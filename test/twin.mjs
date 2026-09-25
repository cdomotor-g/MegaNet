// The Digital Twin tab (digital-twin.js), held to what it claims about the
// ground it stands a station on, and to the one thing it must never do.
//
// Why this is a check of its own. `smoke` opens the tab and, with every
// elevation and imagery host blocked by the network policy, a tab that says
// "no ground could be read" passes — which is right, and says nothing about a
// tab that read the ground wrongly. `tabs` measures the panels in that same
// state. A twin whose mesh is a pixel off, whose pole floats a centimetre
// above the ground, whose figure stands at the station's height rather than
// its own, or whose .glb Blender opens as an empty scene, leaves every one of
// those assertions green.
//
// So the world is made here, as `map3d` and `terrain` make theirs: the State's
// elevation service is answered with a tiled 32-bit-float GeoTIFF of a
// closed-form surface, built by this file in the exact layout the real service
// uses (128 × 128 tiles, uncompressed, little-endian, GDAL's NoData tag), so
// every height in the mesh is arithmetic. What is asserted:
//
//   The raster       the request is the patch grown by half a sample, so that
//                    the pixel *centres* the service returns land on the mesh
//                    vertices and the middle one on the station. Sampled at
//                    the box's own corners instead, every height would be half
//                    a sample off and nothing would look wrong.
//   The mesh         N × N vertices, each at the height the surface has at its
//                    pixel centre, relative to the station, times the
//                    exaggeration — and only the ground scales.
//   The objects      a 2.000 m × Ø0.300 m pole with its foot at the origin on
//                    the ground, and a 1.75 m figure with its feet on the
//                    ground where it stands, not at the pole's height.
//   The .glb         header, chunks, the ground's positions read back out of
//                    the binary and matched to the scene, the JPEG in it, the
//                    station's coordinates in its header.
//   The fallbacks    an empty raster → the ~30 m tiles, and a note that says
//                    so; imagery aborted or blank → Esri; nothing at all → a
//                    stage that says so and an empty scene. Never flat ground.
//   Walking          eye 1.70 m above the ground under the camera; W moves;
//                    Escape returns to orbit.
//   The teardown     the frame loop stops and the renderer goes with the tab,
//                    and the tab rebuilds on return.
//   The lazy load    three.js is not fetched until the tab is opened.
//
// Needs WebGL2, which Playwright's Chromium has through SwiftShader; skips
// rather than fails if that is ever absent, as map3d does.
//
//   node --run twin        (or: npm run twin)
//       npm run twin -- -v    also print what passed

import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the world ────────────────────────────────────────────────────────────────
// A surface in metres, a function of latitude and longitude, with features a
// few tens of metres across so that a half-sample error is a visible number:
// the longitude term alone slopes up to ~0.6 m per metre.
function groundAt(lat, lon) {
  return 300 + 12 * Math.sin(lon * 5800) + 8 * Math.cos(lat * 7300) + 2 * Math.sin((lat + lon) * 2100);
}

