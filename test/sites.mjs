// The repeater site finder (map-sites.js), held to what it claims.
//
// Everything runs against ground this check makes — terrainkit.mjs's hilly
// world, hills every eight kilometres from a closed form (lib/terrarium.mjs) —
// so "is that a summit" and "is that the card's fade margin" are answered by
// arithmetic here rather than by whatever SRTM says about Queensland today. The
// land cover is seeded (trees, everywhere, so the refined figures have to
// differ from the screened ones) and the Queensland cadastre is a stub that
// puts a road parcel 70 m east of whatever it is asked about.
//
// What is under test, and the defect each block would catch:
//
//   The paste     exact before loose. A list of station numbers pasted in to
//                 say "these sites" enrolling every station that merely shares
//                 a digit run — or a coordinate cut in two at its comma — is a
//                 search run for the wrong network, and it looks right.
//   The answer    peaks, not maxima; spaced, not five points on one ridge; and
//                 the margin quoted for a result is the link budget card's
//                 arithmetic over 256 samples with the land cover on them,
//                 not the screening pass's bare-ground figure.
//   The weights   a re-rank, not a re-run: the pool survives a slider, and a
//                 slider that says "only height matters" puts the highest
//                 summit first.
//   The road      asked for the finalists only, only while its weight is above
//                 nought, and a cadastre that fails is said to have failed
//                 rather than read as "no road here".
//   The circle    Draw & measure's own circle, armed from this panel with a
//                 real pointer, lands its stations in the set and disarms.
//   Reset         takes all of it off the map.
//
//   npm run sites          (or: node sites.mjs)
//   npm run sites -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng, hillyHeightAt } from './lib/terrarium.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 90_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

// ── the cadastre ─────────────────────────────────────────────────────────────
// Answers MapRoads.near()'s small-box queries with one road parcel: a strip
// 20 m wide running north–south, 70 m east of the middle of the box — which is
// the point asked about, because near() builds its box symmetric round it.
// `mode` switches it to a 500 for the failure block.
let roadMode = 'near';
const roadAsked = [];
const QLD_CADASTRE_ROUTE = /spatial-gis\.information\.qld\.gov\.au\/.*LandParcelPropertyFramework\//;
const LIVE_LAYERS = { layers: [{ id: 4, name: 'Cadastral parcels' }] };
function roadStrip(w, s, e, n) {
  const lat = (s + n) / 2, lon = (w + e) / 2;
  const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  const x0 = lon + 70 / mPerDegLon, x1 = lon + 90 / mPerDegLon;
  return {
    type: 'Feature',
    properties: { feat_name: 'Test Road', locality: 'Testville', shire_name: 'Testshire',
                  lotplan: '', parcel_typ: 'Road Type Parcel' },
    geometry: { type: 'Polygon', coordinates: [[[x0, s], [x1, s], [x1, n], [x0, n], [x0, s]]] },
  };
}

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png',
                         body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
await page.route(QLD_CADASTRE_ROUTE, route => {
  const url = new URL(route.request().url());
  if (!/\/query$/.test(url.pathname)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE_LAYERS) });
  }
  const [w, s, e, n] = (url.searchParams.get('geometry') || '').split(',').map(Number);
  // Only near()'s boxes — a few hundred metres across. The layer's own view
  // queries are rounded to 0.02° and never this small.
  if (!(e - w < 0.015)) {
    return route.fulfill({ status: 200, contentType: 'application/json',
                           body: JSON.stringify({ type: 'FeatureCollection', features: [] }) });
  }
  roadAsked.push({ w, s, e, n });
  if (roadMode === 'down') return route.fulfill({ status: 500, body: 'down' });
  return route.fulfill({ status: 200, contentType: 'application/json',
                         body: JSON.stringify({ type: 'FeatureCollection', features: [roadStrip(w, s, e, n)] }) });
});
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => {
  toggleStationsSplit(false);
  // Trees round both ends and open rangeland between, so a refined figure is
  // charged P.2108's terminal clutter — which the screening pass never is —
  // without a 15 m canopy standing on every hilltop and cutting every path.
  LandCover.seed(lat => lat.map((_, i) => (i === 0 || i === lat.length - 1 ? 2 : 11)));
  MapChrome.setPinned('sites', true);
});
await page.waitForTimeout(400);

