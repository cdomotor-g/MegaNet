// /api/rain-ahead — the rain one weather model has falling over the coming
// week at the stations Station Health covers, for its 🌧 Rain ahead card
// (health-rain-ahead.js): which stations with a fault open to get to before
// the rain does.
//
//   GET /api/rain-ahead                      what this route is: the model, its
//                                            source and licence, the limits
//   GET /api/rain-ahead?cells=lat,lon;…      {model, source, fetched, stale,
//                                            cells: [{at, tz, days, mm}]}
//
// ── What it is, and what it is not ──────────────────────────────────────────
//
// A raw figure from one global numerical weather model: ECMWF's IFS, the
// European Centre's high-resolution run, which ECMWF publishes as open data
// under CC BY 4.0 — its rain a day, for the next DAYS days, at the model's grid
// point nearest the middle of each quarter-degree square asked about, through
// Open-Meteo's forecast API (its data CC BY 4.0 too). No forecaster has looked
// at it. It is not a forecast or a warning from the Bureau of Meteorology, and
// Flood-Net issues neither (terms.html): the card says so in as many words,
// links the Bureau's own, and uses the figure for one thing only — which
// faults to fix first.
//
// ── Why not the Bureau's own forecasts ──────────────────────────────────────
//
// The Bureau's forecasts — its website, its anonymous-FTP products (the précis
// XML, the gridded ADFD), the weather app's API — come under the default terms
// of its copyright notice: for your own use, or inside your own organisation.
// Publishing them, which is what showing them on a page anybody can open
// amounts to, is for Registered Users under a licence, and the website does
// not permit scraping besides. Flood-Net is not a Bureau system, so it shows
// none of them and links to them instead. If that ever changes — a licence,
// or Flood-Net becoming the Bureau's — the Bureau's own forecast is the better
// source, and this route is the one place to change.
//
// ── Why through here, and not from the browser ──────────────────────────────
//
//   * Open-Meteo's free API is limited per caller — 10,000 calls a day, 5,000
//     an hour, 600 a minute — and asks callers on shared hosting to use
//     Cloudflare Workers, because it counts a Worker's calls per Cloudflare
//     account. Every office behind one address would share a browser's
//     allowance; through here everybody shares one cached answer.
//   * One host for the browser to reach: floodwarning.net, which the Bureau's
//     web filter already lets through (docs/floodwarning-net.md), not another
//     it may not.
//   * One place for a key. The free API is for non-commercial use; if the
//     owner takes a paid plan, the OPEN_METEO_KEY secret sends these requests
//     to Open-Meteo's customer API with it, and nothing else changes.
//
// ── What it will ask ────────────────────────────────────────────────────────
//
// Only Open-Meteo, only the one model and the one variable, for at most
// CELLS_MAX squares a request, each snapped to the GRID and inside Australia's
// box (AU). Nothing from the request reaches the upstream address but those
// numbers, printed again from the parsed values. The squares are sorted and
// told once each, so the same stations asked in any order, at any precision,
// are one answer in the edge cache.
//
// ── Brakes ──────────────────────────────────────────────────────────────────
//
// The edge cache's key is the squares and nothing else. An answer younger than
// FRESH_S (three hours; the model runs every six) is served as it stands;
// older, Open-Meteo is asked again, and while it will not answer the last good
// answer is served for up to KEEP_S, marked stale with the reason. One
// upstream request per answer at a time in an isolate. No per-caller limit,
// for cameras.js's reason: everything here is public, and the worst a crawler
// can do is spend the day's allowance — after which the card says the model's
// figures are not to hand, and the stale copies keep serving.
//
// CORS is open (`*`): the github.io copy and local checkouts ask
// floodwarning.net for this, as they do for /api/cameras.

const PREFIX = '/api/rain-ahead';
export const DOC_URL = 'https://floodwarning.net/docs/station-health.md';
export const UPSTREAM = 'https://api.open-meteo.com/v1/forecast';
export const UPSTREAM_KEYED = 'https://customer-api.open-meteo.com/v1/forecast';
export const MODEL = 'ecmwf_ifs';
export const DAYS = 7;
// A quarter of a degree, about 25 km: stations closer than that share one
// figure. The model's own grid is 9 km, but a day's rain from a global model
// does not know a valley from the next one, and a coarser grid is fewer
// squares to ask about (CELLS_MAX) and more stations sharing each answer.
export const GRID = 0.25;
export const CELLS_MAX = 50;
export const FRESH_S = 3 * 60 * 60;
export const KEEP_S = 48 * 60 * 60;
export const TIMEOUT_MS = 15000;
// The mainland, Tasmania and the Torres Strait — every station on the
// register — and the sea between: nothing outside it is asked about.
export const AU = Object.freeze({ s: -44.5, n: -9, w: 112, e: 154.5 });
export const USER_AGENT = `Flood-Net rain ahead (+${DOC_URL})`;

