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
//   The pins      a candidate's pin is what a real pointer lands on — not the
//                 network's canvas over it — and a click picks it.
//   Google Earth  the KML parsed and walked: a folder per candidate holding
//                 its pin (lon,lat, not lat,lon) and its paths, one per site
//                 it can be drawn to, each in the band its own margin falls in
//                 by an oracle written here; #1's paths on and everybody
//                 else's off on the folder AND on every path; every styleUrl
//                 resolving; the caveat in the file. Then the KMZ as the bytes
//                 that were downloaded, unzipped by a reader in this file: a
//                 stored zip, doc.kml first, every CRC right, the pins real
//                 PNGs in the map's own blue — and doc.kml the plain KML but
//                 for its icons.
//   The dim       the "everything else" slider fades every pane from the
//                 overlays up and nothing else — not the finder's, not the
//                 popup, not the base map — reaches a pane made after it
//                 moved, and applies nothing at all while the finder is empty,
//                 however low it was left.
//   3-D           the finder's own source and layers between the network's
//                 links and pins, a DOM pin per candidate that a real click
//                 selects without leaking to either map, the dim reaching the
//                 network's paint, and nothing left behind on the way out.
//   The circle    Draw & measure's own circle, armed from this panel with a
//                 real pointer, lands its stations in the set and disarms.
//   Reset         takes all of it off the map, the dim included.
//
//   npm run sites          (or: node sites.mjs)
//   npm run sites -- -v    also print what passed

import zlib from 'node:zlib';
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
});
await page.waitForTimeout(200);
// The finder is a pane of the side panel at this width, opened from 🗼 in its
// strip — with a real click, the way an operator opens it.
await page.click('#help-panel .dock-tab[data-dock="map-sites"]');
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
  // Its place is read off the side panel's strip, which stands the map's
  // controls in the order the corner did — the corner holds none of them at
  // this width. The strip's own button for the pane, and ℹ️ itself.
  const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
  const at = sel => strip.findIndex(b => b.matches(sel));
  const group = sel => strip.find(b => b.matches(sel))?.closest('.dock-group')?.dataset.group;
  const body = wrap && wrap.querySelector('.mn-mapctl-body');
  return {
    present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
    shown: !!(body && body.getClientRects().length), showing: dockShowing(),
    title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    label: strip.find(b => b.dataset.dock === 'map-sites')?.getAttribute('aria-label'),
    group: group('[data-dock="map-sites"]'),
    afterPolar: at('[data-dock="map-sites"]') === at('[data-dock="map-polar"]') + 1,
    beforeHere: at('.mn-map-here') === at('[data-dock="map-sites"]') + 1,
    runDisabled: document.getElementById('sites-run')?.disabled,
    status: document.getElementById('sites-status')?.textContent || '',
  };
});
ok('a 🗼 Repeater site finder is a pane of the side panel, open from its button in the strip',
   panel.present && panel.docked && panel.shown && panel.showing === 'map-sites'
     && panel.title === 'Repeater site finder' && panel.label === 'Repeater site finder', JSON.stringify(panel));
ok('…in the tools group, straight after the polar plot and straight before What is here',
   panel.group === 'tools' && panel.afterPolar && panel.beforeHere, JSON.stringify(panel));
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
const CSV_COLUMNS = csvRows[0].split(',');

// ── 2a. a pin on the map takes a click ───────────────────────────────────────
console.log('\nA pin on the map');

// The pins used to sit in a pane under the network's canvas, where a real
// pointer lands on the canvas and never on the pin — and the pin's handler
// named a function nothing declared, so the one route that did reach it (the
// keyboard) threw. Asked with the pointer, where the hit test says the pin is.
await page.evaluate(r => state.map.setView([r.lat, r.lon], 13, { animate: false }), R[1]);
await page.waitForTimeout(400);
const pin2 = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.mn-site')].find(x => x.querySelector('.mn-site-mark')?.textContent === '2');
  if (!el) return null;
  const r = el.querySelector('.mn-site-mark').getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, mine: !!(hit && el.contains(hit)), hit: hit ? `${hit.tagName}.${hit.className}` : null };
});
ok('candidate #2\'s pin is what the pointer lands on, not the network\'s canvas over it',
   !!pin2 && pin2.mine, JSON.stringify(pin2));
