// /api/photos/* — the field photos' bytes, kept in Cloudflare R2.
//
// Supabase's free plan holds 1 GB of storage for the whole organisation and
// lets 5 GB a month out of it, and a crew's zip of site photos is 2 GB on its
// own. R2 holds 10 GB free, charges nothing to read out of, and is a binding on
// this Worker rather than another service to sign in to. So the bytes moved;
// everything *about* a photo — where it was taken, which station, who added it,
// its hash — stays in meganet.field_photo, and every rule about what may be
// added is still meganet.add_field_photo()'s. This route only carries bytes.
//
// ── Who may do what ──────────────────────────────────────────────────────────
//
// The same people the Supabase bucket let in (tools/storage_bucket.sql:
// `meganet.is_editor()` for read, write and delete), decided the same way: the
// caller's own Supabase token is put to `rpc/is_editor` on the project, and the
// project answers. Nothing here reads a token's claims and trusts them; the
// database verifies the signature and gives the verdict. The scheduled Dropbox
// and Google Drive syncs, and the one-off move out of Supabase, carry the
// project's secret key instead, which the project also verifies (an admin
// endpoint answers 200 to it and to nothing else).
//
//   POST   /api/photos/sign                  editor: {bucket, paths, expiresIn}
//                                            → {urls: {path: url}, missing: [path]}
//   PUT    /api/photos/<bucket>/<path>       editor or sync: the bytes, create-only
//   DELETE /api/photos/<bucket>/<path>       editor or sync
//   GET    /api/photos/<bucket>/<path>?e=&s= anyone holding a signed URL
//
// An <img> cannot send a bearer token, so a view is a URL signed here with an
// HMAC and an expiry, as Supabase's signed URLs were. The key is 32 random bytes
// this Worker makes the first time it needs one and keeps in the bucket itself,
// under a prefix no path this route accepts can reach — so there is no secret
// for anybody to set, rotate or leak into a repo.
//
// `missing` is how the app gets through the move: a photo still in Supabase is
// signed there instead (datastore.js), until the migration has carried it over.
//
// ── Without the binding ──────────────────────────────────────────────────────
//
// Every route answers 503 {unbound: true} when env.PHOTOS is not bound, and the
// app and the syncs read that as "use Supabase Storage, as before". Deploying
// this file before R2 is switched on changes nothing.
//
// CORS is open (`*`): no request here carries a cookie that means anything, only
// a bearer token or a signature, so an origin gains nothing by being allowed —
// and github.io and local checkouts need to reach floodwarning.net for bytes.

import { PUBLISHABLE_KEY } from './api.js';

const SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const PREFIX = '/api/photos/';

// Buckets this route serves. `inspections` (attachments) stays in Supabase: it
// is small, and its paths are filed under records rather than under photo/.
export const PHOTO_BUCKETS = ['field-photos'];

// meganet.add_field_photo() insists on `photo/<uuid>.<ext>` and a thumbnail at
// `photo/<uuid>.thumb.jpg`, so nothing else is ever a real object.
const PATH_RE = /^photo\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.thumb\.jpg|\.[a-z0-9]{2,5})$/i;

// The Supabase bucket's own limit (tools/storage_bucket.sql), kept.
export const MAX_BYTES = 26214400;

// Raster formats only — an SVG is a document that runs script, not a photo.
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
               'image/gif', 'image/tiff', 'image/avif'];

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
                    heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', tif: 'image/tiff',
                    tiff: 'image/tiff', avif: 'image/avif' };
function typeOfPath(path) { return EXT_TYPES[path.split('.').pop().toLowerCase()] || ''; }

const MAX_SIGN_PATHS = 500;
const MAX_EXPIRY_S = 24 * 3600;
const KEY_OBJECT = '_meganet/url-signing-key';
const AUTH_TTL_MS = 60 * 1000;

let signingKey = null;          // CryptoKey, per isolate
const authCache = new Map();    // sha256(token) → { who, until }

