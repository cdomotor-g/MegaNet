// More map layers (map-feeds.js, EPIC #291): the open-data layers drawn from
// one list, and the "Open data here" section on the station card.
//
// Every service is external and this harness blocks outbound requests, so the
// check stubs them, the way the live ones answer:
//
//   * a MapServer `export` is a PNG; the Geoscience Australia pipelines one
//     answers 500, so the check can see one dead service leave the others
//     drawing — the fault the first draft had, where one bad entry left every
//     layer after it on "Drawing…";
//   * `legend` gives base64 swatches, `identify` the features at a point;
//   * the weed survey's species are sublayers of group 200 in the service's
//     own layer list, and the list here is whatever that says;
//   * Energex and Ergon answer a service-level `query` (one per company per
//     view) with Esri paths, a cable layer and an overhead one;
//   * DEA's WMS hands over 256 px tiles.
//
// Run:  npm run feeds
//       npm run feeds -- -v    also print what passed

import fs from 'node:fs';
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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HOSTS = /(services\.ga\.gov\.au|spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/(InlandWaters\/(FloodLines|GroundAndSurfaceWaterMonitoring)|Boundaries\/CulturalHeritage|Environment\/ParksTerrestrial|Farming\/Biosecurity)|gis\.environment\.gov\.au|api\.ala\.org\.au|services\d\.arcgis\.com|data\.gov\.au\/geoserver|apps\.des\.qld\.gov\.au|ows\.dea\.ga\.gov\.au|services\.arcgis\.com\/[^/]+\/ArcGIS\/rest\/services\/Network_|\/api\/qld-gauges)/;
const CENTER = { lat: -27.535, lon: 152.99 };
// The gauge's reading two hours ago in AEST, so it is never "an old reading"
// whenever the check runs (a fixed date aged into one on 20 Nov 2026).
const GAUGE_AT = new Date(Date.now() - 2 * 3600e3 + 10 * 3600e3).toISOString().slice(0, 13) + ':00:00+10:00';
const GAUGE_SAYS = `${GAUGE_AT.slice(0, 10)} ${GAUGE_AT.slice(11, 16)}`;

const asked = [];   // every stubbed request: { path, params }