if (pin2) {
  await page.mouse.click(pin2.x, pin2.y);
  await page.waitForTimeout(300);
}
const picked2 = await page.evaluate(() => ({
  rank: MapSites.selectedRank(),
  popup: document.querySelector('.leaflet-popup .mn-site-pop h4')?.textContent || '',
  row: document.querySelector('.sites-result.is-on .sites-rank')?.textContent || '',
}));
ok('…and a click on it picks it, opens its callout and its row',
   picked2.rank === 2 && /^#2 repeater site/.test(picked2.popup) && picked2.row === '2', JSON.stringify(picked2));
ok('…without throwing', errors.length === 0, errors.join('\n'));
await page.evaluate(() => { state.map.closePopup(); MapSites.select(1); });

// ── 2b. the Google Earth file ────────────────────────────────────────────────
console.log('\nThe Google Earth file');

// Parsed as a document and walked, for drawkml.mjs's reason: a wrong KML opens
// perfectly. Every figure below is held against MapSites.results() — the
// ranked answer the panel shows — and the bands against an oracle written
// here from the map's own two thresholds, not against bandOf().
const fade = await page.evaluate(() => ({ good: state.mapFadeGoodDb, ok: state.mapFadeOkDb }));
const G = fade.good > 0 ? fade.good : 15, O = Number.isFinite(fade.ok) ? fade.ok : 6;
const kmlIn = await page.evaluate(() => { const d = MapSites.exportSites(); return { d, text: sitesKml(d) }; });
const K = await page.evaluate(parseKmlInPage, kmlIn.text);
const T = run1.targets;
ok('the file is well-formed KML 2.2, one Document',
   !K.error && K.root === 'kml' && K.ns === 'http://www.opengis.net/kml/2.2' && K.docs === 1, String(K.error));
ok('…named for what it holds', K.docName === `Repeater sites — ${T.length} sites, ${R.length} candidates`, K.docName);
ok('…flying to the search area when it opens', K.lookAt);
const tops = K.top || [];
ok('the sites first, then one folder per candidate in rank order, then the search area',
   tops.length === 1 + R.length + 1 && tops[0].tag === 'Folder' && tops[0].name === `Sites to serve (${T.length})`
   && R.every((r, i) => tops[1 + i].tag === 'Folder' && tops[1 + i].name.startsWith(`#${r.rank} — `))
   && tops[tops.length - 1].tag === 'Placemark' && tops[tops.length - 1].geom?.type === 'Polygon',
   JSON.stringify(tops.map(t => `${t.tag}:${t.name}`)));
ok('…each candidate folder saying height, score and how many sites it serves',
   R.every((r, i) => tops[1 + i].name
     === `#${r.rank} — ${Math.round(r.ground)} m · score ${Math.round(r.score)} · ${r.served} of ${T.length} at ≥${O} dB`),
   tops.slice(1, 1 + R.length).map(t => t.name).join(' | '));
ok('…and only #1\'s folder open', R.every((r, i) => tops[1 + i].open === (i === 0 ? '1' : '0')));

const candFolders = tops.slice(1, 1 + R.length);
const candPins = candFolders.map(f => f.placemarks[0]);
ok('every candidate\'s pin is its own point, lon,lat in that order',
   candPins.every((p, i) => p && p.geom?.type === 'Point'
     && Math.abs(p.geom.coords[0][0] - R[i].lon) < 1e-9 && Math.abs(p.geom.coords[0][1] - R[i].lat) < 1e-9),
   JSON.stringify(candPins.map(p => p && p.geom && p.geom.coords[0])));
ok('…styled with its own numbered pin', candPins.every((p, i) => p && p.style === `#mnSite-${R[i].rank}`));
ok('…with a balloon that is a plain table of every site — no scripts, no classes',
   candPins.every(p => p && /<table/.test(p.desc) && (p.desc.match(/<tr>/g) || []).length === 1 + T.length
     && !/<script|class=|style=/i.test(p.desc) && /Road reserve:/.test(p.desc)),
   candPins[0] && candPins[0].desc.slice(0, 200));
ok('…and the CSV\'s columns as its data', candPins.every((p, i) => p && p.data
     && p.data.rank === String(R[i].rank) && p.data.site_lat === R[i].lat.toFixed(6)
     && Object.keys(p.data).every(k => CSV_COLUMNS.includes(k))),
   JSON.stringify(candPins[0] && candPins[0].data));

const drawnOf = r => r.figs.filter(f => f && Object.keys(f).length && !f.colo && !f.failed);
const linksOf = f => (f.folders.find(x => /^Links from #/.test(x.name)) || { placemarks: [] });
ok('each candidate\'s paths are one per site, less any it stands on or could not compute',
   R.every((r, i) => linksOf(candFolders[i]).placemarks.length === drawnOf(r).length
     && linksOf(candFolders[i]).name === `Links from #${r.rank} (${drawnOf(r).length})`),
   R.map((r, i) => `${linksOf(candFolders[i]).placemarks.length}/${drawnOf(r).length}`).join(' '));

// The bands, from the figure's margin and the map's two thresholds.
const oracleBand = f => (f.colo ? 'good' : f.margin == null ? (f.verdict === 'obstructed' ? 'bad' : 'none')
  : f.margin >= G ? 'good' : f.margin >= O ? 'ok' : 'bad');
const kOf = pm => T.findIndex(t => t.lat.toFixed(6) === pm.data?.target_lat && t.lon.toFixed(6) === pm.data?.target_lon);
const bandMiss = [], seenBands = new Set();
R.forEach((r, i) => linksOf(candFolders[i]).placemarks.forEach(pm => {
  const k = kOf(pm), f = r.figs[k];
  if (k < 0 || !f) { bandMiss.push(`#${r.rank}: no target for ${pm.name}`); return; }
  const want = `#mnLink${f.verdict === 'obstructed' ? 'Obs' : ''}-${oracleBand(f)}`;
  seenBands.add(want);
  if (pm.style !== want) bandMiss.push(`#${r.rank} → ${T[k].name}: ${pm.style} ≠ ${want} (${f.margin})`);
}));
ok('every path is styled by the band its own margin falls in', bandMiss.length === 0,
   bandMiss.slice(0, 4).join('; ') || [...seenBands].join(' '));
const BAND_HEX = { good: '#00e676', ok: '#ffab00', bad: '#e53935', none: '#888888' };
const kmlOf = (hex, a = 'ff') => `${a}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
ok('…in the band\'s own colour, whatever the theme — obstructed paths thinner and translucent',
   Object.entries(BAND_HEX).every(([b, h]) => K.styles[`mnLink-${b}`]?.line === kmlOf(h)
     && K.styles[`mnLinkObs-${b}`]?.line === kmlOf(h, '99')
     && +K.styles[`mnLinkObs-${b}`].width < +K.styles[`mnLink-${b}`].width),
   JSON.stringify(K.styles['mnLink-good']));
const allPms = [];
const walk = f => { allPms.push(...f.placemarks); f.folders.forEach(walk); };
tops.forEach(t => (t.tag === 'Folder' ? walk(t) : allPms.push(t)));
ok('every styleUrl names a style that is in the file',
   K.styleUrls.length > 0 && K.styleUrls.every(u => u.startsWith('#') && K.styles[u.slice(1)]),
   K.styleUrls.filter(u => !K.styles[u.slice(1)]).join(' '));
const allLinks = candFolders.flatMap(f => linksOf(f).placemarks);
ok('every path is draped on the ground, not a chord through it',
   allLinks.length > 0 && allLinks.every(p => p.geom?.type === 'LineString' && p.geom.tess === '1' && p.geom.alt === 'clampToGround'));
ok('…from its candidate to its site, lon,lat',
   R.every((r, i) => linksOf(candFolders[i]).placemarks.every(pm => {
     const c = pm.geom.coords, t = T[kOf(pm)];
     return c.length === 2 && Math.abs(c[0][0] - r.lon) < 1e-9 && Math.abs(c[0][1] - r.lat) < 1e-9
       && !!t && Math.abs(c[1][0] - t.lon) < 1e-9 && Math.abs(c[1][1] - t.lat) < 1e-9;
   })));

// Visibility: #1's paths on, everybody else's off, on the folder AND on every
// path in it — Earth on the web converts an import into project features and
// may keep the placemark's flag and drop the folder's.
const vis = candFolders.map(f => ({ folder: linksOf(f).visibility, each: linksOf(f).placemarks.map(p => p.visibility) }));
ok('#1\'s paths are on — no visibility written on the folder or on any path',
   vis[0].folder === null && vis[0].each.every(v => v === null), JSON.stringify(vis[0]));
ok('every other candidate\'s paths are off, on the folder and on each path',
   vis.slice(1).every(v => v.folder === '0' && v.each.length > 0 && v.each.every(x => x === '0')),
   JSON.stringify(vis.slice(1).map(v => [v.folder, [...new Set(v.each)]])));
ok('…while every candidate\'s pin, the sites and the search area stay on',
   candPins.every(p => p.visibility === null) && tops[0].visibility === null
   && tops[0].placemarks.every(p => p.visibility === null) && tops[tops.length - 1].visibility === null);

const dataMiss = [];
R.forEach((r, i) => linksOf(candFolders[i]).placemarks.forEach(pm => {
  const f = r.figs[kOf(pm)];
  const want = f && f.margin != null ? f.margin.toFixed(1) : '';
  if (pm.data?.margin_db !== want) dataMiss.push(`${pm.name}: ${pm.data?.margin_db} ≠ ${want}`);
  if (!Object.keys(pm.data || {}).every(k => CSV_COLUMNS.includes(k))) dataMiss.push(`${pm.name}: a column the CSV does not have`);
}));
ok('every path carries its margin to the tenth, under the CSV\'s own column names', dataMiss.length === 0,
   dataMiss.slice(0, 3).join('; '));
ok('…and says it in words too, both directions and where the figure came from',
   allLinks.every(p => /Fade margin:/.test(p.desc) && /repeater to site/.test(p.desc) && /Figure:/.test(p.desc)));

const chordFolders = candFolders.map(f => f.folders.find(x => x.name === 'Sight lines at antenna height (3-D)'));
const rep = kmlIn.d.rep;
ok('each candidate has its sight lines at antenna height, off, and said to be chords not clearance',
   chordFolders.every((f, i) => f && f.visibility === '0' && f.placemarks.length === drawnOf(R[i]).length
     && f.placemarks.every(p => p.visibility === '0' && /straight chord/.test(p.name) && /not the path's clearance/.test(p.desc))),
   JSON.stringify(chordFolders.map(f => f && [f.visibility, f.placemarks.length])));
ok('…straight lines from the mast top to the antenna top, relative to the ground',
   chordFolders.every(f => f && f.placemarks.every(p => {
     const t = T[T.findIndex(x => Math.abs(x.lon - p.geom.coords[1][0]) < 1e-9 && Math.abs(x.lat - p.geom.coords[1][1]) < 1e-9)];
     const d = t && kmlIn.d.targets.find(x => x.key === t.key);
     return p.geom.type === 'LineString' && p.geom.tess === '0' && p.geom.alt === 'relativeToGround'
       && p.geom.coords[0][2] === rep.agl && !!d && p.geom.coords[1][2] === d.agl;
   })), `mast ${rep.agl} m`);

const siteFolder = tops[0];
ok('the sites to serve are all there, stations as stations and the proposed one plainly',
   siteFolder.placemarks.length === T.length
   && siteFolder.placemarks.every((p, k) => p.name === T[k].name
     && p.style === (T[k].kind === 'station' ? '#mnTarget' : '#mnTargetPt')
     && Math.abs(p.geom.coords[0][0] - T[k].lon) < 1e-9 && Math.abs(p.geom.coords[0][1] - T[k].lat) < 1e-9),
   siteFolder.placemarks.map(p => `${p.name}:${p.style}`).join(' | '));
ok('…each saying which candidate serves it best',
   siteFolder.placemarks.every(p => /Best served by(:<\/b>)? (#\d|no candidate)/.test(p.desc)), siteFolder.placemarks[0].desc);

// The search area: a circle on the sphere, measured back with this file's
// own haversine — drawkml.mjs's check, for its reason.
const areaPm = tops[tops.length - 1];
const ring = areaPm.geom.coords;
const A = run1.area;
ok('the search area is a closed ring, starting due north of the middle',
   ring.length === 73 && ring[0][0] === ring[72][0] && ring[0][1] === ring[72][1]
   && Math.abs(ring[0][0] - A.lon) < 1e-9 && ring[0][1] > A.lat, `${ring.length} points`);
ok('…every vertex the search radius from the middle, on the sphere',
   ring.every(([lon, lat]) => Math.abs(acmaDist(A, { lat, lon }) - A.rKm) / A.rKm < 0.005), `${A.rKm.toFixed(2)} km`);
ok('…draped, and an outline', areaPm.geom.tess === '1' && areaPm.geom.alt === 'clampToGround'
   && areaPm.style === '#mnArea');

const PM_ORDER = ['name', 'visibility', 'open', 'description', 'LookAt', 'styleUrl', 'ExtendedData', 'Point', 'LineString', 'Polygon'];
const badOrder = allPms.filter(p => !p.order.every((t, i) => PM_ORDER.includes(t)
  && (i === 0 || PM_ORDER.indexOf(p.order[i - 1]) < PM_ORDER.indexOf(t))));
ok('every placemark\'s children are in the KML 2.2 schema\'s order', badOrder.length === 0,
   badOrder.slice(0, 2).map(p => `${p.name}: ${p.order.join(',')}`).join('; '));
ok('the caveat travels with the file', K.docDesc.includes(kmlIn.d.caveat) && /Exported from MegaNet on /.test(K.docDesc));

const nasty = 'Smith & Sons <b>"Hill"</b>';
const Kn = await page.evaluate(parseKmlInPage, await page.evaluate(name => {
  const d = MapSites.exportSites();
  d.targets[0].name = name;
  if (d.targets[0].station) d.targets[0].station.name = name;
  return sitesKml(d);
}, nasty));
ok('a site named with & and < survives, as its own name',
   !Kn.error && Kn.top[0].placemarks[0].name === nasty
   && Kn.top.slice(1, -1).every(f => linksOf(f).placemarks.every(p => kOf(p) !== 0 || p.name.includes(nasty))),
   String(Kn.error || Kn.top[0].placemarks[0].name));

// ── 2c. the KMZ and the KML, downloaded ──────────────────────────────────────
console.log('\nThe KMZ and the KML, downloaded');

const base = await page.evaluate(() => `repeater-sites-${slug(MapSites.targets()[0].name) || 'sites'}-${MapSites.targets().length}`);
const plain = await page.evaluate(() => sitesKml(MapSites.exportSites()));
const btns = await page.evaluate(() => {
  const z = document.getElementById('sites-kmz'), l = document.getElementById('sites-kml');
  return { kmz: { on: !!z && !z.disabled, title: z ? z.title : '', text: z ? z.textContent.trim() : '' },
           kml: { on: !!l && !l.disabled, title: l ? l.title : '' } };
});
ok('the panel offers the KMZ and a plain KML beside Save CSV, and says how to import them',
   btns.kmz.on && btns.kml.on && /Google Earth \(KMZ\)/.test(btns.kmz.text)
   && /Import file to project/.test(btns.kmz.title) && /Import file to project|Open local KML file/.test(btns.kml.title),
   JSON.stringify(btns));

const readDownload = async dl => {
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks);
};
const [dlz] = await Promise.all([page.waitForEvent('download'), page.locator('#sites-kmz').click()]);
const kmz = await readDownload(dlz);
ok('the KMZ is named for the sites, as the CSV is', dlz.suggestedFilename() === `${base}.kmz`, dlz.suggestedFilename());
const Z = unzipStored(kmz);
ok('it is a zip', kmz.subarray(0, 4).toString('latin1') === 'PK\x03\x04' && !!Z && !Z.error, Z && Z.error);
const zNames = Z.entries.map(e => e.name);
ok('…whose first entry is doc.kml, first in the file as well as in the directory',
   zNames[0] === 'doc.kml' && Z.entries[0].offset === 0, zNames.join(' '));
ok('…holding a numbered pin per candidate and the site mark',
   zNames.length === 1 + R.length + 1 && R.every(r => zNames.includes(`files/site-${r.rank}.png`))
   && zNames.includes('files/target.png'), zNames.join(' '));
ok('…every entry stored, sizes agreeing, local header matching the directory',
   Z.entries.every(e => e.method === 0 && e.lmethod === 0 && e.csize === e.usize && e.usize === e.data.length
     && e.lname === e.name && e.lsize === e.csize && e.lcrc === e.crc && e.lsig === 0x04034b50),
   JSON.stringify(Z.entries.map(e => [e.name, e.method, e.csize, e.usize])));
ok('…and every CRC right, by a CRC written in this file',
   Z.entries.every(e => crc32(e.data) === e.crc), JSON.stringify(Z.entries.map(e => [e.name, e.crc, crc32(e.data)])));
ok('…the directory where the end record says it is', Z.cenOff + Z.cenSize === Z.eocd);

const pngs = Z.entries.filter(e => e.name.endsWith('.png')).map(e => ({ name: e.name, px: pngPixels(e.data) }));
ok('the pins are 64 px PNGs', pngs.every(p => p.px && p.px.w === 64 && p.px.h === 64),
   JSON.stringify(pngs.map(p => [p.name, p.px && p.px.w, p.px && p.px.error])));
// The map's own pin: a #0b5cab disc in a white ring, the rank in white. Read
// off the decoded pixels, above the numeral and inside the ring.
const near = (rgba, hex, tol = 24) => rgba && rgba[3] > 200 && [1, 3, 5].every((o, i) =>
  Math.abs(rgba[i] - parseInt(hex.slice(o, o + 2), 16)) <= tol);
const site1 = pngs.find(p => p.name === 'files/site-1.png')?.px;
ok('…drawn as the map\'s pin: a blue disc in a white ring',
   !!site1 && near(site1.at(32, 13), '#0b5cab') && near(site1.at(32, 6), '#ffffff') && site1.at(1, 1)[3] === 0,
   site1 ? JSON.stringify([site1.at(32, 13), site1.at(32, 6), site1.at(1, 1)]) : 'no pixels');
const tgt = pngs.find(p => p.name === 'files/target.png')?.px;
ok('…and the site mark a ring round a dot', !!tgt && near(tgt.at(32, 32), '#0b5cab') && near(tgt.at(32, 12), '#0b5cab')
   && tgt.at(32, 19)[3] < 60, tgt ? JSON.stringify([tgt.at(32, 32), tgt.at(32, 12), tgt.at(32, 19)]) : 'no pixels');

const docKml = Z.entries[0].data.toString('utf8');
const Kz = await page.evaluate(parseKmlInPage, docKml);
const rel = Kz.hrefs.filter(h => !/^https?:/.test(h));
ok('doc.kml parses, and every icon it names is in the zip',
   !Kz.error && rel.length > 0 && rel.every(h => zNames.includes(h)), String(Kz.error || rel.join(' ')));
ok('…and every picture in the zip is used', zNames.filter(n => n.endsWith('.png')).every(n => rel.includes(n)));
const iconless = s => undated(s).replace(/<IconStyle>[\s\S]*?<\/IconStyle>/g, '<IconStyle/>');
ok('doc.kml is the plain KML with its own icons — nothing else differs', iconless(docKml) === iconless(plain),
   `${docKml.length} vs ${plain.length} bytes`);
ok('…and the plain KML fetches Google\'s numbered pins instead',
   R.every(r => K.styles[`mnSite-${r.rank}`]?.href === `https://maps.google.com/mapfiles/kml/paddle/${r.rank}.png`)
   && /^https:\/\/maps\.google\.com\//.test(K.styles.mnTarget?.href || ''));
const told = await page.evaluate(() => document.getElementById('app-status')?.textContent || '');
ok('the download says what it wrote and where to take it',
   new RegExp(`${base}\\.kmz — ${R.length} candidates, ${T.length} sites and \\d+ paths`).test(told)
   && /earth\.google\.com/.test(told), told);

const [dll] = await Promise.all([page.waitForEvent('download'), page.locator('#sites-kml').click()]);
const kmlBody = (await readDownload(dll)).toString('utf8');
ok('the KML button downloads the same file, as .kml', dll.suggestedFilename() === `${base}.kml`
   && undated(kmlBody) === undated(plain), dll.suggestedFilename());

// ── 2d. everything else, dimmed ──────────────────────────────────────────────
console.log('\nEverything else, dimmed');

const panes = () => page.evaluate(() => {
  const out = {};
  for (const [name, el] of Object.entries(state.map.getPanes())) {
    out[name] = { z: parseInt(el.style.zIndex || getComputedStyle(el).zIndex, 10),
                  op: getComputedStyle(el).opacity, inline: el.style.opacity };
  }
  return out;
});
const KEEP = ['mnSites', 'mnSitesLines', 'popupPane', 'mapPane'];
const p100 = await panes();
ok('at its default of 100 % the slider touches no pane',
   Object.values(p100).every(p => p.op === '1' && p.inline === '')
   && await page.evaluate(() => document.getElementById('sites-dim')?.value) === '100',
   JSON.stringify(Object.entries(p100).filter(([, p]) => p.op !== '1')));
await page.locator('#sites-dim').fill('20');
const p20 = await panes();
const dimmedNames = Object.keys(p20).filter(n => p20[n].op === '0.2');
const shouldDim = Object.keys(p20).filter(n => !KEEP.includes(n) && p20[n].z >= 300);
ok('at 20 % every pane from the overlays up is at 0.2 — the network\'s canvas, the pins\', the labels\' and every context layer\'s',
   shouldDim.length >= 4 && ['overlayPane', 'markerPane', 'tooltipPane', 'shadowPane'].every(n => shouldDim.includes(n))
   && shouldDim.every(n => p20[n].op === '0.2') && dimmedNames.length === shouldDim.length,
   `dimmed: ${dimmedNames.join(' ')}`);
ok('…while the finder\'s own panes and the popup stay whole',
   KEEP.every(n => !p20[n] || p20[n].op === '1'), JSON.stringify(KEEP.map(n => p20[n] && p20[n].op)));
ok('…and the base map, its labels and the elevation stay under their own sliders',
   Object.entries(p20).filter(([n, p]) => p.z < 300 && n !== 'mapPane').every(([, p]) => p.op === '1')
   && p20.tilePane.op === '1', Object.entries(p20).filter(([, p]) => p.z < 300).map(([n, p]) => `${n}:${p.op}`).join(' '));
const dimSaid = await page.evaluate(() => ({
  out: document.getElementById('sites-dim-out')?.textContent,
  vt: document.getElementById('sites-dim')?.getAttribute('aria-valuetext'),
  stored: JSON.parse(localStorage.getItem('mn-sites-v1') || '{}').dimPct,
  k: MapSites.dimOthers(),
  names: [...document.querySelectorAll('.mn-site-tname')].map(e => e.textContent),
  dots: document.querySelectorAll('.mn-site-tdot').length,
}));
ok('the slider reads out its value, remembers it, and says it to a screen reader',
   dimSaid.out === '20 %' && dimSaid.vt === '20 percent' && dimSaid.stored === 20 && dimSaid.k === 0.2,
   JSON.stringify(dimSaid));
ok('with the network faded, every site keeps a dot and gains its name',
   dimSaid.dots === T.length && dimSaid.names.length === T.length && T.every(t => dimSaid.names.includes(t.name)),
   JSON.stringify(dimSaid.names));
const late = await page.evaluate(async () => {
  state.map.createPane('mnLateHigh').style.zIndex = 360;
  state.map.createPane('mnLateLow').style.zIndex = 240;
  await new Promise(r => setTimeout(r, 0));
  const out = { high: getComputedStyle(state.map.getPane('mnLateHigh')).opacity,
                low: getComputedStyle(state.map.getPane('mnLateLow')).opacity };
  for (const n of ['mnLateHigh', 'mnLateLow']) { state.map.getPane(n).remove(); delete state.map._panes[n]; }
  return out;
});
ok('a layer\'s pane made after the slider moved is dimmed as it appears — and one under the overlays is not',
   late.high === '0.2' && late.low === '1', JSON.stringify(late));

// At nought the network is out of sight, and it has to be out of reach too: a
// transparent canvas still hit-tests, so a click on what looked like empty
// ground used to open the callout and card of a station nobody could see.
await page.locator('#sites-dim').fill('0');
const p0 = await page.evaluate(() => Object.fromEntries(Object.entries(state.map.getPanes())
  .map(([n, el]) => [n, { op: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }])));
ok('at 0 % the faded panes stop taking the pointer, and the finder\'s own panes and the popups do not',
   ['overlayPane', 'markerPane', 'tooltipPane'].every(n => p0[n].op === '0' && p0[n].pe === 'none')
   // mnSitesLines never takes the pointer at any strength (its lines are
   // pictures, and the network's canvas is above them), so it is not asked.
   && ['mnSites', 'popupPane'].every(n => p0[n].op === '1' && p0[n].pe !== 'none'),
   JSON.stringify(Object.fromEntries(Object.entries(p0).map(([n, v]) => [n, `${v.op}/${v.pe}`]))));
await page.locator('#sites-dim').fill('20');
const p20b = await page.evaluate(() => getComputedStyle(state.map.getPane('overlayPane')).pointerEvents);
ok('…and above nought they are faint but still clickable', p20b !== 'none', p20b);

// ── 2e. in 3-D ───────────────────────────────────────────────────────────────
console.log('\nIn 3-D');

const gl2 = await page.evaluate(() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; }
});
if (!gl2) {
  console.log('  SKIP — this browser has no WebGL2, so the 3-D half cannot be checked here.');
} else {
  await page.evaluate(() => MapSites.select(1));
  await page.locator('.mn-map-3d').click();
  await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded() && !!Map3D._map().getTerrain(),
    null, { timeout: RUN_TIMEOUT });
  await page.waitForTimeout(500);
  const look3 = () => page.evaluate(() => {
    const m = Map3D._map(), s = Map3D._sites();
    const ids = m.getStyle().layers.map(l => l.id);
    const f = (s.drawn && s.drawn.features) || [];
    const kinds = {};
    for (const x of f) kinds[x.properties.kind] = (kinds[x.properties.kind] || 0) + 1;
    return {
      ids, source: s.source, kinds, pins: s.pins,
      layers: ['mn-sites-fill', 'mn-sites-area', 'mn-sites-links', 'mn-sites-targets'].map(id => !!m.getLayer(id)),
      links: f.filter(x => x.properties.kind === 'link').map(x => x.geometry.coordinates),
      area: f.filter(x => x.properties.kind === 'area').map(x => x.geometry.coordinates[0]),
      dom: document.querySelectorAll('#map3d .mn-site').length,
      domOn: [...document.querySelectorAll('#map3d .mn-site.is-on .mn-site-mark')].map(e => e.textContent),
      marks: document.querySelectorAll('#map3d .mn-site-t').length,
      names: document.querySelectorAll('#map3d .mn-site-tname').length,
      mirror: { st: Map3D._mirror().stations.features.length, markers: state.mapMarkers.length,
                kinds: Map3D._mirror().links.features.filter(x => x.properties.kind != null).length },
      paint: { links: m.getPaintProperty('mn-links', 'line-opacity'),
               st: m.getPaintProperty('mn-stations', 'circle-opacity'),
               stroke: m.getPaintProperty('mn-stations', 'circle-stroke-opacity'),
               here: m.getPaintProperty('mn-here-dot', 'circle-opacity') },
      dim: s.dim,
      circle: { off: document.getElementById('sites-circle')?.disabled, title: document.getElementById('sites-circle')?.title || '' },
      rank: MapSites.selectedRank(),
    };
  });
  const s3 = await look3();
  ok('the finder has its own source and four layers in 3-D', s3.source && s3.layers.every(Boolean), JSON.stringify(s3.layers));
  ok('…between the network\'s links and its pins, as its panes sit in 2-D',
     ['mn-sites-fill', 'mn-sites-area', 'mn-sites-links', 'mn-sites-targets']
       .every(id => s3.ids.indexOf(id) > s3.ids.indexOf('mn-links') && s3.ids.indexOf(id) < s3.ids.indexOf('mn-stations')),
     s3.ids.join(', '));
  ok('…holding the search area, a ring per site and #1\'s paths',
     s3.kinds.area === 1 && s3.kinds.target === T.length && s3.kinds.link === drawnOf(R[0]).length
     && s3.area[0].length === 97 && s3.links.every(c => Math.abs(c[0][0] - R[0].lon) < 1e-9 && Math.abs(c[0][1] - R[0].lat) < 1e-9),
     JSON.stringify(s3.kinds));
  ok('one numbered pin per candidate, on the terrain, #1 picked',
     s3.dom === R.length && s3.domOn.join() === '1' && s3.pins === R.length + T.length, JSON.stringify([s3.dom, s3.domOn, s3.pins]));
  ok('…and every site\'s mark, named while the rest is dimmed', s3.marks === T.length && s3.names === T.length);
  ok('none of it is in the network\'s own mirror', s3.mirror.st === s3.mirror.markers && s3.mirror.kinds === 0,
     JSON.stringify(s3.mirror));
  ok('the dim reaches the network in 3-D: links, pins and the What is here mark at 0.2',
     s3.dim === 0.2 && JSON.stringify(s3.paint.links) === '["*",["get","op"],0.2]'
     && JSON.stringify(s3.paint.st) === '["*",["get","op"],0.2]' && JSON.stringify(s3.paint.stroke) === '["*",["get","op"],0.2]'
     && s3.paint.here === 0.2, JSON.stringify(s3.paint));
  ok('Draw a circle is off in 3-D, and says why', s3.circle.off === true && /Leave 3-D/.test(s3.circle.title),
     JSON.stringify(s3.circle));

  // A real pointer on pin #3. The camera is put straight over it first, so the
  // pin is where the hit test answers rather than where a projection guesses.
  await page.evaluate(r => Map3D._map().jumpTo({ center: [r.lon, r.lat], zoom: 12, pitch: 0, bearing: 0 }), R[2]);
  await page.waitForTimeout(900);
  const pin3 = await page.evaluate(() => {
    window.__lfClicks = 0; window.__mlClicks = 0;
    state.map.on('click', () => window.__lfClicks++);
    Map3D._map().on('click', () => window.__mlClicks++);
    const el = [...document.querySelectorAll('#map3d .mn-site')].find(x => x.querySelector('.mn-site-mark')?.textContent === '3');
    if (!el) return null;
    const r = el.querySelector('.mn-site-mark').getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, mine: !!(hit && el.contains(hit)), hit: hit ? `${hit.tagName}.${hit.className}` : null };
  });
  ok('pin #3 is on screen where the pointer can reach it', !!pin3 && pin3.mine, JSON.stringify(pin3));
  if (pin3) {
    await page.mouse.click(pin3.x, pin3.y);
    await page.waitForTimeout(400);
  }
  const s3b = await look3();
  const leaked = await page.evaluate(() => ({ lf: window.__lfClicks, ml: window.__mlClicks, here: MapHere.point() }));
  ok('clicking it picks candidate #3', s3b.rank === 3 && s3b.domOn.join() === '3', JSON.stringify([s3b.rank, s3b.domOn]));
  ok('…and its paths replace #1\'s on the terrain',
     s3b.kinds.link === drawnOf(R[2]).length
     && s3b.links.every(c => Math.abs(c[0][0] - R[2].lon) < 1e-9 && Math.abs(c[0][1] - R[2].lat) < 1e-9),
     JSON.stringify(s3b.kinds));
  ok('…with the click answered by the pin alone — not the 3-D map, not the 2-D map under it',
     leaked.lf === 0 && leaked.ml === 0 && leaked.here === null, JSON.stringify(leaked));

  await page.locator('#sites-dim').fill('100');
  const s3c = await look3();
  ok('back at 100 % the network\'s opacities are its own again, and the names go',
     s3c.dim === 1 && JSON.stringify(s3c.paint.links) === '["get","op"]' && JSON.stringify(s3c.paint.st) === '["get","op"]'
     && s3c.paint.here === 1 && s3c.names === 0, JSON.stringify(s3c.paint));

  await page.locator('.mn-map-3d').click();
  await page.waitForFunction(() => !Map3D._map(), null, { timeout: RUN_TIMEOUT });
  const gone3 = await page.evaluate(() => ({
    host: !!document.getElementById('map3d'), markers: document.querySelectorAll('.maplibregl-marker').length,
    pins: Map3D._sites().pins, flat: document.querySelectorAll('.mn-site').length,
    circle: { off: document.getElementById('sites-circle')?.disabled, title: document.getElementById('sites-circle')?.title || '' },
  }));
  ok('leaving 3-D takes its pins and marks with it, and leaves 2-D\'s', !gone3.host && gone3.markers === 0 && gone3.pins === 0
     && gone3.flat === R.length, JSON.stringify(gone3));
  ok('…and Draw a circle comes back', gone3.circle.off === false && /middle of the area/.test(gone3.circle.title),
     JSON.stringify(gone3.circle));
}
await page.evaluate(() => MapSites.select(1));
// Left dimmed for the rest of the run, so ↺ has a dim to take away.
await page.locator('#sites-dim').fill('20');

