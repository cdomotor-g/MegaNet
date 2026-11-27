// /api/upload/v1/* — field photos sent in by other apps and contractors.
//
// A write route, and so deliberately not part of worker/api.js, which is
// read-only by construction and stays so: nothing here is imported by it, and
// nothing of it is imported here. This is a door of its own, like
// /api/notify/*, with its own keys, its own limits and its own tests
// (test/photo-upload.mjs). docs/agent-api.md ("Sending field photos") and
// api.html (#upload) are the user's documentation; db/migrations/0127 the
// database's half.
//
// ── Why it stores and does not read ──────────────────────────────────────────
//
// On the Workers Free plan a request has 10 ms of CPU. Hashing a 25 MB photo,
// let alone reading its EXIF or making a thumbnail, is far more. So this route
// reads nothing of the photo: it checks the key, the declared type, size and
// SHA-256, asks the database for a receipt, and streams the bytes untouched
// into an inbox in R2 — passing the declared SHA-256 to R2, which refuses the
// object if the bytes do not match it, at no CPU cost here. The field photo
// sync (tools/field-photos, PHOTO_SOURCE=api, every fifteen minutes) does the
// rest exactly as it does for Dropbox and Google Drive: photo-meta.js reads
// where and when it was taken, add_field_photo() files it under the nearest
// station, the Review panel's log gets its row, and the receipt is settled.
//
//   PUT  /api/upload/v1/photos              a key: the photo → 202 {receipt, state:'waiting'}
//                                           (200 with the receipt it already has, for a repeat)
//   GET  /api/upload/v1/photos/<receipt>    the same key: what became of it
//   GET  /api/upload/v1/whoami              a key: its label and today's allowance
//   GET  /api/upload/v1/inbox/<receipt>     the project's secret key: the bytes, for the sync
//   DELETE /api/upload/v1/inbox/<receipt>   the project's secret key: cleared once settled
//
// ── Keys ─────────────────────────────────────────────────────────────────────
//
// `fnp_` + 64 hex digits, minted by an administrator on the Admin tab (Ingest
// tokens → Photo upload keys) and shown once. The database keeps only its
// SHA-256, and only the SHA-256 is sent to it: the key itself is never logged,
// stored or passed on. A verdict is remembered for a minute per isolate, so a
// revoked key is refused within the minute.
//
// ── What a refusal by a good key leaves ──────────────────────────────────────
//
// A photo a live key sent that is refused here — not a photo type, too big,
// no length, a SHA-256 that is not one or does not match, a hint the database
// turned down, the day's allowance spent — gets a row in the Review panel's
// upload log (meganet.log_field_photo_upload, origin 'api'), best effort, so
// the person reviewing sees a contractor's failures as well as their photos.
// Requests with no live key leave nothing but their 401.

const SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const PREFIX = '/api/upload';
export const INBOX = '_meganet/upload-inbox/';

// The sync's own limit for a photo (tools/field-photos/lib/run.mjs MAX_BYTES),
// so nothing is accepted here that would be refused there.
export const UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

// What the sync can read and store (tools/field-photos/lib/read.mjs STORED):
// a HEIC is converted to a JPEG there; nothing else is a photo it keeps.
export const UPLOAD_TYPES = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
});

// Cloudflare rate limiting rules — wrangler.toml's PHOTO_UPLOAD_RATE_LIMIT and
// PHOTO_UPLOAD_AUTH_FAIL hold the same numbers; test/agent-docs.mjs checks.
// The first counts every upload request per key; the second only requests
// carrying a key that is not live, per address.
export const UPLOAD_RATE = Object.freeze({ binding: 'PHOTO_UPLOAD_RATE_LIMIT', limit: 30, period: 60 });
export const UPLOAD_AUTH_FAIL = Object.freeze({ binding: 'PHOTO_UPLOAD_AUTH_FAIL', limit: 10, period: 60 });
export const UPLOAD_DAY_DEFAULT = 500;

const KEY_RE = /^fnp_[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTH_TTL_MS = 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-content-sha256, x-floodnet-file-name, x-floodnet-client',
  'Access-Control-Expose-Headers': 'location, retry-after',
  'Access-Control-Max-Age': '86400',
};

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

