// /api/sort/v1/* — SoRT's forum sessions, kept here for whoever has the forum
// passphrase.
//
// The SoRT scope builder (https://cdomotor-g.github.io/SoRT/) is a static page
// on GitHub Pages: it has nowhere of its own to keep a forum's work, and the
// forum is run from several computers at once. The owner ruled out GitHub
// tokens and accounts — "anyone with that passphrase could get into the sort
// scope builder and do their thing" — so this is a small file store behind one
// shared passphrase, typed once on each forum computer. It is not part of the
// read-only agent API (worker/api.js): it shares nothing with it, adds nothing
// to READABLE_RELATIONS and nothing to docs/api-changelog.json. The contract is
// SoRT's as much as ours; docs/sort-store.md has it in full.
//
//   OPTIONS /api/sort/v1/…              the preflight: 204 for SoRT's and this origin
//   GET     /api/sort/v1/check          200 {ok: true} — the passphrase is right
//   GET     /api/sort/v1/files/<path>   200 the file's text, ETag; 404 {error: 'not found'}
//   PUT     /api/sort/v1/files/<path>   the whole file as JSON text, at most 4 MB:
//                                       If-None-Match: * to create, If-Match: "<etag>"
//                                       to replace → 200 {etag}; 412 {error: 'changed'}
//
// <path> is index.json or stations/<slug>.json (PATH_RE); anything else 400
// {error: 'path'}. A wrong or missing passphrase is 401 {error: 'passphrase'};
// past a brake, 429 {error: 'slow down'}; another method, 405.
//
// ── The passphrase ───────────────────────────────────────────────────────────
// Every request but the preflight carries X-SoRT-Passphrase. It is accepted
// when sha256_hex('sort-forum-v1:' + passphrase) is PASS_SHA256 below — or,
// when the Worker has SORT_PASS_SHA256 (a secret or a variable), that instead,
// so the owner can change the passphrase without a change here. The hashes are
// compared in constant time. The passphrase is about 100 random bits, so a
// plain SHA-256 is enough: nobody is going to search 2^100 of them, and the
// hash in this public file says nothing that helps. The header is never
// logged, never echoed, and never stored.
//
// ── Where the files are ──────────────────────────────────────────────────────
// The PHOTOS R2 bucket, under FILES_PREFIX (_meganet/, the prefix no photo
// path reaches — worker/photos.js serves only field-photos/photo/<uuid>.<ext>).
// Every write is conditional (R2's onlyIf), so two forum computers saving the
// same file at once cannot lose either save: the second is told 412 and SoRT
// reads the file again. And each successful save is copied to HISTORY_PREFIX,
// one copy per file per UTC hour (the hour's last save), so a bad save can be
// put right by hand — docs/sort-store.md, "Putting a file back".
//
// ── Brakes ───────────────────────────────────────────────────────────────────
//   * SORT_RATE_LIMIT — SORT_RATE.limit requests a minute per address, every
//     request but the preflight (which reads and stores nothing).
//   * SORT_AUTH_FAIL — SORT_AUTH_FAIL.limit wrong passphrases a minute per
//     address, counted only on a wrong one; past it a wrong passphrase is 429
//     rather than 401. A right passphrase is never refused by it, so one forum
//     computer with a stale passphrase behind an office's shared address cannot
//     lock the others out.
// Both are Cloudflare's rate limiting bindings (wrangler.toml), keyed by a hash
// of the address, with a window in the isolate standing in without them, as in
// worker/report.js. Per location and eventually consistent: brakes, not quotas.

const PREFIX = '/api/sort/v1';
export const FILES_PREFIX = '_meganet/sort/files/';
export const HISTORY_PREFIX = '_meganet/sort/history/';
export const PATH_RE = /^(index\.json|stations\/[a-z0-9][a-z0-9-]{0,79}\.json)$/;
export const MAX_BYTES = 4 * 1024 * 1024;

