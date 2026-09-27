// tools/field-photos/lib/run.mjs — one run of the Dropbox sync.
//
//   1. Where the last run got to: the Dropbox cursor, kept in
//      meganet.field_photo_sync_cursor (service_role only).
//   2. What is new in the folder since — every file, in the folder and under
//      it, oldest first.
//   3. What the listing holds that was imported before — a removed one
//      included, the tombstone keeps it removed — asked a hundred at a time
//      and skipped. For each photo left: downloaded;
//      read by photo-meta.js exactly as the Field Photos tab reads a dropped
//      file (EXIF, then the overlay by OCR); skipped if the same bytes are
//      already in MegaNet (dropped in by hand); uploaded — the photo and its
//      thumbnail — and indexed through meganet.add_field_photo(), which files
//      it under the nearest station and refuses what it must.
//   4. The cursor moves on only when every photo the listing held was dealt
//      with. A run that stopped early (a cap, a time limit, an error) leaves it
//      where it was, and the next run lists the same photos again and skips
//      the ones this run imported — slower, never lossy. The cap and the time
//      limit count only the photos a run works on, never the ones it skips as
//      imported before: counted, a backlog longer than the cap would be
//      re-skipped from its oldest end every run and never got past.
//   5. What it did, in meganet.field_photo_sync, for the tab to show.
//
// Everything that talks to the outside world is passed in, so the tests run it
// against a fake Dropbox and a fake project with no network at all.

import crypto from 'node:crypto';
import { readPhoto, PhotoMeta } from './read.mjs';
import { accessToken, account, changes, download } from './dropbox.mjs';
import { client } from './supabase.mjs';

export const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;
const MAX_BYTES = 24 * 1024 * 1024;        // meganet.attachment_type's limit for a picture (0010: 25165824)
const HOME = { lat: -25, lon: 145, km: 3000 };   // the one guess the overlay parser may make: which side of the equator
const KEEP_FILES = 60;                      // file results kept in the report's detail

