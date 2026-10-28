// Route on map (#251 of #250): the Worker's /api/drive (worker/drive.js) and
// the Stations map's 🛣️ (map-drive.js).
//
// In two halves.
//
// **Under Node**, the route against stand-ins for the router (FOSSGIS's
// Valhalla), the edge cache, the clock and the editor check. What matters,
// because each fails in silence if wrong: nobody but an editor gets a route;
// a coordinate it will not take is refused before anybody is asked anything;
// the router is asked exactly the two points, rounded to a metre, under
// Flood-Net's name and with nothing of the caller's — not the session, not a
// cookie; FOSSGIS's one-a-second holds within an isolate, a queue too long is
// turned away, the same pair asked twice at once is one request and asked
// again later is the edge cache's; the binding's "no" stops it before the
// router; the router's own "there is no drive" is a 422 that says why, and a
// router that is down, slow, wordy or garbled is a 502/504 that is not kept.
// And the shape: the polyline decoded against Google's own worked example, the
// arrival turned out of the steps, how far each end of the road is from the
// point asked for.
//
// **In Chromium**, the real app on the real station list, with the Worker,
// the database's access tracks and the gazetteer stood in: signed out there is
// no 🛣️; signed in it is in the Position group after Directions, on the card
// and in the editor. Where the drive starts, by the owner's rule — a desk is
// never asked for its position; a Brisbane-hub station starts at Pritchard
// Road, Virginia; any other is asked, and offered where I am, the depot, a
// click on the map (Escape stops it), the start used last, and a coordinate, a
// station or a town typed in; a phone starts where it is, and falls back to
// the rule, saying why, when it will not say or only roughly. An access
// track: the drive goes to its road end, whichever way round it was recorded,
// and it is drawn from there to the pin; a road that stops short is a dotted
// stretch, and the panel says how long. The panel: the distance and time, the
// turns, Directions, OpenStreetMap's credit and its fix-the-map link, every
// word marked with a meaning and listed in the fold, and every handler real.
// The Worker refusing, and no Worker at all. The map rebuilt under it, and
// signing out taking it away.
//
// Run:  npm run drive
//       npm run drive -- -v    also print what passed

import fs from 'node:fs';
import worker from '../worker/index.js';
import { handleDrive, isDrivePath, decodePolyline6, parsePoint, routerBody, shapeTrip, metres,
         ROUTER_URL, USER_AGENT, SPACING_MS, MAX_WAIT_MS, CACHE_S, MAX_BYTES, DRIVE_RATE, _test } from '../worker/drive.js';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { seedRows } from './lib/migration.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);

const ORIGIN = 'https://floodwarning.net';
const DEPOT = [-27.37429, 153.06059];

// Google's encoded polyline at six places — the router's shape — written here
// rather than borrowed from the file under test.
function encode6(pts) {
  const one = v => {
    let n = v < 0 ? ~(v << 1) : v << 1, out = '';
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return out + String.fromCharCode(n + 63);
  };
  let out = '', pl = 0, pn = 0;
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6);
    out += one(a - pl) + one(b - pn);
    pl = a; pn = b;
  }
  return out;
}

