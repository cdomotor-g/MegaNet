// The photo upload route (worker/upload.js), offline.
//
// /api/upload/v1/* is a write door for other apps and contractors, so what it
// refuses is the whole of its safety: a key that is not live, a type that is
// not a photo, a photo with no length or over the limit, a SHA-256 that is
// missing or does not match the bytes, more than its rate, a repeat that must
// not be stored twice, a receipt asked for by another key, and the inbox read
// with anything but the project's secret key. And it must stay apart from the
// read-only agent API: worker/api.js neither imports it nor lists its tables.
// R2 is a Map that checks the SHA-256 it is given, as R2 does; the project is a
// stand-in that keeps receipts the way db/migrations/0127 does
// (tools/check_photo_upload.sql holds the database to that).
//
// Run:  npm run photoupload

import crypto from 'node:crypto';
import fs from 'node:fs';
import { repo } from './lib/paths.mjs';
import { handleUpload, isUploadPath, cleanName, hintsOf, INBOX, UPLOAD_MAX_BYTES, UPLOAD_RATE, UPLOAD_AUTH_FAIL, _test } from '../worker/upload.js';
import worker from '../worker/index.js';
import * as api from '../worker/api.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });

const hex = b => crypto.createHash('sha256').update(b).digest('hex');
const KEY_A = 'fnp_' + 'a1'.repeat(32);
const KEY_B = 'fnp_' + 'b2'.repeat(32);
const KEY_OLD = 'fnp_' + 'c3'.repeat(32);
const SECRET = 'sb_secret_test';

// ── Stand-ins ─────────────────────────────────────────────────────────────────
function bucket() {
  const m = new Map();
  return {
    m,
    async put(k, body, opts = {}) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (opts.sha256 && hex(bytes) !== opts.sha256) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
      m.set(k, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
      return { key: k, size: bytes.length };
    },
    async get(k) { const v = m.get(k); return v ? { body: v.bytes, size: v.bytes.length, httpMetadata: v.httpMetadata } : null; },
    async delete(k) { m.delete(k); },
  };
}

function project() {
  const tokens = new Map([
    [hex(KEY_A), { id: 1, label: 'Acme Surveys', day_limit: 3, expires_at: null }],
    [hex(KEY_B), { id: 2, label: 'Bight Hydro', day_limit: 500, expires_at: null }],
  ]);
  const receipts = [];
  const logged = [];
  const asked = [];
  const stations = new Set(['_stn_a']);
  const inFloodNet = new Map([[hex('already here'), { id: 'p-elsewhere', station_id: '_stn_a' }]]);
  const reply = (body, status = 200) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const fn = String(url).split('/rpc/')[1];
    const auth = init.headers && init.headers.Authorization;
    asked.push({ fn, auth, body: init.body });
    if (auth !== `Bearer ${SECRET}`) return reply({ message: 'no' }, 401);
    const a = JSON.parse(init.body || '{}');
    const used = id => receipts.filter(r => r.token_id === id).length;
    switch (fn) {
      case 'photo_upload_check': {
        const t = tokens.get(a.p_hash);
        return reply(t ? { ...t, day_used: used(t.id) } : null);
      }
      case 'photo_upload_accept': {
        const t = [...tokens.values()].find(x => x.id === a.p_token_id);
        const p = a.p;
        const had = receipts.find(r => r.token_id === t.id && r.sha256 === p.sha256);
        if (had && had.state === 'receiving') return reply({ refused: 'busy', receipt: had.receipt, message: 'this photo is being received right now — ask again in a minute' });
        if (had) return reply({ ...had, fresh: false });
        if (used(t.id) >= t.day_limit) return reply({ refused: 'day_limit', message: `this key has sent its ${t.day_limit} photos for the last 24 hours` });
        if (p.hints.station_id && !stations.has(p.hints.station_id)) return reply({ code: '22023', message: `no such station: ${p.hints.station_id}` }, 400);
        const dup = inFloodNet.get(p.sha256);
        const r = { receipt: crypto.randomUUID(), token_id: t.id, sha256: p.sha256, file_name: p.file_name, hints: p.hints,
                    state: dup ? 'duplicate' : 'receiving', photo_id: dup ? dup.id : null, station_id: dup ? dup.station_id : null,
                    reason: dup ? 'the same photo is already in Flood-Net' : '' };
        receipts.push(r);
        return reply({ ...r, fresh: !dup });
      }
      case 'photo_upload_stored': {
        const r = receipts.find(x => x.receipt === a.p_receipt && x.state === 'receiving');
        if (r) r.state = 'waiting';
        return reply(r ? { receipt: r.receipt, state: r.state } : null);
      }
      case 'photo_upload_abandon': {
        const i = receipts.findIndex(x => x.receipt === a.p_receipt && x.state === 'receiving');
        if (i >= 0) receipts.splice(i, 1);
        return reply(i >= 0);
      }
      case 'photo_upload_status': {
        const r = receipts.find(x => x.receipt === a.p_receipt && x.token_id === a.p_token_id);
        return reply(r ? { receipt: r.receipt, state: r.state, file_name: r.file_name, sha256: r.sha256 } : null);
      }
      case 'log_field_photo_upload': logged.push(...a.p_rows); return reply({ batch_id: a.p_rows[0].batch_id });
      default: return reply({ message: `no function ${fn}` }, 404);
    }
  };
  return { fetch, receipts, logged, asked, tokens };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i), 0xff, 0xd9]);