// A GeoTIFF exactly as ArcGIS's exportImage writes one for pixelType=F32: one
// band of little-endian floats, no compression, 128 × 128 tiles padded to the
// full tile, the GDAL NoData tag. `empty` is the other shape the real service
// has: a patch it holds nothing for comes back with every tile's byte count
// at zero.
function tiffF32(W, H, valueAt, { empty = false } = {}) {
  const TW = 128, TH = 128;
  const ntx = Math.ceil(W / TW), nty = Math.ceil(H / TH), nt = ntx * nty;
  const tileBytes = TW * TH * 4;
  const entries = [
    [256, 3, [W]], [257, 3, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]],
    [277, 3, [1]], [284, 3, [1]], [322, 3, [TW]], [323, 3, [TH]],
    [324, 4, null], [325, 4, null], [339, 3, [3]], [42113, 2, Buffer.from('-9999\0', 'latin1')],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extAt = 8 + ifdSize;
  const extSize = (nt > 1 ? 2 * 4 * nt : 0) + 6;
  const dataAt = extAt + extSize;
  const offsets = [], counts = [];
  for (let t = 0; t < nt; t++) {
    offsets.push(empty ? 0 : dataAt + t * tileBytes);
    counts.push(empty ? 0 : tileBytes);
  }
  entries[9][2] = offsets;
  entries[10][2] = counts;
  const buf = Buffer.alloc(dataAt + (empty ? 0 : nt * tileBytes));
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(8, 4);
  let p = 8;
  buf.writeUInt16LE(entries.length, p); p += 2;
  let ext = extAt;
  for (const [tag, type, val] of entries) {
    let bytes;
    if (type === 2) bytes = val;
    else {
      bytes = Buffer.alloc(val.length * (type === 3 ? 2 : 4));
      val.forEach((v, i) => (type === 3 ? bytes.writeUInt16LE(v, i * 2) : bytes.writeUInt32LE(v, i * 4)));
    }
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(val.length, p + 4);
    if (bytes.length <= 4) bytes.copy(buf, p + 8);
    else { buf.writeUInt32LE(ext, p + 8); bytes.copy(buf, ext); ext += bytes.length; }
    p += 12;
  }
  buf.writeUInt32LE(0, p);
  if (!empty) {
    for (let t = 0; t < nt; t++) {
      const tx = t % ntx, ty = Math.floor(t / ntx);
      const base = dataAt + t * tileBytes;
      for (let r = 0; r < TH; r++) {
        for (let c = 0; c < TW; c++) {
          const x = tx * TW + c, y = ty * TH + r;
          buf.writeFloatLE(x < W && y < H ? valueAt(x, y) : 0, base + (r * TW + c) * 4);
        }
      }
    }
  }
  return buf;
}

// PNGs: a gradient for the imagery (so the blank-sheet test has variance to
// find) and a flat tile for Esri.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngRgb(W, H, rgbAt) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgbAt(x, y);
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const GRADIENT = pngRgb(256, 256, (x, y) => [x, y, (x + y) >> 1]);
const GREY     = pngRgb(64, 64, () => [128, 128, 128]);
const FLAT     = pngRgb(8, 8, () => [0x66, 0x99, 0x66]);

// ── the harness ──────────────────────────────────────────────────────────────
const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);

// What each host does right now — flipped by the fallback phase.
const world = { dem: 'ok', img: 'ok', esri: 'ok', srtm: 'ok' };
const seen  = { dem: [], img: 0, esri: 0, srtm: 0, three: 0 };

