// The station relocation finder (map-relocate.js), held to what it claims.
//
// Everything runs against ground this check makes. The terrain is the terrain
// kit's hilly world (lib/terrarium.mjs); round the station picked, the trees,
// the water and the buildings are laid out here, in metres east and north of
// it, and handed to the app through the seams it already has — the land
// cover's seeded sampler for the canopy and the classes, and routes standing
// in for the State's buildings and for Overpass:
//
//   a stand of 15 m trees, a disc 70 m across the middle, 150 m east
//   water, a strip 300–340 m north, from edge to edge
//   a shed outline 20 m square, 200 m west, roof 6 m (the LiDAR's own layer)
//   a house known only as a point, 200 m south (the topographic points)
//   a barn 16 m square from OpenStreetMap, 250 m south-west
//
// so every assertion below is arithmetic on that layout, not a reading of the
// app back to itself. What is under test, and the defect each block would
// catch:
//
//   The panel       a pane of the side panel, its button straight after 🗼 and
//                   straight before ℹ️, and Find new sites off until a station
//                   is picked — with a reason.
//   The station     found by its number through the box, with a real click;
//                   the repeaters that carry it ticked and the nearby others
//                   offered unticked.
//   The lattice     every place inside the circle and none outside, ~32
//                   across, where it is now among them.
//   Ruled out       every place within the clearance of a building — a point,
//                   an outline, an OpenStreetMap way — and every place in
//                   water, and no other; a clearance moved re-reads the ground
//                   with nothing fetched.
//   Open sky        under the canopy is WMO class 5; well away from every
//                   obstacle is class 1; beside the stand, the angle is the
//                   one the trees' height and distance make.
//   The margin      a screened figure is pathAnalyse over the same 30 m path,
//                   and a result's quoted figure is the link budget card's own
//                   arithmetic over pathGround's 256 samples, to the last bit.
//   The ranking     a place every repeater hears at "ok" first; best first;
//                   spaced; never ruled out; a weight a re-rank with the
//                   screen kept — and "close by" alone puts the nearest first.
//   The map         the wash painted and re-painted by the colour mode with no
//                   terrain asked; the buildings outlined; a pointer on the
//                   ground shows that square's figures; a pin is what a real
//                   click lands on, and picks it.
//   A source down   Overpass refusing is said in words, and the State's
//                   buildings still rule their places out.
//   Reset           takes all of it off the map.
//
//   npm run relocate          (or: node relocate.mjs)
//   npm run relocate -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { answer, asking } from './lib/ask.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 120_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ── the layout, in metres east (x) and north (y) of the station ─────────────
const TREES = { x: 150, y: 0, r: 70, h: 15 };
const WATER = { y0: 300, y1: 340 };
const SHED  = { x: -200, y: 0, half: 10, h: 6 };
const HOUSE = { x: 0, y: -200, r: 6 };          // the app's radius for a point
const BARN  = { x: -250, y: -250, half: 8 };
const CLEAR = 10, RIM = 1, OBST_R = 60;

// The check's own metres-in-a-degree, the same series the app uses — so a
// place's offsets and its coordinates mean one thing on both sides.
function mpd(lat) {
  const p = lat * Math.PI / 180;
  return { lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
           lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) };
}
const square = (st, b) => {
  const k = mpd(st.lat);
  const ll = (x, y) => [st.lon + x / k.lon, st.lat + y / k.lat];
  return [ll(b.x - b.half, b.y - b.half), ll(b.x + b.half, b.y - b.half), ll(b.x + b.half, b.y + b.half),
          ll(b.x - b.half, b.y + b.half), ll(b.x - b.half, b.y - b.half)];
};
const distSquare = (b, x, y) => {
  const dx = Math.max(Math.abs(x - b.x) - b.half, 0), dy = Math.max(Math.abs(y - b.y) - b.half, 0);
  return Math.hypot(dx, dy);
};
const bldDist = (x, y) => Math.min(distSquare(SHED, x, y), Math.max(0, Math.hypot(x - HOUSE.x, y - HOUSE.y) - HOUSE.r),
                                   distSquare(BARN, x, y));