const ORIGIN = 'https://floodwarning.net';

function req(method, path, { key, body, type = 'image/jpeg', sha, len, name, ip = '203.0.113.9' } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': ip });
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (body) {
    if (type) headers.set('Content-Type', type);
    if (len !== null) headers.set('Content-Length', String(len ?? body.length));
    if (sha !== null) headers.set('X-Content-SHA256', sha ?? hex(body));
    if (name) headers.set('X-FloodNet-File-Name', name);
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body || undefined, duplex: 'half' });
}

let clock = Date.parse('2026-11-27T00:00:00Z');
function setup() {
  _test.clearKeys(); _test.clearWindows();
  const db = project();
  const env = { PHOTOS: bucket(), SUPABASE_SECRET_KEY: SECRET };
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const call = async r => {
    const res = await handleUpload(r, env, ctx, { fetch: db.fetch, now: () => clock });
    await Promise.all(waits.splice(0));
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, body, headers: res.headers };
  };
  return { db, env, call };
}
const PUT = '/api/upload/v1/photos';

// ── Paths and parts ───────────────────────────────────────────────────────────
check('the upload paths are ours', isUploadPath('/api/upload/v1/photos') && isUploadPath('/api/upload') && !isUploadPath('/api/uploads') && !isUploadPath('/api/v1/stations'));
check('a file name loses its folders and control characters', cleanName('C:\\DCIM\\IMG_0042.JPG') === 'IMG_0042.JPG' && cleanName('../a/b\u0007.jpg') === 'b.jpg' && cleanName('x'.repeat(400)).length === 300);
check('hints are read from the query', JSON.stringify(hintsOf(new URLSearchParams('station=_stn_a&caption=board&lat=-27.5&lon=153'))) === '{"station_id":"_stn_a","caption":"board","lat":-27.5,"lon":153}');
let threw = false;
try { hintsOf(new URLSearchParams('lat=-27.5')); } catch (_) { threw = true; }
check('half a position is refused at the door', threw);

// ── Keys ──────────────────────────────────────────────────────────────────────
{
  const { call, db } = setup();
  let r = await call(req('GET', '/api/upload/v1/whoami'));
  check('no key → 401', r.status === 401 && /Bearer fnp_/.test(r.body.error), r.status);
  r = await call(req('GET', '/api/upload/v1/whoami', { key: 'mgn_' + '0'.repeat(64) }));
  check('a key of another shape → 401, the database not asked', r.status === 401 && !db.asked.length, r.status);
  r = await call(req('GET', '/api/upload/v1/whoami', { key: KEY_OLD }));
  check('a key the database does not know → 401', r.status === 401 && /not live/.test(r.body.error), r.status);
  check('only the key\'s SHA-256 is sent to the database, never the key',
    db.asked.every(a => !String(a.body).includes(KEY_OLD)) && db.asked.some(a => String(a.body).includes(hex(KEY_OLD))));
  r = await call(req('GET', '/api/upload/v1/whoami', { key: KEY_A }));
  check('whoami gives the label and the day', r.status === 200 && r.body.label === 'Acme Surveys' && r.body.day_limit === 3 && r.body.day_left === 3
    && r.body.limits.max_bytes === UPLOAD_MAX_BYTES, JSON.stringify(r.body));
  const before = db.asked.length;
  await call(req('GET', '/api/upload/v1/whoami', { key: KEY_A }));
  check('a key\'s verdict is remembered for a minute', db.asked.length === before);
  let last;
  for (let i = 0; i <= UPLOAD_AUTH_FAIL.limit; i++) {
    _test.clearKeys();
    last = await call(req('GET', '/api/upload/v1/whoami', { key: KEY_OLD, ip: '198.51.100.7' }));
  }
  check(`more than ${UPLOAD_AUTH_FAIL.limit} wrong keys a minute from one address → 429`, last.status === 429 && last.headers.get('Retry-After') === '60', last.status);
  check('no response carries the key', !JSON.stringify(r.body).includes(KEY_A));
}