// sha256_hex('sort-forum-v1:' + the forum passphrase). The owner's to change:
// SORT_PASS_SHA256 on the Worker overrides it (docs/sort-store.md).
export const PASS_SALT = 'sort-forum-v1:';
export const PASS_SHA256 = '43d489a684d7d3059b89b3f59b60c314aaac74062a2c90e1c7abf7b29b2f6b7e';
const PASS_HEADER = 'X-SoRT-Passphrase';
const PASS_MAX = 1024;

export const SORT_RATE = Object.freeze({ binding: 'SORT_RATE_LIMIT', limit: 120, period: 60 });
export const SORT_AUTH_FAIL = Object.freeze({ binding: 'SORT_AUTH_FAIL', limit: 10, period: 60 });

// The pages that may read the answers: SoRT's (GitHub Pages) and Flood-Net's.
// Any other origin gets no CORS headers at all; a client that is not a browser
// needs none, and with the passphrase may use the store like SoRT does.
export const ORIGINS = Object.freeze(['https://cdomotor-g.github.io', 'https://floodwarning.net']);

export function isSortPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// ── Small helpers ────────────────────────────────────────────────────────────

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The hash a passphrase is held to: the Worker's SORT_PASS_SHA256 when it has
// one, else the constant. A value that is set but is not a SHA-256 in hex is
// null — every request is refused (503) rather than falling back to the old
// passphrase the owner meant to replace.
export function expectedHash(env) {
  const set = env && env.SORT_PASS_SHA256;
  if (set === undefined || set === null || set === '') return PASS_SHA256;
  const h = String(set).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

// The R2 key of a file's copy for the UTC hour `now` falls in.
export function historyKey(path, now = Date.now()) {
  return `${HISTORY_PREFIX}${path}/${new Date(now).toISOString().slice(0, 13)}Z.json`;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// The body as text, refusing to read past `cap` bytes: null if it is longer.
async function readCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
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

// If-Match's etag, unquoted — R2's etagMatches takes the bare etag and refuses
// a quoted one. `"abc"` or a bare `abc`; a list, a weak etag or `*` (replace
// whatever is there, which is the overwrite this exists to stop) is null.
function ifMatchEtag(value) {
  const v = String(value || '').trim();
  const m = /^"([^",\s*]{1,128})"$/.exec(v) || /^([^",\s*/]{1,128})$/.exec(v);
  return m ? m[1] : null;
}

// ── Brakes ───────────────────────────────────────────────────────────────────

const WINDOWS = { [SORT_RATE.binding]: new Map(), [SORT_AUTH_FAIL.binding]: new Map() };

async function rateKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256Hex(`floodnet-sort|${ip}`)).slice(0, 32);
}

// One more for `key` under `rule`: true while it is within the rule.
async function within(rule, key, env, now) {
  const b = env && env[rule.binding];
  if (b && typeof b.limit === 'function') {
    try {
      const out = await b.limit({ key });
      return !(out && out.success === false);
    } catch (_) { /* the binding erred: the window below decides */ }
  }
  const windows = WINDOWS[rule.binding];
  const w = (windows.get(key) || []).filter(t => t > now - rule.period * 1000);
  const ok = w.length < rule.limit;
  if (ok) w.push(now);
  if (windows.size > 5000) windows.clear();
  windows.set(key, w);
  return ok;
}

// ── The routes ───────────────────────────────────────────────────────────────

async function getFile(env, path, cors, reply) {
  const obj = await env.PHOTOS.get(FILES_PREFIX + path);
  if (!obj) return reply({ error: 'not found' }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: obj.httpEtag, ...cors },
  });
}

