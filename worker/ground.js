// /api/ground/* — map tiles of what stands on the ground round the stations,
// kept in R2, for the ⛰️ 3-D view and the digital twin (#278).
//
//   GET  /api/ground/<layer>/<z>/<x>/<y>.pbf   one vector tile; 204 where there is none
//   HEAD (same path)                           the same, no body
//   GET  /api/ground/<layer>/meta.json         what the build tool says of the layer; 404 until built
//   PUT  (either path)                         the project's secret key only; replaces it
//
// The first layer is `qld-buildings`: the State's building outlines, drawn from
// its own LiDAR, each with its height above the ground and its eave height.
// The State's service answers queries, not map tiles, so a map that asked it
// directly would send a fresh query for every pan and zoom and wait on the
// State's server each time; tiles cut once and kept here are read the way the
// map reads its other layers. docs/ground-cover-sources.md has the research
// ("Buildings: the State's LiDAR outlines in Queensland, Overture everywhere
// else") and "How the app reaches them".
//
// ── Where the tiles live ─────────────────────────────────────────────────────
//
// In the PHOTOS bucket (meganet-photos), under `_ground/<layer>/` — the same
// bucket the field photos and the notify list use, because a new bucket has to
// be made by hand in the dashboard before a binding to it can deploy. Nothing
// else in the Worker reads or lists that prefix: /api/photos only knows its own
// photo buckets' paths.
//
// ── Who may write ────────────────────────────────────────────────────────────
//
// Reading is for anybody: the outlines are CC BY 4.0, and CORS is open (`*`).
// Writing is for the build tool alone, with the project's secret key — the same
// check /api/archive's PUT makes (whoIs, worker/photos.js, says 'service' only
// for a key the project's auth admin API accepts). An editor's session is not
// enough. The key is never logged or echoed. A PUT replaces what is there: a
// layer is rebuilt when the State adds survey areas. There is no DELETE.
//
// A tile is a Mapbox Vector Tile, unpacked or gzipped, at most MAX_TILE_BYTES;
// a gzipped one is stored and served as gzip (Content-Encoding), so it is
// never packed twice. meta.json must be a JSON object, at most MAX_META_BYTES.
//
// A tile nobody wrote answers 204 No Content: MapLibre draws that as an empty
// tile without logging an error, and most tiles of a State are empty of
// buildings.

import { whoIs } from './photos.js';

const PREFIX = '/api/ground';
export const KEY_PREFIX = '_ground/';
export const LAYERS = ['qld-buildings'];
export const MAX_ZOOM = 18;
export const MAX_TILE_BYTES = 4 * 1048576;
export const MAX_META_BYTES = 1048576;
export const TILE_CACHE = 'public, max-age=86400';
// An empty tile may be filled by the next build, so it is kept for less.
export const EMPTY_CACHE = 'public, max-age=3600';
export const META_CACHE = 'public, max-age=300';
const TILE_TYPE = 'application/x-protobuf';
const META_TYPE = 'application/json';

const N = '(0|[1-9]\\d{0,6})';
const TILE_RE = new RegExp(`^([a-z0-9-]{1,40})/${N}/${N}/${N}\\.pbf$`);
const META_RE = /^([a-z0-9-]{1,40})\/meta\.json$/;

const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

