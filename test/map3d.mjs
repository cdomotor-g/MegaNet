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
//   The lazy load   the library is not imported until ⛰️ is pressed. This
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

import fs from 'node:fs';
import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
// The version map-3d.js pins, read from it, and the one the harness serves:
// they move together (#190), and a pin that drifts from the devDependency
// would be answered by a different MapLibre than the page asked for.
const MAPLIBRE_VER = (fs.readFileSync(new URL('../map-3d.js', import.meta.url), 'utf8')
  .match(/const LIB_VER\s*=\s*'([^']+)'/) || [])[1];
const MAPLIBRE_DEV = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  .devDependencies['maplibre-gl'];
// The grid the rising water reads the ground's range off (9b), read from the
// file for the same reason: the check reads the same points, not a copy of them.
const WATER_GRID = Number((fs.readFileSync(new URL('../map-3d.js', import.meta.url), 'utf8')
  .match(/const WATER_GRID\s*=\s*(\d+)/) || [])[1]) || 0;
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
// The Queensland cadastre's export — the 2-D property boundaries' one image
// and the 3-D view's tiles of it and of the road reserve. A flat picture, like
// the base map's: what is asserted is what was asked for. `cadFail` drives the
// loud-failure assertion, as `demBlocked` does for the terrain.
const cadAsked = [];
let cadFail = false;
await page.route(/LandParcelPropertyFramework\/MapServer\/export\?/, route => {
  cadAsked.push(route.request().url());
  if (cadFail) return route.abort('blockedbyclient');
  return route.fulfill({ status: 200, contentType: 'image/png', body: baseTilePng(),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// ── 0. WebGL, or nothing below this line means anything ─────────────────────
// Playwright's headless Chromium renders WebGL through SwiftShader, which is
// software and slow but complete. If it is ever not there, this file has to say
// so in as many words rather than reporting forty failures about a 3-D view
// that was never given a chance to draw.
const gl2 = await page.evaluate(() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); }
  catch (_) { return false; }
});
if (!gl2) {
  console.log('\n  SKIP — this browser has no WebGL2, so the 3-D view cannot be checked here.');
  console.log('         MapLibre needs it; Playwright\'s bundled Chromium has it through SwiftShader.');
  await browser.close(); await server.close();
  process.exit(0);
}

// ── 1. the renderer is not fetched until it is asked for ────────────────────
console.log('\nThe renderer is fetched on demand, not at load');

const libRequests = [];
page.on('request', r => { if (/unpkg\.com\/maplibre-gl@[^/]+\/dist\/maplibre-gl\.mjs/.test(r.url())) libRequests.push(r.url()); });
const beforePress = await page.evaluate(() => ({
  lib:    Map3D._lib() === null ? 'undefined' : typeof Map3D._lib(),
  script: !!document.querySelector('script[src*="maplibre-gl"]'),
  mode:   state.map3d,
  host:   !!document.getElementById('map3d'),
}));
ok('the page has loaded and opened the map without MapLibre',
   beforePress.lib === 'undefined' && libRequests.length === 0,
   `library: ${beforePress.lib}, ${libRequests.length} request(s)`);
ok('…and without a script tag for it',  beforePress.script === false);
ok('3-D is off until it is asked for',  beforePress.mode === false);
ok('and there is no canvas over the map', beforePress.host === false);

// The button, and the panel beside it.
const btn3d = page.locator('.mn-map-3d');
ok('the map has one ⛰️ button, in the side panel\'s strip', await btn3d.count() === 1
   && await page.evaluate(() => !!document.querySelector('.mn-map-3d').closest('#help-panel .dock-strip')));
// …in the Map section, last, with its camera pair under it — and the 3-D
// settings with no button of their own: ⛰️ opens them (section 2).
const rail3d = await page.evaluate(() => {
  const show = document.querySelector('#help-panel .dock-strip > .dock-group[data-group="show"]');
  const keys = show ? [...show.children].map(b => b.dataset.dock || [...b.classList].find(c => c.startsWith('mn-map-')) || b.className) : [];
  return { keys, settingsBtn: !!document.querySelector('#help-panel .dock-tab[data-dock="map-3d"]'),
           pane: !!document.getElementById('map-3d-panel-body') && !!document.getElementById('map-3d-panel-body').closest('#help-panel .dock-pane') };
});
ok('…standing last in the Map section with its camera pair, the 3-D settings a pane with no button of its own',
   JSON.stringify(rail3d.keys.slice(-3)) === JSON.stringify(['mn-map-3d', 'mn-map-north', 'mn-map-tilt'])
     && !rail3d.settingsBtn && rail3d.pane, JSON.stringify(rail3d));
const paneBefore = await page.evaluate(() => dockShowing());
ok('…which reports that the mode is off',
   await btn3d.getAttribute('aria-pressed') === 'false');

// The rising water is on until somebody turns it off — and is turned off here,
// before the first press, so that every section up to its own (9b) draws what
// it always drew at the speed it always did: each step of the rise re-drapes
// the view, and SwiftShader drawing that while a section waited on the hint's
// .3 s fade made the fade late.
ok('Rising water is on until it is turned off', await page.evaluate(() => state.map3dWater === true));
await page.evaluate(() => Map3D.setWater(false));

// ── 2. pressing it starts a real 3-D map ────────────────────────────────────
console.log('\nPressing ⛰️ starts a 3-D map');

await btn3d.click();
await page.waitForFunction(
  () => typeof Map3D !== 'undefined' && !!Map3D._map() && Map3D._map().isStyleLoaded(),
  null, { timeout: GL_TIMEOUT });
// One idle frame, so the terrain is set and the tiles the camera wants are in.
await page.waitForFunction(() => {
  const m = Map3D._map();
  return !!m && !!m.getTerrain();
}, null, { timeout: GL_TIMEOUT });

const cam = await page.evaluate(() => {
  const m = Map3D._map();
  return {
    lib:      Map3D._lib() ? typeof Map3D._lib() : 'undefined',
    version:  Map3D._lib() && Map3D._lib().getVersion ? Map3D._lib().getVersion() : null,
    global:   typeof window.maplibregl,
    worker:   Map3D._lib() && Map3D._lib().getWorkerUrl ? (Map3D._lib().getWorkerUrl() || '') : null,
    on:       state.map3d,
    terrain:  m.getTerrain(),
    pitch:    m.getPitch(),
    maxPitch: m.getMaxPitch(),
    rotate:   !!(m.dragRotate && m.dragRotate.isEnabled()),
    keyboard: !!(m.keyboard && m.keyboard.isEnabled()),
    touch:    !!(m.touchPitch && m.touchPitch.isEnabled()),
    demSrc:   !!m.getSource('mn-dem'),
    baseSrc:  !!m.getSource('mn-base'),
    layers:   m.getStyle().layers.map(l => l.id),
    // A custom layer is not in getStyle().layers — the style spec has no way to
    // describe one — so it is asked for by name rather than looked for in a list.
    sheetLayer: !!m.getLayer('mn-sheets'),
    canvas:   !!document.querySelector('#map3d canvas'),
    hostOn:   document.getElementById('map3d').classList.contains('is-on'),
  };
});
// The hint at the foot of the view, as the mode opens (section 6b has the rest).
const hudOpen = await page.evaluate(() => {
  const hud = document.getElementById('map3d-hud'), q = document.getElementById('map3d-hud-q');
  return { up: !!hud && !hud.classList.contains('is-folded') && hud.parentNode === document.getElementById('map3d'),
           q: !!q && q.getAttribute('aria-expanded') === 'true',
           says: !!hud && hud.textContent.startsWith(viewMoveWords(matchMedia('(pointer: coarse)').matches)) };
});
ok('the renderer is now loaded',            cam.lib === 'object', `typeof = ${cam.lib}`);
ok('…and it is the version map-3d.js pins', !!MAPLIBRE_VER && cam.version === MAPLIBRE_VER
   && MAPLIBRE_DEV === MAPLIBRE_VER, `${cam.version}; map-3d.js ${MAPLIBRE_VER}; devDependency ${MAPLIBRE_DEV}`);
// 6.x is ESM only, imported by map-3d.js (#190): the module's exports are the
// library, and nothing is left on window for another file to start leaning on.
ok('…imported as a module, leaving no global behind', cam.global === 'undefined', cam.global);
// Over http(s) the worker is MapLibre's own, started however it starts it. The
// classic copy is for file:// only (section 10).
ok('…and over http its worker is the library\u2019s own', cam.worker === '', String(cam.worker).slice(0, 40));
ok('the mode is on',                        cam.on === true);
// ⛰️ opens its settings as it tilts the map: the side panel on the 3-D pane.
const settings3d = await page.evaluate(() => {
  const body = document.getElementById('map-3d-panel-body');
  return { showing: dockShowing(), shown: !!body && body.getClientRects().length > 0,
           leave: (document.getElementById('map-3d-toggle') || {}).textContent || '' };
});
ok('…and pressing ⛰️ opened its settings beside the map, offering the way out',
   settings3d.showing === 'map-3d' && settings3d.shown && /Leave 3-D/.test(settings3d.leave),
   JSON.stringify({ before: paneBefore, ...settings3d }));
ok('there is a WebGL canvas over the map',  cam.canvas && cam.hostOn);
ok('terrain is set, from the DEM source',   !!cam.terrain && cam.terrain.source === 'mn-dem',
   JSON.stringify(cam.terrain));
ok('the DEM tiles were actually fetched',   demHits > 0, `${demHits} tiles`);

// How large a pin is drawn where it stands — the leader's ring is sized by it.
// 6.0 took away `map.transform`, which pinScale() read the depth out of; it now
// works the depth out from the camera the map describes (#190). Held against
// the depth MapLibre itself draws with: the transform it still keeps
// internally, read here the way pinScale() used to. If a later MapLibre moves
// that too, these checks say so rather than passing on nothing.
await page.waitForFunction(() => Map3D._map().areTilesLoaded(), null, { timeout: GL_TIMEOUT }).catch(() => {});
const scale = await page.evaluate(() => {
  const m = Map3D._map(), ml = Map3D._lib();
  const tr = m._camera && m._camera.transform;
  const mx = tr && (m.getTerrain() ? tr._pixelMatrix3D : tr._pixelMatrix);
  const own = ll => {
    const mc = ml.MercatorCoordinate.fromLngLat(ll), ws = tr.worldSize;
    const z = m.getTerrain() ? (m.queryTerrainElevation(ll) || 0) : 0;
    const w = mx[3] * mc.x * ws + mx[7] * mc.y * ws + mx[11] * z + mx[15];
    return w > 0 ? tr.cameraToCenterDistance / w : null;
  };
  const cv = m.getCanvas().getBoundingClientRect();
  // The middle, the foot and the far edge of the view, and two off to the
  // sides — where the ground under each is whatever the surface puts there.
  const spots = [[0.5, 0.5], [0.5, 0.92], [0.5, 0.12], [0.1, 0.7], [0.9, 0.3]]
    .map(([fx, fy]) => m.unproject([cv.width * fx, cv.height * fy]));
  return {
    oracle: !!mx,
    rows: spots.map(ll => ({ mine: Map3D._pinScale(ll), own: mx ? own(ll) : null })),
    centre: Map3D._pinScale(m.getCenter()),
    pitch: m.getPitch(),
  };
});
ok('a pin at the centre of the view is drawn at its 2-D size',
   Math.abs(scale.centre - 1) < 1e-6, String(scale.centre));
ok('…larger at the foot of a tilted view and smaller towards the horizon',
   scale.rows[1].mine > 1.2 && scale.rows[2].mine < 0.9, JSON.stringify(scale.rows.map(r => r.mine)));
ok('…by exactly the depth MapLibre draws it at, across the view',
   scale.oracle && scale.rows.every(r => r.mine != null && r.own != null && Math.abs(r.mine / r.own - 1) < 1e-3),
   JSON.stringify(scale));
ok('the base map is draped over it',        cam.baseSrc);
// The camera the whole feature was asked for.
ok('the camera starts tilted',              cam.pitch > 30, `${cam.pitch}°`);
ok('…and can go to 85°',                    cam.maxPitch === 85, String(cam.maxPitch));
ok('drag-rotate is on',                     cam.rotate);
ok('the keyboard can tilt it too',          cam.keyboard);
ok('and a touch screen can',                cam.touch);
ok('…and the view says how, at its foot, as it opens — with a "?" for later', hudOpen.up && hudOpen.q && hudOpen.says,
   JSON.stringify(hudOpen));
// The two depictions the feature is for: a line across the ground, and the
// sheet layer that rises from it.
ok('the links are drawn as a layer',        cam.layers.includes('mn-links'), cam.layers.join(', '));
ok('the stations are drawn as a layer',     cam.layers.includes('mn-stations'));
ok('the sheet layer is registered',         cam.sheetLayer === true);

// The repeater site finder's own source and layers are always in the style
// (sites.mjs drives them with an answer on the map) — and with the finder
// idle they hold nothing and its "everything else" dim is exactly off: the
// network's opacities are the plain per-feature values styleSpec wrote, not a
// multiplication by one, and the drape's 0.35 further down is untouched.
const idleSites = await page.evaluate(() => {
  const m = Map3D._map(), s = Map3D._sites();
  return {
    layers: ['mn-sites-fill', 'mn-sites-area', 'mn-sites-links', 'mn-sites-targets'].every(id => !!m.getLayer(id)),
    source: s.source, features: s.drawn ? s.drawn.features.length : -1, pins: s.pins, dim: s.dim,
    links: m.getPaintProperty('mn-links', 'line-opacity'),
    stations: m.getPaintProperty('mn-stations', 'circle-opacity'),
  };
});
ok('the site finder has a source and layers of its own, empty while it is idle',
   idleSites.layers && idleSites.source && idleSites.features === 0 && idleSites.pins === 0, JSON.stringify(idleSites));
ok('…and its dim is exactly off: the network keeps the opacities it was given',
   idleSites.dim === 1 && JSON.stringify(idleSites.links) === '["get","op"]'
   && JSON.stringify(idleSites.stations) === '["get","op"]', JSON.stringify(idleSites));

// ── 3. the mirror is the 2-D map's own answer ───────────────────────────────
// Read against `state.mapLines` and `state.mapMarkers` rather than against a
// literal, for `maplinks`' reason: a re-ordered palette still passes, and a
// second derivation of "what colour is this link" does not.
console.log('\nWhat it draws is what the 2-D map drew');

const mirror = await page.evaluate(() => {
  const m = Map3D._mirror();
  const cores   = state.mapLines.filter(l => l.mnLinkRole === 'core' || l.mnLinkRole === 'backbone');
  const dashes  = state.mapLines.filter(l => l.mnLinkRole === 'backbone-dash');
  const casings = state.mapLines.filter(l => l.mnLinkRole === 'casing' || l.mnLinkRole === 'backbone-casing');
  const wantColours = cores.map(l => l.options.color).sort();
  const gotColours  = m.links.features.filter(f => f.properties.dash === 0)
                       .map(f => f.properties.colour).sort();
  return {
    links: m.links.features.length,
    cores: cores.length, dashes: dashes.length, casings: casings.length,
    pins:  m.stations.features.length, markers: state.mapMarkers.length,
    coloursMatch: JSON.stringify(wantColours) === JSON.stringify(gotColours),
    sampleWant: wantColours.slice(0, 3), sampleGot: gotColours.slice(0, 3),
    // Every mirrored pin carries the station id its Leaflet marker carries,
    // which is what makes a click in 3-D able to paint the same card.
    idsMatch: JSON.stringify(m.stations.features.map(f => f.properties.id)) ===
              JSON.stringify(state.mapMarkers.map(k => k.mnStationId)),
    fillsMatch: JSON.stringify(m.stations.features.map(f => f.properties.fill)) ===
                JSON.stringify(state.mapMarkers.map(k => k.options.fillColor)),
    ringsMatch: JSON.stringify(m.stations.features.map(f => f.properties.ring)) ===
                JSON.stringify(state.mapMarkers.map(k => k.options.color)),
    // The Bureau's outlines: solid pink round a forecast location, and for an
    // information location the dashed ring's image instead (MapLibre strokes
    // a circle solid and no other way).
    solid: m.stations.features.filter(f => f.properties.outline && !f.properties.dash).length,
    dashed: m.stations.features.filter(f => f.properties.dash).length,
    outlinesMatch: JSON.stringify(m.stations.features.map(f => [f.properties.outline, !!f.properties.dash])) ===
                   JSON.stringify(state.mapMarkers.map(k => [k.options.mnOutline || '', !!(k.options.mnOutline && k.options.mnOutlineDash)])),
    dashLayer: !!Map3D._map().getLayer('mn-stations-outline-dash'),
    dashImages: Map3D._map().listImages().filter(id => id.startsWith('mn-sls-dash-')).length,
  };
});
ok('every pin on the 2-D map is in the 3-D view',
   mirror.pins === mirror.markers, `${mirror.pins} vs ${mirror.markers}`);
ok('…carrying the same station ids, in the same order', mirror.idsMatch);
ok('…the same role colours',                            mirror.fillsMatch);
ok('…and the same filter rings',                        mirror.ringsMatch);
ok('…and the same outlines: solid round a forecast location, dashed round an information one',
   mirror.outlinesMatch && mirror.solid + mirror.dashed > 0, `${mirror.solid} solid, ${mirror.dashed} dashed`);
ok('…the dashed ones drawn as the ring\'s image, made for the pins in view',
   !mirror.dashed || (mirror.dashLayer && mirror.dashImages > 0),
   `layer ${mirror.dashLayer}, ${mirror.dashImages} image(s)`);
ok('every core and backbone line is mirrored, and the casings are not',
   mirror.links === mirror.cores + mirror.dashes,
   `${mirror.links} features for ${mirror.cores} cores + ${mirror.dashes} dashes, `
   + `${mirror.casings} casings dropped`);
ok('a white casing is never mirrored — in 3-D the terrain lifts the line',
   mirror.casings > 0 && mirror.links < mirror.cores + mirror.dashes + mirror.casings,
   `${mirror.casings} casings on the 2-D map`);
ok('each mirrored line carries the colour the 2-D map gave it',
   mirror.coloursMatch, `want ${mirror.sampleWant} got ${mirror.sampleGot}`);

// The colouring is a property of the 2-D map, so changing it has to change the
// 3-D view — without this, "it mirrors" could be true of a mirror taken once.
const recoloured = await page.evaluate(async () => {
  const before = Map3D._mirror().links.features.map(f => f.properties.colour);
  setMapLinkColour('plain');
  await new Promise(r => setTimeout(r, 400));
  const after = Map3D._mirror().links.features.map(f => f.properties.colour);
  const plainDistinct = new Set(after).size;
  setMapLinkColour('freq');
  await new Promise(r => setTimeout(r, 400));
  const back = Map3D._mirror().links.features.map(f => f.properties.colour);
  // What a link is *allowed* to be under the frequency colouring: a channel
  // colour MapFreq actually assigned, or one of the two base colours a hop with
  // no recorded frequency keeps. Computed here, off the module and the theme,
  // so a re-ordered palette or a re-themed line still passes and a colour from
  // nowhere does not.
  const allowed = new Set([
    ...MapFreq.rows().map(r => r.colour),
    cssVar('--map-line', '#ff6f00'),
    cssVar('--map-backbone', '#000000'),
    cssVar('--map-line-blocked', '#d81b60'),
  ]);
  return { beforeDistinct: new Set(before).size, plainDistinct,
           backDistinct: new Set(back).size,
           stray: [...new Set(back)].filter(c => !allowed.has(c)),
           backSet: [...new Set(back)] };
});
ok('the frequency colouring gives the 3-D links more than one colour',
   recoloured.beforeDistinct > 1, `${recoloured.beforeDistinct} colours`);
ok('switching the 2-D map to plain collapses them in 3-D too',
   recoloured.plainDistinct < recoloured.beforeDistinct,
   `${recoloured.plainDistinct} vs ${recoloured.beforeDistinct}`);
ok('switching back restores them',
   recoloured.backDistinct === recoloured.beforeDistinct);
ok('and every colour is one MapFreq assigned or a base colour — none from nowhere',
   recoloured.stray.length === 0,
   `stray: ${recoloured.stray.join(', ')} of ${recoloured.backSet.length}`);

// A filter is the other half of the same claim: hide stations in 2-D and they
// have to be gone from 3-D, or the tilted map is showing a set nobody asked for.
const filtered = await page.evaluate(async () => {
  const all = Map3D._mirror();
  state.filters.searches = [{ text: 'Kanigan', name: true, number: true, alert: true }];
  stationsFilterChanged();
  state.mapHideOthers = true;
  refreshMapLayers();
  await new Promise(r => setTimeout(r, 500));
  const few = Map3D._mirror();
  state.mapHideOthers = false;
  state.filters.searches = [{ text: '', name: true, number: true, alert: true }];
  stationsFilterChanged();
  await new Promise(r => setTimeout(r, 500));
  const back = Map3D._mirror();
  return { all: all.stations.features.length, few: few.stations.features.length,
           back: back.stations.features.length, markers: state.mapMarkers.length };
});
ok('hiding non-matching stations in 2-D hides them in 3-D',
   filtered.few > 0 && filtered.few < filtered.all,
   `${filtered.few} of ${filtered.all}`);
ok('clearing the filter brings them back',
   filtered.back === filtered.markers && filtered.back > filtered.few,
   `${filtered.back} pins, ${filtered.markers} markers`);

// ── 4. the sheet, against pathAnalyse's own arithmetic ──────────────────────
// The one that matters. Everything here is computed twice — once by the module
// and once from `pathAnalyse` in the same page — and compared to the
// millimetre.
console.log('\nThe line-of-sight sheet is the profile card’s own geometry');

const sheet = await page.evaluate(async () => {
  // A pair far enough apart that the earth bulge is tens of metres: on a short
  // hop `los` and `los - bulge` differ by centimetres and the whole trap this
  // assertion exists for would be inside the tolerance.
  const located = state.data.stations.filter(s => s.lat != null && s.lon != null);
  let best = null;
  for (let i = 0; i < located.length && !best; i += 7) {
    for (let j = i + 1; j < located.length; j += 13) {
      const km = acmaHaversineKm(located[i].lat, located[i].lon,
                                 located[j].lat, located[j].lon);
      if (km > 40 && km < 90) { best = [located[i], located[j], km]; break; }
    }
  }
  if (!best) return { none: true };
  const [a, b, km] = best;
  const row = await Map3D._sheetFor(a, b);
  if (!row) return { noRow: true, km };

  // The same path, analysed directly — the profile card's own call.
  const sys = s => (state.data.rm_systems || []).find(r => r.id === s.rm_system_id) || null;
  const agl = s => (sys(s) && sys(s).antenna_height_m != null
                    ? sys(s).antenna_height_m : PATH_DEFAULT_AGL);
  const fq = (x, y) => {
    for (const s of [x, y]) if (s.repeater && s.repeater.rx_mhz > 0) return s.repeater.rx_mhz;
    return PATH_DEFAULT_MHZ;
  };
  const prof = await Terrain.profile([[a.lat, a.lon], [b.lat, b.lon]], 48);
  const an = pathAnalyse(prof, {
    elevA: a.elevation_ahd != null ? a.elevation_ahd : null,
    elevB: b.elevation_ahd != null ? b.elevation_ahd : null,
    aglA: agl(a), aglB: agl(b), freqMhz: fq(a, b),
  });

  // Compare sample by sample. `row` drops samples with no ground, so match on
  // index into the analysed points that survived.
  const pts = an.pts.filter((p, i) => p.ground != null && prof.lat[i] != null);
  let maxRayErr = 0, maxNaiveErr = 0, maxBulge = 0, maxClearErr = 0, ground = 0;
  let clearSamples = 0, blocked = 0, clampedRight = 0;
  for (let i = 0; i < Math.min(row.length, pts.length); i++) {
    const p = pts[i], r = row[i];
    const wantRay = Math.max(p.los - p.bulge, p.ground);
    maxRayErr   = Math.max(maxRayErr, Math.abs(r.ray - wantRay));
    // What the naive version — `ray = los`, bulge forgotten — would have drawn.
    maxNaiveErr = Math.max(maxNaiveErr, Math.abs(r.ray - Math.max(p.los, p.ground)));
    maxBulge    = Math.max(maxBulge, p.bulge);
    ground      = Math.max(ground, Math.abs(r.ground - p.ground));
    // The sheet is never drawn below the ground it stands on, so where the ray
    // has gone under the terrain its thickness is zero rather than negative —
    // which is the picture ("the curtain has run into the hill"), not a
    // different answer. Compared where it is not clamped; the clamp itself is
    // asserted separately, against the sign of the clearance.
    if (p.clearance != null) {
      if (p.clearance >= 0) {
        maxClearErr = Math.max(maxClearErr, Math.abs((r.ray - r.ground) - p.clearance));
        clearSamples++;
      } else {
        blocked++;
        if (Math.abs(r.ray - r.ground) < 1e-6) clampedRight++;
      }
    }
  }
  return {
    km, n: row.length, pts: pts.length,
    maxRayErr, maxNaiveErr, maxBulge, maxClearErr, ground,
    clearSamples, blocked, clampedRight,
    verdict: an.verdict,
    // The colour ramp reads the Fresnel ratio, which is what the verdict reads.
    ratios: row.map(r => r.ratio).filter(v => v != null).length,
    minRatio: Math.min(...row.map(r => (r.ratio == null ? Infinity : r.ratio))),
    worstRatio: an.worst.ratio,
    belowGround: row.filter(r => r.ray < r.ground - 1e-6).length,
  };
});

if (sheet.none || sheet.noRow) {
  ok('a hop long enough to test the bulge on was found', false,
     JSON.stringify(sheet));
} else {
  ok('the sheet stands on the same ground the profile sampled',
     near(sheet.ground, 0, 1e-6), `${sheet.ground} m apart`);
  ok('its top edge is the ray with the earth bulge taken out of it',
     near(sheet.maxRayErr, 0, 1e-6), `${sheet.maxRayErr} m from los − bulge`);
  // The deliberate-break assertion. If somebody writes `ray = los` this file
  // has to go red, and it only can if the two differ by more than the tolerance
  // above — which is what picking a 40–90 km hop buys.
  ok('…which is NOT the straight line a profile chart draws',
     sheet.maxNaiveErr > 1 && sheet.maxBulge > 1,
     `bulge reaches ${sheet.maxBulge.toFixed(1)} m on this ${sheet.km.toFixed(0)} km hop; `
     + `a sheet drawn at los would be ${sheet.maxNaiveErr.toFixed(1)} m out`);
  ok('the sheet’s own thickness is pathAnalyse’s clearance, to the millimetre',
     sheet.clearSamples > 0 && near(sheet.maxClearErr, 0, 1e-3),
     `${sheet.maxClearErr} m over ${sheet.clearSamples} clear samples`);
  ok('…and where the ground is above the line, the sheet closes rather than inverting',
     sheet.blocked === sheet.clampedRight,
     `${sheet.clampedRight} of ${sheet.blocked} blocked samples closed`);
  ok('no part of it is drawn below the ground it stands on',
     sheet.belowGround === 0, `${sheet.belowGround} samples`);
  ok('every interior sample carries a Fresnel ratio for the colour ramp',
     sheet.ratios >= sheet.n - 2, `${sheet.ratios} of ${sheet.n}`);
  ok('and the worst of them is the one pathAnalyse calls the worst',
     near(sheet.minRatio, sheet.worstRatio, 1e-9),
     `${sheet.minRatio} vs ${sheet.worstRatio}`);
}

// Turning the sheets on actually builds geometry, and the exaggeration scales
// the picture without moving the verdict.
console.log('\nThe sheets are built, and exaggeration does not change the answer');

await page.evaluate(() => {
  // A view small enough that the in-view budget is a handful of hops rather
  // than the whole network — which is the geo-fencing the feature is built on.
  Map3D._map().jumpTo({ center: [152.6, -26.0], zoom: 8, pitch: 60 });
  Map3D.setSheets(true);
});
await page.waitForFunction(() => Map3D._sheets().verts > 0 ||
                                 (Map3D._sheets().done === 0 && Map3D._sheets().failed > 0),
  null, { timeout: GL_TIMEOUT }).catch(() => {});
const built = await page.evaluate(() => {
  const s = Map3D._sheets();
  const rows = Map3D._sheetRows();
  return { ...s, sample: rows.length ? rows[0].slice(0, 2) : null,
           note: document.getElementById('map-3d-note')
                   ? document.getElementById('map-3d-note').textContent : '' };
});
ok('switching the sheets on builds geometry',
   built.verts > 0 && built.rows > 0, `${built.rows} hops, ${built.verts} vertices`);
// A pan while profiles are in flight starts a new generation over the top of
// them, and the in-flight count has to survive that: the old profiles are still
// running whatever the new round thinks. Zeroing it on re-queue made each of
// them decrement past zero, and the panel quoted "-3 still measuring…".
const churn = await page.evaluate(async () => {
  const m = Map3D._map();
  const seen = [];
  const views = [[152.4, -26.0], [152.9, -25.6], [152.1, -26.4], [152.6, -25.9], [152.3, -26.1]];
  for (const [lng, lat] of views) {
    m.jumpTo({ center: [lng, lat], zoom: 8.5, pitch: 60 });
    await new Promise(r => setTimeout(r, 220));
    seen.push(Map3D._sheets().pending);
  }
  for (let i = 0; i < 200 && Map3D._sheets().pending > 0; i++) {
    await new Promise(r => setTimeout(r, 100));
    seen.push(Map3D._sheets().pending);
  }
  return { min: Math.min(...seen), last: Map3D._sheets().pending, n: seen.length };
});
ok('panning while profiles are in flight never makes the count go negative',
   churn.min >= 0, `lowest pending seen was ${churn.min} over ${churn.n} readings`);
ok('…and it settles back to nothing in flight',
   churn.last === 0, `${churn.last} still pending`);
ok('and the note says how many hops were sheeted',
   /\d+\s+hops?\s+sheeted/.test(built.note), built.note.slice(0, 120));

const exag = await page.evaluate(async () => {
  // Every sheet in, before anything is compared: a profile still landing
  // between the two reads would change the list for a reason that has nothing
  // to do with exaggeration, and the assertion would be about the race.
  for (let i = 0; i < 400 && Map3D._sheets().pending > 0; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  const before = Map3D._sheetRows().map(r => r.map(p => p.ratio));
  Map3D.setExaggeration(2);
  await new Promise(r => setTimeout(r, 200));
  const after = Map3D._sheetRows().map(r => r.map(p => p.ratio));
  const t = Map3D._map().getTerrain();
  // Read before it is put back — setExaggeration(1) below writes over it.
  const stored = localStorage.getItem('mn-3d-exag');
  Map3D.setExaggeration(1);
  return { same: JSON.stringify(before) === JSON.stringify(after),
           exagApplied: t && t.exaggeration, stored,
           diag: { rows: `${before.length} → ${after.length}`, s: Map3D._sheets() } };
});
ok('2× exaggeration reaches the terrain', exag.exagApplied === 2, String(exag.exagApplied));
ok('…and changes no clearance ratio, so the colours say the same thing',
   exag.same, JSON.stringify(exag.diag));
ok('the setting is remembered', exag.stored === '2');

// ── 5. the loud failure ─────────────────────────────────────────────────────
// A DEM tile that will not come is flat ground on screen, and flat ground
// between two stations reads as a clear path. It has to be said out loud.
console.log('\nA terrain tile that will not come is said out loud');

demBlocked = true;
const loud = await page.evaluate(async () => {
  // Somewhere the DEM has not been fetched for yet, so the blocked route is
  // actually asked.
  Map3D._map().jumpTo({ center: [143.2, -21.4], zoom: 9, pitch: 60 });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    const el = document.getElementById('map-3d-note');
    if (el && /terrain tile/i.test(el.textContent)) {
      return { note: el.textContent.replace(/\s+/g, ' ').trim() };
    }
  }
  const el = document.getElementById('map-3d-note');
  return { note: el ? el.textContent.replace(/\s+/g, ' ').trim() : '(no note)' };
});
ok('the panel warns that terrain tiles could not be fetched',
   /terrain tiles? could not be fetched/i.test(loud.note), loud.note.slice(0, 160));
ok('…and says what that looks like on screen, rather than only that it happened',
   /flat/i.test(loud.note) && /clear path/i.test(loud.note), loud.note.slice(0, 200));
demBlocked = false;

// ── 6. the controls are still controls ──────────────────────────────────────
// Measured with elementFromPoint rather than read off the stylesheet, for
// `maplinks`' reason: a canvas one layer too high looks identical in the CSS
// and swallows every press.
console.log('\nThe 2-D controls still work with the 3-D canvas over the map');

const reachable = await page.evaluate(() => {
  const probe = sel => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { sel, hidden: true };
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { sel, hit: !!(top && (el === top || el.contains(top) || top.contains(el))),
             got: top ? (top.className || top.tagName) : null };
  };
  // Leaflet's own numbers, read off the elements it actually made rather than
  // copied out of its stylesheet into this file.
  const zOf = sel => {
    const el = document.querySelector(sel);
    return el ? Number(getComputedStyle(el).zIndex) : NaN;
  };
  return {
    z: getComputedStyle(document.getElementById('map3d')).zIndex,
    popupPane: zOf('.leaflet-popup-pane'),
    corner:    zOf('.leaflet-top'),
    // Where the map's controls stand at this width: the side panel's strip,
    // beside the map rather than on it — ⛰️ and ⛶ as themselves, Map display
    // as its pane's button (the 3-D settings have none: ⛰️ opens them). Off
    // the map they are out of
    // the canvas's reach whatever its z-index, and this still proves it: the
    // thing under the pointer where each is drawn is that control. And ↺, the
    // one control still *on* the map, in its top-right corner: the one the
    // canvas's z-index is actually standing between, and so the one that says
    // the window below the corners is right.
    probes: ['.mn-map-3d', '.mn-map-full', '#help-panel .dock-tab[data-dock="map-display"]',
             '#leaflet-map .leaflet-top.leaflet-right .mn-map-reset'].map(probe),
  };
});
// The window, not a magic number: above the popup pane (700, the highest
// Leaflet pane) and below the control corners (.leaflet-top / .leaflet-bottom,
// positioned at 1000 and stacking their contents as a unit — which is the part
// that is easy to get wrong, because `.leaflet-control`'s own z-index is 800
// and reads like the ceiling). Both bounds are read out of Leaflet's own
// stylesheet below rather than written here, so a Leaflet upgrade that moved
// either one fails this instead of silently widening it.
ok('the 3-D canvas sits above every Leaflet pane and below the control corners',
   Number(reachable.z) > reachable.popupPane && Number(reachable.z) < reachable.corner,
   `z-index ${reachable.z}, panes up to ${reachable.popupPane}, corners at ${reachable.corner}`);