function answer(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  asked.push({ host: u.host, path: u.pathname, params: p });
  const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const png = () => ({ status: 200, contentType: 'image/png', body: PNG });

  if (u.pathname === '/api/qld-gauges') {
    const g = {};
    for (const id of (p.sites || '').split(',')) if (id === '540001A') g[id] = { m: 2.345, at: GAUGE_AT, tz: '+10:00' };
    return json({ source: {}, asOf: '2026-11-18T08:30:00Z', gauges: g });
  }
  if (/GroundAndSurfaceWaterMonitoring\/MapServer\/1[34]\/query$/.test(u.pathname)) {
    const open = /\/13\/query$/.test(u.pathname);
    return json({ features: open
      ? [{ attributes: { identifier: '540001A', title: 'Test Creek at Example', basin: 'CONDAMINE', latitude: -28.25, longitude: 152.2156 } },
         { attributes: { identifier: '540002B', title: 'Quiet Creek at Nowhere', basin: 'CONDAMINE', latitude: CENTER.lat, longitude: CENTER.lon } }]
      : [{ attributes: { identifier: '540003C', title: 'Old Creek <img src=x onerror="window.__feedXss=1">', latitude: CENTER.lat + 0.001, longitude: CENTER.lon, commence: '1960', cease: '1999' } }] });
  }
  if (u.host === 'ows.dea.ga.gov.au') return png();
  if (/^services\d\.arcgis\.com$/.test(u.host)) {
    // Brisbane's stormwater (pipes and drains) and the other utilities' mains.
    const brisbane = /dEKgZETqwmDAh1rP/.test(u.pathname);
    if (p.returnCountOnly === 'true') return json({ count: brisbane && /Stormwater_Pipe/.test(u.pathname) ? 3 : 0 });
    const { lat, lon } = CENTER;
    return json({ features: brisbane ? [{ attributes: { OBJECTID: 1 }, geometry: { paths: [[[lon - 0.001, lat + 0.0005], [lon + 0.001, lat + 0.0005]]] } }] : [] });
  }
  if (u.host === 'data.gov.au') return png();
  if (u.host === 'api.ala.org.au') {
    // Near whatever point is asked about (the card), else the view's centre.
    const lat = p.lat ? Number(p.lat) : CENTER.lat, lon = p.lon ? Number(p.lon) : CENTER.lon;
    return json({ totalRecords: 3, occurrences: [
      { vernacularName: 'Lantana', scientificName: 'Lantana camara', year: 2025, decimalLatitude: lat + 0.001, decimalLongitude: lon },
      { vernacularName: 'Lantana', scientificName: 'Lantana camara', year: 2019, decimalLatitude: lat + 0.004, decimalLongitude: lon },
      { vernacularName: null, scientificName: 'Pontederia crassipes', year: 2009, decimalLatitude: lat, decimalLongitude: lon + 0.01 },
    ] });
  }
  if (u.host === 'apps.des.qld.gov.au') {
    return { status: 200, contentType: 'text/csv', body: [
      'Tide Data provided @ 13:05hrs on 17-11-2026',
      'Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude, Longitude',
      'whyteislandnx,1794883200,2026-11-17T12:40,1.762,1.745,0.017,-27.4017,153.1574',
      'whyteislandnx,1794883800,2026-11-17T12:50,2.196,1.782,0.414,-27.4017,153.1574',
      'whyteislandnx,1794884400,2026-11-17T13:00,-99.000,1.818,-99.000,-27.4017,153.1574',
      'abellpoint,1794232800,2026-11-10T00:00,-99.000,1.915,-99.000,-20.2608,148.7103',
    ].join('\n') };
  }
  if (/Oil_Gas_Pipelines\/MapServer\/export$/.test(u.pathname)) return { status: 500, contentType: 'text/plain', body: 'down' };
  if (/\/export$/.test(u.pathname)) return png();
  if (/\/legend$/.test(u.pathname)) {
    return json({ layers: [
      { layerId: 2, layerName: 'Power Lines', legend: [{ label: '132', imageData: PNG.toString('base64'), contentType: 'image/png' }] },
      { layerId: 65, layerName: 'Fire ant', legend: [{ label: '', imageData: PNG.toString('base64'), contentType: 'image/png' }] },
      { layerId: 12, layerName: '1974 Floodline Brisbane and Bremer Rivers', legend: [{ label: '', imageData: PNG.toString('base64'), contentType: 'image/png' }] },
    ] });
  }
  if (/Biosecurity\/MapServer$/.test(u.pathname)) {
    return json({ layers: [
      { id: 65, name: 'Fire ant', parentLayerId: 30 },
      { id: 200, name: 'Weed distribution', parentLayerId: -1, subLayerIds: [202, 310] },
      { id: 202, name: 'African boxthorn', parentLayerId: 200 },
      { id: 310, name: 'Lantana', parentLayerId: 200 },
      // An id that is not a number is not a layer: it never reaches the page.
      { id: '1"><img src=x onerror="window.__feedXss=2">', name: 'Zz bogus', parentLayerId: 200 },
    ] });
  }
  if (/\/identify$/.test(u.pathname)) {
    const layers = p.layers || '';
    if (/Biosecurity/.test(u.pathname) && /\b65\b/.test(layers)) {
      return json({ results: [
        { layerId: 65, layerName: 'Fire ant', value: 'Fire ant biosecurity zone 2', attributes: { 'Biosecurity zone': 'Fire ant biosecurity zone 2' } },
        { layerId: 40, layerName: 'Banana pest', value: 'Southern banana biosecurity zone', attributes: { 'Biosecurity zone': 'Southern banana biosecurity zone' } },
      ] });
    }
    if (/Biosecurity/.test(u.pathname) && /\b200\b/.test(layers)) {
      return json({ results: [
        { layerId: 310, layerName: 'Lantana', value: 'Lantana camara', attributes: { 'Common name': 'Lantana', 'State declaration': 'Restricted' } },
        { layerId: 206, layerName: 'African lovegrass', value: 'Eragrostis curvula', attributes: { 'Common name': 'African lovegrass', 'State declaration': 'Not declared' } },
      ] });
    }
    if (/FloodLines/.test(u.pathname)) {
      return json({ results: [
        { layerId: 12, layerName: '1974 Floodline Brisbane and Bremer Rivers', value: 'Brisbane River', attributes: {} },
        { layerId: 51, layerName: 'Sunny day failure - referable dam', value: 'Wivenhoe Dam', attributes: { 'Dam name': 'Wivenhoe Dam' } },
      ] });
    }
    if (/CulturalHeritage/.test(u.pathname)) {
      return json({ results: [{ layerId: 1, layerName: 'Cultural Heritage party boundary', value: 'Example People', attributes: { Name: 'Example People' } }] });
    }
    return json({ results: [] });
  }
  if (/Network_(Energex|Extract)\/FeatureServer\/query$/.test(u.pathname)) {
    const energex = /Network_Energex/.test(u.pathname);
    const cable = energex ? 13 : 7, line = energex ? 12 : 6;
    // A small box is a card's question about one place (a box CABLE_M round
    // it, since the services ignore `distance` beside a point): Energex's
    // cable through it, and an overhead line 1 km off, which is fetched but
    // further than 30 m and so left out.
    const [w, so, e, n] = (p.geometry || '').split(',').map(Number);
    if (p.geometryType === 'esriGeometryEnvelope' && e - w < 0.01) {
      const la = (so + n) / 2, lo = (w + e) / 2;
      return json({ layers: [
        { id: cable, features: energex ? [{ attributes: { OBJECTID: 1 }, geometry: { paths: [[[lo - 0.0002, la], [lo + 0.0002, la]]] } }] : [] },
        { id: line, features: [{ attributes: { OBJECTID: 2 }, geometry: { paths: [[[lo + 0.01, la - 0.001], [lo + 0.01, la + 0.001]]] } }] },
      ] });
    }
    const { lat, lon } = CENTER;
    return json({ layers: [
      { id: cable, features: [{ attributes: { OBJECTID: 1 }, geometry: { paths: [[[lon - 0.001, lat], [lon + 0.001, lat]]] } }] },
      { id: line,  features: [{ attributes: { OBJECTID: 2 }, geometry: { paths: [[[lon, lat - 0.001], [lon, lat + 0.001]]] } }] },
    ] });
  }
  return json({ layers: [] });
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route(HOSTS, (route) => route.fulfill({
    ...answer(route.request().url()), headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // ── 1. The list ───────────────────────────────────────────────────────
  const list = await page.evaluate(() => MapFeeds.FEEDS.map(f => ({
    id: f.id, label: f.label, meaning: f.meaning, kind: f.kind, url: f.url || '', src: f.source,
  })));
  check('the list holds the feeds the epic asked for',
    ['ga-power', 'ga-pipes', 'qld-network', 'qld-flood-history', 'qld-dam-flood', 'dea-water', 'qld-gauges',
     'qld-heritage', 'qld-parks', 'capad', 'qld-biosecurity', 'qld-fences', 'qld-weeds', 'ala-weeds', 'qld-tides',
     'bcc-stormwater', 'unitywater', 'melbourne-water', 'vic-drainage'].every(id => list.some(f => f.id === id)),
    list.map(f => f.id).join(','));
  check('every feed has a label, a meaning of a sentence or more, and a source with a licence and a page',
    list.every(f => f.label && f.meaning.length > 60 && f.src && f.src.by && f.src.licence && /^https:/.test(f.src.page)),
    JSON.stringify(list.filter(f => !(f.label && f.meaning.length > 60))));
  check('every service address is https',
    list.every(f => ['network', 'ala', 'tide', 'pipes'].includes(f.kind) || /^https:\/\//.test(f.url)));
  check('ids are distinct', new Set(list.map(f => f.id)).size === list.length);

  // ── 2. The controls ───────────────────────────────────────────────────
  const ui = await page.evaluate(() => {
    const fold = document.querySelector('#map-display-block .mn-feeds');
    return {
      fold: !!fold,
      boxes: fold ? fold.querySelectorAll('input[type="checkbox"][data-feed]').length : 0,
      titled: fold ? [...fold.querySelectorAll('label.filter-check')].every(l => (l.getAttribute('title') || '').length > 60) : false,
      words: fold ? fold.querySelectorAll('.mn-feed-words dt').length : 0,
      groups: fold ? fold.querySelectorAll('fieldset.mn-feed-group legend').length : 0,
      digging: fold ? /Before You Dig/.test(fold.textContent) : false,
    };
  });
  check('the fold sits in Map display, a switch per feed, each with its meaning on hover',
    ui.fold && ui.boxes === list.length && ui.titled, JSON.stringify(ui));
  check('the words fold lists every feed and the card section, for a finger that cannot hover',
    ui.words === list.length + 1, String(ui.words));
  check('the feeds are grouped, and the fold says they are not for finding a cable before digging',
    ui.groups === 6 && ui.digging, JSON.stringify(ui));

  // ── 3. Drawing ────────────────────────────────────────────────────────
  await page.evaluate((c) => state.map.setView([c.lat, c.lon], 16, { animate: false }), CENTER);
  asked.length = 0;
  await page.evaluate(() => {
    for (const id of ['ga-power', 'ga-pipes', 'qld-flood-history', 'qld-biosecurity', 'qld-network', 'dea-water', 'qld-weeds']) {
      MapFeeds.setEnabled(id, true);
    }
  });
  await page.waitForFunction(() => {
    const d = MapFeeds._state().drawn;
    return ['ga-power', 'qld-flood-history', 'qld-biosecurity', 'qld-weeds', 'dea-water'].every(id => d[id] && d[id].note === 'ok')
      && MapFeeds._state().net && d['ga-pipes'] && d['ga-pipes'].note === 'fail';
  }, null, { timeout: 20_000 }).catch(() => {});
  const st = await page.evaluate(() => MapFeeds._state());

  check('one dead service is said to be dead, and every layer after it still draws',
    st.drawn['ga-pipes'].note === 'fail'
      && ['qld-flood-history', 'qld-biosecurity', 'qld-weeds', 'dea-water'].every(id => st.drawn[id].note === 'ok'),
    JSON.stringify(Object.fromEntries(Object.entries(st.drawn).map(([k, v]) => [k, v.note]))));
  const pipesNote = await page.evaluate(() => document.getElementById('mn-feed-note-ga-pipes').textContent);
  check('and its note names who did not answer', /Could not be drawn — Geoscience Australia/.test(pipesNote), pipesNote);

  const powerExport = asked.find(a => /Electricity_Infrastructure\/MapServer\/export$/.test(a.path));
  check('a picture is the service’s export of the listed sublayers, in web mercator',
    powerExport && powerExport.params.layers === 'show:2,0,1' && powerExport.params.bboxSR === '3857'
      && powerExport.params.transparent === 'true', JSON.stringify(powerExport && powerExport.params));
  const bioExport = asked.find(a => /Biosecurity\/MapServer\/export$/.test(a.path) && /\b65\b/.test(a.params.layers));
  check('the zones drawn are the ones that mark out a place, not the whole-State ones',
    bioExport && bioExport.params.layers === 'show:65,75,80,35,95', JSON.stringify(bioExport && bioExport.params.layers));
  const weedExport = asked.find(a => /Biosecurity\/MapServer\/export$/.test(a.path) && a.params.layers === 'show:310');
  check('the weed survey draws one weed, Lantana first, read from the service’s own list', !!weedExport,
    JSON.stringify(asked.filter(a => /Biosecurity\/MapServer\/export$/.test(a.path)).map(a => a.params.layers)));
  const deaTile = asked.find(a => a.host === 'ows.dea.ga.gov.au');
  check('the satellite water is asked as small WMS tiles — its service refuses anything over 512 px',
    deaTile && Number(deaTile.params.width) <= 512 && /ga_ls_wo_fq_myear_3/.test(deaTile.params.layers), JSON.stringify(deaTile && deaTile.params));

  const netAsks = asked.filter(a => /Network_(Energex|Extract)\/FeatureServer\/query$/.test(a.path));
  check('the power network is one request per company per view, every voltage class in it at zoom 16',
    netAsks.length === 2 && netAsks.every(a => Object.keys(JSON.parse(a.params.layerDefs)).length >= 6),
    JSON.stringify(netAsks.map(a => a.params.layerDefs)));
  const panes = await page.evaluate(() => ['mnFeedAreas', 'mnFeedLines', 'mnFeedNet'].map(n => {
    const el = state.map.getPane(n);
    return el ? { z: el.style.zIndex, pe: getComputedStyle(el).pointerEvents, kids: el.children.length } : null;
  }));
  check('three panes of their own, under the network, refusing the pointer',
    panes.every(p => p && p.pe === 'none' && Number(p.z) < 400) && panes[0].kids > 0 && panes[2].kids > 0, JSON.stringify(panes));

  const legend = await page.evaluate(() => MapFeeds.legendHtml());
  check('the key names each drawn feed with its meaning on hover, the service swatches and the dashed cable',
    /High-voltage power lines/.test(legend) && /class="term"/.test(legend) && /data:image\/png;base64/.test(legend)
      && /Dashed: underground cable/.test(legend) && !/Gas and oil pipelines/.test(legend), legend.slice(0, 300));
  const attrib = await page.evaluate(() => document.querySelector('.leaflet-control-attribution').textContent);
  check('each drawn source is credited on the map', /Energex and Ergon/.test(attrib) && /Geoscience Australia/.test(attrib), attrib.slice(-300));

  // Weed picked → asked again for that species.
  asked.length = 0;
  await page.evaluate(() => MapFeeds.setWeed(202));
  await page.waitForTimeout(800);
  check('picking another weed draws that one',
    asked.some(a => /Biosecurity\/MapServer\/export$/.test(a.path) && a.params.layers === 'show:202'));
  const sel = await page.evaluate(() => [...document.querySelectorAll('#mn-feed-weed option')].map(o => o.textContent));
  check('the weed list is the service’s, alphabetical', sel.join('|') === 'African boxthorn|Lantana' && !(await page.evaluate(() => window.__feedXss || !!document.querySelector('#mn-feed-weed img'))), sel.join('|'));

  // The Atlas's weed records and the storm tide gauges.
  asked.length = 0;
  await page.evaluate(() => { MapFeeds.setEnabled('ala-weeds', true); MapFeeds.setEnabled('qld-tides', true); });
  await page.waitForFunction(() => {
    const d = MapFeeds._state().drawn;
    return d['ala-weeds'] && d['ala-weeds'].note === 'ok' && d['qld-tides'] && d['qld-tides'].note === 'ok';
  }, null, { timeout: 15_000 }).catch(() => {});
  const alaAsk = asked.find(a => a.host === 'api.ala.org.au');
  check('weed records are asked of the Atlas for the view: Queensland’s weed records and the national weeds list only',
    alaAsk && /^POLYGON\(\(/.test(alaAsk.params.wkt || '') && alaAsk.params.fq === 'data_resource_uid:"dr18218" OR species_list_uid:"dr823"',
    JSON.stringify(alaAsk && alaAsk.params));
  const alaNote = await page.evaluate(() => document.getElementById('mn-feed-note-ala-weeds').textContent);
  check('and the note counts the records drawn', /Drawn: 3 records in view/.test(alaNote), alaNote);
  const tidePins = await page.evaluate(() => [...document.querySelectorAll('.leaflet-mnFeedPins-pane .mn-tide-pin')]
    .map(e => ({ cls: e.className, label: e.getAttribute('aria-label') })));
  check('a pin per storm tide gauge, the latest real reading on it, not the file’s -99 gap',
    tidePins.length === 2 && tidePins.some(p => /Whyteisland storm tide gauge — 2\.20 m at 2026-11-17 12:50/.test(p.label)
      && /surge is \+0\.41 m/.test(p.label) && /not AHD/.test(p.label) && /mn-tide-high/.test(p.cls)),
    JSON.stringify(tidePins));
  check('and a gauge with no reading in the week says so',
    tidePins.some(p => /Abellpoint storm tide gauge — no reading/.test(p.label) && /mn-tide-none/.test(p.cls)), JSON.stringify(tidePins));
  const pinPane = await page.evaluate(() => getComputedStyle(state.map.getPane('mnFeedPins')).pointerEvents);
  check('the tide pins’ pane takes the pointer, for their figures on hover', pinPane !== 'none', pinPane);
  asked.length = 0;
  await page.evaluate(() => { MapFeeds.setEnabled('qld-tides', false); MapFeeds.setEnabled('qld-tides', true); });
  await page.waitForTimeout(800);
  check('the 5 MB tide file is read once a visit, not each time the layer is switched',
    !asked.some(a => a.host === 'apps.des.qld.gov.au'), JSON.stringify(asked.map(a => a.host)));
  await page.evaluate(() => { MapFeeds.setEnabled('ala-weeds', false); MapFeeds.setEnabled('qld-tides', false); });

  // The State's river gauges (#295): a pin per open gauge with its latest
  // height from our Worker, "gauge height, not AHD"; closed ones grey dots.
  asked.length = 0;
  // Leaflet sets a string tooltip as HTML, so what is handed to it is noted.
  await page.evaluate(() => {
    const bind = L.Layer.prototype.bindTooltip; window.__tips = [];
    L.Layer.prototype.bindTooltip = function (c, o) { if (typeof c === 'string') window.__tips.push(c); return bind.call(this, c, o); };
  });
  await page.evaluate(() => MapFeeds.setEnabled('qld-gauges', true));
  await page.waitForFunction(() => (MapFeeds._state().drawn['qld-gauges'] || {}).note === 'ok', null, { timeout: 15_000 }).catch(() => {});
  const gpins = await page.evaluate(() => [...document.querySelectorAll('.leaflet-mnFeedPins-pane .mn-tide-pin')]
    .map(e => ({ cls: e.className, label: e.getAttribute('aria-label') })));
  check('a pin per open State gauge: the latest gauge height and its time on it, saying it is not AHD',
    gpins.some(p => new RegExp(`Test Creek at Example \\(540001A\\) — State river gauge: gauge height 2\\.35 m at ${GAUGE_SAYS} \\(AEST\\)`).test(p.label)
      && /not AHD/.test(p.label) && /mn-gauge-live/.test(p.cls)), JSON.stringify(gpins));
  check('a gauge the Worker has no reading for says so',
    gpins.some(p => /Quiet Creek at Nowhere \(540002B\) — State river gauge, no recent reading/.test(p.label) && /mn-gauge-none/.test(p.cls)), JSON.stringify(gpins));
  const gAsk = asked.filter(a => a.path === '/api/qld-gauges');
  check('the heights are asked of the Worker, the open gauges in one request, never the State’s portal from the browser',
    gAsk.length === 1 && gAsk[0].params.sites === '540001A,540002B' && !asked.some(a => /water-monitoring/.test(a.host)), JSON.stringify(gAsk));
  const gNote = await page.evaluate(() => document.getElementById('mn-feed-note-qld-gauges').textContent);
  check('the note counts the open gauges and gives the latest reading', new RegExp(`Drawn: 2 open gauges, the latest reading ${GAUGE_SAYS} \\(AEST\\)`).test(gNote), gNote);
  // A closed gauge's words are the State's text, shown as text: its title
  // carries markup here, and the tooltip must show it, not run it.
  const gTip = await page.evaluate(() => (window.__tips || []).filter(t => t.includes('Old Creek')));
  check('a closed gauge\u2019s tooltip shows the State\u2019s words as text, never as markup',
    gTip.length === 1 && !gTip[0].includes('<img') && gTip[0].includes('Old Creek &lt;img'), JSON.stringify(gTip));
  await page.evaluate(() => MapFeeds.setEnabled('qld-gauges', false));

  // Pipes (#294): Brisbane's stormwater drawn; Unitywater and Melbourne Water,
  // whose areas the view is not in, not asked at all.
  asked.length = 0;
  await page.evaluate(() => { for (const id of ['bcc-stormwater', 'unitywater', 'melbourne-water', 'vic-drainage']) MapFeeds.setEnabled(id, true); });
  await page.waitForFunction(() => (MapFeeds._state().drawn['bcc-stormwater'] || {}).note === 'ok', null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
  const pipeAsks = asked.filter(a => /^services\d\.arcgis\.com$/.test(a.host));
  check('Brisbane’s stormwater is one request a part — pipes and open drains — for the view',
    pipeAsks.length === 2 && pipeAsks.every(a => /dEKgZETqwmDAh1rP/.test(a.path) && a.params.geometryType === 'esriGeometryEnvelope'),
    JSON.stringify(pipeAsks.map(a => a.path)));
  const awayNotes = await page.evaluate(() => ['unitywater', 'melbourne-water', 'vic-drainage'].map(id =>
    document.getElementById(`mn-feed-note-${id}`).textContent));
  check('a utility whose area the view is not in is not asked, and says it only publishes its own area',
    awayNotes.every(t => /Nothing here/.test(t)) && !asked.some(a => /tQg86iShPXJPWQWw|ZSYwjtv8RKVhkXIL/.test(a.path) || a.host === 'data.gov.au'),
    JSON.stringify(awayNotes));
  const pipeNote = await page.evaluate(() => document.getElementById('mn-feed-note-bcc-stormwater').textContent);
  check('the note counts the pipes drawn', /Drawn: 2 pipes in view/.test(pipeNote), pipeNote);
  const pipeLegend = await page.evaluate(() => MapFeeds.legendHtml());
  check('the key has a line for each kind of pipe, the open drain dashed',
    /Stormwater pipe/.test(pipeLegend) && /mn-feed-net-ug[^>]*>\s*<\/span>\s*<span class="small">Open drain/.test(pipeLegend), pipeLegend.slice(0, 200));
  await page.evaluate(() => { for (const id of ['bcc-stormwater', 'unitywater', 'melbourne-water', 'vic-drainage']) MapFeeds.setEnabled(id, false); });

  // Zoomed out past a feed's floor: no request, and the note says why.
  asked.length = 0;
  await page.evaluate(() => state.map.setZoom(9, { animate: false }));
  await page.waitForTimeout(800);
  const netNote = await page.evaluate(() => document.getElementById('mn-feed-note-qld-network').textContent);
  check('zoomed out, the power network is not asked for and says to zoom in',
    !asked.some(a => /FeatureServer\/query$/.test(a.path)) && /Zoom in/.test(netNote), netNote);

  // Views (map-views.js, #296): which feeds are on is part of a view.
  const views = await page.evaluate(async () => {
    for (const f of MapFeeds.FEEDS) MapFeeds.setEnabled(f.id, ['qld-flood-history', 'qld-biosecurity'].includes(f.id));
    const snap = MapViews.snapshot();
    const id = MapViews.VIEWS[0].id;
    MapViews.apply(id);
    await new Promise(r => setTimeout(r, 300));
    const after = MapFeeds.enabledList();
    MapViews.undo();
    await new Promise(r => setTimeout(r, 300));
    return { snap: snap.feeds, after, undone: MapFeeds.enabledList(),
             boxes: [...document.querySelectorAll('.mn-feeds input[data-feed]')].filter(b => b.checked).map(b => b.dataset.feed) };
  });
  check('a kept view remembers which More map layers are on',
    JSON.stringify(views.snap) === JSON.stringify(['qld-flood-history', 'qld-biosecurity']), JSON.stringify(views.snap));
  check('a built-in view turns them off, as it does every other layer, and Undo puts them back with their ticks',
    views.after.length === 0 && JSON.stringify(views.undone) === JSON.stringify(['qld-flood-history', 'qld-biosecurity'])
      && JSON.stringify(views.boxes.sort()) === JSON.stringify(['qld-biosecurity', 'qld-flood-history']), JSON.stringify(views));

  // Off is off.
  asked.length = 0;
  await page.evaluate(() => { for (const f of MapFeeds.FEEDS) MapFeeds.setEnabled(f.id, false); state.map.setZoom(14, { animate: false }); });
  await page.waitForTimeout(800);
  check('with every feed off, nothing is asked and nothing is drawn',
    asked.length === 0 && !(await page.evaluate(() => MapFeeds.active())), JSON.stringify(asked.slice(0, 3)));

  // Remembered.
  await page.evaluate(() => MapFeeds.setEnabled('qld-biosecurity', true));
  const kept = await page.evaluate(() => localStorage.getItem('mn-map-feeds'));
  check('what is on is remembered for next time', kept === '["qld-biosecurity"]', String(kept));
  await page.evaluate(() => MapFeeds.setEnabled('qld-biosecurity', false));

  // ── 4. Open data here, on the station card ───────────────────────────
  asked.length = 0;
  await page.evaluate(() => showStationCard('yangan_al'));
  await page.waitForFunction(() => /Fire ant/.test((document.getElementById('mn-feeds-card-yangan_al') || {}).textContent || ''),
    null, { timeout: 10_000 }).catch(() => {});
  const closed = await page.evaluate(() => {
    const el = document.getElementById('mn-feeds-card-yangan_al');
    return el ? { text: el.textContent, open: !!el.querySelector('details[open]'), chip: !!el.querySelector('.term-chip[title]') } : null;
  });
  check('the card says straight away, without opening, that the site is in a fire ant zone',
    closed && /Fire ant biosecurity zone 2/.test(closed.text) && closed.chip && !closed.open, JSON.stringify(closed));
  check('and opening the card asks one question, not ten',
    asked.filter(a => /identify$|query$/.test(a.path)).length === 1,
    JSON.stringify(asked.map(a => a.path)));

  await page.evaluate(() => { const d = document.querySelector('#mn-feeds-card-yangan_al details'); d.open = true; });
  await page.waitForFunction(() => /Example People/.test(document.getElementById('mn-feeds-card-yangan_al').textContent)
    && /Lantana/.test(document.getElementById('mn-feeds-card-yangan_al').textContent), null, { timeout: 10_000 }).catch(() => {});
  const open = await page.evaluate(() => {
    const el = document.getElementById('mn-feeds-card-yangan_al');
    return { text: el.textContent.replace(/\s+/g, ' '), terms: el.querySelectorAll('.term[title]').length };
  });
  check('opened, it lists every zone, the past flood and the dam it is under',
    /Southern banana biosecurity zone/.test(open.text) && /1974/.test(open.text) && /Wivenhoe Dam — sunny day failure/.test(open.text), open.text.slice(0, 400));
  check('the cultural heritage party, by name and not by contact details',
    /Example People — cultural heritage party/.test(open.text), open.text.slice(0, 400));
  check('Energex’s underground cable within 30 m',
    /Energex: low voltage \(street supply\), underground \(1\)/.test(open.text), open.text.slice(0, 600));
  check('the weed records within 2 km, one line a weed, nearest first, with the latest year',
    /Lantana — 2 records, nearest 110 m, latest 2025/.test(open.text) && /Pontederia crassipes — 1 record, nearest 9[0-9]0 m, latest 2009/.test(open.text)
      && open.text.indexOf('Lantana — 2') < open.text.indexOf('Pontederia'), open.text);
  check('a station outside every utility’s area says no pipes are published there, and asks none',
    /Pipes\s*none published for this area/.test(open.text), open.text.slice(0, 500));
  check('the weeds in its square, the restricted ones marked',
    /2: African lovegrass, Lantana \(restricted\)/.test(open.text), open.text);
  check('the nearest open State gauge and its latest height on the card, as gauge height',
    new RegExp(`State river gauges\\s*Test Creek at Example \\(540001A\\), 5\\.5 km — gauge height 2\\.35 m at ${GAUGE_SAYS} \\(AEST\\)`).test(open.text), open.text.slice(0, 700));
  check('each row’s word has its meaning on hover', open.terms >= 12, String(open.terms));

  // ── 5. And the What is here card asks about a point the same way ─────
  const hereSrc = fs.readFileSync(new URL('../map-here.js', import.meta.url), 'utf8');
  check('What is here carries the same section and asks it about the picked point',
    /data-mn-feeds="\$\{escAttr\(MapFeeds\.key\(here\)\)\}"/.test(hereSrc) && /MapFeeds\.ask\(FEEDS_ID, landPoint\(\)\)/.test(hereSrc));

  // ── 5. The hover tip over the layers (map-feed-tip.js) ──────────────────
  const tipLines = await page.evaluate(({ lat, lon }) => {
    MapFeeds.setOnly(['qld-flood-history', 'qld-heritage']);
    state.map.setView([lat, lon], 12);
    return MapFeedTip.linesAt(lat, lon);
  }, CENTER);
  check('resting on a past flood outline and a heritage area names both in the hover tip',
    tipLines.some(l => /Past flood reached here — 1974/.test(l)) && tipLines.some(l => /Cultural heritage party — Example People/.test(l)), JSON.stringify(tipLines));
  await page.evaluate(() => MapFeeds.setOnly([]));
  const none = await page.evaluate(({ lat, lon }) => MapFeedTip.linesAt(lat, lon), CENTER);
  check('with no layer on, the hover tip asks nothing and says nothing', none.length === 0, JSON.stringify(none));
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n  ${results.length} assertion(s).`);
if (failed.length) {
  console.log(`FAIL — ${failed.length} of the open-data layer checks failed.`);
  process.exit(1);
}
console.log('PASS — the open-data layers draw from one list, one dead service stops nothing, and the station card says what they say about its place.');