// ── 2f. in the default layout, with the cards in the side panel ─────────────
// Everything above runs with ◫ off, so the Stations cards are under the map and
// the finder is the side panel's only pane. That is not how anybody meets it:
// by default the cards are in the side panel too, the profile card in the path
// tools' pane (〽️), and "Profile the worst path" draws into it there. It used
// to leave the card hidden there and say it was "under the map".
console.log('\nIn the default layout');

await page.evaluate(() => { toggleStationsSplit(true); setDockTab('map-sites'); });
await page.waitForTimeout(300);
const beforeProf = await page.evaluate(() => ({ showing: dockShowing(),
  cards: !!document.querySelector('#help-panel .dock-pane-stations #stations-cards') }));
ok('with ◫ on the cards are in the side panel beside the finder, and the finder is the pane on screen',
   beforeProf.showing === 'map-sites' && beforeProf.cards, JSON.stringify(beforeProf));
await page.locator('.sites-panel button', { hasText: 'Profile the worst path' }).first().click();
await page.waitForTimeout(400);
const afterProf = await page.evaluate(() => {
  const el = document.getElementById('path-profile-panel');
  return { showing: dockShowing(), open: state.path.open,
           visible: !!el && el.checkVisibility(),
           note: document.getElementById('map-note')?.textContent || '' };
});
ok('Profile the worst path brings the profile card up in the side panel, open',
   afterProf.showing === 'paths' && afterProf.visible && afterProf.open === true, JSON.stringify(afterProf));