for (const p of reachable.probes) {
  ok(`${p.sel} is still the thing under the pointer`, p.hit === true,
     p.missing ? 'not in the DOM' : p.hidden ? 'has no box' : `got ${p.got}`);
}

// The panel's own switch and the ⛰️ button in the strip are the same mode.
ok('the ⛰️ button reports the mode is on',
   await btn3d.getAttribute('aria-pressed') === 'true');
const panelBtn = await page.evaluate(() => {
  const b = document.getElementById('map-3d-toggle');
  return b ? { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') } : null;
});
ok('and the panel offers the way out', panelBtn && /Leave 3-D/.test(panelBtn.text),
   JSON.stringify(panelBtn));

// ── 6b. How to move it ───────────────────────────────────────────────────────
// Somebody new to the mode was watched failing to find the tilt: a drag pans,
// and nothing on screen said the other half of the camera is on the right
// button. So the view says how it is moved, at its foot, in the words the
// digital twin's hint uses (viewMoveWords, core.js — the twin's half is in
// `npm run twin`), and folds to a "?" that brings it back. Read off the page:
// where it stands, what it says, that it does not take the drag it describes.
const hudNow = () => page.evaluate(() => {
  const hud = document.getElementById('map3d-hud'), q = document.getElementById('map3d-hud-q');
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const hb = box(hud);
  const under = hb ? document.elementFromPoint((hb.left + hb.right) / 2, (hb.top + hb.bottom) / 2) : null;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return {
    inHost: !!hud && hud.parentNode === document.getElementById('map3d') && !!q && q.parentNode === hud.parentNode,
    text: hud ? hud.textContent : null, words: viewMoveWords(coarse),
    shown: !!hud && getComputedStyle(hud).visibility !== 'hidden' && Number(getComputedStyle(hud).opacity) > 0.5,
    folded: !!hud && hud.classList.contains('is-folded'),
    q: q ? { expanded: q.getAttribute('aria-expanded'), name: q.getAttribute('aria-label'), box: box(q),
             shown: getComputedStyle(q).display !== 'none' } : null,
    passesThrough: !!under && under.classList.contains('maplibregl-canvas'),
    hud: hb, scale: box(document.querySelector('#map3d .maplibregl-ctrl-scale')),
    attrib: box(document.querySelector('#map3d .maplibregl-ctrl-attrib')),
    nav: box(document.querySelector('#map3d .maplibregl-ctrl-bottom-right .maplibregl-ctrl-group')),
    canvasName: (document.querySelector('#map3d canvas.maplibregl-canvas') || {}).getAttribute?.('aria-label') || '',
    keys: viewKeyWords(),
    panel: (document.querySelector('#map-3d-panel-body .map3d-moving') || {}).textContent || '',
    mouse: viewMoveWords(false), touch: viewMoveWords(true),
  };
});
let H = await hudNow();
ok('minutes after 3-D opened, the hint has folded by itself to its "?", which says so',
   H.inHost && H.folded && !H.shown && H.q && H.q.shown && H.q.expanded === 'false' && H.q.name === 'How to move the view',
   JSON.stringify({ inHost: H.inHost, folded: H.folded, shown: H.shown, q: H.q }));
await page.click('#map3d-hud-q');
// The fade in is .3 s, but SwiftShader drawing the terrain can hold the page's
// frames back past a fixed wait (twice in CI, October 2026): wait for the hint
// itself, well inside the 12 s it stays up.
await page.waitForFunction(() => {
  const hud = document.getElementById('map3d-hud');
  return !!hud && getComputedStyle(hud).visibility !== 'hidden' && Number(getComputedStyle(hud).opacity) > 0.5;
}, null, { timeout: 3000 }).catch(() => {});
H = await hudNow();
ok('…and the "?" brings it back', H.shown && !H.folded && H.q.expanded === 'true', JSON.stringify({ shown: H.shown, q: H.q }));
ok('…saying how the view is moved in the twin\'s own words, and where the compass and tilt buttons are',
   !!H.text && H.text.startsWith(H.words) && /compass and tilt buttons under ⛰️/.test(H.text), H.text);
ok('…standing above the credits and the scale bar, and clear of the zoom and compass in the other corner',
   !!H.hud && !!H.scale && !!H.attrib && !!H.nav && H.hud.bottom <= Math.min(H.scale.top, H.attrib.top) + 0.5
     && H.hud.right <= H.nav.left + 0.5, JSON.stringify({ hud: H.hud, scale: H.scale, attrib: H.attrib, nav: H.nav }));
// The credits open across the foot when the map is built and close to an ⓘ on
// the first drag (MapLibre's compact attribution): the hint goes down with them.
const credits = open => page.evaluate(o => document.querySelector('#map3d .maplibregl-ctrl-attrib').classList.toggle('maplibregl-compact-show', o), open);
await credits(true);
await page.waitForTimeout(200);
const raised = await hudNow();
await credits(false);
await page.waitForTimeout(200);
const dropped = await hudNow();
ok('…and goes down with the credits when they close to their ⓘ',
   dropped.hud.bottom > raised.hud.bottom + 10 && dropped.hud.bottom <= Math.min(dropped.scale.top, dropped.attrib.top) + 0.5,
   JSON.stringify({ open: raised.hud.bottom, closed: dropped.hud.bottom, attrib: dropped.attrib }));
ok('…and a drag that starts on it is a drag of the map: it takes no pointer', H.passesThrough);
ok('the canvas\'s name says how the keys move it', H.canvasName.includes(H.keys), H.canvasName);
ok('the 3-D panel says it too, for a mouse, a finger and the keys',
   H.panel.includes(H.mouse) && H.panel.includes(H.touch) && H.panel.includes(H.keys), H.panel.replace(/\s+/g, ' '));
// Its few seconds, made short; "?" pressed while it is up puts it away at once,
// and pressed again brings it back for its few seconds.
await page.evaluate(() => { Map3D._hud(1200); Map3D.toggleHud(); });
H = await hudNow();
const shutAtOnce = H.folded && H.q.expanded === 'false' && H.q.name === 'How to move the view';
await page.click('#map3d-hud-q');
await page.waitForTimeout(450);   // the fade in (.3 s) done, well inside its 1.2 s
const backUp = await hudNow();
await page.waitForTimeout(1400);
H = await hudNow();
ok('"?" pressed while the hint is up puts it away, and pressed again brings it back',
   shutAtOnce && backUp.shown && backUp.q.expanded === 'true', JSON.stringify({ shutAtOnce, back: backUp.shown }));
ok('…for its few seconds, after which it folds to the "?", which says so',
   H.folded && !H.shown && H.q.shown && H.q.expanded === 'false', JSON.stringify({ folded: H.folded, shown: H.shown, q: H.q }));
await page.evaluate(() => Map3D._hud(null));

// ── 7. a pin clicked in 3-D paints a card that is on screen (#193) ──────────
// The section above asks whether the *controls* survive the canvas. This asks
// the same question of the thing the canvas is drawn over, and it is a separate
// section because the answer was different and nothing here could see it.
//
// `map-3d.js` has painted a station card on a pin click since the view shipped,
// and it worked: `state.stnCard.id` was set, the card took its box, and
// `getBoundingClientRect()` answered with real numbers. It was also completely
// invisible — 690 against the canvas's 750, in the stage's own stacking context,
// with an opaque WebGL canvas on top. Every property a check is tempted to read
// said the card was fine.
//
// So the assertion is `elementFromPoint` over the card's own rectangle: not
// "did a card open", not "is it displayed", but **is the card the thing painted
// where the card is**. That is `maplinks`' rule — any check about whether
// something is on screen has to ask the geometry — applied to the one question
// z-index can answer wrongly while every other signal reads true.
console.log('\nA pin clicked in 3-D paints a card you can see');

// The camera has stopped and the tiles it asked for are in. A pin stands on
// the terrain under it, so until the DEM tiles for a new view have landed it
// is drawn a few pixels from where project() puts it, and a click aimed from a
// fixed wait misses by that much whenever the page is busy. The 2-D map under
// the canvas follows the camera, so a jump is a round of that map's tiles too,
// which is exactly when the page is busy. Used after the fixed wait, not
// instead of it: areTilesLoaded() is true for a moment before a jump's first
// frame has asked for anything.
const idle3d = () => page.waitForFunction(() => {
  const m = Map3D._map();
  return !!m && !m.isMoving() && m.areTilesLoaded();
}, null, { timeout: GL_TIMEOUT }).catch(() => {});

// A repeater, so the same click exercises the focus dim the 2-D handler runs.
// The camera goes to it rather than hoping one is in frame.
const pin = await page.evaluate(() => {
  const rep = (state.mapMarkers || []).find(
    m => m.mnStation && m.mnStation.roles && m.mnStation.roles.includes('repeater'));
  if (!rep) return null;
  const ll = rep.getLatLng();
  Map3D._map().jumpTo({ center: [ll.lng, ll.lat], zoom: 12, pitch: 60, bearing: 0 });
  return { id: rep.mnStationId, lat: ll.lat, lng: ll.lng };
});
ok('the file has a repeater to click', !!pin);

// Where the renderer says the pin is, rather than where the arithmetic says
// it should be: pins are billboarded circles standing on terrain, and the
// question this check is asking is about what a *click* does.
const pinOnScreen = t => page.evaluate((t) => {
  const m = Map3D._map();
  const p = m.project([t.lng, t.lat]);
  const r = m.getCanvas().getBoundingClientRect();
  const f = m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] });
  const hit = f.length ? f[0].properties.id : null;
  const mk  = (state.mapMarkers || []).find(x => x.mnStationId === hit);
  return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y), hit,
           repeater: !!(mk && mk.mnStation && mk.mnStation.roles
                        && mk.mnStation.roles.includes('repeater')) };
}, t);

