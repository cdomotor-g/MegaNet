// worker/api.js — the read-only station API, and the MCP server, for agents.
//
// The owner's ask: "some kind of API or MCP so people can point their agents at
// our database in readonly mode to extract station level information" — useful
// for drafting assessment reports but not only for that — "with some throttling
// if possible to avoid ddos type lock ups". Two doors onto one set of handlers:
//
//   /api/v1/…   plain JSON over GET: curl, scripts, a spreadsheet, and any
//               function-calling agent (ChatGPT Actions, Gemini…) through the
//               OpenAPI document at /api/v1/openapi.json
//   /api/mcp    a Model Context Protocol server over Streamable HTTP: Claude
//               Code, Claude Desktop / claude.ai, Cursor, VS Code, Gemini CLI,
//               Codex and anything else that speaks MCP
//
// Every MCP tool is a thin adapter over a /api/v1 route, so both doors give the
// same answer, share one cache and one set of limits, and are documented once:
// docs/agent-api.md. AGENTS.md, GEMINI.md, .github/copilot-instructions.md,
// llms.txt and .cursor/rules/meganet-api.mdc tell agents it exists, and
// test/agent-docs.mjs holds all of them to the numbers written here.
//
// ── Read-only by construction ────────────────────────────────────────────────
// Nothing here can write, and not because a check says so. The only request
// this file ever sends upstream is a GET, to PostgREST, for a relation named in
// READABLE_RELATIONS, carrying the publishable key — the same key, and so the
// same row-level security, as a signed-out visitor to the app. Upstream headers
// are built from constants and never copied from the caller's request, so a
// caller's Authorization header, cookies and Access identity stop here. The API
// can therefore read exactly what `anon` can (docs/access.md, option (a)), and
// what the database withholds from `anon` — reading_raw, the inspection
// records, field photos, app_user, editor_allow, ingest tokens — is not
// reachable through it at any privilege. No RPC is called at all: the one
// read-only RPC anon has, stations_doc(), returns 7.5 MB and is exactly what an
// API per station exists to avoid.
//
// ── Throttling ───────────────────────────────────────────────────────────────
// Three rules, per RATE_LIMITS: a per-client minute, a per-client ten-second
// burst, and a per-address ceiling. A client is the caller's address plus the
// optional name it gives in X-MegaNet-Client (or ?client=), so colleagues
// behind one office NAT — or everyone using a hosted connector, which reaches
// us from the provider's addresses — are not one client; the address ceiling
// is what stops one caller minting names to dodge its own limit. Keys are
// hashed before they reach any limiter.
//
// Enforced by Cloudflare's rate limiting binding when wrangler.toml declares it
// ([[ratelimits]], wrangler ≥ 4.36): per Cloudflare location and eventually
// consistent — a brake, not a quota. Without the binding (tests, a local run, a
// deploy by an older wrangler, which drops the section with a warning) a small
// in-isolate sliding window stands in. X-RateLimit-Limiter says which answered.
// The binding runs inside the Worker, so it protects the database and its
// egress, not the Worker's own request allowance: the WAF rule in
// docs/agent-api.md ("For the owner") is what stops a flood before the Worker.
//
// Behind the limiter: every upstream call times out at 10 s, one request may
// make at most LIMITS.upstreamPerRequest of them and at most six at once, list
// sizes and reading windows are capped, and a 200 is cached for 60 s at the
// edge (caches.default, keyed by URL) so a burst of identical questions costs
// the database one answer.

// ── Where things are ─────────────────────────────────────────────────────────

export const API_VERSION = '1.0.0';
export const PUBLIC_ORIGIN = 'https://floodwarning.net';
export const API_PREFIX = '/api/v1';
export const MCP_PATH = '/api/mcp';
export const API_BASE_URL = `${PUBLIC_ORIGIN}${API_PREFIX}`;
export const MCP_URL = `${PUBLIC_ORIGIN}${MCP_PATH}`;
export const OPENAPI_URL = `${API_BASE_URL}/openapi.json`;
export const DOCS_URL = 'https://github.com/cdomotor-g/MegaNet/blob/main/docs/agent-api.md';
export const CLIENT_HEADER = 'X-MegaNet-Client';

// The project and its publishable key — both already public in core.js
// (DB_ORIGIN, DB_ANON_KEY) and worker/index.js; rotate them together. The key
// names the project and authorises nothing: RLS decides what it may read.
export const SUPABASE_REST_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1';
export const PUBLISHABLE_KEY = 'sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY';
const DB_SCHEMA = 'meganet';

export const DISCLAIMER =
  'MegaNet is not a flood warning service, and it does not issue warnings, forecasts or public alerts. '
  + 'It is engineering tooling for the radio networks that telemetry travels over — an asset register, a '
  + 'path planner and a fault-finding aid. Nothing here should be read as an official statement about '
  + 'flooding, river conditions or public safety. It is also not an official product of, and is not '
  + 'endorsed by, the Australian Bureau of Meteorology or any other agency. For official Australian flood '
  + 'warnings and river height data, go to the Bureau of Meteorology: http://www.bom.gov.au/australia/flood/';

// ── Limits ───────────────────────────────────────────────────────────────────
// Changing a number here changes what docs/agent-api.md and the agent files
// must say — test/agent-docs.mjs reads these and fails until they agree.

export const RATE_LIMITS = Object.freeze([
  Object.freeze({ name: 'client',  binding: 'API_RATE_LIMIT',  limit: 60,  period: 60, per: 'client'  }),
  Object.freeze({ name: 'burst',   binding: 'API_BURST_LIMIT', limit: 20,  period: 10, per: 'client'  }),
  Object.freeze({ name: 'address', binding: 'API_IP_LIMIT',    limit: 240, period: 60, per: 'address' }),
]);

export const LIMITS = Object.freeze({
  listDefault: 25,
  listMax: 100,
  offsetMax: 10000,
  radiusDefaultKm: 25,
  radiusMaxKm: 250,
  candidateMax: 5000,          // rows a filtered search may consider before paging
  qMinLength: 2,
  qMaxLength: 100,
  readingsDefault: 1000,
  readingsMax: 5000,
  windowMaxDays: Object.freeze({ raw: 7, hourly: 31, daily: 731 }),
  windowDefaultDays: Object.freeze({ raw: 1, hourly: 7, daily: 90 }),
  upstreamTimeoutMs: 10000,
  upstreamPerRequest: 32,
  upstreamParallel: 6,
  upstreamPageRows: 1000,      // Supabase's default max-rows; paging never trusts it
  responseMaxBytes: 2000000,
  cacheSeconds: 60,
  vocabularySeconds: 3600,
  mcpBodyMaxBytes: 65536,
  mcpBatchMax: 10,
});

// What may be read. Every relation here is granted to `anon` by a migration and
// listed in db/README.md as public; the list is the only way a relation name
// reaches the upstream URL, including as an embedded resource in `select`.
export const READABLE_RELATIONS = Object.freeze(new Set([
  'station', 'station_json', 'sensor', 'repeater', 'pass_range',
  'sls_location', 'sls_doc',
  'station_flood_class', 'station_crossing', 'station_gauge_survey',
  'station_bureau_listing', 'station_flood_effect', 'station_aep_level', 'station_frequency',
  'catchment', 'hub', 'radio_network', 'rm_system',
  'crossing_type', 'gauge_datum', 'bureau_index',
  'station_health',
  'reading', 'reading_hourly', 'reading_daily',
  'inspection_chart_visit', 'inspection_chart_power', 'inspection_chart_radio',
  'inspection_chart_gas', 'inspection_chart_water_level', 'inspection_chart_data',
  'inspection_chart_fade_margin',
  'link_fade_margin', 'app_meta',
]));

const PAUSE_HINT =
  'MegaNet\'s database is a Supabase free-tier project, which pauses after 7 days without activity; '
  + 'while it is paused every read fails until the owner restores it. Try again later, and if it '
  + 'persists, raise an issue at https://github.com/cdomotor-g/MegaNet/issues.';

// ── Small helpers ────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(status, error, detail, extra) {
    super(detail || error);
    this.status = status;
    this.error = error;
    this.detail = detail;
    this.extra = extra || null;
  }
}

const bad = (detail, extra) => new ApiError(400, 'bad request', detail, extra);

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const nonEmpty = a => Array.isArray(a) && a.length > 0;
const uniq = a => [...new Set(a)];

function stripNulls(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// Newest first by a date-ish field; undated last; stable otherwise. The card's
// rule (flood-stages.js), restated so the API and the app agree on "current".
function newestFirst(rows, field) {
  return (rows || []).map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r[field] || '', y = b.r[field] || '';
    if (x !== y) return x ? (y ? (x < y ? 1 : -1) : -1) : 1;
    return a.i - b.i;
  }).map(o => o.r);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad)
          - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];

function flattenAlertIds(alertIds) {
  const out = [];
  for (const v of Object.values(alertIds || {})) {
    for (const x of [].concat(v)) if (Number.isInteger(num(x))) out.push(num(x));
  }
  return uniq(out);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── PostgREST query building ─────────────────────────────────────────────────
// Values that reach a logic tree (`or=(…)`) are double-quoted, so a comma, a
// full stop or a bracket in a station name stays part of the value. Free text
// has its quotes, backslashes and wildcards removed before it gets here.

const pgQuote = v => `"${String(v).replace(/["\\]/g, '')}"`;
const pgArray = items => `{${items.map(pgQuote).join(',')}}`;
const pgList = items => `(${items.map(pgQuote).join(',')})`;

function buildQuery(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// One logic parameter for any number of OR-groups, ANDed together — one `or=`
// for one group, `and=(or(…),or(…))` for several — so nothing depends on how
// PostgREST treats a repeated `or` key.
function logicPair(groups) {
  const gs = groups.filter(g => g && g.length);
  if (!gs.length) return null;
  if (gs.length === 1) return ['or', `(${gs[0].join(',')})`];
  return ['and', `(${gs.map(g => `or(${g.join(',')})`).join(',')})`];
}

function assertReadable(relation, pairs) {
  if (!READABLE_RELATIONS.has(relation)) {
    throw new ApiError(500, 'internal error', `refusing to read ${relation}: it is not on the public read list`);
  }
  for (const [k, v] of pairs) {
    if (k !== 'select') continue;
    for (const m of String(v).matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:![A-Za-z_]+)?\(/g)) {
      if (!READABLE_RELATIONS.has(m[1])) {
        throw new ApiError(500, 'internal error', `refusing to embed ${m[1]}: it is not on the public read list`);
      }
    }
  }
}

function contentRangeTotal(header) {
  const m = /\/(\d+)\s*$/.exec(header || '');
  return m ? Number(m[1]) : null;
}

// ── The one way upstream ─────────────────────────────────────────────────────

class Upstream {
  constructor(rc) {
    this.rc = rc;
    this.calls = 0;
    this.active = 0;
    this.waiting = [];
  }

  async slot() {
    if (this.active >= LIMITS.upstreamParallel) await new Promise(resolve => this.waiting.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  // GET one relation. `count` asks PostgREST for the exact total (Content-Range);
  // `ttl` caches the upstream answer at the edge for that many seconds — used
  // for the vocabularies, which change with a migration, not with a station.
  async select(relation, pairs, { count = false, ttl = 0 } = {}) {
    assertReadable(relation, pairs);
    if (this.calls >= LIMITS.upstreamPerRequest) {
      throw new ApiError(503, 'request too broad',
        `Answering this needed more than ${LIMITS.upstreamPerRequest} database reads. Narrow the request.`);
    }
    this.calls++;
    const url = `${SUPABASE_REST_URL}/${relation}?${buildQuery(pairs)}`;
    const cache = ttl > 0 ? this.rc.cache : null;
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return { rows: JSON.parse(await hit.text()), total: contentRangeTotal(hit.headers.get('Content-Range')) };
      } catch (_) { /* a cache that cannot answer is a miss */ }
    }

    const headers = {
      apikey: PUBLISHABLE_KEY,
      'Accept-Profile': DB_SCHEMA,
      Accept: 'application/json',
    };
    if (count) headers.Prefer = 'count=exact';

    await this.slot();
    let res, text;
    try {
      res = await globalThis.fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ApiError(timedOut ? 504 : 502, timedOut ? 'database timeout' : 'database unreachable',
        `${timedOut ? `The database did not answer within ${LIMITS.upstreamTimeoutMs / 1000} s.`
                    : `The database could not be reached (${(err && err.message) || err}).`} ${PAUSE_HINT}`);
    } finally {
      this.release();
    }

    const range = res.headers.get('Content-Range');
    // PostgREST answers an offset past the end of a counted result with 416.
    // That is an empty page, not a failure.
    if (res.status === 416) return { rows: [], total: contentRangeTotal(range) };
    if (!res.ok) {
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
      const said = body && (body.message || body.hint)
        ? `${body.message || ''}${body.hint ? ` — ${body.hint}` : ''}${body.code ? ` (${body.code})` : ''}`
        : `HTTP ${res.status}`;
      if (res.status >= 500) {
        throw new ApiError(503, 'database unavailable', `The database answered ${said}. ${PAUSE_HINT}`);
      }
      throw new ApiError(502, 'database refused the query',
        `The database refused a query this API built: ${said}. That is a bug in the API or a schema change it `
        + 'has not caught up with — please raise an issue at https://github.com/cdomotor-g/MegaNet/issues.');
    }
    let rows;
    try { rows = JSON.parse(text); } catch (_) { rows = null; }
    if (!Array.isArray(rows)) {
      throw new ApiError(502, 'database answered unexpectedly', `Expected a JSON array from ${relation}. ${PAUSE_HINT}`);
    }
    if (cache) {
      const put = cache.put(url, new Response(text, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
          ...(range ? { 'Content-Range': range } : {}),
        },
      }));
      this.rc.waitUntil(put);
    }
    return { rows, total: contentRangeTotal(range) };
  }

  // Every row of a filtered read, a page at a time, trusting the counted total
  // rather than a short page — the server's max-rows is not ours to assume.
  async selectAll(relation, pairs, cap, { ttl = 0 } = {}) {
    const rows = [];
    let total = null;
    for (let page = 0; ; page++) {
      const got = await this.select(relation,
        [...pairs, ['limit', LIMITS.upstreamPageRows], ['offset', rows.length]], { count: page === 0, ttl });
      if (page === 0) total = got.total;
      rows.push(...got.rows);
      if (!got.rows.length) break;
      if (total != null ? rows.length >= total : got.rows.length < LIMITS.upstreamPageRows) break;
      if (rows.length >= cap) break;
    }
    const truncated = rows.length > cap || (total != null && total > Math.min(rows.length, cap));
    return { rows: rows.slice(0, cap), total, truncated };
  }
}

// In-isolate memory for the vocabularies and the SLS gauge list: settled values
// only, never an in-flight promise, because a Worker may not finish I/O on
// behalf of another request.
const MEMO = new Map();
async function memo(key, ttlMs, load) {
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  MEMO.set(key, { at: Date.now(), value });
  return value;
}

// For the tests: a fresh isolate, as far as this module's memory goes.
export function resetApiState() {
  MEMO.clear();
  WINDOWS.clear();
}

const VOCAB_MS = LIMITS.vocabularySeconds * 1000;
const vocabRead = (rc, relation, select, order = 'ord.asc') => memo(`vocab:${relation}`, VOCAB_MS, async () =>
  (await rc.up.select(relation, [['select', select], ['order', order]], { ttl: LIMITS.vocabularySeconds })).rows);

const catchmentsOf = rc => vocabRead(rc, 'catchment', 'id,name,basin_no,area_sqkm,region,division,division_no,border');
const hubsOf = rc => vocabRead(rc, 'hub', 'id,name,area_sqkm');
const networksOf = rc => vocabRead(rc, 'radio_network', 'id,name,description');
const rmSystemsOf = rc => vocabRead(rc, 'rm_system',
  'id,name,tx_power_w,line_loss_db,supp_loss_db_m,antenna_type,antenna_gain_dbi,antenna_height_m,rx_threshold_dbm');
const crossingTypesOf = rc => vocabRead(rc, 'crossing_type', 'code,label,meaning');
const datumsOf = rc => vocabRead(rc, 'gauge_datum', 'code,label');
const bureauIndexOf = rc => vocabRead(rc, 'bureau_index', 'code,label,title');
// Every Service Level Specification the database holds, one row per state.
// `*`, and a row with no jurisdiction read as Queensland's, so this answers the
// same before 0038 has reached the database (one document, no such column) as
// after it — the Worker deploys on push, the migration when someone applies it.
const slsDocsOf = rc => memo('vocab:sls_doc', VOCAB_MS, async () =>
  bySlsDoc((await rc.up.select('sls_doc', [['select', '*']], { ttl: LIMITS.vocabularySeconds })).rows
    .map(r => ({ ...r, jurisdiction: r.jurisdiction || 'QLD' }))));

const byKey = (rows, key = 'id') => new Map((rows || []).map(r => [r[key], r]));

// A failed read becomes a value rather than a thrown error, so one unavailable
// section cannot sink a dossier that has everything else.
async function settle(p) {
  try { return { ok: true, value: await p }; } catch (err) { return { ok: false, error: err }; }
}

const unavailable = (err, source) => ({
  status: 'unavailable',
  detail: (err && (err.detail || err.message)) || 'The database did not answer.',
  ...(source ? { source } : {}),
});

// ── Station ids, kinds and the compact row ───────────────────────────────────

const STATION_ID_RE = /^[a-z0-9_.-]{1,64}$/;
const RIVER_LOCATION_TYPES = ['Water Level', 'Tide', 'Tide Gauge', 'Reservoir'];

// What sort of station this is, from the station's own record: ALERT addresses
// by kind, the location types the Bureau's sheets gave it, the stream the river
// height list reads it on, and its roles. The same rule filters `type=`, so a
// row always shows the kinds that found it. (ARRO sensor types are listed
// beside it, as telemetry.sensor_types, and are not part of the rule: only 25
// river and 249 rain stations are known by a sensor type alone.)
export function stationKinds(r) {
  const roles = r.roles || [], lt = r.location_types || [], a = r.alert_ids || {};
  const kinds = [];
  if (lt.includes('Rain Gauge') || a.rainfall != null) kinds.push('rain');
  if (lt.some(t => RIVER_LOCATION_TYPES.includes(t)) || a.water_level != null
      || (r.stream != null && r.stream !== '')) kinds.push('river');
  if (roles.includes('repeater')) kinds.push('repeater');
  if (roles.includes('base')) kinds.push('base');
  return kinds;
}

