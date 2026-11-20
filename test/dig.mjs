// 🚧 Before you dig (map-dig.js) and its view in the Property group: a spot
// and a trench's line checked against the open-data services, each finding
// banded red, amber or for the record by how near it is, and the check sheet.
//
// Every service is external and this harness blocks outbound requests, so
// the check stubs them, placing things a known distance from where it asks:
//
//   * Geoscience Australia: a 132 kV transmission line 12 m east of the spot
//     and a gas pipeline 45 m north (amber at a 30 m ring);
//   * Energex: an underground low-voltage cable 5 m south, and an overhead
//     11 kV line 300 m off (fetched, too far, left out);
//   * the cadastre: the lot the spot is on (freehold) with its boundary 8 m
//     west, a road parcel past it, and an easement through the spot;
//   * the soil service: likely acid sulfate soil at 1:50 000, and a Vertosol;
//   * the zones, heritage and flood questions as More map layers asks them.
//
// Run:  npm run dig
//       npm run dig -- -v    also print what passed

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
const J = x => JSON.stringify(x);

const SPOT = { lat: -27.5, lon: 152.95 };
const KX = 111320 * Math.cos(SPOT.lat * Math.PI / 180), KY = 110574;
// [east m, north m] from the spot to [lon, lat].
const at = (e, n) => [SPOT.lon + e / KX, SPOT.lat + n / KY];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HOSTS = /(services\.ga\.gov\.au|spatial-gis\.information\.qld\.gov\.au\/arcgis|gis\.environment\.gov\.au|services\d?\.arcgis\.com|api\.ala\.org\.au|ows\.dea\.ga\.gov\.au|data\.gov\.au\/geoserver)/;

