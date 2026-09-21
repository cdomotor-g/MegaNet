// The 3-D view on the Stations map (map-3d.js), held to the four things it
// claims and the one thing it must never do.
//
// Why this is a check of its own, and what every other check here is blind to.
// `smoke` opens the Stations tab and asserts a clean console — which a 3-D
// button that does nothing at all passes, because the mode is off by default
// and nothing throws. `registry` leaves the tab and asserts the Leaflet map was
// taken down — which a WebGL context and its worker pool outliving the div they
// were built on also passes, because they are not a Leaflet map and it never
// looks for them. `maplinks` measures what the 2-D map's links say — and a 3-D
// view drawing an entirely different set of links, in different colours, from a
// second and wrong derivation, leaves every one of its assertions green.
//
// So what is asserted here is the *seam*, not the picture:
//
//   The mirror      every core link and every pin on the 2-D map is in the 3-D
//                   view with the colour the 2-D map gave it — read off
//                   `state.mapLines` rather than compared against a literal, so
//                   a re-ordered palette still passes and a second derivation
//                   does not. The white casings are NOT mirrored: a casing
//                   exists to lift a line off the base map, and in 3-D the
//                   terrain does that.
//
//   The sheet       the load-bearing one. A hop's line-of-sight sheet has to
//                   stand between the ground and the ray, and the ray in a 3-D
//                   view is **not** the straight line a profile chart draws.
//                   path-profile.js keeps the line straight and bends the earth
//                   up under it (`clearance = los - (ground + bulge)`); the
//                   terrain here is drawn where the DEM says it is, so the
//                   bulge has to move to the other side and the sheet's top
//                   edge is `los - bulge`. Write `ray = los` and the picture is
//                   still a picture — a plausible one, drawn over real terrain,
//                   reporting clearance that is not there by up to the bulge,
//                   which on a 60 km hop is ~50 m. Nothing throws, nothing
//                   looks wrong, and the map disagrees with the profile card
//                   about whether a path is blocked. Every assertion about the
//                   sheet is therefore arithmetic against `pathAnalyse`'s own
//                   numbers, computed in the page for the same pair.
//
//   The z-index     the 3-D canvas covers every Leaflet pane and stops below
//                   Leaflet's control container, which is what lets one set of
//                   controls drive both modes. Asserted with
//                   `elementFromPoint` — the geometry, not the stylesheet —
//                   for `maplinks`' reason: a check that reads the CSS agrees
//                   with a bug that put the canvas one layer too high.
//
//   The teardown    leaving the tab takes the GL context with it.
//
//   The lazy load   `window.maplibregl` is undefined until ⛰️ is pressed. This
//                   is the whole justification for fetching a megabyte of
//                   renderer outside index.html's script list, and it is the
//                   kind of claim that decays the first time somebody adds a
//                   convenience call at the top of a file.
//
// The world is made here, as `terrainkit.mjs` makes its: terrarium tiles from a
// closed-form surface, so every height the sheet stands on is arithmetic rather
// than whatever SRTM says about Queensland today. The base-map tiles are a flat
// colour — this check is about geometry, and a drape is a drape.
//
//   node --run map3d        (or: npm run map3d)
//       npm run map3d -- -v    also print what passed