export async function run({
  env = {}, fetch, log = () => {}, worker = null,
  now = () => new Date(), uuid = () => crypto.randomUUID(),
} = {}) {
  const started = now();
  const folder = (env.DROPBOX_FOLDER || '').replace(/\/+$/, '');
  const maxFiles = Math.max(1, Number(env.MAX_FILES) || 150);
  const budgetMs = Math.max(10000, Number(env.TIME_BUDGET_S || 600) * 1000);
  const report = {
    source: 'dropbox', folder: folder || '(the app folder)', account: null,
    last_run_at: started.toISOString(), last_error: null,
    seen: 0, imported: 0, unplaced: 0, skipped: 0, failed: 0,
    detail: { files: [], complete: false },
  };
  const files = report.detail.files;
  const note = (entry, result, reason, id) => {
    files.push({ name: entry.name, path: entry.path_display || null, result, reason: reason || null, id: id || null });
    if (files.length > KEEP_FILES) files.shift();
    log(`  ${result.padEnd(8)} ${entry.path_display || entry.name}${reason ? ` — ${reason}` : ''}`);
  };

  const db = client(fetch, { url: env.SUPABASE_URL || DEFAULT_SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
  let prior = null;
  try {
    prior = (await db.select('field_photo_sync?source=eq.dropbox&select=runs')).at(0) || null;
    const saved = (await db.select('field_photo_sync_cursor?source=eq.dropbox&select=cursor')).at(0);

    const token = await accessToken(fetch, {
      appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken: env.DROPBOX_REFRESH_TOKEN,
    });
    try { report.account = await account(fetch, token); } catch (_) { report.account = null; }
    const by = `Dropbox — ${report.account || 'the linked account'}`;

    const listing = await changes(fetch, token, { folder, cursor: saved && saved.cursor });
    if (listing.reset) log('  Dropbox reset the cursor — listing the folder from the start');
    const photos = listing.entries
      .filter(e => PHOTO_EXT.test(e.name || ''))
      .sort((a, b) => String(a.server_modified || '').localeCompare(String(b.server_modified || '')));
    report.seen = photos.length;
    log(`${photos.length} new or changed photo${photos.length === 1 ? '' : 's'} in ${report.folder}${report.account ? `, ${report.account}'s Dropbox` : ''}`);

    // Imported before: one query a hundred files, not one a file.
    const known = new Map();
    for (let i = 0; i < photos.length; i += 100) {
      const ids = photos.slice(i, i + 100).map(e => `"${String(e.id).replace(/["\\]/g, '')}"`).join(',');
      const rows = await db.select(`field_photo?select=id,origin_ref,deleted_at&origin=eq.dropbox&origin_ref=in.(${encodeURIComponent(ids)})`);
      for (const r of rows) known.set(r.origin_ref, r);
    }
    const before = photos.filter(e => known.has(e.id));
    report.skipped += before.length;
    if (before.length <= 20) {
      for (const e of before) {
        const had = known.get(e.id);
        note(e, 'skipped', had.deleted_at ? 'removed from MegaNet — not brought back' : 'already imported', had.id);
      }
    } else {
      const gone = before.filter(e => known.get(e.id).deleted_at).length;
      log(`  ${before.length} imported before${gone ? ` (${gone} of them since removed from MegaNet)` : ''} — skipped`);
    }

    let handled = 0;
    let complete = true;
    for (const e of photos.filter(x => !known.has(x.id))) {
      if (handled >= maxFiles || now() - started > budgetMs) { complete = false; break; }
      handled++;
      try {
        const out = await one(e);
        report[out.result]++;
        if (out.unplaced) report.unplaced++;
        note(e, out.result, out.reason, out.id);
      } catch (err) {
        report.failed++;
        note(e, 'failed', (err && err.message) || String(err));
      }
    }
    report.detail.complete = complete;
    if (complete) {
      await db.upsert('field_photo_sync_cursor', { source: 'dropbox', cursor: listing.cursor });
    } else {
      log(`  stopped after ${handled} — the rest are listed again next run`);
    }
    report.last_ok_at = now().toISOString();

    async function one(e) {
      if (e.size > MAX_BYTES) return { result: 'skipped', reason: `${(e.size / 1048576).toFixed(1)} MB is over the 24 MB a photo may be` };

      const buf = await download(fetch, token, e.id);
      const r = await readPhoto(buf, { name: e.name, worker, home: HOME });
      const dup = await db.select(`field_photo?select=id&sha256=eq.${r.sha}&deleted_at=is.null&limit=1`);
      if (dup.length) return { result: 'skipped', reason: 'the same photo is already in MegaNet', id: dup[0].id };

      const id = uuid();
      const path = `photo/${id}.${r.ext}`;
      const thumb = r.thumb ? `photo/${id}.thumb.jpg` : null;
      await db.upload(path, r.upload, r.contentType);
      const takeDown = async () => {
        try { await db.remove(path); } catch (_) { /* an orphan is swept later */ }
        if (thumb) { try { await db.remove(thumb); } catch (_) { /* ditto */ } }
      };
      try {
        if (thumb) await db.upload(thumb, r.thumb, 'image/jpeg');
      } catch (err) { await takeDown(); throw err; }

      const p = PhotoMeta.record({ ...r, type: r.converted ? 'image/heic' : r.contentType });
      Object.assign(p, {
        storage_path: path, thumb_path: thumb, content_type: r.contentType,
        byte_size: r.upload.length, sha256: r.sha,
        origin: 'dropbox', origin_ref: e.id, uploaded_by: by,
      });
      p.meta.dropbox = { path: e.path_display || null, rev: e.rev || null, content_hash: e.content_hash || null,
                         server_modified: e.server_modified || null, client_modified: e.client_modified || null };
      if (r.ocrError) p.meta.ocr_error = String(r.ocrError).slice(0, 300);

      let row;
      try {
        row = await db.rpc('add_field_photo', { p_photo: p });
      } catch (err) {
        await takeDown();
        if (err && err.status === 409) return { result: 'skipped', reason: 'already in MegaNet (the database said so)', id: err.details || null };
        throw err;
      }
      const placed = row && row.lat !== null && row.lat !== undefined;
      return {
        result: 'imported', id: row && row.id, unplaced: !placed,
        reason: placed ? `${r.pos.placement === 'ocr' ? `read off the photo (${r.pos.confidence})` : 'the camera\'s GPS'}${row.station_id ? `, filed under ${row.station_id}` : ''}`
                       : 'nothing says where it was taken — it is in Unplaced',
      };
    }
  } catch (err) {
    report.last_error = String((err && err.message) || err).slice(0, 500);
    log(`FAILED — ${report.last_error}`);
  }

  report.runs = ((prior && prior.runs) || 0) + 1;
  try {
    await db.upsert('field_photo_sync', report);
  } catch (err) {
    log(`the report could not be written — ${(err && err.message) || err}`);
    if (!report.last_error) report.last_error = `the report could not be written — ${(err && err.message) || err}`;
  }
  return { ok: !report.last_error && report.failed === 0, report };
}
