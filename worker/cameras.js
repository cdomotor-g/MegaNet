// /api/cameras/* — the councils' and QLDTraffic's camera pictures, for the
// Stations map's flood and road cameras (map-cameras.js) and the station card's
// cameras section.
//
// Most Queensland councils show flood and road cameras on their disaster
// dashboards, TMR publishes its own flood cameras on QLDTraffic, and
// tools/council_cameras.py gathers every one of them into
// data/council-cameras.json each week: where each camera is, what the council
// calls it, and where its latest picture is published. The pictures stay on
// the councils' servers (and their vendors': Envault, Disaster Watch,
// Sightmaster, QLDTraffic…). This route fetches the latest one when somebody
// opens a camera — nothing is stored anywhere but the edge cache, for minutes.
//
//   GET /api/cameras              {cameras, councils, generated, catalog, fresh_s, keep_s}
//   GET /api/cameras/<id>         the camera's latest picture (its first view)
//   GET /api/cameras/<id>/<n>     the n-th of a camera that looks several ways (from 0)
//
// ── Why through here, and not the council's address in an <img> ─────────────
//
//   * How old it is. Most of the servers say when their picture last changed
//     (Last-Modified), and a dry crossing in a picture from yesterday is the
//     most dangerous thing this layer could show. An <img> cannot read a
//     header from another origin, and few of these servers send CORS; this
//     route passes Last-Modified on with CORS open, and says when it fetched
//     the picture itself (X-Camera-Fetched), so the viewer can say "taken
//     12 minutes ago" — or "this picture is 3 days old".
//   * Kindness to the councils. A council's dashboard is under the most load
//     on the day this layer is most used. However many people open the same
//     camera, its server is asked at most once a minute per Cloudflare
//     location (FRESH_S), and a burst in one isolate is one request.
//   * A picture when the council's server is down. The last one fetched is
//     kept for KEEP_S and served in its place, marked X-Camera-Stale with the
//     reason, so the viewer says what it is showing and how old it is.
//   * Plain http and broken certificates, which a few dashboards' cameras
//     have, are this side's problem rather than a mixed-content block.
//
// The viewer falls back to the council's own address when this route cannot
// answer at all, saying that it cannot tell how old that picture is.
//
// ── What it will fetch ───────────────────────────────────────────────────────
//
// Only the pictures in the catalog, by the camera's id: nothing from the
// request names an address, so this is not a proxy anybody can point
// anywhere. The catalog is the committed file, read through the static
// assets binding (wrangler.toml's [assets] binding = "ASSETS") the first time
// an isolate needs it — the bundle every other route loads stays as it was.
// A camera's answer must be a JPEG, PNG, GIF or WebP by its own first bytes
// (several servers say binary/octet-stream, and one says text/html when the
// camera is down), no larger than MAX_BYTES, inside TIMEOUT_MS.
//
// ── Brakes ───────────────────────────────────────────────────────────────────
//
// The edge cache's key is the camera and the view, and nothing else — a query
// string cannot make it ask the council again — so what reaches a council is
// bounded whatever arrives here. There is no per-caller limit: everything
// served is public, the council's own dashboard serves the same picture to
// anybody, and a flood of requests here costs this Worker's daily allowance
// exactly as it would on any other public route.
//
// CORS is open (`*`): nothing here depends on who is asking, and the github.io
// copy and local checkouts ask floodwarning.net for these. The responses carry
// the same document lock as /api/photos — a picture is never a page.
//
// Header values here are ASCII on purpose (X-Camera-Stale carries a sentence).

const PREFIX = '/api/cameras';
export const CATALOG_PATH = '/data/council-cameras.json';
export const DOC_URL = 'https://floodwarning.net/docs/council-cameras.md';

// A picture fetched less than FRESH_S ago is served as it stands; most of
// these cameras change every 1 to 15 minutes, and a minute is as fresh as the
// fastest of them.
export const FRESH_S = 60;
// How long the last good picture stands in for one the council's server will
// not give. Past this the viewer says the camera could not be reached.
export const KEEP_S = 6 * 60 * 60;
// The largest camera picture in the catalog is about 1 MB.
export const MAX_BYTES = 8 * 1024 * 1024;
export const TIMEOUT_MS = 10000;
export const USER_AGENT = `Flood-Net council cameras (+${DOC_URL})`;