if (pin) {
  await page.waitForTimeout(1200);
  await idle3d();
  const where = await pinOnScreen(pin);
  ok('the pin under the pointer is a station the 2-D map drew', where.hit != null,
     JSON.stringify(where));

  await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
  await page.mouse.click(where.x, where.y);
  await page.waitForTimeout(500);

  const card = await page.evaluate(() => {
    const el = document.getElementById('stn-card');
    const r  = el.getBoundingClientRect();
    const z  = n => (n ? Number(getComputedStyle(n).zIndex) : NaN);
    const mine = (x, y) => {
      const t = document.elementFromPoint(x, y);
      return { mine: !!(t && (t === el || el.contains(t))),
               got: t ? (t.id || t.className || t.tagName) : null };
    };
    return {
      id: state.stnCard.id,
      focus: state.mapFocusRepeaterId,
      box: r.width > 0 && r.height > 0,
      topLeft: mine(r.left + 14, r.top + 14),
      centre:  mine(r.left + r.width / 2, r.top + r.height / 2),
      cardZ:   z(el),
      hereZ:   z(document.getElementById('here-card')),
      canvasZ: z(document.getElementById('map3d')),
      cornerZ: z(document.querySelector('.leaflet-top')),
    };
  });

  ok('clicking the pin opens that station’s card', card.id === where.hit,
     JSON.stringify({ card: card.id, clicked: where.hit }));
  ok('…and the card has a box', card.box);
  // The two that matter. Everything above this was already true while the card
  // was buried under the canvas.
  ok('…and the card is what is painted at its own top-left corner',
     card.topLeft.mine === true, `got ${card.topLeft.got}`);
  ok('…and at its own centre', card.centre.mine === true, `got ${card.centre.got}`);
  // The window, for the same reason the canvas's own is asserted above: over
  // the canvas so it can be seen, under the control corners so the controls it
  // shares the map with stay reachable — Leaflet's zoom, and on any other map
  // the whole icon column.
  ok('the card sits above the 3-D canvas and below the control corners',
     card.cardZ > card.canvasZ && card.cardZ < card.cornerZ,
     JSON.stringify({ card: card.cardZ, canvas: card.canvasZ, corner: card.cornerZ }));
  ok('and What is here’s card, which was under it too, is lifted with it',
     card.hereZ > card.canvasZ && card.hereZ < card.cornerZ,
     JSON.stringify({ here: card.hereZ, canvas: card.canvasZ, corner: card.cornerZ }));
  // The rest of what a 2-D pin click does, less the callout this mode cannot
  // draw: a repeater takes the focus dim with it.
  if (where.repeater) {
    ok('clicking a repeater in 3-D focuses it, as it does in 2-D',
       card.focus === where.hit, JSON.stringify({ focus: card.focus, clicked: where.hit }));
    // The card has to go before the pin can be clicked a second time, and that
    // is the card working rather than the check cheating: it opens bottom-left
    // and grows to most of the map's height, so a pin near the middle of the
    // view is underneath it by the time it is open. `closeStnCard(false)`
    // clears the card and nothing else — the focus is the state under test and
    // it is left exactly as the first click set it.
    //
    // And the pin is found again rather than clicked where it was: a card
    // opened over its own pin slides the camera until the pin is clear of it,
    // so the leader has somewhere to go (MapLeader.reveal, the next section).
    await page.evaluate(() => closeStnCard(false));
    await page.waitForTimeout(150);
    await idle3d();
    const again = await pinOnScreen(pin);
    await page.mouse.click(again.x, again.y);
    await page.waitForTimeout(400);
    ok('…and clicking it again clears the focus',
       await page.evaluate(() => state.mapFocusRepeaterId) == null);
  }
  await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
}

// ── 7a. hovering names a pin, and a near miss still opens it ────────────────
// A pin up a tilted view is a dot of a few pixels. Hovering one has to say
// what it is without opening anything, and a click just off its edge has to
// be that pin's rather than the path running into it (PIN_HIT_PX).
console.log('\nHovering a pin in 3-D names it, and a near miss still opens it');
if (pin) {
  await page.evaluate((t) => Map3D._map().jumpTo({ center: [t.lng, t.lat], zoom: 12, pitch: 60, bearing: 0 }), pin);
  await page.waitForTimeout(1200);
  await idle3d();
  const at = await pinOnScreen(pin);
  await page.mouse.move(at.x - 40, at.y - 40);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await page.waitForTimeout(150);
  const tip = await page.evaluate((id) => {
    const el = document.querySelector('#map3d .map3d-tip');
    const mk = (state.mapMarkers || []).find(m => m.mnStationId === id);
    return { shown: !!(el && !el.hidden && el.offsetWidth > 0),
             text: el ? el.textContent : '', name: mk && mk.mnStation ? mk.mnStation.name : null,
             cursor: Map3D._map().getCanvas().style.cursor, card: state.stnCard.id };
  }, at.hit);
  ok('hovering a pin shows a label with its name', tip.shown && !!tip.name && tip.text.includes(tip.name),
     JSON.stringify(tip));
  ok('…and the pointer says it can be clicked, and nothing opened', tip.cursor === 'pointer' && tip.card == null,
     JSON.stringify(tip));

  // Off the drawn circle, inside the tolerance: the bare point misses and the
  // click still lands on the pin.
  const miss = await page.evaluate((t) => {
    const m = Map3D._map();
    const r = m.getCanvas().getBoundingClientRect();
    const x0 = t.x - r.left, y0 = t.y - r.top;
    // Outward from the centre in each direction to the first pixel the bare
    // point misses: just past the drawn edge, well inside the tolerance.
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let d = 1; d <= 30; d++) {
        const x = x0 + ux * d, y = y0 + uy * d;
        if (!m.queryRenderedFeatures([x, y], { layers: ['mn-stations'] }).length) {
          return { x: Math.round(r.left + x + ux), y: Math.round(r.top + y + uy), d: d + 1 };
        }
      }
    }
    return null;
  }, at);
  if (miss) {
    await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
    await page.mouse.click(miss.x, miss.y);
    await page.waitForTimeout(500);
    const got = await page.evaluate(() => state.stnCard.id);
    ok('a click just off a pin’s edge opens that pin’s card', got === at.hit,
       JSON.stringify({ got, pin: at.hit, miss }));
  } else {
    ok('a click just off a pin’s edge opens that pin’s card', true, 'no clear near-miss spot in frame — not exercised');
  }
  await page.mouse.move(5, 5);
  await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
}

// ── 7b. the card's gold leader, over the canvas ─────────────────────────────
// In 2-D a gold leader runs from the station card's top edge to a ring round
// its pin (map-leader.js). In 3-D it was simply not there: it is drawn in a
// Leaflet pane, and every Leaflet pane is under the canvas. So it is drawn over
// the canvas now, to where MapLibre stands the pin on the terrain, and what is
// asserted is the geometry rather than the picture:
//
//   * it is *there* — the thing `elementFromPoint` finds along its own line,
//     over the canvas, and not the canvas;
//   * it ends on the pin the renderer drew — `project()` — and goes on ending
//     there through a turn of the camera;
//   * its ring clears the pin as MapLibre draws it, which is not the 2-D size:
//     a circle layer scales with depth, so a pin at the foot of a steep view is
//     drawn half as large again. That is measured with MapLibre's own hit-test
//     (`queryRenderedFeatures`), which scales a circle by its depth in its own
//     code, independently of the leader's arithmetic — and a ring at the 2-D
//     size is shown to cut through the same pin, so the check is not passing
//     on a pin too small to tell;
//   * a pin the card covers gets no leader until the camera slides it clear
//     (MapLeader.reveal), as a click on a pin there does;
//   * and it goes with the card. Leaving 3-D gives it back to the 2-D pane —
//     asserted below, where the camera section leaves 3-D.
console.log('\nThe card’s gold leader reaches its pin in 3-D');

// The leader as drawn, and the pin as the renderer has it, in the map
// container's pixels — the canvas covers the container exactly.
const leader3d = id => page.evaluate((id) => {
  const m = Map3D._map();
  const g = MapLeader.geometry();
  const mk = state.mapMarkers.find(x => String(x.mnStationId) === String(id));
  const ll = mk.getLatLng();
  const p = m.project([ll.lng, ll.lat]);
  const svg = document.querySelector('.mn-leader');
  const cont = state.map.getContainer().getBoundingClientRect();
  const c = document.getElementById('stn-card').getBoundingClientRect();
  // The case is the widest of the three strokes: its inner edge is where the
  // ring stops being clear ground.
  const ring = document.querySelector('.mn-leader-case .mn-leader-ring');
  const caseW = ring ? parseFloat(getComputedStyle(ring).strokeWidth) : NaN;
  const hit = (x, y) => m.queryRenderedFeatures([x, y], { layers: ['mn-stations'] })
    .some(f => String(f.properties.id) === String(id));
  const out = {
    g, pin: { x: p.x, y: p.y },
    parent: svg && svg.parentNode ? (svg.parentNode.id || svg.parentNode.className) : null,
    card: { left: c.left - cont.left, top: c.top - cont.top,
            right: c.right - cont.left, bottom: c.bottom - cont.top },
    // What a 2-D ring would be: Leaflet's radius and the leader's 6 px gap.
    ring2d: mk.getRadius() + 6, caseW,
  };
  if (g) {
    const inner = g.ring.r - caseW / 2 - 0.5;
    const inner2d = out.ring2d - caseW / 2 - 0.5;
    out.hitCentre = hit(g.ring.x, g.ring.y);
    // Just inside the ring's inner edge, below the pin (towards the camera)
    // and beside it.
    out.clear = !hit(g.ring.x, g.ring.y + inner) && !hit(g.ring.x + inner, g.ring.y);
    out.cut2d = hit(g.ring.x, g.ring.y + inner2d) || hit(g.ring.x + inner2d, g.ring.y);
  }
  return out;
}, id);

