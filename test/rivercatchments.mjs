// A river's catchment, and a gauge's (river-catchments.js): the outlines
// tools/build_catchments.py writes from the Geofabric, drawn when a river is
// selected or a station's card asks, and shaded by the height of their own
// ground.
//
// The files are the site's own, so they are read for real. The terrain is
// not — the AWS tiles are off-origin — so the tile host is answered with the
// harness's hilly world (lib/terrarium.mjs), which is ground with relief in
// it everywhere: enough for a height range to be found and a ramp to be laid
// over it, and the same world every run. Then the host is cut off, and the
// catchment has to fall back to its flat wash and say so.
//
// Run:  npm run rivercatchments
//       npm run rivercatchments -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// ── The files ────────────────────────────────────────────────────────────────
const DIR = path.join(REPO_ROOT, 'data', 'catchments-au');
const INDEX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const RIVERS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'rivers-au.json'), 'utf8'));
const STATIONS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8')).stations;

check('the index credits the Bureau and carries its licence',
  /Bureau of Meteorology/.test(INDEX.meta.attribution || '') && INDEX.meta.licence === 'CC BY 4.0', INDEX.meta.attribution);
check('one river entry per river in the rivers file', INDEX.rivers.length === RIVERS.rivers.length,
  `${INDEX.rivers.length} against ${RIVERS.rivers.length}`);
const named = new Set([...INDEX.rivers.filter(Boolean).map(r => `r${r[1]}`),
                       ...Object.values(INDEX.stations).map(s => `s${s[1]}`)]);
const onDisk = new Set(fs.readdirSync(DIR).filter(f => f !== 'index.json').map(f => f.replace(/\.json$/, '')));
check('every file the index names is on disk, and no other',
  [...named].every(n => onDisk.has(n)) && [...onDisk].every(n => named.has(n)), `${named.size} named, ${onDisk.size} on disk`);

const bRid = RIVERS.rivers.findIndex(r => r[0] === 'BURDEKIN RIVER');
const bRow = INDEX.rivers[bRid];
// The Burdekin's basin is 129,860 km² by the Bureau's own count. The
// network's drainage area at its mouth is 94,000-odd — short by the
// Belyando–Suttor country — which is why the callout leads with the
// catchment's figure, and why this checks against the basin's.
check('the Burdekin\'s catchment is its whole basin, within 7 % of the Bureau\'s 129,860 km²',
  !!bRow && Math.abs(bRow[0] / 129860 - 1) < 0.07, JSON.stringify(bRow));
const gauges = Object.entries(INDEX.stations).filter(([, v]) => v[2] === 'gauge');
// Most of this network's gauges are the Bureau's flood warning gauges and
// most of the Geofabric's gauged nodes are the States' water-monitoring ones,
// so the two lists meet at about a hundred stations; the rest are placed on
// their stream.
check('the gauges that are also gauged nodes of the Geofabric have the Bureau\'s own catchment',
  gauges.length > 50, `${gauges.length} gauges`);
const reach = Object.values(INDEX.stations).filter(v => v[2] === 'reach').length;
const near = Object.values(INDEX.stations).filter(v => v[2] === 'near').length;
check('…hundreds more are traced up the fine catchments from the reach they stand on',
  reach > 400, `${reach} by reach`);
check('…and the rest of those on a stream are placed at the nearer sub-catchment boundary',
  reach + near > 900, `${reach} by reach, ${near} near`);
const covered = INDEX.rivers.filter(Boolean).length;
check('four rivers in five have a catchment, the small creeks inside a big river\'s sub-catchment cut from the fine ones',
  covered / INDEX.rivers.length > 0.78 && INDEX.meta.rivers_from_fine > 400,
  `${covered} of ${INDEX.rivers.length}, ${INDEX.meta.rivers_from_fine} from the fine catchments`);
const ratio = INDEX.meta.river_area_ratio_median;
check('a river\'s catchment matches the area its own network says drains to its mouth, at the median',
  ratio > 0.9 && ratio < 1.1, String(ratio));

// A gauged station with a position, for the card.
const [gid, gRow] = gauges.find(([id]) => {
  const s = STATIONS.find(x => String(x.id) === id);
  return s && s.lat != null;
});
const gStation = STATIONS.find(x => String(x.id) === gid);

