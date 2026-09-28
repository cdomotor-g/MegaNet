// tools/field-photos/lib/run.mjs — one run of a folder sync: Dropbox's, or
// Google Drive's.
//
// Where the photos come from is a provider — lib/dropbox.mjs or lib/gdrive.mjs —
// which is everything a run needs of a place photos are saved to, and nothing
// of MegaNet's:
//
//   source    the origin its photos are filed under ('dropbox', 'gdrive'), and
//             the key of its rows in field_photo_sync and field_photo_sync_cursor
//   label     what it is called in a sentence
//   settings(env)            what the environment says: no call and no throw,
//                            so there is a report whatever is missing
//   connect(settings, fetch, { now })   signed in — { account, by, … } — or a
//                            sentence thrown saying why not
//   changes(session, cursor) → { entries, cursor, reset }: every file new or
//                            changed since the cursor, and the cursor to keep
//                            once each of them has been dealt with
//   download(session, entry) → the file's bytes
//
// and a file is { ref, name, path, size, modified, meta }: `ref` the provider's
// own id for it (the photo's origin_ref), `meta` what the photo keeps of it
// (meta.dropbox, meta.gdrive).
//
//   1. Where the last run got to: the provider's cursor, kept in
//      meganet.field_photo_sync_cursor (service_role only).
//   2. What is new in the folder since — every file, in the folder and under
//      it, oldest first: photos, and zip packs of photos.
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
//   5. What it did, in meganet.field_photo_sync, for the tab to show; and a row
//      for each file it tried, in meganet.field_photo_upload — best effort:
//      that log is never the reason a run fails.
//
// A zip pack (lib/zip.mjs) is opened when the run reaches it, and each photo in
// it is a file of its own: origin_ref `<the zip's ref>#<its path in the zip>`,
// its own name for the title, and meta.<source>.archive = { name: the zip's,
// path: in it }. Nothing marks a zip done but the cursor — a run that finishes
// moves past it like any other file. A run that stops inside one leaves the
// cursor where it was, and the next downloads the zip again, asks after its
// photos' refs as in 3 once it has read the zip's directory, and skips the ones
// already in: a zip's photos are counted, capped and skipped exactly as loose
// ones are, for the price of a second download.
//
// Everything that talks to the outside world is passed in, so the tests run it
// against a fake Dropbox, a fake Google and a fake project with no network.

import crypto from 'node:crypto';
import { readPhoto, PhotoMeta } from './read.mjs';
import { dropbox } from './dropbox.mjs';
import { gdrive } from './gdrive.mjs';
import { openZip, ZipError, ZIP_LIMITS } from './zip.mjs';
import { client } from './supabase.mjs';

export const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
export const PROVIDERS = Object.freeze({ dropbox, gdrive });
const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;
const ZIP_EXT = /\.zip$/i;
const MAX_BYTES = 24 * 1024 * 1024;        // meganet.attachment_type's limit for a picture (0010: 25165824)
const HOME = { lat: -25, lon: 145, km: 3000 };   // the one guess the overlay parser may make: which side of the equator
const KEEP_FILES = 60;                      // file results kept in the report's detail
const LOOKUP_CHARS = 6000;                  // origin_refs in one look-up, as they go in its URL
const LOG_ROWS = 500;                       // upload-log rows a call

// A photo in a zip — and not macOS's resource fork beside it, which
// (__MACOSX/…/._IMG_0042.jpg) is a .jpg by name only.
const photoInZip = e => PHOTO_EXT.test(e.name) && !e.name.startsWith('._') && !/(^|\/)__MACOSX\//.test(e.path);

// The origin_ref of a photo in a zip. `"` and `%` are escaped, so the ref goes
// into a look-up as a quoted value and comes back as it was written.
const inZip = (zipRef, path) => `${zipRef}#${path.replace(/[%"]/g, c => (c === '%' ? '%25' : '%22'))}`;

