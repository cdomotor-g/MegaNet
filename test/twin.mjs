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

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng, hillyHeightAtWorld } from './lib/terrarium.mjs';
import { TEST_DIR } from './lib/paths.mjs';

// The three.js the harness vendors — the version the module has to ask for,
// or every real visitor gets a 404 the check would not see.
const THREE_VER = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'package.json'), 'utf8')).devDependencies.three;

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
// full tile, the GDAL NoData tag, and the two GeoTIFF tags that say where the
// pixels are — ModelPixelScale (33550) and ModelTiepoint (33922) — which the
// app checks against its request. `empty` is the other shape the real service
// has: a patch it holds nothing for comes back with every tile's byte count
// at zero. `extent` is [west, south, east, north] of what the raster covers.
function tiffF32(W, H, extent, valueAt, { empty = false } = {}) {
  const TW = 128, TH = 128;
  const ntx = Math.ceil(W / TW), nty = Math.ceil(H / TH), nt = ntx * nty;
  const tileBytes = TW * TH * 4;
  const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
  const bytesFor = (type, val) => {
    if (type === 2) return val;
    const size = type === 3 ? 2 : type === 4 ? 4 : 8;
    const b = Buffer.alloc(val.length * size);
    val.forEach((v, i) => (type === 3 ? b.writeUInt16LE(v, i * size)
                         : type === 4 ? b.writeUInt32LE(v, i * size) : b.writeDoubleLE(v, i * size)));
    return b;
  };
  // Tags ascending, as TIFF requires. The tile offsets are filled in once the
  // data's position is known; their size is known now.
  const entries = [
    [256, 3, [W]], [257, 3, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]],
    [277, 3, [1]], [284, 3, [1]], [322, 3, [TW]], [323, 3, [TH]],
    [324, 4, new Array(nt).fill(0)], [325, 4, new Array(nt).fill(0)], [339, 3, [3]],
    [33550, 12, [pw, ph, 0]], [33922, 12, [0, 0, 0, extent[0], extent[3], 0]],
    [42113, 2, Buffer.from('-9999\0', 'latin1')],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extAt = 8 + ifdSize;
  let extSize = 0;
  for (const [, type, val] of entries) { const n = bytesFor(type, val).length; if (n > 4) extSize += n; }
  const dataAt = extAt + extSize;
  for (let t = 0; t < nt; t++) {
    entries[9][2][t]  = empty ? 0 : dataAt + t * tileBytes;
    entries[10][2][t] = empty ? 0 : tileBytes;
  }
  const buf = Buffer.alloc(dataAt + (empty ? 0 : nt * tileBytes));
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(8, 4);
  let p = 8;
  buf.writeUInt16LE(entries.length, p); p += 2;
  let ext = extAt;
  for (const [tag, type, val] of entries) {
    const bytes = bytesFor(type, val);
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

// What an ArcGIS ImageServer does to a request box unless told not to
// (`adjustAspectRatio=false`): it keeps the centre and makes the pixels square
// in the image's own units, widening whichever axis is the shorter per pixel.
// Measured live on the State's service: a 402 m box at Brisbane, square in
// metres and so 1/cos(lat) narrower in degrees of longitude, came back 450 m
// north to south. A request box that is square in metres is *not* square in
// degrees, so the snap is the trap the app has to step round, and the fake
// service sets it exactly as the real one does.
function snapExtent(bbox, W, H, adjust) {
  if (adjust === 'false') return bbox.slice();
  const pix = Math.max((bbox[2] - bbox[0]) / W, (bbox[3] - bbox[1]) / H);
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  return [cx - pix * W / 2, cy - pix * H / 2, cx + pix * W / 2, cy + pix * H / 2];
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

// What each host does right now — flipped by the fallback phase. `snap` on
// the DEM is a service that ignores adjustAspectRatio=false and snaps anyway,
// which the app has to notice from the GeoTIFF's own tags.
const world = { dem: 'ok', img: 'ok', esri: 'ok', srtm: 'ok' };
const seen  = { dem: [], img: [], esri: 0, srtm: 0, three: 0 };

// Registered after the policy so they are consulted first.
await page.route(/QldDem\/ImageServer\/exportImage/, route => {
  const u = new URL(route.request().url());
  const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
  const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
  const adjust = u.searchParams.get('adjustAspectRatio');
  seen.dem.push({ bbox, W, H, adjust, format: u.searchParams.get('format'), pixelType: u.searchParams.get('pixelType'),
                  imageSR: u.searchParams.get('imageSR'), bboxSR: u.searchParams.get('bboxSR') });
  if (world.dem === 'abort') return route.abort('blockedbyclient');
  // The raster covers what ArcGIS would return for this request — the box as
  // asked only when the parameter is there — and its tags say so.
  const extent = snapExtent(bbox, W, H, world.dem === 'snap' ? null : adjust);
  const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
  const body = tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw),
                       { empty: world.dem === 'empty' });
  return route.fulfill({ status: 200, contentType: 'image/tiff', body,
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route => {
  const u = new URL(route.request().url());
  seen.img.push({ adjust: u.searchParams.get('adjustAspectRatio'), size: u.searchParams.get('size') });
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

  // The patch's own raster request — the horizon asks the same service for
  // an 8 km sheet once the patch is standing, and that is not this.
  const mLat = 110.574e3, mLon = 111.320e3 * Math.cos(st.lat * Math.PI / 180);
  const patchDem = () => seen.dem.filter(r => (r.bbox[2] - r.bbox[0]) * mLon < 3000);
  const req = patchDem()[patchDem().length - 1];
  ok('one raster request, as 32-bit floats, in degrees, 201 × 201, with the aspect snap switched off',
    !!req && req.W === 201 && req.H === 201 && req.pixelType === 'F32' && req.format === 'tiff'
      && req.imageSR === '4326' && req.bboxSR === '4326' && req.adjust === 'false', JSON.stringify(req));
  ok('and the imagery request has it switched off too',
    seen.img.length > 0 && seen.img[seen.img.length - 1].adjust === 'false', JSON.stringify(seen.img));
  ok('and the renderer asked for is the version the harness vendors',
    (await page.evaluate(() => DigitalTwin._libUrl())) === `https://unpkg.com/three@${THREE_VER}/build/three.module.min.js`,
    await page.evaluate(() => DigitalTwin._libUrl()));
  // The box is the patch plus one sample — half on each side — so pixel
  // centres are the vertices.
  const reqW = (req.bbox[2] - req.bbox[0]) * mLon, reqH = (req.bbox[3] - req.bbox[1]) * mLat;
  ok('the request box is the patch grown by half a sample on every side',
    near(reqW, 402, 0.05) && near(reqH, 402, 0.05), `${reqW.toFixed(3)} × ${reqH.toFixed(3)} m`);
  ok('and centred on the station',
    near((req.bbox[0] + req.bbox[2]) / 2, st.lon, 1e-7) && near((req.bbox[1] + req.bbox[3]) / 2, st.lat, 1e-7));

  // Heights: the surface at the *vertex's own place on the ground*, from the
  // station's coordinates and the scene's metres — not from the request, and
  // not from what came back. That is the oracle that goes red when the rows
  // land 12% too far apart, which one derived from the returned raster
  // cannot: the raster's row j always holds the raster's row j.
  const STEP = 2, HALF = 200;
  const atXZ = (x, z) => groundAt(st.lat - z / mLat, st.lon + x / mLon);
  const at = (i, j) => atXZ(-HALF + i * STEP, -HALF + j * STEP);
  // Bilinear over the four vertices around a point, as the app reads the
  // grid between samples — the fixture's own heights at those vertices, so
  // the comparison is exact rather than a smooth surface against a facet.
  const atBilinear = (x, z) => {
    const fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    const i = Math.min(199, Math.floor(fx)), j = Math.min(199, Math.floor(fz)), tx = fx - i, tz = fz - j;
    return at(i, j) * (1 - tx) * (1 - tz) + at(i + 1, j) * tx * (1 - tz) + at(i, j + 1) * (1 - tx) * tz + at(i + 1, j + 1) * tx * tz;
  };
  const probes = [[0, 0], [100, 100], [200, 200], [37, 150], [150, 37], [0, 200], [200, 0], [101, 100], [100, 99], [100, 50], [50, 100]];
  const got = await page.evaluate(probes => {
    const d = DigitalTwin.debug();
    const step = d.size / (d.N - 1), half = d.size / 2;
    return probes.map(([i, j]) => ({ h: d.heightAt(-half + i * step, -half + j * step), y: d.vertexY(j * d.N + i),
                                     x: d.vertexX(j * d.N + i), z: d.vertexZ(j * d.N + i) }));
  }, probes);
  const h0 = at(100, 100);
  ok('the station\'s own height is the centre pixel', near(d.h0, h0, 1e-3), `${d.h0} vs ${h0}`);
  const heightsRight = probes.every(([i, j], k) => near(got[k].h, at(i, j), 1e-3));
  ok('every probed vertex has the surface\'s height at its own latitude and longitude — 100 m north included', heightsRight,
    probes.map(([i, j], k) => `(${i},${j}) ${got[k].h.toFixed(3)} vs ${at(i, j).toFixed(3)}`).join(', '));
  ok('and its mesh y is that height less the station\'s, at 1×',
    probes.every(([i, j], k) => near(got[k].y, at(i, j) - h0, 1e-3)));
  ok('and every vertex stands where its row and column say: column 0 west, row 0 north',
    probes.every(([i, j], k) => near(got[k].x, -HALF + i * STEP, 1e-3) && near(got[k].z, -HALF + j * STEP, 1e-3)),
    probes.map(([i, j], k) => `(${i},${j}) → ${got[k].x.toFixed(1)},${got[k].z.toFixed(1)}`).join(' '));
  ok('the pole is 2.000 m tall and 0.300 m across',
    d.pole && near(d.pole.h, 2, 1e-9) && near(d.pole.r, 0.15, 1e-9), JSON.stringify(d.pole));
  ok('and its foot is on the ground at the origin',
    d.pole && near(d.pole.baseY, 0, 1e-6) && near(d.pole.x, 0, 1e-9) && near(d.pole.z, 0, 1e-9), JSON.stringify(d.pole));
  // The figure's feet, against the fixture's own ground where it stands —
  // not against the app's yAt(), which is what places it.
  const figGround = d.figure ? atBilinear(d.figure.x, d.figure.z) - h0 : NaN;
  ok('the figure is 1.75 m and stands with its feet on the ground beside the pole',
    d.figure && near(d.figure.h, 1.75, 1e-9) && near(d.figure.baseY, figGround, 1e-3)
      && Math.hypot(d.figure.x, d.figure.z) > 0.6 && Math.hypot(d.figure.x, d.figure.z) < 2 && d.figure.visible,
    JSON.stringify(d.figure) + ` ground there ${figGround}`);
  ok('the imagery is the State\'s, draped', d.imagery === 'qld' && d.textured && seen.img.length >= 1, `${d.imagery} textured:${d.textured}`);

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
    /Ground at the pin/.test(truth) && /301\.50/.test(truth) && /Check_2026_1m\.tif/.test(truth)
      && truth.includes(`${Number(st.elev).toFixed(1)} m AHD`),
    truth.replace(/\s+/g, ' ').slice(0, 300));

  // ── 2. Exaggeration scales the relief and nothing else ────────────────────
  console.log('\nVertical exaggeration\n');
  const ex = await page.evaluate(probes => {
    DigitalTwin.setExag(2.5);
    const d = DigitalTwin.debug();
    const step = d.size / (d.N - 1), half = d.size / 2;
    return { exag: d.exag, pole: d.pole, figure: d.figure,
             ys: probes.map(([i, j]) => d.vertexY(j * d.N + i)),
             hs: probes.map(([i, j]) => d.heightAt(-half + i * step, -half + j * step)) };
  }, probes);
  ok('at 2.5× every vertex y is 2.5 × its relief', ex.exag === 2.5 && probes.every(([i, j], k) => near(ex.ys[k], (at(i, j) - h0) * 2.5, 1e-3)));
  ok('the heights themselves did not move', probes.every(([i, j], k) => near(ex.hs[k], at(i, j), 1e-3)));
  ok('the pole is still 2 m with its foot at the origin', near(ex.pole.h, 2, 1e-9) && near(ex.pole.baseY, 0, 1e-6));
  const figGround25 = (atBilinear(ex.figure.x, ex.figure.z) - h0) * 2.5;
  ok('and the figure followed the ground under it, 2.5× its relief', near(ex.figure.baseY, figGround25, 1e-3), `${ex.figure.baseY} vs ${figGround25}`);
  await page.evaluate(() => DigitalTwin.setExag(1));

  // ── 2b. The horizon ───────────────────────────────────────────────────────
  // The far ground past the patch: three sheets, one mesh of concentric
  // squares standing on the patch's own edge, the Earth's curve, a sky and
  // haze. The oracles are the fixtures' own worlds read the way the app
  // reads them — the State's closed-form surface at the inner sheet's nodes,
  // the hilly tile world at the outer sheets' — never the app's own sampler.
  console.log('\nThe horizon\n');
  const hzd = (await dbg()).horizon;
  ok('the horizon is up: three shells of far ground to 60 km round the patch, under a sky, in haze',
    hzd.on && hzd.up && !hzd.pending && hzd.km === 60 && hzd.meshes.length === 3 && hzd.sky
      && hzd.fog && hzd.fog.exp2 && near(hzd.fog.density, 2.9e-5, 1e-9) && hzd.far >= 200000,
    JSON.stringify({ on: hzd.on, up: hzd.up, meshes: hzd.meshes.length, sky: hzd.sky, fog: hzd.fog, far: hzd.far }));
  ok('the inner sheet is the State\'s raster at 40 m over ±4 km, the outer two the tiles over ±20 and ±60 km',
    hzd.shells && hzd.shells[0] && hzd.shells[0].source === 'qld' && hzd.shells[0].half === 4000 && near(hzd.shells[0].resolution_m, 40, 1e-6)
      && hzd.shells[1] && hzd.shells[1].source === 'srtm' && hzd.shells[1].half === 20000
      && hzd.shells[2] && hzd.shells[2].source === 'srtm' && hzd.shells[2].half === 60000,
    JSON.stringify(hzd.shells && hzd.shells.map(s => s && { source: s.source, half: s.half, zoom: s.zoom, res: s.resolution_m })));
  const sheetReq = seen.dem.find(r => near((r.bbox[2] - r.bbox[0]) * mLon, 8040, 1));
  ok('the State was asked once for the 8 km sheet — 201 × 201 floats, the same request shape as the patch\'s',
    !!sheetReq && sheetReq.W === 201 && sheetReq.pixelType === 'F32' && sheetReq.adjust === 'false', JSON.stringify(sheetReq));
  ok('the tiles were asked for the outer two, at a coarser zoom for the wider — a handful, not a hundred',
    seen.srtm > 0 && seen.srtm <= 20 && hzd.shells[1].zoom > hzd.shells[2].zoom,
    `${seen.srtm} tiles, zooms ${hzd.shells[1].zoom} and ${hzd.shells[2].zoom}`);
  ok('every sheet is draped with its own imagery', hzd.images && hzd.images.every(s => s === 'qld') && hzd.meshes.every(m => m.textured),
    JSON.stringify(hzd.images));
  ok('the far shell is drawn first, and within a shell the outermost squares first',
    hzd.meshes[2].renderOrder < hzd.meshes[1].renderOrder && hzd.meshes[1].renderOrder < hzd.meshes[0].renderOrder
      && [0, 1, 2].every(k => hzd.meshes[k].renderOrder >= 1),
    hzd.meshes.map(m => m.renderOrder).join(','));
  const orders = await page.evaluate(() => [0, 1, 2].map(k => DigitalTwin.debug().horizon.order(k)));
  ok('…measured: each shell\'s first triangle is on its outer edge and its last on its inner',
    orders.every((o, k) => o.first > o.last && near(o.first, hzd.meshes[k].outerHalf, 1) && near(o.last, hzd.meshes[k].innerHalf, 1)),
    JSON.stringify(orders));
  ok('no vertex of the far ground is inside the patch, and the mesh faces up',
    near(orders[0].minHq, 200, 1e-3) && orders.every(o => o.meanNormalY > 0.9), JSON.stringify(orders.map(o => [o.minHq, o.meanNormalY])));

  // The seam: the innermost square's 800 vertices are the patch's own edge
  // vertices — same place, same height — so there is no crack to see through.
  const edgeIJ = t => (t < 200 ? [t, 0] : t < 400 ? [200, t - 200] : t < 600 ? [600 - t, 200] : [0, 800 - t]);
  const seamT = [0, 1, 57, 199, 200, 333, 400, 401, 599, 600, 777, 799];
  const seam = await page.evaluate(ts => {
    const d = DigitalTwin.debug();
    return ts.map(t => ({ v: d.horizon.vertex(0, t) }));
  }, seamT);
  const seamGot = await page.evaluate(ts => {
    const d = DigitalTwin.debug();
    return ts.map(([i, j]) => ({ x: d.vertexX(j * d.N + i), y: d.vertexY(j * d.N + i), z: d.vertexZ(j * d.N + i) }));
  }, seamT.map(edgeIJ));
  ok('the horizon\'s innermost square is the patch\'s edge, vertex for vertex — same x, z and height',
    seam.every((s, k) => s.v && s.v.inner && s.v.t === seamT[k] && near(s.v.h, 200, 1e-9)
      && near(s.v.x, seamGot[k].x, 1e-4) && near(s.v.z, seamGot[k].z, 1e-4) && near(s.v.y, seamGot[k].y, 1e-4)),
    seam.map((s, k) => `${seamT[k]}: ${s.v && [s.v.x.toFixed(1), s.v.y.toFixed(3), s.v.z.toFixed(1)]} vs ${[seamGot[k].x.toFixed(1), seamGot[k].y.toFixed(3), seamGot[k].z.toFixed(1)]}`).join('; '));

  // The sheets, read as the app reads them. The State's: a node (i, j) of the
  // ±4 km sheet is a pixel centre of the grown request, which the route
  // filled with the surface at that latitude and longitude. The tiles': a
  // node is terrain.js's nearest pixel of the hilly world at the zoom it
  // fetched, on a lattice even in Mercator y.
  const R_EYE = 7320000;
  const drop = (x, z) => Math.max(0, x * x + z * z - 2 * HALF * HALF) / (2 * R_EYE);
  const mercY = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
  const tileXf = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const nodeQld = (g, i, j) => groundAt(g.box.north - (g.box.north - g.box.south) * j / (g.n - 1),
                                        g.box.west + (g.box.east - g.box.west) * i / (g.n - 1));
  const nodeTile = (g, i, j) => {
    const lon = g.box.west + (g.box.east - g.box.west) * i / (g.n - 1);
    const my = mercY(g.box.north) + (mercY(g.box.south) - mercY(g.box.north)) * j / (g.n - 1);
    const side = 256 * 2 ** g.zoom;
    return hillyHeightAtWorld(Math.floor(tileXf(lon, g.zoom) * 256) / side, Math.floor(my * 2 ** g.zoom * 256) / side);
  };
  const sheetAt = (g, x, z) => {
    const lat = st.lat - z / mLat, lon = st.lon + x / mLon;
    const fx = (lon - g.box.west) / (g.box.east - g.box.west) * (g.n - 1);
    const fy = (g.rows === 'merc' ? (mercY(lat) - mercY(g.box.north)) / (mercY(g.box.south) - mercY(g.box.north))
                                  : (g.box.north - lat) / (g.box.north - g.box.south)) * (g.n - 1);
    const node = g.rows === 'merc' ? nodeTile : nodeQld;
    const i = Math.min(g.n - 2, Math.floor(fx)), j = Math.min(g.n - 2, Math.floor(fy)), tx = fx - i, ty = fy - j;
    return node(g, i, j) * (1 - tx) * (1 - ty) + node(g, i + 1, j) * tx * (1 - ty) + node(g, i, j + 1) * (1 - tx) * ty + node(g, i + 1, j + 1) * tx * ty;
  };
  // Where a point stands round its square, as an index into the patch's 800
  // edge vertices — the app's own rule, restated.
  const perimT = (x, z) => {
    const hq = Math.max(Math.abs(x), Math.abs(z));
    if (-z >= Math.abs(x)) return (0 + (x + hq) / (2 * hq)) * 200;
    if (x >= Math.abs(z))  return (1 + (z + hq) / (2 * hq)) * 200;
    if (z >= Math.abs(x))  return (2 + (hq - x) / (2 * hq)) * 200;
    return (3 + (hq - z) / (2 * hq)) * 200;
  };
  const edgeLift = t => {   // the LiDAR edge less the State's sheet under it, at edge vertex t
    const [i, j] = edgeIJ(t % 800);
    return at(i, j) - sheetAt(hzd.shells[0], -HALF + 2 * i, -HALF + 2 * j);
  };
  const liftAt = (x, z) => { const t = perimT(x, z), i = Math.floor(t), w = t - i; return edgeLift(i) * (1 - w) + edgeLift((i + 1) % 800) * w; };
  // Probes: the vertex nearest each place, in the shell that holds it.
  const far = [[0, 0, -240], [0, 130, 250], [0, 0, -1000], [0, 2500, -900], [1, 10000, 3000], [1, -6000, -14000], [2, 0, -40000], [2, 33000, 25000]];
  const farGot = await page.evaluate(far => far.map(([k, x, z]) => {
    const d = DigitalTwin.debug().horizon;
    const i = d.nearest(k, x, z);
    return { k, i, v: d.vertex(k, i) };
  }), far);
  const expectFar = (k, v, exag) => {
    const hq = Math.max(Math.abs(v.x), Math.abs(v.z));
    const w = Math.min(1, Math.max(0, (hq / HALF - 1) / 2));
    const H = sheetAt(hzd.shells[k], v.x, v.z) + (1 - w) * liftAt(v.x, v.z);
    return (H - h0) * exag - drop(v.x, v.z);
  };
  const farOk = farGot.map(({ k, v }) => v && !v.inner && !v.seam && near(v.y, expectFar(k, v, 1), 0.02));
  ok('just outside the patch, the State\'s sheet is lifted to meet the LiDAR edge, the lift fading by three patch-halves out',
    farOk[0] && farOk[1], farGot.slice(0, 2).map(({ k, v }) => v && `(${v.x.toFixed(0)},${v.z.toFixed(0)}) h${v.h.toFixed(0)} y ${v.y.toFixed(3)} vs ${expectFar(k, v, 1).toFixed(3)} seam:${v.seam}`).join('; '));
  ok('beyond that, each vertex stands on its sheet\'s own height at its own latitude and longitude, less the Earth\'s curve',
    farOk.slice(2).every(Boolean), farGot.slice(2).map(({ k, v }) => v && `${k}:(${v.x.toFixed(0)},${v.z.toFixed(0)}) y ${v.y.toFixed(3)} vs ${expectFar(k, v, 1).toFixed(3)} drop ${drop(v.x, v.z).toFixed(3)} seam:${v.seam}`).join('; '));
  const v40 = farGot[6].v;
  ok('…and at 40 km that curve is 109 m, on an Earth the light bends round (R = 7,320 km)',
    v40 && near(drop(v40.x, v40.z), 109, 2) && hzd.earthR === 7320000, v40 && `${drop(v40.x, v40.z).toFixed(1)} m at ${Math.hypot(v40.x, v40.z).toFixed(0)} m`);

  // Exaggeration stretches the far relief with the patch's, and not the curve.
  const ex25 = await page.evaluate(({ far, ts }) => {
    DigitalTwin.setExag(2.5);
    const d = DigitalTwin.debug();
    return { far: far.map(([k, x, z]) => { const i = d.horizon.nearest(k, x, z); return { k, v: d.horizon.vertex(k, i) }; }),
             seam: ts.map(t => d.horizon.vertex(0, t)),
             edge: ts.map(t => { const [i, j] = t < 200 ? [t, 0] : t < 400 ? [200, t - 200] : t < 600 ? [600 - t, 200] : [0, 800 - t]; return d.vertexY(j * d.N + i); }) };
  }, { far, ts: seamT });
  ok('at 2.5× the far ground is 2.5 × its relief less the same curve, and the seam still meets the patch',
    ex25.far.every(({ k, v }) => v && near(v.y, expectFar(k, v, 2.5), 0.02)) && ex25.seam.every((v, k) => near(v.y, ex25.edge[k], 1e-4)),
    ex25.far.map(({ k, v }) => `${k}: ${v.y.toFixed(3)} vs ${expectFar(k, v, 2.5).toFixed(3)}`).join('; '));
  await page.evaluate(() => DigitalTwin.setExag(1));

  // The orbit camera is kept above the far ground too, not only the patch's.
  const cam = await page.evaluate(() => {
    const c = DigitalTwin._orbit({ radius: 880, theta: 0.3, phi: 1.53 });
    const d = DigitalTwin.debug();
    return { c, ground: d.horizon.ringSurface(c.x, c.z), mode: d.mode };
  });
  ok('the orbit camera, out over the far ground, stays above it',
    cam.mode === 'orbit' && Math.max(Math.abs(cam.c.x), Math.abs(cam.c.z)) > 200 && cam.c.y >= cam.ground + 0.9 - 1e-6,
    `camera ${cam.c.x.toFixed(0)},${cam.c.y.toFixed(1)},${cam.c.z.toFixed(0)}; ground there ${cam.ground.toFixed(1)}`);
  await page.evaluate(() => DigitalTwin.resetView());

  // The switch, and its cost.
  const srtmAtToggle = seen.srtm;
  await page.evaluate(() => DigitalTwin.setHorizon(false));
  d = await dbg();
  ok('switched off: the far ground and the haze go, the patch stays, and the setting is kept',
    !d.horizon.up && !d.horizon.on && d.built && d.horizon.fog && !d.horizon.fog.exp2
      && await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin')).horizon === false),
    JSON.stringify({ up: d.horizon.up, built: d.built, fog: d.horizon.fog }));
  await page.evaluate(() => DigitalTwin.setHorizon(true));
  await settled();
  d = await dbg();
  ok('and back on from memory: three shells, no new tile requests', d.horizon.up && d.horizon.meshes.length === 3 && seen.srtm === srtmAtToggle,
    `${d.horizon.meshes.length} shells, ${seen.srtm - srtmAtToggle} new tile request(s)`);
  await page.evaluate(() => DigitalTwin.setHorizon(false));
  const bare = { srtm: seen.srtm, dem: seen.dem.length, img: seen.img.length };
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('off from the start, a rebuild asks for the patch alone: one raster, one image, no tiles',
    !d.horizon.up && d.built && seen.srtm === bare.srtm && seen.dem.length === bare.dem + 1 && seen.img.length === bare.img + 1,
    `+${seen.srtm - bare.srtm} tiles, +${seen.dem.length - bare.dem} rasters, +${seen.img.length - bare.img} images`);
  await page.evaluate(() => DigitalTwin.setHorizon(true));
  await settled();
  d = await dbg();
  // (The State's sheet is asked for again; the tiles are terrain.js's to
  // remember, and it still has them.)
  ok('switched on again, the sheets are fetched then', d.horizon.up && d.horizon.meshes.length === 3 && seen.dem.length === bare.dem + 2 && d.notes.length === 0,
    `+${seen.dem.length - bare.dem} rasters; ${d.notes.join(' | ')}`);

  // The tiles gone: the State's sheet still stands, the two beyond it are
  // not drawn — never flat — and the notes say so.
  world.srtm = 'abort';
  await page.evaluate(() => { Terrain.clear(); DigitalTwin.rebuild(); });
  await settled();
  d = await dbg();
  ok('tiles gone → the inner sheet from the State stands alone, the outer two are not drawn, and a note says so',
    d.built && d.source === 'qld' && d.horizon.up && d.horizon.meshes.length === 1 && d.horizon.shells[0] && !d.horizon.shells[1] && !d.horizon.shells[2]
      && d.notes.some(n => /2 of the horizon's 3 sheets/.test(n)),
    `${d.horizon.meshes.length} shell(s); ${d.notes.join(' | ')}`);
  world.srtm = 'ok';
  await page.evaluate(() => { Terrain.clear(); DigitalTwin.rebuild(); });
  await settled();
  d = await dbg();
  ok('and back', d.horizon.up && d.horizon.meshes.length === 3 && d.notes.length === 0, d.notes.join(' | '));

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
  ok('and the horizon and the sky are not — Blender gets the site', !glb.meshes.some(m => /^horizon|^sky/.test(m)), glb.meshes.join(', '));
  ok('the ground has N × N float positions with normals, UVs and an index',
    glb.accCount === glb.N * glb.N && glb.accType === 5126 && glb.hasNormal && glb.hasUv && glb.indices === (glb.N - 1) * (glb.N - 1) * 6,
    `${glb.accCount} positions, ${glb.indices} indices`);
  ok('its bounds are the patch', near(glb.accMin[0], -200, 1e-3) && near(glb.accMax[0], 200, 1e-3) && near(glb.accMin[2], -200, 1e-3) && near(glb.accMax[2], 200, 1e-3),
    `${glb.accMin} … ${glb.accMax}`);
  ok('positions read back out of the binary are the scene\'s, each where its row and column put it',
    glb.back.every(b => near(b.y, b.want, 1e-5) && near(b.x, -200 + 2 * b.i, 1e-4) && near(b.z, -200 + 2 * b.j, 1e-4)),
    JSON.stringify(glb.back));
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
  const demBefore = patchDem().length;
  world.dem = 'abort';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('a raster request that fails → the tiles, and a note that says to try again, after one retry',
    d.source === 'srtm' && d.qld === 'failed' && patchDem().length === demBefore + 2 && d.notes.some(n => /could not be reached/.test(n) && /Rebuild/.test(n)),
    `${d.source} ${d.qld} requests:${patchDem().length - demBefore} ${d.notes.join(' | ')}`);

  // A service that snaps the box anyway — the default it had before the
  // parameter, or a future that drops it — is caught from the GeoTIFF's own
  // pixel scale, and is a failed request, not a ground 12% out.
  world.dem = 'snap';
  await page.evaluate(() => DigitalTwin.rebuild());
  await settled();
  d = await dbg();
  ok('a raster that came back a different shape from the one asked for is refused, and the note says so',
    d.source === 'srtm' && d.qld === 'failed' && d.notes.some(n => /different extent/.test(n)),
    `${d.source} ${d.qld} ${d.notes.join(' | ')}`);
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

  // (terrain.js remembers a failed tile for a minute; the horizon's sheets
  // would be missing until then, so the memory is cleared with the world.)
  world.dem = 'ok'; world.srtm = 'ok'; world.img = 'abort';
  await page.evaluate(() => { Terrain.clear(); DigitalTwin.rebuild(); });
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
    const cv = document.getElementById('twin-canvas');
    cv.focus();
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    cv.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
    await frame();
    const d1 = DigitalTwin.debug();
    const moved = Math.hypot(d1.camera.x - d0.camera.x, d1.camera.z - d0.camera.z);
    const pressed = document.getElementById('twin-walk').getAttribute('aria-pressed');
    const name = cv.getAttribute('aria-label');
    cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frame();
    return { mode0: d0.mode, cam0: d0.camera, cam1: d1.camera, moved, pressed, name, modeAfter: DigitalTwin.debug().mode,
             pressedAfter: document.getElementById('twin-walk').getAttribute('aria-pressed') };
  });
  // The eye, against the fixture's ground under the camera (at 1×).
  const eye0 = walk.cam0.y - (atBilinear(walk.cam0.x, walk.cam0.z) - h0);
  const eye1 = walk.cam1.y - (atBilinear(walk.cam1.x, walk.cam1.z) - h0);
  ok('walk mode puts the eye 1.70 m above the ground under the camera', walk.mode0 === 'walk' && near(eye0, 1.7, 0.01), `${eye0}`);
  ok('W walks forward, and the eye stays 1.70 m up', walk.moved > 0.05 && walk.moved < 6 && near(eye1, 1.7, 0.01), `${walk.moved.toFixed(2)} m, eye ${eye1}`);
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
  // …and drawing again: the frame count has to move past where the teardown
  // left it, or a loop that never restarted passes on the first build's frames.
  await page.waitForFunction(f => DigitalTwin.debug().frames > f, f2, { timeout: 10_000 }).catch(() => {});
  d = await dbg();
  ok('and the twin is rebuilt on return, and drawing', d.built && d.live && d.source === 'qld' && d.frames > f2, `frames ${f2} → ${d.frames}`);

  // ── 7. The radio paths, and the twin inside the Stations map ──────────────
  console.log('\nThe radio paths, in the map and on the tab\n');
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0 && state.mapLines.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  // A station the map has drawn a link for, and every line touching it as the
  // twin will read them: the far end and the colour the 2-D map gave each.
  const linked = await page.evaluate(() => {
    const ends = l => [l.mnLinkStationId, l.mnLinkRepeaterId, l.mnLinkRepeaterId2].filter(v => v != null);
    const core = state.mapLines.find(l => l.mnLinkRole === 'core' && l.mnLinkStationId);
    const s = state.data.stations.find(x => x.id === core.mnLinkStationId);
    const touching = state.mapLines.filter(l => (l.mnLinkRole === 'core' || l.mnLinkRole === 'backbone') && ends(l).includes(s.id));
    const colours = {};
    for (const l of touching) colours[ends(l).find(v => v !== s.id)] = l.options.color;
    return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, far: Object.keys(colours), colours };
  });
  await page.evaluate(() => DigitalTwin.clearCaches());

  // Zoom 15 with the station on the card: fetched ahead, nothing handed over.
  const demBeforePrefetch = seen.dem.length;
  await page.evaluate(([id, lat, lon]) => { showStationCard(id); state.map.setView([lat, lon], 15, { animate: false }); },
    [linked.id, linked.lat, linked.lon]);
  await sleep(1500);
  const pre = await page.evaluate(() => ({ active: MapTwin.active(), built: DigitalTwin.debug().built, zoom: state.map.getZoom() }));
  ok('at zoom 15 the station\'s patch is fetched ahead, and the map is still the map',
    seen.dem.length > demBeforePrefetch && !pre.active && !pre.built && pre.zoom === 15,
    `requests +${seen.dem.length - demBeforePrefetch}, active:${pre.active} built:${pre.built} zoom:${pre.zoom}`);

  // Zoom 17: the hand-over.
  await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 17, { animate: false }), [linked.lat, linked.lon]);
  await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
  await settled();
  const inMap = await page.evaluate(() => {
    const d = DigitalTwin.debug();
    const host = document.getElementById('map-twin');
    const cv = document.getElementById('twin-canvas');
    return { active: MapTwin.active(), station: MapTwin.station(), embedded: d.embedded, built: d.built, live: d.live,
             hostOn: !!(host && host.classList.contains('is-on')), inMap: !!(cv && cv.closest('#leaflet-map')),
             paths: d.paths, size: d.size, zoom: state.map.getZoom(),
             dragging: state.map.dragging.enabled(), wheel: state.map.scrollWheelZoom.enabled(),
             back: !!document.querySelector('#map-twin .map-twin-back'), status: d.status,
             cardAbove: (() => { const c = document.getElementById('stn-card'); return c ? getComputedStyle(c).zIndex : null; })() };
  });
  ok('at zoom 17 with the station on the card, the map hands over to its twin',
    inMap.active && inMap.station === linked.id && inMap.embedded && inMap.built && inMap.live && inMap.hostOn && inMap.inMap && inMap.back,
    JSON.stringify({ ...inMap, paths: undefined }));
  ok('and Leaflet\'s own drag and wheel are held off under it', !inMap.dragging && !inMap.wheel);
  ok('the station card stays above the twin', inMap.cardAbove === '760', String(inMap.cardAbove));
  const half = inMap.size / 2;
  const P = inMap.paths || { list: [], count: 0 };
  ok('the radio paths are the map\'s own lines: one ray per far end, in the colour the map gave it',
    P.source === 'map' && P.count === linked.far.length && linked.far.length > 0
      && P.list.every(p => linked.colours[p.farId] && p.colour.toLowerCase() === linked.colours[p.farId].toLowerCase()),
    `${P.source} ${P.count} vs ${linked.far.length}: ${JSON.stringify(P.list.map(p => [p.farId, p.colour]))} vs ${JSON.stringify(linked.colours)}`);
  ok('each ray leaves the antenna and ends at the patch\'s edge, or at the far station inside it',
    P.list.every(p => (Math.abs(p.end.x) <= half + 1e-6 && Math.abs(p.end.z) <= half + 1e-6)
      && (near(Math.max(Math.abs(p.end.x), Math.abs(p.end.z)), half, 1e-6) || p.km * 1000 < half + 1)
      && p.agl0 > 0),
    JSON.stringify(P.list.map(p => p.end)));

  // Every far station is named under the stage, and its name is the way
  // there: pressing it moves the map to the far station and the hand-over
  // follows, at this zoom, without rebuilding the tab.
  const line = await page.evaluate(() => {
    const el = document.getElementById('twin-paths');
    return { hidden: el.hidden, text: el.textContent, buttons: [...el.querySelectorAll('button.twin-path')].map(b => b.textContent.trim()) };
  });
  const farNames = await page.evaluate(ids => ids.map(id => state.data.stations.find(s => s.id === id).name), linked.far);
  ok('the paths are listed under the stage by the far station\'s name, distance and bearing',
    !line.hidden && farNames.every(n => line.buttons.includes(n)) && /km at \d+°/.test(line.text) && /^Radio path/.test(line.text.trim()),
    line.text.replace(/\s+/g, ' ').slice(0, 200));
  const followed = await page.evaluate(() => {
    const b = document.querySelector('#twin-paths button.twin-path');
    b.click();
    return true;
  });
  const farId = linked.far[0];
  await page.waitForFunction(id => MapTwin.active() && MapTwin.station() === id && DigitalTwin.debug().built, farId, { timeout: BUILD_TIMEOUT });
  await settled();
  const arrived = await page.evaluate(() => ({ station: MapTwin.station(), zoom: state.map.getZoom(), card: state.stnCard.id, tab: state.activeTab }));
  ok('pressing a far station\'s name goes to it: the map moves at this zoom and hands over to its twin',
    followed && arrived.station === farId && arrived.zoom === 17 && arrived.card === farId && arrived.tab === 'stations', JSON.stringify(arrived));
  // Back to the station under test for what follows.
  await page.evaluate(([id, lat, lon]) => { showStationCard(id); state.map.setView([lat, lon], 17, { animate: false }); }, [linked.id, linked.lat, linked.lon]);
  await page.waitForFunction(id => MapTwin.active() && MapTwin.station() === id && DigitalTwin.debug().built, linked.id, { timeout: BUILD_TIMEOUT });
  await settled();

  // A phone: the overlay's head is one row that never shrinks, the stage keeps
  // a picture's worth of height, and nothing spills past the map or sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await sleep(500);
  const phone = await page.evaluate(() => {
    const r = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const head = r('#map-twin .map-twin-head'), stage = r('#twin-stage'), attrib = r('#map-twin .map-twin-attrib'),
          host = r('#map-twin'), map = r('#leaflet-map'), bar = r('#map-twin .map-twin-bar');
    return { active: MapTwin.active(), head, stage, attrib, host, map, bar,
             scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
             labelsHidden: [...document.querySelectorAll('#map-twin .map-twin-label')].every(el => getComputedStyle(el).display === 'none') };
  });
  ok('on a phone the twin is still up, the head is one row above a stage of at least 160 px, and the credit line is inside the map',
    phone.active && phone.bar.height < 60 && phone.head.bottom <= phone.stage.top + 1 && phone.stage.height >= 160
      && phone.attrib.bottom <= phone.map.bottom + 1 && phone.host.width <= phone.map.width + 1 && phone.labelsHidden,
    JSON.stringify({ bar: phone.bar && phone.bar.height, head: phone.head && phone.head.bottom, stageTop: phone.stage && phone.stage.top,
                     stageH: phone.stage && phone.stage.height, attribBottom: phone.attrib && phone.attrib.bottom, mapBottom: phone.map && phone.map.bottom, labels: phone.labelsHidden }));
  ok('and the page does not scroll sideways', phone.scroll <= phone.client + 1, `${phone.scroll} in ${phone.client}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(500);
  await page.waitForFunction(id => MapTwin.active() && MapTwin.station() === id, linked.id, { timeout: BUILD_TIMEOUT });

  // Out again by the wheel: past the widest orbit, the map takes over one
  // level out.
  const wheeled = await page.evaluate(async () => {
    const cv = document.getElementById('twin-canvas');
    let n = 0;
    while (MapTwin.active() && n < 80) {
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
      await new Promise(r => requestAnimationFrame(r));
      n++;
    }
    return { n, active: MapTwin.active(), zoom: state.map.getZoom(), live: DigitalTwin.debug().live,
             hostOn: document.getElementById('map-twin').classList.contains('is-on'),
             dragging: state.map.dragging.enabled() };
  });
  ok('wheeling out past the edge hands back to the map, one zoom level out, and the renderer goes',
    !wheeled.active && wheeled.zoom === 16 && !wheeled.live && !wheeled.hostOn && wheeled.dragging, JSON.stringify(wheeled));

  // The switch in Map display. Zoom 17 rather than deeper: the topo base the
  // harness's map opens on stops at 17, and Leaflet clamps the map to its
  // layers. (A zoom animation the map may have in flight is waited out
  // first, as map3d does — a view set during one is overruled when it ends.)
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: 10_000 });
  await page.evaluate(([lat, lon]) => { MapTwin.setEnabled(false); state.map.setView([lat, lon], 17, { animate: false }); }, [linked.lat, linked.lon]);
  await sleep(600);
  const off = await page.evaluate(() => ({ active: MapTwin.active(), zoom: state.map.getZoom(), auto: state.mapTwinAuto }));
  ok('switched off, zoom 17 is a map', !off.active && off.zoom === 17 && off.auto === false, JSON.stringify(off));
  await page.evaluate(() => MapTwin.setEnabled(true));
  await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
  await settled();
  ok('switched on again, the same view hands over', await page.evaluate(() => MapTwin.active()));
  // ← Map: one level out from the hand-over.
  await page.evaluate(() => MapTwin.leave());
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: 10_000 });
  await sleep(300);
  const left = await page.evaluate(() => ({ active: MapTwin.active(), zoom: state.map.getZoom() }));
  ok('← Map leaves, to the last zoom before the hand-over', !left.active && left.zoom === 16, JSON.stringify(left));

  // Zooming the map out with the twin up — the map's own move — takes the
  // twin down without touching the zoom asked for.
  await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 17, { animate: false }), [linked.lat, linked.lon]);
  await page.waitForFunction(() => MapTwin.active(), null, { timeout: BUILD_TIMEOUT });
  await page.evaluate(() => state.map.setZoom(12, { animate: false }));
  await page.waitForFunction(() => !MapTwin.active() && !state.map._animatingZoom, null, { timeout: 10_000 });
  ok('zooming the map out takes the twin down at the zoom asked for', (await page.evaluate(() => state.map.getZoom())) === 12);

  // From the overlay to the tab: the same station, no longer embedded, and
  // the paths now read from the relations rather than the map's lines.
  await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 17, { animate: false }), [linked.lat, linked.lon]);
  await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
  await page.evaluate(() => MapTwin.openTab());
  await page.waitForFunction(() => state.activeTab === 'twin' && DigitalTwin.debug().built && !DigitalTwin.debug().embedded, null, { timeout: BUILD_TIMEOUT });
  await settled();
  const onTab = await page.evaluate(async () => {
    const d = DigitalTwin.debug();
    const buf = await DigitalTwin.buildGlb();
    const dv = new DataView(buf);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    return { station: d.stationId, embedded: d.embedded, paths: d.paths, mapUp: !!state.map,
             pathMeshes: json.meshes.filter(m => /^path to /.test(m.name)).length };
  });
  ok('the tab opens on the station from the overlay, with the paths read from the relations',
    onTab.station === linked.id && !onTab.embedded && !onTab.mapUp && onTab.paths && onTab.paths.source === 'data'
      && onTab.paths.count >= linked.far.length && linked.far.every(id => onTab.paths.list.some(p => p.farId === id)),
    JSON.stringify({ ...onTab, paths: onTab.paths && { source: onTab.paths.source, count: onTab.paths.count, far: onTab.paths.list.map(p => p.farId) } }));
  ok('and the .glb carries one mesh per path', onTab.pathMeshes === onTab.paths.count, `${onTab.pathMeshes} vs ${onTab.paths.count}`);

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
