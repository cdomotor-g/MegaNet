// /api/drive — a drive by road between two points, for the Stations map's
// 🛣️ Route on map (map-drive.js, #251 of #250).
//
//   GET /api/drive?from=<lat>,<lon>&to=<lat>,<lon>
//     200  {from, to, km, s, ferry, toll, shape, steps, gap_start_m, gap_end_m,
//           source, fetched}
//     400  a coordinate it will not take (not two numbers, not in Australia,
//          the two too far apart)
//     401  not an editor's session
//     422  {code: 'no_road' | 'no_path' | 'too_far'} — the router answered, and
//          the answer is that there is no drive
//     429  {code: 'busy'} — the brake below
//     502  {code: 'router'} / 504 {code: 'timeout'} — the router did not answer
//          usefully
//
// ── Why not Google, and why this router ──────────────────────────────────────
// Google's Routes API only lets its routes be shown on a Google Map, and limits
// keeping them; the Stations map is Leaflet over OpenStreetMap, OpenTopoMap,
// Esri and the State's imagery. So the drive comes from OpenStreetMap's roads,
// through Valhalla on FOSSGIS's server (valhalla1.openstreetmap.de), which
// FOSSGIS runs for low-traffic applications like this one on these terms
// (fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen):
//
//   * at most one request a second;
//   * a User-Agent that names the application, and a Referer where possible;
//   * OpenStreetMap's attribution and a link to report a map error, shown with
//     the route — map-drive.js draws both on the map;
//   * an address to reach the operator on the site — privacy.html and
//     terms.html carry one;
//   * no high-traffic site, and the service can be withdrawn without notice.
//
// Valhalla rather than FOSSGIS's OSRM because, tried against thirty stations
// (#250), it followed property tracks further in — 150 m from the pin at two
// stations where OSRM stopped 1.4 and 2 km short — and because it takes areas
// to avoid, which #252's flooded and closed roads will need.
//
// ── Why through here ─────────────────────────────────────────────────────────
//
//   * One name on every request. FOSSGIS asks for the application's name, and
//     a browser will not let a page set User-Agent.
//   * One brake for everybody. The one-a-second limit is FOSSGIS's for this
//     application, not for each browser running it: see "Brakes".
//   * One place to change the router. FOSSGIS asks that its addresses not be
//     built into apps, since it may withdraw them; this file is where the
//     address is, and openrouteservice or a Valhalla of our own would go here.
//   * Editors only, for now (the owner, 2026-10-28) — and a route through a
//     property's gate is not for the open internet any more than its access
//     track is (0067).
//
// Nothing of the caller's request reaches the router but the two coordinates,
// rounded to a metre: not the session, not the address, not the station.
//
// ── Who may ──────────────────────────────────────────────────────────────────
// An editor: the Supabase session in Authorization, put to the database's own
// is_editor() through photos.js's whoIs(), which remembers the answer for a
// minute. A member who may only look, and the syncs' secret key, are refused —
// neither has a station card to press the button on.
//
// ── Brakes ───────────────────────────────────────────────────────────────────
//
//   * One request a second to the router from each isolate: a request that
//     arrives inside the second waits for it (up to MAX_WAIT_MS, then 429),
//     and the same two points asked twice at once are one request.
//   * DRIVE_RATE_LIMIT, Cloudflare's rate limiting binding (wrangler.toml), on
//     one key for everybody: 30 a minute per Cloudflare location, which is half
//     FOSSGIS's ceiling and far past what a few editors planning trips ask.
//     Without the binding the isolate's spacing is the brake.
//   * The answer is kept in the edge cache for CACHE_S on the rounded pair, so
//     the same route asked again — the card reopened, the start unchanged —
//     never reaches the router. OpenStreetMap's roads change daily at most.
//
// Header values are ASCII on purpose.

import { whoIs } from './photos.js';

const PATH = '/api/drive';
export const ROUTER_URL = 'https://valhalla1.openstreetmap.de/route';
export const DOC_URL = 'https://floodwarning.net/docs/drive.md';
export const USER_AGENT = `Flood-Net station routes (+${DOC_URL})`;
const REFERER = 'https://floodwarning.net/';

export const DRIVE_RATE = Object.freeze({ binding: 'DRIVE_RATE_LIMIT', key: 'valhalla', limit: 30, period: 60 });
export const SPACING_MS = 1000;
export const MAX_WAIT_MS = 8000;
export const CACHE_S = 6 * 60 * 60;
export const TIMEOUT_MS = 20000;
export const MAX_BYTES = 6 * 1024 * 1024;
// Bump to throw away every kept answer — when what this file makes of the
// router's answer changes.
const CACHE_V = '1';