// Said with every answer, and on the card under it.
export const SOURCE = Object.freeze({
  model: 'ECMWF IFS (9 km, open data)',
  credit: 'Rain from ECMWF’s IFS weather model (© ECMWF, CC BY 4.0), through Open-Meteo.com (CC BY 4.0).',
  ecmwf: 'https://www.ecmwf.int/',
  openMeteo: 'https://open-meteo.com/',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
  not: 'A weather model’s raw figure, used only to choose which faults to fix first. '
     + 'Not a forecast or a warning from the Bureau of Meteorology or from Flood-Net.',
});

export function isRainAheadPath(pathname) {
  return pathname === PREFIX || pathname === `${PREFIX}/`;
}

const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...OPEN, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// ── The squares ──────────────────────────────────────────────────────────────

// A coordinate on the grid, as both ends print it: two decimals, the same
// rounding health-rain-ahead.js's cellOf() does.
export function snap(v) {
  const s = Math.round(v / GRID) * GRID;
  return Object.is(s, -0) ? 0 : s;
}
export const cellKey = (lat, lon) => `${snap(lat).toFixed(2)},${snap(lon).toFixed(2)}`;

// `cells` as asked → { cells: [[lat, lon], …] sorted, told once } or { error }.
export function parseCells(q) {
  if (typeof q !== 'string' || !q.trim()) return { error: 'no squares asked about: ?cells=lat,lon;lat,lon…' };
  if (q.length > 4000) return { error: 'too long a list of squares' };
  const seen = new Map();
  for (const part of q.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(-?\d{1,3}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/);
    if (!m) return { error: `not a square: "${p.slice(0, 40)}" (lat,lon in degrees)` };
    const lat = snap(Number(m[1])), lon = snap(Number(m[2]));
    if (!(lat >= AU.s && lat <= AU.n && lon >= AU.w && lon <= AU.e)) {
      return { error: `outside Australia: ${m[1]},${m[2]}` };
    }
    seen.set(cellKey(lat, lon), [lat, lon]);
  }
  if (!seen.size) return { error: 'no squares asked about: ?cells=lat,lon;lat,lon…' };
  if (seen.size > CELLS_MAX) return { error: `at most ${CELLS_MAX} squares a request, and this asked about ${seen.size}` };
  const cells = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { cells };
}

export function upstreamUrl(cells, key) {
  const u = new URL(key ? UPSTREAM_KEYED : UPSTREAM);
  u.searchParams.set('latitude', cells.map(c => c[0].toFixed(2)).join(','));
  u.searchParams.set('longitude', cells.map(c => c[1].toFixed(2)).join(','));
  u.searchParams.set('daily', 'precipitation_sum');
  u.searchParams.set('models', MODEL);
  u.searchParams.set('forecast_days', String(DAYS));
  u.searchParams.set('timezone', 'auto');
  if (key) u.searchParams.set('apikey', key);
  return u.toString();
}

// Open-Meteo's answer → the cells, in the order asked. One location answers
// with an object, several with a list of them, each with its own time zone and
// its days in it. A day the model has no figure for is null, not nought.
export function reshape(body, cells) {
  if (body && body.error) throw new Error(`Open-Meteo said: ${String(body.reason || 'an error').slice(0, 160)}`);
  const list = Array.isArray(body) ? body : body ? [body] : [];
  if (list.length !== cells.length) throw new Error(`Open-Meteo answered for ${list.length} places, not ${cells.length}`);
  return list.map((o, i) => {
    const d = o && o.daily;
    const days = d && Array.isArray(d.time) ? d.time : null;
    const mm = d && Array.isArray(d.precipitation_sum) ? d.precipitation_sum : null;
    if (!days || !mm || days.length !== mm.length || !days.every(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))) {
      throw new Error('Open-Meteo answered without a day-by-day rain figure');
    }
    return {
      at: cells[i],
      tz: typeof o.timezone === 'string' ? o.timezone.slice(0, 64) : 'UTC',
      days: days.slice(0, DAYS),
      mm: mm.slice(0, DAYS).map(v => (typeof v === 'number' && isFinite(v) ? Math.round(Math.max(0, v) * 10) / 10 : null)),
    };
  });
}

