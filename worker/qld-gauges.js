// /api/qld-gauges — the latest river height at the Queensland Government's
// stream gauges, for the Stations map's State river gauges layer
// (map-feeds.js) and the "State river gauges" row on a station's card (#295).
//
//   GET /api/qld-gauges?sites=130105B,144003A   → { source, asOf, gauges: { "130105B": { m, at, tz } } }
//
// Why a route and not the browser asking the State: the State's Water
// Monitoring Information Portal sends no CORS header (the permission a browser
// wants before a page may read another site's answer) and refuses the browser's
// pre-check, so a page on floodwarning.net cannot read it. The Worker asks
// instead, and everybody shares one cached answer.
//
// What it asks: one fixed address, the portal's get_latest_ts_values call, for
// variable 100.00 (stage — the river height above the gauge's own zero) from the
// composite archive-and-telemetry source. The only caller input is the list of
// site numbers, each held to the State's pattern (digits then a letter), at
// most SITES_MAX a request, sorted and de-duplicated so the same set in any
// order is one cache entry. Read-only, public data (CC BY 4.0).
//
// What the number is: gauge height, metres above the gauge's own zero. Not AHD
// (the national sea-level datum), and the feed does not say where each gauge's
// zero sits, so these heights are never to be set beside Flood-Net's.
//
// Readings are logged and sent hourly (the State's guide), so an answer is kept
// FRESH_S in the edge cache; if the portal will not answer, the last good
// answer is served for up to KEEP_S, marked stale. CORS is open (`*`).

const PREFIX = '/api/qld-gauges';
export const DOC_URL = 'https://floodwarning.net/docs/agent-api.md';
export const UPSTREAM = 'https://water-monitoring.information.qld.gov.au/cgi/webservice.exe';
export const USER_AGENT = `Flood-Net river gauges (+${DOC_URL})`;
export const SITES_MAX = 100;
export const FRESH_S = 20 * 60;
export const KEEP_S = 6 * 60 * 60;
export const TIMEOUT_MS = 15000;
export const SOURCE = Object.freeze({
  by: 'State of Queensland (Water Monitoring Information Portal)',
  licence: 'CC BY 4.0',
  page: 'https://water-monitoring.information.qld.gov.au/',
  datum: 'Metres above the gauge’s own zero (gauge height), not AHD. Not comparable with Flood-Net’s heights.',
});

const SITE_RE = /^[0-9]{5,7}[A-Z]$/;
const TIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

export function isQldGaugesPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// The sites a query names — sorted, no repeats — or null when any is not a site.
export function parseSites(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(',');
  if (parts.length > SITES_MAX * 2) return null;
  const set = new Set();
  for (const p of parts) {
    if (!SITE_RE.test(p)) return null;
    set.add(p);
  }
  if (!set.size || set.size > SITES_MAX) return null;
  return [...set].sort();
}

// The State's "20261119060000" is local Queensland time, which is UTC+10 all year.
export function readingTime(s) {
  const m = TIME_RE.exec(String(s || ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+10:00`;
}

export function upstreamUrl(sites) {
  const call = { function: 'get_latest_ts_values', version: '2',
    params: { site_list: sites.join(','), datasource: 'AT', trace_list: [{ varfrom: '100.00', varto: '100.00' }] } };
  return `${UPSTREAM}?${JSON.stringify(call)}`;
}

// The portal's answer, cut to what we serve. A site it does not know, or has no
// reading for, is left out.
export function readGauges(json, sites) {
  const out = {};
  const ret = (json && json.return) || {};
  for (const site of sites) {
    const traces = ret[site];
    const v = Array.isArray(traces) && traces[0] && Array.isArray(traces[0].values) ? traces[0].values[0] : null;
    if (!v) continue;
    const m = Number(v.v), at = readingTime(v.time);
    if (!isFinite(m) || !at || v.v === '' || v.v === null) continue;
    out[site] = { m, at, tz: '+10:00' };
  }
  return out;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...OPEN, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export async function handleQldGauges(request, env, ctx, deps = {}) {
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  const now = deps.now ? deps.now() : Date.now();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'GET only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  }
  const url = new URL(request.url);
  if (url.pathname !== PREFIX) return json({ error: 'not an address: /api/qld-gauges?sites=<site numbers>' }, 404);
  const sites = parseSites(url.searchParams.get('sites'));
  if (!sites) {
    return json({ error: `sites: 1 to ${SITES_MAX} State gauge numbers, comma-separated, such as 130105B,144003A` }, 400);
  }

  const cache = deps.cache !== undefined ? deps.cache
    : (typeof caches !== 'undefined' && caches.default ? caches.default : null);
  const key = `https://floodwarning.net${PREFIX}?sites=${sites.join(',')}`;
  let kept = null;
  if (cache) {
    try {
      const hit = await cache.match(new Request(key));
      if (hit) kept = await hit.json();
    } catch (_) { kept = null; }
  }
  const age = kept ? (now - kept.fetchedAt) / 1000 : Infinity;
  const body = g => ({ source: SOURCE, asOf: new Date(g.fetchedAt).toISOString(), stale: g.stale || undefined, gauges: g.gauges });
  const ok = (g, cc) => new Response(request.method === 'HEAD' ? null : JSON.stringify(body(g)), {
    status: 200, headers: { ...OPEN, 'Content-Type': 'application/json', 'Cache-Control': cc } });
  if (kept && age < FRESH_S) return ok(kept, `public, max-age=${Math.max(60, Math.round(FRESH_S - age))}`);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs || TIMEOUT_MS);
  try {
    const res = await doFetch(upstreamUrl(sites), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, redirect: 'manual', signal: abort.signal });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j || j.error_num !== 0 || !j.return) throw new Error('the portal answered with an error');
    const fresh = { fetchedAt: now, gauges: readGauges(j, sites) };
    if (cache) {
      const put = cache.put(new Request(key), new Response(JSON.stringify(fresh), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${KEEP_S}` } })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
    return ok(fresh, `public, max-age=${FRESH_S}`);
  } catch (_) {
    if (kept && age < KEEP_S) return ok({ ...kept, stale: true }, 'public, max-age=60');
    return json({ error: 'the State’s Water Monitoring Information Portal did not answer' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