// Australia and its near islands. A point outside is a typo or somebody else's
// trip; either way it is not a drive to a Flood-Net station.
export const BOUNDS = Object.freeze({ south: -44.5, north: -9.0, west: 112.0, east: 154.5 });
// Further apart than this in a straight line is not a trip anybody plans from
// a station card (Brisbane to the tip of Cape York is 1,950 km).
export const MAX_APART_KM = 2500;
// A metre, which is finer than any pin or GPS fix here — and coarse enough
// that the same trip asked twice is the same key.
const DP = 5;

// The router's own word for why there is no drive, as one of three.
const NO_DRIVE = Object.freeze({
  171: ['no_road', 'There is no road the router knows of near one of the two points.'],
  442: ['no_path', 'The router knows of no road between the two points.'],
  154: ['too_far', 'The two points are further apart than the router will plan a drive.'],
  150: ['too_far', 'The two points are further apart than the router will plan a drive.'],
});
// Valhalla's arrival manoeuvres: the client says where the road ends itself,
// because past it there may be an access track or a walk.
const ARRIVE = new Set([4, 5, 6]);

export function isDrivePath(pathname) {
  return pathname === PATH;
}

const LOCK = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...LOCK, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

const round = n => Number(Number(n).toFixed(DP));

// "lat,lon" as [lat, lon], or null.
export function parsePoint(text) {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return [round(lat), round(lon)];
}

export function inBounds([lat, lon]) {
  return lat >= BOUNDS.south && lat <= BOUNDS.north && lon >= BOUNDS.west && lon <= BOUNDS.east;
}

export function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Valhalla's shape: Google's encoded polyline at six decimal places.
export function decodePolyline6(s) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (let which = 0; which < 2; which++) {
      let shift = 0, res = 0, b;
      do {
        b = s.charCodeAt(i++) - 63;
        res |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < s.length);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (which === 0) lat += d; else lon += d;
    }
    out.push([round(lat / 1e6), round(lon / 1e6)]);
  }
  return out;
}

// What the router is asked: a car, metric, its turn-by-turn words in British
// English (it has no Australian narrative; en-AU comes back with none).
export function routerBody(from, to) {
  return {
    locations: [{ lat: from[0], lon: from[1], type: 'break' }, { lat: to[0], lon: to[1], type: 'break' }],
    costing: 'auto',
    units: 'kilometers',
    language: 'en-GB',
    directions_type: 'instructions',
  };
}

// The router's trip as this route answers it. Null when it is not a trip.
export function shapeTrip(body, from, to, fetchedMs) {
  const trip = body && body.trip;
  const leg = trip && Array.isArray(trip.legs) && trip.legs[0];
  if (!leg || typeof leg.shape !== 'string' || !trip.summary) return null;
  const shape = decodePolyline6(leg.shape);
  if (shape.length < 2) return null;
  const steps = (Array.isArray(leg.maneuvers) ? leg.maneuvers : [])
    .filter(m => m && !ARRIVE.has(m.type) && typeof m.instruction === 'string' && m.instruction)
    .map(m => ({ text: m.instruction, km: Number(Number(m.length || 0).toFixed(3)),
                 s: Math.round(Number(m.time) || 0), at: Number(m.begin_shape_index) || 0 }));
  return {
    from, to,
    km: Number(Number(trip.summary.length || 0).toFixed(2)),
    s: Math.round(Number(trip.summary.time) || 0),
    ferry: !!trip.summary.has_ferry,
    toll: !!trip.summary.has_toll,
    shape,
    steps,
    // How far each end of the road is from the point asked for: where the
    // nearest road the router knows of is further than a pin's width away,
    // the rest is on foot, by track, or unknown.
    gap_start_m: Math.round(metres(from, shape[0])),
    gap_end_m: Math.round(metres(to, shape[shape.length - 1])),
    source: {
      router: 'Valhalla',
      host: 'FOSSGIS e.V.',
      data: 'OpenStreetMap contributors (ODbL)',
      fix: 'https://www.openstreetmap.org/fixthemap',
    },
    fetched: new Date(fetchedMs).toISOString(),
  };
}

// ── Brakes ───────────────────────────────────────────────────────────────────

let nextSlot = 0;
const inflight = new Map();

// This isolate's turn to ask the router, a second after its last: false when
// that is more than MAX_WAIT_MS away.
async function slot(deps) {
  const now = deps.now();
  const at = Math.max(now, nextSlot);
  if (at - now > MAX_WAIT_MS) return false;
  nextSlot = at + SPACING_MS;
  if (at > now) await deps.sleep(at - now);
  return true;
}