const TYPE_TERMS = {
  rain: [`location_types.cs.${pgArray(['Rain Gauge'])}`, 'alert_ids->rainfall.not.is.null'],
  river: [`location_types.ov.${pgArray(RIVER_LOCATION_TYPES)}`, 'alert_ids->water_level.not.is.null',
          'stream.not.is.null'],
};

const COMPACT_SELECT = [
  'id', 'name', 'station_number', 'lat', 'lon', 'elevation_ahd', 'elevation_source', 'roles',
  'radio_network_ids', 'catchment_ids', 'hub_id', 'basin', 'lga', 'stream', 'awrc_number',
  'location_types', 'alert_ids', 'satcom', 'enabled', 'proposed', 'station_type', 'proposed_year',
  'sensor(type,alert_id)', 'station_flood_class(ord)', 'station_aep_level(ord)',
  'station_crossing(ord)', 'station_gauge_survey(ord)', 'station_flood_effect(ord)',
].join(',');

const elevationBasis = (ahd, source) => (ahd == null ? null : (source ? `modelled — ${source}` : 'surveyed'));

// ── The Service Level Specifications ─────────────────────────────────────────
// One per state the network reaches — Queensland's, and the one for New South
// Wales and the ACT (0038) — and each is its own document: a station on the
// border has an entry in each, they can disagree (GOONDIWINDI's major level is
// 9.2 m in one and 8.5 m in the other), and they are given side by side, never
// merged. What each numbers its schedules is here for a database that has not
// said (sls_doc.schedules arrives with 0038).
const SLS_DOCS = {
  QLD: { place: 'Queensland', url: 'https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf',
         schedules: { forecast_location: '2', information_location: '3', river_data_location: '4',
                      bureau_owned: '7', bureau_assists: '8', bureau_colocated: '9' } },
  NSW: { place: 'New South Wales and the Australian Capital Territory', url: 'https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf',
         schedules: { forecast_location: '2', information_location: '3a', river_data_location: '4',
                      bureau_owned: '6', bureau_assists: '7', bureau_colocated: '8' } },
};
const SLS_DOC_ORDER = ['QLD', 'NSW'];
const slsDocRank = j => { const i = SLS_DOC_ORDER.indexOf(j || 'QLD'); return i < 0 ? SLS_DOC_ORDER.length : i; };
const bySlsDoc = rows => [...rows].sort((a, b) => slsDocRank(a.jurisdiction) - slsDocRank(b.jurisdiction));

const SLS_ROLES = [
  ['forecast_location', 'forecast location'],
  ['information_location', 'information location'],
  ['river_data_location', 'river data location'],
  ['bureau_owned', 'Bureau-owned'],
  ['bureau_assists', 'Bureau assists'],
  ['bureau_colocated', 'Bureau co-located'],
];

// The entry to quote first where a station has two — the more specific
// statement of service, then Queensland's — the rule sls.js puts first on the
// card, so a compact row and the card agree about which one they mean.
function slsRank(r) {
  const i = SLS_ROLES.findIndex(([k]) => r[k]);
  return (i < 0 ? SLS_ROLES.length : i) * 10 + slsDocRank(r.jurisdiction);
}
const bySlsRank = rows => [...(rows || [])].sort((a, b) => slsRank(a) - slsRank(b));

function compactRow(r, { sls, health, catchments, from } = {}) {
  const sensors = Array.isArray(r.sensor) ? r.sensor : [];
  const out = {
    id: r.id,
    name: r.name,
    station_number: r.station_number || null,
    lat: num(r.lat),
    lon: num(r.lon),
    elevation_ahd_m: num(r.elevation_ahd),
    elevation_source: elevationBasis(num(r.elevation_ahd), r.elevation_source),
    roles: r.roles || [],
    kinds: stationKinds(r),
    catchments: (r.catchment_ids || []).map(id => ({ id, name: (catchments && catchments.get(id)?.name) || null })),
    basin: r.basin || null,
    stream: r.stream || null,
    lga: r.lga || null,
    hub_id: r.hub_id || null,
    radio_network_ids: r.radio_network_ids || [],
    awrc_number: r.awrc_number || null,
    enabled: r.enabled !== false,
    // Only proposed — where a station is meant to go, not yet built or
    // numbered — and what kind it is or is to be, and the year it is proposed
    // for (0039). False, null and null on a station that never was a proposal.
    proposed: r.proposed === true,
    station_type: r.station_type || null,
    proposed_year: num(r.proposed_year),
    telemetry: {
      alert_ids: r.alert_ids || {},
      sensor_types: uniq(sensors.map(s => s.type).filter(Boolean)),
      satcom: !!(r.satcom && r.satcom.enabled),
      last_seen_at: (health && health.last_seen_at) || null,
      last_reading_at: (health && health.last_reading_at) || null,
    },
    sls: sls ? stripNulls({
      gauge_type: sls.gauge_type, data_type: sls.data_type, priority: sls.priority, owner: sls.owner,
      jurisdiction: sls.jurisdiction || 'QLD',
    }) : null,
    has: {
      flood_classes: nonEmpty(r.station_flood_class),
      aep_levels: nonEmpty(r.station_aep_level),
      crossings: nonEmpty(r.station_crossing),
      gauge_survey: nonEmpty(r.station_gauge_survey),
      flood_effects: nonEmpty(r.station_flood_effect),
      sls: !!sls,
    },
  };
  if (from && out.lat != null && out.lon != null) {
    const b = bearingDeg(from.lat, from.lon, out.lat, out.lon);
    out.distance_km = round(haversineKm(from.lat, from.lon, out.lat, out.lon), 2);
    out.bearing_deg = Math.round(b);
    out.direction = compass(b);
  }
  return out;
}

function normaliseStationId(raw) {
  const id = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!STATION_ID_RE.test(id)) {
    throw bad(`"${String(raw).slice(0, 80)}" is not a station id. Station ids are lowercase slugs such as `
      + '"abergowrie_br_al"; a Bureau station number also works. Find one with GET /api/v1/stations?q=<name or number>.');
  }
  return id;
}

// The station's document (meganet.station_json — live stations only). An id
// that is all digits and names no station is tried as a Bureau number, because
// that is what a report usually has in hand.
async function loadStationDoc(rc, rawId) {
  const id = normaliseStationId(rawId);
  const read = async sid => (await rc.up.select('station_json',
    [['select', 'id,updated_at,doc'], ['id', `eq.${sid}`]])).rows[0] || null;
  const row = await read(id);
  if (row) return { id: row.id, updated_at: row.updated_at, doc: row.doc || {}, resolved_from: null };

  if (/^\d{1,7}$/.test(id)) {
    const stripped = id.replace(/^0+/, '') || '0';
    const { rows: hits } = await rc.up.select('station', [
      ['select', 'id,name'], ['deleted_at', 'is.null'], ['station_number', `eq.${stripped}`], ['limit', 10]]);
    if (hits.length === 1) {
      const again = await read(hits[0].id);
      if (again) return { id: again.id, updated_at: again.updated_at, doc: again.doc || {}, resolved_from: `station number ${id}` };
    }
    if (hits.length > 1) {
      throw new ApiError(404, 'ambiguous station number',
        `${hits.length} live stations carry station number ${stripped}; ask for one of them by id.`,
        { candidates: hits.map(h => ({ id: h.id, name: h.name })) });
    }
  }
  throw stationNotFound(id);
}

const stationNotFound = id => new ApiError(404, 'station not found',
  `No live station has the id "${id}". Station ids are lowercase slugs such as "abergowrie_br_al"; `
  + 'find one with GET /api/v1/stations?q=<name or number>.');

// The same resolution against the station table, for a route that needs only a
// few columns of it rather than the whole document.
async function resolveStationRow(rc, rawId, select) {
  const id = normaliseStationId(rawId);
  const read = async (col, val) => (await rc.up.select('station',
    [['select', select], [col, `eq.${val}`], ['deleted_at', 'is.null'], ['limit', 10]])).rows;
  const rows = await read('id', id);
  if (rows.length) return { row: rows[0], resolved_from: null };
  if (/^\d{1,7}$/.test(id)) {
    const stripped = id.replace(/^0+/, '') || '0';
    const hits = await read('station_number', stripped);
    if (hits.length === 1) return { row: hits[0], resolved_from: `station number ${id}` };
    if (hits.length > 1) {
      throw new ApiError(404, 'ambiguous station number',
        `${hits.length} live stations carry station number ${stripped}; ask for one of them by id.`,
        { candidates: hits.map(h => ({ id: h.id, name: h.name })) });
    }
  }
  throw stationNotFound(id);
}

// ── Parameters ───────────────────────────────────────────────────────────────

function allowParams(params, allowed) {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      throw bad(`Unknown parameter "${k}" for this endpoint.${allowed.length ? ` Accepted: ${allowed.join(', ')}.` : ' It takes none.'}`);
    }
  }
  return params;
}

function cleanText(v, name, max = LIMITS.qMaxLength) {
  if (v === undefined) return undefined;
  const s = String(v).replace(/[\u0000-\u001f"\\*%]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw bad(`"${name}" is empty.`);
  if (s.length > max) throw bad(`"${name}" is longer than ${max} characters.`);
  return s;
}

function parseIntParam(v, name, { min, max, dflt, clampMax = false }, notes) {
  if (v === undefined || v === '') return dflt;
  if (!/^-?\d+$/.test(String(v).trim())) throw bad(`"${name}" must be a whole number.`);
  let n = Number(v);
  if (n < min) throw bad(`"${name}" must be at least ${min}.`);
  if (n > max) {
    if (!clampMax) throw bad(`"${name}" must be at most ${max}.`);
    if (notes) notes.push(`${name}=${n} is above the maximum of ${max}; ${max} was used.`);
    n = max;
  }
  return n;
}

function parseFloatParam(v, name, min, max) {
  const n = Number(String(v).trim());
  if (String(v).trim() === '' || !Number.isFinite(n)) throw bad(`"${name}" must be a number.`);
  if (n < min || n > max) throw bad(`"${name}" must be between ${min} and ${max}.`);
  return n;
}

function parseBool(v, name) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  throw bad(`"${name}" must be true or false.`);
}

function parseEnum(v, name, values) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!values.includes(s)) throw bad(`"${name}" must be one of: ${values.join(', ')}.`);
  return s;
}

function parseSlug(v, name) {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(s)) throw bad(`"${name}" must be an id such as "brisbane" — see GET /api/v1/networks.`);
  return s;
}

// ── GET /api/v1/stations ─────────────────────────────────────────────────────

export const STATION_LIST_PARAMS = ['q', 'near', 'radius_km', 'basin', 'catchment', 'lga', 'hub', 'network',
  'role', 'type', 'manual', 'limit', 'offset'];

function parseStationFilters(params, notes) {
  const f = {};
  f.q = cleanText(params.q, 'q');
  if (f.q !== undefined && f.q.length < LIMITS.qMinLength && !/^\d+$/.test(f.q)) {
    throw bad(`"q" needs at least ${LIMITS.qMinLength} characters (a number may be shorter).`);
  }
  if (params.near !== undefined) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(params.near));
    if (!m) throw bad('"near" must be "lat,lon" in decimal degrees, e.g. near=-27.47,153.03.');
    f.near = { lat: parseFloatParam(m[1], 'near latitude', -90, 90), lon: parseFloatParam(m[2], 'near longitude', -180, 180) };
    f.radiusKm = params.radius_km === undefined ? LIMITS.radiusDefaultKm
      : parseFloatParam(params.radius_km, 'radius_km', 0.01, LIMITS.radiusMaxKm);
  } else if (params.radius_km !== undefined) {
    throw bad('"radius_km" only means something with "near=lat,lon".');
  }
  f.basin = cleanText(params.basin, 'basin');
  f.catchment = cleanText(params.catchment, 'catchment');
  f.lga = cleanText(params.lga, 'lga');
  f.hub = parseSlug(params.hub, 'hub');
  f.network = parseSlug(params.network, 'network');
  f.role = parseEnum(params.role, 'role', ['field', 'repeater', 'base']);
  f.type = parseEnum(params.type, 'type', ['rain', 'river', 'repeater', 'base']);
  f.manual = parseBool(params.manual, 'manual');
  f.limit = parseIntParam(params.limit, 'limit', { min: 1, max: LIMITS.listMax, dflt: LIMITS.listDefault, clampMax: true }, notes);
  f.offset = parseIntParam(params.offset, 'offset', { min: 0, max: LIMITS.offsetMax, dflt: 0 });
  return f;
}

function resolveCatchments(cats, want) {
  const w = want.toLowerCase().replace(/\s+/g, ' ');
  const exact = cats.filter(c => c.id === w.replace(/ /g, '_') || (c.name || '').toLowerCase() === w);
  if (exact.length) return exact.map(c => c.id);
  return cats.filter(c => (c.name || '').toLowerCase().includes(w)).map(c => c.id);
}

async function qTerms(rc, q) {
  const words = q.split(' ').filter(Boolean).slice(0, 6);
  const ilike = (col, w) => `${col}.ilike.${pgQuote(`*${w}*`)}`;
  const terms = [
    words.length === 1 ? ilike('name', words[0]) : `and(${words.map(w => ilike('name', w)).join(',')})`,
    ilike('id', words.join('_').toLowerCase()),
  ];
  if (words.length === 1) terms.push(ilike('station_number', words[0]), ilike('awrc_number', words[0]));
  const alertIds = new Set();
  if (/^\d{1,7}$/.test(q)) {
    terms.push(`station_number.eq.${pgQuote(q.replace(/^0+/, '') || '0')}`);
    const n = Number(q);
    if (n >= 1 && n <= 65535) {
      const { rows } = await rc.up.select('sensor', [['select', 'station_id'], ['alert_id', `eq.${n}`], ['limit', 100]]);
      for (const r of rows) alertIds.add(r.station_id);
      if (alertIds.size) terms.push(`id.in.${pgList([...alertIds])}`);
    }
  }
  return { terms, alertIds };
}