// The camera put somewhere with the station `at` a fraction of the canvas
// from its middle — MapLibre's own offset, which stands the point itself there.
const aim = (t, at, cam) => page.evaluate(({ t, at, cam }) => {
  const m = Map3D._map(), c = m.getCanvas();
  m.easeTo({ center: [t.lng, t.lat], ...cam, duration: 0,
             offset: [at[0] * c.clientWidth, at[1] * c.clientHeight] });
}, { t, at, cam });

if (pin) {
  await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
  await page.evaluate(t => Map3D._map().jumpTo({ center: [t.lng, t.lat], zoom: 12, pitch: 60, bearing: 0 }), pin);
  await page.waitForTimeout(800);
  await idle3d();
  const at = await pinOnScreen(pin);
  await page.mouse.click(at.x, at.y);
  // The click may slide the camera: the card opens over the middle of the map.
  await page.waitForTimeout(900);
  await idle3d();

  const a = await leader3d(pin.id);
  ok('a pin clicked in 3-D gets the card’s leader, drawn for the 3-D view',
     !!a.g && String(a.g.id) === String(pin.id) && a.g.view === '3d', JSON.stringify(a.g));
  ok('…over the canvas, not on the 2-D pane under it', a.parent === 'map3d', String(a.parent));
  if (a.g) {
    ok('it ends on the pin where MapLibre stands it on the terrain',
       near(a.g.ring.x, a.pin.x, 1.5) && near(a.g.ring.y, a.pin.y, 1.5),
       JSON.stringify({ ring: a.g.ring, pin: a.pin }));
    ok('…and leaves the card from its top outline',
       a.g.from.y >= a.card.top - 0.5 && a.g.from.y <= a.card.top + 8.5
       && a.g.from.x >= a.card.left - 0.5 && a.g.from.x <= a.card.right + 0.5,
       JSON.stringify({ from: a.g.from, card: a.card }));
    ok('…to a pin the card is not covering',
       !(a.pin.x > a.card.left && a.pin.x < a.card.right && a.pin.y > a.card.top && a.pin.y < a.card.bottom),
       JSON.stringify({ pin: a.pin, card: a.card }));
    // The svg is never a click target (pointer-events: none), which also hides
    // it from elementFromPoint — so it is made one for the length of the probe.
    const painted = await page.evaluate(() => {
      const g = MapLeader.geometry(), svg = document.querySelector('.mn-leader');
      const cont = state.map.getContainer().getBoundingClientRect();
      const x = cont.left + (g.from.x + g.to.x) / 2, y = cont.top + (g.from.y + g.to.y) / 2;
      svg.style.pointerEvents = 'auto';
      const t = document.elementFromPoint(x, y);
      svg.style.pointerEvents = '';
      return { line: !!(t && t.classList && t.classList.contains('mn-leader-line')),
               got: t ? (t.getAttribute('class') || t.tagName) : null };
    });
    ok('…and it is what is painted along its own line, over the canvas',
       painted.line, `got ${painted.got}`);
  }

  // A turn of the camera, which the 2-D map has no way to follow.
  await page.evaluate(() => Map3D._map().jumpTo({ bearing: 25 }));
  await page.waitForTimeout(400);
  await idle3d();
  const b = await leader3d(pin.id);
  ok('it follows the pin through a turn of the camera',
     !!b.g && near(b.g.ring.x, b.pin.x, 1.5) && near(b.g.ring.y, b.pin.y, 1.5),
     JSON.stringify({ ring: b.g && b.g.ring, pin: b.pin }));

  // The foot of a steep view: right of the card, low down, close to the camera.
  await aim(pin, [0.2, 0.35], { zoom: 13, pitch: 70, bearing: 0 });
  await page.waitForTimeout(800);
  await idle3d();
  const c = await leader3d(pin.id);
  ok('close to the camera the pin is drawn larger than in 2-D, and the ring grows with it',
     !!c.g && c.g.ring.r > c.ring2d && c.hitCentre,
     JSON.stringify({ r: c.g && c.g.ring.r, ring2d: c.ring2d, hitCentre: c.hitCentre }));
  ok('…where a ring at the 2-D size would cut through it (MapLibre’s own hit-test)',
     c.cut2d === true, JSON.stringify({ ring2d: c.ring2d, caseW: c.caseW }));
  ok('…and the leader’s ring clears it', c.clear === true,
     JSON.stringify({ r: c.g && c.g.ring.r, caseW: c.caseW }));
  ok('…still on the pin', !!c.g && near(c.g.ring.x, c.pin.x, 1.5) && near(c.g.ring.y, c.pin.y, 1.5),
     JSON.stringify({ ring: c.g && c.g.ring, pin: c.pin }));

  // And out towards the horizon, where it is drawn smaller.
  await aim(pin, [0.2, -0.35], { zoom: 13, pitch: 70, bearing: 0 });
  await page.waitForTimeout(800);
  await idle3d();
  const d = await leader3d(pin.id);
  ok('towards the horizon the ring shrinks with the pin, and still clears it',
     !!d.g && d.g.ring.r < d.ring2d && d.clear === true,
     JSON.stringify({ r: d.g && d.g.ring.r, ring2d: d.ring2d, clear: d.clear }));

  // Under the card: no leader, until reveal() — what a click on a pin there
  // runs — slides the camera until the pin is out from under it.
  await page.evaluate(t => {
    const m = Map3D._map(), cv = m.getCanvas();
    const cr = cv.getBoundingClientRect(), k = document.getElementById('stn-card').getBoundingClientRect();
    const x = k.left + k.width / 2 - cr.left, y = k.top + k.height / 2 - cr.top;
    m.easeTo({ center: [t.lng, t.lat], zoom: 12, pitch: 60, bearing: 0, duration: 0,
               offset: [x - cv.clientWidth / 2, y - cv.clientHeight / 2] });
  }, pin);
  await page.waitForTimeout(800);
  await idle3d();
  const e = await leader3d(pin.id);
  ok('a pin the card is covering gets no leader',
     e.g === null && e.pin.x > e.card.left && e.pin.x < e.card.right
     && e.pin.y > e.card.top && e.pin.y < e.card.bottom,
     JSON.stringify({ g: e.g, pin: e.pin, card: e.card }));
  await page.evaluate(() => MapLeader.reveal());
  await page.waitForTimeout(900);
  await idle3d();
  const f = await leader3d(pin.id);
  ok('…until reveal() slides the camera to bring it out, and then it has one',
     !!f.g && f.g.view === '3d' && near(f.g.ring.x, f.pin.x, 1.5) && near(f.g.ring.y, f.pin.y, 1.5)
     && !(f.pin.x > f.card.left && f.pin.x < f.card.right && f.pin.y > f.card.top && f.pin.y < f.card.bottom),
     JSON.stringify({ g: f.g, pin: f.pin, card: f.card }));
  const tilt = await page.evaluate(() => {
    const m = Map3D._map();
    return { pitch: m.getPitch(), bearing: m.getBearing(), zoom: m.getZoom() };
  });
  ok('…keeping the zoom, the tilt and the heading',
     near(tilt.pitch, 60, 0.5) && near(tilt.bearing, 0, 0.5) && near(tilt.zoom, 12, 0.05),
     JSON.stringify(tilt));

  await page.evaluate(() => closeStnCard(false));
  await page.waitForTimeout(150);
  ok('closing the card takes the leader with it',
     await page.evaluate(() => MapLeader.geometry()) === null);
}

// ── 8. the elevation drape, and the What is here bridge (#194) ──────────────
// Two layers of the 2-D map that were simply absent when it was tilted, and
// they failed in opposite ways. The elevation ramp went *quiet*: the switch
// stayed on, the slider stayed where it was, and the colours were gone — which
// is the hardest kind to notice here, because the 3-D view shows relief through
// shading anyway, so the hills are still there and only their meaning has
// left. **What is here** did the other thing and answered confidently about the
// wrong ground: the pick ran off the 2-D map's click, whose `latlng` is that
// pixel's place on the *Leaflet* map, while the camera looking at it has its
// own centre, zoom, pitch and bearing.
console.log('\nThe elevation ramp is draped on the terrain, and What is here picks the right ground');

const elevLook = () => page.evaluate(() => {
  const m = Map3D._map();
  const st = m.getStyle();
  return {
    order:   st.layers.map(l => l.id),
    layer:   !!m.getLayer('mn-elev'),
    tiles:   st.sources['mn-elev'] ? st.sources['mn-elev'].tiles : null,
    attrib:  st.sources['mn-elev'] ? st.sources['mn-elev'].attribution : null,
    opacity: m.getLayer('mn-elev') ? m.getPaintProperty('mn-elev', 'raster-opacity') : null,
    on: MapElevation.active(), slider: state.mapElevOpacity, relief: MapElevation.relief(),
  };
});

// The camera is parked for the rest of this section, so nothing but the drape
// can change what the renderer is asked to draw.
await page.evaluate(() => {
  const m = state.mapMarkers[0].getLatLng();
  Map3D._map().jumpTo({ center: [m.lng, m.lat], zoom: 11, pitch: 60, bearing: 0 });
});
await page.waitForTimeout(1500);

// **How this asks whether the drape actually draws, and why not by looking.**
// The first version of this section screenshotted the canvas with the overlay
// off and again with it on and required the two to differ. It passed with the
// drape pinned to zero opacity — a deliberate break it should have caught —
// because a terrain tile arriving between the two shots changes the pixels
// whatever the drape did. Waiting for two identical frames first narrowed it
// and did not close it.
//
// So it counts instead. `MapElevation.paintedTile` is the one function that
// turns a terrarium tile into ramp colours, and map-3d.js's protocol is the
// only thing in this mode that calls it. Wrapping it and requiring the count to
// rise is a fact about what ran rather than a guess about what appeared — and
// it asserts the property that matters, which is that the drape's pixels come
// out of MapElevation rather than out of a second implementation here.
await page.evaluate(() => {
  const real = MapElevation.paintedTile;
  window.__paints = 0;
  MapElevation.paintedTile = function (...a) { window.__paints++; return real.apply(this, a); };
});

const flat = await elevLook();
ok('with the overlay off there is no drape on the terrain',
   flat.layer === false && flat.tiles === null, JSON.stringify(flat));
ok('nothing has painted a ramp tile while the overlay is off',
   await page.evaluate(() => window.__paints) === 0);

await page.evaluate(() => { MapElevation.setRelief(true); MapElevation.setOpacity(1); MapElevation.setEnabled(true); });
await page.waitForFunction(() => {
  const m = Map3D._map();
  return !!m.getLayer('mn-elev') && m.isSourceLoaded('mn-elev');
}, null, { timeout: GL_TIMEOUT }).catch(() => {});
await page.waitForTimeout(1200);
const on = await elevLook();

ok('turning it on adds a raster layer served by the elevation protocol',
   on.layer === true && Array.isArray(on.tiles) && /^mn-elev:\/\//.test(on.tiles[0]),
   JSON.stringify(on));
// The order is the assertion, not the presence: the ramp is painted *over* the
// base map it qualifies and *under* everything the network draws on it, which
// is the same place its pane occupies in 2-D (245, between the base tiles and
// the overlays).
ok('…between the base map and the links, as it is in 2-D',
   on.order.indexOf('mn-elev') > on.order.indexOf('mn-base')
   && on.order.indexOf('mn-elev') < on.order.indexOf('mn-links'),
   JSON.stringify(on.order));
ok('…carrying the source’s own credit', typeof on.attrib === 'string' && /Terrain/i.test(on.attrib),
   String(on.attrib));
// And that it actually draws: the camera has not moved, nothing else changed,
// so a canvas identical to the one before it would mean a layer that exists and
// paints nothing — which every assertion above would happily pass.
const paints = await page.evaluate(() => window.__paints);
ok('…and it really fetched and painted tiles, through MapElevation’s own painter',
   paints > 0, `${paints} tiles painted`);

// The painter is MapElevation's, which is the property that stops the two modes
// disagreeing about what a height looks like. With relief off a pixel is the
// band colour and nothing else, so it can be held against the ramp directly.
const paint = await page.evaluate(async () => {
  MapElevation.setRelief(false);
  const z = 10, x = 920, y = 590;
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => rej(new Error('tile unavailable'));
    i.src = MapElevation.tileUrl(z, x, y);
  });
  const canvas = MapElevation.paintedTile(img, z, y);
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const raw = document.createElement('canvas');
  raw.width = raw.height = MapElevation.TILE_PX;
  raw.getContext('2d').drawImage(img, 0, 0);
  const out = [];
  for (const [px, py] of [[40, 40], [128, 128], [200, 90]]) {
    const t = raw.getContext('2d').getImageData(px, py, 1, 1).data;
    const height = t[0] * 256 + t[1] + t[2] / 256 - 32768;
    const p = cx.getImageData(px, py, 1, 1).data;
    const hex = '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    out.push({ height: Math.round(height), painted: hex.toUpperCase(),
               ramp: MapElevation.colourAt(height).toUpperCase() });
  }
  return out;
});
ok('the drape is painted by MapElevation’s own ramp, not a copy of it',
   paint.length === 3 && paint.every(p => p.painted === p.ramp), JSON.stringify(paint));

await page.evaluate(() => MapElevation.setOpacity(0.35));
await page.waitForTimeout(250);
ok('the opacity slider reaches the drape',
   (await elevLook()).opacity === 0.35, JSON.stringify(await elevLook()));

// The relief switch changes the pixels behind the same z/x/y, and MapLibre will
// not refetch a URL it already holds — so the template has to move with it or
// the toggle shows yesterday's tiles.
const r1 = (await elevLook()).tiles[0];
await page.evaluate(() => MapElevation.setRelief(true));
await page.waitForTimeout(400);
const r2 = (await elevLook()).tiles[0];
ok('toggling relief changes the tile template, so the drape repaints',
   r1 !== r2, JSON.stringify([r1, r2]));

await page.evaluate(() => MapElevation.setEnabled(false));
await page.waitForTimeout(400);
const off = await elevLook();
ok('turning it off takes the layer and its source away',
   off.layer === false && off.tiles === null, JSON.stringify(off));

// ── What is here, picking off the camera that is actually looking ───────────
await page.evaluate(() => { MapHere.close(); MapHere.arm(true); });
const bridge = await page.evaluate(() => {
  const m = Map3D._map();
  const r = m.getCanvas().getBoundingClientRect();
  // Well off centre and high in a pitched view, where the two projections have
  // no reason to agree — near the middle of a tilted map they nearly do, which
  // is how this went unnoticed.
  // The page pixel the mouse will press, rounded first and then taken back
  // into each map's own frame — not the other way round. The canvas can sit
  // at a fractional offset (77.17 px down, under 6.x), and a point rounded in
  // the canvas's frame is then a fifth of a pixel from the one clicked, which
  // this far up a tilted view is tens of metres.
  const cx = Math.round(r.left + r.width * 0.32), cy = Math.round(r.top + r.height * 0.34);
  const gl = m.unproject([cx - r.left, cy - r.top]);
  const c  = document.getElementById('leaflet-map').getBoundingClientRect();
  const lf = state.map.containerPointToLatLng([cx - c.left, cy - c.top]);
  return { cx, cy, gl: [gl.lat, gl.lng], lf: [lf.lat, lf.lng] };
});
// Degrees are enough: the two answers are kilometres apart here, and the check
// is which one the card got rather than how far apart they are.
const apart = Math.abs(bridge.gl[0] - bridge.lf[0]) + Math.abs(bridge.gl[1] - bridge.lf[1]);
ok('the two projections of that pixel really do disagree', apart > 0.01,
   JSON.stringify(bridge));

await page.mouse.click(bridge.cx, bridge.cy);
await page.waitForTimeout(700);
const picked = await page.evaluate(() => {
  const m = Map3D._map();
  const src = m.getStyle().sources['mn-here'];
  const f = src && src.data && src.data.features[0];
  return { at: MapHere.point(), armed: MapHere.armed(),
           mark: f ? [f.geometry.coordinates[1], f.geometry.coordinates[0]] : null,
           card: (() => { const el = document.getElementById('here-card');
             if (!el || !el.getClientRects().length) return null;
             const r = el.getBoundingClientRect();
             const t = document.elementFromPoint(r.left + 14, r.top + 14);
             return { shown: true, mine: !!(t && (t === el || el.contains(t))) }; })() };
});
// `near` above compares two scalars; this one compares two [lat, lon] pairs.
const samePoint = (a, b) => !!a && !!b && near(a[0], b[0], 1e-4) && near(a[1], b[1], 1e-4);
ok('the pick takes the renderer’s coordinate, not the 2-D map’s',
   samePoint(picked.at, bridge.gl) && !samePoint(picked.at, bridge.lf), JSON.stringify(picked.at));
ok('…and the point is marked on the terrain it was picked on',
   samePoint(picked.mark, bridge.gl), JSON.stringify(picked.mark));
ok('…and the card that answers is on screen and readable',
   picked.card && picked.card.mine === true, JSON.stringify(picked.card));
ok('…and the pick disarms itself, as it does in 2-D', picked.armed === false);

// 2-D's precedence, which Leaflet enforces with fakeStop and this file has to
// write out: a click that lands on a pin is a pin click, and an armed pick does
// not also take it.
await page.evaluate(() => { MapHere.close(); MapHere.arm(true); closeStnCard(false); });
//
// The pin is found by *asking where the hit test answers*, not by projecting a
// coordinate and trusting it. `project()` is the flat position of a point, and
// these pins stand on terrain: near the middle of the view the two agree
// closely, and high in a pitched frame they do not. A check that clicks at
// `project()` and happens to miss reports a precedence failure that is really
// a mis-aimed click.
const onPin = await page.evaluate(() => {
  const m = Map3D._map();
  const r = m.getCanvas().getBoundingClientRect();
  const mid = { x: r.width / 2, y: r.height / 2 };
  const seen = m.queryRenderedFeatures({ layers: ['mn-stations'] });
  const byDistance = seen
    .map(f => ({ f, p: m.project(f.geometry.coordinates) }))
    .sort((a, b) => Math.hypot(a.p.x - mid.x, a.p.y - mid.y)
                  - Math.hypot(b.p.x - mid.x, b.p.y - mid.y));
  for (const { p } of byDistance.slice(0, 40)) {
    const hit = m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] })[0];
    if (hit) {
      return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y),
               id: hit.properties.id };
    }
  }
  return null;
});
ok('there is a pin on screen the hit test agrees about', !!onPin);
if (onPin) {
  await page.mouse.click(onPin.x, onPin.y);
  await page.waitForTimeout(500);
  const after2 = await page.evaluate(() => ({ card: state.stnCard.id, here: MapHere.point(),
                                              armed: MapHere.armed() }));
  // The card is the station's and no point was picked. The pick also *disarms*,
  // which is not this file's doing and is the same in 2-D: showStationCard()
  // calls MapHere.close() because the four cards share one rectangle, so the
  // tool that was armed for a point is put away by the card that replaced it.
  ok('a pin clicked while the pick is armed is a pin click, not a pick',
     after2.card === onPin.id && after2.here === null, JSON.stringify(after2));
}
await page.evaluate(() => { MapHere.close(); closeStnCard(false); });

