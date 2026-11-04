// SoRT's forum sessions (worker/sort.js, /api/sort/v1/*) — offline: R2 is a
// stand-in that keeps etags and does onlyIf the way R2 does.
//
// What matters, because each fails in silence if wrong: the store answers only
// to the forum passphrase, and the owner's SORT_PASS_SHA256 replaces the one in
// the code; nothing outside index.json and stations/<slug>.json is ever read or
// written; no save is blind — a create only where nothing is, a replace only of
// the version last read, so two forum computers saving at once cannot lose
// either's work; every save leaves the hour's copy to put a bad one right; only
// SoRT's and Flood-Net's pages can read the answers; the brakes hold — a
// minute's requests from one address, and its wrong passphrases; and the
// passphrase is never in a log line or an answer.
//
// The real passphrase is not here and is not needed: the checks hold the
// store to a made-up one through SORT_PASS_SHA256, and to the code's own hash
// only by refusing what is not it.
//
// Run:  npm run sortstore

import crypto from 'node:crypto';
import worker from '../worker/index.js';
import {
  handleSort, isSortPath, expectedHash, historyKey, PASS_SHA256, PASS_SALT, MAX_BYTES, PATH_RE, normPass, PASS_KEY, PASS_TTL_MS, resetPassMemo,
  FILES_PREFIX, HISTORY_PREFIX, SORT_RATE, SORT_AUTH_FAIL, ORIGINS,
} from '../worker/sort.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });
const J = v => JSON.stringify(v);

// Every line anything logs, so the end can ask whether a passphrase got into one.
const logged = [];
const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error };
for (const k of Object.keys(realLog)) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };

// Made-up passphrases, none of them the forum's.
const PASS = 'made-up-forum-words-for-the-tests-only';
const PASS2 = 'another-made-up-forum-phrase';
const WRONG = 'not-the-forum-passphrase-at-all';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const N = p => p.toUpperCase().replace(/[^A-Z0-9]/g, '');
const HASH = sha(PASS_SALT + N(PASS));
const HASH2 = sha(PASS_SALT + N(PASS2));
const SECRETS = [PASS, PASS2, WRONG];

const BASE = 'https://floodwarning.net/api/sort/v1';
const SORT_ORIGIN = 'https://cdomotor-g.github.io';
const NOW0 = Date.parse('2026-11-04T05:10:00Z');
let now = NOW0;
const deps = { now: () => now };

// ── R2, as far as this store uses it ─────────────────────────────────────────
// An etag per write; onlyIf as R2 does it — the R2Conditional's etagMatches,
// which takes the bare etag and throws on a quoted one (workerd: "Conditional
// ETag should not be wrapped in quotes"), or a Headers object with
// If-None-Match: * for "only if nothing is there". A refused put is null.
function bucket() {
  const m = new Map();
  let n = 0;
  const b = {
    m, puts: [], refused: 0, failOn: null,
    async get(k) {
      if (b.failOn && b.failOn('get', k)) throw new Error('R2 is having a moment');
      const o = m.get(k);
      if (!o) return null;
      return { key: k, etag: o.etag, httpEtag: `"${o.etag}"`, size: o.body.length,
        body: new Response(o.body).body, text: async () => o.body };
    },
    async put(k, v, opts = {}) {
      if (b.failOn && b.failOn('put', k)) throw new Error('R2 is having a moment');
      const cur = m.get(k);
      const c = opts.onlyIf;
      if (c instanceof Headers) {
        if (c.get('If-None-Match') === '*' && cur) { b.refused++; return null; }
        if (c.get('If-Match')) throw new Error('the stand-in does not read If-Match headers');
      } else if (c && c.etagMatches !== undefined) {
        if (/"/.test(c.etagMatches)) throw new TypeError(`Conditional ETag should not be wrapped in quotes (${c.etagMatches}).`);
        if (!cur || cur.etag !== c.etagMatches) { b.refused++; return null; }
      } else if (c && c.etagDoesNotMatch !== undefined) {
        throw new Error('the stand-in does not do etagDoesNotMatch');
      }
      const etag = `e${++n}`;
      m.set(k, { body: String(v), etag, opts });
      b.puts.push(k);
      return { key: k, etag, httpEtag: `"${etag}"`, size: String(v).length };
    },
  };
  return b;
}
const ENV = (extra = {}) => ({ PHOTOS: bucket(), SORT_PASS_SHA256: HASH, ...extra });

let ipN = 1;
function req(method, path, { pass = PASS, origin, headers = {}, body, ip } = {}) {
  const h = { 'CF-Connecting-IP': ip || `198.51.100.${(ipN++ % 254) + 1}`, ...headers };
  if (pass !== null && pass !== undefined) h['X-SoRT-Passphrase'] = pass;
  if (origin) h.Origin = origin;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = body; if (body instanceof ReadableStream) init.duplex = 'half'; }
  return new Request(`${BASE}${path}`, init);
}
// Each answer, read once; every body kept, so the end can ask whether a
// passphrase was ever echoed.
const answered = [];
async function read(res) {
  const text = await res.text();
  answered.push(text);
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, body, text, headers: res.headers };
}
const go = async (env, ...a) => read(await handleSort(req(...a), env, {}, deps));