// How well a row answers q, for ordering a search by relevance: the exact
// identities first, then a name that starts with it, then one that contains it.
// Built once per request: a broad q ranks a couple of thousand candidates.
function qScorer(q, alertIds) {
  const Q = q.toLowerCase();
  const slug = Q.replace(/ /g, '_');
  const words = Q.split(' ');
  const stripped = /^\d+$/.test(q) ? (q.replace(/^0+/, '') || '0') : null;
  const wordStart = new RegExp(`(^|[^a-z0-9])${Q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return r => {
    if (r.id === Q || r.id === slug) return 100;
    if (stripped && r.station_number === stripped) return 95;
    if (alertIds.has(r.id)) return 90;
    const name = (r.name || '').toLowerCase();
    if (name === Q) return 85;
    if (name.startsWith(Q)) return 70;
    if (wordStart.test(name)) return 60;
    if (name.includes(Q)) return 50;
    if (words.length > 1 && words.every(w => name.includes(w))) return 45;
    if ((r.awrc_number || '').toLowerCase() === Q) return 40;
    return 10;
  };
}

function stationFilterPairs(f) {
  const pairs = [['deleted_at', 'is.null']];
  if (f.catchmentIds) pairs.push(['catchment_ids', `ov.${pgArray(f.catchmentIds)}`]);
  if (f.basin) pairs.push(['basin', `ilike.*${f.basin}*`]);
  if (f.lga) pairs.push(['lga', `ilike.*${f.lga}*`]);
  if (f.hub) pairs.push(['hub_id', `eq.${f.hub}`]);
  if (f.network) pairs.push(['radio_network_ids', `cs.${pgArray([f.network])}`]);
  if (f.role) pairs.push(['roles', `cs.${pgArray([f.role])}`]);
  if (f.type === 'repeater' || f.type === 'base') pairs.push(['roles', `cs.${pgArray([f.type])}`]);
  if (f.near) {
    const dLat = f.radiusKm / 111.32;
    const dLon = f.radiusKm / (111.32 * Math.max(0.01, Math.cos(f.near.lat * Math.PI / 180)));
    pairs.push(['lat', `gte.${round(f.near.lat - dLat, 6)}`], ['lat', `lte.${round(f.near.lat + dLat, 6)}`],
               ['lon', `gte.${round(f.near.lon - dLon, 6)}`], ['lon', `lte.${round(f.near.lon + dLon, 6)}`]);
  }
  return pairs;
}

// The stations the SLS calls Manual (or Automatic), by name, for `manual=`: one
// read of the merged view, just the ids, remembered for ten minutes in the
// isolate and at the edge — the document changes by edition, not by the hour.
// With no other filter this list *is* the answer, and the station table is not
// scanned at all; with one, it is what the candidates are checked against.
const slsStations = (rc, manual) => memo(`sls:${manual ? 'Manual' : 'Automatic'}`, 600000, async () => {
  const { rows } = await rc.up.selectAll('sls_location',
    [['select', 'station_id,station_name'], ['gauge_type', `eq.${manual ? 'Manual' : 'Automatic'}`],
      ['station_id', 'not.is.null'], ['order', 'station_name.asc,station_id.asc']],
    LIMITS.candidateMax, { ttl: 600 });
  const seen = new Set();
  return rows.filter(r => !seen.has(r.station_id) && seen.add(r.station_id)).map(r => r.station_id);
});

// The SLS row, health row and catchment names for one page of stations.
async function decorate(rc, rows, from, notes) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const [sls, health, cats] = await Promise.all([
    // `*` rather than a list, for slsDocsOf's reason: the columns that say
    // whose entry it is arrive with 0038.
    settle(rc.up.select('sls_location', [['select', '*'], ['station_id', `in.${pgList(ids)}`]])),
    settle(rc.up.select('station_health', [['select', 'station_id,online,last_seen_at,last_reading_at'],
      ['station_id', `in.${pgList(ids)}`], ['order', 'last_seen_at.desc.nullslast']])),
    settle(catchmentsOf(rc)),
  ]);
  if (!sls.ok) notes.push('The SLS could not be read just now; "sls" is null on every row.');
  if (!health.ok) notes.push('Station health could not be read just now; last_seen_at is null on every row.');
  const slsBy = new Map(), healthBy = new Map();
  if (sls.ok) for (const r of bySlsRank(sls.value.rows)) if (!slsBy.has(r.station_id)) slsBy.set(r.station_id, r);
  if (health.ok) for (const r of health.value.rows) if (!healthBy.has(r.station_id)) healthBy.set(r.station_id, r);
  const catMap = cats.ok ? byKey(cats.value) : null;
  return rows.map(r => compactRow(r, { sls: slsBy.get(r.id), health: healthBy.get(r.id), catchments: catMap, from }));
}

function pageLink(rc, path, params, offset) {
  const u = new URL(`${rc.origin}${API_PREFIX}${path}`);
  for (const [k, v] of Object.entries(params)) if (k !== 'offset' && v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set('offset', String(offset));
  return u.toString();
}

async function listStations(rc, params, { catchmentIds, path = '/stations' } = {}) {
  const notes = [];
  const f = parseStationFilters(params, notes);
  const echo = stripNulls({
    q: f.q, near: f.near ? `${f.near.lat},${f.near.lon}` : undefined, radius_km: f.near ? f.radiusKm : undefined,
    basin: f.basin, catchment: f.catchment, lga: f.lga, hub: f.hub, network: f.network, role: f.role, type: f.type,
    manual: f.manual, limit: f.limit, offset: f.offset,
  });
  const empty = note => ({
    count: 0, total: 0, total_exact: true, limit: f.limit, offset: f.offset, next: null,
    query: echo, stations: [], notes: [...notes, note], generated_at: new Date().toISOString(),
  });

  if (catchmentIds) {
    f.catchmentIds = catchmentIds;
  } else if (f.catchment) {
    f.catchmentIds = resolveCatchments(await catchmentsOf(rc), f.catchment);
    if (!f.catchmentIds.length) return empty(`No catchment matches "${f.catchment}"; GET /api/v1/catchments lists them.`);
  }

  const pairs = stationFilterPairs(f);
  const groups = [];
  let alertIds = new Set();
  if (f.q) {
    const qt = await qTerms(rc, f.q);
    groups.push(qt.terms);
    alertIds = qt.alertIds;
  }
  if (f.type === 'rain' || f.type === 'river') groups.push(TYPE_TERMS[f.type]);
  const logic = logicPair(groups);
  if (logic) pairs.push(logic);

  let pageRows, total, totalExact = true;
  const refine = !!(f.near || f.q || f.manual !== undefined);
  const manualWord = f.manual ? 'Manual' : 'Automatic';
  const manualNote = `manual=${f.manual} keeps stations the Service Level Specification lists as ${manualWord}; stations the SLS does not list match neither.`;

  if (f.manual !== undefined && pairs.length === 1 && !logic && !f.near) {
    // manual= and nothing else: the SLS's own list, already by name, is the answer.
    const ids = await slsStations(rc, f.manual);
    total = ids.length;
    const page = ids.slice(f.offset, f.offset + f.limit);
    if (page.length) {
      const got = await rc.up.select('station', [['select', COMPACT_SELECT], ['id', `in.${pgList(page)}`]]);
      const byId = byKey(got.rows);
      pageRows = page.map(id => byId.get(id)).filter(Boolean);
    } else {
      pageRows = [];
    }
    notes.push(manualNote);
  } else if (!refine) {
    // Everything pushed down: PostgREST filters, orders, counts and pages.
    const got = await rc.up.select('station',
      [['select', COMPACT_SELECT], ...pairs, ['order', 'name.asc,id.asc'], ['limit', f.limit], ['offset', f.offset]],
      { count: true });
    pageRows = got.rows;
    total = got.total;
  } else {
    // Filter upstream, then rank, measure and page here: relevance for q,
    // great-circle distance for near, and the SLS's own word for manual. Only
    // the columns the ranking reads: this is the one read that can be wide.
    const candCols = f.near ? 'id,lat,lon' : (f.q ? 'id,name,station_number,awrc_number' : 'id,name');
    const cand = await rc.up.selectAll('station',
      [['select', candCols], ...pairs, ['order', 'id.asc']], LIMITS.candidateMax);
    let rows = cand.rows;
    if (cand.truncated) {
      totalExact = false;
      notes.push(`More than ${LIMITS.candidateMax} stations matched before ranking; narrow the search (add q, type, catchment or a smaller radius).`);
    }
    if (f.manual !== undefined) {
      const keep = new Set(await slsStations(rc, f.manual));
      rows = rows.filter(r => keep.has(r.id));
      notes.push(manualNote);
    }
    if (f.near) {
      rows = rows
        .filter(r => num(r.lat) != null && num(r.lon) != null)
        .map(r => ({ r, d: haversineKm(f.near.lat, f.near.lon, num(r.lat), num(r.lon)) }))
        .filter(o => o.d <= f.radiusKm)
        .sort((a, b) => a.d - b.d || (a.r.id < b.r.id ? -1 : 1))
        .map(o => o.r);
    } else {
      // A precomputed key and plain comparisons rather than localeCompare: a
      // broad q ranks a couple of thousand names, and the order should not
      // depend on the runtime's locale.
      const score = f.q ? qScorer(f.q, alertIds) : () => 0;
      rows = rows.map(r => ({ r, s: score(r), k: String(r.name || '').toLowerCase() }))
        .sort((a, b) => b.s - a.s || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) || (a.r.id < b.r.id ? -1 : 1))
        .map(o => o.r);
    }
    total = rows.length;
    const page = rows.slice(f.offset, f.offset + f.limit);
    if (page.length) {
      const got = await rc.up.select('station', [['select', COMPACT_SELECT], ['id', `in.${pgList(page.map(r => r.id))}`]]);
      const byId = byKey(got.rows);
      pageRows = page.map(r => byId.get(r.id)).filter(Boolean);
    } else {
      pageRows = [];
    }
  }

  const stations = await decorate(rc, pageRows, f.near, notes);
  const nextOffset = f.offset + stations.length;
  const more = total != null ? nextOffset < total : stations.length === f.limit;
  if (f.near) notes.push(`Sorted by great-circle distance from ${f.near.lat},${f.near.lon}; radius ${f.radiusKm} km.`);
  else if (f.q) notes.push('Sorted by relevance to q: exact id, Bureau number and ALERT address first, then name.');
  return {
    count: stations.length,
    total: total ?? null,
    total_exact: totalExact && total != null,
    limit: f.limit,
    offset: f.offset,
    next: stations.length && more ? pageLink(rc, path, echoToParams(echo, params), nextOffset) : null,
    query: echo,
    stations,
    notes,
    generated_at: new Date().toISOString(),
  };
}

function echoToParams(echo, raw) {
  const out = {};
  for (const k of STATION_LIST_PARAMS) if (raw[k] !== undefined) out[k] = raw[k];
  if (echo.limit !== undefined) out.limit = String(echo.limit);
  return out;
}

// ── GET /api/v1/stations/{id} ────────────────────────────────────────────────

// A station's entries, the one to quote first first.
async function slsRowsFor(rc, id) {
  return bySlsRank((await rc.up.select('sls_location', [['select', '*'], ['station_id', `eq.${id}`],
    ['order', 'bureau_number.asc']])).rows);
}

async function healthRowsFor(rc, id) {
  return (await rc.up.select('station_health', [['select',
    'station_key,station_id,online,since,last_seen_at,last_reading_at,minutes_since_seen,minutes_since_reading,last_status,reported_by'],
    ['station_id', `eq.${id}`], ['order', 'last_seen_at.desc.nullslast']])).rows;
}

async function stationDetail(rc, rawId) {
  const st = await loadStationDoc(rc, rawId);
  const [sls, health] = await Promise.all([settle(slsRowsFor(rc, st.id)), settle(healthRowsFor(rc, st.id))]);
  return {
    id: st.id,
    ...(st.resolved_from ? { resolved_from: st.resolved_from } : {}),
    updated_at: st.updated_at,
    station: st.doc,
    sls: sls.ok ? sls.value : unavailable(sls.error),
    health: health.ok ? (health.value[0] || null) : unavailable(health.error),
    links: stationLinks(rc, st.id),
    sources: [
      { relation: 'meganet.station_json', what: 'the station register record (the stations.json fragment)', updated_at: st.updated_at },
      { relation: 'meganet.sls_location', what: 'the Bureau\'s Service Level Specifications — Queensland\'s, and the one for New South Wales and the ACT — each merged per Bureau number' },
      { relation: 'meganet.station_health', what: 'when MegaNet last heard from the station itself' },
    ],
    generated_at: new Date().toISOString(),
  };
}

function stationLinks(rc, id) {
  const base = `${rc.origin}${API_PREFIX}/stations/${encodeURIComponent(id)}`;
  return {
    station: base,
    dossier: `${base}/dossier`,
    readings: `${base}/readings`,
    flood_levels: `${base}/flood-levels`,
    service_level: `${base}/service-level`,
    app: `${rc.origin}/?station=${encodeURIComponent(id)}`,
  };
}

// ── Flood levels: the Bureau's classes, the SLS's, AEP levels, one ladder ────
// Two datums, and the caveats are the point. Flood classes, crossing heights
// and flood effects are metres ON THE GAUGE; AEP levels are modelled metres
// AHD. A class is put in AHD only by the gauge zero in force, and only where
// that zero was surveyed in AHD — flood-stages.js's rule, and its reasoning.

const FLOOD_CAVEATS = [
  'Flood classes, crossing heights and flood effects are metres on the station\'s gauge (above its zero), not AHD.',
  'An AHD equivalent is given only where the gauge zero in force was surveyed in AHD (zero + height). A zero on an assumed, State or unknown datum cannot be put on the ground.',
  'AEP levels are modelled water levels in metres AHD from the QLD/NSW AEP level workbooks, at the sheet\'s own point — indicative, not observed. confidence runs 1–9 (data_quality × level_difference); higher is better.',
  'The SLS\'s flood classes are the Service Level Specifications\' own figures — Queensland\'s, and the one for New South Wales and the ACT, each row naming its document. They can differ from the Bureau\'s station lists and from each other; all are given, each with its edition.',
  'Where the NSW document says a gauge reads AHD (gauge_datum), its SLS classes are metres AHD as well as metres on the gauge; where it says Local, they are metres on the gauge only. not_yet_defined lists classes the NSW SES has not set.',
  'Levels from different sources can disagree; say which one a report quotes.',
];

const AEP_LEVELS = [
  { key: 'aep_1_m', label: '1% AEP', one_in: 100 },
  { key: 'aep_0_5_m', label: '0.5% AEP', one_in: 200 },
  { key: 'aep_0_2_m', label: '0.2% AEP', one_in: 500 },
  { key: 'aep_0_066_m', label: '0.066% AEP', one_in: 1500 },
];

function gaugeZeroInForce(surveys) {
  const rows = (surveys || []).filter(r => num(r.gauge_zero_m) != null);
  if (!rows.length) return null;
  const open = newestFirst(rows.filter(r => !r.valid_to), 'valid_from');
  return open[0] || newestFirst(rows, 'valid_to')[0];
}

// The AEP row the card uses: newest sheet, then the most confident.
function pickAepRow(rows) {
  if (!nonEmpty(rows)) return null;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r.as_at || '', y = b.r.as_at || '';
    if (x !== y) return x < y ? 1 : -1;
    const cx = num(a.r.confidence) ?? -1, cy = num(b.r.confidence) ?? -1;
    if (cx !== cy) return cy - cx;
    return a.i - b.i;
  })[0].r;
}

function buildFloodLevels(doc, slsRows, v) {
  const crossingTypes = byKey(v.crossingTypes, 'code');
  const datums = byKey(v.datums, 'code');
  const zero = gaugeZeroInForce(doc.gauge_survey);
  const ahdZero = zero && zero.datum === 'AHD' ? num(zero.gauge_zero_m) : null;
  const toAhd = h => (ahdZero == null || num(h) == null ? null : round(ahdZero + num(h), 3));
  const ctype = code => (code ? { crossing_type_label: crossingTypes.get(code)?.label || null } : {});

  const surveyRows = newestFirst(doc.gauge_survey || [], 'valid_from').map(r => stripNulls({
    ...r, datum_label: r.datum ? (datums.get(r.datum)?.label || null) : null,
  }));
  const gauge_zero = surveyRows.length ? {
    status: 'ok',
    in_force: zero ? stripNulls({ ...zero, datum_label: zero.datum ? (datums.get(zero.datum)?.label || null) : null }) : null,
    history: surveyRows,
    note: ahdZero == null
      ? 'The gauge zero in force is not in AHD, so gauge heights here cannot be converted to AHD.'
      : 'Add the gauge zero (m AHD) to a gauge height to get m AHD.',
  } : { status: 'not recorded', detail: 'No gauge survey (Section 6 of the Bureau\'s river height station lists) is recorded for this station.' };

  const editions = newestFirst(doc.flood_classes || [], 'as_at');
  const cur = editions[0] || null;
  const flood_classes = cur ? {
    status: 'ok',
    unit: 'm on the gauge',
    current: stripNulls({ ...cur, ...ctype(cur.crossing_type) }),
    current_m_ahd: ahdZero == null ? null : stripNulls({
      first_report: toAhd(cur.first_report_m), minor: toAhd(cur.minor_m), crops_grazing: toAhd(cur.crops_grazing_m),
      moderate: toAhd(cur.moderate_m), towns: toAhd(cur.towns_m), major: toAhd(cur.major_m),
      crossing: toAhd(cur.crossing_height_m),
    }),
    earlier_editions: editions.slice(1).map(e => stripNulls({ ...e, ...ctype(e.crossing_type) })),
    source: 'The Bureau\'s Queensland river height station lists, Section 4 (meganet.station_flood_class)',
  } : { status: 'not recorded', detail: 'The Bureau\'s river height station lists give no flood classes for this station.' };

  const slsWith = bySlsRank(slsRows).filter(r => r.class_minor != null || r.class_moderate != null
    || r.class_major != null || nonEmpty(r.classes_undefined));
  const sls_flood_classes = slsWith.length ? {
    status: 'ok',
    unit: 'm on the gauge',
    rows: slsWith.map(r => stripNulls({ jurisdiction: r.jurisdiction || 'QLD', bureau_number: r.bureau_number,
      minor_m: num(r.class_minor), moderate_m: num(r.class_moderate), major_m: num(r.class_major),
      not_yet_defined: nonEmpty(r.classes_undefined) ? r.classes_undefined : null,
      gauge_datum: r.gauge_datum })),
    source: 'The Service Level Specifications (meganet.sls_location); each row\'s document is its jurisdiction, and its edition is in service_level.editions',
  } : { status: 'not recorded', detail: 'No Service Level Specification gives flood classes for this station.' };

  const crossingRows = newestFirst(doc.crossings || [], 'as_at');
  const crossings = crossingRows.length ? {
    status: 'ok',
    unit: 'm on the gauge',
    items: crossingRows.map(c => stripNulls({
      ...c, ...ctype(c.crossing_type),
      meaning: c.crossing_type ? (crossingTypes.get(c.crossing_type)?.meaning || null) : null,
      height_m_ahd: toAhd(c.height_m),
    })),
    source: 'Section 5 of the Bureau\'s river height station lists (meganet.station_crossing)',
  } : { status: 'not recorded', detail: 'No crossings are recorded against this station\'s gauge.' };

  const effectRows = doc.flood_effects || [];
  const latestEffectAt = newestFirst(effectRows, 'as_at')[0]?.as_at || null;
  const currentEffects = effectRows.filter(e => (e.as_at || null) === latestEffectAt);
  const flood_effects = effectRows.length ? {
    status: 'ok',
    unit: 'm on the gauge',
    as_at: latestEffectAt,
    items: currentEffects.map(e => stripNulls({ ...e, height_m_ahd: toAhd(e.height_m) })),
    earlier_rows: effectRows.length - currentEffects.length,
    source: 'Section 9 of the Bureau\'s Queensland flood warning station lists (meganet.station_flood_effect)',
  } : { status: 'not recorded', detail: 'No flood effects (Section 9) are recorded for this station.' };

  const aepRows = doc.aep_levels || [];
  const sel = pickAepRow(aepRows);
  let aep_levels;
  if (sel) {
    const offset = (num(sel.point_lat) != null && num(doc.lat) != null)
      ? round(haversineKm(num(doc.lat), num(doc.lon), num(sel.point_lat), num(sel.point_lon)), 2) : null;
    aep_levels = {
      status: 'ok',
      unit: 'm AHD',
      indicative: true,
      selected: stripNulls({ ...sel }),
      rows: aepRows.map(r => stripNulls({ ...r })),
      point_offset_km: offset,
      note: offset != null && offset > 1
        ? `The sheet puts this station ${offset} km from where MegaNet does; its levels are for the sheet's point.`
        : 'Modelled at the sheet\'s point for the station.',
      source: `AEP level workbooks (meganet.station_aep_level): ${uniq(aepRows.map(r => r.source).filter(Boolean)).join('; ') || 'source not recorded'}`,
    };
  } else {
    aep_levels = { status: 'not recorded', detail: 'Neither AEP level sheet (QLD, NSW) names this station.' };
  }

  // One ladder in m AHD, lowest first.
  const ladder = [];
  if (cur && ahdZero != null) {
    for (const [key, label] of [['minor_m', 'Minor flood class'], ['moderate_m', 'Moderate flood class'], ['major_m', 'Major flood class']]) {
      if (num(cur[key]) != null) ladder.push({ level: label, m_ahd: toAhd(cur[key]), m_on_gauge: num(cur[key]), source: 'Bureau station lists' });
    }
  }
  if (sel) {
    for (const d of AEP_LEVELS) {
      if (num(sel[d.key]) == null) continue;
      ladder.push({ level: `${d.label} (1 in ${d.one_in})`, m_ahd: num(sel[d.key]),
        m_on_gauge: ahdZero == null ? null : round(num(sel[d.key]) - ahdZero, 3), source: 'AEP sheet (modelled)' });
    }
  }
  ladder.sort((a, b) => a.m_ahd - b.m_ahd);
  let ladderNote = cur && ahdZero == null
    ? 'The flood classes are not on the ladder: the gauge zero in force is not in AHD.'
    : (ladder.length ? 'Flood classes converted with the AHD gauge zero in force; AEP levels as modelled.' : 'Nothing to put on a ladder.');
  // The AEP sheet's ground is at its own point, which may be a bank, a road or
  // a bridge rather than the channel the gauge reads. Say so when the two
  // datums' ground truths are far apart, rather than let the ladder imply
  // they describe the same water surface.
  const ground = sel ? num(sel.ground_m) : null;
  if (ground != null && ahdZero != null && Math.abs(ground - ahdZero) > 10) {
    ladderNote += ` The AEP sheet puts the ground at its point at ${ground} m AHD, ${round(Math.abs(ground - ahdZero), 2)} m `
      + `${ground > ahdZero ? 'above' : 'below'} the gauge zero (${ahdZero} m AHD): its levels may not describe the water at the gauge. Compare the two sets with care.`;
  }

  const anything = [gauge_zero, flood_classes, sls_flood_classes, crossings, flood_effects, aep_levels]
    .some(s => s.status === 'ok');
  return {
    status: anything ? 'ok' : 'not recorded',
    caveats: FLOOD_CAVEATS,
    gauge_zero,
    flood_classes,
    sls_flood_classes,
    crossings,
    flood_effects,
    aep_levels,
    ladder_m_ahd: { status: ladder.length ? 'ok' : 'not recorded', levels: ladder, note: ladderNote },
  };
}