export function isUploadPath(pathname) {
  return typeof pathname === 'string' && (pathname === PREFIX || pathname.startsWith(PREFIX + '/'));
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : null;
}

// A file name as the sender gave it, made safe to show: no folders, no control
// characters, at most 300 characters. Empty when nothing usable was given.
export function cleanName(raw) {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch (_) { /* as given */ }
  s = s.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.slice(0, 300);
}

// The hints a sender may give with a photo, from the query string. Only the
// shape is checked here; the database checks the rest (a station that exists,
// a position on the Earth, a time with a zone) before anything is stored.
export function hintsOf(params) {
  const h = {};
  const station = params.get('station');
  if (station) h.station_id = station.trim().slice(0, 64);
  const caption = params.get('caption');
  if (caption) h.caption = caption.trim().slice(0, 1000);
  const lat = params.get('lat'), lon = params.get('lon');
  if (lat !== null || lon !== null) {
    const a = Number(lat), o = Number(lon);
    if (lat === null || lon === null || lat === '' || lon === '' || !Number.isFinite(a) || !Number.isFinite(o)) {
      throw new Error('lat and lon are numbers, and come together');
    }
    h.lat = a; h.lon = o;
  }
  const taken = params.get('taken_at');
  if (taken) h.taken_at = taken.trim();
  return h;
}

// ── The project, with the secret key ─────────────────────────────────────────

class DbError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code || null; }
}

async function rpc(env, deps, fn, args) {
  const res = await deps.fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
               'Content-Profile': 'meganet', 'Accept-Profile': 'meganet', 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!res.ok) {
    throw new DbError((body && (body.message || body.error)) || `the database answered HTTP ${res.status}`, res.status, body && body.code);
  }
  return body;
}

// ── Keys, remembered a minute ────────────────────────────────────────────────

const keyCache = new Map();   // sha256(key) → { tok, until }

async function keyFor(request, env, deps) {
  const token = bearer(request);
  if (!token || !KEY_RE.test(token)) return { tok: null, why: token ? 'that is not a photo upload key (they start fnp_)' : 'send your key as Authorization: Bearer fnp_…' };
  const h = await sha256Hex(token);
  const hit = keyCache.get(h);
  if (hit && hit.until > deps.now()) return { tok: hit.tok, why: hit.tok ? null : 'that key is not live — revoked, expired or never issued' };
  const tok = await rpc(env, deps, 'photo_upload_check', { p_hash: h });
  if (keyCache.size > 500) keyCache.clear();
  keyCache.set(h, { tok: tok || null, until: deps.now() + AUTH_TTL_MS });
  return { tok: tok || null, why: tok ? null : 'that key is not live — revoked, expired or never issued' };
}

// ── Rate limits ──────────────────────────────────────────────────────────────

const WINDOWS = new Map();   // rule|key → timestamps, when the binding is not there

async function under(rule, key, env, deps) {
  const b = env[rule.binding];
  if (b && typeof b.limit === 'function') {
    try {
      const out = await b.limit({ key });
      return !(out && out.success === false);
    } catch (_) { /* the binding erred: the window below decides */ }
  }
  const now = deps.now();
  const k = `${rule.binding}|${key}`;
  const w = (WINDOWS.get(k) || []).filter(t => t > now - rule.period * 1000);
  const ok = w.length < rule.limit;
  if (ok) w.push(now);
  if (WINDOWS.size > 5000) WINDOWS.clear();
  WINDOWS.set(k, w);
  return ok;
}

// ── The Review panel's log, best effort ──────────────────────────────────────