// ── Uploading ─────────────────────────────────────────────────────────────────
{
  const { call, db, env } = setup();
  let r = await call(req('PUT', `${PUT}?station=_stn_a&caption=gauge%20board`, { key: KEY_A, body: JPEG, name: 'DCIM/IMG_0042.JPG' }));
  const receipt = r.body.receipt;
  check('a photo → 202 waiting, with a receipt and where to ask', r.status === 202 && r.body.state === 'waiting'
    && r.body.status_url === `${ORIGIN}/api/upload/v1/photos/${receipt}` && r.headers.get('Location') === `/api/upload/v1/photos/${receipt}`, JSON.stringify(r.body));
  const stored = env.PHOTOS.m.get(`${INBOX}${receipt}`);
  check('the bytes are in the inbox, unchanged, under the receipt', stored && hex(stored.bytes) === hex(JPEG) && stored.httpMetadata.contentType === 'image/jpeg');
  check('the inbox is out of reach of /api/photos paths', INBOX.startsWith('_meganet/'));
  check('the receipt carries the name and the hints', db.receipts[0].file_name === 'IMG_0042.JPG' && db.receipts[0].hints.caption === 'gauge board' && db.receipts[0].hints.station_id === '_stn_a');

  r = await call(req('PUT', PUT, { key: KEY_A, body: JPEG }));
  check('the same photo again → 200, the same receipt, nothing stored twice',
    r.status === 200 && r.body.receipt === receipt && r.body.repeat === true && env.PHOTOS.m.size === 1, JSON.stringify(r.body));
  r = await call(req('PUT', PUT, { key: KEY_B, body: JPEG }));
  check('another key sending it gets its own receipt', r.status === 202 && r.body.receipt !== receipt);

  r = await call(req('GET', `/api/upload/v1/photos/${receipt}`, { key: KEY_A }));
  check('the key that sent it reads its receipt', r.status === 200 && r.body.state === 'waiting' && r.body.file_name === 'IMG_0042.JPG');
  r = await call(req('GET', `/api/upload/v1/photos/${receipt}`, { key: KEY_B }));
  check('another key does not', r.status === 404);

  const here = new TextEncoder().encode('already here');
  r = await call(req('PUT', PUT, { key: KEY_A, body: here }));
  check('a photo already in Flood-Net → 200 duplicate with its photo, nothing stored',
    r.status === 200 && r.body.state === 'duplicate' && r.body.photo_id === 'p-elsewhere' && env.PHOTOS.m.size === 2, JSON.stringify(r.body));

  const other = new Uint8Array([...JPEG, 1]);
  r = await call(req('PUT', PUT, { key: KEY_A, body: other }));
  r = await call(req('PUT', PUT, { key: KEY_A, body: new Uint8Array([...JPEG, 2]) }));
  check('past the daily allowance → 429, logged for review', r.status === 429 && /3 photos/.test(r.body.error)
    && db.logged.some(l => /3 photos/.test(l.reason) && l.uploaded_by === 'api:Acme Surveys'), JSON.stringify(r.body));
}

// ── Refusals ──────────────────────────────────────────────────────────────────
{
  const { call, db, env } = setup();
  const tries = [
    ['an SVG → 415', { type: 'image/svg+xml' }, 415],
    ['a GIF → 415 (the sync does not keep one)', { type: 'image/gif' }, 415],
    ['no Content-Length → 411', { len: null }, 411],
    ['over the limit → 413', { len: UPLOAD_MAX_BYTES + 1 }, 413],
    ['no X-Content-SHA256 → 400', { sha: null }, 400],
    ['a SHA-256 that is not one → 400', { sha: 'abc' }, 400],
  ];
  for (const [what, opts, want] of tries) {
    const r = await call(req('PUT', PUT, { key: KEY_B, body: JPEG, ...opts }));
    check(what, r.status === want, `${r.status} ${r.body && r.body.error}`);
  }
  let r = await call(req('PUT', `${PUT}?station=_nope`, { key: KEY_B, body: JPEG }));
  check('a station that does not exist → 400 before storing', r.status === 400 && /no such station/.test(r.body.error) && env.PHOTOS.m.size === 0, r.status);
  r = await call(req('PUT', PUT, { key: KEY_B, body: JPEG, sha: hex('something else') }));
  check('bytes that do not match the SHA-256 → 400, nothing kept, the receipt abandoned',
    r.status === 400 && /does not match/.test(r.body.error) && env.PHOTOS.m.size === 0 && db.receipts.length === 0, `${r.status} ${r.body.error}`);
  check('each refusal by a live key is in the Review panel\'s log, as api, refused',
    db.logged.length === tries.length + 2 && db.logged.every(l => l.origin === 'api' && l.outcome === 'refused' && l.uploaded_by === 'api:Bight Hydro'), db.logged.length);
  check('…and never carries the key', !JSON.stringify(db.logged).includes(KEY_B));
  r = await call(req('PUT', PUT, { key: KEY_OLD, body: JPEG }));
  check('a refusal with no live key is not logged', r.status === 401 && db.logged.length === tries.length + 2);
  r = await call(req('GET', PUT, { key: KEY_B }));
  check('GET on the upload route → 405', r.status === 405);
}

