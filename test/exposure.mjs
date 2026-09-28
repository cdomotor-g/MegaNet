// Site exposure on the station card — tidal water, the Water Act's downstream
// limits, the coastal hazard areas and acid sulfate soils, asked of the
// Queensland Government's map services (site-exposure.js).
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * A question nobody answered never reads as an answer. The failure this
//     section is most at risk of is an empty reply and a failed request
//     looking the same to a template — "Not in a mapped storm tide area" for a
//     server that answered 500. So a source that fails is named, with why, on
//     the row and under the rows, and nothing is claimed from it; and a failed
//     source is not asked again on every repaint, but is when Try again is
//     pressed, by keyboard, with focus kept in the card.
//   * A station outside Queensland is told so, in words. These are the State's
//     maps and they stop at the border; a New South Wales station that read
//     "None within 10 km · Not mapped here" would be carrying findings nobody
//     made. One far outside asks nothing at all; one inside the State's box
//     (Banora, across the Tweed) asks only enough to find out.
//   * The rows are the service's answers: the finest soil map that covers the
//     point wins over a coarser one, the Water Act limit on the station's own
//     stream wins over a nearer one on another, a national atlas class is said
//     to be inferred, and the tide levels already on the station's record are
//     put in AHD only through a gauge zero surveyed in AHD.
//   * It costs what the header says: staged (nothing coastal asked for an
//     inland station), never more than four in flight, every feature query
//     naming its fields, a second open of the same card asking nothing, and a
//     card that moves to another station dropping the old one's queue.
//   * It is sane to a keyboard and a screen reader: a named group, no heading
//     that breaks the outline `npm run tabs` holds, every control named, links
//     out opening a new tab without handing it this window, no inline style,
//     and no sideways scroll at 375 px with every disclosure open.
//
// The services are external and this harness blocks outbound requests
// (lib/network.mjs), so the check answers them itself: one stub per layer, in
// the shape the live service returns (captured 28 September 2026 — a count
// query is {"count": n}; a feature query carries fields, aliases and
// features), keyed by the station the point belongs to. Anything else on that
// host — the survey marks, the cadastre — falls through to the policy's abort.
//
// Run:  npm run exposure
//       npm run exposure -- -v    also print what passed

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const log = (...a) => console.log(...a);

const stations = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const station = id => {
  const s = stations.find(x => x.id === id);
  if (!s) throw new Error(`stations.json has no ${id} — pick another station for this scenario`);
  return s;
};

// ── The service, answered ───────────────────────────────────────────────────

const LAYER = {
  'Boundaries/AdministrativeBoundaries/MapServer/1': 'lga',
  'Environment/Fisheries/MapServer/15': 'tidal',
  'Boundaries/AdminBoundariesFramework/MapServer/199': 'hat',
  'InlandWaters/WatercourseIdentificationMap/MapServer/200': 'limit',
  'PlanningCadastre/CoastalManagement/MapServer/5': 'cmd',
  'PlanningCadastre/CoastalManagement/MapServer/9': 'hat40',
  'PlanningCadastre/CoastalManagement/MapServer/11': 'stHigh',
  'PlanningCadastre/CoastalManagement/MapServer/12': 'stMed',
  'PlanningCadastre/CoastalManagement/MapServer/13': 'stNone',
  'GeoscientificInformation/SoilsAndLandResource/MapServer/1902': 'ass25',
  'GeoscientificInformation/SoilsAndLandResource/MapServer/1952': 'ass50',
  'GeoscientificInformation/SoilsAndLandResource/MapServer/2002': 'ass100',
  'GeoscientificInformation/SoilsAndLandResource/MapServer/2052': 'assNat',
  'GeoscientificInformation/SoilsAndLandResource/MapServer/1850': 'assSite',
};
const COASTAL = ['limit', 'cmd', 'hat40', 'stHigh', 'stMed', 'stNone', 'assSite'];
// The distance each question is asked within, as the module's header states it.
const DISTANCE = { lga: null, lgaNear: 1000, tidalIn: 50, hat100: 100, hat1k: 1000, hat10k: 10000,
                   limit: 20000, assSite: 2000 };
const COUNTED = new Set(['tidalIn', 'hat100', 'hat1k', 'hat10k', 'cmd', 'hat40', 'stHigh', 'stMed', 'stNone']);

const FAIL_500 = { fail: 500 };
const FAIL_NET = { fail: 'net' };

const S1 = { map_code: 'S1', map_code_meaning: 'Potential ASS starting at 0.5 to 1m', project_code: 'SEA' };
const LP = { map_code: 'LP', map_code_meaning: 'Land at or below 5m AHD with low probability of ASS', project_code: 'SEA' };
const A1 = { map_code: 'A1', map_code_meaning: 'Actual ASS starting at 0.5 to 1m', project_code: 'SEA' };
const NAT_B = { probclass: 'B', probclass_def: 'Low probability of occurrence (6-70%)', mapscale: '1:2M',
                mapclass: 'ASS in inland lakes, waterways, wetlands and riparian zones',
                source: 'Aust Soils Classification & 1:250K Hydrography' };