// PHOTO_SOURCE: dropbox (the default, for the workflow that predates the
// setting) or gdrive.
export function providerFor(name) {
  const key = String(name || '').trim().toLowerCase() || 'dropbox';
  if (!Object.hasOwn(PROVIDERS, key)) throw new Error(`PHOTO_SOURCE is "${name}" — it is dropbox or gdrive`);
  return PROVIDERS[key];
}

export async function run({
  env = {}, fetch, log = () => {}, worker = null,
  now = () => new Date(), uuid = () => crypto.randomUUID(), provider = dropbox,
} = {}) {
  const started = now();
  const settings = provider.settings(env);
  const maxFiles = Math.max(1, Number(env.MAX_FILES) || 150);
  const budgetMs = Math.max(10000, Number(env.TIME_BUDGET_S || 600) * 1000);
  const report = {
    source: provider.source, folder: settings.label, account: settings.account || null,
    last_run_at: started.toISOString(), last_error: null,
    seen: 0, imported: 0, unplaced: 0, skipped: 0, failed: 0,
    detail: { files: [], complete: false },
  };
  const files = report.detail.files;
  const note = (entry, result, reason, id) => {
    files.push({ name: entry.name, path: entry.path || null, result, reason: reason || null, id: id || null });
    if (files.length > KEEP_FILES) files.shift();
    log(`  ${result.padEnd(8)} ${entry.path || entry.name}${reason ? ` — ${reason}` : ''}`);
  };

  // Every file the run tried — not the ones it skipped as imported before — as
  // meganet.field_photo_upload (0036) has them: imported, unplaced, duplicate;
  // refused, the file's own doing (too big, not a photo MegaNet stores,
  // damaged, turned down by the database); failed, which trying again may
  // mend; skipped, a zip with no photos in it.
  const tried = [];
  let by = null;
  const record = (e, at, outcome, { reason = null, sha = null, bytes = null, id = null, station = null } = {}) => tried.push({
    attempted_at: at, origin: provider.source, batch_id: null,
    file_name: e.inZip || e.name || null, archive_name: e.archive || null,
    sha256: sha || null, byte_size: bytes ?? (Number.isFinite(e.size) && e.size > 0 ? e.size : null),
    outcome, reason: reason ? String(reason).slice(0, 500) : null,
    photo_id: id || null, station_id: station || null, uploaded_by: by,
  });

  const db = client(fetch, { url: env.SUPABASE_URL || DEFAULT_SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
  let prior = null;
  try {
    prior = (await db.select(`field_photo_sync?source=eq.${provider.source}&select=runs`)).at(0) || null;
    const saved = (await db.select(`field_photo_sync_cursor?source=eq.${provider.source}&select=cursor`)).at(0);

    const session = await provider.connect(settings, fetch, { now });
    report.account = session.account || null;
    if (session.label) report.folder = session.label;
    by = session.by;

    const listing = await provider.changes(session, saved && saved.cursor);
    if (listing.reset) {
      log(`  ${typeof listing.reset === 'string' ? listing.reset : `${provider.label} reset the cursor — listing the folder from the start`}`);
    }
    const listed = listing.entries
      .filter(e => PHOTO_EXT.test(e.name || '') || ZIP_EXT.test(e.name || ''))
      .sort((a, b) => String(a.modified || '').localeCompare(String(b.modified || '')));
    const photos = listed.filter(e => !ZIP_EXT.test(e.name));
    const zips = listed.length - photos.length;
    report.seen = photos.length;
    log(`${photos.length} new or changed photo${photos.length === 1 ? '' : 's'}${zips ? ` and ${zips} zip${zips === 1 ? '' : 's'}` : ''} in ${report.folder}${session.whose || ''}`);

    const known = await imported(photos);
    skipKnown(photos, known);

    let handled = 0;
    let complete = true;
    const spent = () => handled >= maxFiles || now() - started > budgetMs;
    for (const e of listed) {
      if (known.has(e.ref)) continue;
      if (spent()) { complete = false; break; }
      if (ZIP_EXT.test(e.name)) {
        if (!(await pack(e))) { complete = false; break; }
      } else {
        handled++;
        await take(e);
      }
    }
    report.detail.complete = complete;
    if (complete) {
      await db.upsert('field_photo_sync_cursor', { source: provider.source, cursor: listing.cursor });
    } else {
      log(`  stopped after ${handled} — the rest are listed again next run`);
    }
    report.last_ok_at = now().toISOString();

    // Imported before: one query a hundred files, not one a file — fewer when
    // their refs are long, as a zip's photos' are, since they go in a URL.
    async function imported(list) {
      const known = new Map();
      for (let i = 0; i < list.length;) {
        const refs = [];
        let chars = 0;
        while (i < list.length && refs.length < 100) {
          const q = `"${String(list[i].ref).replace(/["\\]/g, '')}"`;
          const n = encodeURIComponent(q).length + 3;
          if (refs.length && chars + n > LOOKUP_CHARS) break;
          refs.push(q);
          chars += n;
          i++;
        }
        const rows = await db.select(`field_photo?select=id,origin_ref,deleted_at&origin=eq.${provider.source}&origin_ref=in.(${encodeURIComponent(refs.join(','))})`);
        for (const r of rows) known.set(r.origin_ref, r);
      }
      return known;
    }

    function skipKnown(list, known) {
      const before = list.filter(e => known.has(e.ref));
      report.skipped += before.length;
      if (before.length <= 20) {
        for (const e of before) {
          const had = known.get(e.ref);
          note(e, 'skipped', had.deleted_at ? 'removed from MegaNet — not brought back' : 'already imported', had.id);
        }
      } else {
        const gone = before.filter(e => known.get(e.ref).deleted_at).length;
        log(`  ${before.length} imported before${gone ? ` (${gone} of them since removed from MegaNet)` : ''} — skipped`);
      }
    }

    // A zip pack: each photo in it taken as a file of its own. False when the
    // run ran out of photos or time inside it — the zip is listed again next
    // run, and what this one took from it is skipped then.
    async function pack(z) {
      const at = now().toISOString();
      const dealt = (result, outcome, reason) => {
        report.seen++;
        report[result]++;
        note(z, result, reason);
        record(z, at, outcome, { reason });
        return true;
      };
      if (z.size > ZIP_LIMITS.total) return dealt('skipped', 'refused', `${(z.size / 1024 ** 3).toFixed(1)} GB is over the 2 GB a zip may be`);
      let zip;
      try {
        zip = openZip(await provider.download(session, z), { wanted: photoInZip });
      } catch (err) {
        // Refused by rule (a password, ZIP64…) is skipped with its reason, as
        // a photo over 24 MB is; a damaged zip fails; either way the log says
        // refused — sending it again will not help. A download that broke off
        // is a failure that might not happen twice.
        const why = (err && err.message) || String(err);
        if (!(err instanceof ZipError)) return dealt('failed', 'failed', why);
        return err.refused ? dealt('skipped', 'refused', why) : dealt('failed', 'refused', why);
      }
      if (!zip.entries.length) return dealt('skipped', 'skipped', 'no photos in it');

      const inside = zip.entries.map(x => ({
        ref: inZip(z.ref, x.path), name: x.name, path: `${z.path || z.name} › ${x.path}`, size: x.size, modified: z.modified,
        meta: { ...z.meta, archive: { name: z.name, path: x.path } },
        archive: z.name, inZip: x.path, read: () => zip.read(x),
      }));
      report.seen += inside.length;
      log(`  ${z.path || z.name}: ${inside.length} photo${inside.length === 1 ? '' : 's'} in it${zip.others ? `, and ${zip.others} other file${zip.others === 1 ? '' : 's'} left alone` : ''}`);
      const known = await imported(inside);
      skipKnown(inside, known);
      for (const e of inside) {
        if (known.has(e.ref)) continue;
        if (spent()) return false;
        handled++;
        await take(e);
      }
      return true;
    }

    // One photo, a file in the folder or one in a zip: counted, noted, logged.
    // What went wrong is, for the log, `refused` when it is the file's own
    // doing (not a photo MegaNet stores, damaged, turned down by the
    // database) and `failed` when trying again may work (a download, an
    // upload); for the report, `skipped` when a rule of the zip's said no — as
    // the 24 MB does for a loose photo — and `failed` otherwise.
    async function take(e) {
      const at = now().toISOString();
      const got = {};
      try {
        const out = await one(e, got);
        report[out.result]++;
        if (out.unplaced) report.unplaced++;
        note(e, out.result, out.reason, out.id);
        record(e, at, out.outcome, { reason: out.reason, id: out.id, station: out.station, sha: got.sha, bytes: got.bytes });
      } catch (err) {
        const why = (err && err.message) || String(err);
        const result = err instanceof ZipError && err.refused ? 'skipped' : 'failed';
        report[result]++;
        note(e, result, why);
        record(e, at, err instanceof ZipError || (err && err.refused) ? 'refused' : 'failed', { reason: why, sha: got.sha, bytes: got.bytes });
        if (err && err.fatal) throw err;
      }
    }

    async function one(e, got) {
      if (e.size > MAX_BYTES) return { result: 'skipped', outcome: 'refused', reason: `${(e.size / 1048576).toFixed(1)} MB is over the 24 MB a photo may be` };

      const buf = e.read ? e.read() : await provider.download(session, e);
      got.bytes = buf.length;
      let r;
      try {
        r = await readPhoto(buf, { name: e.name, worker, home: HOME });
      } catch (err) {
        if (err && typeof err === 'object') err.refused = true;     // not a photo this stores, or a damaged one
        throw err;
      }
      got.sha = r.sha;
      const dup = await db.select(`field_photo?select=id&sha256=eq.${r.sha}&deleted_at=is.null&limit=1`);
      if (dup.length) return { result: 'skipped', outcome: 'duplicate', reason: 'the same photo is already in MegaNet', id: dup[0].id };

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
        origin: provider.source, origin_ref: e.ref, uploaded_by: by,
      });
      p.meta[provider.source] = e.meta;
      if (r.ocrError) p.meta.ocr_error = String(r.ocrError).slice(0, 300);

      let row;
      try {
        row = await db.rpc('add_field_photo', { p_photo: p });
      } catch (err) {
        await takeDown();
        // 23505 — this photo, or this file, is in MegaNet already. 23503 is a
        // word MegaNet does not have: an origin before the migration that adds
        // it. Every photo after this one would be refused the same way, so the
        // run stops here and says why.
        if (err && err.status === 409 && err.code !== '23503') return { result: 'skipped', outcome: 'duplicate', reason: 'already in MegaNet (the database said so)', id: err.details || null };
        if (err && err.code === '23503') err.fatal = err.refused = true;
        else if (err && err.status === 400) err.refused = true;
        throw err;
      }
      const placed = row && row.lat !== null && row.lat !== undefined;
      return {
        result: 'imported', outcome: placed ? 'imported' : 'unplaced', id: row && row.id, unplaced: !placed,
        station: (row && row.station_id) || null,
        reason: placed ? `${r.pos.placement === 'ocr' ? `read off the photo (${r.pos.confidence})` : 'the camera\'s GPS'}${row.station_id ? `, filed under ${row.station_id}` : ''}`
                       : 'nothing says where it was taken — it is in Unplaced',
      };
    }
  } catch (err) {
    report.last_error = String((err && err.message) || err).slice(0, 500);
    log(`FAILED — ${report.last_error}`);
  }

  // The upload log (meganet.log_field_photo_upload): until the migration that
  // adds it is in, PostgREST has no such function (404) — and whatever the
  // reason, a log that could not be written is a line here, not a failed run.
  if (tried.length) {
    try {
      const batch = crypto.randomUUID();      // one run, one batch — `uuid` names objects only
      for (let i = 0; i < tried.length; i += LOG_ROWS) {
        await db.rpc('log_field_photo_upload', { p_rows: tried.slice(i, i + LOG_ROWS).map(t => ({ ...t, batch_id: batch })) });
      }
    } catch (err) {
      log(err && err.status === 404
        ? '  (the upload log is not in this project yet — meganet.log_field_photo_upload — so it was not written)'
        : `  the upload log could not be written — ${(err && err.message) || err}`);
    }
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