async function putFile(request, env, path, reply, now) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return reply({ error: 'too large' }, 413);
  const bytes = await readCapped(request, MAX_BYTES);
  if (!bytes) return reply({ error: 'too large' }, 413);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    JSON.parse(text);
  } catch (_) {
    return reply({ error: 'not JSON' }, 400);
  }

  // Create, or replace the version last read — nothing else. Without either
  // header the save would be blind, and a blind save is how a forum loses the
  // other computer's work.
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  let onlyIf;
  if (ifMatch !== null) {
    const etag = ifMatchEtag(ifMatch);
    if (!etag) return reply({ error: 'changed' }, 412);
    onlyIf = { etagMatches: etag };
  } else if (ifNoneMatch !== null && ifNoneMatch.trim() === '*') {
    // As worker/notify.js creates its list: the Headers form, which R2 reads as
    // HTTP's own "only if there is nothing there".
    onlyIf = new Headers({ 'If-None-Match': '*' });
  } else {
    return reply({ error: 'changed' }, 412);
  }

  const put = await env.PHOTOS.put(FILES_PREFIX + path, text, {
    httpMetadata: { contentType: 'application/json' },
    onlyIf,
  });
  if (!put) return reply({ error: 'changed' }, 412);

  // The hour's copy. The save has happened whatever becomes of this, so a
  // failure here is logged (the path and the reason only) and not answered:
  // SoRT would otherwise save again over its own save and be told 412.
  try {
    await env.PHOTOS.put(historyKey(path, now), text, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { etag: put.etag, saved: new Date(now).toISOString() },
    });
  } catch (e) {
    console.log(`[sort] the hour's copy of ${path} was not kept: ${(e && e.message) || e}`);
  }
  return reply({ etag: put.httpEtag }, 200, { ETag: put.httpEtag });
}

export async function handleSort(request, env, ctx, deps = {}) {
  const now = (deps.now || Date.now)();
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag', Vary: 'Origin' }
    : { Vary: 'Origin' };
  const reply = (body, status, extra = {}) => json(body, status, { ...cors, ...extra });

  if (request.method === 'OPTIONS') {
    if (!ORIGINS.includes(origin)) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-sort-passphrase, if-match, if-none-match',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const slowDown = () => reply({ error: 'slow down' }, 429, { 'Retry-After': '60' });
  const key = await rateKey(request);
  if (!(await within(SORT_RATE, key, env, now))) return slowDown();

  const want = expectedHash(env);
  if (!want) {
    console.log('[sort] SORT_PASS_SHA256 is set but is not a SHA-256 in hex: every request is refused until it is');
    return reply({ error: 'passphrase not set up' }, 503);
  }
  const given = request.headers.get(PASS_HEADER);
  if (!given) return reply({ error: 'passphrase' }, 401);
  const ok = given.length <= PASS_MAX && sameHex(await sha256Hex(PASS_SALT + given), want);
  if (!ok) {
    if (!(await within(SORT_AUTH_FAIL, key, env, now))) return slowDown();
    return reply({ error: 'passphrase' }, 401);
  }

  const rest = url.pathname.slice(PREFIX.length);
  if (rest === '/check') {
    if (request.method !== 'GET') return reply({ error: 'GET only' }, 405, { Allow: 'GET, OPTIONS' });
    return reply({ ok: true }, 200);
  }
  if (!rest.startsWith('/files/')) return reply({ error: 'not found' }, 404);
  if (request.method !== 'GET' && request.method !== 'PUT') return reply({ error: 'GET or PUT' }, 405, { Allow: 'GET, PUT, OPTIONS' });
  const path = rest.slice('/files/'.length);
  if (!PATH_RE.test(path)) return reply({ error: 'path' }, 400);
  if (!env || !env.PHOTOS) return reply({ error: 'storage' }, 503);

  try {
    return request.method === 'GET'
      ? await getFile(env, path, cors, reply)
      : await putFile(request, env, path, reply, now);
  } catch (e) {
    console.log(`[sort] ${request.method} ${path}: ${(e && e.message) || e}`);
    return reply({ error: 'storage' }, 503);
  }
}
