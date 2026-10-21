// The data archive (#243): worker/archive.js's door, and
// tools/archive/archive-to-r2.mjs and restore-day.mjs end to end — offline, R2
// a Map and the project a stand-in.
//
// What matters, because each fails in silence if wrong and the next thing to
// run is a nightly delete: only the secret key writes; an object is written
// once and never overwritten; what was written is what is read back; a day is
// recorded only after that read-back; a day that changed while it was being
// written is not recorded; and a version left half-done is stepped over, not
// overwritten.
//
// Run:  npm run archivestore

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handleArchive, archiveKey, isArchivePath } from '../worker/archive.js';
import { archive, objectKey, encodeDay, selfTest } from '../tools/archive/archive-to-r2.mjs';
import { restore } from '../tools/archive/restore-day.mjs';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });

function bucket() {
  const m = new Map();
  const meta = (k, v) => ({ key: k, size: v.bytes.length, httpMetadata: v.httpMetadata, customMetadata: v.customMetadata });
  return {
    m,
    async head(k) { const v = m.get(k); return v ? meta(k, v) : null; },
    async get(k) { const v = m.get(k); return v ? { ...meta(k, v), body: v.bytes } : null; },
    async put(k, body, opts = {}) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      if (opts.sha256 && createHash('sha256').update(bytes).digest('hex') !== opts.sha256) throw new Error('sha256 mismatch');
      m.set(k, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
      return meta(k, m.get(k));
    },
    async delete(k) { m.delete(k); },
  };
}

const ORIGIN = 'https://floodwarning.net';
const SECRET = 'sb_secret_ok';

// The project: the auth admin API answers the secret key; is_editor answers
// `editor-token`. Everything else is refused.
function project(env, db) {
  return async (url, init = {}) => {
    const u = String(url);
    const h = new Headers(init.headers || {});
    const auth = h.get('Authorization') || '';
    if (u.includes('/auth/v1/admin/users')) return new Response('{}', { status: auth === `Bearer ${SECRET}` ? 200 : 401 });
    if (u.endsWith('/rest/v1/rpc/is_editor')) return new Response(auth === 'Bearer editor-token' ? 'true' : 'false', { status: 200 });
    if (u.endsWith('/rest/v1/rpc/is_member')) return new Response('false', { status: 200 });
    if (u.startsWith(`${ORIGIN}/api/archive/`)) {
      return handleArchive(new Request(u, { method: init.method || 'GET', headers: h, body: init.body }), env);
    }
    if (db && u.includes('/rest/v1/rpc/')) {
      if (auth !== `Bearer ${SECRET}`) return new Response('{"code":"42501"}', { status: 403 });
      const fn = u.split('/rpc/')[1];
      const body = JSON.parse(init.body || '{}');
      try {
        return new Response(JSON.stringify(db[fn](body)), { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ code: e.code || 'P0001', message: e.message }), { status: 400 });
      }
    }
    if (db && u.includes('/rest/v1/archive_day?')) {
      const q = new URL(u).searchParams;
      if (!q.get('table_name')) {
        const rel = q.get('released_at');
        return new Response(JSON.stringify(db.manifest.filter(m => (rel ? !!m.released_at : true))), { status: 200 });
      }
      const t = q.get('table_name').slice(3), d = q.get('day').slice(3);
      const v = q.get('version') ? Number(q.get('version').slice(3)) : null;
      const rows = db.manifest.filter(r => r.table_name === t && r.day === d && (v === null || r.version === v)).sort((a, b) => b.version - a.version);
      return new Response(JSON.stringify(rows.slice(0, 1)), { status: 200 });
    }
    return new Response('not here', { status: 404 });
  };
}

function req(method, path, { token, body, rows, sha, len } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body) headers.set('Content-Length', String(len ?? body.length));
  if (rows !== undefined) headers.set('X-Archive-Rows', String(rows));
  if (sha) headers.set('X-Archive-Sha256', sha);
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

// ── Paths ─────────────────────────────────────────────────────────────────────
check('an archive path is ours', isArchivePath('/api/archive/reading/2026/10/01.v1.ndjson.gz') && !isArchivePath('/api/photos/x'));
check('a day of each table, by version, is an object',
  archiveKey('/api/archive/reading/2026/10/01.v1.ndjson.gz') === 'reading/2026/10/01.v1.ndjson.gz'
    && archiveKey('/api/archive/reading_raw/2026/02/28.v3.ndjson.gz') && archiveKey('/api/archive/reception/2026/10/21.v12.ndjson.gz'));