ok('…and the note says where the card is', /side panel/.test(afterProf.note) && !/under the map/.test(afterProf.note),
   afterProf.note);
// Back to the layout the rest of the run was written for.
await page.evaluate(() => { toggleStationsSplit(false); setDockTab('map-sites'); });
await page.waitForTimeout(300);

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
// …and with no answer there is no file: both buttons off, and a call made
// anyway (a stale render, the console) writes nothing and says why.
const refused = await page.evaluate(() => {
  let blobs = 0;
  const real = URL.createObjectURL;
  URL.createObjectURL = b => { blobs++; return real.call(URL, b); };
  try { downloadSitesKmz(); downloadSitesKml(); } finally { URL.createObjectURL = real; }
  return { blobs, off: ['sites-kmz', 'sites-kml'].every(id => document.getElementById(id)?.disabled === true) };
});
// announce() empties the live region and writes a frame later, so a reader
// hears it as new — which is also when this can read it.
await page.waitForFunction(() => !!document.getElementById('app-status')?.textContent, null, { timeout: 5000 }).catch(() => {});
refused.said = await page.evaluate(() => document.getElementById('app-status')?.textContent || '');
ok('with no answer the Google Earth buttons are off, and a download writes nothing and says why',
   refused.blobs === 0 && refused.off && /no answer to export yet/.test(refused.said), JSON.stringify(refused));
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

