#!/usr/bin/env node
// tools/field-photos/fetch-for-reader.mjs — the field photos the photo reader
// has still to read, out of the photo store and into a folder, for the
// workflow to encrypt and hand over (.github/workflows/photo-reader-fetch.yml).
//
//   SUPABASE_SECRET_KEY=… node fetch-for-reader.mjs                 the next 200 unread, 1600 px
//   SUPABASE_SECRET_KEY=… SELECT=ids IDS=<uuid>,<uuid> SIZE=full …  those, as they were taken
//
// The photo reader is an agent — a Claude Code session, every night — and
// holds no key to the photos. The workflow holds the secret key, fetches
// what it is asked for with this, and encrypts the folder to a public key the
// session made for the one run, so what leaves the workflow is a file only that
// session can open (docs/photo-reader.md says why it is done this way).
//
// Which photos: SELECT=unread asks the database for the live photos this
// reader has not read at this version (meganet.photos_to_read(), 0090), oldest
// first, at most LIMIT; SELECT=ids takes the ids given, live ones only. The
// bytes come from the photo store (worker/photos.js), signed for the secret
// key, or from Supabase Storage for a photo the move has not carried over yet.
//
// SIZE: `full` keeps the file as it was taken; a number is the longest side in
// pixels (ImageMagick, turned upright by its EXIF, metadata stripped); `thumb`
// is the app's own thumbnail. What it writes, under OUT (default ./reader-out):
//
//   manifest.json   [{ photo_id, station_id, station_name, station_number,
//                      taken_at, title, caption, file, width, height, bytes }]
//   photos/<photo id>.<ext>
//
// It prints counts and nothing that names a site or a file: the workflow's log
// is as public as the repository.
//
//   READER, READER_VERSION   who is reading, and at which version (agent:photo-reader, 1)
//   PHOTO_STORE_URL, SUPABASE_URL   default floodwarning.net's store and MegaNet's project

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { client, DEFAULT_PHOTO_STORE } from './lib/supabase.mjs';

const run = promisify(execFile);
const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
              'image/gif': 'gif', 'image/tiff': 'tif', 'image/avif': 'avif' };

// What was asked for, checked: the workflow passes its inputs through as they
// were typed, so nothing here is trusted to be the shape it should be.
export function options(env = {}) {
  const select = (env.SELECT || 'unread').trim();
  if (!['unread', 'ids'].includes(select)) throw new Error(`SELECT is unread or ids, not ${select}`);
  const ids = select === 'ids' ? String(env.IDS || '').split(/[\s,]+/).filter(Boolean) : [];
  if (select === 'ids' && (!ids.length || ids.some(i => !UUID.test(i)))) throw new Error('IDS is a list of photo ids (uuids), comma-separated');
  if (ids.length > 1000) throw new Error('at most 1,000 photos in one fetch');
  const size = String(env.SIZE || '1600').trim().toLowerCase();
  if (!['full', 'thumb'].includes(size) && !(/^\d{3,4}$/.test(size) && +size >= 320 && +size <= 4000)) {
    throw new Error(`SIZE is full, thumb, or a longest side from 320 to 4000 pixels, not ${size}`);
  }
  const limit = Math.min(1000, Math.max(1, Number(env.LIMIT) || 200));
  const reader = (env.READER || 'agent:photo-reader').trim();
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(reader)) throw new Error(`READER is agent:<name>, not ${reader}`);
  const version = Math.max(1, Number(env.READER_VERSION) || 1);
  return { select, ids, size, limit, reader, version, out: env.OUT || 'reader-out' };
}

const COLS = 'id,station_id,storage_path,thumb_path,content_type,byte_size,width,height,taken_at,title,caption,created_at';

async function chosen(db, o) {
  if (o.select === 'unread') {
    const rows = await db.rpc('photos_to_read', { p_reader: o.reader, p_version: o.version, p_limit: o.limit });
    // The thumbnails' paths are not in that list; one more read for them when asked.
    if (o.size !== 'thumb' || !rows.length) return rows || [];
    const thumbs = await byIds(db, rows.map(r => r.id));
    const t = new Map(thumbs.map(r => [r.id, r.thumb_path]));
    return rows.map(r => ({ ...r, thumb_path: t.get(r.id) || null }));
  }
  const rows = await byIds(db, o.ids);
  const names = await stationsOf(db, rows);
  return rows.map(r => ({ ...r, station_name: names.get(r.station_id)?.name || null,
                          station_number: names.get(r.station_id)?.station_number || null }));
}

