#!/usr/bin/env node
// tools/archive/restore-day.mjs — fetch one archived day back out of R2 (#243).
//
//   SUPABASE_SECRET_KEY=… node restore-day.mjs reception 2026-10-05 > day.ndjson
//   SUPABASE_SECRET_KEY=… node restore-day.mjs reading 2026-08-17 2      a version other than the latest
//
// Writes the day's rows to stdout, a JSON object a line, every column as the
// database stored it (archive_rows(), 0073), after checking the object's
// SHA-256 and line count against the manifest. An editor's access token works
// in place of the secret key (ACCESS_TOKEN=…).
//
// To look at a day in Postgres again without putting it back in the live
// table, load it into a table of the same shape:
//
//   create temporary table day (like meganet.reception);
//   create temporary table lines (j jsonb);
//   \copy lines from 'day.ndjson'
//   insert into day select (jsonb_populate_record(null::meganet.reception, j)).* from lines;
//
// (For a reception, meganet.reception_detail(d) on a row of `day` gives its
// detail as it was posted.)

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PUBLISHABLE_KEY } from '../../worker/api.js';

const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const DEFAULT_ARCHIVE_URL = 'https://floodwarning.net/api/archive';

export async function restore({ table, day, version, env = {}, fetch = globalThis.fetch }) {
  if (!/^(reading|reading_raw|reception)$/.test(table || '')) throw new Error('table: reading, reading_raw or reception');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('day: YYYY-MM-DD');
  const key = env.SUPABASE_SECRET_KEY || env.ACCESS_TOKEN;
  if (!key) throw new Error('SUPABASE_SECRET_KEY (or an editor\'s ACCESS_TOKEN) is needed');
  const url = (env.SUPABASE_URL || '').trim() || DEFAULT_SUPABASE_URL;
  const archive = ((env.ARCHIVE_URL || '').trim() || DEFAULT_ARCHIVE_URL).replace(/\/+$/, '');

  // The manifest: which version, how many rows, what hash.
  const q = `${url}/rest/v1/archive_day?table_name=eq.${table}&day=eq.${day}`
          + (version ? `&version=eq.${Number(version)}` : '') + '&order=version.desc&limit=1';
  const res = await fetch(q, { headers: { apikey: env.SUPABASE_SECRET_KEY ? key : PUBLISHABLE_KEY,
                                          Authorization: `Bearer ${key}`, 'Accept-Profile': 'meganet' } });
  if (!res.ok) throw new Error(`the manifest: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const [m] = await res.json();
  if (!m) throw new Error(`${table} on ${day}${version ? ` version ${version}` : ''} is not in the archive`);

  const obj = await fetch(`${archive}/${m.object_key}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!obj.ok) throw new Error(`${m.object_key}: ${obj.status}`);
  const gz = Buffer.from(await obj.arrayBuffer());
  const sha = createHash('sha256').update(gz).digest('hex');
  if (sha !== m.sha256) throw new Error(`${m.object_key}: SHA-256 ${sha} is not the manifest's ${m.sha256}`);
  const text = gunzipSync(gz).toString('utf8');
  const n = text.split('\n').filter(Boolean).length;
  if (n !== Number(m.rows)) throw new Error(`${m.object_key}: ${n} rows, the manifest says ${m.rows}`);
  return { text, manifest: m };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [table, day, version] = process.argv.slice(2);
  try {
    const { text, manifest } = await restore({ table, day, version, env: process.env });
    process.stdout.write(text);
    console.error(`${manifest.object_key}: ${manifest.rows} rows, archived ${manifest.archived_at}${manifest.released_at ? `, released ${manifest.released_at}` : ''}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