async function floodVocab(rc) {
  const [crossingTypes, datums] = await Promise.all([settle(crossingTypesOf(rc)), settle(datumsOf(rc))]);
  return { crossingTypes: crossingTypes.ok ? crossingTypes.value : [], datums: datums.ok ? datums.value : [] };
}

async function floodLevelsEndpoint(rc, rawId) {
  const st = await loadStationDoc(rc, rawId);
  const [sls, v] = await Promise.all([settle(slsRowsFor(rc, st.id)), floodVocab(rc)]);
  const out = buildFloodLevels(st.doc, sls.ok ? sls.value : [], v);
  return {
    id: st.id,
    name: st.doc.name,
    station_number: st.doc.station_number || null,
    ...(st.resolved_from ? { resolved_from: st.resolved_from } : {}),
    ...out,
    ...(sls.ok ? {} : { sls_flood_classes: unavailable(sls.error, 'meganet.sls_location') }),
    disclaimer: DISCLAIMER,
    generated_at: new Date().toISOString(),
  };
}

// ── Service level (the Service Level Specifications) ─────────────────────────

// One document's edition, as the answer quotes it.
function slsEdition(d) {
  const j = d.jurisdiction || 'QLD';
  const known = SLS_DOCS[j] || {};
  return stripNulls({ jurisdiction: j, place: d.place || known.place || null, title: d.title,
    version: d.version, published: d.published, source: d.source, loaded_at: d.loaded_at,
    current_edition_url: d.url || known.url || null });
}

// "forecast location (Schedule 2)", in the entry's own document's numbering:
// the NSW document's information locations are its Schedule 3a, its Bureau-
// owned sites Schedule 6.
function slsRoleLabels(r, d) {
  const said = (d && d.schedules && typeof d.schedules === 'object') ? Object.values(d.schedules) : [];
  const known = (SLS_DOCS[r.jurisdiction || 'QLD'] || {}).schedules || {};
  return SLS_ROLES.filter(([k]) => r[k]).map(([k, label]) => {
    const n = (said.find(s => s && s.role === k) || {}).label || known[k];
    return n ? `${label} (Schedule ${n})` : label;
  });
}

function buildServiceLevel(doc, slsRows, slsDocs) {
  const docs = bySlsDoc(slsDocs || []);
  const docBy = new Map(docs.map(d => [d.jurisdiction || 'QLD', d]));
  const editions = docs.map(slsEdition);
  const rows = bySlsRank(slsRows);
  // `edition` is the first entry's document's (or, with none, the first
  // document's): the one field this answer had when there was one document.
  const first = rows.length ? docBy.get(rows[0].jurisdiction || 'QLD') : docs[0];
  const edition = first ? slsEdition(first) : null;
  if (!rows.length) {
    const named = editions.map(e => `${e.place || e.jurisdiction}${e.version ? `, version ${e.version}` : ''}`).join('; ');
    return {
      status: 'not recorded',
      detail: doc.station_number
        ? `Bureau number ${doc.station_number} is in no Service Level Specification MegaNet holds${named ? ` (${named})` : ''}.`
        : 'The station has no Bureau number, so it cannot be matched to a Service Level Specification.',
      edition,
      editions,
    };
  }
  return {
    status: 'ok',
    edition,
    editions,
    entries: rows.map(r => {
      const j = r.jurisdiction || 'QLD';
      const d = docBy.get(j);
      return stripNulls({
        jurisdiction: j,
        edition: d && d.version ? d.version : null,
        bureau_number: r.bureau_number,
        name: r.name,
        owner: r.owner,
        gauge_type: r.gauge_type,
        data_type: r.data_type,
        priority: r.priority,
        schedules: r.schedules,
        roles: slsRoleLabels({ ...r, jurisdiction: j }, d),
        catchment_name: r.catchment_name,
        basin_no: r.basin_no,
        awrc_number: r.awrc_number,
        gauge_datum: r.gauge_datum,
        flood_classes_m_on_gauge: stripNulls({ minor: num(r.class_minor), moderate: num(r.class_moderate), major: num(r.class_major) }),
        flood_classes_not_yet_defined: nonEmpty(r.classes_undefined) ? r.classes_undefined : null,
        prediction: stripNulls({ type: r.prediction_type, lead_time: r.lead_time, lead_time_hours: num(r.lead_time_hours),
          trigger_height: r.trigger_height, peak_accuracy: r.peak_accuracy,
          interim_service: r.interim_service ? true : null }),
        fast_response: r.fast_response ? true : null,
        source_note: r.source_note,
      });
    }),
    notes: [
      'Each entry is one document\'s: QLD is Queensland\'s, NSW the one for New South Wales and the ACT. A station on the border has an entry in each and they can disagree — quote the one for the state whose service the report is about, and say which.',
      'gauge_type is the SLS\'s own word: Manual (read by an observer) or Automatic (telemetered).',
      'priority is the impact of losing the site; where a document\'s schedules disagree the highest is kept.',
      'gauge_datum (NSW) is what the gauge reads in: where it is AHD, the flood classes and trigger heights are metres AHD as well as on the gauge.',
      'flood_classes_not_yet_defined (NSW) are classes the document prints n/a for: not yet defined by the NSW SES. fast_response is its ^ (a small catchment with a faster response); prediction.interim_service its * (an interim service with no determined lead time).',
    ],
  };
}

async function serviceLevelEndpoint(rc, rawId) {
  const st = await loadStationDoc(rc, rawId);
  const [sls, slsDocs] = await Promise.all([slsRowsFor(rc, st.id), settle(slsDocsOf(rc))]);
  return {
    id: st.id,
    name: st.doc.name,
    station_number: st.doc.station_number || null,
    ...(st.resolved_from ? { resolved_from: st.resolved_from } : {}),
    service_level: buildServiceLevel(st.doc, sls, slsDocs.ok ? slsDocs.value : []),
    source: 'meganet.sls_location (each Service Level Specification\'s six station schedules merged per Bureau number) and meganet.sls_doc (their editions)',
    generated_at: new Date().toISOString(),
  };
}

// ── The dossier ──────────────────────────────────────────────────────────────
// One call, everything a report drafter needs about one station, each section
// labelled with where it came from and saying so when there is nothing —
// status "ok", "not recorded" or "unavailable" (the read failed; try again).

function identitySection(st, doc) {
  return {
    status: 'ok',
    id: st.id,
    name: doc.name,
    station_number: doc.station_number || null,
    awrc_number: doc.awrc_number || null,
    urbs_label: doc.urbs_label || null,
    alert2_station_id: doc.alert2_station_id ?? null,
    legacy_unit_id: doc.legacy_unit_id ?? null,
    arro_site: doc.site || null,
    owner: doc.owner || null,
    owner_note: doc.owner ? null : 'No owner recorded on the station; the SLS entry (service_level) names one where it lists the station.',
    enabled: doc.enabled !== false,
    // Whether it is only proposed — where a station is meant to go, not yet
    // built or numbered — what kind it is or is to be (a meganet.station_type
    // code), and the year it is proposed for (0039).
    proposed: doc.proposed === true,
    station_type: doc.station_type || null,
    proposed_year: doc.proposed_year ?? null,
    roles: doc.roles || [],
    kinds: stationKinds(doc),
    location_types: doc.location_types || [],
    inspection_config_key: doc.inspection_config_key || null,
    register_notes: doc.notes || null,
    updated_at: st.updated_at,
    source: 'meganet.station_json',
  };
}

function locationSection(doc, cats, hubs) {
  const ahd = num(doc.elevation_ahd);
  const catRows = (doc.catchment_ids || []).map(id => {
    const c = cats && cats.get(id);
    return c ? stripNulls({ id, name: c.name, basin_no: c.basin_no, region: c.region, division: c.division,
      division_no: c.division_no, area_sqkm: num(c.area_sqkm) }) : { id };
  });
  const hub = doc.hub_id ? stripNulls({ id: doc.hub_id, name: hubs && hubs.get(doc.hub_id)?.name }) : null;
  return {
    status: num(doc.lat) != null ? 'ok' : 'not recorded',
    lat: num(doc.lat),
    lon: num(doc.lon),
    coordinates: 'decimal degrees, as recorded in the station register',
    elevation_ahd_m: ahd,
    elevation_source: elevationBasis(ahd, doc.elevation_source),
    elevation_note: ahd == null
      ? 'No height is recorded for this station.'
      : (doc.elevation_source
        ? 'Modelled from a digital elevation model via Geoscience Australia\'s Elvis — not a survey.'
        : 'A surveyed height (the register records a source only for modelled ones).'),
    lga: doc.lga || null,
    basin: doc.basin || null,
    stream: doc.stream || null,
    catchments: catRows,
    catchment_note: catRows.length ? 'Point-in-polygon against the 77 Queensland drainage basins.'
      : 'In no Queensland drainage basin (most such stations are in another state).',
    hub,
    source: 'meganet.station_json; meganet.catchment and meganet.hub for the names',
  };
}

function healthSection(rows) {
  if (!rows.length) {
    return {
      status: 'not recorded',
      detail: 'MegaNet has not heard from this station directly (no MQTT status and no ingest batch). Most stations report through the Bureau\'s own systems rather than MegaNet\'s ingest, so this says nothing about whether the station works.',
      source: 'meganet.station_health',
    };
  }
  const r = rows[0];
  return stripNulls({
    status: 'ok',
    online: r.online,
    since: r.since,
    last_seen_at: r.last_seen_at,
    last_reading_at: r.last_reading_at,
    minutes_since_seen: round(num(r.minutes_since_seen), 0),
    minutes_since_reading: round(num(r.minutes_since_reading), 0),
    reported_by: r.reported_by,
    last_status: r.last_status && Object.keys(r.last_status).length ? r.last_status : null,
    note: '"online" is what the broker last said, not a verdict; apply your own threshold to minutes_since_seen.',
    source: 'meganet.station_health',
  });
}

function sensorTypesByAlert(doc) {
  const m = new Map();
  for (const s of doc.sensors || []) {
    if (s.alert_id == null) continue;
    if (!m.has(s.alert_id)) m.set(s.alert_id, []);
    if (!m.get(s.alert_id).includes(s.type)) m.get(s.alert_id).push(s.type);
  }
  return m;
}

function dailySummarySection(rows, doc, fromDate, toDate, days) {
  if (!rows.length) {
    return {
      status: 'not recorded',
      window: { from: fromDate, to: toDate, days },
      detail: `No telemetry for this station was ingested into MegaNet in the last ${days} days. MegaNet holds only what reaches its own ingest; most stations' records live in the Bureau's systems.`,
      source: 'meganet.reading_daily',
    };
  }
  const types = sensorTypesByAlert(doc);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.addr)) groups.set(r.addr, []);
    groups.get(r.addr).push(r);
  }
  const channels = [...groups.entries()].map(([addr, rs]) => {
    const minOf = k => { const v = rs.map(x => num(x[k])).filter(x => x != null); return v.length ? Math.min(...v) : null; };
    const maxOf = k => { const v = rs.map(x => num(x[k])).filter(x => x != null); return v.length ? Math.max(...v) : null; };
    const last = rs[rs.length - 1];
    const alertId = num(rs[0].alert_id);
    return stripNulls({
      addr,
      alert_id: alertId,
      channel: rs[0].channel || null,
      sensor_types: alertId != null ? (types.get(alertId) || null) : null,
      unit: rs.find(x => x.unit)?.unit || null,
      days_with_data: rs.length,
      readings: rs.reduce((s, x) => s + (num(x.n) || 0), 0),
      duplicate_copies: rs.reduce((s, x) => s + (num(x.n_dup) || 0), 0),
      first_day: rs[0].bucket,
      last_day: last.bucket,
      last_reading_at: last.last_ts,
      raw: stripNulls({ min: minOf('raw_min'), max: maxOf('raw_max'), last: num(last.raw_last) }),
      value: rs.some(x => x.val_last != null) ? stripNulls({ min: minOf('val_min'), max: maxOf('val_max'), last: num(last.val_last) }) : null,
    });
  });
  return {
    status: 'ok',
    window: { from: fromDate, to: toDate, days, basis: 'UTC days' },
    channels,
    note: 'raw is as transmitted (an ALERT count, or an engineering value for a source without counts); value is the converted figure where MegaNet had a conversion. A rainfall accumulator counts tips: its raw.last is a counter, not a day\'s rain.',
    source: 'meganet.reading_daily',
  };
}

const INSPECTION_VIEWS = [
  ['power', 'inspection_chart_power', 'battery_existing_v,battery_existing_v_under_load,lithium_battery_v,dp_existing_v,consumption_standby_ma,consumption_transmit_ma,consumption_sleep_ma,consumption_operating_ma,consumption_interrogation_ma,telephone_socket_v,solar_output_v,solar_short_circuit_ma,solar_regulator_v,solar_charge_current_ma,solar_step_up_v,mains_charge_current_ma,mains_regulated_v'],
  ['radio', 'inspection_chart_radio', 'tx_size_w,tx_deviation_khz,existing_frequency_mhz,existing_forward_w,existing_reflected_w,existing_swr,replacement_forward_w,replacement_reflected_w,replacement_swr'],
  ['data', 'inspection_chart_data', 'phase,rssi_dbm,gas_pressure_kpa,dp_counter'],
  ['fade_margin', 'inspection_chart_fade_margin', 'phase,load_db'],
  ['gas', 'inspection_chart_gas', 'existing_cylinder_pressure_kpa,replacement_cylinder_pressure_kpa,existing_feed_pressure_kpa,existing_bubble_rate_bpm,compressor_pump_cycle_from_kpa,consumption_kpa_per_month'],
  ['water_level', 'inspection_chart_water_level', 'shaft_encoder_increments_per_rev'],
];

async function inspectionsSection(rc, id) {
  const src = 'meganet.inspection_chart_visit and the six inspection_chart_* views (numbers only)';
  const { rows: visits } = await rc.up.select('inspection_chart_visit', [
    ['select', 'id,inspected_on,date_precision,origin'], ['station_id', `eq.${id}`],
    ['order', 'inspected_on.desc.nullslast'], ['limit', 500]]);
  if (!visits.length) {
    return { status: 'not recorded', detail: 'No site inspection visits are recorded for this station.', source: src };
  }
  const dated = visits.filter(v => v.inspected_on);
  const recent = dated.slice(0, 3);
  const ids = recent.map(v => v.id);
  const numbers = {};
  if (ids.length) {
    const got = await Promise.all(INSPECTION_VIEWS.map(([key, view, cols]) => settle(
      rc.up.select(view, [['select', `inspection_id,${cols}`], ['inspection_id', `in.${pgList(ids)}`]]))));
    INSPECTION_VIEWS.forEach(([key], i) => { numbers[key] = got[i]; });
  }
  const failed = Object.entries(numbers).filter(([, r]) => !r.ok).map(([k]) => k);
  const rowsFor = (key, vid) => (numbers[key] && numbers[key].ok ? numbers[key].value.rows.filter(r => r.inspection_id === vid) : []);
  const clean = r => { const o = stripNulls({ ...r }); delete o.inspection_id; return Object.keys(o).length ? o : null; };
  const recent_visits = recent.map(v => {
    const byPhase = (key, field) => {
      const out = {};
      for (const r of rowsFor(key, v.id)) {
        const p = r.phase || 'unspecified';
        if (field) { const x = num(r[field]); if (x != null) out[p] = out[p] == null ? x : Math.max(out[p], x); } else { const c = clean(r); if (c) { delete c.phase; out[p] = c; } }
      }
      return Object.keys(out).length ? out : null;
    };
    return stripNulls({
      date: v.inspected_on,
      date_precision: v.date_precision,
      origin: v.origin,
      power: clean(rowsFor('power', v.id)[0] || {}),
      radio: clean(rowsFor('radio', v.id)[0] || {}),
      data_by_phase: byPhase('data'),
      fade_margin_db_by_phase: byPhase('fade_margin', 'load_db'),
      gas: clean(rowsFor('gas', v.id)[0] || {}),
      water_level: clean(rowsFor('water_level', v.id)[0] || {}),
    });
  });
  return stripNulls({
    status: 'ok',
    visits_recorded: visits.length,
    first_visit: dated.length ? dated[dated.length - 1].inspected_on : null,
    last_visit: dated.length ? stripNulls({ date: dated[0].inspected_on, date_precision: dated[0].date_precision, origin: dated[0].origin }) : null,
    recent_visits,
    note: 'Numbers only: remarks, the inspector and any free text are not public. date_precision says how much of the date the record claims; origin tells a sheet typed into MegaNet from one imported from the historical workbook.',
    unavailable: failed.length ? failed : null,
    source: src,
  });
}

