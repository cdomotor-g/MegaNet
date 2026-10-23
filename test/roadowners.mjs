// Road and bridge owners: the Stations map's Road & bridge owners layer
// (map-road-owners.js) and the Road and bridge section on the station card and
// the What is here card (site-roads.js).
//
// Everything they read is external — the State's Roads and Tracks and TMR's
// bridge register on spatial-gis.information.qld.gov.au, and QLDTraffic's road
// lookup — and this harness blocks outbound requests, so the check stubs all
// three. Like roads.mjs, the stub does what the live services do rather than
// answer every question with everything:
//
//   * the service descriptions publish the sublayers under ids that are NOT the
//     module's fallbacks (Roads and tracks at 11, Bridges at 24, the register
//     at 9), so a query sent to the fallback id is a query the name probe
//     should have stopped — and is answered with a 400, as the live service
//     answers a layer it does not have.
//   * a query's envelope is honoured: only features whose extent meets it come
//     back, so "the nearest road within 150 m" is the module's own reading.
//   * the roads query's `where` is honoured as far as the class filter goes: a
//     footpath sits closest of all to one pick, and comes back only if the
//     module stopped asking for roads alone.
//   * the register holds a structure as one point per carriageway, two of them
//     under one struc_id; and QRT's bridge set holds the same bridge again as a
//     line, eight metres away — the duplicate the layer must merge.
//   * the export is answered with a real 1×1 PNG, so the overlay's onload
//     runs as it does live, and every export's parameters are kept.
//
// The fixture is a crossroads west of Charters Towers, far from any station:
// the Flinders Highway east–west (State-controlled), Gauge Road north–south
// (recorded as the council's), a track with no owner recorded and a private
// lane, and three bridges — Sandy Creek Bridge on the highway (TMR structure
// 4242, two carriageway points, and QRT's copy of it), a rail overpass over
// the highway (structure 5151, road_code OVER), and an unnamed bridge on Gauge
// Road that is in QRT and not on the register.
//
// Run:  npm run roadowners
//       npm run roadowners -- -v    also print what passed

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
const J = v => JSON.stringify(v);

const C = { lat: -21.0, lon: 146.0 };

// ── The fixture ─────────────────────────────────────────────────────────────

const line = (props, coords) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
const point = (props, lon, lat) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });

const LGA = { lga_name_left: 'Charters Towers Regional', lga_name_right: 'Charters Towers Regional',
              locality_left: 'Balfes Creek', locality_right: 'Balfes Creek' };

const ROADS = [
  line({ road_name_full: 'Flinders Highway', class: 'Highway', road_owner: 'TMR', road_maintainer: 'TMR',
         scr_indicator: 'T', nat_route_no: 'A6', ste_route_no: '', user_access: 'Public', ...LGA },
       [[145.97, -21.0], [146.03, -21.0]]),
  line({ road_name_full: 'Gauge Road', class: 'Local', road_owner: 'LG', road_maintainer: 'LG',
         scr_indicator: 'F', nat_route_no: '', ste_route_no: '', user_access: 'Public', ...LGA },
       [[146.005, -21.0], [146.005, -20.97]]),
  line({ road_name_full: 'Track', class: 'Track', road_owner: 'Unknown', road_maintainer: 'Unknown',
         scr_indicator: 'F', nat_route_no: '', ste_route_no: '', user_access: 'Unknown', ...LGA },
       [[145.985, -21.0], [145.985, -21.03]]),
  line({ road_name_full: 'Jacksons Lane', class: 'Restricted', road_owner: 'Private', road_maintainer: 'Private',
         scr_indicator: 'F', nat_route_no: '', ste_route_no: '', user_access: 'Private', ...LGA },
       [[146.02, -21.0], [146.02, -21.02]]),
  // A footpath, closer to the Gauge Road pick below than Gauge Road itself.
  line({ road_name_full: 'Creek Walk', class: 'Walkway', road_owner: 'LG', road_maintainer: 'LG',
         scr_indicator: 'F', nat_route_no: '', ste_route_no: '', user_access: 'Public', ...LGA },
       [[146.0052, -20.985], [146.0052, -20.98]]),
];