const REPORT = 'https://resources.information.qld.gov.au/soils/reports/sites?project=SEA&site=1555';

// One answer per layer per station. A layer a scenario leaves out is a layer
// that station must not ask — the stub answers it with an ArcGIS error and
// records it as unexpected.
const SCENARIO = {
  // In the tide on the Brisbane River: every coastal layer, a Water Act limit
  // on another creek nearer than the one on its own river, the finest soil map
  // over a coarser one that disagrees, and two sample sites.
  jindalee_al: {
    lga: ['Brisbane City'], tidalIn: 1,
    limit: [{ name: 'Norman Creek', reference: 'Norman Creek (Stones Corners)', km: 3.0 },
            { name: 'Brisbane River', reference: 'AP-TEST', km: 12.0 }],
    cmd: 1, hat40: 1, stHigh: 1, stMed: 0, stNone: 0,
    ass25: S1, ass50: null, ass100: LP, assNat: null,
    assSite: [{ km: 0.6, project_code: 'SEA', site_id: 1555, core_depth_m: 2, laboratory_data_available: 'Yes',
                field_ph_available: 'Yes', site_report_url: REPORT },
              { km: 1.5, project_code: 'SEA', site_id: 1554, core_depth_m: 5.5, laboratory_data_available: 'Yes' }],
  },
  // Out of the tide, within 1 km of the highest-tide line; only the national
  // atlas says anything about the soil.
  palmview_al: {
    lga: ['Sunshine Coast Regional'], tidalIn: 0, hat100: 0, hat1k: 1, hat10k: 1,
    limit: [], cmd: 0, hat40: 0, stHigh: 0, stMed: 0, stNone: 1,
    ass25: null, ass50: null, ass100: null, assNat: NAT_B, assSite: [],
  },
  // Inland: no tide within 10 km, no soil mapping, and so no coastal layer.
  abbieglassie_al: {
    lga: ['Maranoa Regional'], tidalIn: 0, hat100: 0, hat1k: 0, hat10k: 0,
    ass25: null, ass50: null, ass100: null, assNat: null,
  },
  // On the shore: in no local government area, within 1 km of one.
  coolangatta: {
    lga: [], tidalIn: 0, lgaNear: ['Gold Coast City'], hat100: 0, hat1k: 1, hat10k: 1,
    limit: [], cmd: 0, hat40: 0, stHigh: 0, stMed: 0, stNone: 0,
    ass25: null, ass50: null, ass100: null, assNat: null, assSite: [],
  },
  // New South Wales, inside Queensland's box: coverage asked, nothing else.
  banora_sewerage_tre: { lga: [], tidalIn: 0, lgaNear: [] },
  // Two sources fail — one with a 500, one never reaching the host — and
  // answer once `healed` is set and Try again is pressed.
  moggill_al: {
    lga: ['Brisbane City'], tidalIn: 1,
    limit: [], cmd: 1, hat40: 0, stHigh: FAIL_500, stMed: 0, stNone: 0,
    ass25: FAIL_NET, ass50: A1, ass100: null, assNat: null, assSite: [],
    healed: { stHigh: 0, ass25: S1 },
  },
  // Slow, so a card can move on while its first questions are in flight.
  golden_beach_al: {
    slow: 400,
    lga: ['Sunshine Coast Regional'], tidalIn: 1,
    limit: [], cmd: 1, hat40: 1, stHigh: 0, stMed: 1, stNone: 0,
    ass25: null, ass50: null, ass100: null, assNat: NAT_B, assSite: [],
  },
};
const AWAY = 'awaba_stony_ck';          // New South Wales, far outside the box
const ALL = [...Object.keys(SCENARIO), AWAY];

const km2deg = km => km / 110.574;

function featureSet(fields, rows, points) {
  return {
    displayFieldName: fields[0],
    fieldAliases: Object.fromEntries(fields.map(f => [f, f])),
    ...(points ? { geometryType: 'esriGeometryPoint', spatialReference: { wkid: 4326, latestWkid: 4326 } } : {}),
    fields: fields.map(f => ({ name: f, type: 'esriFieldTypeString', alias: f, length: 255 })),
    features: rows,
  };
}

