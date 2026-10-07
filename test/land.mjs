// The land on the station card and the "What is here" card — the lot, its
// tenure, who holds that kind of land, the council area, the address, the
// rural property and the land use, asked of the Queensland cadastre
// (site-land.js).
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * It never says who owns freehold. Queensland does not publish owners, so
//     freehold reads as a private title with the owner not published and a
//     title search to name them; a public land use beside it is a hint said as
//     one. A reserve says "often the council" and names the council.
//   * A question nobody answered never reads as an answer: a cadastre that
//     fails is named, with why, and Try again asks it again; an address that
//     fails is not "none registered".
//   * Outside Queensland it says so in words — far outside asking nothing, and
//     inside the State's box (Banora, across the Tweed) asking only the parcel,
//     which comes back as the DCDB's "New South Wales" pseudo-parcel.
//   * A road reserve and a watercourse — the gauge on a bridge, the gauge in a
//     channel — are said as that, with the road manager or the Water Act, and
//     no address is asked for a parcel with no lot/plan.
//   * It costs what the header says: the parcel first, then three at most, the
//     address by the lot's own lot/plan, every query naming its fields, a
//     second open asking nothing, and the What is here card sharing the cache.
//   * It is sane to a keyboard and a screen reader: a named group, no heading,
//     every control named, links out in a new tab without this window, no
//     inline style, and no sideways scroll at 375 px.
//
// The services are external and this harness blocks outbound requests
// (lib/network.mjs), so the check answers them itself, in the shape the live
// services return (captured 7 October 2026), keyed by the station the point
// belongs to. Anything else on that host falls through to the policy's abort.
//
// Run:  npm run land
//       npm run land -- -v    also print what passed

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

// ── The services, answered ──────────────────────────────────────────────────

const LAYER = {
  'PlanningCadastre/LandParcelPropertyFramework/MapServer/4': 'parcel',
  'PlanningCadastre/LandParcelPropertyFramework/MapServer/0': 'addr',
  'PlanningCadastre/LandParcelPropertyFramework/MapServer/50': 'prop',
  'PlanningCadastre/LandUse/MapServer/0': 'use',
};

const FAIL_500 = { fail: 500 };
const FAIL_NET = { fail: 'net' };

// A parcel as the service gives it.
const P = (o) => ({
  lot: null, plan: null, lotplan: null, tenure: null, lot_area: 0, feat_name: null, alias_name: null,
  acc_code: 'B&D PLOT CONTROLLED - 0.25M', cover_typ: 'Base', parcel_typ: 'Lot Type Parcel',
  locality: 'Yangan', shire_name: 'Southern Downs Regional', ...o,
});
const lotP = (lot, plan, o) => P({ lot, plan, lotplan: `${lot}${plan}`, ...o });
const USE = (code, primary, secondary, tertiary, year = 2017) =>
  ({ year, alum_code: code, primary_: primary, secondary, tertiary });

