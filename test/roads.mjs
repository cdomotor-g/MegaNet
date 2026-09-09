// Road reserve on the Stations map: the road parcels, and the intersections
// that were missing from them.
//
// The layer shipped drawing `parcel_typ = 'Road Type Parcel'` and nothing else,
// and every junction came out as a hole — four road strips closing off around
// an unpainted square. That reads as "the road reserve stops here", which at an
// intersection is never true. The DCDB files the crossing square under a third
// value in the same column, `'Unlinked parcel or inter'` (truncated at 24
// characters in the published field, for *unlinked parcel or intersection*),
// carrying no lot, no plan and no name.
//
// The Queensland cadastre is external and this harness blocks outbound
// requests, so the check stubs it — and, like survey.mjs, the stub reproduces
// what the live service actually does rather than an idealised version:
//
//   * the crossing square is a separate feature under the third parcel_typ,
//     sharing its four corners with the four road halves *and nothing else*.
//     The roads themselves stop dead at the junction, exactly as they do in
//     the DCDB, so this fixture has the reported hole in it unless the
//     intersection is drawn.
//   * intersection rows carry `feat_name: null`, so the name on the label can
//     only have come from the roads joined to its corners.
//   * shared corners are byte-identical coordinates, which is what
//     `geometryPrecision=6` buys and what the join is entitled to rely on.
//   * one unlinked parcel sits on its own out in a paddock, touching no road.
//     That is the other half of what that parcel_typ means, and it must not be
//     painted as road reserve.
//   * one road parcel sits in the rounded fetch bbox but outside the viewport:
//     drawn, so a small pan reveals it without a refetch, but not "in view".
//   * and the `where` clause is honoured, which is the whole point of the
//     fixture: a stub that answered every query with every row would have drawn
//     the junction whatever the app asked for, and this file would have passed
//     against the very code it was written to fail against. Asked the old
//     question the fixture has the reported hole in it; asked the new one it
//     does not.
//
// The geometry is a crossroads at the fixture centre: Miranda Drive running
// east–west, Chardonnay Street running north–south, each in two halves, with
// the square between them. Real street names from the reported view.
//
// Run:  npm run roads
//       npm run roads -- -v    also print what passed

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
// Half a road reserve's width in degrees — about 11 m, a suburban street.
const H = 0.0001;
const W = CENTER.lon - H, E = CENTER.lon + H;     // the junction's east/west edges
const S = CENTER.lat - H, N = CENTER.lat + H;     // and its north/south ones

// Written as literals, and shared between the roads and the square by
// reference, so the fixture cannot drift into "nearly the same corner" — which
// is the one thing that would make this file pass for the wrong reason.
const ring = (...pts) => [[...pts, pts[0]]];
const box = (w, s, e, n) => ring([w, s], [e, s], [e, n], [w, n]);

const ROAD = 'Road Type Parcel';
const NODE = 'Unlinked parcel or inter';
const PLACE = { locality: 'Wilsonton Heights', shire_name: 'Toowoomba Regional', lotplan: null };

function feature(parcel_typ, feat_name, coordinates) {
  return {
    type: 'Feature',
    properties: { ...PLACE, parcel_typ, feat_name },
    geometry: { type: 'Polygon', coordinates },
  };
}

const FIXTURE = [
  // Miranda Drive, west of the junction and east of it. Both stop at the
  // junction's own edge — there is no road parcel over the crossing.
  feature(ROAD, 'Miranda Drive', box(146.99, S, W, N)),
  feature(ROAD, 'Miranda Drive', box(E, S, 147.01, N)),
  // Chardonnay Street, south and north.
  feature(ROAD, 'Chardonnay Street', box(W, -20.01, E, S)),
  feature(ROAD, 'Chardonnay Street', box(W, N, E, -19.99)),
  // The crossing square. No name of its own; its corners are the four above.
  feature(NODE, null, box(W, S, E, N)),
  // An unlinked parcel touching nothing — a remnant, not a junction.
  feature(NODE, null, box(146.9795, -20.0055, 146.9805, -20.0045)),
  // A road parcel past the east edge of the viewport, inside the fetch bbox.
  feature(ROAD, 'Wine Drive', box(147.149, -20.001, 147.151, -19.999)),
];