// ── Where the route is ───────────────────────────────────────────────────────
check('the routes are /api/sort/v1 and below it, and nothing near it',
  isSortPath('/api/sort/v1') && isSortPath('/api/sort/v1/check') && isSortPath('/api/sort/v1/files/index.json')
    && !isSortPath('/api/sort') && !isSortPath('/api/sort/v2/check') && !isSortPath('/api/sortv1') && !isSortPath('/api/sort/v10/check'));
{
  const r = await read(await worker.fetch(req('GET', '/check', { pass: WRONG }), ENV(), {}));
  check('the Worker sends /api/sort/v1/* to it', r.status === 401 && r.body && r.body.error === 'passphrase', `${r.status} ${r.text}`);
  const ok = await read(await worker.fetch(req('GET', '/check'), ENV(), {}));
  check('… and it answers there', ok.status === 200 && J(ok.body) === '{"ok":true}', ok.text);
}

// ── The passphrase ───────────────────────────────────────────────────────────
check('the code holds a SHA-256 for the way back in, under the contract\'s salt', /^[0-9a-f]{64}$/.test(PASS_SHA256) && PASS_SALT === 'sort-forum-v1:');
check('with no SORT_PASS_SHA256, the hash held to is the code\'s', expectedHash({}) === PASS_SHA256 && expectedHash({ SORT_PASS_SHA256: '' }) === PASS_SHA256 && expectedHash(undefined) === PASS_SHA256);
check('with one, that — trimmed, in either case', expectedHash({ SORT_PASS_SHA256: ` ${HASH.toUpperCase()}\n` }) === HASH);
check('one that is not a SHA-256 in hex is nothing to hold to (null), not a fall back to the code\'s',
  expectedHash({ SORT_PASS_SHA256: 'hunter2' }) === null && expectedHash({ SORT_PASS_SHA256: HASH.slice(1) }) === null);
{
  const env = ENV();
  const right = await go(env, 'GET', '/check');
  check('the right passphrase: GET /check is 200 {"ok":true}', right.status === 200 && right.text === '{"ok":true}', right.text);
  check('… as JSON, never cached', right.headers.get('Content-Type') === 'application/json' && right.headers.get('Cache-Control') === 'no-store');
  const wrong = await go(env, 'GET', '/check', { pass: WRONG });
  check('a wrong one: 401 {"error":"passphrase"}', wrong.status === 401 && wrong.text === '{"error":"passphrase"}', wrong.text);
  const none = await go(env, 'GET', '/check', { pass: null });
  check('none at all: 401 {"error":"passphrase"}', none.status === 401 && none.text === '{"error":"passphrase"}', none.text);
  const empty = await go(env, 'GET', '/check', { pass: '' });
  check('an empty one: 401', empty.status === 401, empty.text);
  const near = await go(env, 'GET', '/check', { pass: `${PASS}x` });
  const salted = await go(env, 'GET', '/check', { pass: `${PASS_SALT}${PASS}` });
  check('one a letter longer, or with the salt typed in front, is wrong', near.status === 401 && salted.status === 401);
  const long = await go(env, 'GET', '/check', { pass: 'x'.repeat(5000) });
  check('a very long one is wrong, not an error', long.status === 401, long.text);
  const files = await go(env, 'GET', '/files/index.json', { pass: WRONG });
  const put = await go(env, 'PUT', '/files/index.json', { pass: WRONG, body: '{}', headers: { 'If-None-Match': '*' } });
  check('every route asks it — a file is not read or written with a wrong one', files.status === 401 && put.status === 401 && env.PHOTOS.puts.length === 0);
  const unknown = await go(env, 'GET', '/nothing-here', { pass: WRONG });
  check('… nor is anything else under /api/sort/v1 answered without it', unknown.status === 401);
}
{
  const code = { PHOTOS: bucket() };
  const r = await go(code, 'GET', '/check');
  check('with no SORT_PASS_SHA256 the made-up passphrase is refused — the code\'s hash is in force', r.status === 401, r.text);
  const two = { PHOTOS: bucket(), SORT_PASS_SHA256: HASH2 };
  const a = await go(two, 'GET', '/check', { pass: PASS2 });
  const b = await go(two, 'GET', '/check');
  check('SORT_PASS_SHA256 changes the passphrase: the new one in, the old one out', a.status === 200 && b.status === 401, `${a.status} ${b.status}`);
  const broken = await go({ PHOTOS: bucket(), SORT_PASS_SHA256: 'not a hash' }, 'GET', '/check');
  check('a SORT_PASS_SHA256 that is not a hash refuses everybody (503), saying it is not set up',
    broken.status === 503 && broken.body.error === 'passphrase not set up', broken.text);
}

// ── Routes and methods ───────────────────────────────────────────────────────
{
  const env = ENV();
  const r404 = await go(env, 'GET', '/nothing-here');
  check('an address under /api/sort/v1 that is not a route: 404 {"error":"not found"}', r404.status === 404 && r404.text === '{"error":"not found"}', r404.text);
  const bare = await go(env, 'GET', '/files');
  check('… /files with no file named too', bare.status === 404, bare.text);
  const putCheck = await go(env, 'PUT', '/check', { body: '{}' });
  check('/check is GET only: 405, saying what is allowed', putCheck.status === 405 && /GET/.test(putCheck.headers.get('Allow') || ''), putCheck.text);
  for (const m of ['DELETE', 'POST', 'PATCH', 'HEAD']) {
    const r = await go(env, m, '/files/index.json', m === 'POST' || m === 'PATCH' ? { body: '{}' } : {});
    check(`${m} a file: 405, GET and PUT allowed`, r.status === 405 && /GET, PUT/.test(r.headers.get('Allow') || ''), `${r.status}`);
  }
  check('… and no method but PUT wrote anything', env.PHOTOS.puts.length === 0);
}