// The dim was left at 20 % through all of the above. ↺ empties the finder, and
// an empty finder applies no dim whatever the slider remembers.
const pReset = await panes();
const dimAfter = await page.evaluate(() => ({ k: MapSites.dimOthers(),
  stored: JSON.parse(localStorage.getItem('mn-sites-v1') || '{}').dimPct,
  marks: document.querySelectorAll('.mn-site-t').length }));
ok('…and puts every pane back, though the slider still remembers 20 %',
   Object.values(pReset).every(p => p.op === '1' && p.inline === '') && dimAfter.k === 1 && dimAfter.stored === 20
   && dimAfter.marks === 0, JSON.stringify(dimAfter));

// A fresh visit with 20 % remembered: nothing is in the finder, so nothing is
// dimmed — a low value left over from yesterday must not hide the network
// with nothing on screen to say why.
await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
const pFresh = await panes();
const fresh = await page.evaluate(() => ({ k: MapSites.dimOthers(),
  stored: JSON.parse(localStorage.getItem('mn-sites-v1') || '{}').dimPct }));
ok('a fresh visit with 20 % remembered dims nothing until there are sites again',
   fresh.stored === 20 && fresh.k === 1 && Object.values(pFresh).every(p => p.op === '1'), JSON.stringify(fresh));

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

