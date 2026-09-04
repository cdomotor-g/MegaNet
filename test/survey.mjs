// Survey marks on the Stations map: fetched, drawn, honestly counted, and
// reachable through the map's own events (#120, and the invisible-marks bug),
// with each mark's callout carrying a link to its own report and the details a
// crew reads before driving out to it (#174).
//
// The QLD SurveyControl service is external and this harness blocks outbound
// requests, so the check stubs it — and the stub deliberately reproduces the
// live service's own behaviour rather than an idealised one, because the bug
// this test pins lived exactly in that gap:
//
//   * /layers answers with the real sublayer list — feature layers AND the
//     two Group Layers whose names pass the mark regex but whose /query can
//     only answer a 400 error body.
//   * any /query carrying `resultRecordCount` gets `{features: []}` back —
//     HTTP 200, no error field. That is what the live ArcGIS 11.5 joined
//     layers do, and it is why sending a per-layer cap made every mark
//     invisible while the note kept counting.
//   * attributes come back join-prefixed ('sirpub.prop.…scdb.mrk_id'), the
//     way the live rows actually arrive, so the field matching is tested
//     against reality and not against the names the first cut guessed.
//   * /layers carries the real field list on each sublayer, which is where the
//     app picks the names it asks for, and every /query answers with exactly
//     the fields it asked for and honours a `where` naming one mark. Both
//     matter to #174: the viewport query has to stay lean while the callout's
//     own lookup gets everything, and that is only a real claim if the stub
//     can tell the two apart.
//
// One CORS site sits inside the rounded fetch bbox but outside the viewport:
// the note used to count it as "in view", which is the honesty half of the
// bug ("1 mark in view", zero marks visible).
//
// The last section loads the page again with /layers unreachable, which is the
// fallback service's path: its rows arrive complete because it is asked with
// '*', so no callout there looks anything up — and it publishes no report link
// at all, so the link on its callouts is the one derived from the mark number.
//
// Run:  npm run survey
//       npm run survey -- -v    also print what passed

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

const CENTER = { lat: -20.0, lon: 147.0 };
const PFX = 'sirpub.prop.qld_surveycontrol_scdb.';
// The report link lives on a *different* joined table from everything else,
// and its prefix differs by more than a suffix — which is exactly why the app
// matches on the key's last segment rather than on a prefix it assembled.
const RPT = 'sirpub.prop.qld_surveycontrol_rpt_link.report_url';

// The field names the live sublayers publish, verbatim, trimmed to the ones
// this app can match plus 'ahdadj_dt' — the trap field, which must end up in
// neither the viewport query nor the callout's lookup.
const FIELD_NAMES = [
  PFX + 'mrk_id', RPT, PFX + 'alt1_nm', PFX + 'town_nm', PFX + 'locality_de',
  PFX + 'relinfo_de', PFX + 'mrktype_de', PFX + 'mrkcnd_de', PFX + 'lastvisit_dt',
  PFX + 'form6_fg', PFX + 'ahdheight', PFX + 'ahdcls_de', PFX + 'ahdacc_de',
  PFX + 'ahdadj_dt',
];
const FIELDS = FIELD_NAMES.map((name) => ({ name, type: 'esriFieldTypeString' }));
// What the viewport query is expected to ask for, and what one mark's own
// lookup is expected to ask for. Written out here rather than derived, so a
// field quietly joining the per-viewport request fails this file. The lookup
// is compared as a set — the order the app happens to send them in is the
// service's own metadata order and nothing depends on it.
const LEAN_FIELDS = [PFX + 'mrk_id', PFX + 'ahdheight'].join(',');
const FULL_FIELDS = FIELD_NAMES.filter((n) => n !== PFX + 'ahdadj_dt').slice().sort().join(',');
const asSet = (v) => String(v || '').split(',').sort().join(',');