// What the stub says for one layer at one station, as { status, body } — or
// { abort: true } for a request that never reaches the host.
function answer(sid, layer, fields, flags) {
  const sc = SCENARIO[sid] || {};       // AWAY has none: anything it asks is unexpected
  const s = station(sid);
  let a = sc.healed && flags.healed && layer in sc.healed ? sc.healed[layer] : sc[layer];
  if (a === undefined) return { status: 200, body: { error: { code: 400, message: `unexpected: ${layer}` } }, unexpected: true };
  if (a && a.fail === 500) return { status: 500, body: 'Internal Server Error', text: true };
  if (a && a.fail === 'net') return { abort: true };
  if (COUNTED.has(layer)) return { status: 200, body: { count: a } };
  if (layer === 'lga' || layer === 'lgaNear') {
    return { status: 200, body: featureSet(['lga'], a.map(n => ({ attributes: { lga: n } }))) };
  }
  if (layer === 'limit' || layer === 'assSite') {
    const rows = a.map(p => {
      const attributes = Object.fromEntries(fields.map(f => [f, p[f] ?? null]));
      if (layer === 'limit') attributes.determined = 1277424000000;
      return { attributes, geometry: { x: s.lon, y: Number(s.lat) + km2deg(p.km) } };
    });
    return { status: 200, body: featureSet(fields, rows, true) };
  }
  return { status: 200, body: featureSet(fields, a ? [{ attributes: { ...a } }] : []) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const asked = [];              // every request the stub answered: { sid, layer, ... }
const flags = { healed: false };
let inFlight = 0, maxInFlight = 0;

// Which scenario station a query point belongs to. The module rounds to four
// decimal places before it asks, so a point is matched to within that.
function stationAt(lon, lat) {
  const hit = ALL.map(station).find(s => Math.abs(Number(s.lat) - lat) < 6e-5 && Math.abs(Number(s.lon) - lon) < 6e-5);
  return hit ? hit.id : null;
}

async function stub(page) {
  // Registered after the policy so it runs first (Playwright: newest route
  // first); anything this file does not answer falls back to the policy.
  await page.route(/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\//, async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/arcgis\/rest\/services\/(.+?\/MapServer\/\d+)\/query$/);
    const base = m && LAYER[m[1]];
    const [lon, lat] = (url.searchParams.get('geometry') || '').split(',').map(Number);
    const sid = base ? stationAt(lon, lat) : null;
    if (!base || !sid) return route.fallback();
    const q = url.searchParams;
    const distance = q.get('distance') ? Number(q.get('distance')) : null;
    const layer = base === 'lga' ? (distance ? 'lgaNear' : 'lga')
      : base === 'tidal' ? 'tidalIn'
      : base === 'hat' ? { 100: 'hat100', 1000: 'hat1k', 10000: 'hat10k' }[distance] || 'hat?'
      : base;
    const fields = (q.get('outFields') || '').split(',').filter(Boolean);
    const rec = { sid, layer, distance, count: q.get('returnCountOnly') === 'true', outFields: q.get('outFields'),
                  inSR: q.get('inSR'), type: q.get('geometryType'), rel: q.get('spatialRel'),
                  units: q.get('units'), geometry: q.get('returnGeometry'), outSR: q.get('outSR') };
    asked.push(rec);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep((SCENARIO[sid] && SCENARIO[sid].slow) || 40);
      const a = answer(sid, layer, fields, flags);
      rec.unexpected = !!a.unexpected;
      if (a.abort) return await route.abort('failed');
      return await route.fulfill({
        status: a.status,
        contentType: a.text ? 'text/plain' : 'application/json;charset=UTF-8',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: a.text ? a.body : JSON.stringify(a.body),
      });
    } finally {
      inFlight--;
    }
  });
}

// The section, read: its rows, its summary, its tide lines, the failure line.
const read = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(`mn-exposure-card-${id}`);
  if (!el) return null;
  const g = el.querySelector('.stn-card-exp');
  const t = x => x.textContent.replace(/\s+/g, ' ').trim();
  const rows = {};
  for (const r of el.querySelectorAll('.acma-row')) rows[t(r.children[0])] = t(r.children[1]);
  const fail = el.querySelector('.txt-warn.stn-card-exp-foot');
  return {
    key: el.dataset.mnExposure,
    text: g ? t(g) : t(el),
    rows,
    items: [...el.querySelectorAll('.stn-card-exp-sum li')].map(t),
    tide: [...el.querySelectorAll('.stn-card-exp-tide .mn-pop-line')].map(t),
    tideHead: (() => { const h = el.querySelector('.stn-card-exp-tide'); return h ? t(h).split(' HAT')[0] : ''; })(),
    fail: fail ? t(fail) : '',
    retry: !!el.querySelector('.stn-card-exp-retry'),
    sources: [...el.querySelectorAll('.stn-card-exp-src li')].map(t),
    busy: g ? g.hasAttribute('aria-busy') : false,
  };
}, id);

// Every layer has answered or failed: nothing is marked busy and no row is
// still asking.
const settle = (page, id, timeout = 20_000) => page.waitForFunction((id) => {
  const el = document.getElementById(`mn-exposure-card-${id}`);
  const g = el && el.querySelector('.stn-card-exp');
  return !!g && !g.hasAttribute('aria-busy') && !/asking…/.test(g.textContent);
}, id, { timeout });

const askedFor = sid => asked.filter(r => r.sid === sid);
const layersFor = sid => askedFor(sid).map(r => r.layer).sort();