// The service description MapRoads probes for the sublayer id, with the two
// deprecated entries the live service really publishes — the name regex has to
// step over both.
const LIVE_LAYERS = { layers: [
  { id: 0, name: 'Addresses' },
  { id: 1, name: 'Land Parcels' },
  { id: 4, name: 'Cadastral parcels' },
  { id: 5, name: '[Deprecated] Cadastral parcels - gt 1ha' },
  { id: 6, name: '[Deprecated] Cadastral parcels - gt 10ha' },
]};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
// This host serves the survey marks and the contours as well; only the
// cadastre's own service is this file's business.
const QLD_CADASTRE_ROUTE =
  /spatial-gis\.information\.qld\.gov\.au\/.*LandParcelPropertyFramework\//;

const queried = [];   // every /query MapRoads sent: { id, where, outFields }

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, hasTouch: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  // Registered after the policy so it runs first (Playwright: newest route
  // first) and answers before the off-origin abort can.
  await page.route(QLD_CADASTRE_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    let body;
    const m = url.pathname.match(/MapServer\/(\d+)\/query$/);
    if (m) {
      const where = url.searchParams.get('where');
      queried.push({
        id: Number(m[1]),
        where,
        outFields: url.searchParams.get('outFields'),
        offset: url.searchParams.get('maxAllowableOffset'),
      });
      // The bbox is ignored on purpose — what is inside the viewport and what
      // is merely inside the rounded fetch bbox is the app's own reading, and
      // the count assertion below is about exactly that reading. The `where`
      // is not: see the header.
      body = {
        type: 'FeatureCollection',
        features: FIXTURE.filter((f) => (where || '').includes(`'${f.properties.parcel_typ}'`)),
      };
    } else {
      body = LIVE_LAYERS;
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // Above MIN_ZOOM, on the fixture. The layer is on by default, so this is all
  // it takes to make it ask.
  await page.evaluate((c) => {
    state.map.setView([c.lat, c.lon], 15, { animate: false });
    MapRoads.setEnabled(true);
  }, CENTER);
  await page.waitForFunction(
    () => /road parcels? /.test(document.getElementById('map-roads-note').textContent),
    null, { timeout: 15_000 });

  // ── The query asks for both halves of a road reserve ──────────────────────
  check('the cadastre is asked for road parcels AND intersections in one query',
    queried.length > 0 && queried.every((q) =>
      q.where.includes("'Road Type Parcel'") && q.where.includes("'Unlinked parcel or inter'")),
    JSON.stringify(queried.map((q) => q.where)));
  check('and for the type column, without which the two could not be told apart',
    queried.every((q) => (q.outFields || '').split(',').includes('parcel_typ')),
    JSON.stringify(queried.map((q) => q.outFields)));
  check('only the cadastral parcels sublayer is queried — not either deprecated one',
    [...new Set(queried.map((q) => q.id))].join(',') === '4',
    JSON.stringify([...new Set(queried.map((q) => q.id))]));

  // ── Where it is drawn ────────────────────────────────────────────────────
  // Counting the parcels off the DOM is not available and should not be
  // reached for: the Stations map is built with `preferCanvas` and one shared
  // canvas renderer (app.js initMap), so a polygon in this pane is paint on a
  // canvas and not an element. What the pane can still be held to is the claim
  // map-roads.js makes about it — that nothing in it may take a pointer event a
  // station pin was drawn to answer — and the count is held below, against the
  // layer's own note, which is the figure an operator actually reads.
  const pane = await page.evaluate(() => {
    const el = document.querySelector('.leaflet-mnRoads-pane');
    return {
      exists: !!el,
      pointerEvents: el ? getComputedStyle(el).pointerEvents : null,
      interactive: document.querySelectorAll('.leaflet-mnRoads-pane .leaflet-interactive').length,
      note: document.getElementById('map-roads-note').textContent.trim(),
    };
  });
  check('the parcels have a pane of their own, and it refuses the pointer outright',
    pane.exists && pane.pointerEvents === 'none' && pane.interactive === 0, JSON.stringify(pane));

  // ── The note counts the two kinds apart, and only what is in view ─────────
  check('the note counts four road parcels — the fifth is outside the viewport',
    /\b4\b\s*road parcels/.test(pane.note), pane.note);
  check('and says the intersection is drawn, rather than folding it into that figure',
    /\b1\b\s*intersection\b/.test(pane.note) && !/\b1\b\s*intersections\b/.test(pane.note),
    pane.note);

  // ── The bug itself: the junction answers for itself ───────────────────────
  // Real mouse input, for the reason map-roads.js records: every event lands on
  // the shared pins-and-links canvas above this pane, and reaches a parcel only
  // through the map-level hit test.
  await page.evaluate(() => {
    window.__roadsHoverAt = (lat, lon) => {
      const pt = state.map.latLngToContainerPoint([lat, lon]);
      const r = state.map.getContainer().getBoundingClientRect();
      return { x: r.left + pt.x, y: r.top + pt.y };
    };
    window.__roadsLabel = () => {
      const el = document.querySelector('.leaflet-tooltip.mn-road-label');
      return el ? el.textContent.trim() : null;
    };
  });
  // Off the target, settle, then on to it — and settle again. The pause in the
  // middle is not politeness: MapRoads answers a mousemove on the next animation
  // frame and drops any move that arrives while one is already queued, so a
  // move away immediately followed by a move back is one hit test, on the
  // *first* of the two. Which reads as "the parcel is not there".
  const hoverAt = async (lat, lon) => {
    const at = await page.evaluate(([a, b]) => window.__roadsHoverAt(a, b), [lat, lon]);
    await page.mouse.move(at.x + 120, at.y + 120);
    await page.waitForTimeout(150);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(200);
    return page.evaluate(() => window.__roadsLabel());
  };

  const atJunction = await hoverAt(CENTER.lat, CENTER.lon);
  check('the middle of the crossing is road reserve — the hole the fix closes',
    !!atJunction, String(atJunction));
  check('and it is named by the two roads that meet there, which it carries no name of its own for',
    atJunction === 'Chardonnay Street / Miranda Drive intersection — Wilsonton Heights · Toowoomba Regional',
    String(atJunction));

  const atRoad = await hoverAt(CENTER.lat, CENTER.lon - 0.002);
  check('a road parcel still answers with its own name and address',
    atRoad === 'Miranda Drive — Wilsonton Heights · Toowoomba Regional', String(atRoad));

  const atRemnant = await hoverAt(-20.005, 146.98);
  check('the unlinked parcel out on its own is not claimed as road reserve',
    atRemnant === null, String(atRemnant));

  const atNothing = await hoverAt(-20.004, 147.004);
  check('and neither is the block between the roads', atNothing === null, String(atNothing));

  // ── The parcel in the bbox margin ────────────────────────────────────────
  // The fetch bbox rounds outward past the screen edges, so the layer holds
  // parcels the viewport does not show. They must be drawn — a small pan should
  // reveal one without a refetch — and must not be counted "in view" until they
  // are.
  await page.evaluate(() => state.map.panTo([-20.0, 147.15], { animate: false }));
  await page.waitForFunction(
    () => /\bWine|road parcel/.test(document.getElementById('map-roads-note').textContent),
    null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const panned = await hoverAt(-20.0, 147.15);
  check('the parcel that sat outside the viewport is named once it is inside it',
    panned === 'Wine Drive — Wilsonton Heights · Toowoomba Regional', String(panned));

  await page.evaluate((c) => state.map.panTo([c.lat, c.lon], { animate: false }), CENTER);
  await page.waitForTimeout(600);

  // ── Off, and back on ─────────────────────────────────────────────────────
  await page.evaluate(() => MapRoads.setEnabled(false));
  await page.waitForTimeout(200);
  const off = await page.evaluate(() => ({
    paths: document.querySelectorAll('.leaflet-mnRoads-pane path').length,
    note: document.getElementById('map-roads-note').textContent.trim(),
    label: window.__roadsLabel(),
  }));
  check('turning the layer off takes the parcels, the note and any hover label with them',
    off.paths === 0 && /hidden/.test(off.note) && off.label === null, JSON.stringify(off));

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
console.log('PASS — the road reserve is drawn whole, intersections included, and each one names itself.');