// ── the file, read back ──────────────────────────────────────────────────────
// Everything below is written here rather than borrowed from the app, for the
// reason the haversine above is: a file checked with the code that wrote it is
// checking nothing.

// The KML, walked in the page's own DOMParser (the parser Earth's web client
// is closest to) and handed back as plain facts: every Folder and Placemark
// with its name, visibility, style, balloon, data, geometry and the order its
// children came in.
function parseKmlInPage(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const bad = doc.querySelector('parsererror');
  if (bad) return { error: bad.textContent.slice(0, 300) };
  const kids = (el, tag) => [...el.children].filter(c => c.localName === tag);
  const one = (el, tag) => kids(el, tag)[0] || null;
  const txt = (el, tag) => { const c = one(el, tag); return c ? c.textContent : null; };
  const geom = el => {
    for (const tag of ['Point', 'LineString', 'Polygon']) {
      const g = one(el, tag);
      if (!g) continue;
      const ce = tag === 'Polygon' ? g.querySelector('outerBoundaryIs > LinearRing > coordinates') : one(g, 'coordinates');
      const coords = (ce ? ce.textContent : '').trim().split(/\s+/).filter(Boolean).map(s => s.split(',').map(Number));
      return { type: tag, coords, tess: txt(g, 'tessellate'), alt: txt(g, 'altitudeMode') };
    }
    return null;
  };
  const placemark = el => {
    const ed = one(el, 'ExtendedData');
    const data = ed ? {} : null;
    if (ed) for (const d of kids(ed, 'Data')) data[d.getAttribute('name')] = txt(d, 'value');
    return { name: txt(el, 'name'), visibility: txt(el, 'visibility'), style: txt(el, 'styleUrl'),
             desc: txt(el, 'description') || '', data, geom: geom(el), order: [...el.children].map(c => c.localName) };
  };
  const folder = el => ({ name: txt(el, 'name'), visibility: txt(el, 'visibility'), open: txt(el, 'open'),
                          placemarks: kids(el, 'Placemark').map(placemark), folders: kids(el, 'Folder').map(folder) });
  const root = doc.documentElement;
  const D = one(root, 'Document');
  const styles = {};
  for (const s of kids(D, 'Style')) {
    const q = sel => { const e = s.querySelector(sel); return e ? e.textContent : null; };
    styles[s.getAttribute('id')] = { line: q('LineStyle > color'), width: q('LineStyle > width'), href: q('IconStyle > Icon > href') };
  }
  return {
    error: null, root: root.localName, ns: root.namespaceURI, docs: kids(root, 'Document').length,
    docName: txt(D, 'name'), docDesc: txt(D, 'description') || '', lookAt: !!one(D, 'LookAt'),
    styles, styleUrls: [...doc.getElementsByTagName('styleUrl')].map(e => e.textContent),
    hrefs: [...doc.getElementsByTagName('href')].map(e => e.textContent),
    top: [...D.children].filter(c => c.localName === 'Folder' || c.localName === 'Placemark')
      .map(c => (c.localName === 'Folder' ? { tag: 'Folder', ...folder(c) } : { tag: 'Placemark', ...placemark(c) })),
  };
}