const ID_RE = /^[a-z0-9-]{1,80}$/;
const VIEW_RE = /^\d{1,2}$/;

export function isCameraPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-Modified-Since',
  'Access-Control-Expose-Headers': 'Last-Modified, X-Camera-Fetched, X-Camera-Stale',
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

// ── The catalog ──────────────────────────────────────────────────────────────

// The id of every camera and the addresses of its pictures, and nothing else:
// a camera with no http(s) picture is no camera here.
export function indexCatalog(body) {
  const byId = new Map();
  for (const cam of (body && Array.isArray(body.cameras)) ? body.cameras : []) {
    if (!cam || typeof cam.id !== 'string' || !ID_RE.test(cam.id) || !Array.isArray(cam.views)) continue;
    const views = cam.views.map(v => v && v.url).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (views.length) byId.set(cam.id, views);
  }
  const meta = (body && body.meta) || {};
  return { byId, generated: meta.generated || null, councils: Number(meta.councils) || 0 };
}

let catalogP = null;

function catalog(env, origin) {
  if (!catalogP) {
    catalogP = (async () => {
      if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw Object.assign(new Error('the static assets binding (ASSETS) is not set'), { unbound: true });
      }
      const res = await env.ASSETS.fetch(new Request(`${origin}${CATALOG_PATH}`));
      if (!res.ok) throw new Error(`the camera catalog answered HTTP ${res.status}`);
      return indexCatalog(await res.json());
    })();
    // A failure is not kept: the next request asks again.
    catalogP.catch(() => { catalogP = null; });
  }
  return catalogP;
}

// ── A picture ────────────────────────────────────────────────────────────────