async function openStations(contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await stub(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom
    && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
  await page.waitForTimeout(150);
  return { context, page };
}

try {
  const { page } = await openStations({ viewport: { width: 1440, height: 950 } });

  // ── A station in the tide ─────────────────────────────────────────────────
  // Opened by name: its pin shares its pixels with jindalee_tm's, and a click
  // there fans the stack out (MapSpider) instead. The real pin click is
  // PALMVIEW's, below, whose pin stands alone.
  log('\nIn the tide — every coastal layer\n');
  await page.evaluate(() => showStationCard('jindalee_al'));
  await settle(page, 'jindalee_al');
  const jin = await read(page, 'jindalee_al');
  const J = station('jindalee_al');

  check('the card carries a site exposure section, keyed by the rounded position',
    !!jin && jin.key === `${Number(J.lat).toFixed(4)},${Number(J.lon).toFixed(4)}`, JSON.stringify(jin && jin.key));
  check('…placed after the AEP section and before the SLS section',
    await page.evaluate(() => {
      const card = document.getElementById('stn-card');
      const kids = [...card.children];
      const exp = kids.findIndex(e => e.id && e.id.startsWith('mn-exposure-card-'));
      const sls = kids.findIndex(e => e.id && e.id.startsWith('mn-sls-card-'));
      const aep = kids.findIndex(e => e.classList.contains('stn-card-aep'));
      return exp > 0 && sls === exp + 1 && (aep < 0 || aep === exp - 1);
    }));
  check('in tidal water, from the tidal waterways map within 50 m',
    /^In tidal water/.test(jin.rows['Tidal water'] || '') && /within 50 m/.test(jin.rows['Tidal water']),
    jin.rows['Tidal water']);
  check('the Water Act limit on its own river wins over a nearer one on another creek',
    /^Brisbane River/.test(jin.rows['Tidal limit'] || '') && /12 km away/.test(jin.rows['Tidal limit'])
      && /on this station’s stream/.test(jin.rows['Tidal limit']), jin.rows['Tidal limit']);
  check('coastal management district, and within 40 m of HAT',
    /In the coastal management district/.test(jin.rows.Coast || '') && /within 40 m of HAT/.test(jin.rows.Coast),
    jin.rows.Coast);
  check('storm tide high hazard, said with its depth',
    /^High hazard/.test(jin.rows['Storm tide'] || '') && /more than 1 m/.test(jin.rows['Storm tide']),
    jin.rows['Storm tide']);
  check('the finest soil map that covers the point wins, in its own words and with its scale',
    (jin.rows['Acid sulfate'] || '').includes(S1.map_code_meaning) && /1:25 000 map/.test(jin.rows['Acid sulfate'])
      && !/low probability/.test(jin.rows['Acid sulfate']), jin.rows['Acid sulfate']);
  check('the national atlas is reported, and its absence explained rather than read as a finding',
    /not given here/.test(jin.rows['National atlas'] || '') && /finer mapping/.test(jin.rows['National atlas']),
    jin.rows['National atlas']);
  check('the nearest sample site, how far, how many, and its report',
    /^0\.6 km away/.test(jin.rows['ASS sample'] || '') && /SEA site 1555/.test(jin.rows['ASS sample'])
      && /cored to 2 m/.test(jin.rows['ASS sample']) && /2 within 2 km/.test(jin.rows['ASS sample']),
    jin.rows['ASS sample']);
  const report = await page.evaluate(() => {
    const a = document.querySelector('#mn-exposure-card-jindalee_al .acma-row a[href]');
    return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel, name: a.getAttribute('aria-label') || '' };
  });
  check('…the report opening in a new tab without handing it this window',
    !!report && report.href === REPORT && report.target === '_blank' && /\bnoopener\b/.test(report.rel)
      && /new tab/.test(report.name), JSON.stringify(report));

  // The station's own record: HAT from crossing type T, and the tide levels
  // among its flood effects, through a gauge zero surveyed in AHD.
  const zero = (J.gauge_survey || [])[0];
  const hatT = (J.crossings || []).find(c => c.crossing_type === 'T');
  check('the record’s own HAT is on the card, in AHD through its surveyed gauge zero',
    !!zero && zero.datum === 'AHD' && !!hatT
      && jin.tide.includes(`HAT — ${hatT.height_m.toFixed(2)} m on the gauge ≈ ${(zero.gauge_zero_m + hatT.height_m).toFixed(2)} m AHD`)
      && /gauge zero 0\.00 m AHD/.test(jin.tideHead), JSON.stringify({ tide: jin.tide, head: jin.tideHead }));
  check('…with the flood effects’ MHWS beside it',
    jin.tide.some(l => /^MHWS — /.test(l)), JSON.stringify(jin.tide));

  // The same record with its gauge zero changed, rendered straight from the
  // module and moved to Sydney so nothing is asked: a height goes into AHD
  // only through a zero surveyed in AHD, and a zero that would put HAT at
  // 133 m AHD is a record to check, not a figure to print. No live station
  // has either today (Cairns Harbour and Jindalee (Centenary) have no zero at
  // all), which is why it is made here rather than found.
  const datum = await page.evaluate(() => {
    const s = state.data.stations.find(x => x.id === 'jindalee_al');
    const at = (survey) => {
      const d = document.createElement('div');
      d.innerHTML = SiteExposure.html({ ...s, id: 'exposure-check', lat: -33.87, lon: 151.21, gauge_survey: survey });
      const b = d.querySelector('.stn-card-exp-tide');
      return b ? b.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    return {
      assumed: at([{ valid_from: '1994-10-01', gauge_zero_m: 0.0, datum: 'ASSUM' }]),
      none:    at([]),
      absurd:  at([{ valid_from: '1981-11-01', gauge_zero_m: 131.22, datum: 'AHD' }]),
    };
  });
  check('a gauge zero on an assumed datum is said, and nothing is put in AHD through it',
    /not put in AHD/.test(datum.assumed) && !/≈/.test(datum.assumed), datum.assumed);
  check('no gauge zero at all leaves heights on the gauge only',
    /no gauge zero recorded — heights on the gauge only/.test(datum.none) && !/≈/.test(datum.none), datum.none);
  check('a zero that would put HAT at 133 m AHD is not printed as a height',
    /HAT — 1\.87 m on the gauge/.test(datum.absurd) && !/≈/.test(datum.absurd), datum.absurd);

  check('the summary says salt water at high tide',
    jin.items.some(t => /^Salt or brackish water at high tide/.test(t)), JSON.stringify(jin.items));
  check('…a storm surge more than 1 m deep',
    jin.items.some(t => /storm tide area, more than 1 m deep/.test(t)), JSON.stringify(jin.items));
  check('…the station’s recorded ground set against HAT on its own gauge',
    jin.items.some(t => t.includes(`(${Number(J.elevation_ahd).toFixed(2)} m AHD, modelled) is below HAT on this gauge (1.87 m AHD)`)),
    JSON.stringify(jin.items));
  check('…and acid sulfate soils likely, what disturbing them does, and to what',
    jin.items.some(t => /^Acid sulfate soils likely, at the depth the map gives/.test(t)
      && /sulfuric acid/.test(t) && /concrete and steel/.test(t)), JSON.stringify(jin.items));
  check('…flagged indicative, pointing at a site investigation',
    /Indicative — read off maps/.test(jin.text) && /site investigation/.test(jin.text));
  check('nothing failed, so nothing says it did',
    !jin.fail && !jin.retry && !/could not be read/.test(jin.text), jin.fail);
  check('the sources name each dataset asked, its custodian and its licence',
    jin.sources.some(t => /Queensland waterways for waterway barrier works — tidal/.test(t) && /CC BY 4\.0/.test(t))
      && jin.sources.some(t => /Acid sulfate soils series/.test(t) && /CC BY 3\.0 AU/.test(t))
      && jin.sources.some(t => /Storm tide/.test(t))
      && jin.sources.some(t => /Watercourse identification map/.test(t)),
    JSON.stringify(jin.sources.slice(0, 4)));

  const want = ['lga', 'tidalIn', 'ass25', 'ass50', 'ass100', 'assNat', ...COASTAL].sort();
  check('in the tide it asks thirteen questions, one per layer, none of the tide-line bands',
    JSON.stringify(layersFor('jindalee_al')) === JSON.stringify(want), JSON.stringify(layersFor('jindalee_al')));

  // ── The outline, the names, the rules the tabs check holds ───────────────
  const a11y = await page.evaluate(() => {
    const el = document.getElementById('mn-exposure-card-jindalee_al');
    const g = el.querySelector('.stn-card-exp');
    const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const main = document.getElementById('main-content');
    const roots = [main, ...[...document.querySelectorAll('#help-panel .dock-pane')].filter(p => !p.hidden && visible(p))];
    const levels = [
      ...[...document.querySelectorAll('header h1')].filter(visible).map(() => 1),
      ...roots.flatMap(r => [...r.querySelectorAll('h1, h2, h3, h4, h5, h6')]).filter(visible).map(h => Number(h.tagName[1])),
    ];
    const skips = [];
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skips.push(`h${levels[i - 1]}→h${levels[i]}`);
    const label = document.getElementById(g.getAttribute('aria-labelledby') || '');
    const name = c => (c.getAttribute('aria-label') || c.textContent || c.getAttribute('title') || '').trim();
    const controls = [...el.querySelectorAll('a[href], button, summary, [tabindex]:not([tabindex="-1"])')];
    return {
      inMain: main.contains(el),
      skips, headingsInSection: el.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
      role: g.getAttribute('role'), label: label ? label.textContent.trim() : null,
      unnamed: controls.filter(c => !name(c)).map(c => c.outerHTML.slice(0, 60)),
      linksOut: [...el.querySelectorAll('a[href]')].every(a => a.target === '_blank' && /\bnoopener\b/.test(a.rel)),
      inline: el.querySelectorAll('[style]').length,
    };
  });
  check('the section is a group named by its heading', a11y.role === 'group'
    && a11y.label === 'Site exposure — tides and soils', JSON.stringify({ role: a11y.role, label: a11y.label }));
  check('…adding no heading element, so the outline still steps by one',
    a11y.inMain && a11y.headingsInSection === 0 && a11y.skips.length === 0, JSON.stringify(a11y.skips));
  check('every control in it has a name', a11y.unnamed.length === 0, a11y.unnamed.join(' | '));
  check('every link out opens a new tab without handing it this window', a11y.linksOut);
  check('and no inline style anywhere in it', a11y.inline === 0, String(a11y.inline));

  // ── Queries: their shape, and how many at once ───────────────────────────
  check('every query is a point in 4326, intersecting',
    asked.every(r => r.inSR === '4326' && r.type === 'esriGeometryPoint' && r.rel === 'esriSpatialRelIntersects'),
    JSON.stringify(asked.find(r => !(r.inSR === '4326' && r.type === 'esriGeometryPoint'))));
  check('an "is it here" layer is a count; every other names its fields',
    asked.every(r => (COUNTED.has(r.layer) ? r.count && !r.outFields
                                          : !r.count && r.outFields && r.outFields !== '*')),
    JSON.stringify(asked.filter(r => COUNTED.has(r.layer) !== r.count).map(r => r.layer)));
  check('each distance is the one the module states, in metres',
    asked.every(r => (DISTANCE[r.layer] ?? null) === r.distance && (r.distance == null || r.units === 'esriSRUnit_Meter')),
    JSON.stringify(asked.filter(r => (DISTANCE[r.layer] ?? null) !== r.distance).map(r => [r.layer, r.distance])));
  check('point answers come back in 4326 when geometry is asked for',
    asked.filter(r => r.geometry === 'true').every(r => r.outSR === '4326' && ['limit', 'assSite'].includes(r.layer)));

  // ── Near the tide, the national atlas alone — by a real pin click ─────────
  log('\nNear the tide — a real pin click; the highest-tide line, the national atlas alone\n');
  // The same event Leaflet fires, on a pin with no other station within
  // ~500 m of it, at a zoom where it stands alone — stn-card.mjs's lonePin.
  const clicked = await page.evaluate((id) => {
    const s = state.data.stations.find(x => x.id === id);
    const near = (a, b) => Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
    const alone = !state.data.stations.some(y => y !== s && y.lat != null && y.lon != null && near(s, y));
    const m = state.mapMarkers.find(x => x.mnStationId === id);
    if (!m || !alone) return { alone, marker: !!m };
    state.map.setView(m.getLatLng(), 15, { animate: false });
    m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
    return { alone, marker: true, card: state.stnCard.id };
  }, 'palmview_al');
  check('a real pin click on a lone pin opens the card', clicked.alone && clicked.marker && clicked.card === 'palmview_al',
    JSON.stringify(clicked));
  await settle(page, 'palmview_al');
  const pal = await read(page, 'palmview_al');
  check('out of tidal water: the band the highest-tide line is within, and the one it is not',
    /^Within 1 km of the highest-tide line/.test(pal.rows['Tidal water'] || '') && /more than 100 m/.test(pal.rows['Tidal water']),
    pal.rows['Tidal water']);
  check('no Water Act limit within 20 km is said as that, not as a nearest one',
    /^None mapped within 20 km/.test(pal.rows['Tidal limit'] || ''), pal.rows['Tidal limit']);
  check('outside the coastal management district',
    pal.rows.Coast === 'Outside the coastal management district', pal.rows.Coast);
  check('storm tide not mapped here is not "no storm tide"',
    /^Not mapped here/.test(pal.rows['Storm tide'] || '') && /LiDAR/.test(pal.rows['Storm tide']), pal.rows['Storm tide']);
  check('a national atlas class stands alone, said to be inferred at 1:2M',
    (pal.rows['Acid sulfate'] || '').startsWith(NAT_B.probclass_def) && /national atlas, 1:2M/.test(pal.rows['Acid sulfate'])
      && /inferred, not checked on the ground/.test(pal.rows['Acid sulfate']) && !('National atlas' in pal.rows),
    pal.rows['Acid sulfate']);
  check('no sample site row where the soil is only "possible" and none is near',
    !('ASS sample' in pal.rows), pal.rows['ASS sample']);
  check('the summary: within 1 km of the highest tides, acid sulfate soils possible',
    pal.items.some(t => /^Within 1 km of where the highest tides reach/.test(t))
      && pal.items.some(t => /^Acid sulfate soils possible here/.test(t)), JSON.stringify(pal.items));
  check('out of the tide it asks the three tide-line bands as well',
    ['hat100', 'hat1k', 'hat10k'].every(l => layersFor('palmview_al').includes(l)), JSON.stringify(layersFor('palmview_al')));

  // ── Inland ────────────────────────────────────────────────────────────────
  log('\nInland — nothing coastal is asked\n');
  await page.evaluate(() => showStationCard('abbieglassie_al'));
  await settle(page, 'abbieglassie_al');
  const inl = await read(page, 'abbieglassie_al');
  check('no tide within 10 km', inl.rows['Tidal water'] === 'None within 10 km', inl.rows['Tidal water']);
  check('no soil mapping is "not mapped", and says that is not "absent"',
    /^Not mapped here/.test(inl.rows['Acid sulfate'] || '') && /not the same as absent/.test(inl.rows['Acid sulfate']),
    inl.rows['Acid sulfate']);
  check('and no coastal row at all', ['Tidal limit', 'Coast', 'Storm tide', 'ASS sample'].every(l => !(l in inl.rows)),
    JSON.stringify(Object.keys(inl.rows)));
  check('nine questions and none of the seven coastal ones',
    askedFor('abbieglassie_al').length === 9 && !askedFor('abbieglassie_al').some(r => COASTAL.includes(r.layer)),
    JSON.stringify(layersFor('abbieglassie_al')));
  check('the summary says no salt water from these maps — and that inland salinity is not in them',
    inl.items.some(t => /^No tidal water within 10 km/.test(t) && /Inland salinity/.test(t)), JSON.stringify(inl.items));

  // ── Queensland only ───────────────────────────────────────────────────────
  log('\nQueensland only — said in words, and nothing asked that need not be\n');
  await page.evaluate((id) => showStationCard(id), AWAY);
  await page.waitForFunction((id) => !!document.getElementById(`mn-exposure-card-${id}`), AWAY);
  const away = await read(page, AWAY);
  check('a station far outside Queensland says these datasets do not cover it',
    /^Site exposure — tides and soils Queensland Government mapping — indicative Not in Queensland\./.test(away.text)
      && /stop at the state border/.test(away.text) && /nothing is known about this site/.test(away.text), away.text);
  check('…with no row, no summary, and nothing it could be misread from',
    Object.keys(away.rows).length === 0 && away.items.length === 0 && !/None|Not mapped/.test(away.text),
    JSON.stringify(away.rows));
  check('…and asks nothing', askedFor(AWAY).length === 0, String(askedFor(AWAY).length));

  await page.evaluate(() => showStationCard('banora_sewerage_tre'));
  await settle(page, 'banora_sewerage_tre');
  const ban = await read(page, 'banora_sewerage_tre');
  check('a station across the border but inside the State’s box says so once it has asked',
    /Not in Queensland — or offshore/.test(ban.text) && Object.keys(ban.rows).length === 0 && ban.items.length === 0,
    ban.text);
  check('…having asked only whether it is in Queensland',
    JSON.stringify(layersFor('banora_sewerage_tre')) === JSON.stringify(['lga', 'lgaNear', 'tidalIn']),
    JSON.stringify(layersFor('banora_sewerage_tre')));

  await page.evaluate(() => showStationCard('coolangatta'));
  await settle(page, 'coolangatta');
  const cool = await read(page, 'coolangatta');
  check('a station on the shore, off every local government area but within 1 km of one, is answered with a caveat',
    /Just off Queensland’s mapped land/.test(cool.text) && /Within 1 km of the highest-tide line/.test(cool.rows['Tidal water'] || ''),
    cool.text.slice(0, 200));

  // ── Failure ───────────────────────────────────────────────────────────────
  log('\nA source that fails says so by name, and Try again asks again\n');
  await page.evaluate(() => showStationCard('moggill_al'));
  await settle(page, 'moggill_al');
  const mog = await read(page, 'moggill_al');
  check('the storm tide row says it could not be read, and names the map — never "not in an area"',
    /could not be read/.test(mog.rows['Storm tide'] || '') && /the storm tide hazard map/.test(mog.rows['Storm tide'])
      && !/Not in/.test(mog.rows['Storm tide']), mog.rows['Storm tide']);
  check('a finer soil map that failed leaves the coarser answer standing, saying the finer one could not be read',
    (mog.rows['Acid sulfate'] || '').includes(A1.map_code_meaning) && /1:50 000 map/.test(mog.rows['Acid sulfate'])
      && /the 1:25 000 map could not be read/.test(mog.rows['Acid sulfate']), mog.rows['Acid sulfate']);
  check('the line under the rows names each source that failed, and why',
    /the storm tide hazard map \(answered HTTP 500\)/.test(mog.fail)
      && /Queensland’s acid sulfate soil maps \(unreachable/.test(mog.fail)
      && /Nothing on this card is claimed from them/.test(mog.fail), mog.fail);
  check('…with a Try again button', mog.retry);
  check('actual acid sulfate soil reads as already making acid',
    mog.items.some(t => /^Actual acid sulfate soil is mapped here/.test(t)), JSON.stringify(mog.items));

  const beforeRepaint = askedFor('moggill_al').length;
  await page.evaluate(() => repaintStnCard());
  await page.waitForTimeout(300);
  check('a repaint does not re-ask a source that has just failed',
    askedFor('moggill_al').length === beforeRepaint, `${askedFor('moggill_al').length} vs ${beforeRepaint}`);

  flags.healed = true;
  const beforeRetry = askedFor('moggill_al').length;
  // Focused and pressed as a keyboard would; a missing button is a failed
  // check above, not a reason to stop the run.
  if (mog.retry) {
    await page.focus('#mn-exposure-card-moggill_al .stn-card-exp-retry', { timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await settle(page, 'moggill_al').catch(() => {});
  }
  await page.waitForFunction(() => /Site exposure: answered\./.test(document.getElementById('app-status').textContent),
    null, { timeout: 5000 }).catch(() => {});
  const healed = await read(page, 'moggill_al');
  const after = await page.evaluate(() => ({
    inCard: document.getElementById('stn-card').contains(document.activeElement),
    onBody: document.activeElement === document.body,
    status: document.getElementById('app-status').textContent,
  }));
  const again = askedFor('moggill_al').slice(beforeRetry).map(r => r.layer).sort();
  check('Try again, pressed from the keyboard, asks exactly the two that failed',
    JSON.stringify(again) === JSON.stringify(['ass25', 'stHigh']), JSON.stringify(again));
  check('…and their answers replace the failures',
    healed.rows['Storm tide'] === 'Not in a mapped storm tide area'
      && (healed.rows['Acid sulfate'] || '').includes(S1.map_code_meaning) && !healed.fail && !healed.retry,
    JSON.stringify({ storm: healed.rows['Storm tide'], ass: healed.rows['Acid sulfate'], fail: healed.fail }));
  check('…with focus kept in the card rather than dropped on <body>', after.inCard && !after.onBody);
  check('…and the outcome said once, politely', /Site exposure: answered\./.test(after.status), after.status);

  // ── Cost: the cache, and a card that moves on ─────────────────────────────
  log('\nWhat it costs\n');
  const before = asked.length;
  await page.evaluate(() => showStationCard('jindalee_al'));
  await settle(page, 'jindalee_al');
  await page.evaluate(() => repaintStnCard());
  await page.waitForTimeout(300);
  const jin2 = await read(page, 'jindalee_al');
  check('a second open of the same card, and a repaint of it, ask nothing',
    asked.length === before && jin2.rows['Tidal water'] === jin.rows['Tidal water'], `${asked.length - before} new request(s)`);

  // Opened, and moved off in the middle of its second stage (the stub holds
  // every answer 400 ms): eleven questions are due at once, four go out, seven
  // wait — and the seven are never sent for a card nobody is showing.
  const until = async (fn, ms = 10_000) => {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(15); }
    return true;
  };
  await page.evaluate(() => showStationCard('golden_beach_al'));
  const midway = await until(() => askedFor('golden_beach_al').length > 2);
  await page.evaluate((away) => showStationCard(away), AWAY);
  await page.waitForTimeout(1500);
  const dropped = askedFor('golden_beach_al').map(r => r.layer);
  const shown = await page.evaluate(() => ({
    gone: !document.getElementById('mn-exposure-card-golden_beach_al'),
    away: /Not in Queensland\./.test((document.getElementById('mn-exposure-card-awaba_stony_ck') || {}).textContent || ''),
  }));
  check('a card that moves on drops the old station’s queue — what was in flight lands, nothing queued is sent',
    midway && dropped.length === 2 + 4 && dropped.includes('lga') && dropped.includes('tidalIn'),
    JSON.stringify(dropped));
  check('…and the answers that did come back landed nowhere they do not belong', shown.gone && shown.away,
    JSON.stringify(shown));
  await page.evaluate(() => showStationCard('golden_beach_al'));
  await settle(page, 'golden_beach_al');
  const gold = askedFor('golden_beach_al').map(r => r.layer);
  check('coming back picks up where it stopped, asking nothing twice',
    gold.length === new Set(gold).size && gold.length === 13, JSON.stringify(gold.sort()));
  check('never more than four questions in flight at once', maxInFlight <= 4 && maxInFlight >= 2, String(maxInFlight));
  check('no scenario station asked a layer it should not have',
    !asked.some(r => r.unexpected), JSON.stringify(asked.filter(r => r.unexpected).map(r => [r.sid, r.layer])));

  // ── The phone ─────────────────────────────────────────────────────────────
  log('\nThe phone\n');
  const phone = await openStations({ viewport: { width: 375, height: 800 }, hasTouch: true });
  await phone.page.evaluate(() => showStationCard('jindalee_al'));
  await settle(phone.page, 'jindalee_al');
  const w = await phone.page.evaluate(() => {
    for (const d of document.querySelectorAll('#stn-card details')) d.open = true;
    return [document.documentElement.scrollWidth, document.documentElement.clientWidth];
  });
  check('at 375 px, every disclosure open, the page does not scroll sideways', w[0] <= w[1], JSON.stringify(w));
  await phone.context.close();

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
console.log('PASS — the site exposure section says what the State’s maps say, and nothing they did not.');