// ── Paths ────────────────────────────────────────────────────────────────────
{
  const env = ENV();
  const bad = ['other.json', 'INDEX.json', 'index.json.bak', 'index', 'stations/ABC.json', 'stations/-abc.json',
    'stations/abc_def.json', 'stations/abc.JSON', 'stations/.json', 'stations/a/b.json', 'stations/a.json/x',
    `stations/a${'b'.repeat(80)}.json`, 'stations%2Fabc.json', '%2e%2e%2Fsecret.json', 'stations/abc%00.json',
    'stations/abc.json%20', 'stations/ábc.json', 'stations/', 'history/index.json'];
  const got = [];
  for (const p of bad) got.push([p, await go(env, 'GET', `/files/${p}`), await go(env, 'PUT', `/files/${p}`, { body: '{}', headers: { 'If-None-Match': '*' } })]);
  const wrongs = got.filter(([, g, p]) => g.status !== 400 || p.status !== 400 || g.text !== '{"error":"path"}' || p.text !== '{"error":"path"}');
  check(`${bad.length} paths that are not index.json or stations/<slug>.json: 400 {"error":"path"}, to GET and PUT`,
    wrongs.length === 0, wrongs.map(([p, g, q]) => `${p}: ${g.status}/${q.status}`).join('; '));
  check('… and none of them touched the bucket', env.PHOTOS.puts.length === 0 && env.PHOTOS.m.size === 0);
  const good = ['index.json', 'stations/a.json', 'stations/0.json', 'stations/143001-murwillumbah.json', `stations/a${'b'.repeat(79)}.json`];
  const ok = [];
  for (const p of good) ok.push([p, await go(env, 'GET', `/files/${p}`)]);
  check('index.json and stations/<slug>.json up to 80 characters are paths (404 until saved)',
    ok.every(([, r]) => r.status === 404) && good.every(p => PATH_RE.test(p)), ok.map(([p, r]) => `${p}: ${r.status}`).join('; '));
}