const runSites = async () => {
  await page.locator('#sites-run').click();
  await page.waitForFunction(() => ['done', 'blocked'].includes(MapSites.status().kind),
    null, { timeout: RUN_TIMEOUT });
  return page.evaluate(() => ({ status: MapSites.status(), results: MapSites.results(),
                                pool: MapSites.pool(), area: MapSites.area(), targets: MapSites.targets() }));
};
const settle = () => page.waitForFunction(() => MapSites.status().kind !== 'running',
  null, { timeout: RUN_TIMEOUT });

// ── 0. the panel ─────────────────────────────────────────────────────────────
console.log('\nThe panel');

const panel = await page.evaluate(() => {
  const wrap = document.querySelector('.mn-mapctl[data-panel="sites"]');
  const polar = document.querySelector('.mn-mapctl[data-panel="polar"]');
  const here = document.querySelector('.mn-map-here');
  const order = el => [...document.querySelectorAll('.leaflet-control-container .mn-mapctl, .leaflet-control-container .mn-map-here')].indexOf(el);
  return {
    present: !!wrap, title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    afterPolar: !!(wrap && polar) && order(wrap) > order(polar),
    beforeHere: !!(wrap && here) && order(wrap) < order(here),
    runDisabled: document.getElementById('sites-run')?.disabled,
    status: document.getElementById('sites-status')?.textContent || '',
  };
});
ok('a 🗼 Repeater site finder panel sits in the map corner', panel.present && panel.title === 'Repeater site finder',
   JSON.stringify(panel));
ok('…in the tools group, after the polar plot and before What is here',
   panel.afterPolar && panel.beforeHere, JSON.stringify(panel));
ok('Find sites is disabled with nothing to serve, and the panel says what is missing',
   panel.runDisabled === true && /Add the sites/.test(panel.status), panel.status);

// ── 1. the paste ─────────────────────────────────────────────────────────────
console.log('\nThe paste');

// A cluster of real stations: the first in file order with five neighbours
// inside 10 km, each with a station number and a position.
const cluster = await page.evaluate(() => {
  const st = state.data.stations.filter(s => s.lat != null && s.lon != null && s.station_number);
  for (const s0 of st) {
    const near = st.filter(s => s !== s0 && acmaHaversineKm(s0.lat, s0.lon, s.lat, s.lon) < 10);
    const ids = near.filter(s => stationAlertIds(s).length);
    if (near.length >= 5 && ids.length) {
      const pick = [s0, ...near.filter(s => s !== ids[0]).slice(0, 4), ids[0]];
      const lat = pick.reduce((a, s) => a + s.lat, 0) / pick.length;
      const lon = pick.reduce((a, s) => a + s.lon, 0) / pick.length;
      return {
        stations: pick.map(s => ({ id: s.id, name: s.name, number: s.station_number, lat: s.lat, lon: s.lon,
                                   alert: stationAlertIds(s)[0] })),
        point: destPoint(lat, lon, 45, 3),
      };
    }
  }
  return null;
});
ok('the file holds a cluster to test with', !!cluster, JSON.stringify(cluster && cluster.stations.map(s => s.name)));

const S = cluster.stations;
const pointText = `${cluster.point[0].toFixed(5)}, ${cluster.point[1].toFixed(5)}`;
const pasted = [
  S[0].number,
  `${S[1].number}, ${S[2].number}`,       // a CSV row
  S[3].name.toUpperCase(),                 // a name, in the wrong case
  String(S[5].alert),                      // an ALERT address
  pointText,                               // a proposed site — must not be cut at its comma
  'zzqq-not-a-site',
  'creek',                                 // hundreds of them
].join('\n');
await page.locator('#sites-paste').fill(pasted);
await page.locator('.sites-panel button', { hasText: 'Add the list' }).click();
const afterPaste = await page.evaluate(() => ({
  targets: MapSites.targets(),
  note: document.getElementById('sites-paste-note')?.textContent || '',
  box: document.getElementById('sites-paste')?.value || '',
  rings: (() => { let n = 0; state.map.eachLayer(l => {
    if (l.options && l.options.pane === 'mnSitesLines' && l instanceof L.CircleMarker && !(l instanceof L.Circle)) n++;
  }); return n; })(),
}));
const want = [S[0], S[1], S[2], S[3], S[5]].map(s => s.id);
const gotIds = afterPaste.targets.filter(t => t.kind === 'station').map(t => t.sid);
ok('station numbers, a CSV row, a name in any case and an ALERT address each find their one station',
   want.every(id => gotIds.includes(id)) && gotIds.length === want.length,
   `${gotIds.length} station(s): ${JSON.stringify(afterPaste.targets.map(t => t.name))}`);