check('nothing else is', ['/api/archive/photo/2026/10/01.v1.ndjson.gz', '/api/archive/reading/2026/02/30.v1.ndjson.gz',
  '/api/archive/reading/2026/10/01.v0.ndjson.gz', '/api/archive/reading/2026/10/01.ndjson.gz', '/api/archive/reading/../x',
  '/api/archive/reading/2026/10/01.v1.ndjson.gz/x', '/api/archive/'].every(p => archiveKey(p) === null));
check('the object key the archiver writes is one the door accepts',
  archiveKey(`/api/archive/${objectKey('reception', '2026-10-05', 2)}`) === 'reception/2026/10/05.v2.ndjson.gz');

// ── The door ──────────────────────────────────────────────────────────────────
{
  const env = { ARCHIVE: bucket() };
  globalThis.fetch = project(env);
  const enc = encodeDay([[{ a: 1 }, { a: 2 }], [], [{ a: 3 }]]);
  const P = '/api/archive/reading/2026/10/01.v1.ndjson.gz';
  const put = (token, o = {}) => handleArchive(req('PUT', P, { token, body: enc.gz, rows: enc.rows, sha: enc.sha256, ...o }), env);

  check('no key, no write', (await put(undefined)).status === 401);
  check('an editor may not write either', (await put('editor-token')).status === 401);
  check('a write needs the row count and the hash',
    (await handleArchive(req('PUT', P, { token: SECRET, body: enc.gz, sha: enc.sha256 }), env)).status === 400
      && (await handleArchive(req('PUT', P, { token: SECRET, body: enc.gz, rows: 3, sha: 'abc' }), env)).status === 400);
  check('the bytes must be the hash R2 is told', (await put(SECRET, { sha: '0'.repeat(64) })).status >= 400 && !env.ARCHIVE.m.size);
  const r = await put(SECRET);
  check('the secret key writes a day', r.status === 201, await r.clone().text());
  check('… once: the same version again is refused', (await put(SECRET)).status === 409);
  const stored = env.ARCHIVE.m.get('reading/2026/10/01.v1.ndjson.gz');
  check('it is kept with its count and hash, as gzip', stored && stored.customMetadata.rows === '3'
    && stored.customMetadata.sha256 === enc.sha256 && stored.httpMetadata.contentEncoding === 'gzip');

  const anon = await handleArchive(req('GET', P), env);
  check('nobody reads it without signing in', anon.status === 401);
  const ed = await handleArchive(req('GET', P, { token: 'editor-token' }), env);
  const bytes = Buffer.from(await ed.arrayBuffer());
  check('an editor reads it back, byte for byte, with its count and hash',
    ed.status === 200 && createHash('sha256').update(bytes).digest('hex') === enc.sha256
      && ed.headers.get('X-Archive-Rows') === '3' && gunzipSync(bytes).toString() === '{"a":1}\n{"a":2}\n{"a":3}\n');
  check('a day not archived is a 404', (await handleArchive(req('GET', '/api/archive/reading/2026/10/02.v1.ndjson.gz', { token: SECRET }), env)).status === 404);
  check('no DELETE', (await handleArchive(req('DELETE', P, { token: SECRET }), env)).status === 405 && env.ARCHIVE.m.size === 1);
  check('unbound, it says so', (await handleArchive(req('GET', P, { token: SECRET }), {})).status === 503);
}

// ── The archiver, end to end ──────────────────────────────────────────────────
function fakeDb() {
  const days = {
    reading_raw: { '2026-09-01': [[{ id: 1, received_at: '2026-09-01T00:10:00Z' }], ...Array(22).fill([]), [{ id: 2 }]] },
    reception:   { '2026-10-04': [[{ id: 10, detail: {} }, { id: 11, detail: { crc: null } }], ...Array(23).fill([])],
                   '2026-10-05': [...Array(24).fill([])].map((_, h) => h === 5 ? [{ id: 20 }] : []) },
    reading:     {},
  };
  const db = {
    manifest: [],
    days,
    archive_due({ p_table }) {
      return Object.keys(days[p_table]).sort().map(day => {
        const rows = days[p_table][day].flat().length;
        const last = db.manifest.filter(m => m.table_name === p_table && m.day === day).sort((a, b) => b.version - a.version)[0];
        return last && last.rows === rows ? null : { day, rows, version: (last ? last.version : 0) + 1 };
      }).filter(Boolean);
    },
    archive_rows({ p_table, p_day, p_hour }) { return days[p_table][p_day][p_hour] || []; },
    archive_record({ p_table, p_day, p_version, p_rows, p_bytes, p_sha256, p_key }) {
      if (db.onRecord) db.onRecord(p_table, p_day);
      const now = days[p_table][p_day].flat().length;
      if (now !== p_rows) throw Object.assign(new Error('archive it again'), { code: '40001' });
      const last = Math.max(0, ...db.manifest.filter(m => m.table_name === p_table && m.day === p_day).map(m => m.version));
      if (p_version <= last) throw Object.assign(new Error('version'), { code: '22023' });
      if (p_key !== objectKey(p_table, p_day, p_version)) throw Object.assign(new Error('key'), { code: '22023' });
      db.manifest.push({ table_name: p_table, day: p_day, version: p_version, rows: p_rows, bytes: p_bytes, sha256: p_sha256, object_key: p_key, archived_at: 'now' });
      return { ok: true };
    },
  };
  return db;
}

