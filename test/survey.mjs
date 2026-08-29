// Survey marks on the Stations map: fetched, drawn, honestly counted, and
// reachable through the map's own events (#120, and the invisible-marks bug).
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
//
// One CORS site sits inside the rounded fetch bbox but outside the viewport:
// the note used to count it as "in view", which is the honesty half of the
// bug ("1 mark in view", zero marks visible).
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

// The live service's own /layers listing, ids and types verbatim. The group
// layers and the excluded-by-name layers are the point: resolveLayers() has
// to leave every one of them unqueried.
const LIVE_LAYERS = { layers: [
  { id: 0,  name: 'CORS sites',               type: 'Feature Layer' },
  { id: 1,  name: 'Survey control marks',     type: 'Group Layer' },
  { id: 2,  name: 'GDA coordinates',          type: 'Group Layer' },
  { id: 3,  name: 'GDA datum',                type: 'Feature Layer' },
  { id: 4,  name: 'GDA derived',              type: 'Feature Layer' },
  { id: 16, name: 'GDA scaled',               type: 'Feature Layer' },
  { id: 7,  name: 'AHD heights',              type: 'Group Layer' },
  { id: 17, name: 'AHD Datum',                type: 'Feature Layer' },
  { id: 9,  name: 'AHD Derived by Levelling', type: 'Feature Layer' },
  { id: 18, name: 'AHD Derived by Other',     type: 'Feature Layer' },
  { id: 12, name: 'Cadastral connection',     type: 'Feature Layer' },
  { id: 13, name: 'Destroyed',                type: 'Feature Layer' },
]};

const CENTER = { lat: -20.0, lon: 147.0 };
const PFX = 'sirpub.prop.qld_surveycontrol_scdb.';

// Live-shaped rows. Mark B carries the trap the AHD pattern exists for: no
// height, but an epoch-milliseconds adjustment date in 'ahdadj_dt' that a
// loose /ahd/ numeric pick would print as "995846400000 m AHD".
function feature(lat, lon, attrs) {
  return { attributes: attrs, geometry: { x: lon, y: lat } };
}
const FIXTURE = {
  3: [
    feature(-20.0,   147.0,  { [PFX + 'mrk_id']: '10552', [PFX + 'ahdheight']: 52.38, [PFX + 'ahdadj_dt']: 995846400000 }),
    feature(-19.995, 147.01, { [PFX + 'mrk_id']: '10553', [PFX + 'ahdheight']: null,  [PFX + 'ahdadj_dt']: 995846400000 }),
  ],
  4: [
    feature(-20.005, 146.99, { [PFX + 'mrk_id']: '10554', [PFX + 'ahdheight']: 12.5 }),
  ],
  16: [
    feature(-20.01,  147.02, { [PFX + 'mrk_id']: '10555' }),
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

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const queried = [];   // every /query the app sent: { id, hasRC }
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, hasTouch: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  // Registered after the policy, so it runs first (Playwright: newest route
  // first) and the stub answers before the off-origin abort can.
  await page.route('**spatial-gis.information.qld.gov.au/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/layers')) {
      body = LIVE_LAYERS;
    } else {
      const m = url.pathname.match(/MapServer\/(\d+)\/query$/);
      const id = m ? Number(m[1]) : 'other';
      const hasRC = url.searchParams.has('resultRecordCount');
      queried.push({ id, hasRC });
      if (id === 1 || id === 2 || id === 7) {
        // What the live group layers actually say when queried.
        body = { error: { code: 400, message: 'Invalid or missing input parameters.', details: [] } };
      } else if (hasRC) {
        // The live quirk this whole file exists for: a per-layer cap is
        // answered with an empty feature set and no error at all.
        body = { features: [] };
      } else {
        body = { features: FIXTURE[id] || [] };
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
  });
  // 5 px off the mark: inside HIT_PX, outside the 10 px icon.
  const popA = await page.evaluate(() => window.__surveyClick([-20.0, 147.0], 5));
  check('a click near a mark opens its callout with the real AHD height',
    !!popA && popA.includes('10552') && popA.includes('Survey control mark') && popA.includes('52.38 m AHD'),
    String(popA));

  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  // Mark 10553 has no height, only the 'ahdadj_dt' epoch date — which must
  // never be printed as one.
  const popB = await page.evaluate(() => window.__surveyClick([-19.995, 147.01], 0));
  check('a mark with no AHD height shows none — the adjustment date is refused',
    !!popB && popB.includes('10553') && !popB.includes('m AHD'), String(popB));

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