// A trip as Valhalla answers one: four points from `from` to `short` degrees
// north of `to`, three turns and the arrival.
function tripBody(from, to, short = 0) {
  const end = [to[0] + short, to[1]];
  const midLat = (from[0] + end[0]) / 2;
  const pts = [from, [midLat, from[1]], [midLat, end[1]], end];
  return {
    trip: {
      status: 0, units: 'kilometers', language: 'en-GB',
      summary: { length: 123.456, time: 5432.1, has_ferry: false, has_toll: true },
      legs: [{
        shape: encode6(pts), summary: {},
        maneuvers: [
          { type: 1, instruction: 'Drive east on Pritchard Road.', length: 0.2, time: 30, begin_shape_index: 0 },
          { type: 10, instruction: 'Turn right onto Sandgate Road.', length: 100, time: 4000, begin_shape_index: 1 },
          { type: 15, instruction: 'Turn left.', length: 23.256, time: 1402, begin_shape_index: 2 },
          { type: 4, instruction: 'You have arrived at your destination.', length: 0, time: 0, begin_shape_index: 3 },
        ],
      }],
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Under Node: the route
// ════════════════════════════════════════════════════════════════════════════

{
  // The clock, the cache and the router, all stand-ins.
  let now = Date.UTC(2026, 9, 28, 2, 0, 0);
  const waits = [];
  const kept = new Map();
  const cache = {
    async match(req) {
      const k = kept.get(req.url);
      return k && k.until > now ? new Response(k.body, { headers: { 'Content-Type': 'application/json' } }) : undefined;
    },
    async put(req, res) {
      const age = Number((/max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '') || [])[1]) || 0;
      kept.set(req.url, { body: await res.text(), until: now + age * 1000 });
    },
  };
  const calls = [];
  let answer = (body) => new Response(J(tripBody(body.locations.map(l => [l.lat, l.lon])[0], body.locations.map(l => [l.lat, l.lon])[1])), { status: 200 });
  let gate = null;     // a promise the router waits on, to hold a request in flight
  const deps = {
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers || {})), body });
      if (gate) await gate;
      return answer(body, init);
    },
    cache,
    now: () => now,
    sleep: async ms => { waits.push(ms); },
    whoIs: async req => {
      const a = req.headers.get('Authorization') || '';
      return a === 'Bearer editor' ? 'editor' : a === 'Bearer member' ? 'member' : null;
    },
  };
  const ask = (q, { auth = 'editor', method = 'GET', env = {}, headers = {} } = {}) => handleDrive(
    new Request(`${ORIGIN}/api/drive${q}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } }),
    env, { waitUntil() {} }, deps);
  const read = async res => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });
  const Q = (a, b) => `?from=${a[0]},${a[1]}&to=${b[0]},${b[1]}`;
  const GATTON = [-27.55466, 152.274156];

  // ── Where it is ──
  check('the route is /api/drive and nothing near it',
    isDrivePath('/api/drive') && !isDrivePath('/api/drive/x') && !isDrivePath('/api/drives') && !isDrivePath('/api/v1/drive'));
  {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/drive${Q(DEPOT, GATTON)}`), {}, {});
    const r = await read(res);
    check('worker/index.js sends /api/drive here — and with no session it is a 401', r.status === 401 && /editor/.test(r.body && r.body.error), J(r));
  }

  // ── What it will not take ──
  {
    const before = calls.length;
    const post = await ask(Q(DEPOT, GATTON), { method: 'POST' });
    const none = await read(await ask(''));
    const half = await read(await ask('?from=-27.3,153.06&to=abc'));
    const three = await read(await ask('?from=-27.3,153.06,4&to=-27.5,152.2'));
    const london = await read(await ask(Q([51.5, -0.12], GATTON)));
    const apart = await read(await ask(Q([-42.88, 147.33], [-10.7, 142.5])));
    check('GET only — a POST is a 405', post.status === 405 && post.headers.get('Allow') === 'GET');
    check('no points, half a point, three numbers: each a 400 that says what it wants',
      [none, half, three].every(r => r.status === 400 && /latitude and a longitude/.test(r.body.error)), J([none, half, three].map(r => r.status)));
    check('a point outside Australia is a 400', london.status === 400 && /Australia/.test(london.body.error), J(london.body));
    check('two points more than 2,500 km apart (Hobart to Cape York) are a 400', apart.status === 400 && /2,500 km/.test(apart.body.error), J(apart.body));
    check('… and none of them asked the router', calls.length === before);
    check('parsePoint reads a pair however it is spaced, rounded to a metre, and nothing else',
      J(parsePoint(' -27.1234567 , 153.2 ')) === J([-27.12346, 153.2]) && parsePoint('1,2,3') === null && parsePoint('north, south') === null);
  }

  // ── Who may ──
  {
    const before = calls.length;
    const out = await read(await ask(Q(DEPOT, GATTON), { auth: null }));
    const member = await read(await ask(Q(DEPOT, GATTON), { auth: 'member' }));
    check('signed out: 401, asking to sign in as an editor', out.status === 401 && /Sign in as an editor/.test(out.body.error), J(out.body));
    check('a member who may only look: 401, routes are for editors', member.status === 401 && /for editors/.test(member.body.error), J(member.body));
    check('… and neither reached the router', calls.length === before);
  }

  // ── An editor's route ──
  {
    _test.reset();
    const from = [-27.374291234, 153.060594321];
    const res = await ask(Q(from, GATTON), { headers: { Cookie: 'CF_Authorization=secret', 'X-Forwarded-For': '203.0.113.9' } });
    const r = await read(res);
    const c = calls[calls.length - 1];
    check('an editor gets a 200', r.status === 200, J(r.body).slice(0, 300));
    check('the router is asked once, by POST, at FOSSGIS\'s Valhalla', calls.length === 1 && c.url === ROUTER_URL && c.method === 'POST', J(calls.map(x => x.url)));
    check('… exactly the two points, rounded to a metre, by car, in metric, with the turns in words',
      J(c.body) === J(routerBody([-27.37429, 153.06059], GATTON.map(v => Number(v.toFixed(5)))))
      && c.body.costing === 'auto' && c.body.units === 'kilometers' && c.body.directions_type === 'instructions' && c.body.language === 'en-GB', J(c.body));
    check('… under Flood-Net\'s name, with the site as the referrer', c.headers['user-agent'] === USER_AGENT && /^Flood-Net /.test(USER_AGENT)
      && c.headers.referer === 'https://floodwarning.net/', J(c.headers));
    check('… and nothing of the caller\'s: no session, no cookie, no address',
      !('authorization' in c.headers) && !('cookie' in c.headers) && !('x-forwarded-for' in c.headers), J(Object.keys(c.headers)));
    check('the answer: km to the 10 m, seconds whole, toll and ferry said',
      r.body.km === 123.46 && r.body.s === 5432 && r.body.toll === true && r.body.ferry === false, J({ km: r.body.km, s: r.body.s }));
    const want = [[-27.37429, 153.06059], [(-27.37429 + GATTON[0]) / 2, 153.06059], [(-27.37429 + GATTON[0]) / 2, GATTON[1]], GATTON]
      .map(p => p.map(v => Number(v.toFixed(5))));
    check('the shape decoded to the router\'s points, latitude first, to a metre',
      r.body.shape.length === 4 && r.body.shape.every((p, i) => Math.abs(p[0] - want[i][0]) < 2e-5 && Math.abs(p[1] - want[i][1]) < 2e-5), J(r.body.shape));
    check('the turns in words, each with its distance and time — the arrival left to the app, which says where the road ends',
      r.body.steps.length === 3 && r.body.steps[0].text === 'Drive east on Pritchard Road.' && r.body.steps[2].km === 23.256
      && r.body.steps.every(st => typeof st.s === 'number' && typeof st.at === 'number') && !r.body.steps.some(st => /arrived/.test(st.text)), J(r.body.steps));
    check('both ends on the road: no gap either end', r.body.gap_start_m === 0 && r.body.gap_end_m === 0, J([r.body.gap_start_m, r.body.gap_end_m]));
    check('the credit and the fix-the-map link travel with it',
      /OpenStreetMap/.test(r.body.source.data) && r.body.source.fix === 'https://www.openstreetmap.org/fixthemap' && r.body.source.router === 'Valhalla');
    check('the document lock and no-store, as every Worker JSON answer',
      res.headers.get('Cache-Control') === 'no-store' && res.headers.get('X-Content-Type-Options') === 'nosniff'
      && /sandbox/.test(res.headers.get('Content-Security-Policy') || '') && /json/.test(res.headers.get('Content-Type')));

    // Asked again, the same pair to the metre.
    const again = await read(await ask(Q([-27.374289, 153.060591], GATTON)));
    check('the same pair asked again is the edge cache\'s, said so — the router not asked',
      again.status === 200 && again.body.cached === true && calls.length === 1, J({ calls: calls.length, cached: again.body.cached }));
    now += (CACHE_S + 1) * 1000;
    await ask(Q(DEPOT, GATTON));
    check(`… for ${CACHE_S / 3600} hours, and then the router again`, calls.length === 2, String(calls.length));
  }

  // ── Where the road stops short ──
  {
    _test.reset();
    answer = body => {
      const [a, b] = body.locations.map(l => [l.lat, l.lon]);
      return new Response(J(tripBody(a, b, 0.002)), { status: 200 });
    };
    const r = await read(await ask(Q(DEPOT, [-27.6, 152.3])));
    const want = Math.round(metres([-27.6, 152.3], [-27.598, 152.3]));
    check('a road that stops 0.002° short: gap_end_m says how far (about 222 m)', r.body.gap_end_m === want && want > 215 && want < 230, J([r.body.gap_end_m, want]));
    answer = body => new Response(J(tripBody(...body.locations.map(l => [l.lat, l.lon]))), { status: 200 });
  }

  // ── Brakes ──
  {
    _test.reset();
    waits.length = 0;
    const n = calls.length;
    const pairs = Array.from({ length: 10 }, (_, i) => Q(DEPOT, [-27.0 - i / 10, 152.0]));
    const res = await Promise.all(pairs.map(q => ask(q)));
    const st = res.map(r => r.status);
    check(`a second between requests to the router from one isolate: nine routes waited 1 s, 2 s, … ${MAX_WAIT_MS / 1000} s`,
      J(waits) === J([1, 2, 3, 4, 5, 6, 7, 8].map(s => s * SPACING_MS)), J(waits));
    check(`… and a tenth, more than ${MAX_WAIT_MS / 1000} s away, is a 429 that asked nobody`,
      st.filter(s => s === 200).length === 9 && st[9] === 429 && calls.length === n + 9, J(st));
    const busy = await read(res[9]);
    check('… which says the router is busy, with Retry-After', busy.body.code === 'busy' && res[9].headers.get('Retry-After') === '60', J(busy.body));
  }
  {
    _test.reset();
    let open;
    gate = new Promise(r => { open = r; });
    const n = calls.length;
    const two = Promise.all([ask(Q(DEPOT, [-26.5, 152.9])), ask(Q(DEPOT, [-26.5, 152.9]))]);
    await new Promise(r => setTimeout(r, 20));
    const held = _test.inflight();
    open();
    gate = null;
    const [a, b] = await two;
    check('the same pair asked twice at once is one request to the router', held === 1 && calls.length === n + 1 && a.status === 200 && b.status === 200, J({ held, calls: calls.length - n }));
  }
  {
    _test.reset();
    const keys = [];
    const env = { [DRIVE_RATE.binding]: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
    const n = calls.length;
    const res = await ask(Q(DEPOT, [-25.5, 152.0]), { env });
    const r = await read(res);
    check(`the binding (${DRIVE_RATE.binding}, ${DRIVE_RATE.limit} / ${DRIVE_RATE.period} s) saying no is a 429 before the router, on one key for everybody`,
      r.status === 429 && r.body.code === 'busy' && calls.length === n && J(keys) === J([DRIVE_RATE.key]), J({ r: r.body, keys }));
    const okEnv = { [DRIVE_RATE.binding]: { limit: async () => ({ success: true }) } };
    const ok = await ask(Q(DEPOT, [-25.5, 152.0]), { env: okEnv });
    const erred = await ask(Q(DEPOT, [-25.6, 152.0]), { env: { [DRIVE_RATE.binding]: { limit: async () => { throw new Error('binding down'); } } } });
    check('… saying yes, it goes on; a binding that errs leaves the spacing to decide', ok.status === 200 && erred.status === 200);
  }

  // ── The router's answers ──
  {
    const cases = [
      ['no road near a point (171)', () => new Response(J({ error_code: 171, error: 'No suitable edges near location', status_code: 400 }), { status: 400 }), 422, 'no_road', /no road the router knows of near/],
      ['no road between (442)', () => new Response(J({ error_code: 442, error: 'No path could be found for input', status_code: 400 }), { status: 400 }), 422, 'no_path', /no road between/],
      ['too far (154)', () => new Response(J({ error_code: 154, error: 'Path distance exceeds the max distance limit' }), { status: 400 }), 422, 'too_far', /further apart/],
      ['another 400', () => new Response(J({ error_code: 999, error: 'Something élse' }), { status: 400 }), 502, 'router', /HTTP 400: Something lse/],
      ['a 500', () => new Response('oops', { status: 500 }), 502, 'router', /HTTP 500/],
      ['its own 429', () => new Response('slow down', { status: 429 }), 429, 'busy', /turning requests away/],
      ['no answer in time', () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 504, 'timeout', /within 20 seconds/],
      ['unreachable', () => { throw new TypeError('fetch failed'); }, 502, 'router', /could not be reached/],
      ['a 200 that is not JSON', () => new Response('<html>', { status: 200 }), 502, 'router', /not a route/],
      ['a 200 with no trip', () => new Response(J({ hello: 1 }), { status: 200 }), 502, 'router', /not a route/],
      ['more than a route', () => new Response(new Uint8Array(MAX_BYTES + 1), { status: 200 }), 502, 'router', /more than a route/],
    ];
    let i = 0;
    for (const [what, fn, status, code, said] of cases) {
      _test.reset();
      answer = fn;
      const q = Q(DEPOT, [-24 - (i++) / 100, 151.5]);
      const r = await read(await ask(q));
      check(`the router: ${what} → ${status} {code: '${code}'}, said in words`, r.status === status && r.body.code === code && said.test(r.body.error), J(r));
    }
    // A failure is never kept: the next ask goes to the router.
    _test.reset();
    answer = () => new Response('oops', { status: 500 });
    const q = Q(DEPOT, [-23.5, 151.5]);
    await ask(q);
    const n = calls.length;
    answer = body => new Response(J(tripBody(...body.locations.map(l => [l.lat, l.lon]))), { status: 200 });
    const r = await read(await ask(q));
    check('a failure is not kept: asked again, the router is asked again', r.status === 200 && calls.length === n + 1 && !r.body.cached);
  }

  // ── The shape, against somebody else's arithmetic ──
  {
    // Google's worked example, "_p~iF~ps|U_ulLnnqC_mqNvxq`@", is
    // (38.5, -120.2), (40.7, -120.95), (43.252, -126.453) at five places — and
    // so a tenth of each at six.
    const d = decodePolyline6('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    check('the polyline at six places, against Google\'s own worked example',
      J(d) === J([[3.85, -12.02], [4.07, -12.095], [4.3252, -12.6453]]), J(d));
    check('shapeTrip refuses what is not a trip', shapeTrip({}, DEPOT, DEPOT, now) === null
      && shapeTrip({ trip: { legs: [{ shape: encode6([DEPOT]) }], summary: {} } }, DEPOT, DEPOT, now) === null);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// In Chromium: the button, the start, the drawing, the panel
// ════════════════════════════════════════════════════════════════════════════

const KINDS = [...seedRows(fs.readFileSync(repo('db', 'migrations', '0061_station_features.sql'), 'utf8'), 'station_feature_kind'),
               ...seedRows(fs.readFileSync(repo('db', 'migrations', '0067_access_tracks.sql'), 'utf8'), 'station_feature_kind')];
const BRIS = 'loudoun_br_al';       // a Brisbane-hub station, no track
const TRACKED = 'gatton_al';        // a Brisbane-hub station given a track below
const NORTH = 'abergowrie_br_al';   // a Cairns-hub station

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

// What the stand-ins were asked, and how they answer.
const drives = [];                  // { from, to, auth }
const lookups = [];                 // the gazetteer's q
const stand = { mode: 'ok', short: 0, rows: [] };

function driveAnswer(from, to) {
  if (stand.mode === 'no_road') return { status: 422, body: { error: 'There is no road the router knows of near one of the two points.', code: 'no_road' } };
  if (stand.mode === 'none') return { status: 404, html: true };
  return { status: 200, body: shapeTrip(tripBody(from, to, stand.short), from, to, Date.now()) };
}

async function openApp(contextOpts = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, ...contextOpts });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  page.on('dialog', async d => { errors.push(`dialog: ${d.message()}`); await d.dismiss().catch(() => {}); });
  await page.route(/\/api\/drive\?/, async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = s => s.split(',').map(Number);
    const from = p(u.searchParams.get('from')), to = p(u.searchParams.get('to'));
    drives.push({ from: u.searchParams.get('from'), to: u.searchParams.get('to'), auth: req.headers().authorization || '' });
    const a = driveAnswer(from, to);
    if (a.html) return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' });
    return route.fulfill({ status: a.status, contentType: 'application/json', body: J(a.body) });
  });
  await page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    if (req.method() === 'GET' && name === 'station_feature_kind') return json(200, KINDS);
    if (req.method() === 'GET' && name === 'station_feature') {
      const ids = (url.searchParams.get('station_id') || '').replace(/^in\.\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
      return json(200, stand.rows.filter(r => ids.includes(r.station_id)));
    }
    return json(200, []);
  });
  await page.route(/nominatim\.openstreetmap\.org\/search/, route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    lookups.push(q);
    const hits = /julatten/i.test(q) ? [{ category: 'place', type: 'town', addresstype: 'town', name: 'Julatten',
      display_name: 'Julatten, Shire of Mareeba, Queensland, 4871, Australia', lat: '-16.6', lon: '145.35',
      boundingbox: ['-16.61', '-16.59', '145.34', '145.36'] }] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: J(hits) });
  });
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  // The device's position, stood in: how many times it was asked, and what it
  // says — a fix, a refusal, or a fix too rough to use.
  await page.evaluate(() => {
    window.__geo = { calls: 0, mode: 'fix', fix: { latitude: -27.47, longitude: 153.02, accuracy: 12 } };
    const g = navigator.geolocation;
    g.getCurrentPosition = (ok, bad) => {
      window.__geo.calls++;
      setTimeout(() => {
        if (window.__geo.mode === 'denied') bad({ code: 1, message: 'denied' });
        else ok({ coords: { ...window.__geo.fix } });
      }, 10);
    };
  });
  return { context, page };
}