{
  const env = { ARCHIVE: bucket() };
  const db = fakeDb();
  const fetch = project(env, db);
  const ENV = { SUPABASE_SECRET_KEY: SECRET, ARCHIVE_URL: `${ORIGIN}/api/archive`, SUPABASE_URL: 'https://db.example' };

  const dry = await archive({ env: { ...ENV, DRY_RUN: '1' }, fetch });
  check('a dry run lists and writes nothing', dry.left === 3 && env.ARCHIVE.m.size === 0 && !db.manifest.length);

  const r1 = await archive({ env: ENV, fetch });
  check('a run archives every day due, and records each', r1.archived === 3 && db.manifest.length === 3 && env.ARCHIVE.m.size === 3, JSON.stringify(r1));
  const back = await restore({ table: 'reception', day: '2026-10-04', env: ENV, fetch });
  check('restore-day gives the day back, a row a line, as it was',
    back.text === '{"id":10,"detail":{}}\n{"id":11,"detail":{"crc":null}}\n' && back.manifest.version === 1);

  const r2 = await archive({ env: ENV, fetch });
  check('a second run has nothing to do', r2.archived === 0 && db.manifest.length === 3);

  // A late row: the day is offered again, as version 2, beside version 1.
  db.days.reception['2026-10-04'][7] = [{ id: 12 }];
  const r3 = await archive({ env: ENV, fetch });
  check('a late row archives its day again, as the next version, beside the first',
    r3.archived === 1 && env.ARCHIVE.m.has('reception/2026/10/04.v1.ndjson.gz') && env.ARCHIVE.m.has('reception/2026/10/04.v2.ndjson.gz')
      && db.manifest.find(m => m.day === '2026-10-04' && m.version === 2).rows === 3);

  // A row arriving while the day is being written: not recorded, offered again.
  db.onRecord = (t, d) => { if (d === '2026-10-05') { db.days.reception['2026-10-05'][9] = [{ id: 21 }]; db.onRecord = null; } };
  db.days.reception['2026-10-05'][6] = [{ id: 22 }];
  const r4 = await archive({ env: ENV, fetch });
  check('a row that arrives while its day is written: nothing recorded, the day offered again',
    r4.again === 1 && !db.manifest.find(m => m.day === '2026-10-05' && m.version === 2));
  const r5 = await archive({ env: ENV, fetch });
  const v = db.manifest.filter(m => m.day === '2026-10-05').map(m => m.version).sort();
  check('… and the next run steps over the half-done version rather than overwrite it',
    r5.archived === 1 && v.join() === '1,3' && env.ARCHIVE.m.has('reception/2026/10/05.v2.ndjson.gz') && env.ARCHIVE.m.has('reception/2026/10/05.v3.ndjson.gz'),
    JSON.stringify({ r5, v }));

  const st = await selfTest({ env: ENV, fetch, pick: () => 0 });
  check('the self-test gets an archived day back and checks it against the manifest', st && st.rows >= 1 && st.object_key, JSON.stringify(st));
  const k0 = [...env.ARCHIVE.m.keys()][0];
  const v0 = env.ARCHIVE.m.get(k0);
  env.ARCHIVE.m.set(k0, { ...v0, bytes: new Uint8Array([...v0.bytes].map((b, i) => (i === v0.bytes.length - 1 ? b ^ 1 : b))) });
  const bad = await (async () => { for (let i = 0; i < 20; i += 1) { try { await selfTest({ env: ENV, fetch, pick: () => i / 20 }); } catch (e) { return e; } } return null; })();
  check('… and fails when an object is not what was recorded', bad && /SHA-256/.test(bad.message), String(bad && bad.message));
  env.ARCHIVE.m.set(k0, v0);

  const noKey = await archive({ env: { ...ENV, SUPABASE_SECRET_KEY: '' }, fetch }).catch(e => e);
  check('without the secret key it does nothing and says so', noKey.code === 'nokey');
  const unbound = await archive({ env: ENV, fetch: project({}, fakeDb()) }).catch(e => e);
  check('with no bucket bound it stops at the first day and says so', unbound.unbound === true);
}

// ── Report ────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.` : `\nPASS — ${results.length} checks: only the secret key writes the archive, nothing is overwritten, and a day is recorded only once it reads back the same.`);
process.exitCode = failed.length ? 1 : 0;