// drawkml.mjs's normaliser: the one line of a file that is the time it was written.
function undated(s) {
  return s.replace(/Exported from MegaNet[\s\S]*?\]\]><\/description>/, '');
}

// A store-only zip, read from the end record inwards: the central directory
// says where each entry is, and each local header is read again at that offset
// so the two can be held to agreeing. Anything but method 0 is reported rather
// than inflated — the writer claims to store, so a deflated entry is a defect.
function unzipStored(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return { error: 'no end-of-central-directory record', entries: [] };
  const count = buf.readUInt16LE(e + 10), cenSize = buf.readUInt32LE(e + 12), cenOff = buf.readUInt32LE(e + 16);
  const entries = [];
  let p = cenOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return { error: `bad directory entry ${i}`, entries };
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const ent = { name: buf.toString('utf8', p + 46, p + 46 + nlen), method: buf.readUInt16LE(p + 10),
                  crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), offset };
    const lnlen = buf.readUInt16LE(offset + 26), lxlen = buf.readUInt16LE(offset + 28);
    Object.assign(ent, { lsig: buf.readUInt32LE(offset), lmethod: buf.readUInt16LE(offset + 8),
                         lcrc: buf.readUInt32LE(offset + 14), lsize: buf.readUInt32LE(offset + 18),
                         lname: buf.toString('utf8', offset + 30, offset + 30 + lnlen) });
    const at = offset + 30 + lnlen + lxlen;
    ent.data = buf.subarray(at, at + ent.csize);
    entries.push(ent);
    p += 46 + nlen + xlen + clen;
  }
  return { error: null, entries, cenOff, cenSize, eocd: e };
}

// CRC-32 the slow, obvious way — bit by bit, no table — so it shares nothing
// with the writer's.
function crc32(u8) {
  let crc = 0xffffffff;
  for (let n = 0; n < u8.length; n++) {
    crc ^= u8[n];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// An 8-bit RGBA or RGB PNG, decoded far enough to read a pixel: the IDAT
// chunks inflated and each scanline's filter undone. That is every PNG a
// canvas writes; anything else is reported, not guessed at.
function pngPixels(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { error: 'not a PNG' };
  let p = 8, w = 0, h = 0, bpp = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 6 && body[9] !== 2)) return { error: 'not 8-bit RGB(A)', w, h };
      bpp = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
                 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, at: (x, y) => { const o = (y * w + x) * bpp; return [px[o], px[o + 1], px[o + 2], bpp === 4 ? px[o + 3] : 255]; } };
}