// ── Draw & measure, drawn and driven in 3-D ─────────────────────────────────
// Two halves, each of which failed silently before. The shapes were Leaflet
// layers, under the canvas with every other 2-D pane, so a line drawn in 2-D
// was simply not there once the map was tilted. And the tools took their
// clicks off the Leaflet map, which in this mode is a different camera: a
// vertex clicked on a hillside landed wherever that pixel was on the flat map
// — What is here's defect (#194), above, in a tool that keeps what it is
// given. So: the shapes are the same ground in both views, and a click here
// lands where the renderer says the pointer is, judged against the pins drawn
// here.
console.log('\nDraw & measure is drawn on the terrain, and its tools work in 3-D');

const drawLook = () => page.evaluate(() => {
  const m = Map3D._map(), d = Map3D._draw();
  return { ...d, layers: ['mn-draw-fill', 'mn-draw-line', 'mn-draw-ghost', 'mn-draw-hint', 'mn-draw-dot'].map(id => !!m.getLayer(id)),
           types: { fill: m.getLayer('mn-draw-fill') && m.getLayer('mn-draw-fill').type,
                    line: m.getLayer('mn-draw-line') && m.getLayer('mn-draw-line').type } };
});
// Each shape at the middle of the parked view, as MapDraw holds it.
await page.evaluate(() => {
  MapDraw.setTool('');
  state.draw.shapes = []; state.draw.selectedId = null; state.draw.showLabels = true;
  const c = Map3D._map().getCenter();
  state.draw.shapes.push(
    { id: 'd901', kind: 'circle', lat: c.lat + 0.02, lon: c.lng + 0.03, radiusKm: 2.5, colour: '#00b0ff', snappedTo: null },
    { id: 'd902', kind: 'pin',    lat: c.lat - 0.01, lon: c.lng - 0.02, colour: '#ff6d00', snappedTo: null },
    { id: 'd903', kind: 'text',   lat: c.lat - 0.02, lon: c.lng + 0.01, text: 'flood watch', colour: '', snappedTo: null });
  MapDraw.addLine([[c.lat + 0.01, c.lng - 0.04], [c.lat - 0.015, c.lng + 0.035]], [null, null]);
  MapDraw.focus('d901');
});
await page.waitForTimeout(600);
const d0 = await drawLook();
const ex0 = await page.evaluate(() => MapDraw.exportShapes());
const feat = id => (d0.shapes && d0.shapes.features || []).find(f => f.properties.id === id);
const circle0 = feat('d901'), line0 = feat(ex0.find(s => s.kind === 'line').id);
const sameRing = (f, ring) => !!f && !!ring && f.geometry.coordinates[0].length === ring.length
  && f.geometry.coordinates[0].every((p, i) => near(p[0], ring[i][1], 1e-9) && near(p[1], ring[i][0], 1e-9));
ok('Draw & measure has its own sources and five layers in 3-D', d0.layers.every(Boolean), JSON.stringify(d0.layers));
ok('a circle drawn in 2-D is draped here as the ring its KML export is',
   sameRing(circle0, ex0.find(s => s.id === 'd901').ring) && circle0.geometry.type === 'Polygon',
   circle0 ? `${circle0.geometry.coordinates[0].length} points` : 'missing');
// #187's acceptance, the way `npm run drawkml` holds the KML: every vertex of
// the draped ring is the radius from the centre on the sphere, measured by a
// haversine written here rather than the app's — a circle layer would be a
// screen-space disc of the wrong ground radius almost everywhere.
const havKm = (a1, o1, a2, o2) => {
  const r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
};
const ringWorst = circle0 ? circle0.geometry.coordinates[0].reduce((w, [lon, lat]) =>
  Math.max(w, Math.abs(havKm(ex0.find(s => s.id === 'd901').point[0], ex0.find(s => s.id === 'd901').point[1], lat, lon) - 2.5)), 0) : Infinity;
ok('…every vertex 2.5 km from the centre on the ground', ringWorst < 2.5 * 0.005, `worst error ${ringWorst.toFixed(4)} km`);
ok('…and it is draped, as fill and line layers are, not a disc standing at sea level',
   d0.types.fill === 'fill' && d0.types.line === 'line', JSON.stringify(d0.types));
ok('…in its own colour, and at the selected width',
   circle0 && circle0.properties.colour === '#00b0ff' && circle0.properties.width === 4, JSON.stringify(circle0 && circle0.properties));
ok('a line is its own vertices',
   !!line0 && line0.geometry.type === 'LineString'
   && JSON.stringify(line0.geometry.coordinates) === JSON.stringify(ex0.find(s => s.kind === 'line').path.map(p => [p[1], p[0]])),
   JSON.stringify(line0 && line0.geometry.coordinates));
ok('pins and notes are not in the draped source — they stand on the ground as markers',
   d0.shapes.features.length === 2, `${d0.shapes.features.length} features`);
const pinM = d0.pins.find(p => p.id === 'd902'), noteM = d0.pins.find(p => p.id === 'd903');
ok('the pin is a marker wearing 2-D\'s markup, where 2-D has it',
   !!pinM && /\bmn-draw-pin\b/.test(pinM.cls) && near(pinM.lat, ex0.find(s => s.id === 'd902').point[0], 1e-9),
   JSON.stringify(pinM));
ok('…and so is the note, with its text', !!noteM && /\bmn-draw-textbox\b/.test(noteM.cls) && noteM.text === 'flood watch',
   JSON.stringify(noteM));
const labels = d0.pins.filter(p => /\bmn-draw-label\b/.test(p.cls)).map(p => p.text).sort();
const measures = ex0.filter(s => s.kind !== 'text').map(s => s.measure).sort();
ok('every shape but the note carries its measurement, as in 2-D', JSON.stringify(labels) === JSON.stringify(measures),
   JSON.stringify(labels));
await page.evaluate(() => MapDraw.toggleLabels(false));
await page.waitForTimeout(200);
ok('…and Show measurements off takes them away here too',
   (await drawLook()).pins.filter(p => /\bmn-draw-label\b/.test(p.cls)).length === 0);
await page.evaluate(() => MapDraw.toggleLabels(true));

// A real pointer, off centre and high in the pitched view where the two
// cameras disagree about the ground — the bridge's own test, above, for a
// tool that keeps the answer. Snapping off, so the vertices are the pixels
// pressed and nothing else.
await page.evaluate(() => {
  MapDraw.setTool(''); state.draw.shapes = []; state.draw.selectedId = null; MapDraw.render(); MapDraw.rerenderPanel();
  state.draw.snap = false;
  MapHere.close(); closeStnCard(false);
  window.__lfDrawClicks = 0;
  state.map.on('click', () => window.__lfDrawClicks++);
  MapDraw.setTool('line');
});
await page.waitForTimeout(300);
const pix = await page.evaluate(() => {
  const m = Map3D._map();
  const r = m.getCanvas().getBoundingClientRect();
  const c = document.getElementById('leaflet-map').getBoundingClientRect();
  const at = (fx, fy) => {
    const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
    const gl = m.unproject([x - r.left, y - r.top]);
    const lf = state.map.containerPointToLatLng([x - c.left, y - c.top]);
    return { x, y, gl: [gl.lat, gl.lng], lf: [lf.lat, lf.lng] };
  };
  return { a: at(0.30, 0.38), b: at(0.62, 0.52), dbl: m.doubleClickZoom.isEnabled(), zoom: m.getZoom(),
           cursor: getComputedStyle(m.getCanvasContainer()).cursor };
});
ok('the line tool, armed, makes a double click here finish rather than zoom',
   pix.dbl === false && (await drawLook()).dblZoom === false);
ok('…and the pointer is a crosshair over the terrain, as on the flat map', pix.cursor === 'crosshair', pix.cursor);
await page.mouse.click(pix.a.x, pix.a.y);
await page.waitForTimeout(250);
await page.mouse.move(pix.b.x, pix.b.y, { steps: 4 });
await page.waitForTimeout(400);
const ghost = await drawLook();
const g = (ghost.live && ghost.live.features || []).find(f => f.properties.kind === 'ghost');
ok('a vertex down, the dashed ghost follows the pointer across the terrain',
   !!g && g.geometry.coordinates.length === 2
   && near(g.geometry.coordinates[0][1], pix.a.gl[0], 1e-4) && near(g.geometry.coordinates[1][1], pix.b.gl[0], 1e-4),
   JSON.stringify(g && g.geometry.coordinates));
await page.mouse.dblclick(pix.b.x, pix.b.y);
await page.waitForTimeout(500);
const drew = await page.evaluate(() => ({
  shapes: state.draw.shapes.map(s => ({ kind: s.kind, pts: s.pts })),
  tool: state.draw.tool, lf: window.__lfDrawClicks, zoom: Map3D._map().getZoom(),
}));
const ln = drew.shapes.find(s => s.kind === 'line');
const samePt = (a, b) => !!a && !!b && near(a[0], b[0], 1e-4) && near(a[1], b[1], 1e-4);
ok('the double click finished the line, and the tool stays armed for the next',
   drew.shapes.length === 1 && !!ln && drew.tool === 'line', JSON.stringify(drew.shapes));
ok('its ends are where the renderer put the pointer on the terrain, not where the 2-D map would',
   !!ln && samePt(ln.pts[0], pix.a.gl) && samePt(ln.pts[ln.pts.length - 1], pix.b.gl)
   && !samePt(ln.pts[0], pix.a.lf), JSON.stringify(ln && ln.pts));
ok('…every click answered here alone — none reached the 2-D map underneath', drew.lf === 0, `${drew.lf} Leaflet click(s)`);
ok('…and the double click did not zoom the camera', near(drew.zoom, pix.zoom, 1e-6), `${pix.zoom} → ${drew.zoom}`);
const drew3 = await drawLook();
ok('the finished line is draped here at once', (drew3.shapes.features || []).some(f => f.geometry.type === 'LineString'));

// The snap, judged on this canvas: a pin dropped beside a station's pin as
// the renderer drew it lands on that station. The pin is found by asking the
// hit test, for the What is here precedence check's reason.
await page.evaluate(() => { MapDraw.setTool(''); state.draw.snap = true; MapDraw.setTool('pin'); });
const snapPin = await page.evaluate(() => {
  const m = Map3D._map();
  const r = m.getCanvas().getBoundingClientRect();
  const mid = { x: r.width / 2, y: r.height / 2 };
  const seen = m.queryRenderedFeatures({ layers: ['mn-stations'] })
    .map(f => ({ id: f.properties.id, p: m.project(f.geometry.coordinates) }))
    .sort((a, b) => Math.hypot(a.p.x - mid.x, a.p.y - mid.y) - Math.hypot(b.p.x - mid.x, b.p.y - mid.y));
  for (const { id, p } of seen.slice(0, 40)) {
    // Six pixels off the pin, inside the snap's fifteen.
    if (!m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] }).length) continue;
    return { id, x: Math.round(r.left + p.x + 6), y: Math.round(r.top + p.y) };
  }
  return null;
});
ok('there is a station pin on screen to snap to', !!snapPin);
if (snapPin) {
  await page.mouse.move(snapPin.x, snapPin.y);
  await page.waitForTimeout(400);
  const hint = await drawLook();
  ok('hovering beside it rings it, and names it', (hint.live.features || []).some(f => f.properties.kind === 'hint') && !!hint.hint,
     JSON.stringify(hint.hint));
  await page.mouse.click(snapPin.x, snapPin.y);
  await page.waitForTimeout(400);
  // On *a* station — the one beside the pointer, or a neighbour standing
  // nearer the pixel pressed — exactly, and named for it.
  const sp = await page.evaluate(() => state.draw.shapes.filter(s => s.kind === 'pin').map(s => {
    const mk = state.mapMarkers.find(x => s.snappedTo && x.mnStationId === s.snappedTo[0]);
    return { at: [s.lat, s.lon], to: s.snappedTo, st: mk ? [mk.mnStation.lat, mk.mnStation.lon] : null };
  }));
  ok('…and the pin lands on the station itself, named for it',
     sp.length === 1 && !!sp[0].st && near(sp[0].at[0], sp[0].st[0], 1e-12) && near(sp[0].at[1], sp[0].st[1], 1e-12),
     JSON.stringify(sp));
}

// Picked off the terrain with no tool armed, as a click on it does in 2-D.
await page.evaluate(() => { MapDraw.setTool(''); state.draw.selectedId = null; MapDraw.render(); });
await page.waitForTimeout(400);
const onLine = await page.evaluate(() => {
  const m = Map3D._map(), r = m.getCanvas().getBoundingClientRect();
  const sh = state.draw.shapes.find(s => s.kind === 'line');
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const lat = sh.pts[0][0] + t * (sh.pts[1][0] - sh.pts[0][0]);
    const lon = sh.pts[0][1] + t * (sh.pts[1][1] - sh.pts[0][1]);
    const p = m.project([lon, lat]);
    if (m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] }).length) continue;
    const box = [[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]];
    if (!m.queryRenderedFeatures(box, { layers: ['mn-draw-line'] }).length) continue;
    return { id: sh.id, x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) };
  }
  return null;
});
ok('there is a stretch of the drawn line the hit test agrees about', !!onLine);
if (onLine) {
  await page.mouse.click(onLine.x, onLine.y);
  await page.waitForTimeout(500);
  const sel = await page.evaluate(() => ({ sel: state.draw.selectedId, w: (Map3D._draw().shapes.features || [])
    .filter(f => f.properties.id === state.draw.selectedId).map(f => f.properties.width) }));
  ok('a click on a drawn line here selects it, and it thickens', sel.sel === onLine.id && sel.w[0] === 4, JSON.stringify(sel));
}

// The elevation profile's cursor, which path-profile.js puts on the map
// through MapDraw: here too, with its reading.
const dotAt = await page.evaluate(() => {
  const c = Map3D._map().getCenter();
  MapDraw.showProfilePoint(c.lat, c.lng, '123 m');
  return [c.lat, c.lng];
});
await page.waitForTimeout(300);
const dot = await drawLook();
const df = (dot.live.features || []).find(f => f.properties.kind === 'dot');
ok('the profile cursor stands on the terrain with its reading',
   !!df && samePt([df.geometry.coordinates[1], df.geometry.coordinates[0]], dotAt) && dot.dot === '123 m',
   JSON.stringify({ f: df && df.geometry.coordinates, label: dot.dot }));
await page.evaluate(() => MapDraw.clearProfilePoint());
await page.waitForTimeout(200);
ok('…and goes when the pointer leaves the chart', !(await drawLook()).live.features.some(f => f.properties.kind === 'dot'));

await page.evaluate(() => {
  MapDraw.setTool(''); state.draw.shapes = []; state.draw.selectedId = null;
  MapDraw.render(); MapDraw.rerenderPanel();
});

// ── the Queensland cadastre, draped (map-lots.js, map-roads.js) ──────────
// Map display's property boundaries and road parcels — the layers Queensland
// Globe draws — were Leaflet panes, under the canvas in this mode and so simply
// gone. They come back as each file's own export, tiled: asserted here are the
// seam (the template and its styling are those files', the lot lines the same
// renderer as the 2-D image), the place in the stack, the zoom floors, the
// switches, and a tile that will not come said out loud.
console.log('\nProperty boundaries and road parcels are draped, off their own switches');

const qldPin = await page.evaluate(() => {
  const s = state.data.stations.find(x => x.lat < -26 && x.lat > -28.5 && x.lon > 151 && x.lon < 153);
  return s ? [s.lon, s.lat] : null;
});
const cadLook = () => page.evaluate(() => {
  const m = Map3D._map(), st = m.getStyle();
  const src = id => st.sources[id] || null;
  return { order: st.layers.map(l => l.id).filter(id => /^mn-(base|elev|lots|roads|links)$/.test(id)),
           lots: src('mn-lots'), roads: src('mn-roads'),
           note: (document.getElementById('map-3d-note') || {}).textContent || '' };
});
await page.evaluate(() => { MapElevation.setEnabled(false); MapLots.setEnabled(true); MapRoads.setEnabled(true); });
await page.evaluate(c => Map3D._map().jumpTo({ center: c, zoom: 15, pitch: 55, bearing: 0 }), qldPin);
await page.waitForFunction(() => !!Map3D._map().getLayer('mn-lots') && !!Map3D._map().getLayer('mn-roads'),
  null, { timeout: GL_TIMEOUT }).catch(() => {});
await page.waitForTimeout(2500);
const cad = await cadLook();
ok('with both switches on, both are layers of their own — roads over lots, under the links',
   JSON.stringify(cad.order) === JSON.stringify(['mn-base', 'mn-lots', 'mn-roads', 'mn-links']), JSON.stringify(cad.order));
const tpl = s => (s && s.tiles && s.tiles[0]) || '';
const dyn = s => { try { return JSON.parse(new URL(tpl(s).replace('{bbox-epsg-3857}', '0,0,1,1')).searchParams.get('dynamicLayers')); } catch (_) { return null; } };
ok('each is the cadastre service’s export, 512 px, with MapLibre’s bbox placeholder left whole',
   [cad.lots, cad.roads].every(x => /LandParcelPropertyFramework\/MapServer\/export\?/.test(tpl(x))
     && tpl(x).endsWith('&bbox={bbox-epsg-3857}') && /size=512%2C512/.test(tpl(x)) && x.tileSize === 512),
   JSON.stringify([tpl(cad.lots).slice(-60), tpl(cad.roads).slice(-60)]));