async function nearbySection(rc, doc, id) {
  const lat = num(doc.lat), lon = num(doc.lon);
  if (lat == null || lon == null) {
    return { status: 'not recorded', detail: 'The station has no recorded position.', source: 'meganet.station' };
  }
  let found = [];
  for (const span of [0.25, 1, 3]) {
    const dLon = span / Math.max(0.01, Math.cos(lat * Math.PI / 180));
    const { rows } = await rc.up.select('station', [
      ['select', 'id,name,station_number,lat,lon,roles,location_types,alert_ids,stream,proposed'], ['deleted_at', 'is.null'],
      ['lat', `gte.${round(lat - span, 6)}`], ['lat', `lte.${round(lat + span, 6)}`],
      ['lon', `gte.${round(lon - dLon, 6)}`], ['lon', `lte.${round(lon + dLon, 6)}`], ['limit', 1000]]);
    found = rows.filter(r => r.id !== id && num(r.lat) != null && num(r.lon) != null);
    if (found.length >= 5) break;
  }
  const nearest = found
    .map(r => ({ r, d: haversineKm(lat, lon, num(r.lat), num(r.lon)) }))
    .sort((a, b) => a.d - b.d || (a.r.id < b.r.id ? -1 : 1))
    .slice(0, 5)
    .map(({ r, d }) => {
      const b = bearingDeg(lat, lon, num(r.lat), num(r.lon));
      // A proposed neighbour (0039) is where one is meant to go, and says so.
      return { id: r.id, name: r.name, station_number: r.station_number || null, distance_km: round(d, 2),
        bearing_deg: Math.round(b), direction: compass(b), kinds: stationKinds(r), roles: r.roles || [],
        proposed: r.proposed === true };
    });
  return nearest.length
    ? { status: 'ok', stations: nearest, note: 'Great-circle distance and initial bearing from this station.', source: 'meganet.station' }
    : { status: 'not recorded', detail: 'No other live station within about 330 km.', source: 'meganet.station' };
}

async function radioSection(rc, doc, id, networks, rmSystems) {
  const addrs = uniq([...flattenAlertIds(doc.alert_ids),
    ...(doc.sensors || []).map(s => num(s.alert_id)).filter(x => Number.isInteger(x))]).slice(0, 12);

  const [passRead, linkRead] = await Promise.all([
    addrs.length ? settle(rc.up.select('pass_range', [['select', 'repeater_id,kind,lo,hi'],
      ['or', `(${addrs.map(a => `and(lo.lte.${a},hi.gte.${a})`).join(',')})`], ['limit', 1000]])) : null,
    settle(rc.up.select('link_fade_margin', [['select',
      'station_a_id,station_b_id,kind,margin_db,margin_ab_db,margin_ba_db,distance_km,freq_mhz,verdict,band,model,computed_at'],
      ['or', `(station_a_id.eq.${pgQuote(id)},station_b_id.eq.${pgQuote(id)})`], ['order', 'margin_db.asc'], ['limit', 50]])),
  ]);

  const listening = new Map();
  if (passRead && passRead.ok) {
    const byRep = new Map();
    for (const r of passRead.value.rows) {
      if (!byRep.has(r.repeater_id)) byRep.set(r.repeater_id, []);
      byRep.get(r.repeater_id).push(r);
    }
    for (const [rep, ranges] of byRep) {
      if (rep === id) continue;
      const covered = a => ranges.some(r => r.kind === 'pass' && r.lo <= a && a <= r.hi)
                        && !ranges.some(r => r.kind === 'exclusion' && r.lo <= a && a <= r.hi);
      const passes = addrs.filter(covered);
      if (passes.length) listening.set(rep, passes);
    }
  }
  const links = linkRead.ok ? linkRead.value.rows : [];
  const otherIds = uniq([...listening.keys(), ...links.map(l => (l.station_a_id === id ? l.station_b_id : l.station_a_id))]).slice(0, 60);
  let names = new Map();
  if (otherIds.length) {
    const got = await settle(rc.up.select('station', [['select', 'id,name,station_number,lat,lon'], ['id', `in.${pgList(otherIds)}`]]));
    if (got.ok) names = byKey(got.value.rows);
  }
  const lat = num(doc.lat), lon = num(doc.lon);
  const describe = sid => {
    const s = names.get(sid);
    const d = s && lat != null && num(s.lat) != null ? round(haversineKm(lat, lon, num(s.lat), num(s.lon)), 2) : null;
    return stripNulls({ id: sid, name: s ? s.name : null, station_number: s ? s.station_number || null : null, distance_km: d });
  };

  let repeaters_listening;
  if (!addrs.length) repeaters_listening = { status: 'not recorded', detail: 'The station has no ALERT addresses to relay.' };
  else if (!passRead.ok) repeaters_listening = unavailable(passRead.error, 'meganet.pass_range');
  else if (!listening.size) repeaters_listening = { status: 'not recorded', detail: 'No recorded repeater pass range covers this station\'s ALERT addresses.', addresses: addrs };
  else {
    repeaters_listening = {
      status: 'ok',
      addresses: addrs,
      repeaters: [...listening.entries()].map(([rep, passes]) => ({ ...describe(rep), passes_addresses: passes }))
        .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9)).slice(0, 20),
      note: 'From recorded pass ranges (meganet.pass_range, exclusions honoured): a repeater listed passes the address; whether it hears this station depends on the radio path.',
      source: 'meganet.pass_range',
    };
  }

  const link_margins = !linkRead.ok ? unavailable(linkRead.error, 'meganet.link_fade_margin')
    : (links.length ? {
      status: 'ok',
      links: links.map(l => stripNulls({
        other_station: describe(l.station_a_id === id ? l.station_b_id : l.station_a_id),
        kind: l.kind, margin_db: num(l.margin_db), margin_ab_db: num(l.margin_ab_db), margin_ba_db: num(l.margin_ba_db),
        distance_km: num(l.distance_km), freq_mhz: num(l.freq_mhz), verdict: l.verdict, band: l.band, model: l.model,
        computed_at: l.computed_at,
      })),
      note: 'Modelled in the app (Longley–Rice over sampled terrain) and saved; margin_db is the worse direction. Stale if either end has moved since computed_at.',
      source: 'meganet.link_fade_margin',
    } : { status: 'not recorded', detail: 'No modelled link margin has been saved for a link to or from this station.', source: 'meganet.link_fade_margin' });

  const rm = rmSystems ? rmSystems.get(doc.rm_system_id) : null;
  return {
    status: 'ok',
    radio_networks: (doc.radio_network_ids || []).map(nid => ({ id: nid, name: networks ? (networks.get(nid)?.name || null) : null })),
    rm_system: rm ? stripNulls({ ...rm }) : (doc.rm_system_id != null ? { id: doc.rm_system_id } : null),
    alert_ids: doc.alert_ids || {},
    alert2_station_id: doc.alert2_station_id ?? null,
    satcom: doc.satcom || null,
    repeater: doc.repeater ? { status: 'ok', ...doc.repeater } : { status: 'not recorded', detail: 'Not a repeater: no repeater record.' },
    frequencies: nonEmpty(doc.frequencies) ? { status: 'ok', items: doc.frequencies }
      : { status: 'not recorded', detail: doc.repeater ? 'No frequencies beyond the repeater\'s own pair.' : 'No frequencies recorded.' },
    repeaters_listening,
    link_margins,
    source: 'meganet.station_json; meganet.radio_network and meganet.rm_system for the names',
  };
}

// meganet.station_type's four (0039), in the words a sentence needs — the
// app's STATION_TYPE_LABEL (core.js), with its article.
const STATION_TYPE_WORDS = {
  auto_water_level: 'an automatic water level station',
  auto_rain_gauge: 'an automatic rain gauge',
  manual_water_level: 'a manual water level station',
  manual_rain_gauge: 'a manual rain gauge',
};

function summaryLines(doc, d) {
  const lines = [];
  const kinds = stationKinds(doc);
  const where = [
    d.location.catchments?.[0]?.name ? `${d.location.catchments[0].name} catchment` : null,
    doc.lga || null,
  ].filter(Boolean).join(', ');
  lines.push(`${doc.name}${doc.station_number ? ` (Bureau number ${doc.station_number})` : ''} is a `
    + `${kinds.length ? kinds.join(' and ') : 'field'} station${where ? ` in the ${where}` : ''}`
    + `${d.location.hub?.name ? `, maintained from the ${d.location.hub.name}` : ''}.`);
  // A proposal says so next (0039): everything after it is about where a
  // station would be, not where one is.
  if (doc.proposed === true) {
    const type = STATION_TYPE_WORDS[doc.station_type];
    lines.push(`It is proposed, not yet established${type ? `: ${type}` : ''}`
      + `${doc.proposed_year ? `, proposed for ${doc.proposed_year}` : ''}`
      + `${doc.station_number ? '' : ', with no Bureau number until it is'}.`);
  }
  if (d.location.elevation_ahd_m != null) lines.push(`Ground height ${d.location.elevation_ahd_m} m AHD (${d.location.elevation_source}).`);
  const sl = d.service_level;
  if (sl.status === 'ok') {
    for (const e of sl.entries) {
      lines.push(`Service Level Specification (${e.jurisdiction}${e.edition ? ` v${e.edition}` : ''}): `
        + `gauge type ${e.gauge_type || 'not stated'}, data type ${e.data_type || 'not stated'}, `
        + `priority ${e.priority || 'not stated'}, owner ${e.owner || 'not stated'}.`);
    }
  }
  const fc = d.flood_levels.flood_classes;
  if (fc.status === 'ok') {
    const c = fc.current;
    const parts = [['minor', c.minor_m], ['moderate', c.moderate_m], ['major', c.major_m]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${v} m`);
    if (parts.length) lines.push(`Flood classes (${c.as_at || 'undated'}): ${parts.join(', ')} on the gauge.`);
  }
  const aep = d.flood_levels.aep_levels;
  if (aep.status === 'ok' && aep.selected.aep_1_m != null) lines.push(`Modelled 1% AEP level ${aep.selected.aep_1_m} m AHD (indicative, confidence ${aep.selected.confidence ?? 'n/a'} of 9).`);
  const insp = d.inspections;
  if (insp.status === 'ok' && insp.last_visit) lines.push(`${insp.visits_recorded} site visit(s) recorded; the last on ${insp.last_visit.date}.`);
  if (d.telemetry.health.status === 'ok') lines.push(`MegaNet last heard from it at ${d.telemetry.health.last_seen_at}.`);
  return lines;
}

async function dossierEndpoint(rc, rawId) {
  const st = await loadStationDoc(rc, rawId);
  const doc = st.doc;
  const id = st.id;
  const days = 30;                       // UTC dates, today included
  const toDate = new Date(rc.now).toISOString().slice(0, 10);
  const fromDate = new Date(rc.now - (days - 1) * 86400000).toISOString().slice(0, 10);

  const [sls, health, daily, cats, hubs, nets, rms, slsDocs, fv, indexes] = await Promise.all([
    settle(slsRowsFor(rc, id)),
    settle(healthRowsFor(rc, id)),
    settle(rc.up.select('reading_daily', [['select',
      'addr,alert_id,station_number,channel,bucket,n,n_dup,unit,raw_min,raw_max,raw_last,val_min,val_max,val_last,first_ts,last_ts'],
      ['station_id', `eq.${id}`], ['bucket', `gte.${fromDate}`], ['order', 'addr.asc,bucket.asc'], ['limit', 1000]])),
    settle(catchmentsOf(rc)),
    settle(hubsOf(rc)),
    settle(networksOf(rc)),
    settle(rmSystemsOf(rc)),
    settle(slsDocsOf(rc)),
    floodVocab(rc),
    settle(bureauIndexOf(rc)),
  ]);
  const indexBy = indexes.ok ? byKey(indexes.value, 'code') : new Map();
  const [inspections, nearby, radio] = await Promise.all([
    settle(inspectionsSection(rc, id)),
    settle(nearbySection(rc, doc, id)),
    settle(radioSection(rc, doc, id, nets.ok ? byKey(nets.value) : null, rms.ok ? byKey(rms.value) : null)),
  ]);

  const slsRows = sls.ok ? sls.value : [];
  const d = {
    identity: identitySection(st, doc),
    location: locationSection(doc, cats.ok ? byKey(cats.value) : null, hubs.ok ? byKey(hubs.value) : null),
    networks_and_radio: radio.ok ? radio.value : unavailable(radio.error),
    telemetry: {
      status: 'ok',
      sensors: nonEmpty(doc.sensors) ? { status: 'ok', items: doc.sensors }
        : { status: 'not recorded', detail: 'No ARRO sensor records for this station.' },
      alert_ids: doc.alert_ids || {},
      satcom: !!(doc.satcom && doc.satcom.enabled),
      tbrg_bucket_size_mm: doc.TBRGbucketSize ?? null,
      health: health.ok ? healthSection(health.value) : unavailable(health.error, 'meganet.station_health'),
      recent_daily: daily.ok ? dailySummarySection(daily.value.rows, doc, fromDate, toDate, days)
        : unavailable(daily.error, 'meganet.reading_daily'),
      source: 'meganet.station_json (sensors, addresses); station_health; reading_daily',
    },
    service_level: sls.ok ? buildServiceLevel(doc, slsRows, slsDocs.ok ? slsDocs.value : []) : unavailable(sls.error, 'meganet.sls_location'),
    bureau_listings: nonEmpty(doc.bureau_listings) ? {
      status: 'ok',
      items: doc.bureau_listings.map(l => stripNulls({ ...l, index: indexBy.get(String(l.section))?.title || null })),
      note: 'Which of the Bureau\'s Queensland flood warning station indexes list the station: 1 FloodWarn rainfall, 2 daily rainfall, 3 river height.',
      source: 'meganet.station_bureau_listing',
    } : { status: 'not recorded', detail: 'None of the Bureau\'s Queensland station indexes (Sections 1–3) lists this station.' },
    flood_levels: buildFloodLevels(doc, slsRows, fv),
    inspections: inspections.ok ? inspections.value : unavailable(inspections.error, 'meganet.inspection_chart_*'),
    nearby_stations: nearby.ok ? nearby.value : unavailable(nearby.error, 'meganet.station'),
  };
  if (!sls.ok) d.flood_levels.sls_flood_classes = unavailable(sls.error, 'meganet.sls_location');

  const slsEditions = slsDocs.ok ? slsDocs.value.map(slsEdition) : [];
  return {
    dossier_version: '1',
    id,
    ...(st.resolved_from ? { resolved_from: st.resolved_from } : {}),
    name: doc.name,
    generated_at: new Date().toISOString(),
    summary: summaryLines(doc, d),
    ...d,
    sources: [
      { relation: 'meganet.station_json', what: 'the station register record', updated_at: st.updated_at },
      { relation: 'meganet.sls_location / meganet.sls_doc', what: 'the Service Level Specifications for Queensland, and for New South Wales and the ACT',
        edition: slsEditions.length ? slsEditions.map(e => e.title || `${e.jurisdiction} version ${e.version}`).join('; ') : null },
      { relation: 'meganet.station_flood_class / station_crossing / station_gauge_survey / station_flood_effect / station_bureau_listing',
        what: 'the Bureau\'s Queensland flood warning station lists (Sections 1–6, 9), dated by as_at' },
      { relation: 'meganet.station_aep_level', what: 'QLD and NSW AEP level workbooks (modelled, indicative)' },
      { relation: 'meganet.station_health', what: 'what MegaNet\'s own ingest last heard' },
      { relation: 'meganet.reading_daily', what: `daily rollups of telemetry ingested into MegaNet, last ${days} UTC days` },
      { relation: 'meganet.inspection_chart_*', what: 'numbers recorded at site visits (no remarks)' },
      { relation: 'meganet.pass_range / meganet.link_fade_margin', what: 'repeater pass ranges and saved modelled link margins' },
      { relation: 'meganet.station / catchment / hub / radio_network / rm_system', what: 'nearby stations and reference names' },
    ],
    links: stationLinks(rc, id),
    disclaimer: DISCLAIMER,
  };
}

// ── GET /api/v1/stations/{id}/readings ───────────────────────────────────────

const READING_SELECT = {
  raw: 'addr,alert_id,station_number,channel,reading_ts,received_at,value_raw,value,unit,quality,path,dup_count',
  hourly: 'addr,alert_id,channel,bucket,n,n_dup,unit,raw_min,raw_max,raw_mean,raw_last,val_min,val_max,val_mean,val_last,first_ts,last_ts',
  daily: 'addr,alert_id,channel,bucket,n,n_dup,unit,raw_min,raw_max,raw_mean,raw_last,val_min,val_max,val_mean,val_last,first_ts,last_ts',
};
const READING_TABLE = { raw: 'reading', hourly: 'reading_hourly', daily: 'reading_daily' };

function parseInstant(v, name) {
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
    throw bad(`"${name}" must be an ISO 8601 date or date-time, e.g. 2026-09-01 or 2026-09-01T06:00:00Z.`);
  }
  // No zone given means UTC — the Worker's clock, and the daily rollups' days.
  let iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw bad(`"${name}" is not a real date.`);
  return t;
}

async function readingsEndpoint(rc, rawId, params) {
  const notes = [];
  const resolution = parseEnum(params.resolution, 'resolution', ['raw', 'hourly', 'daily']) || 'hourly';
  const maxDays = LIMITS.windowMaxDays[resolution];
  const to = params.to !== undefined ? parseInstant(params.to, 'to') : rc.now;
  const from = params.from !== undefined ? parseInstant(params.from, 'from')
    : to - LIMITS.windowDefaultDays[resolution] * 86400000;
  if (from >= to) throw bad('"from" must be before "to".');
  if (to > rc.now + 86400000) throw bad('"to" is more than a day in the future.');
  const spanDays = (to - from) / 86400000;
  if (spanDays > maxDays + 1e-9) {
    throw bad(`A ${resolution} window may span at most ${maxDays} days; this one spans ${round(spanDays, 1)}. `
      + (resolution === 'raw' ? 'Use resolution=hourly or daily, or a shorter window.'
        : resolution === 'hourly' ? 'Use resolution=daily, or a shorter window.' : 'Ask for a shorter window.'));
  }
  const limit = parseIntParam(params.limit, 'limit', { min: 1, max: LIMITS.readingsMax, dflt: LIMITS.readingsDefault, clampMax: true }, notes);
  const offset = parseIntParam(params.offset, 'offset', { min: 0, max: 1000000, dflt: 0 });

  const resolved = await resolveStationRow(rc, rawId, 'id,name,station_number,sensor(type,alert_id)');
  const station = resolved.row;
  const id = station.id;
  const sensors = station.sensor || [];

  let addrs = null;
  if (params.channel !== undefined) {
    const c = String(params.channel).trim();
    if (/^a:\d{1,5}$/.test(c) || /^s:[^\s"\\]{1,80}$/.test(c)) addrs = [c];
    else if (/^\d{1,5}$/.test(c)) addrs = [`a:${Number(c)}`];
    else {
      const want = c.toLowerCase();
      addrs = uniq(sensors.filter(s => (s.type || '').toLowerCase() === want && s.alert_id != null).map(s => `a:${s.alert_id}`));
      if (!addrs.length) {
        throw bad(`"channel" must be an ALERT address (6128 or a:6128), a satellite/cellular address (s:<number>/<channel>) or one of this station's sensor types with an ALERT address: ${uniq(sensors.filter(s => s.alert_id != null).map(s => s.type)).join(', ') || 'none'}.`);
      }
    }
  }

  const tcol = resolution === 'raw' ? 'reading_ts' : 'bucket';
  const asBound = t => (resolution === 'daily' ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString());
  const pairs = [
    ['select', READING_SELECT[resolution]],
    ['station_id', `eq.${id}`],
    [tcol, `gte.${asBound(from)}`],
    [tcol, resolution === 'daily' ? `lte.${asBound(to)}` : `lt.${asBound(to)}`],
    ...(addrs ? [['addr', `in.${pgList(addrs)}`]] : []),
    ['order', `${tcol}.asc,addr.asc`],
  ];
  const rows = [];
  let total = null;
  while (rows.length < limit) {
    const want = Math.min(LIMITS.upstreamPageRows, limit - rows.length);
    const got = await rc.up.select(READING_TABLE[resolution],
      [...pairs, ['limit', want], ['offset', offset + rows.length]], { count: total === null });
    if (total === null) total = got.total;
    rows.push(...got.rows);
    if (!got.rows.length || (total != null && offset + rows.length >= total)) break;
    if (total == null && got.rows.length < want) break;
  }

  const types = new Map();
  for (const s of sensors) {
    if (s.alert_id == null) continue;
    const k = `a:${s.alert_id}`;
    if (!types.has(k)) types.set(k, []);
    if (!types.get(k).includes(s.type)) types.get(k).push(s.type);
  }
  const channels = {};
  for (const r of rows) {
    if (!channels[r.addr]) channels[r.addr] = stripNulls({ sensor_types: types.get(r.addr) || null, unit: r.unit || null, alert_id: r.alert_id ?? null, channel: r.channel || null });
  }
  const shaped = rows.map(r => (resolution === 'raw'
    ? stripNulls({ t: r.reading_ts, addr: r.addr, value_raw: num(r.value_raw), value: num(r.value), unit: r.unit,
        quality: r.quality, received_at: r.received_at, path: r.path, dup_count: r.dup_count || null })
    : stripNulls({ t: r.bucket, addr: r.addr, n: r.n, raw_min: num(r.raw_min), raw_max: num(r.raw_max),
        raw_mean: num(r.raw_mean), raw_last: num(r.raw_last), val_min: num(r.val_min), val_max: num(r.val_max),
        val_mean: num(r.val_mean), val_last: num(r.val_last), unit: r.unit, first_ts: r.first_ts, last_ts: r.last_ts })));
  if (!shaped.length) {
    notes.push('No readings in this window. MegaNet holds only telemetry ingested into it (docs/ingest-http.md, docs/ingest-mqtt.md); most stations report through the Bureau\'s own systems. Raw readings are kept 90 days; hourly and daily rollups are kept indefinitely.');
  }
  if (resolution === 'daily') notes.push('Daily buckets are UTC dates.');
  const nextOffset = offset + shaped.length;
  const more = total != null ? nextOffset < total : shaped.length === limit;
  const nextParams = {};
  for (const k of ['from', 'to', 'resolution', 'channel', 'limit']) if (params[k] !== undefined) nextParams[k] = params[k];
  if (params.from === undefined) nextParams.from = new Date(from).toISOString();
  if (params.to === undefined) nextParams.to = new Date(to).toISOString();
  return {
    id,
    ...(resolved.resolved_from ? { resolved_from: resolved.resolved_from } : {}),
    name: station.name,
    resolution,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    count: shaped.length,
    total: total ?? null,
    limit,
    offset,
    next: shaped.length && more ? pageLink(rc, `/stations/${encodeURIComponent(id)}/readings`, nextParams, nextOffset) : null,
    channels,
    rows: shaped,
    notes,
    source: `meganet.${READING_TABLE[resolution]}`,
    generated_at: new Date().toISOString(),
  };
}

