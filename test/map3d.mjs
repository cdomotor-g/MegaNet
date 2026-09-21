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

const beforePress = await page.evaluate(() => ({
  lib:    typeof window.maplibregl,
  script: !!document.querySelector('script[src*="maplibre-gl"]'),
  mode:   state.map3d,
  host:   !!document.getElementById('map3d'),
}));
ok('the page has loaded and opened the map without maplibregl',
   beforePress.lib === 'undefined', `typeof maplibregl = ${beforePress.lib}`);
ok('…and without a script tag for it',  beforePress.script === false);
ok('3-D is off until it is asked for',  beforePress.mode === false);
ok('and there is no canvas over the map', beforePress.host === false);

// The button, and the panel beside it.
const btn3d = page.locator('.mn-map-3d');
ok('the map has a ⛰️ corner button', await btn3d.count() === 1);
ok('…which reports that the mode is off',
   await btn3d.getAttribute('aria-pressed') === 'false');

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
    lib:      typeof window.maplibregl,
    version:  window.maplibregl && maplibregl.getVersion ? maplibregl.getVersion() : null,
    on:       state.map3d,
    terrain:  m.getTerrain(),
    pitch:    m.getPitch(),
    maxPitch: m.transform ? m.transform.maxPitch : null,
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
ok('the renderer is now loaded',            cam.lib === 'object', `typeof = ${cam.lib}`);
ok('…and it is the version map-3d.js pins', cam.version === '5.24.0', String(cam.version));
ok('the mode is on',                        cam.on === true);
ok('there is a WebGL canvas over the map',  cam.canvas && cam.hostOn);
ok('terrain is set, from the DEM source',   !!cam.terrain && cam.terrain.source === 'mn-dem',
   JSON.stringify(cam.terrain));
ok('the DEM tiles were actually fetched',   demHits > 0, `${demHits} tiles`);
ok('the base map is draped over it',        cam.baseSrc);
// The camera the whole feature was asked for.
ok('the camera starts tilted',              cam.pitch > 30, `${cam.pitch}°`);
ok('…and can go to 85°',                    cam.maxPitch === 85, String(cam.maxPitch));
ok('drag-rotate is on',                     cam.rotate);
ok('the keyboard can tilt it too',          cam.keyboard);
ok('and a touch screen can',                cam.touch);
// The two depictions the feature is for: a line across the ground, and the
// sheet layer that rises from it.
ok('the links are drawn as a layer',        cam.layers.includes('mn-links'), cam.layers.join(', '));
ok('the stations are drawn as a layer',     cam.layers.includes('mn-stations'));
ok('the sheet layer is registered',         cam.sheetLayer === true);

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
  };
});
ok('every pin on the 2-D map is in the 3-D view',
   mirror.pins === mirror.markers, `${mirror.pins} vs ${mirror.markers}`);
ok('…carrying the same station ids, in the same order', mirror.idsMatch);
ok('…the same role colours',                            mirror.fillsMatch);
ok('…and the same filter rings',                        mirror.ringsMatch);
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
    probes: ['.mn-map-3d', '.mn-map-full', '.mn-mapctl[data-panel="display"] .mn-mapctl-btn',
             '.mn-mapctl[data-panel="3d"] .mn-mapctl-btn'].map(probe),
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

// The panel's own switch and the corner button are the same mode.
ok('the ⛰️ button reports the mode is on',
   await btn3d.getAttribute('aria-pressed') === 'true');
const panelBtn = await page.evaluate(() => {
  const b = document.getElementById('map-3d-toggle');
  return b ? { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') } : null;
});
ok('and the panel offers the way out', panelBtn && /Leave 3-D/.test(panelBtn.text),
   JSON.stringify(panelBtn));

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

if (pin) {
  await page.waitForTimeout(1200);
  // Where the renderer says the pin is, rather than where the arithmetic says
  // it should be: pins are billboarded circles standing on terrain, and the
  // question this check is asking is about what a *click* does.
  const where = await page.evaluate((t) => {
    const m = Map3D._map();
    const p = m.project([t.lng, t.lat]);
    const r = m.getCanvas().getBoundingClientRect();
    const f = m.queryRenderedFeatures([p.x, p.y], { layers: ['mn-stations'] });
    const hit = f.length ? f[0].properties.id : null;
    const mk  = (state.mapMarkers || []).find(x => x.mnStationId === hit);
    return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y), hit,
             repeater: !!(mk && mk.mnStation && mk.mnStation.roles
                          && mk.mnStation.roles.includes('repeater')) };
  }, pin);
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
  // the canvas so it can be seen, under the control corners so the icon column
  // it shares the map with stays reachable.
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
    await page.evaluate(() => closeStnCard(false));
    await page.waitForTimeout(150);
    await page.mouse.click(where.x, where.y);
    await page.waitForTimeout(400);
    ok('…and clicking it again clears the focus',
       await page.evaluate(() => state.mapFocusRepeaterId) == null);
  }
  await page.evaluate(() => { state.mapFocusRepeaterId = null; closeStnCard(false); });
}

// ── 8. leaving the tab takes the GL context with it ─────────────────────────
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

// The renderer is fetched once, not once per press.
const scripts = await page.evaluate(() =>
  document.querySelectorAll('script[src*="maplibre-gl"]').length);
ok('the renderer was injected once, not once per press', scripts === 1, `${scripts} tags`);

await page.evaluate(() => { Map3D.stop(); });

// ── the console ─────────────────────────────────────────────────────────────
ok('nothing threw on the page', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
await server.close();

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