// The live service's own /layers listing, ids and types verbatim. The group
// layers and the excluded-by-name layers are the point: resolveLayers() has
// to leave every one of them unqueried.
const LIVE_LAYERS = { layers: [
  { id: 0,  name: 'CORS sites',               type: 'Feature Layer', fields: FIELDS },
  { id: 1,  name: 'Survey control marks',     type: 'Group Layer' },
  { id: 2,  name: 'GDA coordinates',          type: 'Group Layer' },
  { id: 3,  name: 'GDA datum',                type: 'Feature Layer', fields: FIELDS },
  { id: 4,  name: 'GDA derived',              type: 'Feature Layer', fields: FIELDS },
  { id: 16, name: 'GDA scaled',               type: 'Feature Layer', fields: FIELDS },
  { id: 7,  name: 'AHD heights',              type: 'Group Layer' },
  { id: 17, name: 'AHD Datum',                type: 'Feature Layer', fields: FIELDS },
  { id: 9,  name: 'AHD Derived by Levelling', type: 'Feature Layer', fields: FIELDS },
  { id: 18, name: 'AHD Derived by Other',     type: 'Feature Layer', fields: FIELDS },
  { id: 12, name: 'Cadastral connection',     type: 'Feature Layer', fields: FIELDS },
  { id: 13, name: 'Destroyed',                type: 'Feature Layer', fields: FIELDS },
]};

// A live remarks string, shape and length included: this is what the callout
// has to collapse and cut, and what its `title` has to keep whole.
const NOTES_10552 = 'Category 2 for GPS. DNR visit 14/01/1998 Obstructions Overhanging shrub'
  + '  NRM visit 30/04/2001 PM & Lid good cond New Lid placed @ NR&M visit 05/02/03'
  + ' PM suited to GNSS vide maintenance form.';

// Live-shaped rows, carrying every field the service would. Mark B carries the
// trap the AHD pattern exists for: no height, but an epoch-milliseconds
// adjustment date in 'ahdadj_dt' that a loose /ahd/ numeric pick would print
// as "995846400000 m AHD".
function feature(lat, lon, attrs) {
  return { attributes: attrs, geometry: { x: lon, y: lat } };
}
const FIXTURE = {
  3: [
    // Everything present: this is the callout with all of it filled in.
    // 1698969600000 is the "Last Visited 03-Nov-2023" a real report prints —
    // UTC midnight of the day, so a local-time read would say 2 Nov.
    feature(-20.0, 147.0, {
      [PFX + 'mrk_id']: '10552',
      [RPT]: 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010552.pdf',
      [PFX + 'alt1_nm']: 'BCC12419 BCC 66/103',
      [PFX + 'town_nm']: 'AYR',
      [PFX + 'locality_de']: 'QUEEN ST/EIGHTH AVE-HOME HILL',
      [PFX + 'relinfo_de']: NOTES_10552,
      [PFX + 'mrktype_de']: 'STAND',
      [PFX + 'mrkcnd_de']: 'GOOD',
      [PFX + 'lastvisit_dt']: 1698969600000,
      [PFX + 'form6_fg']: 'Y',
      [PFX + 'ahdheight']: 52.38,
      [PFX + 'ahdcls_de']: 'Class C',
      [PFX + 'ahdacc_de']: '3rd ORDER',
      [PFX + 'ahdadj_dt']: 995846400000,
    }),
    // No height, and a mark nobody has found since 1998 — the two facts a
    // crew most needs before driving out to it.
    feature(-19.995, 147.01, {
      [PFX + 'mrk_id']: '10553',
      [RPT]: 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010553.pdf',
      [PFX + 'locality_de']: 'INKERMAN RD-JARVISFIELD',
      [PFX + 'mrktype_de']: 'R/INF',
      [PFX + 'mrkcnd_de']: 'NOT FOUND',
      [PFX + 'lastvisit_dt']: 886723200000,
      [PFX + 'form6_fg']: 'N',
      [PFX + 'ahdheight']: null,
      [PFX + 'ahdadj_dt']: 995846400000,
    }),
  ],
  4: [
    // The mark whose lookup the stub refuses (see the route below): its
    // callout must still open, still link to its report, and say plainly that
    // the rest is missing.
    feature(-20.005, 146.99, { [PFX + 'mrk_id']: '10554', [PFX + 'ahdheight']: 12.5 }),
  ],
  16: [
    // A mark number and nothing else — the callout prints what is there and
    // invents nothing.
    feature(-20.01, 147.02, { [PFX + 'mrk_id']: '10555' }),
  ],
  0: [
    // One CORS site in view, no usable name field — the generic label path.
    feature(-19.99, 146.98, {}),
    // And one in the rounded bbox margin just past the viewport's east edge
    // (the viewport at zoom 13 is ~0.24° wide; the bbox rounds out to 0.05°).
    // Drawn, yes — a small pan should reveal it without a refetch — but it
    // must NOT be counted "in view".
    feature(-20.0, 147.13, {}),
  ],
};