// ── Catchments and networks ──────────────────────────────────────────────────

async function catchmentsEndpoint(rc) {
  const cats = await catchmentsOf(rc);
  return {
    count: cats.length,
    catchments: cats.map(c => stripNulls({ ...c, area_sqkm: num(c.area_sqkm) })),
    note: 'The 77 Queensland drainage basins. GET /api/v1/catchments/{id} lists a basin\'s stations; ?catchment= on /api/v1/stations filters by id or name.',
    source: 'meganet.catchment',
    generated_at: new Date().toISOString(),
  };
}

async function catchmentEndpoint(rc, rawId, params) {
  const want = String(rawId || '').trim().toLowerCase();
  if (!want || want.length > 80) throw bad('A catchment id is needed, e.g. /api/v1/catchments/herbert.');
  const cats = await catchmentsOf(rc);
  const c = cats.find(x => x.id === want) || cats.find(x => (x.name || '').toLowerCase() === want.replace(/_/g, ' '));
  if (!c) {
    const near = cats.filter(x => x.id.includes(want) || (x.name || '').toLowerCase().includes(want)).slice(0, 10);
    throw new ApiError(404, 'catchment not found', `No catchment has the id "${want}". GET /api/v1/catchments lists the 77.`,
      near.length ? { candidates: near.map(x => ({ id: x.id, name: x.name })) } : null);
  }
  const list = await listStations(rc, params, { catchmentIds: [c.id], path: `/catchments/${encodeURIComponent(c.id)}` });
  return {
    catchment: stripNulls({ ...c, area_sqkm: num(c.area_sqkm) }),
    ...list,
    source: 'meganet.catchment; meganet.station (catchment_ids, point-in-polygon)',
  };
}

async function networksEndpoint(rc) {
  const [nets, hubs, rms] = await Promise.all([networksOf(rc), hubsOf(rc), rmSystemsOf(rc)]);
  return {
    radio_networks: nets,
    hubs: hubs.map(h => stripNulls({ ...h, area_sqkm: num(h.area_sqkm) })),
    rm_systems: rms,
    notes: [
      'radio_networks: the Bureau radio networks a station can belong to (filter with ?network=<id>).',
      'hubs: the Bureau\'s field maintenance regions (filter with ?hub=<id>).',
      'rm_systems: Radio Mobile transmitter/receiver presets a station\'s rm_system_id points at.',
    ],
    source: 'meganet.radio_network, meganet.hub, meganet.rm_system',
    generated_at: new Date().toISOString(),
  };
}

// ── The index and the OpenAPI document ───────────────────────────────────────

export const ENDPOINTS = Object.freeze([
  { path: '/api/v1/', op: 'getApiIndex', summary: 'What this API is, its endpoints, limits and links.' },
  { path: '/api/v1/openapi.json', op: 'getOpenApi', summary: 'This API as an OpenAPI 3.1 document.' },
  { path: '/api/v1/stations', op: 'searchStations', summary: 'Search and filter stations; compact rows.' },
  { path: '/api/v1/stations/{id}', op: 'getStation', summary: 'One station\'s full register record, its SLS rows and health.' },
  { path: '/api/v1/stations/{id}/dossier', op: 'getStationDossier', summary: 'Everything a report needs about one station, labelled with its sources.' },
  { path: '/api/v1/stations/{id}/readings', op: 'getStationReadings', summary: 'Telemetry ingested into MegaNet: raw, hourly or daily, bounded windows.' },
  { path: '/api/v1/stations/{id}/flood-levels', op: 'getStationFloodLevels', summary: 'Flood classes, SLS classes, crossings, gauge zero, flood effects, AEP levels and one AHD ladder.' },
  { path: '/api/v1/stations/{id}/service-level', op: 'getStationServiceLevel', summary: 'The station\'s entries in the Service Level Specifications (Queensland; New South Wales and the ACT).' },
  { path: '/api/v1/catchments', op: 'listCatchments', summary: 'The 77 Queensland drainage basins.' },
  { path: '/api/v1/catchments/{id}', op: 'getCatchment', summary: 'One basin and its stations.' },
  { path: '/api/v1/networks', op: 'listNetworks', summary: 'Radio networks, maintenance hubs and Radio Mobile systems.' },
]);

function rateLimitWords() {
  return RATE_LIMITS.map(r => `${r.limit} requests / ${r.period} s per ${r.per}${r.name === 'burst' ? ' (burst)' : ''}`);
}

function apiIndex(rc) {
  return {
    name: 'MegaNet station API',
    version: API_VERSION,
    read_only: true,
    description: 'Read-only, public station-level data from MegaNet — the register of the Bureau of Meteorology\'s Queensland (and neighbouring) flood-warning telemetry network: field stations, repeaters, base stations, their Bureau flood-warning details, SLS entries, AEP levels, health, ingested readings and inspection numbers. Useful for drafting assessment reports, and for anything else.',
    endpoints: ENDPOINTS.map(e => ({ method: 'GET', path: e.path, summary: e.summary })),
    mcp: { url: `${rc.origin}${MCP_PATH}`, transport: 'Streamable HTTP (POST, JSON responses)', protocol_versions: MCP_VERSIONS },
    openapi: `${rc.origin}${API_PREFIX}/openapi.json`,
    docs: DOCS_URL,
    limits: {
      rate: rateLimitWords(),
      client_name: `Name your client with the ${CLIENT_HEADER} header or ?client=<name> so your share of an address is your own.`,
      list_max: LIMITS.listMax,
      radius_max_km: LIMITS.radiusMaxKm,
      readings_max_rows: LIMITS.readingsMax,
      readings_window_max_days: LIMITS.windowMaxDays,
      cache_seconds: LIMITS.cacheSeconds,
    },
    station_ids: 'Lowercase slugs such as "abergowrie_br_al"; an all-digit id is also tried as a Bureau station number.',
    data_policy: 'Only what the public (anon) key can read: no inspection remarks, raw ingest payloads, photos or user data. See docs/access.md.',
    disclaimer: DISCLAIMER,
    generated_at: new Date().toISOString(),
  };
}

let OPENAPI_MEMO = null;
export function openApiDocument(origin = PUBLIC_ORIGIN) {
  if (OPENAPI_MEMO && OPENAPI_MEMO.origin === origin) return OPENAPI_MEMO.doc;
  const idParam = { $ref: '#/components/parameters/StationId' };
  const limitParam = (max, dflt) => ({ name: 'limit', in: 'query', required: false,
    description: `Rows per page, 1–${max} (default ${dflt}). Larger values are clamped with a note.`,
    schema: { type: 'integer', minimum: 1, maximum: max, default: dflt } });
  const offsetParam = { name: 'offset', in: 'query', required: false, description: 'Rows to skip, for paging; follow "next".',
    schema: { type: 'integer', minimum: 0, default: 0 } };
  const errors = {
    400: { $ref: '#/components/responses/BadRequest' },
    404: { $ref: '#/components/responses/NotFound' },
    429: { $ref: '#/components/responses/RateLimited' },
    502: { $ref: '#/components/responses/Upstream' },
    503: { $ref: '#/components/responses/Upstream' },
    504: { $ref: '#/components/responses/Upstream' },
  };
  const ok = (description, schema = { $ref: '#/components/schemas/Object' }) => ({
    200: { description, content: { 'application/json': { schema } } }, ...errors,
  });
  const op = (operationId, summary, description, parameters, responses) =>
    ({ get: { operationId, summary, description, parameters, responses } });
  const q = (name, description, schema) => ({ name, in: 'query', required: false, description, schema });

  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'MegaNet station API',
      version: API_VERSION,
      summary: 'Read-only public station data from the MegaNet telemetry network register.',
      description: `Read-only, public station-level data from MegaNet (${PUBLIC_ORIGIN}): the register of the Bureau of Meteorology's Queensland flood-warning telemetry network. `
        + `Rate limited (${rateLimitWords().join('; ')}); a 429 carries Retry-After. The same data is served to MCP clients at ${MCP_URL}. `
        + `Documentation: ${DOCS_URL}. ${DISCLAIMER}`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    paths: {
      '/api/v1/': op('getApiIndex', 'API index', 'What this API is: endpoints, rate limits, links to the docs, the MCP server and this document.', [], ok('The index.')),
      '/api/v1/openapi.json': op('getOpenApi', 'OpenAPI document', 'This document.', [], ok('An OpenAPI 3.1 document.')),
      '/api/v1/stations': op('searchStations', 'Search stations',
        'Find stations by name, Bureau or AWRC number, or ALERT address; filter by catchment, basin, LGA, hub, network, role, kind or SLS gauge type; or list those near a point. Compact rows; page with "next".',
        [
          q('q', 'Name words, a Bureau station number, an AWRC number or an ALERT address (2–100 characters; a number may be shorter). Ranked by relevance.', { type: 'string', minLength: 1, maxLength: LIMITS.qMaxLength }),
          q('near', 'A point as "lat,lon" in decimal degrees; results are sorted by distance and carry distance_km, bearing_deg and direction.', { type: 'string', pattern: '^-?\\d+(\\.\\d+)?,-?\\d+(\\.\\d+)?$' }),
          q('radius_km', `Radius around "near", 0.01–${LIMITS.radiusMaxKm} km (default ${LIMITS.radiusDefaultKm}).`, { type: 'number', minimum: 0.01, maximum: LIMITS.radiusMaxKm }),
          q('catchment', 'A Queensland drainage basin, by id ("herbert") or name ("Herbert"). See /api/v1/catchments.', { type: 'string' }),
          q('basin', 'Words in the Bureau\'s basin name for the station, e.g. "Burdekin".', { type: 'string' }),
          q('lga', 'Words in the local government area, e.g. "Townsville".', { type: 'string' }),
          q('hub', 'A maintenance hub id, e.g. "cairns". See /api/v1/networks.', { type: 'string' }),
          q('network', 'A radio network id. See /api/v1/networks.', { type: 'string' }),
          q('role', 'The station\'s role in the network.', { type: 'string', enum: ['field', 'repeater', 'base'] }),
          q('type', 'A kind: rain or river (from ALERT addresses, location types and the Bureau\'s river height list), repeater or base.', { type: 'string', enum: ['rain', 'river', 'repeater', 'base'] }),
          q('manual', 'true: stations the Service Level Specification lists as Manual; false: as Automatic. Stations not in the SLS match neither.', { type: 'boolean' }),
          limitParam(LIMITS.listMax, LIMITS.listDefault), offsetParam,
        ], ok('A page of compact station rows.', { $ref: '#/components/schemas/StationList' })),
      '/api/v1/stations/{id}': op('getStation', 'Get a station',
        'One station\'s full register record (the stations.json fragment), its Service Level Specification rows and its latest health row.',
        [idParam], ok('The station.')),
      '/api/v1/stations/{id}/dossier': op('getStationDossier', 'Get a station dossier',
        'Everything an assessment report needs about one station in one call: identity, location, radio, telemetry and health, SLS, Bureau flood details, AEP levels, inspections, nearby stations — each section labelled with its source and status.',
        [idParam], ok('The dossier.')),
      '/api/v1/stations/{id}/readings': op('getStationReadings', 'Get readings',
        `Telemetry ingested into MegaNet for one station. raw: up to ${LIMITS.windowMaxDays.raw} days; hourly: ${LIMITS.windowMaxDays.hourly}; daily: ${LIMITS.windowMaxDays.daily}. At most ${LIMITS.readingsMax} rows per call.`,
        [
          idParam,
          q('from', 'Start, ISO 8601 date or date-time (default: the window before "to").', { type: 'string' }),
          q('to', 'End (exclusive for raw and hourly), ISO 8601 (default: now).', { type: 'string' }),
          q('resolution', 'raw readings, or hourly or daily rollups (default hourly).', { type: 'string', enum: ['raw', 'hourly', 'daily'], default: 'hourly' }),
          q('channel', 'One channel: an ALERT address (6128 or a:6128), s:<number>/<channel>, or a sensor type such as "Water Level".', { type: 'string' }),
          limitParam(LIMITS.readingsMax, LIMITS.readingsDefault), offsetParam,
        ], ok('Readings or rollups.')),
      '/api/v1/stations/{id}/flood-levels': op('getStationFloodLevels', 'Get flood levels',
        'Flood classes (by edition), the SLS classes, crossings, the gauge zero and datum, flood effects, AEP levels and one ladder in m AHD — with the datum caveats.',
        [idParam], ok('Flood levels.')),
      '/api/v1/stations/{id}/service-level': op('getStationServiceLevel', 'Get the SLS entries',
        'The station\'s entries in the Service Level Specifications (QLD; NSW and the ACT), one per document that lists it: gauge type, data type, priority, owner, schedules, flood classes and prediction — and the NSW gauge datum and AWRC number — with each edition.',
        [idParam], ok('The SLS entries.')),
      '/api/v1/catchments': op('listCatchments', 'List catchments', 'The 77 Queensland drainage basins with basin number, area and drainage division.', [], ok('Catchments.')),
      '/api/v1/catchments/{id}': op('getCatchment', 'Get a catchment and its stations', 'One basin (by id or name) and a page of its stations.',
        [{ name: 'id', in: 'path', required: true, description: 'Catchment id, e.g. "herbert".', schema: { type: 'string' } },
          limitParam(LIMITS.listMax, LIMITS.listDefault), offsetParam], ok('The catchment and a page of its stations.')),
      '/api/v1/networks': op('listNetworks', 'List networks and hubs', 'Radio networks, maintenance hubs and Radio Mobile system presets — the ids ?network= and ?hub= take.', [], ok('Networks, hubs and systems.')),
    },
    components: {
      parameters: {
        StationId: { name: 'id', in: 'path', required: true,
          description: 'A station id — a lowercase slug such as "abergowrie_br_al". An all-digit id is also tried as a Bureau station number.',
          schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' } },
      },
      responses: {
        BadRequest: { description: 'A parameter is missing, malformed or out of range; detail says which.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        NotFound: { description: 'No such station, catchment or endpoint.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        RateLimited: { description: 'Rate limited. Wait retry_after seconds (also the Retry-After header).',
          headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' } },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        Upstream: { description: 'The database was unreachable, slow or refused; detail says which (a paused free-tier project is the usual cause).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      schemas: {
        Object: { type: 'object', additionalProperties: true },
        Error: { type: 'object', required: ['error'], properties: {
          error: { type: 'string' }, detail: { type: 'string' }, retry_after: { type: 'integer' } }, additionalProperties: true },
        StationSummary: { type: 'object', additionalProperties: true, properties: {
          id: { type: 'string' }, name: { type: 'string' }, station_number: { type: ['string', 'null'] },
          lat: { type: ['number', 'null'] }, lon: { type: ['number', 'null'] },
          elevation_ahd_m: { type: ['number', 'null'] }, elevation_source: { type: ['string', 'null'] },
          roles: { type: 'array', items: { type: 'string' } }, kinds: { type: 'array', items: { type: 'string' } },
          catchments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          basin: { type: ['string', 'null'] }, stream: { type: ['string', 'null'] }, lga: { type: ['string', 'null'] },
          telemetry: { type: 'object', additionalProperties: true }, sls: { type: ['object', 'null'], additionalProperties: true },
          has: { type: 'object', additionalProperties: true }, distance_km: { type: 'number' } } },
        StationList: { type: 'object', additionalProperties: true, properties: {
          count: { type: 'integer' }, total: { type: ['integer', 'null'] }, limit: { type: 'integer' }, offset: { type: 'integer' },
          next: { type: ['string', 'null'] }, stations: { type: 'array', items: { $ref: '#/components/schemas/StationSummary' } },
          notes: { type: 'array', items: { type: 'string' } } } },
      },
    },
  };
  OPENAPI_MEMO = { origin, doc };
  return doc;
}

// ── Routing ──────────────────────────────────────────────────────────────────

async function routeRest(rc, sub, params) {
  const parts = sub.split('/').filter(Boolean).map(seg => {
    try { return decodeURIComponent(seg); } catch (_) { throw bad('The path is not validly percent-encoded.'); }
  });
  const none = () => allowParams(params, []);
  if (parts.length === 0) { none(); return apiIndex(rc); }
  if (parts.length === 1 && parts[0] === 'openapi.json') { none(); return openApiDocument(rc.origin); }
  if (parts[0] === 'stations') {
    if (parts.length === 1) return listStations(rc, allowParams(params, STATION_LIST_PARAMS));
    if (parts.length === 2) { none(); return stationDetail(rc, parts[1]); }
    if (parts.length === 3) {
      switch (parts[2]) {
        case 'dossier': none(); return dossierEndpoint(rc, parts[1]);
        case 'readings': return readingsEndpoint(rc, parts[1],
          allowParams(params, ['from', 'to', 'resolution', 'channel', 'limit', 'offset']));
        case 'flood-levels': none(); return floodLevelsEndpoint(rc, parts[1]);
        case 'service-level': none(); return serviceLevelEndpoint(rc, parts[1]);
        default: break;
      }
    }
  }
  if (parts[0] === 'catchments') {
    if (parts.length === 1) { none(); return catchmentsEndpoint(rc); }
    if (parts.length === 2) return catchmentEndpoint(rc, parts[1], allowParams(params, ['limit', 'offset']));
  }
  if (parts[0] === 'networks' && parts.length === 1) { none(); return networksEndpoint(rc); }
  throw new ApiError(404, 'not found', `No endpoint at ${API_PREFIX}${sub}. GET ${API_PREFIX}/ lists them.`);
}

function errorBody(err) {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.error, ...(err.detail ? { detail: err.detail } : {}), ...(err.extra || {}) } };
  }
  return { status: 500, body: { error: 'internal error', detail: String((err && err.message) || err) } };
}