const pt = afterPaste.targets.find(t => t.kind === 'point');
ok('a coordinate on its own line is a proposed site, not two numbers',
   !!pt && Math.abs(pt.lat - cluster.point[0]) < 1e-4 && Math.abs(pt.lon - cluster.point[1]) < 1e-4,
   JSON.stringify(pt));
ok('what matched nothing is named', /not found: zzqq-not-a-site/.test(afterPaste.note), afterPaste.note);
ok('a word that matches many is a question back, not a hundred sites',
   /“creek” matches \d+/.test(afterPaste.note) && afterPaste.targets.length === 6, afterPaste.note);
ok('…and both are left in the box to be corrected, the rest cleared out of it',
   afterPaste.box.split('\n').sort().join('|') === 'creek|zzqq-not-a-site', JSON.stringify(afterPaste.box));
ok('every site is ringed on the map', afterPaste.rings === 6, `${afterPaste.rings} ring(s)`);

await page.evaluate(id => { state.mapSelection.clear(); addToMapSelection([id]); MapSites.clear(); }, S[4].id);
// clear() took the paste's six away; put them back, then add the selection.
await page.locator('#sites-paste').fill(pasted);
await page.locator('.sites-panel button', { hasText: 'Add the list' }).click();
await page.evaluate(() => MapSites.drawingChanged());   // the selection count is drawn with the shapes row
await page.locator('.sites-panel button', { hasText: 'Add the map selection' }).click();
const withSel = await page.evaluate(() => MapSites.targets().map(t => t.sid));
ok('Add the map selection puts the picked stations in the set', withSel.includes(S[4].id) && withSel.length === 7,
   `${withSel.length} site(s)`);

// ── 2. the answer ────────────────────────────────────────────────────────────
console.log('\nThe answer');

// A 20 m mast, typed into the panel the way an operator would: at the network's
// own 4 m every path in a world of 380 m hills is cut, and a ranking on line of
// sight over paths that are all obstructed would pass for the wrong reason.
await page.locator('#sites-agl').fill('20');
await page.locator('#sites-agl').dispatchEvent('change');
ok('the mast height is taken from the panel',
   await page.evaluate(() => JSON.parse(localStorage.getItem('mn-sites-v1') || '{}').agl === 20));

const run1 = await runSites();
const R = run1.results;
ok('the run finishes', run1.status.kind === 'done', JSON.stringify(run1.status));
ok('five sites by default, ranked 1..5', R.length === 5 && R.every((r, i) => r.rank === i + 1),
   `${R.length} result(s)`);
ok('best first', R.every((r, i) => i === 0 || r.score <= R[i - 1].score + 1e-9),
   R.map(r => r.score.toFixed(1)).join(' → '));
ok('the search area holds every site',
   run1.targets.every(t => acmaDist(run1.area, t) <= run1.area.rKm + 1e-6),
   `${run1.area.rKm.toFixed(1)} km`);
ok('…and every result is inside it', R.every(r => acmaDist(run1.area, r) <= run1.area.rKm + 1e-6));