function logRefusal(env, deps, ctx, tok, row) {
  const p = rpc(env, deps, 'log_field_photo_upload', { p_rows: [{
    origin: 'api', batch_id: crypto.randomUUID(), uploaded_by: `api:${tok.label}`,
    file_name: row.file_name || 'unnamed', sha256: SHA_RE.test(row.sha256 || '') ? row.sha256 : null,
    byte_size: Number.isFinite(row.byte_size) && row.byte_size > 0 ? row.byte_size : null,
    outcome: 'refused', reason: String(row.reason || '').slice(0, 500),
  }] }).catch(() => { /* the log is never the reason a request fails */ });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

// ── The routes ───────────────────────────────────────────────────────────────

function receiptOut(url, r, extra = {}) {
  return {
    receipt: r.receipt, state: r.state,
    ...(r.photo_id ? { photo_id: r.photo_id } : {}),
    ...(r.station_id ? { station_id: r.station_id } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    status_url: `${url.origin}${PREFIX}/v1/photos/${r.receipt}`,
    ...extra,
  };
}

async function upload(request, env, ctx, deps, url, tok) {
  if (!(await under(UPLOAD_RATE, `key:${tok.id}`, env, deps))) {
    return json({ error: `${UPLOAD_RATE.limit} uploads a minute per key at most`, retry_after: UPLOAD_RATE.period },
      429, { 'Retry-After': String(UPLOAD_RATE.period) });
  }

  const sha = String(request.headers.get('X-Content-SHA256') || '').trim().toLowerCase();
  const type = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const lenHeader = request.headers.get('Content-Length');
  const len = lenHeader === null ? NaN : Number(lenHeader);
  const ext = UPLOAD_TYPES[type];
  const name = cleanName(request.headers.get('X-FloodNet-File-Name') || url.searchParams.get('name'))
    || (SHA_RE.test(sha) && ext ? `${sha.slice(0, 12)}.${ext}` : 'unnamed');
  const refuse = (status, reason, extra = {}) => {
    logRefusal(env, deps, ctx, tok, { file_name: name, sha256: sha, byte_size: len, reason });
    return json({ error: reason, ...extra }, status);
  };

  if (!ext) return refuse(415, `not a photo type this takes: ${type || 'no Content-Type'} — send image/jpeg, image/png, image/webp or image/heic`);
  if (!Number.isFinite(len) || len <= 0) return refuse(411, 'a Content-Length is needed');
  if (len > UPLOAD_MAX_BYTES) return refuse(413, `${(len / 1048576).toFixed(1)} MB is over the ${UPLOAD_MAX_BYTES / 1048576} MB a photo may be`);
  if (!SHA_RE.test(sha)) return refuse(400, 'X-Content-SHA256 is needed: the SHA-256 of the photo, as 64 hex digits');
  let hints;
  try { hints = hintsOf(url.searchParams); } catch (err) { return refuse(400, err.message); }

  let r;
  try {
    r = await rpc(env, deps, 'photo_upload_accept', { p_token_id: tok.id, p: {
      sha256: sha, file_name: name, content_type: type, byte_size: len, hints,
    } });
  } catch (err) {
    if (err.status === 400 || err.code === '22023') return refuse(400, err.message);
    throw err;
  }
  if (r && r.refused === 'day_limit') return refuse(429, r.message, { retry_after: 3600 });
  if (r && r.refused === 'busy') return json({ error: r.message, receipt: r.receipt, retry_after: 60 }, 409, { 'Retry-After': '60' });
  if (r && r.refused) return json({ error: r.message || 'that key is not live' }, 401);
  if (!r || !r.receipt) throw new Error('the database gave no receipt');

  // Sent before with this key, or already in Flood-Net: nothing to store.
  if (!r.fresh) {
    if (request.body) { try { await request.body.cancel(); } catch (_) { /* nothing to read */ } }
    return json(receiptOut(url, r, { repeat: r.state !== 'duplicate' || undefined }), 200,
      { Location: `${PREFIX}/v1/photos/${r.receipt}` });
  }

  const key = `${INBOX}${r.receipt}`;
  const abandon = async reason => {
    try { await env.PHOTOS.delete(key); } catch (_) { /* nothing there */ }
    try { await rpc(env, deps, 'photo_upload_abandon', { p_receipt: r.receipt }); } catch (_) { /* swept by the hour */ }
    return refuse(400, reason);
  };
  let obj;
  try {
    obj = await env.PHOTOS.put(key, request.body, {
      sha256: sha,
      httpMetadata: { contentType: type },
      customMetadata: { receipt: r.receipt, key: String(tok.id) },
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    return abandon(/sha-?256|checksum|digest/i.test(msg)
      ? 'the photo that arrived does not match X-Content-SHA256 — send it again, or check how the hash is made'
      : `the photo could not be stored — ${msg.slice(0, 200)}`);
  }
  if (!obj || obj.size !== len) return abandon('the upload was cut short — send it again');
  await rpc(env, deps, 'photo_upload_stored', { p_receipt: r.receipt });
  return json(receiptOut(url, { ...r, state: 'waiting' }, {
    note: 'It is read and filed within about fifteen minutes; ask status_url what became of it.',
  }), 202, { Location: `${PREFIX}/v1/photos/${r.receipt}` });
}

async function status(env, deps, url, tok, id) {
  const r = await rpc(env, deps, 'photo_upload_status', { p_token_id: tok.id, p_receipt: id });
  if (!r) return json({ error: 'no such receipt for this key' }, 404);
  return json({ ...r, status_url: `${url.origin}${PREFIX}/v1/photos/${r.receipt}` }, 200);
}

function whoami(tok) {
  const used = Number(tok.day_used) || 0;
  return json({
    label: tok.label, day_limit: tok.day_limit, day_used: used, day_left: Math.max(0, tok.day_limit - used),
    expires_at: tok.expires_at || null,
    limits: { max_bytes: UPLOAD_MAX_BYTES, types: Object.keys(UPLOAD_TYPES),
              per_minute: UPLOAD_RATE.limit },
  }, 200);
}

async function inbox(request, env, id) {
  if (!env.SUPABASE_SECRET_KEY || !sameText(bearer(request) || '', env.SUPABASE_SECRET_KEY)) {
    return json({ error: 'the inbox is read with the project\'s secret key only' }, 401);
  }
  const key = `${INBOX}${id}`;
  if (request.method === 'DELETE') { await env.PHOTOS.delete(key); return json({ ok: true }, 200); }
  if (request.method !== 'GET') return json({ error: 'GET or DELETE' }, 405);
  const obj = await env.PHOTOS.get(key);
  if (!obj) return json({ error: 'not in the inbox' }, 404);
  return new Response(obj.body, { status: 200, headers: {
    'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
    'Content-Length': String(obj.size), 'Cache-Control': 'no-store', ...CORS,
  } });
}

export async function handleUpload(request, env, ctx, deps = {}) {
  deps = { fetch: (...a) => fetch(...a), now: () => Date.now(), ...deps };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const rest = url.pathname.slice(PREFIX.length).replace(/\/+$/, '');
  if (!env || !env.PHOTOS || !env.SUPABASE_SECRET_KEY) {
    return json({ error: 'photo uploads are not switched on here yet', unbound: true }, 503);
  }
  try {
    let m;
    if ((m = /^\/v1\/inbox\/([0-9a-f-]{36})$/.exec(rest)) && UUID_RE.test(m[1])) return await inbox(request, env, m[1]);

    const isPhotos = rest === '/v1/photos';
    const st = /^\/v1\/photos\/([0-9a-f-]{36})$/.exec(rest);
    const isWho = rest === '/v1/whoami';
    if (!isPhotos && !(st && UUID_RE.test(st[1])) && !isWho) {
      return json({ error: 'not an upload route — see https://floodwarning.net/api#upload' }, 404);
    }
    if (isPhotos && request.method !== 'PUT' && request.method !== 'POST') return json({ error: 'PUT the photo' }, 405, { Allow: 'PUT, POST, OPTIONS' });
    if (!isPhotos && request.method !== 'GET') return json({ error: 'GET only' }, 405, { Allow: 'GET, OPTIONS' });

    const { tok, why } = await keyFor(request, env, deps);
    if (!tok) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (bearer(request) && !(await under(UPLOAD_AUTH_FAIL, `ip:${await sha256Hex(`floodnet-upload|${ip}`)}`, env, deps))) {
        return json({ error: `${UPLOAD_AUTH_FAIL.limit} wrong keys a minute from one address at most`, retry_after: UPLOAD_AUTH_FAIL.period },
          429, { 'Retry-After': String(UPLOAD_AUTH_FAIL.period) });
      }
      return json({ error: why }, 401, { 'WWW-Authenticate': 'Bearer realm="floodnet-upload"' });
    }
    if (isWho) return whoami(tok);
    if (st) return await status(env, deps, url, tok, st[1]);
    return await upload(request, env, ctx, deps, url, tok);
  } catch (err) {
    // Never the request's headers: they carry the key.
    return json({ error: `photo upload: ${String((err && err.message) || err).slice(0, 300)}` }, 502);
  }
}

export const _test = { clearKeys: () => keyCache.clear(), clearWindows: () => WINDOWS.clear() };