// ── Asking, and keeping the answer ──────────────────────────────────────────

async function ask(cells, env, deps) {
  const key = env && typeof env.OPEN_METEO_KEY === 'string' && env.OPEN_METEO_KEY.trim() ? env.OPEN_METEO_KEY.trim() : '';
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let res;
  try {
    res = await deps.fetch(upstreamUrl(cells, key), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (err) {
    throw new Error(err && err.name === 'AbortError' ? `Open-Meteo did not answer inside ${TIMEOUT_MS / 1000} s` : 'Open-Meteo could not be reached');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  if (!res.ok) {
    const why = body && body.reason ? `: ${String(body.reason).slice(0, 160)}` : '';
    throw new Error(`Open-Meteo answered HTTP ${res.status}${why}`);
  }
  return { cells: reshape(body, cells), fetchedMs: deps.now() };
}

function toCached(got) {
  return new Response(JSON.stringify(got.cells), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${KEEP_S}`,
      'X-Rain-Fetched-Ms': String(got.fetchedMs),
    },
  });
}

async function fromCached(res) {
  const fetchedMs = Number(res.headers.get('X-Rain-Fetched-Ms'));
  if (!isFinite(fetchedMs) || fetchedMs <= 0) return null;
  try {
    const cells = await res.json();
    return Array.isArray(cells) ? { cells, fetchedMs } : null;
  } catch (_) { return null; }
}

const inflight = new Map();
function once(key, job) {
  let p = inflight.get(key);
  if (!p) {
    p = job().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

function send(request, got, stale, deps) {
  const age = Math.max(0, Math.floor((deps.now() - got.fetchedMs) / 1000));
  const body = {
    model: MODEL, source: SOURCE, days: DAYS, grid: GRID,
    fetched: new Date(got.fetchedMs).toISOString(),
    stale: stale ? String(stale).slice(0, 200) : null,
    cells: got.cells,
  };
  const res = json(body, 200, { 'Cache-Control': stale ? 'no-store' : `public, max-age=${Math.max(0, FRESH_S - age)}` });
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res;
}

function defaults(deps) {
  return {
    fetch: deps.fetch || ((...a) => fetch(...a)),
    cache: deps.cache !== undefined ? deps.cache
      : (typeof caches !== 'undefined' && caches.default ? caches.default : null),
    now: deps.now || Date.now,
  };
}

// ── The route ────────────────────────────────────────────────────────────────

export async function handleRainAhead(request, env, ctx, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'GET only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  const d = defaults(deps);
  const url = new URL(request.url);
  const q = url.searchParams.get('cells');

  if (q == null) {
    return json({
      model: MODEL, source: SOURCE, days: DAYS, grid: GRID, cells_max: CELLS_MAX, area: AU,
      fresh_s: FRESH_S, keep_s: KEEP_S, doc: DOC_URL,
      ask: `${PREFIX}?cells=lat,lon;lat,lon… (at most ${CELLS_MAX}, snapped to ${GRID}°)`,
    }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  const parsed = parseCells(q);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const key = `${url.origin}${PREFIX}?cells=${parsed.cells.map(c => `${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(';')}`;

  let hit = null;
  if (d.cache) {
    try { hit = await d.cache.match(new Request(key)); } catch (_) { hit = null; }
  }
  const heldMs = hit ? Number(hit.headers.get('X-Rain-Fetched-Ms')) : NaN;
  if (hit && isFinite(heldMs) && (d.now() - heldMs) / 1000 < FRESH_S) {
    const held = await fromCached(hit);
    if (held) return send(request, held, null, d);
    hit = null;
  }
  try {
    const got = await once(key, async () => {
      const g = await ask(parsed.cells, env, d);
      if (d.cache) {
        const put = d.cache.put(new Request(key), toCached(g)).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
      }
      return g;
    });
    return send(request, got, null, d);
  } catch (err) {
    const held = hit && (d.now() - heldMs) / 1000 < KEEP_S ? await fromCached(hit) : null;
    if (held) return send(request, held, err.message, d);
    return json({ error: err.message, source: SOURCE }, 502);
  }
}

export const _test = { inflight };