// ── Rate ──────────────────────────────────────────────────────────────────────
{
  const { call } = setup();
  let last;
  for (let i = 0; i <= UPLOAD_RATE.limit; i++) {
    last = await call(req('PUT', PUT, { key: KEY_B, body: new Uint8Array([...JPEG, i % 256, i >> 8]) }));
  }
  check(`more than ${UPLOAD_RATE.limit} uploads a minute per key → 429`, last.status === 429 && last.headers.get('Retry-After') === '60', last.status);
  const binding = { calls: [], async limit(o) { this.calls.push(o.key); return { success: false }; } };
  const { db } = setup();
  const env = { PHOTOS: bucket(), SUPABASE_SECRET_KEY: SECRET, PHOTO_UPLOAD_RATE_LIMIT: binding };
  const res = await handleUpload(req('PUT', PUT, { key: KEY_B, body: JPEG }), env, {}, { fetch: db.fetch, now: () => clock });
  check('the Cloudflare binding decides when it is there, keyed on the key\'s id, not the key',
    res.status === 429 && binding.calls.length === 1 && binding.calls[0] === 'key:2');
}

// ── The inbox, for the sync ───────────────────────────────────────────────────
{
  const { call, env } = setup();
  const r0 = await call(req('PUT', PUT, { key: KEY_B, body: JPEG }));
  const id = r0.body.receipt;
  let r = await call(req('GET', `/api/upload/v1/inbox/${id}`, { key: KEY_B }));
  check('a contractor key cannot read the inbox', r.status === 401);
  r = await call(req('GET', `/api/upload/v1/inbox/${id}`, { key: 'sb_secret_wrong' }));
  check('nor can a wrong secret', r.status === 401);
  const res = await handleUpload(req('GET', `/api/upload/v1/inbox/${id}`, { key: SECRET }), env, {}, {});
  const got = new Uint8Array(await res.arrayBuffer());
  check('the secret key reads the bytes back', res.status === 200 && hex(got) === hex(JPEG));
  r = await call(req('DELETE', `/api/upload/v1/inbox/${id}`, { key: SECRET }));
  check('and clears them', r.status === 200 && !env.PHOTOS.m.has(`${INBOX}${id}`));
  r = await call(req('GET', '/api/upload/v1/inbox/../../photo', { key: SECRET }));
  check('nothing but a receipt id reaches the inbox', r.status === 404);
}

// ── Switched off ──────────────────────────────────────────────────────────────
{
  const res = await handleUpload(req('GET', '/api/upload/v1/whoami', { key: KEY_A }), { PHOTOS: bucket() }, {}, {});
  const body = await res.json();
  check('without the secret key → 503 unbound', res.status === 503 && body.unbound === true);
  const res2 = await worker.fetch(req('GET', '/api/upload/v1/whoami', { key: KEY_A }), {}, {});
  check('the Worker routes /api/upload/* here', res2.status === 503);
  const pre = await handleUpload(new Request(`${ORIGIN}${PUT}`, { method: 'OPTIONS' }), {}, {}, {});
  check('a preflight is answered, with the headers an upload sends',
    pre.status === 204 && /x-content-sha256/.test(pre.headers.get('Access-Control-Allow-Headers')));
}

// ── Kept apart from the read-only agent API ───────────────────────────────────
{
  const src = fs.readFileSync(repo('worker/api.js'), 'utf8');
  check('worker/api.js does not import the upload route', !/upload\.js/.test(src));
  check('the agent API reads neither upload table', ![...api.READABLE_RELATIONS].some(r => /photo_upload/.test(r)));
  const up = fs.readFileSync(repo('worker/upload.js'), 'utf8');
  check('the upload route does not import the agent API', !/from '\.\/api\.js'/.test(up));
  check('the upload route never writes to the console', !/console\./.test(up));
}

// ── Verdict ───────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) if (!r.ok || process.argv.includes('-v')) console.log(`  ${r.ok ? '✓' : '✗'} ${r.what}${r.detail !== '' && !r.ok ? ` — ${r.detail}` : ''}`);
console.log(`${results.length - failed.length}/${results.length} photo upload checks passed`);
process.exit(failed.length ? 1 : 0);