async function underRate(env) {
  const b = env && env[DRIVE_RATE.binding];
  if (!b || typeof b.limit !== 'function') return true;
  try {
    const out = await b.limit({ key: DRIVE_RATE.key });
    return !(out && out.success === false);
  } catch (_) {
    return true;    // the binding erred: the isolate's spacing decides
  }
}

function once(key, job) {
  let p = inflight.get(key);
  if (!p) {
    p = job().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// ── The router ───────────────────────────────────────────────────────────────

class RouteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readCapped(body, cap) {
  if (!body) return '';
  const reader = body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { try { await reader.cancel(); } catch (_) { /* gone */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

async function askRouter(from, to, env, deps) {
  if (!(await underRate(env))) throw new RouteError(429, 'busy', 'Routes are being asked for faster than the router allows. Try again in a minute.');
  if (!(await slot(deps))) throw new RouteError(429, 'busy', 'The router is busy with other routes. Try again in a few seconds.');
  let res;
  try {
    res = await deps.fetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(routerBody(from, to)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new RouteError(504, 'timeout', `The router did not answer within ${TIMEOUT_MS / 1000} seconds.`);
    }
    throw new RouteError(502, 'router', 'The router could not be reached.');
  }
  const text = await readCapped(res.body, MAX_BYTES);
  if (text == null) throw new RouteError(502, 'router', 'The router sent more than a route.');
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  if (res.status === 429) throw new RouteError(429, 'busy', 'The router is turning requests away for now. Try again in a minute.');
  if (!res.ok) {
    const known = body && NO_DRIVE[body.error_code];
    if (known) throw new RouteError(422, known[0], known[1]);
    const said = body && typeof body.error === 'string' ? `: ${body.error.replace(/[^\x20-\x7e]/g, '').slice(0, 120)}` : '';
    throw new RouteError(502, 'router', `The router answered HTTP ${res.status}${said}.`);
  }
  const trip = shapeTrip(body, from, to, deps.now());
  if (!trip) throw new RouteError(502, 'router', 'The router answered with something that is not a route.');
  return trip;
}

// ── The route ────────────────────────────────────────────────────────────────

function defaults(deps) {
  return {
    fetch: deps.fetch || ((...a) => fetch(...a)),
    cache: deps.cache !== undefined ? deps.cache
      : (typeof caches !== 'undefined' && caches.default ? caches.default : null),
    now: deps.now || Date.now,
    sleep: deps.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    whoIs: deps.whoIs || whoIs,
  };
}

export async function handleDrive(request, env, ctx, deps = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, { Allow: 'GET' });
  const d = defaults(deps);
  const url = new URL(request.url);

  const from = parsePoint(url.searchParams.get('from'));
  const to = parsePoint(url.searchParams.get('to'));
  if (!from || !to) return json({ error: 'from and to are each a latitude and a longitude: ?from=-27.37,153.06&to=-27.22,151.19' }, 400);
  if (!inBounds(from) || !inBounds(to)) return json({ error: 'Both points have to be in Australia.' }, 400);
  if (metres(from, to) > MAX_APART_KM * 1000) {
    return json({ error: `The two points are more than ${MAX_APART_KM.toLocaleString('en-AU')} km apart.` }, 400);
  }

  const who = await d.whoIs(request, d.fetch);
  if (who !== 'editor') {
    return json({ error: who ? 'Routes on the map are for editors.' : 'Sign in as an editor to see a route on the map.' }, 401);
  }

  const key = `${url.origin}${PATH}?from=${from.join(',')}&to=${to.join(',')}&v=${CACHE_V}`;
  if (d.cache) {
    try {
      const hit = await d.cache.match(new Request(key));
      if (hit) {
        const body = await hit.json();
        return json({ ...body, cached: true }, 200);
      }
    } catch (_) { /* a cache that will not answer is no cache */ }
  }

  try {
    const trip = await once(key, async () => {
      const t = await askRouter(from, to, env, d);
      if (d.cache) {
        const put = d.cache.put(new Request(key), new Response(JSON.stringify(t), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_S}` },
        })).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
      }
      return t;
    });
    return json(trip, 200);
  } catch (err) {
    if (err instanceof RouteError) {
      return json({ error: err.message, code: err.code }, err.status, err.status === 429 ? { 'Retry-After': '60' } : {});
    }
    return json({ error: `The route could not be worked out: ${(err && err.message) || err}`, code: 'router' }, 502);
  }
}

// Read by the check and by nothing else.
export const _test = {
  reset() { nextSlot = 0; inflight.clear(); },
  inflight: () => inflight.size,
};