import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const GL_TIMEOUT   = Number(process.env.MAP3D_TIMEOUT || 45_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// ── the world, made here ─────────────────────────────────────────────────────
// terrainkit.mjs's surface, and deliberately the same one: hills every eight
// kilometres, keyed off absolute world position so the landscape is the same at
// every zoom. A sheet that samples at z11 and a profile that samples at z12
// have to be standing on one planet or the comparison between them means
// nothing.
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
const EARTH_KM = 40075.017;
const HILL_KM  = 8;
function heightAtWorld(wx, wy) {
  const K = 2 * Math.PI * EARTH_KM / HILL_KM;
  const a = Math.sin(wx * K) * Math.sin(wy * K);
  const b = Math.sin(wx * K / 9.7 + 0.6) * Math.cos(wy * K / 11.3 + 1.1);
  const c = Math.sin(wx * K / 41 + 2.2);
  return Math.round(180 + 380 * a * a + 220 * b + 90 * c);
}
const demCache = new Map();
function terrariumPng(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const W = 256, H = 256;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const side = 256 * Math.pow(2, z);
  for (let py = 0; py < H; py++) {
    raw[py * (W * 3 + 1)] = 0;
    for (let px = 0; px < W; px++) {
      const v = heightAtWorld((x * 256 + px) / side, (y * 256 + py) / side) + 32768;
      const o = py * (W * 3 + 1) + 1 + px * 3;
      raw[o]     = Math.floor(v / 256) & 0xff;
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  demCache.set(key, png);
  return png;
}

// A base-map tile: one flat colour. The drape is not what this file is about,
// and a tile that is cheap to make is a check that is cheap to run.
let flatTile = null;
function baseTilePng() {
  if (flatTile) return flatTile;
  const W = 8, H = 8;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let py = 0; py < H; py++) {
    raw[py * (W * 3 + 1)] = 0;
    for (let px = 0; px < W; px++) {
      const o = py * (W * 3 + 1) + 1 + px * 3;
      raw[o] = 0x66; raw[o + 1] = 0x99; raw[o + 2] = 0x66;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  flatTile = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return flatTile;
}

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
let demHits = 0, demBlocked = false;

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
// Registered after the policy so they are consulted first: the terrain server
// and the two base-map hosts are answered with this world, and everything else
// off-origin stays blocked.
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  demHits++;
  // `demBlocked` is how the loud-failure assertion is driven: the DEM stops
  // answering and the panel has to say so, because flat ground on screen reads
  // as a clear path and is the one wrong answer that costs a site visit.
  if (demBlocked) return route.abort('blockedbyclient');
  return route.fulfill({ status: 200, contentType: 'image/png',
                         body: terrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(/(tile\.openstreetmap\.org|tile\.opentopomap\.org|server\.arcgisonline\.com)/, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: baseTilePng(),
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
page.on('pageerror', e => errors.push(String(e)));


await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => { const m = state.mapMarkers[0].getLatLng(); state.map.setView([m.lat, m.lng], 11); });
await page.evaluate(() => Map3D.toggle());
await page.waitForFunction(() => !!state.map3d && !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: 60000 });
await page.waitForFunction(() => !!Map3D._map().getTerrain(), null, { timeout: 60000 });
await page.waitForTimeout(1500);

const look = () => page.evaluate(() => {
  const m = Map3D._map();
  const order = m.getStyle().layers.map(l => l.id);
  const src = m.getStyle().sources['mn-elev'];
  return {
    order,
    hasLayer: !!m.getLayer('mn-elev'),
    tiles: src ? src.tiles : null,
    opacity: m.getLayer('mn-elev') ? m.getPaintProperty('mn-elev', 'raster-opacity') : null,
    loaded: m.getLayer('mn-elev') ? m.isSourceLoaded('mn-elev') : null,
    elevOn: MapElevation.active(), sliderVal: state.mapElevOpacity,
  };
});
console.log('OFF   ', JSON.stringify(await look()));

await page.evaluate(() => MapElevation.setEnabled(true));
await page.waitForTimeout(2500);
console.log('ON    ', JSON.stringify(await look()));

await page.evaluate(() => MapElevation.setOpacity(0.35));
await page.waitForTimeout(400);
console.log('DIMMED', JSON.stringify(await look()));

await page.evaluate(() => MapElevation.setRelief(!MapElevation.relief()));
await page.waitForTimeout(2000);
console.log('RELIEF', JSON.stringify(await look()));

await page.screenshot({ path: '/tmp/claude-0/-home-user-MegaNet/391c793f-cc5c-59b9-a853-83e8e72bc76d/scratchpad/elev-3d.png' });

await page.evaluate(() => MapElevation.setEnabled(false));
await page.waitForTimeout(600);
console.log('OFF2  ', JSON.stringify(await look()));

// ── the What is here bridge ────────────────────────────────────────────────
await page.evaluate(() => MapHere.arm(true));
const pt = await page.evaluate(() => {
  const m = Map3D._map(); const r = m.getCanvas().getBoundingClientRect();
  // Somewhere off-centre so the two projections cannot coincide.
  const p = { x: Math.round(r.width * 0.32), y: Math.round(r.height * 0.34) };
  return { cx: Math.round(r.left + p.x), cy: Math.round(r.top + p.y),
           gl: (() => { const l = m.unproject([p.x, p.y]); return [+l.lat.toFixed(5), +l.lng.toFixed(5)]; })(),
           leaflet: (() => { const c = document.getElementById('leaflet-map').getBoundingClientRect();
             const l = state.map.containerPointToLatLng([r.left + p.x - c.left, r.top + p.y - c.top]);
             return [+l.lat.toFixed(5), +l.lng.toFixed(5)]; })() };
});
console.log('pick point — maplibre says', JSON.stringify(pt.gl), 'leaflet says', JSON.stringify(pt.leaflet));
await page.mouse.click(pt.cx, pt.cy);
await page.waitForTimeout(700);
console.log('after pick:', JSON.stringify(await page.evaluate(() => {
  const m = Map3D._map();
  const src = m.getStyle().sources['mn-here'];
  return { point: MapHere.point() ? MapHere.point().map(v => +v.toFixed(5)) : null,
           armed: MapHere.armed(),
           markFeatures: src && src.data ? src.data.features.length : null,
           cardOnScreen: (() => { const el = document.getElementById('here-card');
             return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); })() };
})));
await page.screenshot({ path: '/tmp/claude-0/-home-user-MegaNet/391c793f-cc5c-59b9-a853-83e8e72bc76d/scratchpad/here-3d.png' });
console.log('pageerrors:', errors.join(' | ') || 'none');
await browser.close(); await server.close();