export function isGroundPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// What a path names — {kind: 'tile'|'meta', layer, key} — or null.
export function groundTarget(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${PREFIX}/`)) return null;
  const rest = pathname.slice(PREFIX.length + 1);
  let m = TILE_RE.exec(rest);
  if (m) {
    const [, layer, zs, xs, ys] = m;
    const z = Number(zs), x = Number(xs), y = Number(ys);
    if (!LAYERS.includes(layer) || z > MAX_ZOOM) return null;
    const n = 2 ** z;
    if (x >= n || y >= n) return null;
    return { kind: 'tile', layer, key: `${KEY_PREFIX}${layer}/${z}/${x}/${y}.pbf` };
  }
  m = META_RE.exec(rest);
  if (m && LAYERS.includes(m[1])) return { kind: 'meta', layer: m[1], key: `${KEY_PREFIX}${m[1]}/meta.json` };
  return null;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...OPEN, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
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
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

const isGzip = b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
// An unpacked vector tile is a run of `layers` (field 3, length-delimited),
// so its first byte is that field's tag.
const isTile = b => b.length >= 1 && b[0] === 0x1a;

async function put(request, env, t) {
  if ((await whoIs(request)) !== 'service') {
    return json({ error: 'ground tiles are written with the project\'s secret key only' }, 401);
  }
  const cap = t.kind === 'tile' ? MAX_TILE_BYTES : MAX_META_BYTES;
  const limit = `over the ${cap / 1048576} MB limit for ${t.kind === 'tile' ? 'a tile' : 'meta.json'}`;
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > cap) return json({ error: limit }, 413);
  const bytes = await readCapped(request.body, cap);
  if (!bytes) return json({ error: limit }, 413);
  if (!bytes.length) {
    return json({ error: t.kind === 'tile' ? 'an empty tile is no tile: leave it out and it answers 204' : 'meta.json is empty' }, 400);
  }

  let httpMetadata;
  if (t.kind === 'tile') {
    if (!isGzip(bytes) && !isTile(bytes)) return json({ error: 'not a vector tile (a Mapbox Vector Tile, unpacked or gzipped)' }, 400);
    httpMetadata = { contentType: TILE_TYPE, ...(isGzip(bytes) ? { contentEncoding: 'gzip' } : {}) };
  } else {
    let doc;
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { doc = null; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return json({ error: 'meta.json must be a JSON object' }, 400);
    httpMetadata = { contentType: META_TYPE };
  }
  const obj = await env.PHOTOS.put(t.key, bytes, { httpMetadata });
  if (!obj || obj.size !== bytes.length) return json({ error: 'the object was not stored whole — send it again' }, 500);
  return json({ key: t.key, size: obj.size }, 200);
}

async function get(request, env, t) {
  const head = request.method === 'HEAD';
  const obj = head ? await env.PHOTOS.head(t.key) : await env.PHOTOS.get(t.key);
  if (!obj) {
    if (t.kind === 'tile') return new Response(null, { status: 204, headers: { ...OPEN, 'Cache-Control': EMPTY_CACHE } });
    return json({ error: `${t.layer} has not been built yet`, layer: t.layer }, 404);
  }
  const headers = new Headers(OPEN);
  headers.set('Content-Type', t.kind === 'tile' ? TILE_TYPE : META_TYPE);
  headers.set('Content-Length', String(obj.size));
  headers.set('Cache-Control', t.kind === 'tile' ? TILE_CACHE : META_CACHE);
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  const gzipped = t.kind === 'tile' && obj.httpMetadata && obj.httpMetadata.contentEncoding === 'gzip';
  if (gzipped) headers.set('Content-Encoding', 'gzip');
  // encodeBody 'manual': the bytes are gzip already, and the runtime must not
  // pack them again.
  return new Response(head ? null : obj.body, { status: 200, headers, ...(gzipped ? { encodeBody: 'manual' } : {}) });
}

export async function handleGround(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  const t = groundTarget(new URL(request.url).pathname);
  if (!t) {
    return json({ error: `not a ground address: /api/ground/<layer>/<z>/<x>/<y>.pbf or /api/ground/<layer>/meta.json, the layer one of ${LAYERS.join(', ')}` }, 404);
  }
  if (!env || !env.PHOTOS) return json({ error: 'the R2 bucket is not bound', unbound: true }, 503);
  try {
    switch (request.method) {
      case 'GET': case 'HEAD': return await get(request, env, t);
      case 'PUT': return await put(request, env, t);
      default: return json({ error: 'GET, HEAD or PUT' }, 405, { Allow: 'GET, HEAD, PUT, OPTIONS' });
    }
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
