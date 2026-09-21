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
  const p = { x: Math.round(r.width * 0.32), y: Math.round(r.height * 0.34) };
  const gl = m.unproject([p.x, p.y]);
  const c  = document.getElementById('leaflet-map').getBoundingClientRect();
  const lf = state.map.containerPointToLatLng([r.left + p.x - c.left, r.top + p.y - c.top]);
  return { cx: Math.round(r.left + p.x), cy: Math.round(r.top + p.y),
           gl: [gl.lat, gl.lng], lf: [lf.lat, lf.lng] };
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

// ── 9. leaving the tab takes the GL context with it ─────────────────────────
// ── a path clicked in 3-D opens the card its 2-D line opens (#195) ────────
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