// Peaks, not maxima: every candidate taken off the ground is higher than the
// world 600 m from it in eight directions. At hills every ~7 km on the ground
// that is a drop of ~70 m from a summit, and of nothing from a hillside.
const notSummits = R.filter(r => r.src === 'ground').filter(r => {
  const h = hillyHeightAt(r.lat, r.lon);
  for (let a = 0; a < 360; a += 45) {
    const p = dest(r.lat, r.lon, a, 0.6);
    if (hillyHeightAt(p[0], p[1]) > h) return true;
  }
  return false;
});
ok('every result is a summit of the world the tiles were made from', notSummits.length === 0,
   notSummits.map(r => `${r.lat.toFixed(4)},${r.lon.toFixed(4)}`).join(' '));

const spacing = Math.max(0.5, run1.area.rKm * 2 * 0.06);
let closest = Infinity;
for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) closest = Math.min(closest, acmaDist(R[i], R[j]));
ok('no two results are the same hill', closest >= spacing - 1e-6,
   `closest pair ${closest.toFixed(2)} km, spacing ${spacing.toFixed(2)} km`);

ok('every figure for a result is the refined one, with the land cover on',
   R.every(r => r.cover === run1.targets.length && !r.bare && !r.grid && !r.failed),
   R.map(r => `${r.cover}/${r.bare}/${r.grid}/${r.failed}`).join(' '));

// The card's arithmetic, done here again from its parts: the same profile,
// the same seeded cover, pathAnalyse, and both ends' radios as filed. The
// figure the panel quotes has to be this figure, to the last bit.
const cross = await page.evaluate(async () => {
  const r = MapSites.results()[0];
  const ts = MapSites.targets();
  const k = ts.findIndex(t => t.kind === 'station');
  const t = ts[k], st = state.data.stations.find(s => s.id === t.sid);
  const prof = await Terrain.profile([[r.lat, r.lon], [t.lat, t.lon]], 256);
  const cov = await LandCover.sample(prof.lat, prof.lon);
  const rep = state.data.rm_systems[0], fld = rmSystemOf(st);
  const an = pathAnalyse(prof, {
    elevA: null, elevB: st.elevation_ahd, freqMhz: PATH_DEFAULT_MHZ,
    aglA: 20, aglB: fld.antenna_height_m,
    cover: cov.cls, canopy: cov.canopyOk ? cov.canopy : null,
  });
  const one = (a, b) => wattsToDbm(a.tx_power_w) + a.antenna_gain_dbi - a.line_loss_db
    - an.pathLoss_db + b.antenna_gain_dbi - b.line_loss_db - b.rx_threshold_dbm;
  return { quoted: r.figs[k].margin, verdict: r.figs[k].verdict, mine: Math.min(one(rep, fld), one(fld, rep)),
           mineVerdict: an.verdict, clutter: an.clutterA_db + an.clutterB_db };
});
ok('the margin quoted is the link budget card\'s arithmetic over the same path',
   cross.quoted != null && Math.abs(cross.quoted - cross.mine) < 1e-9 && cross.verdict === cross.mineVerdict,
   JSON.stringify(cross));
ok('…with the trees in it — a terminal-clutter term is being charged', cross.clutter > 5,
   `${cross.clutter.toFixed(1)} dB`);

const drawn = await page.evaluate(() => {
  let lines = 0;
  state.map.eachLayer(l => {
    if (l.options && l.options.pane === 'mnSitesLines' && l instanceof L.Polyline && !(l instanceof L.Polygon)) lines++;
  });
  return { pins: document.querySelectorAll('.mn-site').length, on: document.querySelectorAll('.mn-site.is-on').length,
           lines, legend: document.getElementById('map-legend')?.textContent || '',
           selected: MapSites.selectedRank(), rows: document.querySelectorAll('.sites-table tbody tr').length };
});
ok('a pin per result, the first one picked', drawn.pins === 5 && drawn.on === 1 && drawn.selected === 1,
   JSON.stringify(drawn));
ok('the picked result draws a path to every site, and lists every site', drawn.lines === 7 && drawn.rows === 7,
   `${drawn.lines} line(s), ${drawn.rows} row(s)`);
ok('the legend names what is drawn', /Repeater site candidates/.test(drawn.legend));

const road = R.map(r => r.road);
ok('the cadastre was asked about the finalists, and only them',
   roadAsked.length >= R.length && roadAsked.length <= R.length + 3, `${roadAsked.length} request(s)`);