// ── Reading, creating, replacing ─────────────────────────────────────────────
{
  const env = ENV();
  const missing = await go(env, 'GET', '/files/index.json');
  check('a file not saved yet: 404 {"error":"not found"}', missing.status === 404 && missing.text === '{"error":"not found"}', missing.text);

  const v1 = '{"forum":"Test forum","stations":["a"],"note":"ünïcödé ✓"}';
  const blind = await go(env, 'PUT', '/files/index.json', { body: v1 });
  check('a save with neither If-None-Match nor If-Match is refused: 412 {"error":"changed"} — never a blind save',
    blind.status === 412 && blind.text === '{"error":"changed"}' && env.PHOTOS.m.size === 0, blind.text);
  const odd = await go(env, 'PUT', '/files/index.json', { body: v1, headers: { 'If-None-Match': '"e1"' } });
  check('… If-None-Match with anything but * is not a create either (412)', odd.status === 412 && env.PHOTOS.m.size === 0, odd.text);

  const created = await go(env, 'PUT', '/files/index.json', { body: v1, headers: { 'If-None-Match': '*', 'Content-Type': 'application/json' } });
  check('created with If-None-Match: * — 200 {"etag":"\\"…\\""} and the same ETag header',
    created.status === 200 && created.body && created.body.etag === '"e1"' && created.headers.get('ETag') === '"e1"', `${created.status} ${created.text}`);
  const stored = env.PHOTOS.m.get(`${FILES_PREFIX}index.json`);
  check('… kept at _meganet/sort/files/index.json, the text exactly as sent, as JSON',
    stored && stored.body === v1 && stored.opts.httpMetadata.contentType === 'application/json' && FILES_PREFIX === '_meganet/sort/files/', J(stored && stored.body));

  const got = await go(env, 'GET', '/files/index.json');
  check('read back: 200, the text exactly, application/json, ETag, no-store',
    got.status === 200 && got.text === v1 && got.headers.get('Content-Type') === 'application/json'
      && got.headers.get('ETag') === '"e1"' && got.headers.get('Cache-Control') === 'no-store', `${got.status} ${got.text}`);

  const again = await go(env, 'PUT', '/files/index.json', { body: '{"x":1}', headers: { 'If-None-Match': '*' } });
  check('creating it again over the one there: 412 {"error":"changed"}, the file as it was',
    again.status === 412 && again.text === '{"error":"changed"}' && (env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === v1, again.text);
  const noMatch = await go(env, 'PUT', '/files/index.json', { body: '{"x":1}' });
  check('replacing it without If-Match: 412', noMatch.status === 412 && (env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === v1, noMatch.text);

  const v2 = '{"forum":"Test forum","stations":["a","b"]}';
  const replaced = await go(env, 'PUT', '/files/index.json', { body: v2, headers: { 'If-Match': got.headers.get('ETag') } });
  const e2 = replaced.headers.get('ETag') || '"none"';
  check('replaced with If-Match: the ETag last read — 200 and a new etag, the file\'s own',
    replaced.status === 200 && /^"e\d+"$/.test(e2) && e2 !== '"e1"' && replaced.body.etag === e2
      && e2 === `"${(env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).etag}"` && (env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === v2, replaced.text);
  const stale = await go(env, 'PUT', '/files/index.json', { body: '{"stale":true}', headers: { 'If-Match': '"e1"' } });
  check('a replace from the version before (someone saved in between): 412, their save kept',
    stale.status === 412 && stale.text === '{"error":"changed"}' && (env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === v2, stale.text);

  for (const [v, what] of [['*', 'If-Match: * (whatever is there)'], [`W/${e2}`, 'a weak etag'], [`${e2}, "e99"`, 'a list'], ['""', 'an empty etag'], ['"*"', 'a quoted *']]) {
    const r = await go(env, 'PUT', '/files/index.json', { body: '{"blind":true}', headers: { 'If-Match': v } });
    check(`${what} is not the version last read: 412`, r.status === 412 && (env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === v2, `${r.status} ${r.text}`);
  }
  const bareTag = await go(env, 'PUT', '/files/index.json', { body: '{"v":3}', headers: { 'If-Match': e2.slice(1, -1) } });
  const e3 = bareTag.headers.get('ETag') || '"none"';
  check('the etag unquoted is taken as the same etag (200)', bareTag.status === 200 && e3 && e3 !== e2, bareTag.text);

  const ghost = await go(env, 'PUT', '/files/stations/nowhere.json', { body: '{}', headers: { 'If-Match': e3 } });
  check('a replace of a file that is not there: 412', ghost.status === 412 && !env.PHOTOS.m.has(`${FILES_PREFIX}stations/nowhere.json`), ghost.text);

  // Two forum computers, both on e3, both press Save.
  const [a, b] = await Promise.all([
    go(env, 'PUT', '/files/index.json', { body: '{"by":"first"}', headers: { 'If-Match': e3 } }),
    go(env, 'PUT', '/files/index.json', { body: '{"by":"second"}', headers: { 'If-Match': e3 } }),
  ]);
  const kept = (JSON.parse((env.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body || '{}') || {}).by;
  check('two saves on the same version at once: one 200, the other 412, and the one kept is the one told 200',
    [a.status, b.status].sort().join() === '200,412' && kept === (a.status === 200 ? 'first' : 'second'), `${a.status} ${b.status} ${kept}`);

  const st = await go(env, 'PUT', '/files/stations/143001-murwillumbah.json', { body: '{"station":"143001"}', headers: { 'If-None-Match': '*' } });
  check('a station\'s file is created under stations/', st.status === 200 && env.PHOTOS.m.has(`${FILES_PREFIX}stations/143001-murwillumbah.json`), st.text);
}

// ── What a file may be ───────────────────────────────────────────────────────
{
  const env = ENV();
  const create = { 'If-None-Match': '*' };
  const notJson = await go(env, 'PUT', '/files/index.json', { body: 'not json', headers: create });
  check('a body that is not JSON: 400 {"error":"not JSON"}', notJson.status === 400 && notJson.text === '{"error":"not JSON"}', notJson.text);
  const emptyBody = await go(env, 'PUT', '/files/index.json', { body: '', headers: create });
  const noBody = await go(env, 'PUT', '/files/index.json', { headers: create });
  check('an empty body, or none, is not JSON either', emptyBody.status === 400 && noBody.status === 400, `${emptyBody.status} ${noBody.status}`);
  const badUtf8 = await go(env, 'PUT', '/files/index.json', { body: new Uint8Array([0x22, 0xff, 0xfe, 0x22]), headers: create });
  check('bytes that are not UTF-8 are not JSON', badUtf8.status === 400 && badUtf8.body.error === 'not JSON', badUtf8.text);
  const cut = await go(env, 'PUT', '/files/index.json', { body: '{"forum": "cut sho', headers: create });
  check('a file cut short is not JSON', cut.status === 400, cut.text);
  check('… and none of them was kept', env.PHOTOS.m.size === 0);

  const full = `"${'x'.repeat(MAX_BYTES - 2)}"`;
  const atCap = await go(env, 'PUT', '/files/stations/big.json', { body: full, headers: create });
  check(`a file of exactly ${MAX_BYTES / 1048576} MB is kept`, MAX_BYTES === 4194304 && atCap.status === 200 && ((env.PHOTOS.m.get(`${FILES_PREFIX}stations/big.json`) || {}).body || '').length === MAX_BYTES, atCap.text);
  const over = await go(env, 'PUT', '/files/stations/bigger.json', { body: `"${'x'.repeat(MAX_BYTES - 1)}"`, headers: create });
  check('a byte more: 413 {"error":"too large"}, nothing kept', over.status === 413 && over.text === '{"error":"too large"}' && !env.PHOTOS.m.has(`${FILES_PREFIX}stations/bigger.json`), over.text);
  const said = await go(env, 'PUT', '/files/stations/bigger.json', { body: '{}', headers: { ...create, 'Content-Length': String(MAX_BYTES + 1) } });
  check('a Content-Length over it is refused before reading (413)', said.status === 413, said.text);
  const chunks = [new Uint8Array(MAX_BYTES).fill(0x20), new Uint8Array(10).fill(0x20)];
  const stream = new ReadableStream({ pull(c) { const v = chunks.shift(); if (v) c.enqueue(v); else c.close(); } });
  const chunked = await go(env, 'PUT', '/files/stations/bigger.json', { body: stream, headers: create });
  check('a chunked body over it is refused without being read whole (413)', chunked.status === 413, chunked.text);
}

// ── The hour's copy ──────────────────────────────────────────────────────────
{
  const env = ENV();
  now = Date.parse('2026-11-04T05:10:00Z');
  const k5 = `${HISTORY_PREFIX}index.json/2026-11-04T05Z.json`;
  check('the copy\'s key: _meganet/sort/history/<path>/<YYYY-MM-DDTHH>Z.json, in UTC',
    historyKey('index.json', now) === k5 && historyKey('stations/a.json', Date.parse('2026-11-04T23:59:59+10:00')) === `${HISTORY_PREFIX}stations/a.json/2026-11-04T13Z.json`);
  const a = await go(env, 'PUT', '/files/index.json', { body: '{"v":1}', headers: { 'If-None-Match': '*' } });
  check('a save leaves the hour\'s copy, the same text', a.status === 200 && (env.PHOTOS.m.get(k5) || {}).body === '{"v":1}', J([...env.PHOTOS.m.keys()]));
  const copy5 = env.PHOTOS.m.get(k5);
  check('… as JSON, naming the save\'s etag', copy5 && copy5.opts.httpMetadata.contentType === 'application/json' && copy5.opts.customMetadata.etag === 'e1');
  now = Date.parse('2026-11-04T05:40:00Z');
  const b = await go(env, 'PUT', '/files/index.json', { body: '{"v":2}', headers: { 'If-Match': a.headers.get('ETag') } });
  check('a second save in the same hour writes over that hour\'s copy', b.status === 200 && (env.PHOTOS.m.get(k5) || {}).body === '{"v":2}'
    && [...env.PHOTOS.m.keys()].filter(k => k.startsWith(`${HISTORY_PREFIX}index.json/`)).length === 1);
  check('… and the copy is not the file: an etag from it is not the file\'s', b.headers.get('ETag') !== `"${(env.PHOTOS.m.get(k5) || {}).etag}"`);
  now = Date.parse('2026-11-04T06:02:00Z');
  const c = await go(env, 'PUT', '/files/index.json', { body: '{"v":3,"bad":true}', headers: { 'If-Match': b.headers.get('ETag') } });
  const k6 = `${HISTORY_PREFIX}index.json/2026-11-04T06Z.json`;
  check('the next hour has its own copy, and the last hour\'s is left as it was — what a bad save is put right from',
    c.status === 200 && (env.PHOTOS.m.get(k6) || {}).body === '{"v":3,"bad":true}' && (env.PHOTOS.m.get(k5) || {}).body === '{"v":2}');
  const before = env.PHOTOS.puts.length;
  const refused = await go(env, 'PUT', '/files/index.json', { body: '{"v":"stale"}', headers: { 'If-Match': a.headers.get('ETag') } });
  check('a refused save leaves no copy', refused.status === 412 && env.PHOTOS.puts.length === before && (env.PHOTOS.m.get(k6) || {}).body === '{"v":3,"bad":true}');
  const s = await go(env, 'PUT', '/files/stations/abc.json', { body: '{"s":1}', headers: { 'If-None-Match': '*' } });
  check('a station\'s copy is under its own path', s.status === 200 && (env.PHOTOS.m.get(`${HISTORY_PREFIX}stations/abc.json/2026-11-04T06Z.json`) || {}).body === '{"s":1}');

  const flaky = ENV();
  flaky.PHOTOS.failOn = (op, k) => op === 'put' && k.startsWith(HISTORY_PREFIX);
  const logs = logged.length;
  const f = await go(flaky, 'PUT', '/files/index.json', { body: '{"v":1}', headers: { 'If-None-Match': '*' } });
  check('the copy failing does not fail the save: 200 with its etag, and the file kept',
    f.status === 200 && f.body.etag === '"e1"' && (flaky.PHOTOS.m.get(`${FILES_PREFIX}index.json`) || {}).body === '{"v":1}', f.text);
  check('… and it is logged, naming the file', logged.slice(logs).some(l => /\[sort\].*index\.json/.test(l)), J(logged.slice(logs)));
  now = NOW0;
}

// ── Storage ──────────────────────────────────────────────────────────────────
{
  const unbound = { SORT_PASS_SHA256: HASH };
  const c = await go(unbound, 'GET', '/check');
  const g = await go(unbound, 'GET', '/files/index.json');
  check('with no bucket bound, /check still answers and a file is 503 {"error":"storage"}', c.status === 200 && g.status === 503 && g.body.error === 'storage', `${c.status} ${g.text}`);
  const down = ENV();
  down.PHOTOS.failOn = op => op === 'get';
  const d = await go(down, 'GET', '/files/index.json');
  check('the bucket erring: 503 {"error":"storage"}', d.status === 503 && d.body.error === 'storage', d.text);
}

// ── CORS ─────────────────────────────────────────────────────────────────────
{
  const env = ENV();
  check('the origins are SoRT\'s and Flood-Net\'s and no other', J(ORIGINS) === J(['https://cdomotor-g.github.io', 'https://floodwarning.net']));
  for (const o of ORIGINS) {
    const pre = await read(await handleSort(req('OPTIONS', '/files/index.json', { pass: null, origin: o,
      headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-sort-passphrase,if-match' } }), env, {}, deps));
    check(`${o}'s preflight, with no passphrase: 204, its origin named, GET, PUT, OPTIONS, the four headers, ETag exposed, a Max-Age, Vary: Origin`,
      pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === o
        && pre.headers.get('Access-Control-Allow-Methods') === 'GET, PUT, OPTIONS'
        && pre.headers.get('Access-Control-Allow-Headers') === 'content-type, x-sort-passphrase, if-match, if-none-match'
        && pre.headers.get('Access-Control-Expose-Headers') === 'ETag'
        && Number(pre.headers.get('Access-Control-Max-Age')) > 0 && /Origin/.test(pre.headers.get('Vary') || ''),
      `${pre.status} ${J(Object.fromEntries(pre.headers))}`);
  }
  const evilPre = await read(await handleSort(req('OPTIONS', '/check', { pass: null, origin: 'https://evil.example' }), env, {}, deps));
  check('another site\'s preflight: refused, with no CORS header', evilPre.status === 403 && !evilPre.headers.get('Access-Control-Allow-Origin') && !evilPre.headers.get('Access-Control-Allow-Methods'));
  const lookalike = await read(await handleSort(req('OPTIONS', '/check', { pass: null, origin: 'https://cdomotor-g.github.io.evil.example' }), env, {}, deps));
  const http = await read(await handleSort(req('OPTIONS', '/check', { pass: null, origin: 'http://cdomotor-g.github.io' }), env, {}, deps));
  check('… nor to a look-alike, or SoRT\'s own host over http', lookalike.status === 403 && http.status === 403 && !lookalike.headers.get('Access-Control-Allow-Origin'));

  const okSort = await go(env, 'GET', '/check', { origin: SORT_ORIGIN });
  check('an answer to SoRT\'s page names its origin and exposes ETag', okSort.status === 200 && okSort.headers.get('Access-Control-Allow-Origin') === SORT_ORIGIN
    && okSort.headers.get('Access-Control-Expose-Headers') === 'ETag' && /Origin/.test(okSort.headers.get('Vary') || ''));
  const no = await go(env, 'GET', '/check', { origin: SORT_ORIGIN, pass: WRONG });
  check('… a refusal too, so SoRT can read why (401 with its origin)', no.status === 401 && no.headers.get('Access-Control-Allow-Origin') === SORT_ORIGIN);
  const put = await go(env, 'PUT', '/files/index.json', { origin: SORT_ORIGIN, body: '{}', headers: { 'If-None-Match': '*' } });
  const got = await go(env, 'GET', '/files/index.json', { origin: SORT_ORIGIN });
  check('… a save and a read too, ETag exposed on both', put.headers.get('Access-Control-Allow-Origin') === SORT_ORIGIN && got.headers.get('Access-Control-Allow-Origin') === SORT_ORIGIN
    && got.headers.get('Access-Control-Expose-Headers') === 'ETag' && got.headers.get('ETag'));
  const evil = await go(env, 'GET', '/files/index.json', { origin: 'https://evil.example' });
  check('another site\'s page is answered (the passphrase decides) but with no CORS header, so the page cannot read it',
    evil.status === 200 && !evil.headers.get('Access-Control-Allow-Origin') && !evil.headers.get('Access-Control-Expose-Headers'));
  const cli = await go(env, 'GET', '/files/index.json');
  check('a client with no Origin (not a browser) and the passphrase is served, with no CORS header', cli.status === 200 && !cli.headers.get('Access-Control-Allow-Origin'));
}

// ── Brakes ───────────────────────────────────────────────────────────────────
{
  // Without the bindings: the isolate's window.
  const env = ENV();
  const ip = '192.0.2.10';
  const seq = [];
  for (let i = 0; i < SORT_RATE.limit + 1; i++) seq.push(await go(env, 'GET', '/check', { ip }));
  const last = seq[seq.length - 1];
  check(`${SORT_RATE.limit} requests a minute from one address, then 429 {"error":"slow down"} with Retry-After: 60`,
    SORT_RATE.limit === 120 && SORT_RATE.period === 60 && seq.slice(0, -1).every(r => r.status === 200)
      && last.status === 429 && last.text === '{"error":"slow down"}' && last.headers.get('Retry-After') === '60', J(seq.slice(-3).map(r => r.status)));
  const lastSort = await go(env, 'GET', '/check', { ip, origin: SORT_ORIGIN });
  check('… readable by SoRT\'s page', lastSort.status === 429 && lastSort.headers.get('Access-Control-Allow-Origin') === SORT_ORIGIN);
  const other = await go(env, 'GET', '/check', { ip: '192.0.2.11' });
  check('… while another address is not held up', other.status === 200);
  const pre = await read(await handleSort(req('OPTIONS', '/check', { ip, pass: null, origin: SORT_ORIGIN }), env, {}, deps));
  check('… and the preflight, which reads and stores nothing, is not held up either', pre.status === 204);
  now += 61000;
  const later = await go(env, 'GET', '/check', { ip });
  check('a minute on, the address is let through again', later.status === 200, later.text);
  now = NOW0;
}
{
  const env = ENV();
  const ip = '192.0.2.20';
  const seq = [];
  for (let i = 0; i < SORT_AUTH_FAIL.limit + 1; i++) seq.push(await go(env, 'GET', '/check', { ip, pass: WRONG }));
  check(`${SORT_AUTH_FAIL.limit} wrong passphrases a minute from one address are 401, the next 429 {"error":"slow down"}`,
    SORT_AUTH_FAIL.limit === 10 && SORT_AUTH_FAIL.period === 60 && seq.slice(0, -1).every(r => r.status === 401)
      && seq[seq.length - 1].status === 429 && seq[seq.length - 1].text === '{"error":"slow down"}', J(seq.map(r => r.status)));
  const right = await go(env, 'GET', '/check', { ip });
  check('… while the right passphrase from that address is still let in (an office\'s shared address is not locked out)', right.status === 200, right.text);
  const ip2 = '192.0.2.21';
  for (let i = 0; i < SORT_AUTH_FAIL.limit + 5; i++) await go(env, 'GET', '/check', { ip: ip2 });
  for (let i = 0; i < SORT_AUTH_FAIL.limit + 5; i++) await go(env, 'GET', '/check', { ip: ip2, pass: null });
  const firstWrong = await go(env, 'GET', '/check', { ip: ip2, pass: WRONG });
  check('right passphrases and missing ones are not counted as wrong', firstWrong.status === 401, firstWrong.text);
}
{
  const asked = { [SORT_RATE.binding]: [], [SORT_AUTH_FAIL.binding]: [] };
  let rateOk = true, failOk = true;
  const env = ENV({
    SORT_RATE_LIMIT: { limit: async o => { asked.SORT_RATE_LIMIT.push(o.key); return { success: rateOk }; } },
    SORT_AUTH_FAIL: { limit: async o => { asked.SORT_AUTH_FAIL.push(o.key); return { success: failOk }; } },
  });
  const ip = '192.0.2.30';
  await go(env, 'GET', '/check', { ip });
  await go(env, 'GET', '/files/index.json', { ip });
  await read(await handleSort(req('OPTIONS', '/check', { ip, pass: null, origin: SORT_ORIGIN }), env, {}, deps));
  check('with the bindings: SORT_RATE_LIMIT asked once a request (not for the preflight), SORT_AUTH_FAIL not at all for right ones',
    asked.SORT_RATE_LIMIT.length === 2 && asked.SORT_AUTH_FAIL.length === 0, J({ r: asked.SORT_RATE_LIMIT.length, f: asked.SORT_AUTH_FAIL.length }));
  check('… keyed by a hash, not the address itself', asked.SORT_RATE_LIMIT.every(k => /^[0-9a-f]{32}$/.test(k) && !k.includes('192')), J(asked.SORT_RATE_LIMIT));
  await go(env, 'GET', '/check', { ip, pass: WRONG });
  check('a wrong passphrase is counted by SORT_AUTH_FAIL', asked.SORT_AUTH_FAIL.length === 1);
  failOk = false;
  const held = await go(env, 'GET', '/check', { ip, pass: WRONG });
  const still = await go(env, 'GET', '/check', { ip });
  check('SORT_AUTH_FAIL saying no: a wrong one 429, a right one still 200', held.status === 429 && held.body.error === 'slow down' && still.status === 200, `${held.status} ${still.status}`);
  rateOk = false;
  const slow = await go(env, 'GET', '/check', { ip });
  check('SORT_RATE_LIMIT saying no: 429 for everything, right passphrase or not', slow.status === 429 && slow.body.error === 'slow down', slow.text);
  const broken = ENV({ SORT_RATE_LIMIT: { limit: async () => { throw new Error('binding down'); } } });
  const b = await go(broken, 'GET', '/check', { ip: '192.0.2.31' });
  check('a binding that errs falls back to the isolate\'s window rather than refusing', b.status === 200, b.text);
}

// ── A passphrase the forum sets itself (PUT /passphrase, its hash kept in R2) ─
{
  check('a passphrase is held to its letters and digits, in capitals', normPass(' The heron-audits, the gauge! ') === 'THEHERONAUDITSTHEGAUGE' && normPass('') === '');
  const S1 = 'Wombats queue politely at the ford', S2 = 'a heron audits the staff gauge';
  const env = { PHOTOS: bucket() };
  resetPassMemo();
  await env.PHOTOS.put(PASS_KEY, JSON.stringify({ sha256: sha(PASS_SALT + N(S1)) }));
  const a = await go(env, 'GET', '/check', { pass: 'WOMBATS queue - politely, at the FORD.' });
  check('with one in R2 (no SORT_PASS_SHA256), it is the one held to — typed however', a.status === 200, a.text);
  const b = await go(env, 'GET', '/check', { pass: S2 });
  check('… and any other is refused', b.status === 401, b.text);
  const bad = await go(env, 'PUT', '/passphrase', { pass: S1, body: '{"sha256":"nope"}' });
  check('PUT /passphrase wants {"sha256": 64 hex} (400 otherwise)', bad.status === 400 && bad.body.error === 'sha256', bad.text);
  const wrong = await go(env, 'PUT', '/passphrase', { pass: S2, body: J({ sha256: sha(PASS_SALT + N(S2)) }) });
  check('… and the current passphrase: a wrong one changes nothing (401)', wrong.status === 401 && JSON.parse((await env.PHOTOS.get(PASS_KEY).then(o => o.text()))).sha256 === sha(PASS_SALT + N(S1)), wrong.text);
  const ch = await go(env, 'PUT', '/passphrase', { pass: S1, body: J({ sha256: sha(PASS_SALT + N(S2)).toUpperCase() }) });
  check('with the right one it changes it: 200 {"ok":true}', ch.status === 200 && ch.text === '{"ok":true}', ch.text);
  const o = await env.PHOTOS.get(PASS_KEY); const stored = JSON.parse(await o.text());
  check('… only the new hash (lower case) and when, in R2', stored.sha256 === sha(PASS_SALT + N(S2)) && /^2026-/.test(stored.changed_at) && Object.keys(stored).length === 2, J(stored));
  const c1 = await go(env, 'GET', '/check', { pass: S2 }), c2 = await go(env, 'GET', '/check', { pass: S1 });
  check('the new one is in at once, the old one out', c1.status === 200 && c2.status === 401, `${c1.status} ${c2.status}`);
  const get = await go(env, 'GET', '/passphrase', { pass: S2 });
  check('GET /passphrase is 405 — the hash is never read back', get.status === 405 && !get.text.includes(stored.sha256), get.text);
  const ov = await go({ PHOTOS: bucket(), SORT_PASS_SHA256: HASH }, 'PUT', '/passphrase', { body: J({ sha256: HASH2 }) });
  check('with SORT_PASS_SHA256 on the Worker, it is the owner\'s: 409 {"error":"set in Cloudflare"}', ov.status === 409 && ov.body.error === 'set in Cloudflare', ov.text);
  // Another isolate's memo: a change elsewhere is seen within PASS_TTL_MS.
  resetPassMemo();
  const env2 = { PHOTOS: bucket() };
  await env2.PHOTOS.put(PASS_KEY, JSON.stringify({ sha256: sha(PASS_SALT + N(S1)) }));
  await go(env2, 'GET', '/check', { pass: S1 });
  await env2.PHOTOS.put(PASS_KEY, JSON.stringify({ sha256: sha(PASS_SALT + N(S2)) }));
  const stale = await go(env2, 'GET', '/check', { pass: S1 });
  now += PASS_TTL_MS + 1;
  const fresh = await go(env2, 'GET', '/check', { pass: S2 });
  check(`a change made elsewhere holds here within ${PASS_TTL_MS / 1000} s`, stale.status === 200 && fresh.status === 200, `${stale.status} ${fresh.status}`);
  resetPassMemo();
  const down = { PHOTOS: bucket() }; down.PHOTOS.failOn = (op, k) => op === 'get' && k === PASS_KEY;
  const r = await go(down, 'GET', '/check', { pass: S1 });
  check('if R2 can\'t say which passphrase is in force: 503, never the code\'s as a fall back', r.status === 503 && r.body.error === 'storage', r.text);
  resetPassMemo();
  SECRETS.push(S1, S2);
}

// ── The passphrase is in no log line and no answer ───────────────────────────
{
  const env = ENV();
  env.PHOTOS.failOn = (op, k) => op === 'get' || k.startsWith(HISTORY_PREFIX);
  await go(env, 'GET', '/files/index.json', { pass: PASS });
  await go(env, 'PUT', '/files/index.json', { pass: PASS, body: '{}', headers: { 'If-None-Match': '*' } });
  await go({ PHOTOS: bucket(), SORT_PASS_SHA256: 'not a hash' }, 'GET', '/check', { pass: PASS });
  check('the checks above did log something (an R2 failure, a hash not set up) — so the next one asks of real lines', logged.length >= 3, J(logged));
  const leaks = logged.filter(l => SECRETS.some(s => l.includes(s)) || l.includes(HASH) || l.includes(HASH2));
  check('no log line holds a passphrase, or the hash it is held to', leaks.length === 0, J(leaks));
  const echoes = answered.filter(t => SECRETS.some(s => t.includes(s)));
  check(`no answer, of the ${answered.length} given, echoes a passphrase`, echoes.length === 0, J(echoes.slice(0, 2)));
  const src = (await import('node:fs')).readFileSync(new URL('../worker/sort.js', import.meta.url), 'utf8');
  check('worker/sort.js never logs a request\'s headers', !/console\.\w+\([^)]*headers/i.test(src) && !/console\.\w+\([^)]*given/.test(src));
}

// ── Report ───────────────────────────────────────────────────────────────────
for (const k of Object.keys(realLog)) console[k] = realLog[k];
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.`
  : `\nPASS — ${results.length} checks: SoRT's files answer only to the forum passphrase, two paths' worth of them, no save blind, the hour's copy kept, SoRT's and Flood-Net's pages only, braked, and the passphrase in no log.`);
process.exitCode = failed.length ? 1 : 0;