// The service answers with the fields it was asked for and nothing else. That
// is the whole point of the split #174 makes, so the stub has to do it too:
// asked leanly it must NOT hand back the detail fields, or the callout would
// appear to work while the viewport query quietly paid for it.
function project(f, outFields, withGeometry) {
  const attributes = {};
  if (!outFields || outFields === '*') Object.assign(attributes, f.attributes);
  else {
    const keep = new Set(outFields.split(','));
    for (const [k, v] of Object.entries(f.attributes)) if (keep.has(k)) attributes[k] = v;
  }
  return withGeometry ? { attributes, geometry: f.geometry } : { attributes };
}

// `where` is either the viewport's '1=1' or one mark, named by the very field
// the app read out of /layers.
function whereFilter(rows, where) {
  const m = /^(\S+)='(\d+)'$/.exec(where || '');
  return m ? rows.filter((f) => String(f.attributes[m[1]]) === m[2]) : rows;
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
// The Queensland spatial host serves more than one of this app's layers, so a
// route has to name the service as well: SurveyControl is what MapSurvey asks,
// FoundationData is what it falls back to, and nothing else on that host is
// this file's business.
const QLD_SURVEY_ROUTE =
  /spatial-gis\.information\.qld\.gov\.au\/.*(SurveyControl|FoundationData)\//;

const queried = [];   // every /query MapSurvey sent: { id, hasRC, outFields, where }
const bbox = () => queried.filter((q) => q.where === '1=1');
const lookups = () => queried.filter((q) => q.where !== '1=1');
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, hasTouch: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  // Registered after the policy, so it runs first (Playwright: newest route
  // first) and the stub answers before the off-origin abort can.
  // MapSurvey's two services by name, not the whole host. The host-wide glob
  // this used to carry meant "every query the app sent", which was the same
  // thing only while MapSurvey was the one layer using it — MapRoads reads the
  // cadastre on the same host now, and is on by default, so a host-wide stub
  // would answer its queries too and put them in `queried` below. Its requests
  // fall through to the network policy and are aborted, which is what the rest
  // of this file already assumes about everything off-origin.
  await page.route(QLD_SURVEY_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/layers')) {
      body = LIVE_LAYERS;
    } else {
      const m = url.pathname.match(/MapServer\/(\d+)\/query$/);
      const id = m ? Number(m[1]) : 'other';
      const hasRC = url.searchParams.has('resultRecordCount');
      const outFields = url.searchParams.get('outFields');
      const where = url.searchParams.get('where');
      queried.push({ id, hasRC, outFields, where });
      const rows = whereFilter(FIXTURE[id] || [], where);
      if (id === 1 || id === 2 || id === 7) {
        // What the live group layers actually say when queried.
        body = { error: { code: 400, message: 'Invalid or missing input parameters.', details: [] } };
      } else if (hasRC) {
        // The live quirk this whole file exists for: a per-layer cap is
        // answered with an empty feature set and no error at all.
        body = { features: [] };
      } else if (where && where.includes("'10554'")) {
        // One mark's lookup refused, the way ArcGIS refuses — HTTP 200 with an
        // error body. Its callout still has a job to do.
        body = { error: { code: 500, message: 'Unable to complete operation.', details: [] } };
      } else {
        const withGeometry = url.searchParams.get('returnGeometry') !== 'false';
        body = { features: rows.map((f) => project(f, outFields, withGeometry)) };
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // The view the fixture is built around, above MIN_ZOOM, then the switch on.
  await page.evaluate((c) => {
    state.map.setView([c.lat, c.lon], 13, { animate: false });
    MapSurvey.setEnabled(true);
  }, CENTER);
  await page.waitForFunction(() => /marks? in view/.test(document.getElementById('map-survey-note').textContent),
    null, { timeout: 15_000 });

  // ── The fix itself: the queries, and what they no longer carry ────────────
  check('no query carries resultRecordCount — the parameter the live service answers with nothing',
    queried.length > 0 && queried.every((q) => !q.hasRC), JSON.stringify(queried));
  const ids = [...new Set(queried.map((q) => q.id))].sort((a, b) => a - b);
  check('exactly the feature layers are queried — no group layers, no destroyed, no cadastral',
    ids.join(',') === '0,3,4,16', `queried ids: ${ids.join(',')}`);

  // ── The viewport query stays lean (#174) ──────────────────────────────────
  // The callout's fields are worth ~150 kB per sublayer per view on the live
  // service, to show data for the one mark somebody clicks. So the per-view
  // request must ask for the same two fields it always did, and nothing here
  // may quietly widen it.
  check('the viewport query still asks for two fields — the callout\u2019s are not in it',
    bbox().length > 0 && bbox().every((q) => q.outFields === LEAN_FIELDS),
    JSON.stringify([...new Set(bbox().map((q) => q.outFields))]));
  check('nothing is looked up before a mark is clicked', lookups().length === 0,
    JSON.stringify(lookups()));

  // ── Marks render, and the note tells the truth ────────────────────────────
  const drawn = await page.evaluate(() => {
    const icons = [...document.querySelectorAll('.mn-survey-div')];
    const rect = document.getElementById('leaflet-map').getBoundingClientRect();
    const inView = icons.filter((el) => {
      const b = el.getBoundingClientRect();
      return b.right > rect.left && b.left < rect.right && b.bottom > rect.top && b.top < rect.bottom;
    });
    return {
      total: icons.length,
      inView: inView.length,
      cors: document.querySelectorAll('.mn-survey-cors').length,
      interactive: document.querySelectorAll('.leaflet-mnSurvey-pane .leaflet-interactive').length,
      note: document.getElementById('map-survey-note').textContent.trim(),
    };
  });
  check('all six fixture points draw — four marks and two CORS sites', drawn.total === 6 && drawn.cors === 2,
    JSON.stringify(drawn));
  check('five of them are inside the viewport — the sixth sits in the bbox margin',
    drawn.inView === 5, `${drawn.inView} in viewport`);
  check('the note counts only what the viewport shows', /\b5\b\s*marks in view/.test(drawn.note), drawn.note);
  check('no marker claims the pointer — interaction is map-delegated', drawn.interactive === 0,
    `${drawn.interactive} interactive`);

  // ── A real hover names the mark by its register id ────────────────────────
  // Real mouse input, for the same reason rivers uses it: every real event
  // lands on the shared pins-and-links canvas above this pane and reaches the
  // marks only through the map-level hit test.
  const target = await page.evaluate(() => {
    const pt = state.map.latLngToContainerPoint([-20.0, 147.0]);
    const rect = state.map.getContainer().getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  });
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(250);
  const hover = await page.evaluate(() => ({
    tips: [...document.querySelectorAll('.leaflet-tooltip.mn-survey-label')].map((el) => el.textContent.trim()),
    cursor: state.map.getContainer().style.cursor,
  }));
  check('a real mouse over a mark shows its register id and a pointer cursor',
    hover.tips.includes('10552') && hover.cursor === 'pointer', JSON.stringify(hover));

  await page.mouse.move(target.x, target.y - 120);
  await page.waitForTimeout(250);
  const hoverGone = await page.evaluate(() => ({
    tips: [...document.querySelectorAll('.leaflet-tooltip.mn-survey-label')].length,
    cursor: state.map.getContainer().style.cursor,
  }));
  check('off the mark, the hover name goes and the cursor returns',
    hoverGone.tips === 0 && hoverGone.cursor === '', JSON.stringify(hoverGone));

  // ── The callout, driven at the map-event level ────────────────────────────
  // The exact event Leaflet fires for a real click or tap; this sandbox's
  // Chromium reports native touch, under which Leaflet 1.9.4 never turns a
  // synthetic mouse click into a map click (test/rivers.mjs records the
  // probe). Every map-click behaviour in this suite is driven the same way.
  await page.evaluate(() => {
    window.__surveyClick = (latlng, dyPx = 0) => {
      const at = state.map.layerPointToLatLng(
        state.map.latLngToLayerPoint(latlng).add([0, dyPx]));
      state.map.fire('click', {
        latlng: at,
        layerPoint: state.map.latLngToLayerPoint(at),
        containerPoint: state.map.latLngToContainerPoint(at),
        originalEvent: new MouseEvent('click'),
      });
      const el = document.querySelector('.leaflet-popup-content');
      return el ? el.textContent : null;
    };
    // The callout fills itself in after its lookup lands, so every read of it
    // is two reads: what it opened with, and what it settled on.
    const el = () => document.querySelector('.leaflet-popup-content');
    window.__popupText  = () => (el() ? el().textContent : null);
    window.__popupPills = () => [...document.querySelectorAll('.leaflet-popup-content a.pill')]
      .map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() }));
    // The full remarks string, which rides on the truncated line's title.
    window.__popupNoteTitle = () => {
      const n = document.querySelector('.leaflet-popup-content .mn-pop-line span[title]');
      return n ? n.getAttribute('title') : null;
    };
  });
  const settle = () => page.waitForFunction(
    () => !/Looking up mark details/.test(window.__popupText() || ''), null, { timeout: 10_000 });

  // 5 px off the mark: inside HIT_PX, outside the 10 px icon.
  const popA = await page.evaluate(() => window.__surveyClick([-20.0, 147.0], 5));
  check('a click near a mark opens its callout with the real AHD height',
    !!popA && popA.includes('10552') && popA.includes('Survey control mark') && popA.includes('52.38 m AHD'),
    String(popA));

  // ── The report link, and the details behind it (#174) ─────────────────────
  // The callout is useful before its lookup answers: the heading, the
  // coordinates, the height and — the thing this issue is about — the link to
  // the mark's own report are all built from what drawing the mark knew.
  const openedWith = await page.evaluate(() => ({ text: window.__popupText(), pills: window.__popupPills() }));
  check('the callout opens naming the mark, already carrying its report link, and says the rest is coming',
    openedWith.text.includes('Mark 10552')
      && openedWith.pills.some((a) => a.href === 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010552.pdf')
      && /Looking up mark details/.test(openedWith.text),
    JSON.stringify(openedWith));

  await settle();
  const full = await page.evaluate(() => ({
    text: window.__popupText(), pills: window.__popupPills(), note: window.__popupNoteTitle(),
  }));
  check('the lookup fills in what the mark physically is and where it is',
    full.text.includes('Survey control mark · STAND')
      && full.text.includes('QUEEN ST/EIGHTH AVE-HOME HILL')
      && full.text.includes('Also BCC12419 BCC 66/103'),
    JSON.stringify(full.text));
  check('the AHD height carries its class and order — the levelling check\u2019s whole question',
    full.text.includes('52.38 m AHD · Class C / 3rd ORDER'), String(full.text));
  // 1698969600000 is UTC midnight of the day the report prints as "Last
  // Visited 03-Nov-2023"; read in local time west of Greenwich it is 2 Nov.
  check('condition and last visit read back as the report prints them',
    full.text.includes('GOOD · last visited 3 Nov 2023'), String(full.text));
  check('the remarks are collapsed and cut on screen, and kept whole on the title',
    full.text.includes('Category 2 for GPS. DNR visit 14/01/1998')
      && !full.text.includes('vide maintenance form.')
      && full.note === NOTES_10552.replace(/\s+/g, ' '),
    JSON.stringify({ note: full.note }));
  check('the report link is the service\u2019s own, says it carries a sketch, and opens away from the app',
    full.pills.some((a) => a.href === 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010552.pdf'
      && /with sketch/.test(a.text)), JSON.stringify(full.pills));
  check('Street View sits beside it — the other half of finding a mark on the ground',
    full.pills.some((a) => /Street View/.test(a.text) && a.href.includes('147')), JSON.stringify(full.pills));

  const one = lookups();
  check('one mark clicked is one lookup, for that mark, on the sublayer it was drawn from',
    one.length === 1 && one[0].id === 3 && one[0].where === `${PFX}mrk_id='10552'`,
    JSON.stringify(one));
  check('and that lookup asks for the callout\u2019s fields — never the adjustment date the AHD pattern refuses',
    one.length === 1 && asSet(one[0].outFields) === FULL_FIELDS && !one[0].outFields.includes('ahdadj_dt'),
    String(one.length === 1 ? asSet(one[0].outFields) : ''));

  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__surveyClick([-20.0, 147.0], 5));
  await settle();
  const reopened = await page.evaluate(() => window.__popupText());
  check('re-opening the same callout costs no second lookup',
    lookups().length === 1 && reopened.includes('52.38 m AHD · Class C / 3rd ORDER'),
    JSON.stringify(lookups()));

  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  // Mark 10553 has no height, only the 'ahdadj_dt' epoch date — which must
  // never be printed as one.
  const popB = await page.evaluate(() => window.__surveyClick([-19.995, 147.01], 0));
  check('a mark with no AHD height shows none — the adjustment date is refused',
    !!popB && popB.includes('10553') && !popB.includes('m AHD'), String(popB));
  await settle();
  const fullB = await page.evaluate(() => window.__popupText());
  check('a mark nobody has found since 1998 says so, and still shows no height',
    fullB.includes('NOT FOUND · last visited 6 Feb 1998') && !fullB.includes('m AHD'), String(fullB));

  // ── A callout whose lookup fails is still the callout (#174) ──────────────
  // The link is built from the mark number, so the reason for opening the
  // callout survives the lookup that fills in the rest.
  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__surveyClick([-20.005, 146.99], 0));
  await settle();
  const failed = await page.evaluate(() => ({ text: window.__popupText(), pills: window.__popupPills() }));
  check('a refused lookup says so plainly and keeps the report link',
    failed.text.includes('Mark 10554')
      && failed.text.includes('12.5 m AHD')
      && failed.text.includes('Mark details unavailable.')
      && failed.pills.some((a) => a.href === 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010554.pdf'),
    JSON.stringify(failed));

  // ── A mark with nothing but a number ──────────────────────────────────────
  // The service publishes no report link for it either, so the link is the one
  // derived from the mark number — left-padded to six digits, the shape the
  // joined field carried on all 328 live marks it was checked against.
  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__surveyClick([-20.01, 147.02], 0));
  await settle();
  const bare = await page.evaluate(() => ({ text: window.__popupText(), pills: window.__popupPills() }));
  check('a mark with only a number prints only what is there, and derives its report link',
    bare.text.includes('Mark 10555')
      && bare.text.includes('Survey control mark')
      && !bare.text.includes(' · ')
      && !bare.text.includes('unavailable')
      && bare.pills.some((a) => a.href === 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010555.pdf'),
    JSON.stringify(bare));

  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  const popMiss = await page.evaluate(() => window.__surveyClick([-20.0, 147.0], 120));
  check('a click past the hit distance opens nothing', popMiss === null, String(popMiss));

  const popDraw = await page.evaluate(() => {
    state.draw.tool = 'line';   // an armed draw tool owns the click
    const out = window.__surveyClick([-20.0, 147.0], 0);
    state.draw.tool = null;
    return out;
  });
  check('an armed draw tool owns the click — the mark yields', popDraw === null, String(popDraw));

  // ── The off switch means it never happened ────────────────────────────────
  await page.evaluate(() => MapSurvey.setEnabled(false));
  await page.waitForTimeout(350);
  const off = await page.evaluate(() => ({
    icons: document.querySelectorAll('.mn-survey-div').length,
    popups: document.querySelectorAll('.leaflet-popup-content').length,
    note: document.getElementById('map-survey-note').textContent,
  }));
  check('the off switch removes marks, callout and count together',
    off.icons === 0 && off.popups === 0 && /hidden/i.test(off.note), JSON.stringify(off));

  check('no pageerror', errors.length === 0, errors.join(' | '));

  // ── The fallback service's path ───────────────────────────────────────────
  // With /layers unreachable, MapSurvey falls back to the flat FoundationData
  // point layer, which it asks with outFields '*'. Two things follow, and both
  // are #174's: the rows arrive complete, so no callout there ever looks
  // anything up; and that service publishes no report link at all, so the link
  // is the one derived from the mark number.
  const fbQueried = [];
  const fbPage = await context.newPage();
  await applyNetworkPolicy(fbPage, server.origin);
  fbPage.on('pageerror', (e) => errors.push('fallback: ' + e.message));
  await fbPage.route(QLD_SURVEY_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/layers')) {
      // The sublayer probe is unreachable — this is what sends MapSurvey to
      // the fallback in the first place.
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service Unavailable' });
    }
    fbQueried.push({ path: url.pathname, outFields: url.searchParams.get('outFields') });
    const rows = whereFilter(FIXTURE[3], url.searchParams.get('where'));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      // The fallback layer publishes the same field names minus the joined
      // report link, and unprefixed — which is why the app matches on a key's
      // last segment and not on the prefix it saw first.
      body: JSON.stringify({ features: rows.map((f) => ({
        geometry: f.geometry,
        attributes: Object.fromEntries(Object.entries(f.attributes)
          .filter(([k]) => k !== RPT)
          .map(([k, v]) => [k.split('.').pop(), v])),
      })) }),
    });
  });
  await fbPage.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await fbPage.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await fbPage.evaluate(() => switchTab('stations'));
  await fbPage.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await fbPage.evaluate((c) => {
    state.map.setView([c.lat, c.lon], 13, { animate: false });
    MapSurvey.setEnabled(true);
  }, CENTER);
  await fbPage.waitForFunction(() => /marks? in view/.test(document.getElementById('map-survey-note').textContent),
    null, { timeout: 15_000 });
  const fbPop = await fbPage.evaluate(() => {
    const at = state.map.layerPointToLatLng(state.map.latLngToLayerPoint([-20.0, 147.0]));
    state.map.fire('click', {
      latlng: at,
      layerPoint: state.map.latLngToLayerPoint(at),
      containerPoint: state.map.latLngToContainerPoint(at),
      originalEvent: new MouseEvent('click'),
    });
    const el = document.querySelector('.leaflet-popup-content');
    return {
      text: el ? el.textContent : null,
      pills: [...document.querySelectorAll('.leaflet-popup-content a.pill')]
        .map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() })),
    };
  });
  check('on the fallback service the callout is complete the moment it opens — nothing to look up',
    !!fbPop.text
      && fbPop.text.includes('Survey control mark · STAND')
      && fbPop.text.includes('GOOD · last visited 3 Nov 2023')
      && !/Looking up mark details|unavailable/.test(fbPop.text),
    JSON.stringify(fbPop.text));
  check('and its report link is derived from the mark number, since that service publishes none',
    fbPop.pills.some((a) => a.href === 'https://qspatial.information.qld.gov.au/SurveyReport/SCR010552.pdf'),
    JSON.stringify(fbPop.pills));
  check('the fallback is asked once, for the whole row, and never again for one mark',
    fbQueried.length === 1 && fbQueried[0].outFields === '*'
      && fbQueried[0].path.includes('FoundationData/FeatureServer/8'),
    JSON.stringify(fbQueried));

  check('no pageerror on the fallback path', errors.length === 0, errors.join(' | '));
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
console.log('PASS — the marks the service returns are on the map, counted honestly, and reachable.');