let terrain = true;
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, look: 'calm' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
    if (!terrain) return route.abort('blockedbyclient');
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                           headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  check('a first visit has a selected river\'s catchment switched on', await page.evaluate(() => state.mapRiverCatchment === true));
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && MapRiverLines.active(), null, { timeout: 30_000 });

  // ── Select the Burdekin: its catchment, outlined, then shaded ─────────────
  await page.evaluate(() => MapRiverLines.selectNamed('Burdekin River', { lat: -20, lon: 147 }));
  await page.waitForFunction(() => { const s = RiverCatchments.shown(); return s && /relief|flat|fail|none/.test(s.status); },
    null, { timeout: 30_000 }).catch(() => {});
  const shown = await page.evaluate(() => RiverCatchments.shown());
  check('selecting the Burdekin shows its catchment, shaded by height', shown && shown.kind === 'river'
    && shown.key === bRid && shown.status === 'relief', JSON.stringify(shown));
  check('…its ramp runs over its own ground\'s range, not a fixed one',
    shown && shown.range && shown.range.hi - shown.range.lo > 50 && shown.range.hi < 1000, JSON.stringify(shown && shown.range));

  await page.evaluate((b) => { state.map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }, JSON.parse(fs.readFileSync(path.join(DIR, `r${bRow[1]}.json`), 'utf8'))[String(bRid)].box);
  await page.waitForTimeout(2500);
  const drawn = await page.evaluate(() => {
    const edge = document.querySelectorAll('.leaflet-mnCatchLine-pane path.mn-catch-edge').length;
    const wash = document.querySelectorAll('.leaflet-mnCatchLine-pane path.mn-catch-wash').length;
    const panes = ['mnCatchRelief', 'mnCatchLine'].map(p => getComputedStyle(document.querySelector(`.leaflet-${p}-pane`)).pointerEvents);
    let painted = 0, blank = 0, cut = 0;
    for (const c of document.querySelectorAll('.leaflet-mnCatchRelief-pane canvas')) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let on = 0;
      for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) on++;
      const all = d.length / 4 / 7;
      if (!on) blank++; else painted++;
      if (on && on < all * 0.95) cut++;
    }
    return { edge, wash, panes, painted, blank, cut };
  });
  check('the outline is drawn, edge and wash', drawn.edge === 1 && drawn.wash === 1, JSON.stringify(drawn));
  check('the relief is painted inside it and nowhere outside: the tiles across its edge are cut to it',
    drawn.painted > 0 && drawn.cut > 0, JSON.stringify(drawn));
  check('neither pane takes the pointer', drawn.panes.every(p => p === 'none'), JSON.stringify(drawn.panes));

  const legend = await page.evaluate(() => document.getElementById('map-legend')?.textContent.replace(/\s+/g, ' ') || '');
  check('the legend names the catchment, its area and the heights its ramp runs between',
    /Catchment of Burdekin River — [\d,]+ km², shaded by its own ground from -?[\d,]+ m to [\d,]+ m/.test(legend),
    legend.slice(legend.indexOf('Catchment of'), legend.indexOf('Catchment of') + 200));
  const attrib = await page.evaluate(() => document.querySelector('.leaflet-control-attribution')?.textContent || '');
  check('the map credits the catchments to the Bureau', /Catchments: Geofabric/.test(attrib), attrib.slice(0, 200));

  await page.evaluate((rid) => MapRiverLines.pick(String(rid)), bRid);
  await page.waitForTimeout(400);
  const callout = await page.evaluate(() => document.querySelector('.mn-rl-popup .leaflet-popup-content')?.textContent.replace(/\s+/g, ' ') || '');
  check('the river\'s callout leads with its catchment\'s area', /River · catchment [\d,]+ km², outlined on the map/.test(callout), callout.slice(0, 200));

  // ── Put down with the river ───────────────────────────────────────────────
  await page.evaluate(() => MapRiverLines.clearSelection());
  await page.waitForTimeout(300);
  const gone = await page.evaluate(() => ({ shown: RiverCatchments.shown(),
    paths: document.querySelectorAll('.leaflet-mnCatchLine-pane path').length,
    tiles: document.querySelectorAll('.leaflet-mnCatchRelief-pane canvas').length }));
  check('putting the river down takes its catchment with it', gone.shown === null && gone.paths === 0 && gone.tiles === 0, JSON.stringify(gone));

  // ── The switch ────────────────────────────────────────────────────────────
  await page.evaluate(() => MapRiverLines.setCatchment(false));
  await page.evaluate(() => MapRiverLines.selectNamed('Burdekin River', { lat: -20, lon: 147 }));
  await page.waitForTimeout(800);
  const off = await page.evaluate(() => ({ shown: RiverCatchments.shown(), sel: MapRiverLines.selected(),
    stored: localStorage.getItem('mn-river-catchment') }));
  check('with the switch off a river selects alone, and the choice is remembered',
    off.shown === null && off.sel && off.sel.title === 'Burdekin River' && off.stored === 'off', JSON.stringify(off));
  await page.evaluate(() => MapRiverLines.setCatchment(true));
  await page.waitForFunction(() => { const s = RiverCatchments.shown(); return s && s.status !== 'loading'; }, null, { timeout: 30_000 }).catch(() => {});
  check('turning it back on shows the selected river\'s catchment', await page.evaluate(() => (RiverCatchments.shown() || {}).key) === bRid);
  await page.evaluate(() => MapRiverLines.clearSelection());

  // ── A gauge's catchment, from its card ────────────────────────────────────
  await page.evaluate((id) => showStationCard(id), gStation.id);
  await page.waitForFunction((id) => /km²/.test(document.getElementById(`mn-catch-card-${id}`)?.textContent || ''),
    String(gStation.id), { timeout: 15_000 }).catch(() => {});
  const card = await page.evaluate((id) => document.getElementById(`mn-catch-card-${id}`)?.textContent.replace(/\s+/g, ' ') || '', String(gStation.id));
  check('a gauged station\'s card gives the area above its gauge, and says it is the Bureau\'s own',
    card.includes(`${Math.round(gRow[0]).toLocaleString('en-AU')} km²`) && /gauging station/.test(card), card.slice(0, 220));
  const [rid, rRow] = Object.entries(INDEX.stations).find(([id, v]) => v[2] === 'reach'
    && STATIONS.some(x => String(x.id) === id && x.lat != null));
  await page.evaluate((id) => showStationCard(id), rid);
  await page.waitForFunction((id) => /km²/.test(document.getElementById(`mn-catch-card-${id}`)?.textContent || ''),
    rid, { timeout: 15_000 }).catch(() => {});
  const rCard = await page.evaluate((id) => document.getElementById(`mn-catch-card-${id}`)?.textContent.replace(/\s+/g, ' ') || '', rid);
  check('a station traced from its reach says so on its card',
    rCard.includes(`${Math.round(rRow[0]).toLocaleString('en-AU')} km²`) && /traced up the Geofabric's finest catchments/.test(rCard),
    rCard.slice(0, 220));
  await page.evaluate((id) => showStationCard(id), gStation.id);
  await page.waitForTimeout(300);
  await page.click(`#mn-catch-card-${gStation.id} button`);
  await page.waitForFunction(() => { const s = RiverCatchments.shown(); return s && s.kind === 'station' && s.status !== 'loading'; },
    null, { timeout: 30_000 }).catch(() => {});
  const st = await page.evaluate((s) => ({ shown: RiverCatchments.shown(),
    inView: state.map.getBounds().contains([s.lat, s.lon]) }), { lat: gStation.lat, lon: gStation.lon });
  check('“Show the catchment on the map” shows it and takes the map there',
    st.shown && st.shown.kind === 'station' && st.shown.key === String(gStation.id) && st.inView, JSON.stringify(st));
  const legend2 = await page.evaluate(() => document.getElementById('map-legend')?.textContent.replace(/\s+/g, ' ') || '');
  check('…and the legend calls it the catchment above the station', legend2.includes(`Catchment above ${gStation.name}`), legend2.slice(0, 200));
  await page.evaluate(() => clearStationsMapMarks());
  check('🧹 puts a gauge\'s catchment down too', await page.evaluate(() => RiverCatchments.shown() === null));

  // ── No terrain: the wash, and the legend says why ─────────────────────────
  terrain = false;
  await page.evaluate(() => MapRiverLines.selectNamed('Brisbane River', { lat: -27.5, lon: 152.9 }));
  await page.waitForFunction(() => { const s = RiverCatchments.shown(); return s && /relief|flat|fail|none/.test(s.status); },
    null, { timeout: 30_000 }).catch(() => {});
  const flat = await page.evaluate(() => ({ shown: RiverCatchments.shown(),
    legend: document.getElementById('map-legend')?.textContent.replace(/\s+/g, ' ') || '',
    edge: document.querySelectorAll('.leaflet-mnCatchLine-pane path.mn-catch-edge').length }));
  check('with no terrain the catchment is still outlined and washed, and the legend says why',
    flat.shown && flat.shown.status === 'flat' && flat.edge === 1 && /no terrain to shade it with/.test(flat.legend),
    JSON.stringify({ status: flat.shown && flat.shown.status, edge: flat.edge }));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — a selected river and a station\'s gauge show the land that drains to them, shaded by its own ground.');
