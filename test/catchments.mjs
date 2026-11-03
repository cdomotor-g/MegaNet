// The boundary layers on the Stations map: the 77 Queensland drainage basins
// and the Bureau's eight maintenance hubs (#179), and the council areas — the
// ABS's local government areas, lines first and shaded on request.
//
// Both draw from a file in this repo rather than from a service, so unlike the
// rivers there is nothing to seed and nothing to stub — the harness's own
// server hands over data/qld-basins.geojson and data/bom-hubs.geojson, and the
// page under test is the page in production.
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * Off by default. Both are context nobody asked for until they ask, and a
//     layer that turns itself on is a layer that gets turned off for good.
//   * Nothing takes the pointer. Same trap map-rivers.js documents: these panes
//     sit under the shared pins-and-links canvas, and a polygon the size of the
//     Burdekin that claimed a click would be swallowing one meant for a pin.
//   * The filter box emphasises basins and never *selects* stations with them.
//     "Catchments are context, never a match" is the whole contract with
//     stationsFilterChanged(), and it is one line away from being false.
//   * The number matches as well as the name. The Bureau's schedules are headed
//     "130 Fitzroy", so both halves of that have to find the basin.
//   * The geometry answers where a station is. catchmentAt/hubAt are what the
//     station card will read; they are checked here against towns whose basin
//     is not in dispute, because a point-in-polygon that is subtly wrong looks
//     exactly like one that is right.
//
// Run:  npm run catchments
//       npm run catchments -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // ── Off by default ────────────────────────────────────────────────────────
  const initial = await page.evaluate(() => ({
    catchments: state.mapCatchments,
    hubs: state.mapHubs,
    basinPaths: document.querySelectorAll('.leaflet-mnCatchments-pane path').length,
    hubPaths: document.querySelectorAll('.leaflet-mnHubs-pane path').length,
    catchNote: document.getElementById('map-catchment-note').textContent,
    hubNote: document.getElementById('map-hub-note').textContent,
  }));
  check('both layers are off on a first visit', initial.catchments === false && initial.hubs === false,
    JSON.stringify({ c: initial.catchments, h: initial.hubs }));
  check('an off layer has drawn nothing', initial.basinPaths === 0 && initial.hubPaths === 0,
    `${initial.basinPaths} basin, ${initial.hubPaths} hub paths`);
  check('each off layer says so in its own note',
    /hidden/i.test(initial.catchNote) && /hidden/i.test(initial.hubNote),
    JSON.stringify([initial.catchNote.trim(), initial.hubNote.trim()]));

  // ── Catchments on: all 77, none taking the pointer ─────────────────────────
  await page.evaluate(() => {
    state.map.setView([-22.5, 148.0], 6, { animate: false });
    MapCatchments.setEnabled(true);
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-mnCatchments-pane path').length > 0,
    null, { timeout: 20_000 });

  const drawn = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.leaflet-mnCatchments-pane path')];
    const pane = document.querySelector('.leaflet-mnCatchments-pane');
    return {
      total: paths.length,
      interactive: paths.filter((p) => p.classList.contains('leaflet-interactive')).length,
      panePointer: getComputedStyle(pane).pointerEvents,
      divisions: MapCatchments.divisions(),
      note: document.getElementById('map-catchment-note').textContent,
    };
  });
  check('every basin in the file draws', drawn.total >= 77, `${drawn.total} paths`);
  check('no basin claims the pointer — the pane is inert',
    drawn.interactive === 0 && drawn.panePointer === 'none',
    `${drawn.interactive} interactive, pane pointer-events: ${drawn.panePointer}`);
  check('the note counts the basins before anything matches',
    /77\s*<\/strong>|77/.test(drawn.note) && /Type a basin name/.test(drawn.note),
    drawn.note.trim().slice(0, 120));
  check('the legend key is one row per drainage division, five of them',
    drawn.divisions.length === 5
      && drawn.divisions.every((d) => d.color && d.basins > 0)
      && drawn.divisions.reduce((n, d) => n + d.basins, 0) === 77,
    JSON.stringify(drawn.divisions.map((d) => `${d.division}:${d.basins}`)));

  // ── The filter box emphasises, and never selects ──────────────────────────
  const before = await page.evaluate(() => filteredStations().length);
  await page.evaluate(() => {
    state.filters.searches = [{ text: 'fitzroy', name: true, number: true, alert: true }];
    stationsFilterChanged();
  });
  await page.waitForTimeout(400);

  const matched = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.mn-catchment-label')].map((e) => e.textContent.trim()),
    buttons: [...document.querySelectorAll('#map-catchment-note .mn-river-note-btn')]
      .map((b) => ({ id: b.dataset.catchment, tag: b.tagName })),
    note: document.getElementById('map-catchment-note').textContent,
  }));
  check('typing a basin name labels that basin on the map',
    matched.labels.includes('Fitzroy'), JSON.stringify(matched.labels));
  check('the note carries a real button per matched basin — the keyboard path',
    matched.buttons.length >= 1 && matched.buttons.every((b) => b.tag === 'BUTTON')
      && matched.buttons.some((b) => b.id === 'fitzroy'),
    JSON.stringify(matched.buttons));

  // The contract with stationsFilterChanged(): basins are drawn context. The
  // same filter must select the same stations whether the layer is on or off,
  // which is the only way to say "never a match" as a number.
  const withLayer = await page.evaluate(() => filteredStations().length);
  const withoutLayer = await page.evaluate(() => {
    MapCatchments.setEnabled(false);
    stationsFilterChanged();
    const n = filteredStations().length;
    MapCatchments.setEnabled(true);
    return n;
  });
  await page.waitForTimeout(400);
  check('the same filter selects the same stations with the layer on or off',
    withLayer === withoutLayer && withLayer < before,
    `on ${withLayer}, off ${withoutLayer}, unfiltered ${before}`);

  // ── The Bureau writes "130 Fitzroy", so the number finds it too ───────────
  await page.evaluate(() => {
    state.filters.searches = [{ text: '130', name: true, number: true, alert: true }];
    stationsFilterChanged();
  });
  await page.waitForTimeout(400);
  const byNumber = await page.evaluate(() =>
    [...document.querySelectorAll('#map-catchment-note .mn-river-note-btn')]
      .map((b) => b.dataset.catchment));
  check('a bare basin number matches the basin', byNumber.includes('fitzroy'),
    JSON.stringify(byNumber));

  // A number is matched whole, or "13" would light up 130, 131, 132 and 133.
  await page.evaluate(() => {
    state.filters.searches = [{ text: '13', name: true, number: true, alert: true }];
    stationsFilterChanged();
  });
  await page.waitForTimeout(400);
  const shortNumber = await page.evaluate(() =>
    [...document.querySelectorAll('#map-catchment-note .mn-river-note-btn')]
      .map((b) => b.dataset.catchment));
  check('a partial number matches no basin — "13" is not basin 130',
    !shortNumber.includes('fitzroy'), JSON.stringify(shortNumber));

  // ── The note button moves the map to its basin ────────────────────────────
  await page.evaluate(() => {
    state.filters.searches = [{ text: 'fitzroy', name: true, number: true, alert: true }];
    stationsFilterChanged();
  });
  await page.waitForTimeout(400);
  // Read once the map has finished moving, not straight after the call: a
  // change of four zoom levels or fewer is animated, and Leaflet only commits
  // the new centre when the animation ends. Whether this one is depends on
  // where the search left the map — which stations happen to be called
  // Fitzroy — so waiting is the only reading that does not depend on the data.
  const moved = await page.evaluate(() => new Promise((resolve) => {
    const before = state.map.getCenter();
    const done = () => {
      const after = state.map.getCenter();
      resolve({ moved: before.lat !== after.lat || before.lng !== after.lng,
                lat: after.lat, lon: after.lng });
    };
    state.map.once('moveend', done);
    MapCatchments.zoomTo('fitzroy');
    setTimeout(done, 5000);
  }));
  check('the note button takes the map to its basin',
    moved.moved && moved.lat < -21 && moved.lat > -26 && moved.lon > 146 && moved.lon < 152,
    JSON.stringify(moved));

  // ── Where a point actually is ─────────────────────────────────────────────
  const located = await page.evaluate(() => ({
    brisbane: MapCatchments.catchmentAt(-27.47, 153.028),
    rockhampton: MapCatchments.catchmentAt(-23.38, 150.51),
    townsville: MapCatchments.catchmentAt(-19.259, 146.8169),
    tasman: MapCatchments.catchmentAt(-35.0, 160.0),
  }));
  check('a point in the Brisbane basin says Brisbane',
    located.brisbane && located.brisbane.id === 'brisbane'
      && located.brisbane.basin_no === '143', JSON.stringify(located.brisbane));
  check('a point in the Fitzroy basin says Fitzroy',
    located.rockhampton && located.rockhampton.id === 'fitzroy', JSON.stringify(located.rockhampton));
  check('a point in the Ross basin says Ross',
    located.townsville && located.townsville.id === 'ross', JSON.stringify(located.townsville));
  check('a point in the Tasman Sea is in no basin, and says so with null',
    located.tasman === null, JSON.stringify(located.tasman));

  // ── Hubs ──────────────────────────────────────────────────────────────────
  await page.evaluate(() => MapHubs.setEnabled(true));
  await page.waitForFunction(
    () => document.querySelectorAll('.leaflet-mnHubs-pane path').length > 0,
    null, { timeout: 20_000 });

  const hubs = await page.evaluate(() => ({
    paths: document.querySelectorAll('.leaflet-mnHubs-pane path').length,
    interactive: document.querySelectorAll('.leaflet-mnHubs-pane path.leaflet-interactive').length,
    panePointer: getComputedStyle(document.querySelector('.leaflet-mnHubs-pane')).pointerEvents,
    labels: [...document.querySelectorAll('.mn-hub-label')].map((e) => e.textContent.trim()).sort(),
    key: MapHubs.hubs(),
    brisbane: MapHubs.hubAt(-27.47, 153.028),
    cairns: MapHubs.hubAt(-16.92, 145.77),
    note: document.getElementById('map-hub-note').textContent,
  }));
  check('the eight hubs draw', hubs.paths >= 8, `${hubs.paths} paths`);
  check('no hub claims the pointer — the pane is inert',
    hubs.interactive === 0 && hubs.panePointer === 'none',
    `${hubs.interactive} interactive, pane pointer-events: ${hubs.panePointer}`);
  check('every hub is named on the map', hubs.labels.length === 8
    && hubs.labels.includes('Brisbane Hub') && hubs.labels.includes('Cairns Hub'),
    JSON.stringify(hubs.labels));
  check('the legend key is one row per hub, each with the colour it is drawn in',
    hubs.key.length === 8 && hubs.key.every((h) => /^#[0-9a-f]{6}$/i.test(h.color)),
    JSON.stringify(hubs.key.map((h) => `${h.id}:${h.color}`)));
  check('Brisbane is in the Brisbane hub and Cairns in the Cairns hub',
    hubs.brisbane && hubs.brisbane.id === 'brisbane' && hubs.cairns && hubs.cairns.id === 'cairns',
    JSON.stringify([hubs.brisbane, hubs.cairns]));

  // ── The document carries both, so the app never has to ask the geometry ───
  const doc = await page.evaluate(() => {
    const s = state.data.stations.find((x) => x.id === 'brisbane_bar_tide_tm')
           || state.data.stations.find((x) => x.hub_id);
    return {
      hubs: (state.data.hubs || []).length,
      catchments: state.data.catchments.length,
      withDivision: state.data.catchments.filter((c) => c.division).length,
      sample: s && { id: s.id, hub_id: s.hub_id, catchment_ids: s.catchment_ids },
      stationsWithHub: state.data.stations.filter((x) => x.hub_id).length,
    };
  });
  check('stations.json carries the hub vocabulary', doc.hubs === 8, JSON.stringify(doc.hubs));
  check('every catchment carries its drainage division',
    doc.catchments === 77 && doc.withDivision === 77,
    `${doc.withDivision} of ${doc.catchments}`);
  check('every station with a position carries the hub that maintains it',
    doc.stationsWithHub >= 3173, `${doc.stationsWithHub} stations`);
  check('a station carries both facts, and its catchment ids are basin ids',
    !!doc.sample && !!doc.sample.hub_id && Array.isArray(doc.sample.catchment_ids),
    JSON.stringify(doc.sample));

  // ── Council areas (map-councils.js): off, then on, lines, names, shading ───
  const cOff = await page.evaluate(() => ({
    on: state.mapCouncils,
    paths: document.querySelectorAll('.leaflet-mnCouncils-pane path').length,
    note: document.getElementById('map-council-note').textContent,
    shadeRow: !!document.querySelector('[aria-label="Council area shading opacity"]'),
  }));
  check('council areas are off on a first visit and have drawn nothing',
    cOff.on === false && cOff.paths === 0 && /hidden/i.test(cOff.note) && !cOff.shadeRow, JSON.stringify(cOff));

  await page.evaluate(() => {
    state.map.setView([-27.55, 152.75], 9, { animate: false });
    MapCouncils.setEnabled(true);
  });
  await page.waitForFunction(() => MapCouncils.active()
    && document.querySelectorAll('.leaflet-mnCouncils-pane path').length > 0, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  const cOn = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.leaflet-mnCouncils-pane path')];
    return {
      total: paths.length,
      interactive: paths.filter((p) => p.classList.contains('leaflet-interactive')).length,
      panePointer: getComputedStyle(document.querySelector('.leaflet-mnCouncils-pane')).pointerEvents,
      filled: paths.filter((p) => Number(p.getAttribute('fill-opacity') || 0) > 0).length,
      labels: [...document.querySelectorAll('.mn-council-label')].map((e) => e.textContent.trim()),
      shadeBox: !!document.querySelector('input[onchange^="MapCouncils.setShade"]'),
      legend: (document.getElementById('map-legend') || {}).textContent || '',
      stored: localStorage.getItem('mn-councils'),
    };
  });
  check('every council area in the file draws, all states', cOn.total >= 540, `${cOn.total} paths`);
  check('no council area claims the pointer — the pane is inert',
    cOn.interactive === 0 && cOn.panePointer === 'none',
    `${cOn.interactive} interactive, pane pointer-events: ${cOn.panePointer}`);
  check('lines only until shading is asked for', cOn.filled === 0, `${cOn.filled} filled`);
  check('the councils in view are named at zoom 9 — Brisbane, Ipswich, Logan',
    ['Brisbane', 'Ipswich', 'Logan'].every((n) => cOn.labels.includes(n)), JSON.stringify(cOn.labels.slice(0, 15)));
  check('the shading switch appears under the layer once it is on, and the choice is remembered',
    cOn.shadeBox && cOn.stored === 'on', JSON.stringify({ box: cOn.shadeBox, stored: cOn.stored }));
  check('the legend keys the boundary line', /Council area \(LGA\) boundary/.test(cOn.legend), cOn.legend.slice(0, 80));

  await page.evaluate(() => MapCouncils.setShade(true));
  await page.waitForTimeout(200);
  const shaded = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.leaflet-mnCouncils-pane path')];
    const ops = new Set(paths.map((p) => p.getAttribute('fill-opacity')));
    return {
      filled: paths.filter((p) => Number(p.getAttribute('fill-opacity') || 0) > 0).length,
      total: paths.length, ops: [...ops],
      slider: !!document.querySelector('[aria-label="Council area shading opacity"]'),
      tints: (document.getElementById('map-legend') || {}).textContent.includes('never a neighbour'),
    };
  });
  check('shading fills every council area, with the opacity slider and the tints in the key',
    shaded.filled === shaded.total && shaded.slider && shaded.tints, JSON.stringify(shaded));
  await page.evaluate(() => MapCouncils.setOpacity(0.5));
  const op = await page.evaluate(() => document.querySelector('.leaflet-mnCouncils-pane path').getAttribute('fill-opacity'));
  check('the slider restyles in place', op === '0.5', String(op));

  // No two neighbours share a tint: the build tool's promise, checked on the
  // file the page draws — councils sharing a vertex are neighbours.
  const tints = await page.evaluate(async () => {
    const fc = await MapCouncils.ready();
    const owner = new Map();
    let clash = [];
    fc.features.forEach((f, i) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of polys) for (const r of p) for (const [x, y] of r) {
        const k = x + ',' + y, o = owner.get(k);
        if (o == null) { owner.set(k, i); continue; }
        if (o !== i && fc.features[o].properties.c === f.properties.c) clash.push(f.properties.name + '/' + fc.features[o].properties.name);
      }
    });
    clash = [...new Set(clash)];
    return { n: fc.features.length, clash: clash.slice(0, 5), noLabel: fc.features.filter((f) => !f.properties.lp).length };
  });
  check('no two neighbouring councils share a tint, and every one has a label point',
    tints.clash.length === 0 && tints.noLabel === 0, JSON.stringify(tints));

  await page.evaluate(() => { MapCouncils.setShade(false); MapCouncils.setEnabled(false); });
  await page.waitForTimeout(200);
  const cGone = await page.evaluate(() => ({
    paths: document.querySelectorAll('.leaflet-mnCouncils-pane path').length,
    labels: document.querySelectorAll('.mn-council-label').length,
  }));
  check('the off switch takes the council lines and names together', cGone.paths === 0 && cGone.labels === 0, JSON.stringify(cGone));

  // ── Off again ─────────────────────────────────────────────────────────────
  await page.evaluate(() => { MapCatchments.setEnabled(false); MapHubs.setEnabled(false); });
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({
    basinPaths: document.querySelectorAll('.leaflet-mnCatchments-pane path').length,
    hubPaths: document.querySelectorAll('.leaflet-mnHubs-pane path').length,
    labels: document.querySelectorAll('.mn-catchment-label, .mn-hub-label').length,
    catchNote: document.getElementById('map-catchment-note').textContent,
    hubNote: document.getElementById('map-hub-note').textContent,
  }));
  check('the off switch takes the polygons and their labels together',
    off.basinPaths === 0 && off.hubPaths === 0 && off.labels === 0
      && /hidden/i.test(off.catchNote) && /hidden/i.test(off.hubNote),
    JSON.stringify(off));

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
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the boundaries draw, stay out of the way, and answer where a station is.');