const TMR_BRIDGES = [
  point({ name: 'Sandy Creek Bridge', struc_id: 4242, struc_type: 'Bridge', cons_type: 'Deck Unit',
          cons_mtrl: 'Pre-Stressed Concrete', rsect_name: 'Flinders Highway', road_code: 'ON' }, 146.0100, -20.99995),
  point({ name: 'Sandy Creek Bridge', struc_id: 4242, struc_type: 'Bridge', cons_type: 'Deck Unit',
          cons_mtrl: 'Pre-Stressed Concrete', rsect_name: 'Flinders Highway', road_code: 'ON' }, 146.0100, -21.00005),
  point({ name: 'Rail Overpass', struc_id: 5151, struc_type: 'Bridge', cons_type: 'Girder/Beam',
          cons_mtrl: 'Steel', rsect_name: 'Flinders Highway', road_code: 'OVER' }, 145.9950, -21.0),
];

const QRT_BRIDGES = [
  // QRT's copy of Sandy Creek Bridge: a line along the highway through the
  // register's points, which must not become a second pin.
  line({ name: null, feature_type: 'Road Bridge', operational_status: 'Operational', additional_names: null },
       [[146.0097, -21.0], [146.0103, -21.0]]),
  // The bridge on Gauge Road, on no register.
  line({ name: null, feature_type: 'Road Bridge', operational_status: 'Operational', additional_names: null },
       [[146.005, -20.9903], [146.005, -20.9897]]),
];

// The three contacts QLDTraffic names, and a district only near the highway —
// the lookup's own behaviour.
const CONTACTS = {
  state:    { id: 277, code: '0', name: 'Catchall', contact_type: 'state', website: null,
              display_name: 'Department of Transport and Main Roads, State Management Traffic Centre',
              email: '131940.tti@tmr.qld.gov.au', phone_number: '131940' },
  local:    { id: 201, code: '2420', name: 'Charters Towers Regional', contact_type: 'local', website: null,
              display_name: 'Charters Towers Regional Council', email: 'mail@charterstowers.qld.gov.au',
              phone_number: '07 4761 5300' },
  district: { id: 266, code: '411', name: 'NTHD', contact_type: 'district', website: 'javascript:alert(1)',
              display_name: 'Department of Transport and Main Roads, Northern District',
              email: 'northern.district@tmr.qld.gov.au', phone_number: '07 4758 7500' },
  // A road somebody else runs, as the lookup names Ventia on the Second Range
  // Crossing: only at the overpass.
  operator: { id: 301, code: 'X', name: 'Overpass operator', contact_type: 'private_owned', website: 'https://example.org/roads',
              display_name: 'Overpass Road Services', email: 'roads@example.org', phone_number: '1300 000 000' },
};

// ── The stub ─────────────────────────────────────────────────────────────────

const LAYERS = {
  RoadsAndTracks: { layers: [
    { id: 20, name: 'Bridges and tunnels' }, { id: 21, name: 'Green bridges' },
    { id: 24, name: 'Bridges' }, { id: 23, name: 'Tunnels' }, { id: 11, name: 'Roads and tracks' },
  ] },
  StateRoadInformation: { layers: [
    { id: 6, name: 'State controlled road' }, { id: 9, name: 'State controlled bridge' },
    { id: 60, name: 'State controlled road culverts' },
  ] },
};
const DATA = { 'RoadsAndTracks/11': ROADS, 'RoadsAndTracks/24': QRT_BRIDGES, 'StateRoadInformation/9': TMR_BRIDGES };

function extentOf(f) {
  const g = f.geometry;
  const pts = g.type === 'Point' ? [g.coordinates] : g.coordinates;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { w: Math.min(...xs), e: Math.max(...xs), s: Math.min(...ys), n: Math.max(...ys) };
}