async function byIds(db, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    out.push(...await db.select(`field_photo?select=${COLS}&deleted_at=is.null&id=in.(${part.join(',')})`));
  }
  const at = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => at.get(a.id) - at.get(b.id));
}

async function stationsOf(db, rows) {
  const ids = [...new Set(rows.map(r => r.station_id).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100).map(s => `"${s.replace(/"/g, '')}"`).join(',');
    for (const s of await db.select(`station?select=id,name,station_number&id=in.(${part})`)) out.set(s.id, s);
  }
  return out;
}

async function bytesOf(db, fetchImpl, p, url) {
  if (url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`the photo store answered HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return (await db.downloadStorage(p)).bytes;
}

// Smaller, upright, and without its metadata — or as it was, when no
// ImageMagick is to hand (said once, and the run goes on).
async function shrink(file, size, log, state) {
  if (state.noMagick) return file;
  const out = file.replace(/\.[a-z0-9]+$/i, '') + '.r.jpg';
  try {
    await run(state.magick, [file, '-auto-orient', '-resize', `${size}x${size}>`, '-strip', '-quality', '85', out]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Said once, however many photos were being shrunk when it was found.
      if (!state.noMagick) log('::warning::No ImageMagick — the photos are sent at full size.');
      state.noMagick = true;
      return file;
    }
    throw err;
  }
  fs.rmSync(file);
  const final = out.replace(/\.r\.jpg$/, '.jpg');
  fs.renameSync(out, final);
  return final;
}

export async function fetchForReader({ env = {}, fetch = globalThis.fetch, log = () => {}, magick = 'convert' } = {}) {
  const o = options(env);
  const store = (env.PHOTO_STORE_URL || '').trim() || DEFAULT_PHOTO_STORE;
  const db = client(fetch, { url: env.SUPABASE_URL || DEFAULT_SUPABASE_URL, key: env.SUPABASE_SECRET_KEY, store });
  const rows = await chosen(db, o);
  const dir = path.join(o.out, 'photos');
  fs.mkdirSync(dir, { recursive: true });

  const pathOf = r => (o.size === 'thumb' ? (r.thumb_path || r.storage_path) : r.storage_path);
  const signed = { urls: {}, missing: [] };
  for (let i = 0; i < rows.length; i += 400) {
    const part = rows.slice(i, i + 400).map(pathOf);
    const s = await db.signStore(part, 3600);
    Object.assign(signed.urls, s.urls);
    signed.missing.push(...s.missing);
  }

  const manifest = [], state = { noMagick: false, magick };
  let failed = 0, bytes = 0;
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const r = rows[next++];
      const p = pathOf(r);
      try {
        const buf = await bytesOf(db, fetch, p, signed.urls[p]);
        const ext = o.size === 'thumb' ? 'jpg' : (EXT[r.content_type] || path.extname(p).slice(1) || 'jpg');
        let file = path.join(dir, `${r.id}.${ext}`);
        fs.writeFileSync(file, buf);
        if (/^\d+$/.test(o.size)) file = await shrink(file, Number(o.size), log, state);
        const size = fs.statSync(file).size;
        bytes += size;
        manifest.push({
          photo_id: r.id, station_id: r.station_id || null, station_name: r.station_name || null,
          station_number: r.station_number || null, taken_at: r.taken_at || null, title: r.title || '',
          caption: r.caption || '', file: path.relative(o.out, file), width: r.width || null, height: r.height || null,
          bytes: size,
        });
      } catch (err) {
        failed += 1;
        log(`  a photo could not be fetched — ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  const at = new Map(rows.map((r, i) => [r.id, i]));
  manifest.sort((a, b) => at.get(a.photo_id) - at.get(b.photo_id));
  fs.writeFileSync(path.join(o.out, 'manifest.json'), JSON.stringify({
    reader: o.reader, reader_version: o.version, select: o.select, size: o.size, fetched_at: new Date().toISOString(), photos: manifest,
  }, null, 1));
  return { asked: rows.length, fetched: manifest.length, failed, bytes, fromSupabase: signed.missing.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const magick = process.env.MAGICK || 'convert';
    const r = await fetchForReader({ env: process.env, log: s => console.log(s), magick });
    console.log(`Fetched ${r.fetched} of ${r.asked} photo${r.asked === 1 ? '' : 's'} (${(r.bytes / 1048576).toFixed(1)} MB; `
      + `${r.fromSupabase} still in Supabase Storage); ${r.failed} failed.`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `fetched=${r.fetched}\n`);
    if (r.failed && !r.fetched) process.exitCode = 1;
  } catch (err) {
    console.error(`FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}