ok('…at the zoom floors the 2-D layers keep — 1:36,000 for lots, 1:72,000 for roads',
   cad.lots.minzoom === 13 && cad.roads.minzoom === 12, JSON.stringify([cad.lots.minzoom, cad.roads.minzoom]));
ok('…each carrying the State’s credit', [cad.lots, cad.roads].every(x => /State of Queensland/.test(x.attribution || '')));
const lotsDyn = dyn(cad.lots), roadsDyn = dyn(cad.roads);
// The 2-D layer's own colour, asked of it rather than written down here.
const roadRgb = await page.evaluate(() => { const n = parseInt(MapRoads.legendColour().slice(1), 16);
                                            return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
// The 2-D image's own request, from the 2-D map under the canvas (it follows
// the camera): the same renderer for the casing and the line, which is what
// "one style in both modes" means.
const twoD = cadAsked.map(u => new URL(u)).find(u => u.searchParams.get('size') !== '512,512');
const twoDDyn = twoD ? JSON.parse(twoD.searchParams.get('dynamicLayers')) : null;
ok('the lot lines are the 2-D image’s own renderer — casing and line',
   !!lotsDyn && !!twoDDyn && lotsDyn.length === 2
     && lotsDyn.every((l, i) => JSON.stringify(l.drawingInfo.renderer) === JSON.stringify(twoDDyn[i].drawingInfo.renderer)),
   JSON.stringify([lotsDyn && lotsDyn.map(l => l.id), twoDDyn && twoDDyn.map(l => l.id)]));
const lab = lotsDyn && lotsDyn[0].drawingInfo.labelingInfo && lotsDyn[0].drawingInfo.labelingInfo[0];
ok('…labelled closer in than 2-D, and only on the ground’s own lots',
   !!lab && lab.minScale === 2500 && /cover_typ = 'Base'/.test(lab.where || '')
     && twoDDyn[0].drawingInfo.labelingInfo[0].minScale === 5000 && !twoDDyn[0].drawingInfo.labelingInfo[0].where,
   JSON.stringify(lab));
ok('the road reserve is the same two parcel types the 2-D layer asks for, in its colour',
   !!roadsDyn && roadsDyn[0].definitionExpression === "parcel_typ IN ('Road Type Parcel','Unlinked parcel or inter')"
     && JSON.stringify(roadsDyn[0].drawingInfo.renderer.symbol.outline.color.slice(0, 3)) === JSON.stringify(roadRgb),
   JSON.stringify(roadsDyn && roadsDyn[0].drawingInfo.renderer));
const tileZ = u => { const b = (new URL(u).searchParams.get('bbox') || '').split(',').map(Number);
                     return Math.log2(40075016.686 / (b[2] - b[0])); };
const tiles3d = cadAsked.filter(u => /size=512%2C512/.test(u));
ok('tiles were asked for, the bbox filled in at whole zooms at or past the floors',
   tiles3d.length > 0 && tiles3d.every(u => { const z = tileZ(u); return Math.abs(z - Math.round(z)) < 1e-6 && Math.round(z) >= 12; }),
   `${tiles3d.length} tiles; zooms ${[...new Set(tiles3d.map(u => Math.round(tileZ(u))))].join(',')}`);

// Out past both floors: nothing more is asked.
await page.evaluate(c => Map3D._map().jumpTo({ center: c, zoom: 10.5, pitch: 0, bearing: 0 }), qldPin);
await page.waitForTimeout(1500);
const before = cadAsked.filter(u => /size=512%2C512/.test(u)).length;
await page.evaluate(c => Map3D._map().jumpTo({ center: [c[0] + 0.3, c[1]], zoom: 10.5, pitch: 0, bearing: 0 }), qldPin);
await page.waitForTimeout(1500);
ok('zoomed out past both floors, a pan asks for no cadastre tile',
   cadAsked.filter(u => /size=512%2C512/.test(u)).length === before);

// The switches, and the order surviving whatever is added after.
await page.evaluate(() => MapLots.setEnabled(false));
await page.waitForTimeout(300);
const offLots = await cadLook();
ok('property boundaries off in Map display takes them off the 3-D view, and only them',
   !offLots.order.includes('mn-lots') && offLots.order.includes('mn-roads') && !offLots.lots, JSON.stringify(offLots.order));
await page.evaluate(() => { MapLots.setEnabled(true); MapElevation.setEnabled(true); });
await page.waitForFunction(() => !!Map3D._map().getLayer('mn-lots') && !!Map3D._map().getLayer('mn-elev'),
  null, { timeout: GL_TIMEOUT }).catch(() => {});
const back = await cadLook();
ok('…on again puts them back under the roads, and the elevation ramp goes under both',
   JSON.stringify(back.order) === JSON.stringify(['mn-base', 'mn-elev', 'mn-lots', 'mn-roads', 'mn-links']), JSON.stringify(back.order));
await page.evaluate(() => { Map3D.baseChanged(); });
const rebased = await cadLook();
ok('…and a base map swapped in goes under all of it',
   JSON.stringify(rebased.order) === JSON.stringify(['mn-base', 'mn-elev', 'mn-lots', 'mn-roads', 'mn-links']), JSON.stringify(rebased.order));
await page.evaluate(() => MapElevation.setEnabled(false));

// A tile that will not come is a stretch of ground with no boundary on it,
// which reads as one big lot: counted and said.
cadFail = true;
await page.evaluate(c => Map3D._map().jumpTo({ center: [c[0] - 0.05, c[1] + 0.05], zoom: 15.5, pitch: 50, bearing: 30 }), qldPin);
await page.waitForFunction(() => /could not be\s+fetched from the Queensland spatial service/.test(
  (document.getElementById('map-3d-note') || {}).textContent || ''), null, { timeout: GL_TIMEOUT }).catch(() => {});
const failNote = (await cadLook()).note;
ok('a cadastre tile that will not come is said out loud, never left as bare ground',
   /tiles? could not be\s+fetched from the Queensland spatial service/.test(failNote) && /no line there is not no\s+boundary there/.test(failNote),
   failNote.slice(0, 200));
cadFail = false;
await page.evaluate(() => Map3D._map().jumpTo({ zoom: 10.5, pitch: 0 }));

// ── polar radio coverage, draped (map-polar.js, #188) ─────────────────────
// The polar plot was a Leaflet image overlay, under the canvas in this mode and
// so simply gone. It comes back as the same picture, lying on the relief — so
// what is asserted is the seam (the 2-D overlay's own image, its own four
// corners, its own opacity), the place in the ground's stack, the caveat on the
// panel, and the property `npm run terrain` holds in 2-D: a new threshold is a
// repaint of levels already in hand, and not one terrain tile is asked again —
// through the 3-D path as well, where the renderer's own DEM is on the same
// counter. Then leaving 3-D, which must leave the 2-D plot exactly as it was.
console.log('\nPolar radio coverage lies on the terrain (#188)');

const polarPin = await page.evaluate(() => {
  const s = state.data.stations.find(x => x.id === 'beenleigh_al');
  return s ? [s.lon, s.lat] : null;
});
await page.evaluate(c => Map3D._map().jumpTo({ center: c, zoom: 10.5, pitch: 55, bearing: 20 }), polarPin);
const polarOn = await page.evaluate(async () => {
  // A short range and a coarse step, as terrainkit draws it: the assertion is
  // about the seam, not the model.
  MapPolar.set('centre', 'station');
  MapPolar.pickCentre('beenleigh_al');
  MapPolar.set('rMaxKm', 12);
  MapPolar.set('azStep', 6);
  MapPolar.set('unit', 'dbm');
  MapPolar.set('fromDbm', -120);
  MapPolar.set('toDbm', -60);
  MapPolar.draw();
  const until = Date.now() + 60000;
  while (Date.now() < until && !MapPolar.active()) await new Promise(r => setTimeout(r, 250));
  return MapPolar.active();
});
ok('a polar plot drawn with the 3-D view up', polarOn === true);
await page.waitForFunction(() => !!Map3D._map().getLayer('mn-polar'), null, { timeout: GL_TIMEOUT }).catch(() => {});
await idle3d();
const polarLook = () => page.evaluate(() => {
  const m = Map3D._map(), st = m.getStyle();
  const layer = st.layers.find(l => l.id === 'mn-polar');
  const src = st.sources['mn-polar'];
  const img = document.querySelector('.leaflet-pane.leaflet-mnPolar-pane img');
  const d = MapPolar.drawn();
  return {
    order: st.layers.map(l => l.id).filter(id => /^mn-(base|elev|polar|lots|roads|links)$/.test(id)),
    type: layer ? layer.type : null, srcType: src ? src.type : null,
    url: src ? src.url : null, coords: src ? src.coordinates : null,
    opacity: layer && layer.paint ? layer.paint['raster-opacity'] : null,
    twoD: img ? { src: img.src, opacity: Number(getComputedStyle(img).opacity) } : null,
    box: d ? d.box : null, terrain: !!m.getTerrain(),
    note: (document.getElementById('map-3d-note') || {}).textContent.replace(/\s+/g, ' ') || '',
  };
});
const pl = await polarLook();
ok('it lies on the ground: an image raster under the terrain, over the base, under the cadastre and the links',
   pl.type === 'raster' && pl.srcType === 'image' && pl.terrain
     && JSON.stringify(pl.order) === JSON.stringify(['mn-base', 'mn-polar', 'mn-lots', 'mn-roads', 'mn-links']),
   JSON.stringify({ type: pl.type, src: pl.srcType, order: pl.order }));
ok('…the 2-D overlay’s own picture, not a second computation', !!pl.twoD && pl.url === pl.twoD.src,
   `${(pl.url || '').slice(0, 30)}… vs ${(pl.twoD && pl.twoD.src || '').slice(0, 30)}…`);
const corners = b => b && [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];
ok('…over the same four corners', JSON.stringify(pl.coords) === JSON.stringify(corners(pl.box)), JSON.stringify(pl.coords));
ok('…at the same opacity', !!pl.twoD && Math.abs(pl.opacity - pl.twoD.opacity) < 1e-6, `${pl.opacity} vs ${pl.twoD && pl.twoD.opacity}`);
ok('the caveat travels: bare terrain, no patterns, no trees, no clutter — and the profile card decides',
   /no antenna patterns, no trees and no terminal clutter/.test(pl.note) && /profile card is the authority/.test(pl.note),
   pl.note.slice(0, 160));

// Re-banding, through the 3-D path: the image changes, the terrain is not
// asked for — neither by terrain.js for the model nor by the renderer.
const polarBefore = demHits;
await page.evaluate(() => MapPolar.set('toDbm', -80));
await page.waitForTimeout(500);
await idle3d();
const rb = await polarLook();
ok('a new threshold re-colours the draped plot', !!rb.url && rb.url !== pl.url && !!rb.twoD && rb.url === rb.twoD.src,
   `${rb.url === pl.url ? 'unchanged' : 'changed'}; matches 2-D: ${!!rb.twoD && rb.url === rb.twoD.src}`);
ok('…in place, under the cadastre still', JSON.stringify(rb.order) === JSON.stringify(pl.order), JSON.stringify(rb.order));
ok('…without fetching a single terrain tile', demHits === polarBefore, `${demHits - polarBefore} extra tile(s)`);

// Leaving 3-D: the 2-D plot is exactly as it was.
await page.evaluate(() => Map3D.stop());
const after2d = await page.evaluate(() => {
  const img = document.querySelector('.leaflet-pane.leaflet-mnPolar-pane img');
  const d = MapPolar.drawn();
  return { active: MapPolar.active(), src: img ? img.src : null,
           opacity: img ? Number(getComputedStyle(img).opacity) : null, box: d ? d.box : null };
});
ok('leaving 3-D leaves the 2-D plot exactly as it was',
   after2d.active && after2d.src === rb.url && Math.abs(after2d.opacity - rb.opacity) < 1e-6
     && JSON.stringify(after2d.box) === JSON.stringify(rb.box), JSON.stringify({ a: after2d.active, same: after2d.src === rb.url }));

// A plot drawn before 3-D was opened is draped as it opens; cleared in 2-D, it
// goes from the 3-D view too, and its caveat with it.
await page.locator('.mn-map-3d').click();
await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded() && !!Map3D._map().getLayer('mn-polar'),
  null, { timeout: GL_TIMEOUT }).catch(() => {});
const reopened = await polarLook();
ok('opening 3-D over a plot already drawn drapes it', reopened.type === 'raster' && reopened.url === rb.url,
   JSON.stringify({ type: reopened.type, same: reopened.url === rb.url }));
await page.evaluate(() => MapPolar.clear());
await page.waitForTimeout(200);
const cleared = await polarLook();
ok('clearing the plot takes it off the 3-D view, and its caveat with it',
   cleared.type === null && cleared.srcType === null && !/no antenna patterns/.test(cleared.note),
   JSON.stringify({ type: cleared.type, src: cleared.srcType }));
await page.evaluate(() => { MapLots.setEnabled(false); MapRoads.setEnabled(false); });

// ── 9. leaving the tab takes the GL context with it ─────────────────────────
// ── a path clicked in 3-D opens the card its 2-D line opens (#196) ────────
console.log('\nA radio path clicked in 3-D opens the path card');

// The styling alone was never enough: a hit has to reach a *link*, so the
// mirror has to carry the pair each line joins.
const linkIds = await page.evaluate(() => {
  const f = Map3D._mirror().links.features;
  const paired = f.filter(x => x.properties.rid != null
    && (x.properties.sid != null || x.properties.rid2 != null));
  return { n: f.length, paired: paired.length,
           backbones: f.filter(x => x.properties.rid2 != null).length };
});
ok('the mirror draws some paths', linkIds.n > 0, `${linkIds.n} features`);
ok('every drawn path carries the pair it joins',
   linkIds.n > 0 && linkIds.paired === linkIds.n, `${linkIds.paired}/${linkIds.n}`);

// Where the renderer says the line is, not where the arithmetic says it should
// be — the rule the pin check follows, and it counts for more here because
// these lines are draped over terrain rather than billboarded above it.
const line = await page.evaluate(() => {
  const f = Map3D._mirror().links.features.find(x => x.properties.rid != null);
  if (!f) return null;
  const c = f.geometry.coordinates, a = c[0], b = c[c.length - 1];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  Map3D._map().jumpTo({ center: mid, zoom: 11, pitch: 60, bearing: 0 });
  return { mid, props: f.properties };
});
ok('the file has a path to click', !!line);

if (line) {
  await page.waitForTimeout(1200);
  await idle3d();
  const where = await page.evaluate((t) => {
    const m = Map3D._map();
    const p = m.project(t.mid);
    const r = m.getCanvas().getBoundingClientRect();
    const box = [[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]];
    const f = m.queryRenderedFeatures(box, { layers: ['mn-links'] });
    // The bare point, for the comparison that justifies LINK_HIT_PX.
    const pt = m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-links'] });
    return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y),
             box: f.length, point: pt.length,
             hit: f.length ? f[0].properties : null };
  }, line);
  ok('the tolerance box finds the path under the pointer', !!where.hit,
     JSON.stringify(where));
  ok('…and it is at least as forgiving as the bare point',
     where.box >= where.point, `box ${where.box}, point ${where.point}`);

  if (where.hit) {
    // Hovering it names both ends before anything is clicked.
    await page.evaluate(() => closeStnCard(false));
    await page.mouse.move(where.x - 30, where.y - 30);
    await page.mouse.move(where.x, where.y, { steps: 4 });
    await page.waitForTimeout(150);
    const tip = await page.evaluate(() => {
      const el = document.querySelector('#map3d .map3d-tip');
      return { shown: !!(el && !el.hidden && el.offsetWidth > 0), text: el ? el.textContent : '' };
    });
    ok('hovering a path shows a label naming its two ends',
       tip.shown && /[→↔]/.test(tip.text) && /path card/.test(tip.text), JSON.stringify(tip));
    await page.mouse.move(5, 5);

    // While a draw tool is armed the click belongs to the drawing, exactly as
    // in 2-D. Checked first, because it must not leave a card open behind it.
    await page.evaluate(() => {
      state.path.open = false;
      if (typeof MapBackbone !== 'undefined') MapBackbone.closeCard(false);
      state.draw.tool = 'line';
    });
    await page.mouse.click(where.x, where.y);
    await page.waitForTimeout(400);
    const armed = await page.evaluate(() => state.path.open);
    ok('a path click is ignored while a draw tool is armed', armed !== true,
       `state.path.open = ${armed}`);

    await page.evaluate(() => {
      state.draw.tool = null;
      state.path.open = false;
      if (typeof MapBackbone !== 'undefined') MapBackbone.closeCard(false);
    });
    await page.mouse.click(where.x, where.y);
    await page.waitForTimeout(700);
    const card = await page.evaluate(() => {
      const el = document.getElementById('path-card');
      const r  = el ? el.getBoundingClientRect() : null;
      return { open: state.path.open, box: !!(r && r.width > 0 && r.height > 0) };
    });
    ok('clicking a path in 3-D opens the path card',
       card.open === true && card.box, JSON.stringify(card));
  }
}

// A pin sits on the end of every line it belongs to, so the handler asks the
// pins first. If that order ever flips, the station at a link's end becomes
// the one station on the map nobody can open.
const endpoint = await page.evaluate(() => {
  const f = Map3D._mirror().links.features.find(x => x.properties.rid != null);
  if (!f) return null;
  const id = f.properties.rid;
  const mk = (state.mapMarkers || []).find(m => m.mnStationId === id);
  if (!mk) return null;
  const ll = mk.getLatLng();
  Map3D._map().jumpTo({ center: [ll.lng, ll.lat], zoom: 12, pitch: 60, bearing: 0 });
  return { id, lat: ll.lat, lng: ll.lng };
});
if (endpoint) {
  await page.waitForTimeout(1200);
  await idle3d();
  const both = await page.evaluate((t) => {
    const m = Map3D._map();
    const p = m.project([t.lng, t.lat]);
    const r = m.getCanvas().getBoundingClientRect();
    const box = [[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]];
    return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y),
             pin:  m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] }).length,
             line: m.queryRenderedFeatures(box, { layers: ['mn-links'] }).length };
  }, endpoint);
  if (both.pin > 0 && both.line > 0) {
    await page.evaluate(() => {
      state.path.open = false; state.draw.tool = null;
      if (typeof MapBackbone !== 'undefined') MapBackbone.closeCard(false);
      closeStnCard(false);
    });
    await page.mouse.click(both.x, both.y);
    await page.waitForTimeout(600);
    const who = await page.evaluate(() => ({
      station: state.stnCard.id, path: state.path.open }));
    ok('where a pin and a path overlap, the pin takes the click',
       who.station != null && who.path !== true, JSON.stringify(who));
  } else {
    ok('where a pin and a path overlap, the pin takes the click', true,
       `no overlap in frame (pin ${both.pin}, line ${both.line}) — not exercised`);
  }
}