// Registered after the policy so they are consulted first.
await page.route(/QldDem\/ImageServer\/exportImage/, route => {
  const u = new URL(route.request().url());
  const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
  const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
  seen.dem.push({ bbox, W, H, format: u.searchParams.get('format'), pixelType: u.searchParams.get('pixelType'),
                  imageSR: u.searchParams.get('imageSR'), bboxSR: u.searchParams.get('bboxSR') });
  if (world.dem === 'abort') return route.abort('blockedbyclient');
  const pw = (bbox[2] - bbox[0]) / W, ph = (bbox[3] - bbox[1]) / H;
  const body = tiffF32(W, H, (x, y) => groundAt(bbox[3] - (y + 0.5) * ph, bbox[0] + (x + 0.5) * pw),
                       { empty: world.dem === 'empty' });
  return route.fulfill({ status: 200, contentType: 'image/tiff', body,
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route => {
  seen.img++;
  if (world.img === 'abort') return route.abort('blockedbyclient');
  return route.fulfill({ status: 200, contentType: 'image/png', body: world.img === 'blank' ? GREY : GRADIENT,
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/server\.arcgisonline\.com/, route => {
  seen.esri++;
  if (world.esri === 'abort') return route.abort('blockedbyclient');
  return route.fulfill({ status: 200, contentType: 'image/png', body: FLAT,
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  seen.srtm++;
  if (world.srtm === 'abort') return route.abort('blockedbyclient');
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/api-elevation\.fsdf\.org\.au/, route =>
  route.fulfill({ status: 200, contentType: 'application/json',
                  body: JSON.stringify({ SOURCE: 'QLD Government - https://www.qld.gov.au/', DATASET: 'Check_2026_1m.tif',
                                         'DEM RESOLUTION': '1m', 'HEIGHT AT LOCATION': '301.50m', 'METADATA URL': '' }),
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
page.on('request', r => { if (/unpkg\.com\/three@/.test(r.url())) seen.three++; });
page.on('pageerror', e => errors.push(String(e)));

const settled = () => page.waitForFunction(
  () => typeof DigitalTwin !== 'undefined' && !DigitalTwin.debug().status.endsWith('…'),
  null, { timeout: BUILD_TIMEOUT });
const dbg = () => page.evaluate(() => {
  const d = DigitalTwin.debug();
  // Functions do not cross the bridge; the numbers do.
  return { ...d, heightAt: undefined, yAt: undefined, vertexY: undefined };
});

try {
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // ── 0. WebGL, or nothing below this line means anything ───────────────────
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  if (!gl) {
    console.log('\nSKIP — this Chromium has no WebGL; the Digital Twin cannot be exercised here.\n');
    await browser.close(); server.close();
    process.exit(0);
  }

  console.log('\nThe lazy load\n');
  ok('three.js is not fetched before the tab is opened',
    seen.three === 0 && !(await page.evaluate(() => DigitalTwin.libLoaded())), `${seen.three} request(s)`);

  // A station with a position inside Queensland's service box, and a recorded
  // height, so the Ground truth panel has a comparison to make.
  const st = await page.evaluate(() => {
    const s = state.data.stations.find(x => isFinite(x.lat) && isFinite(x.lon)
      && x.lat < -10 && x.lat > -28.5 && x.lon > 140 && x.lon < 153.5 && x.elevation_ahd != null);
    return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, elev: s.elevation_ahd };
  });

  // ── 1. The scene, built ───────────────────────────────────────────────────
  console.log('\nThe ground, the pole and the figure\n');
  await page.evaluate(id => DigitalTwin.openStation(id), st.id);
  await page.waitForFunction(() => DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
  await settled();
  let d = await dbg();

  ok('the tab is open on the station', d.stationId === st.id && await page.evaluate(() => state.activeTab === 'twin'));
  ok('three.js arrived, and only once the tab was opened', d.lib && seen.three >= 1, `${seen.three} request(s)`);
  ok('the ground came from the State\'s service', d.source === 'qld' && d.holes === 0, `${d.source}, ${d.holes} hole(s)`);
  ok('N × N vertices', d.vertices === d.N * d.N && d.N === 201, `${d.vertices}`);
  ok('the default patch is 400 m at 2 m samples', d.size === 400 && near(d.sample_m, 2, 1e-9), `${d.size} m, ${d.sample_m} m`);
  ok('a frame has been drawn', d.frames > 0, `${d.frames}`);
  ok('no warnings on a world that answered', d.notes.length === 0, d.notes.join(' | '));

  const req = seen.dem[seen.dem.length - 1];
  ok('one raster request, as 32-bit floats, in degrees, 201 × 201',
    !!req && req.W === 201 && req.H === 201 && req.pixelType === 'F32' && req.format === 'tiff'
      && req.imageSR === '4326' && req.bboxSR === '4326', JSON.stringify(req));
  // The box is the patch plus one sample — half on each side — so pixel
  // centres are the vertices.
  const mLat = 110.574e3, mLon = 111.320e3 * Math.cos(st.lat * Math.PI / 180);
  const reqW = (req.bbox[2] - req.bbox[0]) * mLon, reqH = (req.bbox[3] - req.bbox[1]) * mLat;
  ok('the request box is the patch grown by half a sample on every side',
    near(reqW, 402, 0.05) && near(reqH, 402, 0.05), `${reqW.toFixed(3)} × ${reqH.toFixed(3)} m`);
  ok('and centred on the station',
    near((req.bbox[0] + req.bbox[2]) / 2, st.lon, 1e-7) && near((req.bbox[1] + req.bbox[3]) / 2, st.lat, 1e-7));

  // Heights: the surface at each pixel centre, on its vertex.
  const pw = (req.bbox[2] - req.bbox[0]) / 201, ph = (req.bbox[3] - req.bbox[1]) / 201;
  const at = (i, j) => groundAt(req.bbox[3] - (j + 0.5) * ph, req.bbox[0] + (i + 0.5) * pw);
  const probes = [[0, 0], [100, 100], [200, 200], [37, 150], [150, 37], [0, 200], [200, 0], [101, 100], [100, 99]];
  const got = await page.evaluate(probes => {
    const d = DigitalTwin.debug();
    const step = d.size / (d.N - 1), half = d.size / 2;
    return probes.map(([i, j]) => ({ h: d.heightAt(-half + i * step, -half + j * step), y: d.vertexY(j * d.N + i) }));
  }, probes);
  const h0 = at(100, 100);
  ok('the station\'s own height is the centre pixel', near(d.h0, h0, 1e-3), `${d.h0} vs ${h0}`);
  const heightsRight = probes.every(([i, j], k) => near(got[k].h, at(i, j), 1e-3));
  ok('every probed vertex has the surface\'s height at its pixel centre', heightsRight,
    probes.map(([i, j], k) => `(${i},${j}) ${got[k].h.toFixed(3)} vs ${at(i, j).toFixed(3)}`).join(', '));
  ok('and its mesh y is that height less the station\'s, at 1×',
    probes.every(([i, j], k) => near(got[k].y, at(i, j) - h0, 1e-3)));
  ok('the pole is 2.000 m tall and 0.300 m across',
    d.pole && near(d.pole.h, 2, 1e-9) && near(d.pole.r, 0.15, 1e-9), JSON.stringify(d.pole));
  ok('and its foot is on the ground at the origin',
    d.pole && near(d.pole.baseY, 0, 1e-6) && near(d.pole.x, 0, 1e-9) && near(d.pole.z, 0, 1e-9), JSON.stringify(d.pole));
  const figGround = await page.evaluate(() => { const d = DigitalTwin.debug(); return d.yAt(d.figure.x, d.figure.z); });
  ok('the figure is 1.75 m and stands with its feet on the ground beside the pole',
    d.figure && near(d.figure.h, 1.75, 1e-9) && near(d.figure.baseY, figGround, 1e-6)
      && Math.hypot(d.figure.x, d.figure.z) > 0.6 && Math.hypot(d.figure.x, d.figure.z) < 2 && d.figure.visible,
    JSON.stringify(d.figure) + ` ground there ${figGround}`);
  ok('the imagery is the State\'s, draped', d.imagery === 'qld' && d.textured && seen.img >= 1, `${d.imagery} textured:${d.textured}`);

  // The panels around the scene.
  const dom = await page.evaluate(() => {
    const cv = document.getElementById('twin-canvas');
    const truth = document.getElementById('twin-truth');
    const h2 = document.getElementById('twin-heading');
    const table = document.querySelector('#twin-table table');
    return {
      name: cv.getAttribute('aria-label') || '', tab: cv.tabIndex,
      truth: truth ? truth.textContent : '',
      heading: h2 ? h2.textContent : '',
      caption: table && table.caption ? table.caption.textContent : '',
      cells: table ? table.querySelectorAll('tbody td').length : 0,
      exportOn: !document.getElementById('twin-export').disabled,
      status: document.getElementById('twin-status').textContent,
      inline: [...document.querySelectorAll('#main-content [style]')]
        .filter(el => !(el.getAttribute('style') || '').split(';').map(s => s.trim()).filter(Boolean)
          .every(s => /^--[\w-]+\s*:/.test(s)))
        .map(el => el.tagName + '[' + el.getAttribute('style') + ']'),
    };
  });
  ok('the canvas is a named control, and its name carries the numbers',
    dom.tab === 0 && /400 m/.test(dom.name) && /relief/.test(dom.name) && dom.name.includes(st.name), dom.name);
  ok('the heading names the station', dom.heading.includes(st.name), dom.heading);
  ok('the status says the size, the source and the imagery',
    /400 m of ground/.test(dom.status) && /Queensland LiDAR/.test(dom.status) && /aerial imagery/.test(dom.status), dom.status);
  ok('the ground table is captioned and holds two lines through the pole', /through/.test(dom.caption) && dom.cells >= 18, `${dom.cells} cells`);
  ok('the export is offered', dom.exportOn);
  ok('no inline style but a token override — the renderer left the canvas alone', dom.inline.length === 0, dom.inline.join(' · '));
  await page.waitForFunction(() => /301\.50/.test(document.getElementById('twin-truth').textContent), null, { timeout: 15_000 }).catch(() => {});
  const truth = await page.evaluate(() => document.getElementById('twin-truth').textContent);
  ok('the Ground truth list quotes the ground at the pin, the recorded height and Elvis\'s answer',
    /Ground at the pin/.test(truth) && /301\.50/.test(truth) && /Check_2026_1m\.tif/.test(truth) && new RegExp(String(st.elev)).test(truth),
    truth.replace(/\s+/g, ' ').slice(0, 300));

  // ── 2. Exaggeration scales the relief and nothing else ────────────────────
  console.log('\nVertical exaggeration\n');
  const ex = await page.evaluate(probes => {
    DigitalTwin.setExag(2.5);
    const d = DigitalTwin.debug();
    const step = d.size / (d.N - 1), half = d.size / 2;
    return { exag: d.exag, pole: d.pole, figure: d.figure, figGround: d.yAt(d.figure.x, d.figure.z),
             ys: probes.map(([i, j]) => d.vertexY(j * d.N + i)),
             hs: probes.map(([i, j]) => d.heightAt(-half + i * step, -half + j * step)) };
  }, probes);
  ok('at 2.5× every vertex y is 2.5 × its relief', ex.exag === 2.5 && probes.every((p, k) => near(ex.ys[k], (ex.hs[k] - h0) * 2.5, 1e-3)));
  ok('the heights themselves did not move', probes.every(([i, j], k) => near(ex.hs[k], at(i, j), 1e-3)));
  ok('the pole is still 2 m with its foot at the origin', near(ex.pole.h, 2, 1e-9) && near(ex.pole.baseY, 0, 1e-6));
  ok('and the figure followed the ground under it', near(ex.figure.baseY, ex.figGround, 1e-6), `${ex.figure.baseY} vs ${ex.figGround}`);
  await page.evaluate(() => DigitalTwin.setExag(1));

  // ── 3. The .glb ───────────────────────────────────────────────────────────
  console.log('\nThe .glb\n');
  const glb = await page.evaluate(async () => {
    const buf = await DigitalTwin.buildGlb();
    const dv = new DataView(buf);
    const magic = dv.getUint32(0, true), version = dv.getUint32(4, true), total = dv.getUint32(8, true);
    const jsonLen = dv.getUint32(12, true), jsonType = dv.getUint32(16, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    const binLen = dv.getUint32(20 + jsonLen, true), binType = dv.getUint32(24 + jsonLen, true);
    const binStart = 28 + jsonLen;
    const ground = json.meshes.find(m => m.name === 'ground');
    const prim = ground && ground.primitives[0];
    const acc = prim && json.accessors[prim.attributes.POSITION];
    const bv = acc && json.bufferViews[acc.bufferView];
    const pos = bv ? new Float32Array(buf.slice(binStart + bv.byteOffset, binStart + bv.byteOffset + bv.byteLength)) : null;
    const d = DigitalTwin.debug();
    const idx = (i, j) => (j * d.N + i) * 3;
    const back = pos ? [[0, 0], [100, 100], [200, 200], [37, 150]].map(([i, j]) => ({ i, j, x: pos[idx(i, j)], y: pos[idx(i, j) + 1], z: pos[idx(i, j) + 2],
                                                                                  want: d.vertexY(j * d.N + i) })) : [];
    const img = json.images && json.images[0];
    const iv = img && json.bufferViews[img.bufferView];
    const jpeg = iv ? Array.from(new Uint8Array(buf, binStart + iv.byteOffset, 3)) : null;
    const mat = prim && json.materials[prim.material];
    return {
      byteLength: buf.byteLength, magic, version, total, jsonLen, jsonType, binLen, binType,
      bufLen: json.buffers[0].byteLength, asset: json.asset, meshes: json.meshes.map(m => m.name),
      nodes: json.nodes.length, sceneNodes: json.scenes[0].nodes.length,
      accCount: acc && acc.count, accMin: acc && acc.min, accMax: acc && acc.max, accType: acc && acc.componentType,
      hasUv: !!(prim && prim.attributes.TEXCOORD_0 != null), hasNormal: !!(prim && prim.attributes.NORMAL != null),
      indices: prim && prim.indices != null ? json.accessors[prim.indices].count : 0,
      back, jpeg, texOnGround: !!(mat && mat.pbrMetallicRoughness.baseColorTexture),
      mime: img && img.mimeType, N: d.N,
    };
  });
  ok('a glTF 2.0 binary: magic, version, total length', glb.magic === 0x46546C67 && glb.version === 2 && glb.total === glb.byteLength,
    `${glb.magic.toString(16)} v${glb.version} ${glb.total}/${glb.byteLength}`);
  ok('a JSON chunk then a BIN chunk, and the lengths add up',
    glb.jsonType === 0x4E4F534A && glb.binType === 0x004E4942 && glb.jsonLen % 4 === 0 && glb.binLen % 4 === 0
      && 12 + 8 + glb.jsonLen + 8 + glb.binLen === glb.total && glb.binLen === glb.bufLen);
  ok('the ground, the pole and the figure are in it, one node each',
    glb.meshes.includes('ground') && glb.meshes.includes('station pole') && glb.meshes.includes('torso') && glb.meshes.includes('head')
      && glb.nodes === glb.meshes.length && glb.sceneNodes === glb.nodes, glb.meshes.join(', '));
  ok('the ground has N × N float positions with normals, UVs and an index',
    glb.accCount === glb.N * glb.N && glb.accType === 5126 && glb.hasNormal && glb.hasUv && glb.indices === (glb.N - 1) * (glb.N - 1) * 6,
    `${glb.accCount} positions, ${glb.indices} indices`);
  ok('its bounds are the patch', near(glb.accMin[0], -200, 1e-3) && near(glb.accMax[0], 200, 1e-3) && near(glb.accMin[2], -200, 1e-3) && near(glb.accMax[2], 200, 1e-3),
    `${glb.accMin} … ${glb.accMax}`);
  ok('positions read back out of the binary are the scene\'s', glb.back.every(b => near(b.y, b.want, 1e-5))
      && near(glb.back[1].x, 0, 1e-5) && near(glb.back[1].z, 0, 1e-5), JSON.stringify(glb.back));
  ok('the imagery is embedded as a JPEG and the ground\'s material wears it',
    glb.jpeg && glb.jpeg[0] === 0xFF && glb.jpeg[1] === 0xD8 && glb.mime === 'image/jpeg' && glb.texOnGround, `${glb.jpeg} ${glb.mime}`);
  const x = glb.asset.extras || {};
  ok('the header carries the station, its coordinates, the datum and the ruler',
    x.station_id === st.id && near(x.origin.lat, st.lat, 1e-9) && near(x.origin.lon, st.lon, 1e-9) && x.origin.datum === 'AHD'
      && near(x.pole.height_m, 2, 1e-9) && near(x.pole.diameter_m, 0.3, 1e-9) && near(x.figure.height_m, 1.75, 1e-9)
      && x.ground.source === 'qld', JSON.stringify(x).slice(0, 300));

  // ── 4. The fallbacks, one host at a time ──────────────────────────────────
  console.log('\nThe fallbacks\n');
  world.dem = 'empty';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('an empty raster → the ~30 m tiles, and the notes say the State holds nothing here',
    d.source === 'srtm' && d.qld === 'empty' && seen.srtm > 0 && d.notes.some(n => /SRTM/.test(n) && /holds nothing/.test(n)), `${d.source}: ${d.notes.join(' | ')}`);
  ok('the tiles\' ground has relief and the scene stands on it', d.built && d.max - d.min > 0.5 && near(d.pole.baseY, 0, 1e-6), `${d.min}–${d.max}`);
  ok('the status names the tiles', /SRTM ~30 m/.test(d.status), d.status);

  // A request that fails is a different fact from a patch the State holds
  // nothing for, and the note has to say which — one means the data is not
  // there, the other means press Rebuild. Two attempts are made before
  // giving up, so the route sees the request twice.
  const demBefore = seen.dem.length;
  world.dem = 'abort';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('a raster request that fails → the tiles, and a note that says to try again, after one retry',
    d.source === 'srtm' && d.qld === 'failed' && seen.dem.length === demBefore + 2 && d.notes.some(n => /could not be reached/.test(n) && /Rebuild/.test(n)),
    `${d.source} ${d.qld} requests:${seen.dem.length - demBefore} ${d.notes.join(' | ')}`);
  world.dem = 'ok';

  // terrain.js keeps the tiles it decoded, so blocking their host after the
  // step above changes nothing until that cache is released — which is what
  // MemMeter's Release button does, and what the app would do offline after
  // a long session.
  world.dem = 'abort'; world.srtm = 'abort';
  await page.evaluate(() => { Terrain.clear(); DigitalTwin.rebuild(); });
  await settled();
  d = await dbg();
  const empty = await page.evaluate(() => ({
    placeholder: !document.getElementById('twin-placeholder').hidden,
    text: document.getElementById('twin-placeholder').textContent,
    exportOn: !document.getElementById('twin-export').disabled,
  }));
  ok('no ground at all → nothing drawn, said out loud, and no export',
    !d.built && /No ground could be read/.test(d.status) && d.notes.some(n => /Nothing is drawn/.test(n)) && empty.placeholder && !empty.exportOn,
    `${d.status} | ${empty.text}`);

  world.dem = 'ok'; world.srtm = 'ok'; world.img = 'abort';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('imagery aborted → Esri\'s tiles, and a note that says to try again',
    d.built && d.imagery === 'esri' && d.textured && seen.esri > 0 && d.notes.some(n => /Esri/.test(n) && /could not be fetched/.test(n)),
    `${d.imagery} ${d.notes.join(' | ')}`);

  world.img = 'blank';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('a blank sheet from the State → Esri\'s tiles, and a note that the State holds nothing here',
    d.imagery === 'esri' && d.notes.some(n => /Esri/.test(n) && /holds nothing/.test(n)), `${d.imagery} ${d.notes.join(' | ')}`);

  world.img = 'abort'; world.esri = 'abort';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('no imagery at all → the height ramp, and a note', d.built && d.imagery === null && !d.textured && d.notes.some(n => /No imagery/.test(n)),
    `${d.imagery} textured:${d.textured} ${d.notes.join(' | ')}`);

  world.img = 'ok'; world.esri = 'ok';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('and everything back → the State\'s ground and imagery again', d.source === 'qld' && d.imagery === 'qld' && d.notes.length === 0);

  // ── 5. Walking, and a click on the ground ─────────────────────────────────
  console.log('\nWalking\n');
  const walk = await page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    DigitalTwin.toggleWalk();
    await frame();
    const d0 = DigitalTwin.debug();
    const eye0 = d0.camera.y - d0.yAt(d0.camera.x, d0.camera.z);
    const cv = document.getElementById('twin-canvas');
    cv.focus();
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    cv.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
    await frame();
    const d1 = DigitalTwin.debug();
    const eye1 = d1.camera.y - d1.yAt(d1.camera.x, d1.camera.z);
    const moved = Math.hypot(d1.camera.x - d0.camera.x, d1.camera.z - d0.camera.z);
    const pressed = document.getElementById('twin-walk').getAttribute('aria-pressed');
    const name = cv.getAttribute('aria-label');
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frame();
    return { mode0: d0.mode, eye0, eye1, moved, pressed, name, modeAfter: DigitalTwin.debug().mode,
             pressedAfter: document.getElementById('twin-walk').getAttribute('aria-pressed') };
  });
  ok('walk mode puts the eye 1.70 m above the ground under the camera', walk.mode0 === 'walk' && near(walk.eye0, 1.7, 0.01), `${walk.eye0}`);
  ok('W walks forward, and the eye stays 1.70 m up', walk.moved > 0.05 && walk.moved < 6 && near(walk.eye1, 1.7, 0.01), `${walk.moved.toFixed(2)} m, eye ${walk.eye1}`);
  ok('the button reads as pressed and the canvas name says how to walk', walk.pressed === 'true' && /Walking/.test(walk.name), walk.name);
  ok('Escape returns to orbit', walk.modeAfter === 'orbit' && walk.pressedAfter === 'false');

  const box = await page.locator('#twin-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
  await sleep(300);
  const picked = await page.evaluate(() => document.getElementById('twin-pick').textContent);
  ok('a click on the ground is answered with where it is and how high', /ground \d+\.\d\d m/.test(picked) && /of the pole/.test(picked), picked);

  // ── 6. The teardown, and the return ───────────────────────────────────────
  console.log('\nThe teardown\n');
  const before = (await dbg()).frames;
  await page.evaluate(() => switchTab('stations'));
  await sleep(400);
  const gone = await page.evaluate(() => ({ ...DigitalTwin.debug(), heightAt: 0, yAt: 0, vertexY: 0, canvas: !!document.getElementById('twin-canvas') }));
  const f1 = gone.frames;
  await sleep(400);
  const f2 = (await dbg()).frames;
  ok('leaving the tab takes the renderer and the scene with it', !gone.live && !gone.built && !gone.canvas && gone.contextLost === null);
  ok('and the frame loop has stopped', f1 === f2 && f1 >= before, `${before} → ${f1} → ${f2}`);

  // The station card offers the twin, and opens the tab on that station.
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  const pill = await page.evaluate(id => {
    showStationCard(id);
    const b = document.querySelector('#stn-card .mn-twin');
    if (!b) return { present: false };
    b.click();
    return { present: true, tab: state.activeTab, station: DigitalTwin.debug().stationId, text: b.textContent.trim() };
  }, st.id);
  ok('the station card carries a Digital twin pill that opens the tab on the station',
    pill.present && pill.tab === 'twin' && pill.station === st.id && /^🧊/.test(pill.text), JSON.stringify(pill));
  await page.waitForFunction(() => DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
  await settled();
  d = await dbg();
  ok('and the twin is rebuilt on return', d.built && d.live && d.source === 'qld' && d.frames > 0);

  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  failures++;
  console.log(`  FAIL the check itself threw: ${err.stack || err}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
