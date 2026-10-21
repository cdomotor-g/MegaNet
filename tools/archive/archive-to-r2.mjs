#!/usr/bin/env node
// tools/archive/archive-to-r2.mjs — write every finished UTC day of
// meganet.reading, reading_raw and reception to the data archive in R2, before
// the database is allowed to let any of it go (#243, db/migrations/0073).
//
//   SUPABASE_SECRET_KEY=… node archive-to-r2.mjs            archive what is due
//   SUPABASE_SECRET_KEY=… DRY_RUN=1 node archive-to-r2.mjs  only list it
//
// For each table, asks the database which days are due (archive_due: two or
// more days old, not archived at their count now), and for each day:
//
//   1. reads it an hour at a time (archive_rows), a JSON line a row;
//   2. gzips it and takes its SHA-256;
//   3. puts it through the Worker (/api/archive/…, create-only; R2 checks the
//      hash on the way in);
//   4. reads it back — fetches the object, gunzips it, and checks its hash,
//      its line count and that it is the same bytes;
//   5. and only then records it (archive_record), which refuses a count that
//      is no longer the day's — a row came in meanwhile — so the day is simply
//      offered again on the next run, as the next version.
//
// Nothing here deletes anything. meganet.retain() deletes, nightly, and only
// days recorded here. Run by .github/workflows/archive-r2.yml.
//
//   ARCHIVE_URL      default https://floodwarning.net/api/archive
//   SUPABASE_URL     default Flood-Net's own project
//   TABLES           default reading_raw,reception,reading
//   MAX_DAYS, TIME_BUDGET_S   how much one run may do (60 days a table, 1500 s)

import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { restore } from './restore-day.mjs';

const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const DEFAULT_ARCHIVE_URL = 'https://floodwarning.net/api/archive';
const TABLES = ['reading_raw', 'reception', 'reading'];

export function objectKey(table, day, version) {
  const [y, m, d] = day.split('-');
  return `${table}/${y}/${m}/${d}.v${version}.ndjson.gz`;
}

export function encodeDay(rowsByHour) {
  const lines = [];
  for (const rows of rowsByHour) for (const r of rows) lines.push(JSON.stringify(r));
  const text = lines.length ? lines.join('\n') + '\n' : '';
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  return { gz, rows: lines.length, sha256: createHash('sha256').update(gz).digest('hex') };
}