// ── what moves the 2-D map moves the camera ─────────────────────────────────
// Every "take me there" in the app — a row of the station list, the Repeaters
// listening card, Zoom to station, the fit a new filter makes — is a setView or
// a fitBounds on the Leaflet map, and in 3-D that map is under the canvas. Each
// one moved it, out of sight, and the camera stayed where it was. So these are
// driven by what a row's own button calls (selectStation) and read off the
// camera, not off Leaflet.
//
// The other half is the 2-D map keeping up with the camera, and that is held
// here too: without it the second press of a row whose station the camera had
// since panned away from was a zero pan to Leaflet, and went nowhere.
console.log('\nWhat moves the 2-D map moves the camera');

// Read in pixels rather than degrees. With terrain on, MapLibre keeps the
// camera where it is and re-grounds its centre as the DEM tiles land, which at
// 55° of tilt moves the centre a few hundred metres off the station the camera
// was sent to while the station stays in the middle of the view — so "there"
// is where the operator sees it: `off`, the station's distance from the middle
// of the canvas. And the 2-D map is set to whole pixels, so `lfOff` is how far
// its centre is from the camera's, in its own pixels.
const view3 = (s = null) => page.evaluate((s) => {
  const m = Map3D._map(), c = m.getCenter(), l = state.map.getCenter();
  const cv = m.getCanvas().getBoundingClientRect();
  const sp = s ? m.project([s.lon, s.lat]) : null;
  const lp = state.map.latLngToContainerPoint([c.lat, c.lng]), ls = state.map.getSize();
  return { lat: c.lat, lng: c.lng, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing(),
           off: sp ? Math.hypot(sp.x - cv.width / 2, sp.y - cv.height / 2) : null,
           lfOff: Math.hypot(lp.x - ls.x / 2, lp.y - ls.y / 2),
           lf: { lat: l.lat, lng: l.lng, zoom: state.map.getZoom() } };
}, s);
// Leaflet's own move first (an animated pan is a quarter of a second), then the
// camera's ease after it.
const settle3 = async () => {
  await page.waitForTimeout(400);
  await page.waitForFunction(() => { const m = Map3D._map(); return !!m && !m.isMoving(); },
    null, { timeout: GL_TIMEOUT });
  await page.waitForTimeout(150);
};
const at = v => v.off != null && v.off <= 20;

// Two located stations well apart, neither of them selected — selectStation on
// the selected one is the toggle that clears it.
const ends = await page.evaluate(() => {
  closeStnCard(false);
  if (MapHere.armed()) MapHere.arm(false);
  const pool = state.data.stations.filter(s => s.lat != null && s.lon != null && s.id !== state.selectedId);
  const a = pool[0];
  const b = pool.find(s => acmaHaversineKm(a.lat, a.lon, s.lat, s.lon) > 150);
  const c = pool.find(s => s !== a && s !== b && acmaHaversineKm(a.lat, a.lon, s.lat, s.lon) > 150
                                              && acmaHaversineKm(b.lat, b.lon, s.lat, s.lon) > 150);
  return [a, b, c].map(s => s && { id: s.id, lat: s.lat, lon: s.lon, name: s.name });
});
const [SA, SB, SC] = ends;
ok('the file has three located stations far enough apart to tell apart', !!(SA && SB && SC),
   JSON.stringify(ends));

if (SA && SB && SC) {
  // Somewhere else entirely, turned and tilted, zoomed well out.
  await page.evaluate(() => Map3D._map().jumpTo({ center: [134, -26], zoom: 5, pitch: 55, bearing: 25 }));
  await settle3();

  await page.evaluate(id => selectStation(id), SA.id);
  await settle3();
  const v1 = await view3(SA);
  ok('a row of the station list takes the camera to its station', at(v1),
     `${SA.name}: ${Math.round(v1.off)} px from the middle of the view`);
  ok('…at the zoom the 2-D map went to, less the one step the two scales differ by',
     near(v1.zoom, v1.lf.zoom - 1, 0.3) && v1.lf.zoom >= 11, JSON.stringify(v1));
  ok('…keeping the tilt and the heading the operator chose',
     near(v1.pitch, 55, 0.5) && near(v1.bearing, 25, 0.5), `${v1.pitch}°, ${v1.bearing}°`);

  // The operator brings the camera down closer than a row would put it. A row
  // then keeps that zoom rather than pulling the camera back out to 11.
  await page.evaluate(() => Map3D._map().jumpTo({ zoom: 13.4 }));
  await settle3();
  const v2 = await view3();
  ok('the 2-D map keeps up with the camera: same place, the zoom a step closer',
     v2.lfOff <= 2 && v2.lf.zoom === 14, JSON.stringify(v2));
  await page.evaluate(id => selectStation(id), SB.id);
  await settle3();
  const v3 = await view3(SB);
  ok('another row takes the camera to its station', at(v3),
     `${SB.name}: ${Math.round(v3.off)} px from the middle of the view`);
  // Near rather than equal: an ease settles the ground height under the camera
  // when it lands, and the zoom is re-read against it.
  ok('…and keeps the camera\'s own zoom, which was already closer than the row asks for',
     near(v3.zoom, 13.4, 0.3) && v3.zoom > 13, String(v3.zoom));

  // Panned away by hand, then the same station asked for again (off, and on):
  // to a 2-D map left where the row put it, that is a pan of nothing.
  await page.evaluate(([lat, lon]) => Map3D._map().jumpTo({ center: [lon + 0.4, lat + 0.3] }), [SB.lat, SB.lon]);
  await settle3();
  await page.evaluate(id => { selectStation(id); selectStation(id); }, SB.id);
  await settle3();
  const v4 = await view3(SB);
  ok('panned away and asked for again, the camera goes back to it', at(v4),
     `${Math.round(v4.off)} px from the middle of the view`);

  // Zoom to station goes all the way in — the deepest zoom the map's base
  // allows, which the camera follows a level out.
  await page.evaluate(id => zoomToStation(id), SC.id);
  await settle3();
  const v5 = await view3(SC);
  const maxZ = await page.evaluate(() => state.map.getMaxZoom());
  ok('Zoom to station (all the way in) takes the camera there too', at(v5)
     && v5.lf.zoom === maxZ && near(v5.zoom, v5.lf.zoom - 1, 0.3), JSON.stringify({ ...v5, maxZ }));

  // The side panel's edge dragged: the 2-D map is re-measured on every frame
  // of it without being panned (dockResized), so its centre moves by half of
  // what the width did, and Leaflet reports a `moveend` for it. That is not a
  // move of anybody's, and the camera stays put — a follow of it would be a
  // jump of ~60 px here on each frame of the drag.
  const v6 = await view3();
  await page.evaluate(() => { dockSetWidth(state.dockW + 120, false); dockResized(); });
  await page.waitForTimeout(600);
  await settle3();
  const v7 = await view3();
  await page.evaluate(() => { dockSetWidth(state.dockW - 120, false); dockResized(); });
  await page.waitForTimeout(600);
  await settle3();
  ok('dragging the side panel\'s edge does not move the camera',
     near(v7.lat, v6.lat, 1e-4) && near(v7.lng, v6.lng, 1e-4) && near(v7.zoom, v6.zoom, 1e-3),
     JSON.stringify([v6, v7]));

  // A drag on the canvas moves the camera and nothing else: Leaflet's own drag
  // is off while the canvas is over it, so the 2-D map ends where the camera
  // stopped rather than wherever its own drag of the same pixels took it.
  const held = await page.evaluate(() =>
    ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard', 'touchZoom']
      .filter(k => state.map[k] && state.map[k].enabled()));
  ok('Leaflet\'s own drag, wheel, double-click and keys are off under the canvas', held.length === 0,
     held.join(', '));
  // The row and the zoom opened the station card, which grows over most of
  // the map's height from its bottom-left corner — and a drag that starts on
  // the card drags nothing.
  await page.evaluate(() => closeStnCard(false));
  const cbox = await page.locator('#map3d canvas').boundingBox();
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cbox.x + cbox.width / 2 + 160, cbox.y + cbox.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await settle3();
  const v8 = await view3();
  ok('a drag in 3-D moves the camera', !(near(v8.lat, v7.lat, 1e-3) && near(v8.lng, v7.lng, 1e-3)),
     JSON.stringify(v8));
  ok('…and the 2-D map ends where the camera stopped', v8.lfOff <= 2, JSON.stringify(v8));

  // Leaving 3-D shows the 2-D map where the camera was looking, and gives
  // Leaflet its handlers back.
  await page.evaluate(() => Map3D.toggle());
  await page.waitForTimeout(300);
  const flat = await page.evaluate(v => {
    const p = state.map.latLngToContainerPoint([v.lat, v.lng]), sz = state.map.getSize();
    return { off: Math.hypot(p.x - sz.x / 2, p.y - sz.y / 2),
             on: ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard', 'touchZoom']
               .filter(k => state.map[k] && state.map[k].enabled()).length };
  }, v8);
  ok('leaving 3-D shows the 2-D map where the camera was', flat.off <= 2, JSON.stringify(flat));
  ok('…with its own drag, wheel, double-click and keys back', flat.on === 6, `${flat.on} of 6`);

  // The card's leader was drawn over the canvas, which has gone: it is back on
  // the 2-D map's own pane, and draws there — a card on the station nearest the
  // middle of the map, and the pan a pin click there would make.
  const back = await page.evaluate(() => {
    const svg = document.querySelector('.mn-leader');
    const home = !!svg && svg.parentNode === state.map.getPane('mnLeader');
    const mid = state.map.getSize().divideBy(2);
    let best = null, bd = Infinity;
    for (const m of state.mapMarkers) {
      const p = state.map.latLngToContainerPoint(m.getLatLng());
      const dd = Math.hypot(p.x - mid.x, p.y - mid.y);
      if (dd < bd) { bd = dd; best = m; }
    }
    showStationCard(best.mnStationId);
    MapLeader.reveal();
    return { home, id: best.mnStationId };
  });
  await page.waitForTimeout(700);
  const lead2 = await page.evaluate(id => {
    const g = MapLeader.geometry();
    const mk = state.mapMarkers.find(x => x.mnStationId === id);
    const p = state.map.latLngToContainerPoint(mk.getLatLng());
    return { g, pin: { x: p.x, y: p.y } };
  }, back.id);
  ok('leaving 3-D gives the card’s leader back to the 2-D map’s own pane', back.home);
  ok('…where it is drawn to the 2-D pin',
     !!lead2.g && lead2.g.view === '2d'
     && near(lead2.g.ring.x, lead2.pin.x, 1.5) && near(lead2.g.ring.y, lead2.pin.y, 1.5),
     JSON.stringify(lead2));
  await page.evaluate(() => closeStnCard(false));

  // Back into 3-D for the teardown below, which is about leaving the tab with it on.
  await btn3d.click();
  await page.waitForFunction(
    () => !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: GL_TIMEOUT });
}

// ── 9b. the rising water ────────────────────────────────────────────────────
// Water rising through the heights of the ground in view (map-3d.js, "The
// rising water"), turned off at the top of this file and on again here, and
// held to what it claims:
//
//   the layer   a colour relief, on a DEM source of its own — MapLibre asks
//               that it not share the terrain's — over the base map (and the
//               elevation ramp) and under the links and pins;
//   the range   from under the lowest ground in view to over the highest,
//               held against this file's own closed-form world rather than
//               against the renderer, so a range read with the exaggeration
//               left in, or off the wrong ground, is out by hundreds of metres;
//   the ramp    clear above the level, water under it — and drawn: the same
//               pixels of the view turn from the base map's green to the
//               water's blue as it rises over them;
//   the rise    the level moves by itself, through most of the range;
//   the scale   up the right of the view, clear of the zoom and compass,
//               naming round heights; ⏸ holds it, a height pressed stands it
//               there, End and Home go to the head and the foot;
//   the caveat  along the foot, saying it is not flood modelling, taking no
//               pointer, with the credits, the scale bar, the zoom and the
//               compass standing on it — and the panel note saying it too;
//   the switch  off takes all of it away, and is remembered.
console.log('\nThe rising water');

if (!(await page.evaluate(() => state.map3d))) {
  await btn3d.click();
  await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: GL_TIMEOUT });
}
await idle3d();
// A short cycle, so the rise is seen to go round inside the waits below.
await page.evaluate(() => Map3D._waterClock({ rise: 2, hold: 0.4, drain: 0.4 }));
// The panel's own switch, as a press of it would leave it.
const waterSwitch = on => page.evaluate(o => {
  const cb = document.getElementById('map-3d-water');
  if (!cb) return false;
  cb.checked = o;
  cb.dispatchEvent(new Event('change'));
  return true;
}, on);
const switched = await waterSwitch(true);
await page.waitForFunction(() => { const w = Map3D._water(); return w.layer && w.lo != null && w.level != null; },
  null, { timeout: GL_TIMEOUT }).catch(() => {});
await idle3d();
const W1 = await page.evaluate(n => {
  const m = Map3D._map(), st = m.getStyle(), w = Map3D._waterRange();
  const src = st.sources[w.source] || {};
  const ml = Map3D._lib(), cv = m.getCanvas();
  // The ground the range is read from: the drawn terrain under a grid across
  // the view, handed back as world coordinates for the check's own heights.
  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ll = m.unproject([(i + 0.5) / n * cv.clientWidth, (j + 0.5) / n * cv.clientHeight]);
      if (!ll || m.terrain.getDrawnElevationForLngLat(ll) == null) continue;
      const mc = ml.MercatorCoordinate.fromLngLat(ll);
      pts.push([mc.x, mc.y]);
    }
  }
  return { w, src: { type: src.type, tiles: src.tiles, encoding: src.encoding },
           terrain: m.getTerrain(), order: st.layers.map(l => l.id), pts,
           stored: localStorage.getItem('mn-3d-water') };
}, WATER_GRID);
const wix = id => W1.order.indexOf(id);
ok('Rising water, switched on in the 3-D panel, draws a colour relief on the terrain',
   switched && W1.w.on && W1.w.layer && W1.w.type === 'color-relief' && W1.stored === 'on',
   JSON.stringify({ switched, on: W1.w.on, type: W1.w.type, stored: W1.stored }));
ok('…on a DEM source of its own, from the terrain’s tiles',
   W1.w.source === 'mn-water-dem' && W1.terrain && W1.terrain.source === 'mn-dem' && W1.src.type === 'raster-dem'
     && W1.src.encoding === 'terrarium' && /elevation-tiles-prod\/terrarium/.test((W1.src.tiles || [])[0] || ''),
   JSON.stringify({ source: W1.w.source, terrain: W1.terrain, src: W1.src }));
ok('…over the base map and the elevation ramp, under the links and the pins',
   wix('mn-water') > wix('mn-base') && (wix('mn-elev') < 0 || wix('mn-elev') < wix('mn-water'))
     && wix('mn-water') < wix('mn-links') && wix('mn-water') < wix('mn-stations'),
   W1.order.filter(id => /^mn-(base|elev|water|polar|lots|roads|links|stations)$/.test(id)).join(', '));
const worldHs = W1.pts.map(([x, y]) => heightAtWorld(x, y));
const wLo = Math.min(...worldHs), wHi = Math.max(...worldHs);
// The DEM is this world sampled at a tile's pixels and interpolated between
// them, so it is the world give or take a slope across a pixel — tens of metres
// at most on these hills, where an exaggerated reading is out by hundreds.
const wTol = Math.max(30, 0.1 * (wHi - wLo));
ok('…from under the lowest ground in view to over the highest, read off the ground in metres',
   WATER_GRID > 0 && W1.pts.length >= 12 && W1.w.lo != null && W1.w.lo < W1.w.hi
     && Math.abs(W1.w.lo - Math.max(0, wLo)) <= wTol && Math.abs(W1.w.hi - wHi) <= wTol,
   JSON.stringify({ lo: W1.w.lo, hi: W1.w.hi, world: [wLo, wHi], tol: wTol, ex: W1.terrain && W1.terrain.exaggeration, pts: W1.pts.length }));
// Never below 0 m: over ground under the sea the foot of the scale is sea
// level, not the sea floor — zoomed out to a coast, a rise from thousands of
// metres down spends nearly all its time under water the ramp draws anyway.
// This file's world dips below zero where its terms line up; such a spot is
// found by its own arithmetic, looked at from overhead, and the camera put
// back after.
const home3 = await page.evaluate(() => { const m = Map3D._map(), c = m.getCenter(); return { center: [c.lng, c.lat], zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() }; });
let sea = null;
{
  const mx = (home3.center[0] + 180) / 360;
  const my = (1 - Math.log(Math.tan(Math.PI / 4 + home3.center[1] * Math.PI / 360)) / Math.PI) / 2;
  for (let x = mx - 0.01; x <= mx + 0.01; x += 0.00002) {
    for (let y = my - 0.01; y <= my + 0.01; y += 0.00002) {
      const h = heightAtWorld(x, y);
      if (!sea || h < sea.h) sea = { x, y, h };
    }
  }
}
const seaAt = [sea.x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * sea.y))) * 180 / Math.PI];
await page.evaluate(c => Map3D._map().jumpTo({ center: c, zoom: 12, pitch: 0, bearing: 0 }), seaAt);
await page.waitForTimeout(600);
await idle3d();
const S1 = await page.evaluate(n => {
  const m = Map3D._map(), ml = Map3D._lib(), cv = m.getCanvas(), w = Map3D._waterRange(), pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ll = m.unproject([(i + 0.5) / n * cv.clientWidth, (j + 0.5) / n * cv.clientHeight]);
      if (!ll || m.terrain.getDrawnElevationForLngLat(ll) == null) continue;
      const mc = ml.MercatorCoordinate.fromLngLat(ll);
      pts.push([mc.x, mc.y]);
    }
  }
  return { w, pts };
}, WATER_GRID);
const seaHs = S1.pts.map(([x, y]) => heightAtWorld(x, y));
ok('over ground below sea level the water starts at 0 m, not at the floor',
   sea.h < -30 && seaHs.length >= 12 && Math.min(...seaHs) < -10 && S1.w.lo === 0 && S1.w.hi > 0
     && (S1.w.scale ? S1.w.scale.heights.every(m => m >= 0) : true),
   JSON.stringify({ deepest: Math.round(sea.h), inView: [Math.round(Math.min(...seaHs)), Math.round(Math.max(...seaHs))],
                    lo: S1.w.lo, hi: S1.w.hi, heights: S1.w.scale && S1.w.scale.heights }));