function cacheKeyFor(origin, sub, params) {
  const keys = Object.keys(params).sort();
  const qs = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  return `${origin}${API_PREFIX}${sub}${qs ? `?${qs}` : ''}`;
}

// One route, through the edge cache: what both the REST door and every MCP
// tool call go through, so the two share one answer per URL per minute.
async function cachedRoute(rc, sub, params) {
  const key = cacheKeyFor(rc.origin, sub, params);
  if (rc.cache) {
    try {
      const hit = await rc.cache.match(key);
      if (hit) return { status: 200, text: await hit.text(), cache: 'hit' };
    } catch (_) { /* a miss */ }
  }
  let status, body;
  try {
    body = await routeRest(rc, sub, params);
    status = 200;
  } catch (err) {
    ({ status, body } = errorBody(err));
  }
  let text = JSON.stringify(body);
  if (text.length > LIMITS.responseMaxBytes) {
    status = 413;
    text = JSON.stringify({ error: 'response too large', detail: `The answer would be over ${LIMITS.responseMaxBytes} bytes; ask for fewer rows or a shorter window.` });
  }
  if (status === 200 && rc.cache) {
    rc.waitUntil(rc.cache.put(key, new Response(text, { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LIMITS.cacheSeconds}`,
    } })));
  }
  return { status, text, cache: rc.cache ? 'miss' : 'none' };
}

function makeRc(env, ctx, url) {
  let cache = null;
  try { cache = (globalThis.caches && globalThis.caches.default) || null; } catch (_) { cache = null; }
  const rc = {
    env,
    origin: url.origin,
    now: Date.now(),
    cache,
    waitUntil: p => {
      const safe = Promise.resolve(p).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
    },
  };
  rc.up = new Upstream(rc);
  return rc;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

const WINDOWS = new Map();          // key → timestamps (ms), the in-isolate fallback
const WINDOW_KEYS_MAX = 10000;

function clientName(request, url) {
  const raw = request.headers.get(CLIENT_HEADER) || url.searchParams.get('client') || '';
  const s = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(s) ? s : null;
}

export const RATE_LIMIT_POLICY = RATE_LIMITS.map(r => `${r.limit};w=${r.period};name="${r.name}"`).join(', ');

async function rateLimit(request, env, url, weight = 1) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const name = clientName(request, url);
  const [clientKey, addressKey] = await Promise.all([
    sha256Hex(`meganet-api|client|${ip}|${name || '-'}`),
    sha256Hex(`meganet-api|address|${ip}`),
  ]);
  const keyFor = rule => (rule.per === 'address' ? `a:${addressKey.slice(0, 32)}` : `c:${clientKey.slice(0, 32)}`);

  const viaBinding = [], viaIsolate = [];
  for (const rule of RATE_LIMITS) {
    const b = env && env[rule.binding];
    (b && typeof b.limit === 'function' ? viaBinding : viaIsolate).push(rule);
  }

  let failed = null;
  let retryAfter = 0;
  const fellBack = [];
  for (const rule of viaBinding) {
    try {
      for (let i = 0; i < weight && !failed; i++) {
        const out = await env[rule.binding].limit({ key: keyFor(rule) });
        if (!out || out.success === false) failed = rule;
      }
    } catch (_) {
      fellBack.push(rule);        // the binding erred: this rule falls to the isolate
    }
    if (failed) { retryAfter = rule.period; break; }
  }

  const isolateRules = [...viaIsolate, ...fellBack];
  if (!failed && isolateRules.length) {
    const now = Date.now();
    for (const rule of isolateRules) {
      const k = `${rule.name}|${keyFor(rule)}`;
      const w = (WINDOWS.get(k) || []).filter(t => t > now - rule.period * 1000);
      WINDOWS.set(k, w);
      if (w.length + weight > rule.limit) {
        failed = rule;
        retryAfter = w.length ? Math.max(1, Math.ceil((w[0] + rule.period * 1000 - now) / 1000)) : rule.period;
        break;
      }
    }
    if (!failed) for (const rule of isolateRules) {
      const w = WINDOWS.get(`${rule.name}|${keyFor(rule)}`);
      for (let i = 0; i < weight; i++) w.push(now);
    }
    if (WINDOWS.size > WINDOW_KEYS_MAX) {
      let drop = WINDOWS.size - WINDOW_KEYS_MAX + 1000;
      for (const k of WINDOWS.keys()) { if (drop-- <= 0) break; WINDOWS.delete(k); }
    }
  }

  const limiter = isolateRules.length === 0 ? 'cloudflare' : (isolateRules.length === RATE_LIMITS.length ? 'isolate' : 'mixed');
  return { ok: !failed, rule: failed ? failed.name : null, retryAfter, limiter, client: name };
}

function rateHeaders(rate) {
  return {
    'X-RateLimit-Policy': RATE_LIMIT_POLICY,
    'X-RateLimit-Limiter': rate ? rate.limiter : 'none',
    [CLIENT_HEADER]: rate && rate.client ? rate.client : 'anonymous',
  };
}

function rateDetail(rate) {
  const rule = RATE_LIMITS.find(r => r.name === rate.rule);
  return `Too many requests: the ${rule.name} limit is ${rule.limit} requests / ${rule.period} s per ${rule.per}. `
    + `Wait ${rate.retryAfter} s and retry. Limits: ${rateLimitWords().join('; ')}. Name your client with the `
    + `${CLIENT_HEADER} header or ?client= so an address shared with others does not share your limit. See ${DOCS_URL}`;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

const EXPOSE = ['ETag', 'Retry-After', 'X-RateLimit-Policy', 'X-RateLimit-Limiter', CLIENT_HEADER,
  'X-MegaNet-Cache', 'X-MegaNet-Api-Version'].join(', ');

function baseHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': EXPOSE,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    'X-MegaNet-Api-Version': API_VERSION,
    ...extra,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: baseHeaders(headers) });
}

// Over the answer without its generated_at, so the same data asked twice is
// the same entity and a client holding it gets a 304.
async function etagFor(text) {
  const stable = text.replace(/"generated_at":"[^"]*"/g, '');
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stable));
  return `W/"${[...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('')}"`;
}

const SAFE_REQUEST_HEADERS = /^[A-Za-z0-9 ,_-]{0,512}$/;
const DEFAULT_ALLOWED_HEADERS = ['Content-Type', 'Accept', 'MCP-Protocol-Version', 'Mcp-Session-Id', 'Mcp-Method',
  'Mcp-Name', CLIENT_HEADER, 'If-None-Match', 'Last-Event-ID', 'Authorization'].join(', ');

function preflight(request, isMcp) {
  const asked = request.headers.get('Access-Control-Request-Headers') || '';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': isMcp ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': asked && SAFE_REQUEST_HEADERS.test(asked) ? asked : DEFAULT_ALLOWED_HEADERS,
      'Access-Control-Max-Age': '86400',
      'X-MegaNet-Api-Version': API_VERSION,
    },
  });
}

function paramsOf(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (k === 'client') continue;          // the rate-limit name, not a filter
    if (k in out) throw bad(`Parameter "${k}" is given more than once.`);
    out[k] = v;
  }
  return out;
}

async function handleRest(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(405, { error: 'method not allowed', detail: 'This API is read-only: GET or HEAD only.' },
      { Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' });
  }
  const rate = await rateLimit(request, env, url, 1);
  if (!rate.ok) {
    return jsonResponse(429, { error: 'rate limited', detail: rateDetail(rate), retry_after: rate.retryAfter },
      { 'Retry-After': String(rate.retryAfter), 'Cache-Control': 'no-store', ...rateHeaders(rate) });
  }
  let params;
  try { params = paramsOf(url); } catch (err) {
    const { status, body } = errorBody(err);
    return jsonResponse(status, body, { 'Cache-Control': 'no-store', ...rateHeaders(rate) });
  }
  const rc = makeRc(env, ctx, url);
  const sub = url.pathname.slice(API_PREFIX.length) || '/';
  const out = await cachedRoute(rc, sub.startsWith('/') ? sub : `/${sub}`, params);
  const headers = { ...rateHeaders(rate), 'X-MegaNet-Cache': out.cache };
  if (out.status === 200) {
    const etag = await etagFor(out.text);
    headers.ETag = etag;
    headers['Cache-Control'] = `public, max-age=${LIMITS.cacheSeconds}`;
    const inm = request.headers.get('If-None-Match');
    if (inm && inm.split(',').map(s => s.trim()).includes(etag)) {
      const h = baseHeaders(headers);
      delete h['Content-Type'];
      return new Response(null, { status: 304, headers: h });
    }
  } else {
    headers['Cache-Control'] = 'no-store';
    if (out.status === 503 || out.status === 504) headers['Retry-After'] = '30';
  }
  if (request.method === 'HEAD') return new Response(null, { status: out.status, headers: baseHeaders(headers) });
  return jsonResponse(out.status, out.text, headers);
}

// ── MCP ──────────────────────────────────────────────────────────────────────
// Streamable HTTP, stateless, JSON responses only: POST a JSON-RPC message and
// get one JSON answer; GET is 405 (no server-initiated stream); no session id
// is ever minted. Dual-era, per the 2026-07-28 revision's compatibility rules:
//
//   legacy  (2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05's protocol)
//           — an `initialize` handshake, then tools/list and tools/call; the
//           MCP-Protocol-Version header optional, 2025-03-26 assumed without it.
//           Batches accepted, for 2025-03-26 clients.
//   modern  (2026-07-28) — no handshake: every request carries its version and
//           capabilities in `_meta`, mirrored in the MCP-Protocol-Version,
//           Mcp-Method and Mcp-Name headers, which must agree with the body
//           (400 + -32020 when they do not); server/discover answers up front.
//
// Every result carries resultType "complete" and names this server in _meta,
// which the modern era requires and the legacy era ignores.
//
// Origin: the transport says to validate it, against DNS rebinding — an attack
// on servers on a private network, which this public, credential-free,
// read-only one is not. So: no Origin (every non-browser client) is fine; any
// https origin is fine (a browser-based client or inspector); http is fine only
// from localhost; anything else — `null`, file:, plain http from elsewhere — is
// refused with 403.

export const MCP_MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const MCP_LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const MCP_VERSIONS = Object.freeze([...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS]);
const MCP_LATEST_LEGACY = '2025-11-25';

const SERVER_INFO = Object.freeze({
  name: 'meganet',
  title: 'MegaNet station data (read-only)',
  version: API_VERSION,
  description: 'Read-only public data about the stations of the Bureau of Meteorology\'s Queensland flood-warning telemetry network, from the MegaNet register.',
  websiteUrl: PUBLIC_ORIGIN,
});

export const MCP_INSTRUCTIONS = [
  'MegaNet (floodwarning.net) is the engineering register of the Bureau of Meteorology\'s Queensland (and neighbouring) flood-warning telemetry network: rainfall and river-height field stations, the repeaters that relay them, base stations, and the radio paths between. This server is READ-ONLY and serves only public data.',
  'Station ids are lowercase slugs such as "abergowrie_br_al" (a Bureau number also works). Find stations with search_stations or stations_near, then call get_station_dossier for everything about one station in a single call — identity, location, radio, telemetry and health, the Service Level Specification entry, the Bureau\'s flood classes, crossings and gauge zero, AEP levels, inspection numbers and nearby stations, each labelled with its source. Use get_flood_levels or get_service_level when only that is needed.',
  'Heights: flood classes, crossings and flood effects are metres on the gauge, not AHD; AEP levels are modelled metres AHD and indicative only. Say which source a figure came from. Sections report status "ok", "not recorded" or "unavailable" — never read "not recorded" as zero.',
  `Be gentle: ${rateLimitWords().join('; ')}. Cache what you fetch and do not walk the whole network station by station.`,
  'MegaNet is not a flood warning service. For current warnings and observations, send people to the Bureau of Meteorology (bom.gov.au).',
].join('\n\n');

const idArg = { type: 'string', description: 'Station id, a lowercase slug such as "abergowrie_br_al" (a Bureau station number also works).', maxLength: 64 };
const limitArg = (max, dflt) => ({ type: 'integer', minimum: 1, maximum: max, description: `Rows per page (default ${dflt}, max ${max}).` });
const offsetArg = { type: 'integer', minimum: 0, maximum: LIMITS.offsetMax, description: 'Rows to skip, for paging.' };
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const listFilters = {
  catchment: { type: 'string', maxLength: 100, description: 'Queensland drainage basin by id ("herbert") or name. list_catchments has them.' },
  basin: { type: 'string', maxLength: 100, description: 'Words in the Bureau\'s basin name, e.g. "Burdekin".' },
  lga: { type: 'string', maxLength: 100, description: 'Words in the local government area, e.g. "Townsville".' },
  hub: { type: 'string', maxLength: 64, description: 'Maintenance hub id, e.g. "cairns". list_networks has them.' },
  network: { type: 'string', maxLength: 64, description: 'Radio network id. list_networks has them.' },
  role: { type: 'string', enum: ['field', 'repeater', 'base'], description: 'Role in the network.' },
  type: { type: 'string', enum: ['rain', 'river', 'repeater', 'base'], description: 'Kind of station.' },
  manual: { type: 'boolean', description: 'true: SLS lists it as Manual; false: as Automatic.' },
};

const pick = (a, keys) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, String(a[k])]));
const enc = encodeURIComponent;

export const MCP_TOOLS = Object.freeze([
  {
    name: 'search_stations',
    title: 'Search stations',
    description: 'Find stations by name words, Bureau or AWRC number, or ALERT address, optionally filtered by catchment, basin, LGA, hub, radio network, role, kind (rain/river/repeater/base) or SLS gauge type. Returns compact rows (id, name, number, position, kinds, whether it is only proposed, SLS gauge type, flood-level flags) ranked by relevance. Pass a row\'s id to get_station_dossier.',
    inputSchema: { type: 'object', properties: {
      q: { type: 'string', maxLength: LIMITS.qMaxLength, description: 'Name words, a Bureau station number, an AWRC number or an ALERT address.' },
      ...listFilters, limit: limitArg(LIMITS.listMax, LIMITS.listDefault), offset: offsetArg,
    }, additionalProperties: false },
    route: a => ['/stations', pick(a, ['q', 'catchment', 'basin', 'lga', 'hub', 'network', 'role', 'type', 'manual', 'limit', 'offset'])],
  },
  {
    name: 'stations_near',
    title: 'Stations near a point',
    description: 'Stations within a radius of a latitude/longitude, nearest first, each with distance_km, bearing_deg and compass direction. Optional filters as search_stations.',
    inputSchema: { type: 'object', properties: {
      lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude, decimal degrees (negative south).' },
      lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude, decimal degrees.' },
      radius_km: { type: 'number', minimum: 0.01, maximum: LIMITS.radiusMaxKm, description: `Radius in km (default ${LIMITS.radiusDefaultKm}, max ${LIMITS.radiusMaxKm}).` },
      ...listFilters, limit: limitArg(LIMITS.listMax, LIMITS.listDefault), offset: offsetArg,
    }, required: ['lat', 'lon'], additionalProperties: false },
    route: a => ['/stations', { near: `${a.lat},${a.lon}`, ...pick(a, ['radius_km', 'catchment', 'basin', 'lga', 'hub', 'network', 'role', 'type', 'manual', 'limit', 'offset']) }],
  },
  {
    name: 'get_station',
    title: 'Get a station',
    description: 'One station\'s full register record (sensors, ALERT addresses, radio, Bureau lists, AEP levels…), its Service Level Specification rows and its latest health row.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'], additionalProperties: false },
    route: a => [`/stations/${enc(a.id)}`, {}],
  },
  {
    name: 'get_station_dossier',
    title: 'Get a station dossier',
    description: 'Everything an assessment report needs about one station in one call: identity, location and elevation, networks and radio, sensors and health, recent daily telemetry, the SLS entry, the Bureau\'s flood classes, crossings and gauge zero, AEP levels, inspection numbers and the five nearest stations — each section with its source and a status of ok, not recorded or unavailable.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'], additionalProperties: false },
    route: a => [`/stations/${enc(a.id)}/dossier`, {}],
  },
  {
    name: 'get_readings',
    title: 'Get readings',
    description: `Telemetry ingested into MegaNet for one station: raw readings (window up to ${LIMITS.windowMaxDays.raw} days), hourly (${LIMITS.windowMaxDays.hourly} days) or daily rollups (${LIMITS.windowMaxDays.daily} days). Most stations report through the Bureau's own systems, so an empty answer is normal.`,
    inputSchema: { type: 'object', properties: {
      id: idArg,
      from: { type: 'string', maxLength: 40, description: 'Start, ISO 8601 date or date-time.' },
      to: { type: 'string', maxLength: 40, description: 'End, ISO 8601 (default now).' },
      resolution: { type: 'string', enum: ['raw', 'hourly', 'daily'], description: 'Default hourly.' },
      channel: { type: 'string', maxLength: 90, description: 'An ALERT address (6128), s:<number>/<channel>, or a sensor type such as "Water Level".' },
      limit: limitArg(LIMITS.readingsMax, LIMITS.readingsDefault), offset: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Rows to skip.' },
    }, required: ['id'], additionalProperties: false },
    route: a => [`/stations/${enc(a.id)}/readings`, pick(a, ['from', 'to', 'resolution', 'channel', 'limit', 'offset'])],
  },
  {
    name: 'list_catchments',
    title: 'List catchments',
    description: 'The 77 Queensland drainage basins: id, name, basin number, area, drainage division.',
    inputSchema: { type: 'object', additionalProperties: false },
    route: () => ['/catchments', {}],
  },
  {
    name: 'get_catchment',
    title: 'Get a catchment',
    description: 'One Queensland drainage basin (by id or name) and a page of its stations as compact rows.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', maxLength: 80, description: 'Catchment id such as "herbert", or its name.' },
      limit: limitArg(LIMITS.listMax, LIMITS.listDefault), offset: offsetArg,
    }, required: ['id'], additionalProperties: false },
    route: a => [`/catchments/${enc(String(a.id).trim().toLowerCase().replace(/\s+/g, '_'))}`, pick(a, ['limit', 'offset'])],
  },
  {
    name: 'get_flood_levels',
    title: 'Get flood levels',
    description: 'A station\'s flood heights with their datum caveats: the Bureau\'s flood classes by edition, the SLS\'s classes, crossings, the gauge zero and its datum, flood effects, modelled AEP levels, and one ladder in m AHD where the gauge zero allows it.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'], additionalProperties: false },
    route: a => [`/stations/${enc(a.id)}/flood-levels`, {}],
  },
  {
    name: 'get_service_level',
    title: 'Get the SLS entries',
    description: 'A station\'s entries in the Service Level Specifications — Queensland\'s, and the one for New South Wales and the ACT; a station on the border has one from each: gauge type (Manual/Automatic), data type, priority, owner, schedules, flood classes and prediction (and, from the NSW document, the gauge datum and AWRC number), each with its edition.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'], additionalProperties: false },
    route: a => [`/stations/${enc(a.id)}/service-level`, {}],
  },
  {
    name: 'list_networks',
    title: 'List networks and hubs',
    description: 'Radio networks, the Bureau\'s maintenance hubs and the Radio Mobile system presets — the ids search_stations takes for network and hub.',
    inputSchema: { type: 'object', additionalProperties: false },
    route: () => ['/networks', {}],
  },
].map(t => Object.freeze({ ...t, annotations: { title: t.title, ...ANNOTATIONS } })));

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map(t => [t.name, t]));
const TOOL_LIST = MCP_TOOLS.map(({ name, title, description, inputSchema, annotations }) =>
  ({ name, title, description, inputSchema, annotations }));