const signIn = page => page.evaluate(() => {
  dbSetAccessToken('test-token');
  Auth.isSignedIn = () => true;
  Auth.mayWrite = () => true;
  Auth.role = () => 'editor';
  Auth.accessToken = () => 'test-token';
  SiteFeatures.authChanged();
  MapDrive.authChanged();
  repaintStnCard();
});

const signOut = page => page.evaluate(() => {
  dbSetAccessToken(null);
  Auth.isSignedIn = () => false;
  Auth.mayWrite = () => false;
  Auth.role = () => null;
  Auth.accessToken = () => null;
  SiteFeatures.authChanged();
  MapDrive.authChanged();
  repaintStnCard();
});

const job = page => page.evaluate(() => MapDrive._job());
const drawn = page => page.evaluate(() => MapDrive._drawn());
const settled = (page, status = 'ok') => page.waitForFunction(st => {
  const j = MapDrive._job();
  return !!j && j.status === st;
}, status, { timeout: 10_000 });
const panelText = page => page.evaluate(() => (document.querySelector('.mn-drive-panel') || {}).textContent || '');
const pinOf = (page, id) => page.evaluate(i => { const s = state.data.stations.find(x => x.id === i); return [+s.lat, +s.lon]; }, id);
const f5 = p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
const press = (page, sel) => page.click(`.mn-drive-panel ${sel}`);
const pressText = (page, text) => page.locator('.mn-drive-panel button', { hasText: text }).first().click();