const treeEdge = (x, y) => Math.hypot(x - TREES.x, y - TREES.y) - TREES.r;   // negative inside

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
let tilesAsked = 0;
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  tilesAsked++;
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});

let ST = null;                    // the station, once picked
const qldAsked = [];
await page.route(/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/Structure\/BuildingsAndSettlements\/MapServer\/(\d+)\/query/, route => {
  const url = new URL(route.request().url());
  const id = +/MapServer\/(\d+)\/query/.exec(url.pathname)[1];
  qldAsked.push({ id, where: url.searchParams.get('where'), geometry: url.searchParams.get('geometry') });
  const k = ST ? mpd(ST.lat) : null;
  let features = [];
  if (ST && id === 11) {
    features = [{ attributes: { bsm_max: 110 + SHED.h, dtm_centre: 110 }, geometry: { rings: [square(ST, SHED)] } }];
  } else if (ST && id === 10) {
    features = [{ attributes: { function: 'House' },
                  geometry: { x: ST.lon + HOUSE.x / k.lon, y: ST.lat + HOUSE.y / k.lat } }];
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features }),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
let osmMode = 'ok';
let osmAsked = 0;
await page.route(/overpass/, route => {
  osmAsked++;
  if (osmMode === 'down') return route.fulfill({ status: 500, body: 'down', headers: { 'Access-Control-Allow-Origin': '*' } });
  const geometry = ST ? square(ST, BARN).map(([lon, lat]) => ({ lat, lon })) : [];
  return route.fulfill({ status: 200, contentType: 'application/json',
                         body: JSON.stringify({ elements: ST ? [{ type: 'way', id: 1, tags: { building: 'barn' }, geometry }] : [] }),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });
await page.click('#help-panel .dock-tab[data-dock="map-relocate"]');
await page.waitForTimeout(400);

// ── 0. the panel ─────────────────────────────────────────────────────────────
console.log('\nThe panel');

const panel = await page.evaluate(() => {
  const wrap = document.querySelector('.mn-mapctl[data-panel="relocate"]');
  const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
  const at = sel => strip.findIndex(b => b.matches(sel));
  const body = wrap && wrap.querySelector('.mn-mapctl-body');
  return {
    present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
    shown: !!(body && body.getClientRects().length), showing: dockShowing(),
    title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    group: strip.find(b => b.dataset.dock === 'map-relocate')?.closest('.dock-group')?.dataset.group,
    afterSites: at('[data-dock="map-relocate"]') === at('[data-dock="map-sites"]') + 1,
    beforeHere: at('.mn-map-here') === at('[data-dock="map-relocate"]') + 1,
    runDisabled: document.getElementById('reloc-run')?.disabled,
    status: document.getElementById('reloc-status')?.textContent || '',
  };
});
ok('a 🚚 Relocate station is a pane of the side panel, open from its button in the strip',
   panel.present && panel.docked && panel.shown && panel.showing === 'map-relocate'
     && panel.title === 'Relocate station', JSON.stringify(panel));
ok('…in the tools group, straight after the repeater site finder and straight before What is here',
   panel.group === 'tools' && panel.afterSites && panel.beforeHere, JSON.stringify(panel));
ok('Find new sites is off with no station, and the panel says what is missing',
   panel.runDisabled === true && /Pick the station/.test(panel.status), panel.status);

// ── 1. the station ───────────────────────────────────────────────────────────
console.log('\nThe station');

// A field station in Queensland with one or two repeaters carrying it, each
// with a complete radio and 5–40 km away, and a station number nobody else
// answers to — so typing it finds exactly one.
const pick = await page.evaluate(() => {
  const all = state.data.stations;
  const nums = all.reduce((m, s) => m.set(String(s.station_number || ''), (m.get(String(s.station_number || '')) || 0) + 1), new Map());
  const done = sys => sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  for (const s of all) {
    if (!s.roles.includes('field') || s.lat == null || !s.station_number || nums.get(String(s.station_number)) !== 1) continue;
    if (!(s.lon > 139 && s.lon < 153 && s.lat < -11 && s.lat > -28.5)) continue;
    if (!done(rmSystemOf(s))) continue;
    const reps = findRepeaterMatches(s).filter(r => r.lat != null && r.id !== s.id);
    if (!reps.length || reps.length > 2 || !reps.every(r => done(rmSystemOf(r)))) continue;
    if (!reps.every(r => { const k = acmaHaversineKm(s.lat, s.lon, r.lat, r.lon); return k > 5 && k < 40; })) continue;
    return { id: s.id, name: s.name, number: s.station_number, lat: s.lat, lon: s.lon, reps: reps.map(r => r.id) };
  }
  return null;
});
ok('the file holds a station to test with', !!pick, JSON.stringify(pick));
ST = pick;

await page.fill('#reloc-find', String(pick.number));
await page.locator('#reloc-hits .polar-hit', { hasText: pick.name }).first().click();
await page.waitForTimeout(300);
const picked = await page.evaluate(() => ({
  st: MapRelocate.station(), ticks: MapRelocate.hubs(),
  boxes: [...document.querySelectorAll('.reloc-hubs input[type=checkbox]')].map(b => ({ on: b.checked, off: b.disabled })),
  run: document.getElementById('reloc-run')?.disabled,
  line: document.getElementById('reloc-picked')?.textContent || '',
}));
ok('a station found by its number is the station to move', picked.st && picked.st.id === pick.id && picked.line.includes(pick.name),
   JSON.stringify(picked.st));
ok('the repeaters that carry it come ticked, and only they',
   picked.ticks.length === pick.reps.length && pick.reps.every(id => picked.ticks.includes(id)), JSON.stringify(picked.ticks));
ok('…with nearby repeaters and bases offered beside them, unticked',
   picked.boxes.length > pick.reps.length && picked.boxes.slice(pick.reps.length).every(b => !b.on), JSON.stringify(picked.boxes));
ok('…and Find new sites is on', picked.run === false);

// The trees and the water, through the land cover's own seam: classes and
// canopy for whatever points are asked — the places, and the 10 m lattice.
await page.evaluate(({ st, TREES, WATER, k }) => {
  LandCover.seed((lat, lon) => {
    const cls = [], canopy = [];
    for (let i = 0; i < lat.length; i++) {
      const x = (lon[i] - st.lon) * k.lon, y = (lat[i] - st.lat) * k.lat;
      const tree = Math.hypot(x - TREES.x, y - TREES.y) <= TREES.r;
      const water = y >= WATER.y0 && y <= WATER.y1;
      cls.push(water ? 1 : tree ? 2 : 11);
      canopy.push(tree ? TREES.h : 0);
    }
    return { cls, canopy };
  });
}, { st: pick, TREES, WATER, k: mpd(pick.lat) });

const run = async () => {
  await page.locator('#reloc-run').click();
  await page.waitForFunction(() => ['done', 'blocked'].includes(MapRelocate.status().kind), null, { timeout: RUN_TIMEOUT });
  return page.evaluate(() => ({ status: MapRelocate.status(), cells: MapRelocate.cells(), results: MapRelocate.results(),
                                now: MapRelocate.now(), step: MapRelocate.step(), hubs: MapRelocate.hubs(),
                                bld: MapRelocate.buildings(),
                                text: document.getElementById('reloc-status')?.textContent || '' }));
};

// ── 2. the lattice ───────────────────────────────────────────────────────────
console.log('\nThe lattice');

const t0 = Date.now();
const A = await run();
ok('the run finishes', A.status.kind === 'done', JSON.stringify(A.status) + ' ' + A.text);
if (VERBOSE) console.log(`         ${A.cells.length} places × ${A.hubs.length} repeater(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const R = 500;
ok('the places are a lattice ~32 across the 500 m circle', A.step === Math.round(2 * R / 32), `step ${A.step} m`);
const n = Math.ceil(R / A.step);
let inside = 0;
for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) if (Math.hypot(i * A.step, j * A.step) <= R) inside++;
ok('…every one inside the circle and none outside it',
   A.cells.length === inside && A.cells.every(c => c.dM <= R + 1e-6), `${A.cells.length} of ${inside}`);
ok('…where it is now among them, at the station', A.cells.filter(c => c.now).length === 1
   && A.cells.find(c => c.now).dM === 0);
ok('every place has a screened figure to every repeater',
   A.cells.every(c => c.grid.length === A.hubs.length && c.grid.every(f => f.failed || Number.isFinite(f.margin))));

// ── 3. ruled out ─────────────────────────────────────────────────────────────
console.log('\nRuled out');

const box = qldAsked.find(q => q.id === 11);
const [w, s, e, nn] = (box ? box.geometry : '0,0,0,0').split(',').map(Number);
const k = mpd(pick.lat);
ok('the State is asked about all four of its building layers, over the circle and 60 m beyond',
   [0, 10, 11, 20].every(id => qldAsked.some(q => q.id === id)) && box.where === "status='Current'"
   && Math.abs((pick.lat - s) * k.lat - (R + OBST_R)) < 1 && Math.abs((e - pick.lon) * k.lon - (R + OBST_R)) < 1,
   JSON.stringify(qldAsked.slice(0, 4)));
ok('…and OpenStreetMap too', osmAsked >= 1);
ok('every building found is counted under its source',
   A.bld && A.bld.n === 3 && A.bld.sources.find(x => /LiDAR/.test(x.label)).n === 1
   && A.bld.sources.find(x => /points/.test(x.label)).n === 1 && A.bld.sources.find(x => /OpenStreetMap/.test(x.label)).n === 1,
   JSON.stringify(A.bld));

const wrongB = [], wrongW = [];
for (const c of A.cells) {
  if (c.now) continue;
  const d = bldDist(c.x, c.y);
  const water = c.y >= WATER.y0 && c.y <= WATER.y1;
  const want = d < CLEAR - 0.3 ? 'building' : d > CLEAR + 0.3 ? (water ? 'water' : null) : undefined;
  if (want === undefined) continue;
  if (want === 'building' && c.excluded !== 'building') wrongB.push(`${c.id} d=${d.toFixed(1)} → ${c.excluded}`);
  if (want !== 'building' && c.excluded === 'building') wrongB.push(`${c.id} d=${d.toFixed(1)} ruled out`);
  if (want === 'water' && c.excluded !== 'water') wrongW.push(`${c.id} → ${c.excluded}`);
  if (want === null && c.excluded) wrongW.push(`${c.id} ${c.excluded} with nothing there`);
}
ok('every place within 10 m of a building — outline, point or OpenStreetMap way — is ruled out, and none further',
   wrongB.length === 0 && A.cells.some(c => c.excluded === 'building'), wrongB.slice(0, 6).join(' · '));
ok('every place in water is ruled out, and nothing else is', wrongW.length === 0 && A.cells.some(c => c.excluded === 'water'),
   wrongW.slice(0, 6).join(' · '));

// ── 4. open sky ──────────────────────────────────────────────────────────────
console.log('\nOpen sky');

const under = A.cells.filter(c => treeEdge(c.x, c.y) < -8);
ok('under the stand is WMO class 5, under the canopy, all of the ground within 20 m covered',
   under.length > 0 && under.every(c => c.under && c.wmo === 5)
   && under.filter(c => treeEdge(c.x, c.y) < -28).every(c => c.coverFrac === 1),
   under.filter(c => !(c.under && c.wmo === 5)).map(c => c.id).join(' '));
const open = A.cells.filter(c => treeEdge(c.x, c.y) > OBST_R + 8 && bldDist(c.x, c.y) > OBST_R + 8);
ok('well away from every tree and roof is class 1, nothing above the rim, nothing covering the ground',
   open.length > 0 && open.every(c => c.wmo === 1 && c.angle === 0 && c.coverFrac === 0),
   open.filter(c => c.wmo !== 1).map(c => `${c.id}:${c.wmo}`).join(' '));
// Beside the stand: the steepest tree is the stand's edge, d metres off — no
// nearer than that, and no further than the 10 m lattice's next row in.
const beside = A.cells.filter(c => { const d = treeEdge(c.x, c.y); return d > 12 && d < 45 && bldDist(c.x, c.y) > OBST_R + 8; });
const bad = beside.filter(c => {
  const d = treeEdge(c.x, c.y), lo = Math.atan((TREES.h - RIM) / (d + 11)) * 180 / Math.PI;
  const hi = Math.atan((TREES.h - RIM) / Math.max(5, d)) * 180 / Math.PI;
  return !(c.angle >= lo - 1e-6 && c.angle <= hi + 1e-6) || c.under;
});
ok('beside the stand, the angle is the one a 15 m tree that far off makes', beside.length > 5 && bad.length === 0,
   bad.slice(0, 5).map(c => `${c.id} d=${treeEdge(c.x, c.y).toFixed(1)} a=${c.angle.toFixed(1)}`).join(' · '));
const classOf = a => (a <= 14 ? 1 : a <= 26.6 ? 2 : a <= 45 ? 3 : a <= 63.4 ? 4 : 5);
ok('…and its WMO class is the class of that angle', beside.every(c => c.wmo === classOf(c.angle)));

// ── 5. the margin ────────────────────────────────────────────────────────────
console.log('\nThe margin');

const cross = await page.evaluate(async () => {
  const r = MapRelocate.results()[0], hubs = MapRelocate.hubs();
  const st = state.data.stations.find(s => s.id === MapRelocate.station().id);
  const hub = state.data.stations.find(s => s.id === hubs[0].id);
  const sysA = rmSystemOf(st), sysB = rmSystemOf(hub);
  const aglA = stationAntenna(st, sysA).agl, aglB = stationAntenna(hub, sysB).agl;
  const f = hub.repeater && hub.repeater.rx_mhz > 0 ? hub.repeater.rx_mhz : PATH_DEFAULT_MHZ;
  const one = (an, a, b) => wattsToDbm(a.tx_power_w) + a.antenna_gain_dbi - a.line_loss_db - an.pathLoss_db
                           + b.antenna_gain_dbi - b.line_loss_db - b.rx_threshold_dbm;
  const both = an => Math.min(one(an, sysA, sysB), one(an, sysB, sysA));
  // The screen: 30 m samples, bare ground, the place on the tiles.
  const dKm = acmaHaversineKm(r.lat, r.lon, hub.lat, hub.lon);
  const n = Math.max(64, Math.min(1024, Math.ceil(dKm * 1000 / 30) + 1));
  const prof = await Terrain.profile([[r.lat, r.lon], [hub.lat, hub.lon]], n);
  const an = pathAnalyse(prof, { elevA: null, elevB: hub.elevation_ahd, aglA, aglB, freqMhz: f });
  // The card: pathGround at 256.
  const g = await pathGround({ lat: r.lat, lon: r.lon, elev: null, agl: aglA, mast: false },
                             { lat: hub.lat, lon: hub.lon, elev: hub.elevation_ahd, agl: aglB, mast: stationIsMast(hub) },
                             { samples: 256, freqMhz: f });
  const an2 = pathAnalyse(g.prof, { elevA: g.ends.a.elev, elevB: g.ends.b.elev, aglA, aglB, freqMhz: f });
  return { screened: r.grid[0].margin, screenWant: both(an), fine: r.fine[0] && r.fine[0].margin, fineWant: both(an2),
           src: r.fine[0] && r.fine[0].src };
});
ok('a screened figure is pathAnalyse over the same 30 m path, both directions, the worse', cross.screened === cross.screenWant,
   JSON.stringify(cross));
ok('a result\'s quoted figure is the link budget card\'s own arithmetic, to the last bit',
   cross.src === 'card' && cross.fine === cross.fineWant, JSON.stringify(cross));
ok('where it is now is checked the card\'s way too', A.now && A.now.fine.every(f => f && f.src === 'card'), JSON.stringify(A.now && A.now.fine));

// ── 6. the ranking ───────────────────────────────────────────────────────────
console.log('\nThe ranking');

const RS = A.results;
ok('five places by default, ranked 1..5', RS.length === 5 && RS.every((r, i) => r.rank === i + 1), `${RS.length}`);
ok('a place every repeater hears at "ok" ranks above one some repeater does not, then best first',
   RS.every((r, i) => i === 0 || (RS[i - 1].allOk > r.allOk) || (RS[i - 1].allOk === r.allOk && RS[i - 1].score >= r.score - 1e-9)),
   RS.map(r => `${r.allOk ? '✓' : '✗'}${r.score.toFixed(1)}`).join(' → '));
ok('none of them is ruled out, none is where it is now, every one inside the circle',
   RS.every(r => !r.excluded && r.dM > 0 && r.dM <= R + 1e-6));
let closest = Infinity;
for (let i = 0; i < RS.length; i++) for (let j = i + 1; j < RS.length; j++) {
  closest = Math.min(closest, Math.hypot((RS[i].lat - RS[j].lat) * k.lat, (RS[i].lon - RS[j].lon) * k.lon));
}
ok('no two are the same patch — at least a quarter of the radius apart', closest >= Math.max(2 * A.step, R / 4) - 0.5,
   `closest ${closest.toFixed(1)} m`);
ok('each says what it scored on each count', RS.every(r => [r.F, r.S, r.C, r.N].every(v => v >= 0 && v <= 1)));

// A weight is a re-rank. The screen is kept — not one screened figure moves —
// and what is fetched is the new finalists' card paths and nothing else.
await page.evaluate(() => {
  window.__profiles = 0;
  const p = Terrain.profile;
  Terrain.__orig = p;
  Terrain.profile = function (...a) { window.__profiles++; return p.apply(this, a); };
});
for (const [key, v] of [['wFade', 0], ['wSky', 0], ['wClear', 0], ['wNear', 5]]) {
  await page.locator(`.reloc-panel input[aria-label="${{ wFade: 'Fade margin', wSky: 'Open sky', wClear: 'Clear ground', wNear: 'Close by' }[key]} weight"]`)
    .evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  await page.waitForFunction(() => MapRelocate.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
}
const B = await page.evaluate(() => ({ cells: MapRelocate.cells(), results: MapRelocate.results(), profiles: window.__profiles }));
ok('moving the weights re-ranks with the screen kept, every screened figure as it was',
   B.cells.length === A.cells.length && B.cells.every((c, i) => JSON.stringify(c.grid) === JSON.stringify(A.cells[i].grid)));
ok('…and asks for no more paths than the new finalists\' to their repeaters',
   B.profiles <= 4 * (5 + 3) * A.hubs.length, `${B.profiles} profile(s)`);
const BR = B.results;
ok('with only "close by" weighed, the nearer always ranks first among places heard alike',
   BR.every((r, i) => i === 0 || BR[i - 1].allOk > r.allOk || r.dM >= BR[i - 1].dM - 1e-6), BR.map(r => `${r.allOk ? '✓' : '✗'}${Math.round(r.dM)}`).join(' → '));

// Back to the defaults for the rest of the run.
await page.evaluate(() => {
  Terrain.profile = Terrain.__orig;
  for (const [k, v] of [['wFade', 5], ['wSky', 2], ['wClear', 2], ['wNear', 1]]) MapRelocate.set(k, v);
});
await page.waitForFunction(() => MapRelocate.status().kind === 'done', null, { timeout: RUN_TIMEOUT });

// The clearance re-reads the ground already in hand.
const tilesBefore = tilesAsked, osmBefore = osmAsked, qldBefore = qldAsked.length;
await page.fill('#reloc-clearM', '25');
await page.locator('#reloc-clearM').dispatchEvent('change');
await page.waitForFunction(() => MapRelocate.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
const C25 = await page.evaluate(() => MapRelocate.cells());
const wrong25 = C25.filter(c => !c.now).filter(c => {
  const d = bldDist(c.x, c.y);
  return (d < 24.7 && c.excluded !== 'building') || (d > 25.3 && c.excluded === 'building');
});
ok('a wider clearance rules out the places it now reaches, with nothing fetched',
   wrong25.length === 0 && C25.filter(c => c.excluded === 'building').length > A.cells.filter(c => c.excluded === 'building').length
   && osmAsked === osmBefore && qldAsked.length === qldBefore,
   wrong25.slice(0, 5).map(c => c.id).join(' '));
await page.fill('#reloc-clearM', '10');
await page.locator('#reloc-clearM').dispatchEvent('change');
await page.waitForFunction(() => MapRelocate.status().kind === 'done', null, { timeout: RUN_TIMEOUT });

// ── 7. the map ───────────────────────────────────────────────────────────────
console.log('\nThe map');

const washOf = () => page.evaluate(() => {
  let url = null, n = 0, outlines = 0;
  state.map.eachLayer(l => {
    if (l instanceof L.ImageOverlay && l.options.pane === 'mnRelocWash') { url = l._url; n++; }
    if (l instanceof L.Polygon && l.options.pane === 'mnRelocLines') outlines++;
  });
  return { url, n, outlines };
});
const w1 = await washOf();
ok('the ground is painted, once, in a pane of its own', w1.n === 1 && /^data:image\/png/.test(w1.url || ''));
ok('…with the outlined buildings drawn over it', w1.outlines >= 2, `${w1.outlines} outline(s)`);
const tilesAtPaint = tilesAsked;
await page.selectOption('#reloc-paint', 'margin');
const w2 = await washOf();
await page.selectOption('#reloc-paint', 'change');
const w3 = await washOf();
ok('each colouring paints the ground again with no terrain asked for',
   w2.n === 1 && w3.n === 1 && w2.url !== w1.url && w3.url !== w2.url && tilesAsked === tilesAtPaint);
const keyText = await page.evaluate(() => document.getElementById('reloc-key')?.textContent.replace(/\s+/g, ' ') || '');
ok('…and the key says what the colours mean in that mode', /within a decibel/.test(keyText) && /ruled out/.test(keyText), keyText);
await page.selectOption('#reloc-paint', 'score');

// A pointer on the ground: a place well clear of everything, by its pixel.
const target = A.cells.find(c => !c.excluded && !c.now && treeEdge(c.x, c.y) > 100 && bldDist(c.x, c.y) > 100 && c.dM > 150);
const pt = await page.evaluate(c => {
  state.map.setView([c.lat, c.lon], 16, { animate: false });
  const p = state.map.latLngToContainerPoint([c.lat, c.lon]);
  const r = state.map.getContainer().getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, target);
await page.waitForTimeout(300);
await page.mouse.move(pt.x - 3, pt.y - 3);
await page.mouse.move(pt.x, pt.y);
await page.waitForTimeout(300);
const tipText = await page.evaluate(() => document.querySelector('.leaflet-tooltip.reloc-tip')?.textContent || '');
ok('pointing at the coloured ground shows that square\'s figures', /Score \d+/.test(tipText) && /Worst/.test(tipText), tipText);

const r2 = A.results[1];
await page.evaluate(r => state.map.setView([r.lat, r.lon], 16, { animate: false }), r2);
await page.waitForTimeout(400);
const pin2 = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.leaflet-pane .mn-site')].find(x => x.closest('.leaflet-mnReloc-pane')
    && x.querySelector('.mn-site-mark')?.textContent === '2');
  if (!el) return null;
  const r = el.querySelector('.mn-site-mark').getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, mine: !!(hit && el.contains(hit)), hit: hit ? `${hit.tagName}.${hit.className}` : null };
});
ok('new site #2\'s pin is what the pointer lands on', !!pin2 && pin2.mine, JSON.stringify(pin2));
if (pin2) { await page.mouse.click(pin2.x, pin2.y); await page.waitForTimeout(300); }
const sel = await page.evaluate(() => ({
  rank: MapRelocate.selectedRank(),
  popup: document.querySelector('.leaflet-popup .mn-site-pop h4')?.textContent || '',
  row: document.querySelector('.reloc-panel .sites-result.is-on .sites-rank')?.textContent || '',
  links: (() => { let n = 0; state.map.eachLayer(l => { if (l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.pane === 'mnRelocLines') n++; }); return n; })(),
}));
ok('…and a click on it picks it: its callout, its row, its paths to the repeaters',
   sel.rank === 2 && /^#2 new site/.test(sel.popup) && sel.row === '2' && sel.links === A.hubs.length, JSON.stringify(sel));
await page.evaluate(() => state.map.closePopup());

const legend = await page.evaluate(() => document.getElementById('map-legend')?.textContent.replace(/\s+/g, ' ') || '');
ok('the legend says what the ground and the pins are', /Station relocation/.test(legend), legend.slice(0, 200));

const csv = await page.evaluate(() => MapRelocate.csvText());
const lines = csv.trim().split('\n');
const head = lines.find(l => l.startsWith('rank,'));
ok('Save CSV writes every place screened, one row each, under named columns',
   lines.filter(l => !l.startsWith('#') && !l.startsWith('rank,')).length === A.cells.length
   && /worst_margin_db/.test(head) && /wmo_class/.test(head) && /nearest_building_m/.test(head) && /^# Flood-Net/.test(lines[0]),
   head);

// ── 8. a source down ─────────────────────────────────────────────────────────
console.log('\nA source down');

osmMode = 'down';
const D = await run();
ok('Overpass refusing is said in words, not read as "no buildings"',
   D.status.kind === 'done' && /OpenStreetMap buildings could not be read/.test(D.text), D.text.slice(0, 400));
ok('…and the State\'s buildings still rule their places out, the barn\'s no longer',
   D.cells.some(c => c.excluded === 'building' && distSquare(SHED, c.x, c.y) < CLEAR)
   && !D.cells.some(c => c.excluded === 'building' && distSquare(BARN, c.x, c.y) < CLEAR
                         && distSquare(SHED, c.x, c.y) >= CLEAR && Math.hypot(c.x - HOUSE.x, c.y - HOUSE.y) - HOUSE.r >= CLEAR));
osmMode = 'ok';

// ── 9. reset ─────────────────────────────────────────────────────────────────
console.log('\nReset');

await page.evaluate(() => document.querySelector('.mn-map-reset')?.click());
if (await asking(page)) await answer(page, true);
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  let ours = 0;
  state.map.eachLayer(l => { if (!(l instanceof L.Renderer) && l.options && /^mnReloc/.test(l.options.pane || '')) ours++; });
  return { st: MapRelocate.station(), results: MapRelocate.results().length, ours,
           legend: /Station relocation/.test(document.getElementById('map-legend')?.textContent || '') };
});
ok('↺ takes the station, the answer and everything drawn for them away',
   !after.st && after.results === 0 && after.ours === 0 && !after.legend, JSON.stringify(after));

ok('nothing threw', errors.length === 0, errors.join('\n'));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