const SCENARIO = {
  // Freehold, with an address, a rural property and a farming land use.
  yangan_al: {
    parcel: [lotP('192', 'ML2222', { tenure: 'Freehold', lot_area: 10620 }),
             // The service repeats a parcel now and then, and has strata lots
             // over the ground in town: neither is a second answer.
             lotP('192', 'ML2222', { tenure: 'Freehold', lot_area: 10620 }),
             lotP('3', 'SP9999', { tenure: 'Freehold', cover_typ: 'Strata' })],
    addr: ['44 Yangan Killarney Road Yangan QLD'],
    prop: [{ name: 'Wayland', feature_type: 'Rural Property' }],
    use: USE('3.3.0', 'Production from dryland agriculture and plantations', 'Cropping', 'Cropping', 2012),
  },
  // Freehold in public use: the hint, said as one. Three addresses, and on
  // the line with the road in front — the lot wins, being the one a title
  // search can be asked about, and the road is named beside it.
  palmview_al: {
    parcel: [P({ parcel_typ: 'Road Type Parcel', feat_name: 'Park Road', shire_name: 'Sunshine Coast Regional' }),
             lotP('900', 'SP123456', { tenure: 'Freehold', lot_area: 52000, shire_name: 'Sunshine Coast Regional',
                                        acc_code: 'UPGRADE ADJUSTMENT - 5M' })],
    addr: ['1 Park Road Palmview QLD', '3 Park Road Palmview QLD', '5 Park Road Palmview QLD'],
    prop: [],
    use: USE('5.5.3', 'Intensive uses', 'Services', 'Recreation and culture'),
  },
  // A reserve, named, in a council's area — the case that was asked about.
  abbieglassie_al: {
    parcel: [lotP('12', 'MH407', { tenure: 'Reserve', feat_name: 'Abbieglassie Recreation Reserve',
                                    lot_area: 81000, shire_name: 'Maranoa Regional' })],
    addr: [],
    prop: [],
    use: USE('5.5.3', 'Intensive uses', 'Services', 'Recreation and culture'),
  },
  // In the river channel: the watercourse and an easement over it. No
  // address is asked for a parcel with no lot/plan.
  jindalee_al: {
    parcel: [P({ parcel_typ: 'Watercourse', feat_name: 'Brisbane River', shire_name: 'Brisbane City' }),
             lotP('E', 'SP777', { cover_typ: 'Easement', shire_name: 'Brisbane City' })],
    prop: [],
    use: USE('6.3.0', 'Water', 'River', 'River'),
  },
  // New South Wales, inside Queensland's box: the DCDB's pseudo-parcel.
  banora_sewerage_tre: {
    parcel: [P({ parcel_typ: 'Transport Route', feat_name: 'New South Wales', shire_name: 'Queensland Extent',
                 acc_code: null })],
  },
  // The cadastre fails, then answers once `healed` is set and Try again is
  // pressed; the address then fails on its own.
  moggill_al: {
    parcel: FAIL_500,
    addr: FAIL_NET,
    prop: [],
    use: USE('5.4.2', 'Intensive uses', 'Residential and farm infrastructure', 'Urban residential'),
    healed: { parcel: [lotP('7', 'RP80000', { tenure: 'Freehold', shire_name: 'Brisbane City' })] },
  },
};
const AWAY = 'awaba_stony_ck';          // New South Wales, far outside the box
const ALL = [...Object.keys(SCENARIO), AWAY];
const FIELDS = { parcel: true, addr: true, prop: true, use: true };

function featureSet(fields, rows) {
  return {
    displayFieldName: fields[0],
    fieldAliases: Object.fromEntries(fields.map(f => [f, f])),
    fields: fields.map(f => ({ name: f, type: 'esriFieldTypeString', alias: f, length: 255 })),
    features: rows.map(attributes => ({ attributes })),
  };
}