ok('each result knows the road reserve 70 m east of it, by name',
   road.every(x => x && x.ok && !x.inside && Math.abs(x.distM - 70) < 3 && /Test Road — Testville · Testshire/.test(x.label)),
   JSON.stringify(road.map(x => x && [x.ok, x.distM && Math.round(x.distM), x.label])));
ok('…and scores it as near, not on', R.every(r => Math.abs(r.R - (1 - 70 / 250)) < 0.02),
   R.map(r => r.R.toFixed(2)).join(' '));

const csv = await page.evaluate(() => MapSites.csvText());
const csvRows = csv.trim().split('\n').filter(l => !l.startsWith('#'));
ok('the CSV carries every result against every site', csvRows.length === 1 + 5 * 7 && /^rank,site_lat/.test(csvRows[0]),
   `${csvRows.length} row(s)`);

// ── 3. the weights ───────────────────────────────────────────────────────────
console.log('\nThe weights');

const poolIds = run1.pool.map(c => c.id).join();
const tallest = Math.max(...run1.pool.map(c => c.ground));
await page.evaluate(() => {
  MapSites.set('wLos', 0); MapSites.set('wFade', 0); MapSites.set('wRoad', 0); MapSites.set('wElev', 5);
});
await settle();
const byH = await page.evaluate(() => ({ r: MapSites.results(), pool: MapSites.pool() }));
ok('a weight is a re-rank: the screened pool is the same pool', byH.pool.map(c => c.id).join() === poolIds);
ok('height alone puts the highest summit first', byH.r[0].ground === tallest,
   `${byH.r[0].ground} vs ${tallest}`);
ok('…and the rest in order of height', byH.r.every((r, i) => i === 0 || r.ground <= byH.r[i - 1].ground),
   byH.r.map(r => Math.round(r.ground)).join(' → '));

await page.evaluate(() => { MapSites.set('wElev', 0); MapSites.set('wLos', 5); });
await settle();
const byL = await page.evaluate(() => MapSites.results());
ok('line of sight alone ranks on line of sight', byL.every((r, i) => i === 0 || r.L <= byL[i - 1].L + 1e-9),
   byL.map(r => r.L.toFixed(2)).join(' → '));
ok('…over a set where line of sight actually differs, so the order means something',
   byL[0].L > 0 && byL[0].L > byL[byL.length - 1].L, byL.map(r => r.L.toFixed(2)).join(' → '));

await page.evaluate(() => MapSites.set('count', 3));
await settle();
ok('three when three are asked for', (await page.evaluate(() => MapSites.results().length)) === 3);

// ── 4. the road, when it fails and when it is not wanted ─────────────────────
console.log('\nThe road reserve');

await page.evaluate(() => { MapSites.set('wRoad', 3); MapSites.set('count', 5); });
roadMode = 'down';
const asked0 = roadAsked.length;
await page.evaluate(() => MapSites.set('marginKm', 4));   // a new area: a new run, new finalists
const run2 = await runSites();
ok('a cadastre that fails leaves every result standing', run2.status.kind === 'done' && run2.results.length === 5,
   JSON.stringify(run2.status));
ok('…says it could not be checked, and gives no bonus for it',
   run2.results.every(r => r.road && !r.road.ok && r.R === 0)
   && /could not be checked/.test(await page.evaluate(() => document.querySelector('.sites-results')?.textContent || '')),
   JSON.stringify(run2.results.map(r => r.road)));
ok('…having actually asked', roadAsked.length > asked0);

roadMode = 'near';
await page.evaluate(() => { MapSites.set('wRoad', 0); MapSites.set('marginKm', 5); });
const asked1 = roadAsked.length;
await runSites();
ok('with its weight at nought, the cadastre is not asked at all', roadAsked.length === asked1,
   `${roadAsked.length - asked1} request(s)`);