// What the bytes are, by their own first bytes; null for anything else.
export function sniff(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// The body, refusing to read past `cap` bytes: null if it is longer.
async function readCapped(body, cap) {
  if (!body) return new Uint8Array(0);
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
  const out = new Uint8Array(n);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

function drop(res) {
  try { if (res && res.body) res.body.cancel(); } catch (_) { /* nothing to let go */ }
}

async function fetchPicture(url, deps) {
  let res;
  try {
    res = await deps.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const why = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? `did not answer within ${TIMEOUT_MS / 1000} s` : 'could not be reached';
    throw new Error(`the camera's server ${why}`);
  }
  if (!res.ok) {
    drop(res);
    throw new Error(`the camera's server answered HTTP ${res.status}`);
  }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    drop(res);
    throw new Error(`the picture is larger than ${MAX_BYTES / 1048576} MB`);
  }
  const bytes = await readCapped(res.body, MAX_BYTES);
  if (!bytes) throw new Error(`the picture is larger than ${MAX_BYTES / 1048576} MB`);
  const type = sniff(bytes);
  if (!type) {
    const said = String(res.headers.get('content-type') || 'nothing').split(';')[0].replace(/[^\x20-\x7e]/g, '');
    throw new Error(`the camera's server sent something that is not a picture (${said})`);
  }
  const lm = Date.parse(res.headers.get('last-modified') || '');
  return { bytes, type, lastModified: isFinite(lm) ? new Date(lm).toUTCString() : null, fetchedMs: deps.now() };
}

// The copy kept in the edge cache: the picture and when it was fetched, kept
// for KEEP_S. Its own header names, so the cache keys freshness on nothing
// but the max-age given here.
function toCached(pic) {
  const headers = new Headers({
    'Content-Type': pic.type,
    'Cache-Control': `public, max-age=${KEEP_S}`,
    'X-Camera-Fetched-Ms': String(pic.fetchedMs),
  });
  if (pic.lastModified) headers.set('X-Camera-Last-Modified', pic.lastModified);
  return new Response(pic.bytes.slice(0), { status: 200, headers });
}

async function fromCached(res) {
  const fetchedMs = Number(res.headers.get('X-Camera-Fetched-Ms'));
  if (!isFinite(fetchedMs) || fetchedMs <= 0) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return null;
  return { bytes, type, lastModified: res.headers.get('X-Camera-Last-Modified') || null, fetchedMs };
}

// One upstream request per picture at a time in this isolate: the rest of a
// burst waits for the first one's answer.
const inflight = new Map();

function once(key, job) {
  let p = inflight.get(key);
  if (!p) {
    p = job().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

function send(request, pic, stale, deps) {
  const age = Math.max(0, Math.floor((deps.now() - pic.fetchedMs) / 1000));
  const headers = new Headers(OPEN);
  headers.set('Content-Type', pic.type);
  headers.set('Cache-Control', stale ? 'no-store' : `public, max-age=${Math.max(0, FRESH_S - age)}`);
  headers.set('X-Camera-Fetched', new Date(pic.fetchedMs).toISOString());
  if (pic.lastModified) headers.set('Last-Modified', pic.lastModified);
  if (stale) headers.set('X-Camera-Stale', stale.replace(/[^\x20-\x7e]/g, '').slice(0, 200));
  const since = request.headers.get('If-Modified-Since');
  if (!stale && pic.lastModified && since && since === pic.lastModified) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : pic.bytes.slice(0), { status: 200, headers });
}

async function picture(request, ctx, deps, cam, views, n, origin) {
  const address = views[n];
  const key = `${origin}${PREFIX}/${cam}/${n}`;
  let hit = null;
  if (deps.cache) {
    try { hit = await deps.cache.match(new Request(key)); } catch (_) { hit = null; }
  }
  const heldMs = hit ? Number(hit.headers.get('X-Camera-Fetched-Ms')) : NaN;
  if (hit && isFinite(heldMs) && (deps.now() - heldMs) / 1000 < FRESH_S) {
    const held = await fromCached(hit);
    if (held) return send(request, held, null, deps);
    hit = null;
  }
  try {
    const pic = await once(key, async () => {
      const got = await fetchPicture(address, deps);
      if (deps.cache) {
        const put = deps.cache.put(new Request(key), toCached(got)).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
      }
      return got;
    });
    return send(request, pic, null, deps);
  } catch (err) {
    const held = hit ? await fromCached(hit).catch(() => null) : null;
    if (held) return send(request, held, err.message, deps);
    return json({ error: err.message, camera: cam, view: n }, 502);
  }
}

// ── The route ────────────────────────────────────────────────────────────────

function defaults(deps) {
  return {
    fetch: deps.fetch || ((...a) => fetch(...a)),
    cache: deps.cache !== undefined ? deps.cache
      : (typeof caches !== 'undefined' && caches.default ? caches.default : null),
    now: deps.now || Date.now,
  };
}

export async function handleCameras(request, env, ctx, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'GET only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  const d = defaults(deps);
  const url = new URL(request.url);
  const rest = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '');
  const parts = rest ? rest.split('/') : [];

  let cat;
  try {
    cat = await catalog(env, url.origin);
  } catch (err) {
    return json({ error: `the camera catalog could not be read: ${err.message}`, unbound: !!err.unbound },
                err.unbound ? 503 : 502);
  }

  if (!parts.length) {
    return json({
      cameras: cat.byId.size, councils: cat.councils, generated: cat.generated,
      catalog: CATALOG_PATH, doc: DOC_URL, fresh_s: FRESH_S, keep_s: KEEP_S,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (parts.length > 2 || !ID_RE.test(parts[0]) || (parts[1] !== undefined && !VIEW_RE.test(parts[1]))) {
    return json({ error: 'not a camera address: /api/cameras/<id> or /api/cameras/<id>/<n>' }, 404);
  }
  const views = cat.byId.get(parts[0]);
  if (!views) return json({ error: `there is no camera ${parts[0]} in the catalog`, camera: parts[0] }, 404);
  const n = parts[1] === undefined ? 0 : Number(parts[1]);
  if (n >= views.length) {
    return json({ error: `camera ${parts[0]} has ${views.length} picture${views.length === 1 ? '' : 's'}`, camera: parts[0] }, 404);
  }
  return picture(request, ctx, d, parts[0], views, n, url.origin);
}

// Read by the check and by nothing else.
export const _test = {
  reset() { catalogP = null; inflight.clear(); },
  inflight: () => inflight.size,
};