function answer(sid, layer, fields, flags) {
  const sc = SCENARIO[sid] || {};
  let a = sc.healed && flags.healed && layer in sc.healed ? sc.healed[layer] : sc[layer];
  if (a === undefined) return { status: 200, body: { error: { code: 400, message: `unexpected: ${layer}` } }, unexpected: true };
  if (a && a.fail === 500) return { status: 500, body: 'Internal Server Error', text: true };
  if (a && a.fail === 'net') return { abort: true };
  const pick = o => Object.fromEntries(fields.map(f => [f, o[f] ?? null]));
  if (layer === 'addr') return { status: 200, body: featureSet(fields, a.map(address => pick({ address }))) };
  if (layer === 'use') return { status: 200, body: featureSet(fields, a ? [pick(a)] : []) };
  return { status: 200, body: featureSet(fields, a.map(pick)) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const asked = [];
const flags = { healed: false };
let inFlight = 0, maxInFlight = 0;

// The module rounds to five decimal places; a lot/plan query has no point and
// is matched by the lot/plan the scenario gave the station.
function stationAt(lon, lat) {
  const hit = ALL.map(station).find(s => Math.abs(Number(s.lat) - lat) < 6e-6 && Math.abs(Number(s.lon) - lon) < 6e-6);
  return hit ? hit.id : null;
}
function stationOfLot(where) {
  const m = /^lotplan='([A-Z0-9]+)'$/i.exec(where || '');
  if (!m) return null;
  const parcels = sc => [].concat(Array.isArray(sc.parcel) ? sc.parcel : [], (sc.healed && sc.healed.parcel) || []);
  return Object.keys(SCENARIO).find(sid => parcels(SCENARIO[sid]).some(p => p.lotplan === m[1])) || null;
}

async function stub(page) {
  await page.route(/spatial-gis\.information\.qld\.gov\.au\/arcgis\/rest\/services\//, async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/arcgis\/rest\/services\/(.+?\/MapServer\/\d+)\/query$/);
    const layer = m && LAYER[m[1]];
    const q = url.searchParams;
    const [lon, lat] = (q.get('geometry') || '').split(',').map(Number);
    const sid = !layer ? null : layer === 'addr' ? stationOfLot(q.get('where')) : stationAt(lon, lat);
    if (!layer || !sid) return route.fallback();
    const fields = (q.get('outFields') || '').split(',').filter(Boolean);
    const rec = { sid, layer, outFields: q.get('outFields'), where: q.get('where'), inSR: q.get('inSR'),
                  type: q.get('geometryType'), rel: q.get('spatialRel'), geometry: q.get('returnGeometry'),
                  count: q.get('resultRecordCount') };
    asked.push(rec);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep(40);
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

// The section, read, by its element id.
const read = (page, elId) => page.evaluate((elId) => {
  const el = document.getElementById(elId);
  if (!el) return null;
  const g = el.querySelector('.stn-card-land');
  const t = x => x.textContent.replace(/\s+/g, ' ').trim();
  const rows = {};
  for (const r of el.querySelectorAll('.acma-row')) rows[t(r.children[0])] = t(r.children[1]);
  const fail = el.querySelector('.txt-warn.stn-card-exp-foot');
  return {
    key: el.dataset.mnLand,
    text: g ? t(g) : t(el),
    rows,
    items: [...el.querySelectorAll('.stn-card-exp-sum li')].map(t),
    fail: fail ? t(fail) : '',
    retry: !!el.querySelector('.stn-card-exp-retry'),
    sources: [...el.querySelectorAll('.stn-card-exp-src li')].map(t),
    smart: (el.querySelector('.acma-row a[href*="SmartMap"]') || {}).href || '',
    busy: g ? g.hasAttribute('aria-busy') : false,
  };
}, elId);

const settle = (page, elId, timeout = 20_000) => page.waitForFunction((elId) => {
  const el = document.getElementById(elId);
  const g = el && el.querySelector('.stn-card-land');
  return !!g && !g.hasAttribute('aria-busy') && !/asking/.test(g.textContent);
}, elId, { timeout });

const card = id => `mn-land-card-${id}`;
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

  // ── The What is here card, first, so the station card can reuse it ────────
  log('\nWhat is here — the same section, about a point\n');
  const Y = station('yangan_al');
  await page.evaluate(([lat, lon]) => { MapHere.arm(true); MapHere.pick(lat, lon); }, [Number(Y.lat), Number(Y.lon)]);
  await settle(page, 'mn-land-here');
  const here = await read(page, 'mn-land-here');
  check('the What is here card carries the land section, keyed by the position to five places',
    !!here && here.key === `${Number(Y.lat).toFixed(5)},${Number(Y.lon).toFixed(5)}`, JSON.stringify(here && here.key));
  check('…between the ground’s facts and the nearest stations',
    await page.evaluate(() => {
      const kids = [...document.getElementById('here-card').children];
      const i = kids.findIndex(e => e.id === 'mn-land-here');
      return i > 0 && /Ground height/.test(kids[i - 1].textContent) && /Nearest station/.test(kids[i + 1].textContent);
    }));
  check('the lot on its plan, with the State’s free SmartMap of it',
    /^Lot 192 on ML2222 SmartMap/.test(here.rows['Lot on plan'] || '')
      && here.smart === 'https://apps.information.qld.gov.au/data/v2/Cadastre/SmartMap?lot=192&plan=ML2222',
    JSON.stringify([here.rows['Lot on plan'], here.smart]));
  check('freehold, the owner said to be unpublished — never guessed',
    here.rows.Tenure === 'Freehold' && here.rows['Held by'] === 'Private title — owner not published', JSON.stringify(here.rows));
  check('the council whose area it is in, named as a council',
    here.rows.Council === 'Southern Downs Regional Council', here.rows.Council);
  check('the street address, the rural property, the area and the land use with its year',
    here.rows.Address === '44 Yangan Killarney Road Yangan QLD' && here.rows.Property === 'Wayland'
      && here.rows['Lot area'] === '1.06 ha' && here.rows['Land use'] === 'Cropping mapped 2012', JSON.stringify(here.rows));
  check('the strata lot over it and the repeated parcel are not second answers',
    !('On the line with' in here.rows) && !('Easement' in here.rows), JSON.stringify(Object.keys(here.rows)));
  check('the summary says a title search names a freehold owner, and links to one',
    here.items.some(t => /^Freehold: owned outright by whoever is on the title/.test(t) && /title search/.test(t))
      && here.items.some(t => /Title searches — Titles Queensland/.test(t)), JSON.stringify(here.items));
  check('…with no public-land hint for a farm', !here.items.some(t => /often public land/.test(t)));
  check('the parcel first, then the other three — four questions',
    JSON.stringify(layersFor('yangan_al')) === JSON.stringify(['addr', 'parcel', 'prop', 'use']), JSON.stringify(layersFor('yangan_al')));
  const addrQ = askedFor('yangan_al').find(r => r.layer === 'addr');
  check('the address asked by the lot’s own lot/plan, not by a point',
    !!addrQ && addrQ.where === "lotplan='192ML2222'" && !addrQ.type, JSON.stringify(addrQ));

  const beforeCard = asked.length;
  await page.evaluate(() => showStationCard('yangan_al'));
  await settle(page, card('yangan_al'));
  const yan = await read(page, card('yangan_al'));
  check('opening the station card closes the What is here card',
    await page.evaluate(() => document.getElementById('here-card').hidden));
  check('the station card’s section answers the same, from the same cache — nothing asked',
    asked.length === beforeCard && JSON.stringify(yan.rows) === JSON.stringify(here.rows), `${asked.length - beforeCard} new`);
  check('…placed right after the card’s first section, beside the station’s Owner row',
    await page.evaluate(() => {
      const kids = [...document.getElementById('stn-card').children];
      const i = kids.findIndex(e => e.id && e.id.startsWith('mn-land-card-'));
      return i > 0 && kids[i - 1].matches('.acma-card-head + .acma-sect');
    }));
  check('the sources name each dataset asked, its custodian and its licence',
    yan.sources.some(t => /Cadastral data — Queensland series/.test(t) && /CC BY 4\.0/.test(t))
      && yan.sources.some(t => /Property Address locations/.test(t))
      && yan.sources.some(t => /Rural properties/.test(t))
      && yan.sources.some(t => /Land Use Mapping/.test(t)), JSON.stringify(yan.sources));

  // ── The outline, the names, the rules the tabs check holds ───────────────
  const a11y = await page.evaluate(() => {
    const el = document.getElementById('mn-land-card-yangan_al');
    const g = el.querySelector('.stn-card-land');
    const label = document.getElementById(g.getAttribute('aria-labelledby') || '');
    const name = c => (c.getAttribute('aria-label') || c.textContent || c.getAttribute('title') || '').trim();
    const controls = [...el.querySelectorAll('a[href], button, summary, [tabindex]:not([tabindex="-1"])')];
    return {
      role: g.getAttribute('role'), label: label ? label.textContent.trim() : null,
      headings: el.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
      unnamed: controls.filter(c => !name(c)).map(c => c.outerHTML.slice(0, 60)),
      linksOut: [...el.querySelectorAll('a[href]')].every(a => a.target === '_blank' && /\bnoopener\b/.test(a.rel)
        && /new tab/.test(a.getAttribute('aria-label') || '')),
      inline: el.querySelectorAll('[style]').length,
    };
  });
  check('the section is a group named by its heading, with no heading element',
    a11y.role === 'group' && a11y.label === 'Land — tenure and council' && a11y.headings === 0, JSON.stringify(a11y));
  check('every control in it has a name', a11y.unnamed.length === 0, a11y.unnamed.join(' | '));
  check('every link out opens a new tab, says so, and does not hand it this window', a11y.linksOut);
  check('and no inline style anywhere in it', a11y.inline === 0, String(a11y.inline));

  // ── Freehold in public use ────────────────────────────────────────────────
  log('\nFreehold in public use — a hint, said as one\n');
  await page.evaluate(() => showStationCard('palmview_al'));
  await settle(page, card('palmview_al'));
  const pal = await read(page, card('palmview_al'));
  check('a public land use beside freehold is a hint at a public owner, never a finding',
    pal.items.some(t => /^Mapped as services › recreation and culture, which is often public land/.test(t)
      && /only the title says/.test(t)), JSON.stringify(pal.items));
  check('a coarsely plotted lot says how coarsely', /plotted to ±5 m/.test(pal.rows['Lot on plan'] || ''),
    pal.rows['Lot on plan']);
  check('more than one address: the first, and how many more', pal.rows.Address === '1 Park Road Palmview QLD and 2 more',
    pal.rows.Address);
  check('no rural property row where the map names none', !('Property' in pal.rows), JSON.stringify(Object.keys(pal.rows)));
  check('on the line with a road, the lot wins and the road is named beside it',
    /^Lot 900 on SP123456/.test(pal.rows['Lot on plan'] || '') && pal.rows['On the line with'] === 'Park Road (road reserve)',
    JSON.stringify([pal.rows['Lot on plan'], pal.rows['On the line with']]));

  // ── A reserve ─────────────────────────────────────────────────────────────
  log('\nA reserve — the council, most often\n');
  await page.evaluate(() => showStationCard('abbieglassie_al'));
  await settle(page, card('abbieglassie_al'));
  const res = await read(page, card('abbieglassie_al'));
  check('a reserve, with its name', res.rows.Tenure === 'Reserve — Abbieglassie Recreation Reserve', res.rows.Tenure);
  check('…held by the State through a trustee, often the council',
    res.rows['Held by'] === 'The State, through a trustee — often the council', res.rows['Held by']);
  check('…and the summary names the council as the likely trustee, and where the trustee is recorded',
    res.items.some(t => /most often the local council \(Maranoa Regional Council\)/.test(t) && /trustee and the purpose/.test(t)),
    JSON.stringify(res.items));
  check('…with the State’s page on reserves', res.items.some(t => /Reserves on State land/.test(t)), JSON.stringify(res.items));
  check('no address registered is said as that', res.rows.Address === 'none registered for this lot', res.rows.Address);
  check('…and no public-land hint, which is for freehold only', !res.items.some(t => /often public land/.test(t)));

  // ── In the river ──────────────────────────────────────────────────────────
  log('\nIn the river — the watercourse and the easement\n');
  await page.evaluate(() => showStationCard('jindalee_al'));
  await settle(page, card('jindalee_al'));
  const riv = await read(page, card('jindalee_al'));
  check('a watercourse is said as a watercourse, held by the State',
    riv.rows.Tenure === 'Watercourse — Brisbane River' && riv.rows['Held by'] === 'The State — bed and banks', JSON.stringify(riv.rows));
  check('…with the Water Act and the riverine protection permit in the summary',
    riv.items.some(t => /Water Act 2000/.test(t) && /riverine protection permit/.test(t)), JSON.stringify(riv.items));
  check('the easement over the point is named, and what holding one means',
    riv.rows.Easement === 'Easement E on SP777' && riv.items.some(t => /^An easement crosses this point/.test(t)),
    JSON.stringify([riv.rows.Easement, riv.items]));
  check('no lot/plan, no address asked and no address row',
    !layersFor('jindalee_al').includes('addr') && !('Address' in riv.rows) && !('Lot on plan' in riv.rows),
    JSON.stringify(layersFor('jindalee_al')));

  // ── Queensland only ───────────────────────────────────────────────────────
  log('\nQueensland only\n');
  await page.evaluate((id) => showStationCard(id), AWAY);
  await page.waitForFunction((id) => !!document.getElementById(`mn-land-card-${id}`), AWAY);
  const away = await read(page, card(AWAY));
  check('a station far outside Queensland says the cadastre does not cover it, and asks nothing',
    /Not in Queensland\./.test(away.text) && Object.keys(away.rows).length === 0 && askedFor(AWAY).length === 0,
    away.text);
  await page.evaluate(() => showStationCard('banora_sewerage_tre'));
  await settle(page, card('banora_sewerage_tre'));
  const ban = await read(page, card('banora_sewerage_tre'));
  check('the DCDB’s New South Wales pseudo-parcel is read as not Queensland, never as a lot',
    /Not on Queensland’s land — New South Wales/.test(ban.text) && Object.keys(ban.rows).length === 0, ban.text);
  check('…having asked only the parcel', JSON.stringify(layersFor('banora_sewerage_tre')) === JSON.stringify(['parcel']),
    JSON.stringify(layersFor('banora_sewerage_tre')));

  // ── Failure ───────────────────────────────────────────────────────────────
  log('\nA source that fails says so by name, and Try again asks again\n');
  await page.evaluate(() => showStationCard('moggill_al'));
  await settle(page, card('moggill_al'));
  const mog = await read(page, card('moggill_al'));
  check('a cadastre that failed is named, with why, and nothing is claimed from it',
    /Could not be read: the Queensland cadastre \(answered HTTP 500\)/.test(mog.fail)
      && Object.keys(mog.rows).length === 0 && mog.retry, JSON.stringify(mog));
  check('…and nothing else is asked until it answers', JSON.stringify(layersFor('moggill_al')) === JSON.stringify(['parcel']),
    JSON.stringify(layersFor('moggill_al')));
  const beforeRepaint = askedFor('moggill_al').length;
  await page.evaluate(() => repaintStnCard());
  await page.waitForTimeout(300);
  check('a repaint does not re-ask a source that has just failed', askedFor('moggill_al').length === beforeRepaint);

  flags.healed = true;
  if (mog.retry) {
    await page.focus(`#${card('moggill_al')} .stn-card-exp-retry`, { timeout: 5000 }).catch(() => {});
    await page.keyboard.press('Enter');
    await settle(page, card('moggill_al')).catch(() => {});
  }
  await page.waitForFunction(() => /Land: 1 source still could not be read\./.test(document.getElementById('app-status').textContent),
    null, { timeout: 5000 }).catch(() => {});
  const healed = await read(page, card('moggill_al'));
  const after = await page.evaluate(() => ({
    inCard: document.getElementById('stn-card').contains(document.activeElement),
    status: document.getElementById('app-status').textContent,
  }));
  check('Try again, pressed from the keyboard, gets the lot — and then asks the rest',
    healed.rows['Lot on plan'] && /^Lot 7 on RP80000/.test(healed.rows['Lot on plan'])
      && JSON.stringify(layersFor('moggill_al')) === JSON.stringify(['addr', 'parcel', 'parcel', 'prop', 'use']),
    JSON.stringify([healed.rows, layersFor('moggill_al')]));
  check('an address that failed reads as could not be read — never as none registered',
    /^could not be read — the property address register/.test(healed.rows.Address || '')
      && /the property address register \(unreachable/.test(healed.fail), JSON.stringify([healed.rows.Address, healed.fail]));
  check('…with focus kept in the card, and the outcome said', after.inCard
    && /Land: 1 source still could not be read\./.test(after.status), JSON.stringify(after));

  // ── Cost ──────────────────────────────────────────────────────────────────
  log('\nWhat it costs\n');
  const before = asked.length;
  await page.evaluate(() => showStationCard('palmview_al'));
  await settle(page, card('palmview_al'));
  await page.evaluate(() => repaintStnCard());
  await page.waitForTimeout(300);
  check('a second open of the same card, and a repaint of it, ask nothing', asked.length === before,
    `${asked.length - before} new request(s)`);
  check('every point query is a point in 4326, intersecting, with no geometry back',
    asked.filter(r => r.layer !== 'addr').every(r => r.inSR === '4326' && r.type === 'esriGeometryPoint'
      && r.rel === 'esriSpatialRelIntersects' && r.geometry === 'false'));
  check('every query names its fields', asked.every(r => r.outFields && r.outFields !== '*' && FIELDS[r.layer]));
  check('the address query is capped', asked.filter(r => r.layer === 'addr').every(r => Number(r.count) > 0 && Number(r.count) <= 10));
  check('never more than three questions in flight at once', maxInFlight <= 3 && maxInFlight >= 2, String(maxInFlight));
  check('no scenario station asked a layer it should not have',
    !asked.some(r => r.unexpected), JSON.stringify(asked.filter(r => r.unexpected).map(r => [r.sid, r.layer])));

  // ── The phone ─────────────────────────────────────────────────────────────
  log('\nThe phone\n');
  const phone = await openStations({ viewport: { width: 375, height: 800 }, hasTouch: true });
  await phone.page.evaluate(() => showStationCard('jindalee_al'));
  await settle(phone.page, card('jindalee_al'));
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
console.log('PASS — the land section says what the cadastre says, and never who owns freehold.');