const asked = [];
function answer(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  asked.push({ path: u.pathname, params: p });
  const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const path = u.pathname;
  if (/\/export$/.test(path)) return { status: 200, contentType: 'image/png', body: PNG };
  if (/\/legend$/.test(path)) return json({ layers: [] });
  const line = (a, b, attributes) => ({ attributes, geometry: { paths: [[at(...a), at(...b)]] } });
  const ring = (pts, attributes) => ({ attributes, geometry: { rings: [pts.map(q => at(...q))] } });

  if (/Electricity_Infrastructure\/MapServer\/2\/query$/.test(path)) {
    return json({ features: [line([12, -200], [12, 200], { feature_name: 'Example 132', feature_subtype: 'Overhead', capacity_kv: 132 })] });
  }
  if (/Oil_Gas_Pipelines\/MapServer\/1\/query$/.test(path)) {
    return json({ features: [line([-200, 45], [200, 45], { feature_name: 'Example Gas Line', operator: 'Example Co' })] });
  }
  if (/MapServer\/\d+\/query$/.test(path) && /services\.ga\.gov\.au/.test(u.host)) return json({ features: [] });
  if (/Network_Energex\/FeatureServer\/query$/.test(path)) {
    return json({ layers: [
      { id: 13, features: [line([-100, -5], [100, -5], { VOLTAGE: 'LV', UG_OH: 'U' })] },
      { id: 10, features: [line([300, -100], [300, 100], { VOLTAGE: '11kV', UG_OH: 'O' })] },
    ] });
  }
  if (/Network_Extract\/FeatureServer\/query$/.test(path)) return json({ layers: [] });
  if (/LandParcelPropertyFramework\/MapServer\/4\/query$/.test(path)) {
    return json({ features: [
      ring([[-8, -50], [60, -50], [60, 50], [-8, 50]], { lotplan: '3RP12345', parcel_typ: 'Lot Type Parcel', cover_typ: 'Base', tenure: 'Freehold' }),
      ring([[-28, -80], [-8, -80], [-8, 80], [-28, 80]], { lotplan: null, parcel_typ: 'Road Type Parcel', cover_typ: 'Base', tenure: null }),
      ring([[-3, -50], [3, -50], [3, 50], [-3, 50]], { lotplan: 'AEX1', parcel_typ: 'Easement', cover_typ: 'Easement', tenure: 'Easement' }),
    ] });
  }
  if (/SoilsAndLandResource\/MapServer\/1952\/query$/.test(path)) {
    return json({ features: [{ attributes: { map_code: 'P', map_code_meaning: 'Potential acid sulfate soil within 1 m of the surface' } }] });
  }
  if (/SoilsAndLandResource\/MapServer\/156\/query$/.test(path)) {
    return json({ features: [{ attributes: { asc_ord: 'Vertosol', map_code_meaning: 'Grey cracking clays', project_code: 'TEST' } }] });
  }
  if (/SoilsAndLandResource\/MapServer\/\d+\/query$/.test(path)) return json({ features: [] });
  if (/\/identify$/.test(path)) {
    if (/Biosecurity/.test(path)) return json({ results: [{ layerId: 65, layerName: 'Fire ant', value: 'Fire ant biosecurity zone 2', attributes: { 'Biosecurity zone': 'Fire ant biosecurity zone 2' } }] });
    if (/CulturalHeritage/.test(path)) return json({ results: [{ layerId: 1, layerName: 'party', value: 'Example People', attributes: { Name: 'Example People' } }] });
    // The hover tip (map-feed-tip.js) asks the pictures' services this way.
    if (/Electricity_Infrastructure/.test(path)) return json({ results: [{ layerId: 2, layerName: 'Power Lines', value: 'Example 132', attributes: { 'Feature Name': 'Example 132', 'Feature Subtype': 'Overhead', Capacity_kV: '132' } }] });
    if (/Oil_Gas_Pipelines/.test(path)) return json({ results: [{ layerId: 1, layerName: 'Gas_Pipelines', value: 'Example Gas Line', attributes: { feature_name: 'Example Gas Line', operator: 'Example Co', status: 'Operational' } }] });
    if (/SoilsAndLandResource/.test(path)) {
      return json({ results: [
        { layerId: 2052, layerName: 'national', value: 'A', attributes: { 'Probability class definition': 'High probability of occurrence' } },
        { layerId: 1952, layerName: '1:50 000', value: 'P', attributes: { 'Map code meaning': 'Potential acid sulfate soil within 1 m of the surface' } },
        { layerId: 156, layerName: 'ASC', value: 'x', attributes: { 'Australian Soil Classification Order': 'Vertosol' } },
      ] });
    }
    return json({ results: [] });
  }
  if (/FeatureServer\/\d+\/query$/.test(path)) return json({ features: [] });
  return json({ features: [], layers: [], results: [] });
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route(HOSTS, route => route.fulfill({ ...answer(route.request().url()), headers: { 'Access-Control-Allow-Origin': '*' } }));
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // ── 1. The view ──────────────────────────────────────────────────────────
  console.log('1. The Before you dig view');
  const v = await page.evaluate(() => {
    const view = MapViews.VIEWS.find(x => x.id === 'dig');
    MapViews.apply('dig');
    return { view: view && { group: view.group, label: view.label, feeds: view.knobs.feeds }, active: MapViews.active(),
      on: MapFeeds.enabledList(), dig: !!state.mapDig, wind: !!state.mapWind, lots: !!state.mapLots, easements: !!state.mapEasements };
  });
  check('the view is in the Property group, called Before you dig', v.view && v.view.group === 'property' && v.view.label === 'Before you dig', J(v));
  check('it turns on the power, pipe, heritage and acid sulfate layers, the property lines, easements and wind regions',
    ['ga-power', 'ga-pipes', 'qld-network', 'qld-heritage', 'qld-acid-sulfate'].every(id => v.on.includes(id)) && v.wind && v.lots && v.easements && v.dig, J(v));
  const armed = await page.evaluate(() => ({ live: MapDig.live(), cls: state.map.getContainer().classList.contains('dig-arming') }));
  check('and arms the map for a spot', armed.live && armed.cls, J(armed));
  const head = await page.evaluate(() => {
    const h = document.querySelector('.mv-role--property .mv-role-h');
    return h ? getComputedStyle(h).backgroundColor : null;
  });
  check('a view group\'s heading is a band in its colour', head && head !== 'rgba(0, 0, 0, 0)' && head !== 'transparent', String(head));

  // ── 2. A spot ────────────────────────────────────────────────────────────
  console.log('2. Check a spot');
  await page.evaluate(({ lat, lon }) => { state.map.setView([lat, lon], 17); }, SPOT);
  await page.waitForTimeout(300);
  const pt = await page.evaluate(({ lat, lon }) => { const p = state.map.latLngToContainerPoint([lat, lon]); const r = state.map.getContainer().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, SPOT);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => { const r = MapDig.result(); return r && r.done; }, null, { timeout: 20_000 }).catch(() => {});
  const r1 = await page.evaluate(() => { const r = MapDig.result(); return r && { count: r.count, rows: r.shown.map(x => ({ band: x.band, kind: x.kind, what: x.what, m: x.m == null ? null : Math.round(x.m), detail: x.detail })) }; });
  const find = (re, rows = r1 && r1.rows) => (rows || []).find(x => re.test(x.what));
  check('a tap on the map checks that spot', !!r1 && r1.rows.length > 0, J(r1));
  const tx = find(/Transmission line 132 kV/);
  check('the 132 kV line 12 m off is red, with its crane exclusion zone', tx && tx.band === 'red' && tx.kind === 'over' && Math.abs(tx.m - 12) <= 1 && /exclusion zone 3 m/.test(tx.detail), J(tx));
  const gas = find(/Gas pipeline/);
  check('the gas pipeline 45 m off is amber (inside twice a 30 m ring)', gas && gas.band === 'amber' && Math.abs(gas.m - 45) <= 1, J(gas));
  const cab = find(/Underground cable/);
  check('Energex\'s underground cable 5 m off is red', cab && cab.band === 'red' && cab.kind === 'under' && Math.abs(cab.m - 5) <= 1, J(cab));
  check('the 11 kV line 300 m off is left out', !find(/Overhead line/), J(r1 && r1.rows.map(x => x.what)));
  const lot = find(/On lot 3RP12345/), bnd = find(/Lot boundary/), road = find(/Road reserve/), ease = find(/Inside an easement/);
  check('the lot it is on, freehold, and whose permission that needs', lot && /Freehold — the landholder/.test(lot.detail), J(lot));
  check('the lot boundary 8 m off is amber', bnd && bnd.band === 'amber' && Math.abs(bnd.m - 8) <= 1, J(bnd));
  check('the road reserve past it is amber', road && road.band === 'amber', J(road));
  check('the easement through the spot is red', ease && ease.band === 'red', J(ease));
  const ass = find(/acid sulfate/i), soil = find(/Soil: Vertosol/);
  check('likely acid sulfate soil is red, quoting the map\'s words and scale', ass && ass.band === 'red' && /1:50 000/.test(ass.detail), J(ass));
  check('the Vertosol is amber, in plain words', soil && soil.band === 'amber' && /swells/.test(soil.detail), J(soil));
  check('the fire ant zone and the heritage party are named', !!find(/Fire ant/) && !!find(/Cultural heritage/), J(r1 && r1.rows.map(x => x.what)));
  check('red first, then amber, then the record', r1 && r1.rows.map(x => x.band).join(',') === [...r1.rows.map(x => x.band)].sort((a, b) => ({ red: 0, amber: 1, info: 2 })[a] - ({ red: 0, amber: 1, info: 2 })[b]).join(','), J(r1 && r1.rows.map(x => x.band)));
  const panel = await page.evaluate(() => {
    const w = document.querySelector('.mn-mapctl[data-panel="dig"]');
    const el = w && w.querySelector('.dig-panel');
    return el && { open: w.classList.contains('is-open') || w.classList.contains('is-docked'), text: el.textContent.replace(/\s+/g, ' '),
      bands: el.querySelectorAll('.dig-band[title]').length, terms: el.querySelectorAll('.term[title]').length, words: !!el.querySelector('details.bestrep-words'),
      byda: !!el.querySelector('a[href^="https://www.byda.com.au"]') };
  });
  check('the panel opened with the list, each band titled with its meaning', panel && panel.open && panel.bands >= 8, J(panel && { open: panel.open, bands: panel.bands }));
  check('it says what the open data leaves out, and links to Before You Dig Australia', panel && /Not shown here/.test(panel.text) && /Telecommunications/.test(panel.text) && panel.byda, '');
  check('the words fold is there for a finger', panel && panel.words && panel.terms >= 3, J(panel && { words: panel.words, terms: panel.terms }));
  const drawn = await page.evaluate(() => MapDig.drawnCount());
  check('the ring and what is in it are drawn on the map', drawn >= 4, String(drawn));

  // ── 3. Overhead only, and a wider ring ───────────────────────────────────
  console.log('3. Overhead only; the ring');
  await page.evaluate(() => MapDig._show('over'));
  const over = await page.evaluate(() => MapDig.result().shown.map(x => x.kind));
  check('Overhead (cranes) leaves the cables and pipes out and keeps the land', !over.includes('under') && over.includes('over') && over.includes('land'), J(over));
  await page.evaluate(() => MapDig._show('both'));
  await page.evaluate(() => MapDig._ring(50));
  await page.waitForFunction(() => { const r = MapDig.result(); return r && r.done && r.r === 50; }, null, { timeout: 20_000 }).catch(() => {});
  const wide = await page.evaluate(() => MapDig.result().shown.find(x => /Gas pipeline/.test(x.what)));
  check('at a 50 m ring the gas pipeline 45 m off is red', wide && wide.band === 'red', J(wide));
  await page.evaluate(() => MapDig._ring(30));
  await page.waitForFunction(() => { const r = MapDig.result(); return r && r.done && r.r === 30; }, null, { timeout: 20_000 }).catch(() => {});

  // ── 4. The check sheet ───────────────────────────────────────────────────
  console.log('4. The check sheet');
  const sheet = await page.evaluate(() => MapDig.sheetHtml());
  check('the sheet lists the findings, says it is not a locate, and leaves room for the BYDA number',
    /Before you dig — site check/.test(sheet) && /not a locate/.test(sheet) && /Transmission line 132 kV/.test(sheet) && /Before You Dig request number/.test(sheet), sheet.slice(0, 200));
  check('it says Flood-Net, never the repository\'s name', /Flood-Net/.test(sheet) && !/MegaNet/.test(sheet));
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.evaluate(() => MapDig._save())]);
  check('Save check sheet saves floodnet-dig-check-….html', download && /^floodnet-dig-check-\d{4}-\d{2}-\d{2}\.html$/.test(download.suggestedFilename()), download && download.suggestedFilename());

  // ── 5. A trench's line ───────────────────────────────────────────────────
  console.log('5. Draw a dig line');
  asked.length = 0;
  const l = await page.evaluate(({ lat, lon }) => MapDig.checkLine([[lat, lon - 0.0006], [lat, lon], [lat, lon + 0.0006]]).then(r => ({
    pts: 3, rows: r.shown.map(x => ({ what: x.what, band: x.band, m: x.m == null ? null : Math.round(x.m) })) })), SPOT);
  const ltx = l.rows.find(x => /Transmission line/.test(x.what));
  check('a line that crosses the transmission line puts it at 0 m, red', ltx && ltx.m === 0 && ltx.band === 'red', J(ltx));
  check('the line is asked as a box round it, not point by point', asked.some(a => a.params.geometryType === 'esriGeometryEnvelope'), '');
  await page.evaluate(() => MapDig.clear());
  check('Clear takes it off the map', await page.evaluate(() => !MapDig.live() && MapDig.drawnCount() === 0));

  // ── 6. The hover tip over More map layers ────────────────────────────────
  console.log('6. What the layers show under the pointer');
  await page.evaluate(() => { MapViews.apply('dig'); MapDig.clear(); MapFeeds.setEnabled('qld-soils', true); state.map.setView([-27.5, 152.95], 17); });
  await page.waitForTimeout(400);
  const lines = await page.evaluate(({ lat, lon }) => MapFeedTip.linesAt(lat, lon), SPOT);
  const has = re => lines.some(l => re.test(l));
  check('the tip names the transmission line, its voltage, overhead, and its crane exclusion zone',
    has(/Transmission line, overhead, 132 kV · crane exclusion zone 3 m — Example 132/), J(lines));
  check('the gas pipeline and who runs it', has(/Gas pipeline \(high pressure\) — Example Gas Line · Example Co/), J(lines));
  check('Energex\'s cable under the pointer, underground', has(/Energex: underground cable, low voltage/), J(lines));
  check('the finest acid sulfate map\'s words, not the national atlas\'s', has(/Acid sulfate soil — Potential acid sulfate soil within 1 m of the surface \(1:50 000\)/), J(lines));
  check('the soil order in plain words', has(/Soil: Vertosol — Cracking clay that swells/), J(lines));
  check('the cultural heritage party', has(/Cultural heritage party — Example People/), J(lines));
  check('and the wind region, with the wind layer on', has(/Wind region/), J(lines));
  const spot = await page.evaluate(({ lat, lon }) => { const p = state.map.latLngToContainerPoint([lat, lon]); const r = state.map.getContainer().getBoundingClientRect(); return { x: r.left + p.x + 3, y: r.top + p.y + 3 }; }, SPOT);
  await page.mouse.move(spot.x - 40, spot.y - 40);
  await page.mouse.move(spot.x, spot.y, { steps: 4 });
  await page.waitForFunction(() => MapFeedTip._state().shown, null, { timeout: 8000 }).catch(() => {});
  const tipped = await page.evaluate(() => ({ ...MapFeedTip._state(), cls: !!document.querySelector('.leaflet-tooltip.mn-feed-tip') }));
  check('resting the mouse there shows it as a hover tip, saying it is a guide, not a locate',
    tipped.shown && tipped.cls && /Map layers here/.test(tipped.text), J(tipped));
  await page.evaluate(() => MapFeedTip._ask(-27.4995, 152.9505));
  await page.waitForFunction(() => MapFeedTip._state().shown && /Map layers here/.test(MapFeedTip._state().text), null, { timeout: 8000 }).catch(() => {});
  const before = await page.evaluate(() => MapFeedTip._state().asked);
  await page.evaluate(() => MapFeedTip._ask(-27.4995, 152.9505));
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => MapFeedTip._state());
  check('coming back to the same spot asks nothing again', after.asked === before, J({ before, after }));
  await page.evaluate(() => MapTipStack.setEnabled(false));
  await page.mouse.move(spot.x + 30, spot.y);
  await page.waitForTimeout(900);
  const offState = await page.evaluate(() => ({ off: MapTipStack.off(), shown: MapFeedTip._state().shown }));
  check('with 💬 off, no tip', offState.off && !offState.shown, J(offState));
  await page.evaluate(() => { MapTipStack.setEnabled(true); MapFeeds.setEnabled('qld-soils', false); });

  // ── 7. Another view switches it off ──────────────────────────────────────
  await page.evaluate(() => { MapDig.checkAt(-27.5, 152.95); MapViews.apply('property'); });
  check('another view takes the check off', await page.evaluate(() => !MapDig.live() && !state.mapDig));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the run finished', false, e.stack || String(e));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n  ${results.length} assertion(s).`);
if (failed.length) { console.log(`FAIL — ${failed.length} of the Before you dig checks failed.`); process.exit(1); }
console.log('PASS — Before you dig bands what is near a spot or a line, says what the open data leaves out, and prints a sheet.');