function client(fetch, { url, key, archive }) {
  const rpc = async (fn, body) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
                 'Content-Profile': 'meganet', 'Accept-Profile': 'meganet' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${fn}: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      try { err.code = JSON.parse(text).code; } catch (_) { /* not JSON */ }
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
  const put = async (k, gz, rows, sha) => {
    const res = await fetch(`${archive}/${k}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/gzip',
                 'Content-Length': String(gz.length), 'X-Archive-Rows': String(rows), 'X-Archive-Sha256': sha },
      body: gz,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`PUT ${k}: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      try { err.unbound = !!JSON.parse(text).unbound; } catch (_) { /* not JSON */ }
      throw err;
    }
  };
  const get = async (k) => {
    const res = await fetch(`${archive}/${k}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw Object.assign(new Error(`GET ${k}: ${res.status}`), { status: res.status });
    return { bytes: Buffer.from(await res.arrayBuffer()), rows: res.headers.get('X-Archive-Rows'), sha256: res.headers.get('X-Archive-Sha256') };
  };
  return { rpc, put, get };
}

export async function archive({ env = {}, fetch = globalThis.fetch, log = () => {}, now = () => Date.now() } = {}) {
  if (!env.SUPABASE_SECRET_KEY) throw Object.assign(new Error('SUPABASE_SECRET_KEY is not set'), { code: 'nokey' });
  const db = client(fetch, {
    url: (env.SUPABASE_URL || '').trim() || DEFAULT_SUPABASE_URL,
    key: env.SUPABASE_SECRET_KEY,
    archive: ((env.ARCHIVE_URL || '').trim() || DEFAULT_ARCHIVE_URL).replace(/\/+$/, ''),
  });
  const dry = !!env.DRY_RUN;
  const maxDays = Number(env.MAX_DAYS) || 60;
  const until = now() + (Number(env.TIME_BUDGET_S) || 1500) * 1000;
  const tables = (env.TABLES || '').trim() ? env.TABLES.split(',').map(s => s.trim()).filter(Boolean) : TABLES;
  const out = { archived: 0, rows: 0, bytes: 0, again: 0, failed: 0, left: 0, tables: {} };

  for (const table of tables) {
    const due = await db.rpc('archive_due', { p_table: table, p_limit: 1000 });
    const t = out.tables[table] = { due: due.length, archived: 0, rows: 0, bytes: 0 };
    for (const [i, d] of due.entries()) {
      if (dry || i >= maxDays || now() > until) { out.left += 1; continue; }
      let k = objectKey(table, d.day, d.version);
      try {
        const hours = [];
        for (let h = 0; h < 24; h += 1) hours.push(await db.rpc('archive_rows', { p_table: table, p_day: d.day, p_hour: h }));
        const enc = encodeDay(hours);
        if (enc.rows !== Number(d.rows)) {
          // The day changed between asking and reading: leave it for next time.
          out.again += 1;
          log(`  ${k}: ${enc.rows} rows read, ${d.rows} expected — the day is still changing; next run`);
          continue;
        }
        // Put, then read back. A version already there (a run stopped between
        // its put and its record) is used if it is these bytes, and stepped
        // over if it is not: objects are never overwritten.
        let version = d.version;
        let stored = false;
        for (let tries = 0; tries < 5 && !stored; tries += 1, version += 1) {
          k = objectKey(table, d.day, version);
          try {
            await db.put(k, enc.gz, enc.rows, enc.sha256);
          } catch (err) {
            if (err.status !== 409) throw err;
          }
          const back = await db.get(k);
          const backSha = createHash('sha256').update(back.bytes).digest('hex');
          if (backSha !== enc.sha256) { log(`  ${k}: already holds other bytes — trying the next version`); continue; }
          const backLines = gunzipSync(back.bytes).toString('utf8').split('\n').filter(Boolean).length;
          if (back.sha256 !== enc.sha256 || backLines !== enc.rows || Number(back.rows) !== enc.rows) {
            throw new Error(`${k}: read back ${backLines} rows (header ${back.rows}), not the ${enc.rows} written`);
          }
          stored = true;
        }
        if (!stored) throw new Error(`${k}: five versions in a row already hold other bytes`);
        version -= 1;
        try {
          await db.rpc('archive_record', { p_table: table, p_day: d.day, p_version: version, p_rows: enc.rows,
                                           p_bytes: enc.gz.length, p_sha256: enc.sha256, p_key: k });
        } catch (err) {
          if (err.code !== '40001') throw err;
          out.again += 1;
          log(`  ${k}: a row arrived while it was written — offered again next run`);
          continue;
        }
        out.archived += 1; out.rows += enc.rows; out.bytes += enc.gz.length;
        t.archived += 1; t.rows += enc.rows; t.bytes += enc.gz.length;
        log(`  ${k}: ${enc.rows} rows, ${(enc.gz.length / 1024).toFixed(0)} KB`);
      } catch (err) {
        // Every day would fail the same way: stop and say so.
        if (err.unbound || err.status === 401 || err.status === 403) throw err;
        out.failed += 1;
        log(`  failed ${k} — ${err.message}`);
      }
    }
  }
  return out;
}

// Each run also gets one archived day back — released ones first, the days the
// database no longer holds — exactly as restore-day.mjs would, so a broken
// round trip shows as a red run, not on the day somebody needs it.
export async function selfTest({ env = {}, fetch = globalThis.fetch, pick = Math.random } = {}) {
  const url = (env.SUPABASE_URL || '').trim() || DEFAULT_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  const q = async (filter) => {
    const res = await fetch(`${url}/rest/v1/archive_day?select=table_name,day,version${filter}&order=day.desc&limit=200`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'meganet' } });
    if (!res.ok) throw new Error(`the manifest: ${res.status}`);
    return res.json();
  };
  let days = await q('&released_at=not.is.null');
  if (!days.length) days = await q('');
  if (!days.length) return null;
  const d = days[Math.floor(pick() * days.length)];
  const { manifest } = await restore({ table: d.table_name, day: d.day, version: d.version, env, fetch });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mb = b => `${(b / 1048576).toFixed(1)} MB`;
  try {
    const r = await archive({ env: process.env, log: s => console.log(s) });
    for (const [t, x] of Object.entries(r.tables)) console.log(`${t}: ${x.due} day(s) due, ${x.archived} archived (${x.rows} rows, ${mb(x.bytes)})`);
    if (process.env.DRY_RUN) console.log(`Dry run: ${r.left} day(s) would be archived.`);
    else console.log(`Archived ${r.archived} day(s), ${r.rows} rows, ${mb(r.bytes)}; ${r.again} to try again; ${r.failed} failed; ${r.left} left for the next run.`);
    if (r.failed) process.exitCode = 1;
    if (!process.env.DRY_RUN) {
      const m = await selfTest({ env: process.env });
      if (m) console.log(`Self-test: ${m.object_key} restored — ${m.rows} rows, its hash the manifest's${m.released_at ? ' (a day the database no longer holds)' : ''}.`);
    }
  } catch (err) {
    if (err.code === 'nokey') { console.log(`::notice::${err.message} — nothing archived.`); }
    else if (err.unbound) { console.log('::warning::The Worker has no ARCHIVE binding yet — nothing archived.'); }
    else { console.error(err.message); process.exitCode = 1; }
  }
}