try {
  // ── Signed out, then in ──
  const { context, page } = await openApp();
  await page.evaluate(id => showStationCard(id), BRIS);
  await page.waitForSelector('#stn-card:not([hidden])');
  const outPill = await page.evaluate(() => !!document.querySelector('#stn-card .mn-drive-pill'));
  check('signed out: no 🛣️ on the station card', !outPill);

  await signIn(page);
  const row = await page.evaluate(() => {
    const g = [...document.querySelectorAll('#stn-card [aria-label="Position"]')][0];
    if (!g) return null;
    const items = [...g.querySelectorAll('.pill')];
    const i = items.findIndex(x => x.classList.contains('mn-directions'));
    const b = g.querySelector('.mn-drive-pill');
    return { after: i >= 0 && items[i + 1] === b, label: b && b.textContent.replace(/\s+/g, ' ').trim(), pressed: b && b.getAttribute('aria-pressed') };
  });
  check('signed in as an editor: 🛣️ Route on map, in the Position group right after Directions',
    row && row.after && row.label === '🛣️ Route on map' && row.pressed === 'false', J(row));
  check('… not for a member who may only look', await page.evaluate(() => {
    Auth.mayWrite = () => false;
    const none = MapDrive.pillHtml(state.data.stations.find(s => s.id === 'loudoun_br_al')) === '';
    Auth.mayWrite = () => true;
    return none;
  }));

  // ── A desk, a Brisbane-hub station: Pritchard Road ──
  await page.click('#stn-card .mn-drive-pill');
  await settled(page);
  const pin = await pinOf(page, BRIS);
  const d1 = drives[drives.length - 1];
  check('a desk is never asked where it is', await page.evaluate(() => window.__geo.calls) === 0);
  check('a Brisbane-hub station starts at Pritchard Road, Virginia — to the pin, with the editor\'s session',
    drives.length === 1 && d1.from === f5(DEPOT) && d1.to === f5(pin) && d1.auth === 'Bearer test-token', J(d1));
  const t1 = await panelText(page);
  check('the panel: the station, where from, by road 123 km about 1 h 31 min',
    /Route to Loudoun Br AL/.test(t1) && /Pritchard Road, Virginia/.test(t1) && /123 km, about 1 h 31 min/.test(t1), t1.slice(0, 300));
  const k1 = (await drawn(page)).map(x => x.kind);
  check('on the map: the road, and nothing unmapped when the road reaches the pin', J(k1) === J(['road']), J(k1));
  const fold = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('.mn-drive-panel .mn-drive-steps li')].map(li => li.textContent.trim());
    const words = [...document.querySelectorAll('.mn-drive-panel .mn-drive-words dt')].map(dt => dt.textContent.trim());
    const terms = [...document.querySelectorAll('.mn-drive-panel .term')].map(t => ({ text: t.textContent.trim(), title: t.getAttribute('title') || '' }));
    const dir = document.querySelector('.mn-drive-panel a.mn-directions');
    const links = [...document.querySelectorAll('.mn-drive-panel .mn-drive-credit a')].map(a => a.href);
    return { steps, words, terms, dir: dir && dir.href, links };
  });
  check('Turn by turn: the router\'s three, no arrival of its own', fold.steps.length === 3 && /Turn right onto Sandgate Road/.test(fold.steps[1]), J(fold.steps));
  check('every word the panel uses in its own sense has a meaning on hover — a sentence, not the word again',
    fold.terms.length >= 2 && fold.terms.every(t => t.title.length > 60 && t.title !== t.text), J(fold.terms));
  check('… and listed in the fold for a finger or a keyboard', J(fold.words) === J(['From', 'By road', 'Access track', 'Not mapped']), J(fold.words));
  check('🚗 Directions on the panel too, to the station\'s own coordinate', !!fold.dir && fold.dir.includes(encodeURIComponent(`${pin[0]},${pin[1]}`)), fold.dir);
  check('OpenStreetMap\'s credit and its report-a-map-error link (FOSSGIS\'s terms)',
    fold.links.includes('https://www.openstreetmap.org/copyright') && fold.links.includes('https://www.openstreetmap.org/fixthemap'), J(fold.links));
  const shown = await page.evaluate(() => ({ depot: state.map.getBounds().contains([-27.37429, 153.06059]) }));
  check('the card gives way to the route, as it does to Move pin — and the map fits it',
    await page.evaluate(() => document.getElementById('stn-card').hidden) && shown.depot
    && await page.evaluate(([la, lo]) => state.map.getBounds().contains([la, lo]), pin), J(shown));
  check('focus comes to the panel, not the page', await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.mn-drive-panel')));
  const handlers = await page.evaluate(() => [...document.querySelectorAll('.mn-drive-panel [onclick], .mn-drive-panel [onsubmit], #stn-card .mn-drive-pill')]
    .map(el => el.getAttribute('onclick') || el.getAttribute('onsubmit'))
    .flatMap(h => [...h.matchAll(/MapDrive\.(\w+)/g)].map(m => m[1]))
    .filter(n => typeof MapDrive[n] !== 'function'));
  check('every handler the panel and the pill name is MapDrive\'s', handlers.length === 0, J(handlers));

  // Another look at the card while the route is up: the panel folds to a line.
  await page.evaluate(id => showStationCard(id), BRIS);
  await page.waitForSelector('#stn-card:not([hidden])');
  const folded = await page.evaluate(() => {
    const b = document.querySelector('#stn-card .mn-drive-pill');
    const p = document.querySelector('.mn-drive-panel');
    return { label: b && b.textContent.replace(/\s+/g, ' ').trim(), pressed: b && b.getAttribute('aria-pressed'),
             line: (p.querySelector('.mn-drive-line') || {}).textContent || '', steps: !!p.querySelector('.mn-drive-steps'),
             h: Math.round(p.getBoundingClientRect().height) };
  });
  check('the card opened again says the route is shown, and the panel folds to its one line',
    folded.label === '🛣️ Route shown' && folded.pressed === 'true' && /^123 km by road, about 1 h 31 min$/.test(folded.line) && !folded.steps && folded.h < 110, J(folded));
  await page.evaluate(() => closeStnCard(false));
  check('… closing the card unfolds it', await page.evaluate(() => !!document.querySelector('.mn-drive-panel .mn-drive-steps')));
  await page.click('.mn-drive-panel button[onclick="MapDrive.fold()"]');
  const byHand = await page.evaluate(() => !!document.querySelector('.mn-drive-panel .mn-drive-line'));
  await page.click('.mn-drive-panel button[onclick="MapDrive.fold()"]');
  check('▾ folds and unfolds it by hand', byHand && await page.evaluate(() => !document.querySelector('.mn-drive-panel .mn-drive-line')));

  // ── An access track, recorded from the gauge outwards ──
  const gp = await pinOf(page, TRACKED);
  const trackLL = [[0, 0], [0.002, -0.001], [0.005, -0.003], [0.009, -0.006]].map(([a, b]) => [gp[0] + a, gp[1] + b]);
  stand.rows = [{ id: '00000000-0000-4000-8000-000000000001', station_id: TRACKED, kind: 'access_track', name: '', note: '',
                  geom: { type: 'LineString', coordinates: trackLL.map(([la, lo]) => [lo, la]) }, placed: 'gps', accuracy_m: 5,
                  created_by: 'x@example.test', created_at: '2026-10-19T00:00:00Z', updated_by: 'x@example.test', updated_at: '2026-10-19T00:00:00Z' }];
  stand.short = 0.002;
  await page.evaluate(id => showStationCard(id), TRACKED);
  await page.evaluate(() => document.querySelector('#stn-card .mn-drive-pill').click());
  await settled(page);
  const d2 = drives[drives.length - 1];
  const far = trackLL[trackLL.length - 1];
  check('a station with an access track is driven to the track\'s road end, whichever way it was recorded',
    d2.to === f5(far) && d2.from === f5(DEPOT), J(d2));
  const k2 = await drawn(page);
  const tr = k2.find(x => x.kind === 'track');
  check('the track is drawn from its road end to the gauge', !!tr && Math.abs(tr.pts[0][0] - far[0]) < 1e-9
    && Math.abs(tr.pts[tr.pts.length - 1][0] - gp[0]) < 1e-9, J(tr && [tr.pts[0], tr.pts[tr.pts.length - 1]]));
  check('the road stopping 222 m short of the track is a dotted stretch between them',
    J(k2.map(x => x.kind)) === J(['road', 'gap', 'track']), J(k2.map(x => x.kind)));
  const t2 = await panelText(page);
  check('the panel: the access track\'s length and what is not mapped', /Access track\s*1\.1\d km/.test(t2) && /Not mapped\s*22\d m/.test(t2), t2.slice(0, 400));
  const steps2 = await page.evaluate(() => [...document.querySelectorAll('.mn-drive-panel .mn-drive-steps li')].map(li => li.textContent.trim()));
  check('… and the turns end with the unmapped stretch and the access track to the station',
    /with no mapped road to the start of the access track/.test(steps2[steps2.length - 2] || '') && /^Then the access track, 1\.1\d km, to the station\.$/.test(steps2[steps2.length - 1] || ''), J(steps2.slice(-2)));
  stand.short = 0;
  stand.rows = [];

  // ── A desk, a Cairns-hub station: asked where from ──
  const before = drives.length;
  await page.evaluate(id => showStationCard(id), NORTH);
  await page.evaluate(() => document.querySelector('#stn-card .mn-drive-pill').click());
  await settled(page, 'choose');
  const t3 = await panelText(page);
  const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('any other station is asked where from — nothing sent, the desk not asked where it is',
    drives.length === before && await page.evaluate(() => window.__geo.calls) === 0 && /is not a Brisbane-hub station/.test(t3), t3.slice(0, 300));
  check('… offering where I am, Pritchard Road, a click on the map and a typed start, the box ready to type in',
    /Where I am/.test(t3) && /Pritchard Road, Virginia/.test(t3) && /Click the map/.test(t3) && /town, a station or a coordinate/.test(t3) && focus === 'mn-drive-from', J({ focus }));
  await pressText(page, 'Pritchard Road');
  await settled(page);
  check('Pritchard Road pressed: the drive from the depot', drives.length === before + 1 && drives[drives.length - 1].from === f5(DEPOT));
  const n4 = drives.length;
  await page.click('.mn-drive-panel .link-btn');           // Change
  await settled(page, 'choose');
  await pressText(page, 'Keep');
  await settled(page);
  check('Change, then Keep: back to the same route without asking for it again', drives.length === n4 && (await drawn(page)).length === 1);

  // A click on the map.
  await page.click('.mn-drive-panel .link-btn');
  await pressText(page, 'Click the map');
  const picking = await page.evaluate(() => MapDrive.picking() && state.map.getContainer().classList.contains('mn-drive-picking'));
  await page.keyboard.press('Escape');
  const stopped = await page.evaluate(() => !MapDrive.picking() && !state.map.getContainer().classList.contains('mn-drive-picking'));
  check('Click the map arms a pick with a crosshair, and Escape puts it down', picking && stopped);
  await pressText(page, 'Click the map');
  const spot = await page.evaluate(() => {
    const r = document.getElementById('leaflet-map').getBoundingClientRect();
    const x = Math.round(r.x + r.width * 0.72), y = Math.round(r.y + r.height * 0.3);
    const ll = state.map.mouseEventToLatLng({ clientX: x, clientY: y });
    return { x, y, lat: ll.lat, lon: ll.lng };
  });
  await page.mouse.click(spot.x, spot.y);
  await settled(page);
  const d5 = drives[drives.length - 1];
  check('a click on the map starts the drive there', d5.from === f5([spot.lat, spot.lon]), J({ d5, spot }));

  // Typed: a coordinate, a station, a town, nothing.
  const typeStart = async text => {
    await page.click('.mn-drive-panel .link-btn');
    await settled(page, 'choose');
    await page.fill('#mn-drive-from', text);
    await page.press('#mn-drive-from', 'Enter');
  };
  const lastOffered = await page.evaluate(() => { MapDrive.choose(); return (document.querySelector('.mn-drive-panel') || {}).textContent || ''; });
  check('the start used last is offered again', lastOffered.includes(`${spot.lat.toFixed(5)}, ${spot.lon.toFixed(5)}`));
  await page.evaluate(() => MapDrive.back());
  await typeStart('-26.19, 152.665');
  await settled(page);
  check('a typed coordinate', drives[drives.length - 1].from === '-26.19000,152.66500', J(drives[drives.length - 1]));
  await typeStart('Gatton AL');
  await settled(page);
  check('a typed station, by its name', drives[drives.length - 1].from === f5(gp), J(drives[drives.length - 1]));
  await typeStart('Julatten');
  await settled(page);
  check('a typed town, through the gazetteer', lookups.includes('Julatten') && drives[drives.length - 1].from === '-16.60000,145.35000'
    && /Julatten, Shire of Mareeba/.test(await panelText(page)), J(lookups));
  const n6 = drives.length;
  await typeStart('Nowhereville');
  await page.waitForFunction(() => /Nothing called/.test(document.querySelector('.mn-drive-panel').textContent), null, { timeout: 10_000 });
  check('a name nobody knows: said so, and nothing sent', drives.length === n6);
  await page.evaluate(() => MapDrive.back());

  // ── The Worker refusing, and no Worker ──
  stand.mode = 'no_road';
  await page.evaluate(() => MapDrive.again());
  await settled(page, 'error');
  const e1 = await page.evaluate(() => ({ text: document.querySelector('.mn-drive-panel [role="alert"]').textContent, drawn: MapDrive._drawn().length,
                                         again: !!document.querySelector('.mn-drive-panel button[onclick="MapDrive.again()"]') }));
  check('the Worker\'s "no road near" said on the panel, Try again offered, nothing drawn but the start',
    /no road the router knows of/.test(e1.text) && e1.again && e1.drawn === 0, J(e1));
  stand.mode = 'none';
  await page.evaluate(() => MapDrive.again());
  await settled(page, 'error');
  check('no Worker in front of this copy (a static 404): it says routes are on floodwarning.net',
    /routes are on floodwarning\.net/i.test(await panelText(page)));
  stand.mode = 'ok';
  await page.evaluate(() => MapDrive.again());
  await settled(page);

  // ── The editor card ──
  const ed = await page.evaluate(id => {
    if (state.selectedId !== id) selectStation(id);
    const b = document.getElementById('ef-drive');
    return b && b.getAttribute('onclick');
  }, BRIS);
  check('the editor card has it too, routing to the boxes as they are', /MapDrive\.open\('loudoun_br_al', \{ live: true \}\)/.test(ed || ''), ed);

  // ── The map rebuilt under it ──
  await page.evaluate(() => switchTab('nearby'));
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  check('leaving the tab and coming back draws the route again, panel and all',
    await page.evaluate(() => !!document.querySelector('.mn-drive-panel') && MapDrive._drawn().length > 0));

  // ── Signing out ──
  await signOut(page);
  check('signing out takes the route away', await page.evaluate(() => !document.querySelector('.mn-drive-panel') && MapDrive._drawn().length === 0 && !MapDrive.active()));
  await context.close();

  // ── A phone ──
  const phone = await openApp({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await signIn(phone.page);
  const n7 = drives.length;
  await phone.page.evaluate(id => MapDrive.open(id), NORTH);
  await settled(phone.page);
  const p1 = drives[drives.length - 1];
  check('a phone starts where it is — a Cairns-hub station, no question asked', drives.length === n7 + 1 && p1.from === '-27.47000,153.02000'
    && await phone.page.evaluate(() => window.__geo.calls) === 1, J(p1));
  check('… and says so, with the fix\'s ±', /Where you are\s*\(±12 m\)/.test(await panelText(phone.page)));
  await phone.page.evaluate(() => { window.__geo.mode = 'denied'; });
  await phone.page.evaluate(id => MapDrive.open(id), BRIS);
  await settled(phone.page);
  const t8 = await panelText(phone.page);
  check('a phone that will not say where it is: a Brisbane-hub station starts at Pritchard Road, saying why',
    drives[drives.length - 1].from === f5(DEPOT) && /not allowed to say where it is/.test(t8), t8.slice(0, 300));
  await phone.page.evaluate(id => MapDrive.open(id), NORTH);
  await settled(phone.page, 'choose');
  const t9 = await panelText(phone.page);
  check('… any other station is asked, saying why — and the keyboard not pushed up unasked',
    /not allowed to say where it is/.test(t9) && /is not a Brisbane-hub station/.test(t9)
    && await phone.page.evaluate(() => (document.activeElement && document.activeElement.id) !== 'mn-drive-from'), t9.slice(0, 300));
  await phone.page.evaluate(() => { window.__geo.mode = 'fix'; window.__geo.fix = { latitude: -27.4, longitude: 153.0, accuracy: 5000 }; });
  await phone.page.evaluate(id => MapDrive.open(id), BRIS);
  await settled(phone.page);
  check('a fix only good to 5 km is not "where you are": the rule goes on to Pritchard Road',
    drives[drives.length - 1].from === f5(DEPOT) && /within 5\.00 km/.test(await panelText(phone.page)), await panelText(phone.page));
  await phone.context.close();

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
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 300)}` : ''}`);
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: only an editor gets a route, asked of FOSSGIS's router once a second under Flood-Net's name with nothing of the caller's; it starts where the owner's rule says and is drawn by road, then the access track, saying what is not mapped.`);