// Anything that changes what would be computed takes the answer with it.
await page.evaluate(() => MapSites.set('agl', 12));
const gone = await page.evaluate(() => ({ n: MapSites.results().length, pins: document.querySelectorAll('.mn-site').length }));
ok('changing the mast height takes the answer off the map', gone.n === 0 && gone.pins === 0, JSON.stringify(gone));
await page.evaluate(() => { MapSites.set('agl', ''); MapSites.set('wRoad', 1); MapSites.set('wElev', 2);
                            MapSites.set('wLos', 3); MapSites.set('wFade', 4); });

// ── 5. the circle ────────────────────────────────────────────────────────────
console.log('\nThe circle');

await page.evaluate(c => {
  MapSites.clearTargets();
  state.draw.shapes = []; state.draw.selectedId = null; MapDraw.render(); MapDraw.rerenderPanel();
  state.map.setView([c.lat, c.lon], 12, { animate: false });
}, S[0]);
await page.waitForTimeout(400);
const box = await page.evaluate(() => {
  const el = document.getElementById('leaflet-map');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { left: r.left, top: Math.max(r.top, 0), width: r.width,
           height: Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0) };
});
// The circle starts on the cluster's first station — snapping lands it there —
// and runs 180 px out, which at zoom 12 takes in several of its neighbours.
const C0 = await page.evaluate(([b, c]) => {
  const p = state.map.latLngToContainerPoint([c.lat, c.lon]);
  const r = document.getElementById('leaflet-map').getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [box, S[0]]);
await page.locator('#sites-circle').click();
const armed = await page.evaluate(() => ({ tool: state.draw.tool, label: document.getElementById('sites-circle')?.textContent || '' }));
ok('Draw a circle arms Draw & measure\'s own circle tool', armed.tool === 'circle' && /click the map/.test(armed.label),
   JSON.stringify(armed));
await page.mouse.click(C0.x, C0.y);
await page.waitForTimeout(150);
await page.mouse.click(C0.x + 180, C0.y);
await page.waitForTimeout(300);
const circ = await page.evaluate(() => {
  const sh = MapDraw.exportShapes().filter(s => s.kind === 'circle').pop();
  return { tool: state.draw.tool, ids: sh ? sh.stationIds : null, targets: MapSites.targets().map(t => t.sid),
           label: document.getElementById('sites-circle')?.textContent || '' };
});
ok('two clicks on the map draw the circle and put its stations in the set',
   !!circ.ids && circ.ids.length > 1 && circ.ids.length === circ.targets.length
   && circ.ids.every(id => circ.targets.includes(id)),
   `${circ.ids && circ.ids.length} inside, ${circ.targets.length} in the set`);
ok('…and the tool disarms itself', circ.tool === '' && /Draw a circle/.test(circ.label), JSON.stringify(circ));
const shapeRow = await page.evaluate(() => document.querySelector('.sites-shape')?.textContent || '');
ok('the drawn circle is offered again as a source of stations', /Add the \d+ inside ◯/.test(shapeRow), shapeRow.trim());

// ── 6. reset ─────────────────────────────────────────────────────────────────
console.log('\nReset');

await runSites();
await page.evaluate(() => document.querySelector('.mn-map-reset')?.click());
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  let ours = 0;
  // Leaflet's own canvas renderer for the lines' pane is a layer too, and stays
  // with the pane once made — that is the library's furniture, not a drawing.
  state.map.eachLayer(l => {
    if (!(l instanceof L.Renderer) && l.options && /^mnSites/.test(l.options.pane || '')) ours++;
  });
  return { targets: MapSites.targets().length, results: MapSites.results().length,
           pins: document.querySelectorAll('.mn-site').length, ours,
           legend: /Repeater site candidates/.test(document.getElementById('map-legend')?.textContent || '') };
});
ok('↺ takes the sites, the answer and everything drawn for them away',
   after.targets === 0 && after.results === 0 && after.pins === 0 && after.ours === 0 && !after.legend,
   JSON.stringify(after));

ok('no page errors', errors.length === 0, errors.join('\n'));

await browser.close();
await server.close();

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);

// ── geodesy, the app's own formulas ──────────────────────────────────────────
function acmaDist(a, b) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function dest(lat, lon, brg, km) {
  const R = 6371.0088, rad = Math.PI / 180;
  const d = km / R, b = brg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((l2 / rad + 540) % 360) - 180];
}