// A 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const queries = [];   // { layer, where, envelope }
const exports = [];   // { dynamicLayers, bbox, size }
const lookups = [];   // { lat, lng }
const wrongIds = [];  // queries sent to an id the descriptions do not publish
let lookupDown = false;

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.route(/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\/Transportation\//, async route => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/Transportation\/(RoadsAndTracks|StateRoadInformation)\/MapServer(?:\/(\d+|export)(?:\/query)?)?$/);
    if (!m) return route.fulfill({ status: 404, body: 'not found' });
    const [, svc, sub] = m;
    const q = url.searchParams;
    if (!sub) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: J(LAYERS[svc]) });
    }
    if (sub === 'export') {
      exports.push({ dynamicLayers: JSON.parse(q.get('dynamicLayers') || '[]'), bbox: q.get('bbox'), size: q.get('size'),
                     format: q.get('format'), transparent: q.get('transparent') });
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    const layer = `${svc}/${sub}`;
    const rows = DATA[layer];
    if (!rows) {
      wrongIds.push(layer);
      return route.fulfill({ status: 200, contentType: 'application/json',
                             body: J({ error: { code: 400, message: 'Invalid or missing input parameters.' } }) });
    }
    const [w, s, e, n] = (q.get('geometry') || '').split(',').map(Number);
    const where = q.get('where') || '';
    queries.push({ layer, where, envelope: [w, s, e, n] });
    const features = rows.filter(f => {
      const x = extentOf(f);
      if (x.e < w || x.w > e || x.n < s || x.s > n) return false;
      // The class filter, as the live service would apply it.
      if (/class NOT IN \([^)]*'Walkway'/.test(where) && f.properties.class === 'Walkway') return false;
      return true;
    });
    return route.fulfill({ status: 200, contentType: 'application/json',
                           body: J({ type: 'FeatureCollection', features }) });
  });

  await page.route(/r8s97t2t19\.execute-api\.ap-southeast-2\.amazonaws\.com\/prod\/lookuproad/, async route => {
    const url = new URL(route.request().url());
    const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
    lookups.push({ lat, lng });
    if (lookupDown) return route.abort('failed');
    // Within ~300 m of the highway, the district too — the lookup's buffer.
    const nearHighway = Math.abs(lat - C.lat) < 0.003;
    const atOverpass = Math.abs(lat - C.lat) < 0.0005 && Math.abs(lng - 145.995) < 0.0005;
    const list = [CONTACTS.state, CONTACTS.local].concat(nearHighway ? [CONTACTS.district] : [],
                                                         atOverpass ? [CONTACTS.operator] : []);
    return route.fulfill({ status: 200, contentType: 'application/json',
                           headers: { 'Access-Control-Allow-Origin': '*' }, body: J(list) });
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  // The side panel shut, for roads.mjs's reason: the map at its full width.
  await page.evaluate(() => shutDock({ instant: true }));
  await page.waitForTimeout(400);

  const note = () => page.evaluate(() => (document.getElementById('map-road-owners-note') || {}).textContent || '');
  const legend = () => page.evaluate(() => (document.getElementById('map-legend') || {}).innerHTML || '');
  const view = (lat, lon, z) => page.evaluate(([a, b, c]) => state.map.setView([a, b], c, { animate: false }), [lat, lon, z]);

  // ── Off by default ─────────────────────────────────────────────────────────
  await view(C.lat, C.lon, 14);
  await page.waitForTimeout(900);
  const cold = await page.evaluate(() => ({
    on: state.mapRoadOwners,
    sw: !!document.querySelector('#map-road-owners-note'),
    label: [...document.querySelectorAll('label.filter-check')].map(l => l.textContent.replace(/\s+/g, ' ').trim())
      .find(t => /Road & bridge owners/.test(t)) || null,
  }));
  check('the layer is off by default', cold.on === false, J(cold));
  check('…with its switch in Map display, beside the road parcels', cold.label === 'Road & bridge owners (Qld)', J(cold));
  check('…and off, it asks nothing — not even at a zoom it would draw at',
    exports.length === 0 && queries.length === 0, J({ exports: exports.length, queries: queries.length }));
  check('the legend’s Also available line names it while it is off',
    /Also available[^<]*Road &amp; bridge owners/.test(await legend()));

  // ── Wider than 1:3,000,000: nothing ─────────────────────────────────────────
  await view(C.lat, C.lon, 6);
  await page.evaluate(() => MapRoadOwners.setEnabled(true));
  await page.waitForTimeout(700);
  check('switched on at a continental view, it says zoom in and draws nothing',
    /Zoom in to see who manages each road/.test(await note()) && exports.length === 0, await note());
  check('…and remembers the switch', await page.evaluate(() => localStorage.getItem('mn-road-owners')) === 'on');

  // ── A regional view: the State-controlled network alone ─────────────────────
  await view(C.lat, C.lon, 9);
  await page.waitForFunction(() => /State-controlled roads drawn/.test(document.getElementById('map-road-owners-note').textContent),
    null, { timeout: 15_000 });
  const wide = exports[exports.length - 1];
  const [wTop, wCasing] = wide.dynamicLayers;
  check('the regional image asks for the State-controlled roads only, over their white casing',
    /scr_indicator = 'T' OR road_owner = 'TMR'/.test(wTop.definitionExpression)
      && /scr_indicator = 'T'/.test(wCasing.definitionExpression), J(wide.dynamicLayers.map(d => d.definitionExpression)));
  check('…from the sublayer the name probe found, not the fallback id',
    wTop.source.mapLayerId === 11 && wCasing.source.mapLayerId === 11, J(wTop.source));
  check('…as a translucent png32', wide.format === 'png32' && wide.transparent === 'true', J(wide));
  check('the legend keys the State-controlled roads and nothing else at that scale', await (async () => {
    const l = await legend();
    return /Road — State-controlled/.test(l) && !/Road — the council’s/.test(l);
  })());

  // ── Street level: every road, and the bridges ───────────────────────────────
  await view(C.lat, C.lon, 15);
  await page.waitForFunction(() => /bridges? in view/.test(document.getElementById('map-road-owners-note').textContent),
    null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  const near = exports[exports.length - 1];
  const [top, casing] = near.dynamicLayers;
  const infos = Object.fromEntries((top.drawingInfo.renderer.uniqueValueInfos || []).map(i => [i.value, i.symbol]));
  check('close in, every road is drawn — footpaths, bikeways, ferries and proposed roads left out',
    top.definitionExpression === "class NOT IN ('Walkway','Bikeway','Ferry') AND op_status_ind <> 'Proposed'",
    top.definitionExpression);
  check('…coloured by owner, with a State-controlled road’s key forced to TMR',
    /IIf\(\$feature\.scr_indicator == 'T', 'TMR', \$feature\.road_owner\)/.test(top.drawingInfo.renderer.valueExpression || ''),
    top.drawingInfo.renderer.valueExpression);
  check('…TMR maroon and heaviest, the council slate, private dashed, the parks green',
    J(infos.TMR.color) === J([142, 21, 55, 255]) && infos.TMR.width === 1.2
      && J(infos.LG.color) === J([55, 71, 79, 255]) && infos.Private.style === 'esriSLSDash'
      && J(infos.QPWS.color) === J([46, 125, 50, 255]) && J(infos.Forestry.color) === J(infos.QPWS.color),
    J({ TMR: infos.TMR, LG: infos.LG, Private: infos.Private }));
  check('…every owner code the data dictionary defines has a symbol',
    ['TMR', 'LG', 'QPWS', 'STATE', 'WA', 'PA', 'UP', 'Private', 'Other', 'Unknown'].every(k => infos[k]), J(Object.keys(infos)));
  check('…and the casing is listed second, which is under', casing.drawingInfo.renderer.type === 'simple'
    && casing.drawingInfo.renderer.symbol.width > infos.TMR.width, J(casing.drawingInfo.renderer));

  const drawnNow = await page.evaluate(() => ({
    img: !!document.querySelector('.leaflet-mnRoadOwners-pane img'),
    pins: document.querySelectorAll('.leaflet-mnBridges-pane .mn-bridge-pin').length,
    pe: [getComputedStyle(document.querySelector('.leaflet-mnRoadOwners-pane')).pointerEvents,
         getComputedStyle(document.querySelector('.leaflet-mnBridges-pane')).pointerEvents],
    interactive: document.querySelectorAll('.leaflet-mnBridges-pane .leaflet-interactive').length,
    note: document.getElementById('map-road-owners-note').textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('the image is on the map in a pane of its own', drawnNow.img, J(drawnNow));
  check('three bridge pins — QRT’s copy of Sandy Creek Bridge merged into the register’s, its two carriageways one pin',
    drawnNow.pins === 3, J(drawnNow));
  check('…and neither pane takes the pointer', drawnNow.pe.every(v => v === 'none') && drawnNow.interactive === 0, J(drawnNow.pe));
  check('the note counts them, and how many are State-controlled',
    /\b3 bridges in view, 2 of them State-controlled/.test(drawnNow.note), drawnNow.note);
  check('the bridges were asked of the register and of QRT by the ids their names resolve to',
    queries.some(q => q.layer === 'StateRoadInformation/9') && queries.some(q => q.layer === 'RoadsAndTracks/24')
      && wrongIds.length === 0, J({ wrongIds }));

  const key = await legend();
  check('the legend keys all six road classes and both kinds of bridge',
    ['Road — State-controlled', 'Road — the council’s, as recorded', 'Road — not State-controlled, owner not recorded',
     'Road — national park or State forest', 'Road — private', 'Road — port, water or utility authority']
      .every(t => key.includes(t)) && /Bridge — State-controlled/.test(key) && /Bridge — not State-controlled/.test(key),
    key.replace(/\s+/g, ' ').slice(0, 300));
  check('…and the Also available line stops naming it', !/Also available[^<]*Road &amp; bridge owners/.test(key));

  // ── Hover and click ─────────────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__ptAt = (lat, lon) => {
      const pt = state.map.latLngToContainerPoint([lat, lon]);
      const r = state.map.getContainer().getBoundingClientRect();
      return { x: r.left + pt.x, y: r.top + pt.y };
    };
  });
  const hoverAt = async (lat, lon) => {
    const at = await page.evaluate(([a, b]) => window.__ptAt(a, b), [lat, lon]);
    await page.mouse.move(at.x + 90, at.y + 90);
    await page.waitForTimeout(150);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(220);
    return page.evaluate(() => {
      const el = document.querySelector('.leaflet-tooltip.mn-bridge-label');
      return el ? el.textContent.trim() : null;
    });
  };
  const sandy = await hoverAt(-21.0, 146.0100);
  check('hovering the State bridge names it, its manager and the road it carries',
    sandy === 'Sandy Creek Bridge — Transport and Main Roads · Flinders Highway', String(sandy));
  const over = await hoverAt(-21.0, 145.9950);
  check('an overpass says it is over the road, not on it',
    over === 'Rail Overpass — Transport and Main Roads · over Flinders Highway', String(over));
  const gauge = await hoverAt(-20.99, 146.005);
  check('the bridge on no register says it is not State-controlled — normally the council’s',
    gauge === 'Road Bridge — not State-controlled: normally the council’s', String(gauge));
  const nothing = await hoverAt(-20.995, 146.015);
  check('and empty ground names nothing', nothing === null, String(nothing));

  // A callout already open is closed first, and the map let settle: Leaflet
  // pans to fit a callout, and the next bridge can be under the last one's.
  const clickAt = async (lat, lon) => {
    await page.evaluate(() => state.map.closePopup());
    await page.waitForFunction(() => !document.querySelector('.leaflet-popup-content')
      && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
    await page.waitForTimeout(150);
    const at = await page.evaluate(([a, b]) => window.__ptAt(a, b), [lat, lon]);
    await page.mouse.click(at.x, at.y);
    await page.waitForFunction(() => /who to call|TMR here|council here|unavailable/i.test(
      (document.querySelector('.leaflet-popup-content') || {}).textContent || ''), null, { timeout: 10_000 });
    await page.waitForFunction(() => !/Looking up who to call/.test(
      (document.querySelector('.leaflet-popup-content') || {}).textContent || ''), null, { timeout: 10_000 });
    return page.evaluate(() => {
      const el = document.querySelector('.leaflet-popup-content');
      return { text: el.textContent.replace(/\s+/g, ' ').trim(), html: el.innerHTML };
    });
  };
  const sandyPop = await clickAt(-21.0, 146.0100);
  check('clicking the State bridge opens its callout: the register’s structure and what it is built of',
    /State-controlled bridge — managed by Transport and Main Roads/.test(sandyPop.text)
      && /Carries Flinders Highway/.test(sandyPop.text) && /Structure 4242 · Deck Unit, Pre-Stressed Concrete/.test(sandyPop.text),
    sandyPop.text);
  check('…and who to call: the TMR district QLDTraffic names there, with its phone and email',
    /TMR here: Department of Transport and Main Roads, Northern District · 07 4758 7500 · northern\.district@tmr\.qld\.gov\.au/
      .test(sandyPop.text) && /href="tel:0747587500"/.test(sandyPop.html), sandyPop.text);
  check('…a website the lookup answered that is not https is not made a link', !/javascript:/i.test(sandyPop.html));
  check('…the lookup was asked about the bridge’s own point',
    lookups.some(l => Math.abs(l.lat - (-21.0)) < 1e-4 && Math.abs(l.lng - 146.01) < 1e-4), J(lookups));
  const gaugePop = await clickAt(-20.99, 146.005);
  check('the council’s bridge: not on the register, managed with its road, and the council to call',
    /Not on Transport and Main Roads’ register/.test(gaugePop.text)
      && /The council here: Charters Towers Regional Council · 07 4761 5300/.test(gaugePop.text), gaugePop.text);
  const overPop = await clickAt(-21.0, 145.9950);
  check('where the lookup names the road’s own operator, the callout says operator — not TMR',
    /The road’s operator: Overpass Road Services · 1300 000 000 · roads@example\.org · website/.test(overPop.text)
      && !/TMR here/.test(overPop.text) && /href="https:\/\/example\.org\/roads"/.test(overPop.html), overPop.text);
  await page.evaluate(() => state.map.closePopup());

  // ── What is here, on the highway by the bridge ──────────────────────────────
  const section = async (elId) => {
    await page.waitForFunction(id => {
      const g = document.querySelector(`#${id} .stn-card-roads`);
      return !!g && !g.hasAttribute('aria-busy');
    }, elId, { timeout: 15_000 });
    return page.evaluate(id => {
      const el = document.getElementById(id);
      const t = x => x.textContent.replace(/\s+/g, ' ').trim();
      const rows = [];
      for (const r of el.querySelectorAll('.acma-row')) rows.push([t(r.children[0]), t(r.children[1])]);
      return {
        rows, text: t(el), key: el.dataset.mnRoads,
        sum: [...el.querySelectorAll('.stn-card-exp-sum li')].map(t),
        links: [...el.querySelectorAll('.stn-card-exp-sum a')].map(a => a.getAttribute('href')),
        retry: !!el.querySelector('.stn-card-exp-retry'),
        fail: (el.querySelector('.txt-warn.stn-card-exp-foot') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      };
    }, elId);
  };
  const rowOf = (s, label) => (s.rows.filter(r => r[0] === label).map(r => r[1]));

  await page.evaluate(() => { MapHere.arm(true); MapHere.pick(-21.00002, 146.01005); });
  const hw = await section('mn-roads-here');
  check('What is here on the highway: the road, its route and that it is here',
    rowOf(hw, 'Road')[0] === 'Flinders Highway route A6 · here', J(hw.rows));
  check('…managed by Transport and Main Roads', rowOf(hw, 'Managed by')[0] === 'Transport and Main Roads — State-controlled', J(hw.rows));
  check('…the bridge it is on, with the register’s structure number',
    /^Sandy Creek Bridge here Transport and Main Roads — structure 4242$/.test(rowOf(hw, 'Bridge')[0] || ''), J(hw.rows));
  check('…and the TMR district to call, named once though both the road and the bridge are TMR’s',
    rowOf(hw, 'Contact').length === 1 && /^Department of Transport and Main Roads, Northern District · 07 4758 7500/.test(rowOf(hw, 'Contact')[0]),
    J(rowOf(hw, 'Contact')));
  check('…a summary that says a road corridor permit, with TMR’s permit page and QLDTraffic',
    hw.sum.some(l => /road corridor permit/.test(l)) && hw.links.includes('https://www.tmr.qld.gov.au/rcp')
      && hw.links.includes('https://qldtraffic.qld.gov.au/'), J({ sum: hw.sum, links: hw.links }));

  // ── …on Gauge Road, where a footpath is closer ──────────────────────────────
  await page.evaluate(() => { MapHere.arm(true); MapHere.pick(-20.9822, 146.00515); });
  const lg = await section('mn-roads-here');
  check('on the council road the footpath beside it is not taken for the road',
    /^Gauge Road (\d+ m away|here)$/.test(rowOf(lg, 'Road')[0] || ''), J(lg.rows));
  check('…the roads query asked for roads alone',
    queries.filter(q => q.layer === 'RoadsAndTracks/11').every(q => /class NOT IN \('Walkway','Bikeway','Ferry'\)/.test(q.where)),
    J(queries.filter(q => q.layer === 'RoadsAndTracks/11').map(q => q.where)));
  check('…recorded as the council’s, and named', rowOf(lg, 'Managed by')[0] === 'Charters Towers Regional Council — as the State records it',
    J(lg.rows));
  check('…no bridge within 150 m', rowOf(lg, 'Bridge')[0] === 'none within 150 m', J(lg.rows));
  check('…the council to call, and no TMR district this far from the highway',
    rowOf(lg, 'Contact').length === 1 && /^Charters Towers Regional Council · 07 4761 5300/.test(rowOf(lg, 'Contact')[0]), J(lg.rows));

  // ── …on the track nobody has recorded an owner for ──────────────────────────
  await page.evaluate(() => { MapHere.arm(true); MapHere.pick(-21.02, 145.98502); });
  const tr = await section('mn-roads-here');
  check('an unnamed track with no owner recorded: not named "Track", and not claimed for anybody',
    rowOf(tr, 'Road')[0] === 'An unnamed track here'
      && rowOf(tr, 'Managed by')[0] === 'Not State-controlled — Charters Towers Regional Council, or private', J(tr.rows));
  check('…and the summary says the State has not recorded which',
    tr.sum.some(l => /has not recorded whether it is Charters Towers Regional Council’s or private/.test(l)), J(tr.sum));

  // ── The lookup down: the contact fails alone, and Try again answers ─────────
  lookupDown = true;
  await page.evaluate(() => { MapHere.arm(true); MapHere.pick(-21.015, 146.02); });
  const down = await section('mn-roads-here');
  check('with QLDTraffic’s lookup unreachable, the road and its owner still stand',
    rowOf(down, 'Road')[0] === 'Jacksons Lane here' && rowOf(down, 'Managed by')[0] === 'Private — the owner of the land it crosses',
    J(down.rows));
  check('…the contact row says it could not be read and names the source',
    /^could not be read — QLDTraffic’s road lookup$/.test(rowOf(down, 'Contact')[0] || ''), J(down.rows));
  check('…with the failure in words and Try again', /QLDTraffic’s road lookup \(unreachable/.test(down.fail) && down.retry, down.fail);
  lookupDown = false;
  await page.click('#mn-roads-here .stn-card-exp-retry');
  await page.waitForFunction(() => !/could not be read/.test(document.getElementById('mn-roads-here').textContent), null, { timeout: 15_000 });
  const back = await section('mn-roads-here');
  check('Try again asks the lookup again at once, and the private road has nobody in its directory',
    /^not in QLDTraffic’s directory — the owner of the land it crosses$/.test(rowOf(back, 'Contact')[0] || '') && !back.retry,
    J(back.rows));

  // ── Outside Queensland ──────────────────────────────────────────────────────
  const before = queries.length + lookups.length;
  await page.evaluate(() => { MapHere.arm(true); MapHere.pick(-33.80, 151.00); });
  await page.waitForTimeout(600);
  const nsw = await page.evaluate(() => document.getElementById('mn-roads-here').textContent.replace(/\s+/g, ' ').trim());
  check('a point in New South Wales is told the data stops at the border, and nothing is asked',
    /Not in Queensland/.test(nsw) && queries.length + lookups.length === before, nsw.slice(0, 160));
  await page.evaluate(() => MapHere.close());

  // ── The station card carries the section ────────────────────────────────────
  const sid = await page.evaluate(() => {
    const s = state.data.stations.find(x => x.lat != null && x.lat < -20 && x.lat > -27 && x.lon > 140 && x.lon < 150 && !x.proposed);
    showStationCard(s.id);
    return s.id;
  });
  const card = await section(`mn-roads-card-${sid}`);
  check('a Queensland station’s card has the Road and bridge section, asked and answered',
    /Road and bridge — who manages them/.test(card.text) && rowOf(card, 'Road').length === 1 && rowOf(card, 'Bridge').length === 1,
    J({ sid, rows: card.rows }));
  await page.evaluate(() => closeStnCard());

  // ── Off ─────────────────────────────────────────────────────────────────────
  await page.evaluate(() => MapRoadOwners.setEnabled(false));
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({
    img: !!document.querySelector('.leaflet-mnRoadOwners-pane img'),
    pins: document.querySelectorAll('.leaflet-mnBridges-pane .mn-bridge-pin').length,
    note: document.getElementById('map-road-owners-note').textContent.trim(),
    legend: document.getElementById('map-legend').innerHTML,
    stored: localStorage.getItem('mn-road-owners'),
  }));
  check('turning it off takes the image, the pins and their legend keys with it',
    !off.img && off.pins === 0 && /hidden/.test(off.note) && !/Road — State-controlled/.test(off.legend)
      && off.stored === 'off', J({ ...off, legend: off.legend.length }));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — every road keyed by who manages it, every bridge by whose it is, and who to call.');