function validateArgs(schema, args) {
  const props = schema.properties || {};
  const out = {};
  for (const k of Object.keys(args)) {
    if (!(k in props)) {
      const known = Object.keys(props);
      return { error: `Unknown argument "${k}".${known.length ? ` Accepted: ${known.join(', ')}.` : ' This tool takes no arguments.'}` };
    }
  }
  for (const k of schema.required || []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return { error: `Missing required argument "${k}".` };
  }
  for (const [k, spec] of Object.entries(props)) {
    let v = args[k];
    if (v === undefined || v === null) continue;
    if (spec.type === 'string') {
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') return { error: `"${k}" must be a string.` };
      if (spec.maxLength && v.length > spec.maxLength) return { error: `"${k}" is longer than ${spec.maxLength} characters.` };
      if (spec.enum && !spec.enum.includes(v)) return { error: `"${k}" must be one of: ${spec.enum.join(', ')}.` };
    } else if (spec.type === 'integer' || spec.type === 'number') {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `"${k}" must be a number.` };
      if (spec.type === 'integer' && !Number.isInteger(v)) return { error: `"${k}" must be a whole number.` };
      if (spec.minimum !== undefined && v < spec.minimum) return { error: `"${k}" must be at least ${spec.minimum}.` };
      if (spec.maximum !== undefined && v > spec.maximum) return { error: `"${k}" must be at most ${spec.maximum}.` };
    } else if (spec.type === 'boolean') {
      if (v === 'true') v = true; else if (v === 'false') v = false;
      if (typeof v !== 'boolean') return { error: `"${k}" must be true or false.` };
    }
    out[k] = v;
  }
  return { value: out };
}

const rpcResult = (id, result) => ({
  jsonrpc: '2.0', id,
  result: { ...result, resultType: 'complete', _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO } },
});
const rpcError = (id, code, message, data) =>
  ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

function originAllowed(origin) {
  if (origin === null) return true;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

function decodeHeaderValue(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v || '');
  if (!m) return v;
  try {
    const bin = atob(m[1]);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  } catch (_) { return null; }
}

// Which era a request is from, and whether its headers agree with its body.
function mcpEra(m, headers) {
  if (m.method === 'initialize') return { modern: false };
  const hv = (headers.get('MCP-Protocol-Version') || '').trim() || null;
  const meta = m.params && typeof m.params === 'object' ? m.params._meta : undefined;
  const mv = meta && typeof meta === 'object' ? meta['io.modelcontextprotocol/protocolVersion'] : undefined;
  const fail = (status, code, message, data) => ({ error: { status, body: rpcError(m.id, code, message, data) } });
  const unsupported = requested => fail(400, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested });

  if (mv === undefined || MCP_LEGACY_VERSIONS.includes(mv)) {
    if (hv && !MCP_LEGACY_VERSIONS.includes(hv)) {
      if (MCP_MODERN_VERSIONS.includes(hv)) {
        return fail(400, -32602, 'Invalid params: a request at protocol version 2026-07-28 must carry _meta["io.modelcontextprotocol/protocolVersion"] and _meta["io.modelcontextprotocol/clientCapabilities"]');
      }
      return unsupported(hv);
    }
    return { modern: false };
  }
  if (typeof mv !== 'string') return fail(400, -32602, 'Invalid params: _meta["io.modelcontextprotocol/protocolVersion"] must be a string');
  if (!hv) return fail(400, -32020, 'Header mismatch: the MCP-Protocol-Version header is missing');
  if (hv !== mv) return fail(400, -32020, `Header mismatch: MCP-Protocol-Version header value '${hv}' does not match body value '${mv}'`);
  if (!MCP_MODERN_VERSIONS.includes(mv)) return unsupported(mv);
  const caps = meta['io.modelcontextprotocol/clientCapabilities'];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return fail(400, -32602, 'Invalid params: _meta["io.modelcontextprotocol/clientCapabilities"] is required');
  }
  const hm = headers.get('Mcp-Method');
  if (hm === null) return fail(400, -32020, 'Header mismatch: the Mcp-Method header is missing');
  if (hm !== m.method) return fail(400, -32020, `Header mismatch: Mcp-Method header value '${hm}' does not match body value '${m.method}'`);
  if (m.method === 'tools/call') {
    const hn = headers.get('Mcp-Name');
    const name = m.params && m.params.name;
    if (hn === null) return fail(400, -32020, 'Header mismatch: the Mcp-Name header is missing');
    if (decodeHeaderValue(hn) !== name) return fail(400, -32020, `Header mismatch: Mcp-Name header value '${hn}' does not match body value '${name}'`);
  }
  return { modern: true };
}

async function callTool(rc, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.name !== 'string') {
    return { error: [-32602, 'Invalid params: tools/call needs params.name (a string)'] };
  }
  const tool = TOOLS_BY_NAME.get(params.name);
  if (!tool) return { error: [-32602, `Unknown tool: ${params.name}`, { tools: MCP_TOOLS.map(t => t.name) }] };
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) return { error: [-32602, 'Invalid params: arguments must be an object'] };

  const checked = validateArgs(tool.inputSchema, args);
  if (checked.error) {
    return { result: { content: [{ type: 'text', text: `${tool.name}: ${checked.error}` }], isError: true } };
  }
  const [sub, query] = tool.route(checked.value);
  const out = await cachedRoute(rc, sub, query);
  let data;
  try { data = JSON.parse(out.text); } catch (_) { data = { error: 'unreadable answer' }; }
  if (out.status === 200) {
    return { result: { content: [{ type: 'text', text: out.text }], structuredContent: data, isError: false } };
  }
  const retry = out.status === 503 || out.status === 504 ? ' It may be worth retrying in a minute.' : '';
  return { result: {
    content: [{ type: 'text', text: `${tool.name} failed (HTTP ${out.status}): ${data.error || 'error'}${data.detail ? ` — ${data.detail}` : ''}${retry}` }],
    structuredContent: { status: out.status, ...data },
    isError: true,
  } };
}

async function handleRpc(m, request, env, ctx, url) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') {
    return { status: 400, body: rpcError(m && typeof m === 'object' && !Array.isArray(m) ? m.id ?? null : null, -32600, 'Invalid Request: not a JSON-RPC 2.0 message') };
  }
  const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
  if (typeof m.method !== 'string') {
    // A response from the client (to a request this server never sends): accepted and ignored.
    if (hasId && (Object.prototype.hasOwnProperty.call(m, 'result') || Object.prototype.hasOwnProperty.call(m, 'error'))) return { status: 202, body: null };
    return { status: 400, body: rpcError(hasId ? m.id : null, -32600, 'Invalid Request: no method') };
  }
  if (!hasId) return { status: 202, body: null };               // a notification: nothing to answer
  if (!(typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)))) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: id must be a string or a number') };
  }
  if (m.params !== undefined && (m.params === null || typeof m.params !== 'object' || Array.isArray(m.params))) {
    return { status: 200, body: rpcError(m.id, -32602, 'Invalid params: params must be an object') };
  }
  const era = mcpEra(m, request.headers);
  if (era.error) return era.error;
  const notFoundStatus = era.modern ? 404 : 200;

  switch (m.method) {
    case 'initialize': {
      const asked = m.params && m.params.protocolVersion;
      const version = MCP_LEGACY_VERSIONS.includes(asked) ? asked : MCP_LATEST_LEGACY;
      return { status: 200, body: rpcResult(m.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      }) };
    }
    case 'server/discover':
      return { status: 200, body: rpcResult(m.id, {
        supportedVersions: MCP_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: MCP_INSTRUCTIONS,
        ttlMs: 3600000,
        cacheScope: 'public',
      }) };
    case 'ping':
      return { status: 200, body: rpcResult(m.id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(m.id, { tools: TOOL_LIST, ttlMs: 3600000, cacheScope: 'public' }) };
    case 'tools/call': {
      const rc = makeRc(env, ctx, url);
      const out = await callTool(rc, m.params);
      if (out.error) return { status: 200, body: rpcError(m.id, ...out.error) };
      return { status: 200, body: rpcResult(m.id, out.result) };
    }
    default:
      return { status: notFoundStatus, body: rpcError(m.id, -32601, `Method not found: ${m.method}`) };
  }
}

// The body, or null past `max` bytes — read as a stream and abandoned at the
// cap, so a chunked upload with no Content-Length cannot make the Worker
// buffer more than the 64 KB any MCP message needs.
async function readCapped(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch (_) { /* already gone */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

function mcpResponse(status, body, headers = {}, rate = null) {
  return jsonResponse(status, body, { 'Cache-Control': 'no-store', ...(rate ? rateHeaders(rate) : {}), ...headers });
}

async function handleMcp(request, env, ctx, url) {
  const origin = request.headers.get('Origin');
  if (!originAllowed(origin)) {
    return mcpResponse(403, rpcError(null, -32600, `Origin ${origin} is not allowed: use an https origin, localhost, or no browser at all.`));
  }
  if (request.method !== 'POST') {
    return mcpResponse(405, rpcError(null, -32600, 'The MCP endpoint takes JSON-RPC over POST. It offers no event stream on GET and has no sessions to DELETE.'),
      { Allow: 'POST, OPTIONS' });
  }
  const ctype = request.headers.get('Content-Type') || '';
  if (!/^application\/json\b/i.test(ctype.trim())) {
    return mcpResponse(415, rpcError(null, -32600, 'Content-Type must be application/json.'));
  }
  const tooBig = () => mcpResponse(413, rpcError(null, -32600, `The request body is over ${LIMITS.mcpBodyMaxBytes} bytes.`));
  if (Number(request.headers.get('Content-Length') || 0) > LIMITS.mcpBodyMaxBytes) return tooBig();
  const text = await readCapped(request, LIMITS.mcpBodyMaxBytes);
  if (text === null) return tooBig();
  let msg;
  try { msg = JSON.parse(text); } catch (_) {
    return mcpResponse(400, rpcError(null, -32700, 'Parse error: the body is not JSON.'));
  }
  const batch = Array.isArray(msg);
  const messages = batch ? msg : [msg];
  if (batch && !messages.length) return mcpResponse(400, rpcError(null, -32600, 'Invalid Request: an empty batch.'));
  if (messages.length > LIMITS.mcpBatchMax) {
    return mcpResponse(400, rpcError(null, -32600, `Invalid Request: a batch of ${messages.length} is over the ${LIMITS.mcpBatchMax}-message limit.`));
  }

  // Every message counts against the limits: a batch of ten tool calls is ten.
  const rate = await rateLimit(request, env, url, messages.length);
  if (!rate.ok) {
    const data = { retry_after: rate.retryAfter, limit: rate.rule };
    const errs = messages
      .filter(x => x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, 'id') && typeof x.method === 'string')
      .map(x => rpcError(x.id, -32000, `Rate limited: ${rateDetail(rate)}`, data));
    return mcpResponse(429, batch ? (errs.length ? errs : rpcError(null, -32000, `Rate limited: ${rateDetail(rate)}`, data))
      : (errs[0] || rpcError(null, -32000, `Rate limited: ${rateDetail(rate)}`, data)),
    { 'Retry-After': String(rate.retryAfter) }, rate);
  }

  const results = [];
  for (const m of messages) {
    try {
      results.push(await handleRpc(m, request, env, ctx, url));
    } catch (err) {
      results.push({ status: 200, body: rpcError(m && m.id !== undefined ? m.id : null, -32603, `Internal error: ${(err && err.message) || err}`) });
    }
  }
  if (!batch) {
    const r = results[0];
    if (!r.body) return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSE, ...rateHeaders(rate) } });
    return mcpResponse(r.status || 200, r.body, {}, rate);
  }
  const bodies = results.map(r => r.body).filter(Boolean);
  if (!bodies.length) return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSE, ...rateHeaders(rate) } });
  return mcpResponse(200, bodies, {}, rate);
}

// ── Entry points, for worker/index.js ────────────────────────────────────────

export function isApiPath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)
      || pathname === MCP_PATH || pathname === `${MCP_PATH}/`;
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const isMcp = url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/`;
  try {
    if (request.method === 'OPTIONS') {
      if (isMcp && !originAllowed(request.headers.get('Origin'))) {
        return mcpResponse(403, rpcError(null, -32600, 'Origin not allowed.'));
      }
      return preflight(request, isMcp);
    }
    if (isMcp) return await handleMcp(request, env || {}, ctx, url);
    return await handleRest(request, env || {}, ctx, url);
  } catch (err) {
    return jsonResponse(500, { error: 'internal error', detail: String((err && err.message) || err) }, { 'Cache-Control': 'no-store' });
  }
}