await page.evaluate(h => Map3D._map().jumpTo(h), home3);
await page.waitForTimeout(600);
await idle3d();
await page.evaluate(() => Map3D._waterRange());

const rampOk = r => Array.isArray(r) && r[0] === 'interpolate' && JSON.stringify(r[2]) === '["elevation"]'
  && r.length === 9 && r[3] < r[5] && r[5] < r[7];
const alphaOf = c => { const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(String(c)); return m ? Number(m[1]) : null; };
ok('…its ramp clear above the level and water under it',
   rampOk(W1.w.ramp) && Math.abs(W1.w.ramp[7] - W1.w.level) < 0.011 && alphaOf(W1.w.ramp[8]) === 0
     && alphaOf(W1.w.ramp[4]) > 0.3 && alphaOf(W1.w.ramp[6]) > 0.3,
   JSON.stringify({ level: W1.w.level, ramp: W1.w.ramp }));

// The rise: the level moves by itself, round most of the range, and never out of it.
const seen = [];
for (let i = 0; i < 24; i++) {
  seen.push(await page.evaluate(() => Map3D._water().level));
  await page.waitForTimeout(150);
}
const W2 = await page.evaluate(() => Map3D._water());
const span = W2.hi - W2.lo;
ok('the water rises by itself, through most of the ground’s range, and round again',
   W2.rising && W2.looping && Math.max(...seen) - Math.min(...seen) >= 0.5 * span
     && seen.every(l => l != null && l >= W2.lo - 0.01 && l <= W2.hi + 0.01),
   JSON.stringify({ lo: W2.lo, hi: W2.hi, seen: seen.map(l => Math.round(l)) }));

// The scale and the caveat, measured where they are drawn.
const chrome = () => page.evaluate(() => {
  const b = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const host = document.getElementById('map3d'), cav = document.getElementById('map3d-water-caveat');
  const cb = b(cav);
  const under = cb ? document.elementFromPoint((cb.left + cb.right) / 2, (cb.top + cb.bottom) / 2) : null;
  return {
    host: b(host), hasWater: host.classList.contains('has-water'),
    scale: b(document.getElementById('map3d-water-scale')), track: b(document.getElementById('map3d-water-track')),
    caveat: cb, caveatText: cav ? cav.textContent : '',
    shownCaveat: cav ? [...cav.querySelectorAll('[aria-hidden="true"]')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.textContent) : [],
    under: under ? under.className : null,
    nav: b(document.querySelector('#map3d .maplibregl-ctrl-bottom-right .maplibregl-ctrl-group')),
    attrib: b(document.querySelector('#map3d .maplibregl-ctrl-attrib')),
    bar: b(document.querySelector('#map3d .maplibregl-ctrl-scale')),
    labels: [...document.querySelectorAll('#map3d-water-labels .twin-scale-label')].map(x => ({ m: Number(x.dataset.m), text: x.textContent, pressed: x.getAttribute('aria-pressed') })),
    play: (document.getElementById('map3d-water-play') || {}).textContent || '',
    now: (document.getElementById('map3d-water-now') || {}).textContent || '',
    note: (document.getElementById('map-3d-note') || {}).textContent || '',
    // The digital twin's offer, across the top of the map at close zoom and
    // over this canvas — up here, as it happens, and the scale's head was
    // under it until the scale was told to stand below it.
    offer: (() => { const o = document.getElementById('map-twin-offer'); return o && !o.hidden ? b(o) : null; })(),
  };
});
const C1 = await chrome();
ok('a scale stands up the right of the view, under ↺ and clear of the zoom and compass',
   !!C1.scale && !!C1.host && !!C1.nav && C1.scale.right <= C1.host.right + 0.5 && C1.scale.left > C1.host.left + C1.host.width / 2
     && C1.scale.top >= C1.host.top + 40 && C1.scale.bottom <= C1.nav.top + 0.5 && C1.track && C1.track.height > 60,
   JSON.stringify({ scale: C1.scale, nav: C1.nav, track: C1.track }));
ok('…and under the digital twin’s offer while that is up across the top of the map',
   !C1.offer || C1.scale.top >= C1.offer.bottom - 0.5, JSON.stringify({ scale: C1.scale, offer: C1.offer }));
const stepOk = W2.scale && C1.labels.length >= 2 && C1.labels.every((l, i) => i === 0 || Math.abs(l.m - C1.labels[i - 1].m - W2.scale.step) < 1e-6);
ok('…naming round heights up the range, a round step apart, the reading at its head in m AHD',
   stepOk && C1.labels.every(l => l.m >= W2.lo && l.m <= W2.hi && l.text === `${l.m} m` && Math.abs(l.m / W2.scale.step - Math.round(l.m / W2.scale.step)) < 1e-6)
     && /^≈ -?\d+\.\d m AHD$/.test(C1.now),
   JSON.stringify({ step: W2.scale && W2.scale.step, labels: C1.labels.map(l => l.text), now: C1.now }));
ok('along the foot, in red and in so many words: not flood modelling',
   !!C1.caveat && Math.abs(C1.caveat.bottom - C1.host.bottom) <= 1 && Math.abs(C1.caveat.width - C1.host.width) <= 1
     && C1.shownCaveat.length === 1 && /^⚠ Not flood modelling/.test(C1.shownCaveat[0])
     && /not a flood map, a flood level or a forecast/.test(C1.caveatText),
   JSON.stringify({ caveat: C1.caveat, shown: C1.shownCaveat }));
ok('…with MapLibre’s credits, scale bar, zoom and compass standing on it',
   C1.hasWater && C1.nav && C1.attrib && C1.bar && C1.nav.bottom <= C1.caveat.top + 0.5
     && C1.attrib.bottom <= C1.caveat.top + 0.5 && C1.bar.bottom <= C1.caveat.top + 0.5,
   JSON.stringify({ caveat: C1.caveat, nav: C1.nav, attrib: C1.attrib, bar: C1.bar }));
ok('…and taking no pointer: a drag that starts on it is a drag of the map',
   /maplibregl-canvas/.test(C1.under || ''), String(C1.under));
ok('the 3-D panel says it too', /rising water is not flood\s+modelling/i.test(C1.note), C1.note.replace(/\s+/g, ' ').slice(0, 160));

// ⏸ holds it where it is.
await page.click('#map3d-water-play');
const P1 = await page.evaluate(() => Map3D._water());
await page.waitForTimeout(500);
const P2 = await page.evaluate(() => Map3D._water());
const C2 = await chrome();
ok('⏸ holds the water where it is, and turns to ▶',
   !P1.rising && !P1.looping && P1.level != null && P2.level === P1.level && C2.play.startsWith('▶'),
   JSON.stringify({ rising: P1.rising, looping: P1.looping, before: P1.level, after: P2.level, play: C2.play }));

// A height pressed stands the water there — and it is drawn: the same pixels
// turn from the base map's green to the water's blue as the water goes from
// the foot of the scale to its head.
const pixels = () => page.evaluate(() => new Promise(resolve => {
  const m = Map3D._map(), cv = m.getCanvas();
  m.once('render', () => {
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    const out = [];
    for (const [fx, fy] of [[0.3, 0.75], [0.5, 0.8], [0.7, 0.75], [0.4, 0.9], [0.6, 0.9]]) {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(gl.drawingBufferWidth * fx), Math.floor(gl.drawingBufferHeight * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([px[0], px[1], px[2]]);
    }
    resolve(out);
  });
  m.triggerRepaint();
}));
const mid = C2.labels[Math.floor(C2.labels.length / 2)];
await page.click(`#map3d-water-labels .twin-scale-label[data-m="${mid.m}"]`);
await page.waitForTimeout(200);
const A1 = await page.evaluate(() => Map3D._water());
const C3 = await chrome();
ok('a height pressed on the scale stands the water there, and says it is held there',
   A1.level === mid.m && A1.hold === mid.m && !A1.rising && (C3.labels.find(l => l.m === mid.m) || {}).pressed === 'true',
   JSON.stringify({ pressed: mid.m, level: A1.level, hold: A1.hold, labels: C3.labels }));
await page.focus('#map3d-water-track');
await page.keyboard.press('Home');
await page.waitForTimeout(300);
await idle3d();
const K1 = await page.evaluate(() => Map3D._water());
const dry = await pixels();
await page.keyboard.press('End');
await page.waitForTimeout(300);
await idle3d();
const K2 = await page.evaluate(() => Map3D._water());
const wet = await pixels();
ok('Home and End take it to the foot of the scale and the head', K1.level === K1.lo && K2.level === K2.hi,
   JSON.stringify({ home: K1.level, lo: K1.lo, end: K2.level, hi: K2.hi }));
const bluer = dry.map((d, i) => (wet[i][2] - wet[i][1]) - (d[2] - d[1]));
ok('…and the water is drawn: under it the ground turns from the base map’s green to blue',
   bluer.filter(x => x >= 40).length >= 3, JSON.stringify({ dry, wet }));

// ▶ sets it rising again, from where it stands.
await page.click('#map3d-water-play');
const R1 = await page.evaluate(() => Map3D._water());
ok('▶ sets it rising again', R1.rising && R1.looping && R1.hold == null, JSON.stringify(R1));

// Off: the layer, its source, the scale and the caveat go, MapLibre's furniture
// drops back to the foot, and the choice is remembered.
await waterSwitch(false);
await page.waitForTimeout(200);
const waterOff = await page.evaluate(() => {
  const m = Map3D._map(), host = document.getElementById('map3d');
  const br = document.querySelector('#map3d .maplibregl-ctrl-bottom-right').getBoundingClientRect();
  return { w: Map3D._water(), src: !!m.getSource('mn-water-dem'), scale: !!document.getElementById('map3d-water-scale'),
           caveat: !!document.getElementById('map3d-water-caveat'), hasWater: host.classList.contains('has-water'),
           foot: Math.abs(br.bottom - host.getBoundingClientRect().bottom), stored: localStorage.getItem('mn-3d-water'),
           note: (document.getElementById('map-3d-note') || {}).textContent || '' };
});
ok('Rising water off takes the layer, its source, the scale and the caveat away',
   !waterOff.w.on && !waterOff.w.layer && !waterOff.src && !waterOff.scale && !waterOff.caveat && !waterOff.hasWater && !waterOff.w.looping
     && !/not flood\s+modelling/i.test(waterOff.note),
   JSON.stringify(waterOff));
ok('…puts MapLibre’s furniture back at the foot, and is remembered', waterOff.foot <= 1 && waterOff.stored === 'off',
   JSON.stringify({ foot: waterOff.foot, stored: waterOff.stored }));
await page.evaluate(() => Map3D._waterClock(null));

// ── 9c. ⛰️ and its settings ────────────────────────────────────────────────
// One button: pressed, the side panel opens on the 3-D settings and the map
// tilts; pressed again, the map is flat and the side panel is back as ⛰️ found
// it — on the pane that was open, or shut. Both, from a known start: the map
// flat by Map3D's own toggle, which leaves the side panel alone.
console.log('\n⛰️ opens its settings, and puts the side panel back');

const flat3d = () => page.waitForFunction(() => !state.map3d && !Map3D._map(), null, { timeout: GL_TIMEOUT });
const tilted3d = () => page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: GL_TIMEOUT });
if (await page.evaluate(() => state.map3d)) { await page.evaluate(() => Map3D.toggle()); await flat3d(); }
await page.evaluate(() => setDockTab('map-legend'));
await btn3d.click();
await tilted3d();
const in1 = await page.evaluate(() => dockShowing());
await btn3d.click();
await flat3d();
const out1 = await page.evaluate(() => ({ showing: dockShowing(), stored: localStorage.getItem('mn-dock-tab') }));
ok('⛰️ from the legend: the 3-D settings while tilted, the legend again when flat',
   in1 === 'map-3d' && out1.showing === 'map-legend' && out1.stored === 'map-legend', JSON.stringify({ in1, out1 }));
await page.evaluate(() => shutDock());
await btn3d.click();
await tilted3d();
const in2 = await page.evaluate(() => ({ showing: dockShowing(), stored: localStorage.getItem('mn-help') }));
await btn3d.click();
await flat3d();
const out2 = await page.evaluate(() => dockShowing());
ok('…from a shut side panel: opened on the 3-D settings, and shut again after — remembered as shut while it was open',
   in2.showing === 'map-3d' && in2.stored === 'collapsed' && out2 === null, JSON.stringify({ in2, out2 }));
// Back into 3-D for the teardown below, which is about leaving the tab with it on.
await page.evaluate(() => setDockTab('stations'));
await btn3d.click();
await tilted3d();

console.log('\nLeaving the tab takes the WebGL context with it');

await page.evaluate(() => switchTab('export'));
await page.waitForTimeout(500);
const afterLeave = await page.evaluate(() => ({
  map:    !!Map3D._map(),
  mode:   state.map3d,
  canvas: !!document.querySelector('#map3d canvas'),
  host:   !!document.getElementById('map3d'),
}));
ok('the MapLibre map is gone',        afterLeave.map === false);
ok('its canvas is gone with it',      afterLeave.canvas === false);
ok('the host div is gone too',        afterLeave.host === false);
ok('and the mode reads as off',       afterLeave.mode === false);

// …and coming back works, which is the failure a too-eager teardown produces
// (registry.mjs's lesson: a teardown that breaks the tab is worse than a leak).
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.locator('.mn-map-3d').click();
await page.waitForFunction(
  () => !!Map3D._map() && Map3D._map().isStyleLoaded(), null, { timeout: GL_TIMEOUT });
const again = await page.evaluate(() => ({
  map: !!Map3D._map(), mode: state.map3d,
  pins: Map3D._mirror().stations.features.length,
  markers: state.mapMarkers.length,
}));
ok('coming back and pressing ⛰️ again works',
   again.map && again.mode === true);
ok('…and the mirror is rebuilt against the new map',
   again.pins === again.markers && again.pins > 0, `${again.pins} pins`);

// The renderer is fetched once, not once per press: a module is imported
// once per page however many times it is asked for, and loadLib() holds it.
const scripts = await page.evaluate(() =>
  document.querySelectorAll('script[src*="maplibre-gl"]').length);
ok('the renderer was fetched once, not once per press',
   libRequests.length === 1 && scripts === 0, `${libRequests.length} request(s), ${scripts} script tag(s)`);

await page.evaluate(() => { Map3D.stop(); });

// ── 10. from a page opened as a file (#190) ─────────────────────────────────
// file:// is a supported way to run this app (README.md in this folder says
// why it is not the way to *test* it), and it is the one place MapLibre 6 does
// not start on its own: Chromium will not start a module worker from a blob:
// there, so map-3d.js hands the library its worker as a classic script. So the
// repo's own index.html is opened as a file, with the stations from where a
// file:// page gets them — GitHub raw, answered here from the committed file —
// and the same world as above.
console.log('\nFrom a page opened as a file');

const fpage = await context.newPage();
const ferrors = [];
fpage.on('pageerror', e => ferrors.push(String(e)));
fpage.on('console', m => { if (m.type() === 'error' && /worker/i.test(m.text())) ferrors.push(m.text()); });
await applyNetworkPolicy(fpage, 'file://');
await fpage.route(/raw\.githubusercontent\.com\/cdomotor-g\/MegaNet\/main\/stations\.json/, route =>
  route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
                  body: fs.readFileSync(new URL('../stations.json', import.meta.url)),
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
await fpage.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png', body: terrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await fpage.route(/(tile\.openstreetmap\.org|tile\.opentopomap\.org|server\.arcgisonline\.com)/, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: baseTilePng(),
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
await fpage.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await fpage.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await fpage.evaluate(() => switchTab('stations'));
await fpage.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await fpage.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });
await fpage.locator('.mn-map-3d').click();
const fileOpened = await fpage.waitForFunction(() => {
  const m = typeof Map3D !== 'undefined' && Map3D._map();
  return !!m && m.isStyleLoaded() && !!m.getTerrain();
}, null, { timeout: GL_TIMEOUT }).then(() => true, () => false);
// The pins are a GeoJSON source, which MapLibre tiles in its worker: pins that
// can be queried back are a worker that started and answered.
const fileWorked = fileOpened && await fpage.waitForFunction(() => {
  const m = Map3D._map();
  return m.isSourceLoaded('mn-stations') && m.querySourceFeatures('mn-stations').length > 0;
}, null, { timeout: GL_TIMEOUT }).then(() => true, () => false);
const fileRun = await fpage.evaluate(() => ({
  protocol: location.protocol,
  worker:   Map3D._lib() ? (Map3D._lib().getWorkerUrl() || '').slice(0, 32) : null,
  pins:     Map3D._map() ? Map3D._map().querySourceFeatures('mn-stations').length : 0,
}));
ok('the 3-D view opens from a page opened as a file',
   fileRun.protocol === 'file:' && fileOpened, JSON.stringify(fileRun));
ok('…and its worker answers: the pins come back out of it',
   fileWorked && fileRun.pins > 0, JSON.stringify(fileRun));
ok('…handed over as a classic script', /^data:text\/javascript/.test(fileRun.worker || ''), String(fileRun.worker));
ok('…and nothing on that page threw or said its worker failed', ferrors.length === 0,
   ferrors.slice(0, 3).join(' | '));
await fpage.evaluate(() => { if (typeof Map3D !== 'undefined') Map3D.stop(); });
await fpage.close();

// ── the console ─────────────────────────────────────────────────────────────
ok('nothing threw on the page', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
await server.close();

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
