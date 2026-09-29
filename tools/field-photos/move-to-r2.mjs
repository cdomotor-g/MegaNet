#!/usr/bin/env node
// tools/field-photos/move-to-r2.mjs — carry the field photos' bytes out of
// Supabase Storage and into Cloudflare R2, through MegaNet's Worker.
//
//   SUPABASE_SECRET_KEY=… node move-to-r2.mjs            move everything
//   SUPABASE_SECRET_KEY=… DRY_RUN=1 node move-to-r2.mjs  only count
//
// Nothing in meganet.field_photo changes: an object keeps its path, and only
// where the path is looked up moves (worker/photos.js; datastore.js signs a
// path the store does not hold in Supabase instead, which is what keeps every
// photo on screen while this runs). Each object is put to the store first and
// removed from Supabase only once the store has said it holds it — a 409 from
// the store is "already carried over", so a run stopped half way is resumed by
// running it again. Run by .github/workflows/field-photos-r2.yml, by hand and
// once a day, which also sweeps up anything a sync or a browser had to write to
// Supabase while the store was unreachable.
//
//   PHOTO_STORE_URL    default https://floodwarning.net/api/photos
//   SUPABASE_URL       default MegaNet's own project
//   MAX_OBJECTS, TIME_BUDGET_S   how much one run may do (5000, 1500 s)

import { client, DEFAULT_PHOTO_STORE } from './lib/supabase.mjs';

// lib/run.mjs's, repeated rather than imported: run.mjs brings the photo
// reader and its npm dependencies, and this needs nothing but fetch.
const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';

export async function move({ env = {}, fetch = globalThis.fetch, log = () => {}, now = () => Date.now() } = {}) {
  const store = (env.PHOTO_STORE_URL || '').trim() || DEFAULT_PHOTO_STORE;
  const db = client(fetch, { url: env.SUPABASE_URL || DEFAULT_SUPABASE_URL, key: env.SUPABASE_SECRET_KEY, store });
  const dry = !!env.DRY_RUN;
  const max = Number(env.MAX_OBJECTS) || 5000;
  const until = now() + (Number(env.TIME_BUDGET_S) || 1500) * 1000;
  const out = { moved: 0, already: 0, failed: 0, bytes: 0, left: 0 };

  // Listed whole before anything moves, so removing as it goes cannot shift the
  // pages under the listing.
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listStorage('photo', 100, offset);
    all.push(...page.filter(o => o && o.id && o.name));    // folders come back without an id
    if (page.length < 100) break;
  }
  for (const o of all) {
    const path = `photo/${o.name}`;
    if (dry || out.moved + out.already + out.failed >= max || now() > until) {
      out.left += 1;
      out.bytes += dry ? Number(o.metadata && o.metadata.size) || 0 : 0;
      continue;
    }
    try {
      const { bytes, type } = await db.downloadStorage(path);
      try {
        await db.putStore(path, bytes, (o.metadata && o.metadata.mimetype) || type);
        out.moved += 1;
        out.bytes += bytes.length;
      } catch (err) {
        if (err.status !== 409) throw err;
        out.already += 1;
      }
      await db.removeStorage(path);
    } catch (err) {
      // Every object would fail the same way: stop and say so.
      if (err.code === 'unbound' || err.status === 401 || err.status === 403 || (err.status >= 300 && err.status < 400)) throw err;
      out.failed += 1;
      log(`  failed ${path} — ${err.message}`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mb = b => `${(b / 1048576).toFixed(1)} MB`;
  try {
    const r = await move({ env: process.env, log: s => console.log(s) });
    if (process.env.DRY_RUN) console.log(`${r.left} object${r.left === 1 ? '' : 's'} (${mb(r.bytes)}) in Supabase Storage to move.`);
    else console.log(`Moved ${r.moved} (${mb(r.bytes)}); ${r.already} were already in R2; ${r.failed} failed; ${r.left} left for the next run.`);
    if (r.failed) process.exitCode = 1;
  } catch (err) {
    if (err.code === 'unbound') { console.log(`::notice::Nothing moved — ${err.message}.`); }
    else { console.error(`FAILED — ${err.message}`); process.exitCode = 1; }
  }
}