export function isPhotoPath(pathname) {
  return typeof pathname === 'string' && (pathname === '/api/photos' || pathname.startsWith(PREFIX));
}

// `/api/photos/<bucket>/<path>` → {bucket, path}, or null. Exported so
// test/photo-store.mjs can assert the refusals.
export function photoTarget(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX)) return null;
  let rest;
  try { rest = decodeURIComponent(pathname.slice(PREFIX.length)); } catch (_) { return null; }
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const bucket = rest.slice(0, slash), path = rest.slice(slash + 1);
  if (!PHOTO_BUCKETS.includes(bucket) || !PATH_RE.test(path)) return null;
  return { bucket, path };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-upsert',
  'Access-Control-Max-Age': '86400',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// The key: read out of the bucket, or made and put there. Two isolates racing
// on the very first request each put one; both then read back whichever landed
// last, so at worst a URL or two signed in that instant has to be signed again.
async function urlKey(bucket) {
  if (signingKey) return signingKey;
  let obj = await bucket.get(KEY_OBJECT);
  if (!obj) {
    await bucket.put(KEY_OBJECT, crypto.getRandomValues(new Uint8Array(32)));
    obj = await bucket.get(KEY_OBJECT);
  }
  signingKey = await hmacKey(await obj.arrayBuffer());
  return signingKey;
}

// What a signature covers: the bucket, the path and the expiry, newline-joined
// so no choice of path can shift a boundary.
export async function signPath(key, bucket, path, exp) {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${bucket}\n${path}\n${exp}`));
  return b64url(mac);
}

export async function verifyPath(key, bucket, path, exp, sig, now = Date.now()) {
  if (!/^\d{1,12}$/.test(String(exp || '')) || typeof sig !== 'string' || !sig) return false;
  if (Number(exp) * 1000 < now) return false;
  const want = await signPath(key, bucket, path, exp);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// Who is this bearer: 'editor', 'service', or null. Asked of the project, and
// remembered for a minute so a page of sixty thumbnails is one question.
async function whoIs(request, fetchImpl = fetch) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const token = m[1];
  const h = await sha256(token);
  const hit = authCache.get(h);
  if (hit && hit.until > Date.now()) return hit.who;

  let who = null;
  if (!token.startsWith('sb_secret_')) {
    try {
      const res = await fetchImpl(`${SUPABASE_URL}/rest/v1/rpc/is_editor`, {
        method: 'POST',
        headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`,
                   'Content-Profile': 'meganet', 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok && (await res.json()) === true) who = 'editor';
    } catch (_) { /* not answered: not admitted */ }
  }
  if (!who) {
    // A secret key (new `sb_secret_…` or a legacy service_role JWT) is the only
    // thing the auth admin API answers 200 to.
    try {
      const res = await fetchImpl(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: { apikey: token, Authorization: `Bearer ${token}` },
      });
      if (res.ok) who = 'service';
    } catch (_) { /* ditto */ }
  }
  if (authCache.size > 500) authCache.clear();
  authCache.set(h, { who, until: Date.now() + AUTH_TTL_MS });
  return who;
}

async function sign(request, env, url) {
  if (!(await whoIs(request))) return json({ error: 'sign in as an editor to see field photos' }, 401);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'expected a JSON body' }, 400); }
  const bucket = body && body.bucket;
  if (!PHOTO_BUCKETS.includes(bucket)) return json({ error: `not a photo bucket: ${bucket}` }, 400);
  const paths = [...new Set(Array.isArray(body.paths) ? body.paths : [])];
  if (paths.length > MAX_SIGN_PATHS) return json({ error: `at most ${MAX_SIGN_PATHS} paths at once` }, 400);
  const expiresIn = Math.min(MAX_EXPIRY_S, Math.max(60, Number(body.expiresIn) || 3600));
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const key = await urlKey(env.PHOTOS);

  const urls = {}, missing = [];
  await Promise.all(paths.map(async p => {
    if (typeof p !== 'string' || !PATH_RE.test(p)) return;
    // A head is a class B operation — ten million a month free — and it is what
    // lets a photo still in Supabase be signed there instead of drawn broken.
    if (!(await env.PHOTOS.head(`${bucket}/${p}`))) { missing.push(p); return; }
    const s = await signPath(key, bucket, p, exp);
    urls[p] = `${url.origin}${PREFIX}${bucket}/${p}?e=${exp}&s=${s}`;
  }));
  return json({ urls, missing }, 200);
}

async function serve(request, env, url, t) {
  const key = await urlKey(env.PHOTOS);
  const exp = url.searchParams.get('e'), sig = url.searchParams.get('s');
  if (!(await verifyPath(key, t.bucket, t.path, exp, sig))) {
    return json({ error: 'this link has expired or was not signed here' }, 403);
  }
  const obj = request.method === 'HEAD'
    ? await env.PHOTOS.head(`${t.bucket}/${t.path}`)
    : await env.PHOTOS.get(`${t.bucket}/${t.path}`);
  if (!obj) return json({ error: 'no such photo' }, 404);
  const left = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
  const headers = new Headers({
    'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
    'Content-Length': String(obj.size),
    'Cache-Control': `private, max-age=${left}`,
    ETag: obj.httpEtag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...CORS,
  });
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

async function put(request, env, t) {
  if (!(await whoIs(request))) return json({ error: 'sign in as an editor to add field photos' }, 401);
  let type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream') type = typeOfPath(t.path);
  if (!TYPES.includes(type)) return json({ error: `not a photo type this store keeps: ${type || 'none given'}` }, 415);
  const len = Number(request.headers.get('Content-Length'));
  if (!Number.isFinite(len) || len <= 0) return json({ error: 'a Content-Length is needed' }, 411);
  if (len > MAX_BYTES) return json({ error: `over the ${MAX_BYTES / 1048576} MB limit for a photo` }, 413);
  const k = `${t.bucket}/${t.path}`;
  // Create-only, as the Supabase upload was (`x-upsert: false`): every path is a
  // fresh uuid, so something already there means something went wrong upstream.
  if (await env.PHOTOS.head(k)) return json({ error: 'The resource already exists', statusCode: '409' }, 409);
  const obj = await env.PHOTOS.put(k, request.body, { httpMetadata: { contentType: type } });
  if (obj && obj.size !== len) {
    await env.PHOTOS.delete(k);
    return json({ error: 'the upload was cut short — send it again' }, 400);
  }
  return json({ Key: k }, 200);
}

async function remove(request, env, t) {
  if (!(await whoIs(request))) return json({ error: 'sign in as an editor to remove field photos' }, 401);
  await env.PHOTOS.delete(`${t.bucket}/${t.path}`);
  return json({ ok: true }, 200);
}

export async function handlePhotos(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env || !env.PHOTOS) {
    return json({ error: 'the photo store (R2) is not bound to this Worker yet', unbound: true }, 503);
  }
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/photos/sign') {
      return request.method === 'POST' ? await sign(request, env, url) : json({ error: 'POST only' }, 405);
    }
    const t = photoTarget(url.pathname);
    if (!t) return json({ error: 'not a field photo path' }, 404);
    switch (request.method) {
      case 'GET': case 'HEAD': return await serve(request, env, url, t);
      case 'PUT': case 'POST': return await put(request, env, t);
      case 'DELETE': return await remove(request, env, t);
      default: return json({ error: 'method not allowed' }, 405);
    }
  } catch (err) {
    return json({ error: `photo store: ${err.message}` }, 500);
  }
}

// For the test: the auth check with a stand-in for the project.
export const _test = { whoIs, clearAuth: () => authCache.clear(), resetKey: () => { signingKey = null; } };
