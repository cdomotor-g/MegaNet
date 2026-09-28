// Zip packs on the Field Photos tab: a .zip of photos, opened in the browser
// and its photos queued as if each had been dropped on its own (photo-zip.js,
// field-photos.js).
//
// Why this is a check of its own. `npm run photos` drops photos, never a zip,
// and everything a zip can do wrong is quiet: a photo unzipped with the wrong
// bytes still decodes (it is a JPEG with a grey band in it), a name decoded in
// the wrong code page is a photo with the wrong title, a zip that lies about
// its size is a tab that runs out of memory rather than one that says no, and
// a pack whose photos are all held at once works — on a laptop — until the day
// it is opened on a phone.
//
// Two halves.
//
//   1. photo-zip.js on its own, under Node — the file the browser runs,
//      require()d, against zips built byte by byte here: stored and deflated
//      entries, a folder, the __MACOSX junk macOS adds, dotfiles and
//      Thumbs.db, UTF-8 and CP437 names, a data descriptor, the Unix time
//      Info-ZIP adds, something in front of the zip, a comment after it, and
//      a ZIP64 record in front of a classic end record that does not need it.
//      Then every refusal, each with its sentence: a password, bzip2 and AES,
//      a saturated ZIP64 end record, a split zip, more files than a pack may
//      hold, more bytes, a photo over the limit, a bomb that unpacks past what
//      it declares (and stops there), a wrong checksum, a short entry, a local
//      header that is not where the directory says, and a zip cut in half.
//
//   2. The tab, in Chromium, against a fake project (lib/photo-project.mjs):
//      a zip dropped with loose photos — its photos read, placed and uploaded
//      exactly as the loose ones are, the same photo in the zip and beside it
//      refused as one, each zipped photo saying which zip it came from, the
//      pack's line saying what was left out and why, the bomb refused, the
//      zipped photos let go once read and unzipped again to upload (the bytes
//      that went up are the photo's own), and the outcomes logged with the
//      zip's name. Then a ZIP64 zip refused whole, a zip dropped on the drop
//      zone, and one chosen through the folder picker.
//
// Run:  npm run photozip
//       npm run photozip -- -v    also print what passed

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { storageStore, installStorage } from './lib/storage.mjs';
import { seedRows, attachmentsSql } from './lib/migration.mjs';
import { photoProject, installPhotoProject } from './lib/photo-project.mjs';
import { repo } from './lib/paths.mjs';
import { tiff, gpsEntries, jpegWith } from './lib/exif.mjs';

const require = createRequire(import.meta.url);
const PhotoZip = require(repo('photo-zip.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const READ_TIMEOUT = Number(process.env.PHOTOS_OCR_TIMEOUT || 300_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ═════════════════════════════════════════════════════════════════════════════
// A zip, byte by byte (PKWARE's APPNOTE, 4.3)
// ═════════════════════════════════════════════════════════════════════════════

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dos(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
           date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
// The Unix modification time Info-ZIP and macOS add (0x5455, flags: mtime).
function utExtra(seconds) {
  const b = Buffer.alloc(9);
  b.writeUInt16LE(0x5455, 0); b.writeUInt16LE(5, 2); b[4] = 1; b.writeUInt32LE(seconds, 5);
  return b;
}

// entries: [{ name | rawName, data, method (0|8|…), utf8, dir, encrypted, dd,
//             mtime, extra, usize, csize, crc, compressed, madeBy }]
// opts:    { prefix, comment, end: { disk, cdDisk, onDisk, count, cdSize, cdOffset }, zip64Record }
function zipOf(entries, opts = {}) {
  // Offsets are the zip's own, from its first local header: a self-extractor
  // is a program with a zip appended, offsets untouched — `prefix` is that.
  const parts = [], central = [];
  let offset = 0;
  if (opts.prefix) parts.push(opts.prefix);
  for (const e of entries) {
    const name = e.rawName || Buffer.from(e.name, 'utf8');
    const data = e.data || Buffer.alloc(0);
    const comp = e.compressed || (e.method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const usize = e.usize ?? data.length, csize = e.csize ?? comp.length;
    const flags = (e.utf8 ? 0x800 : 0) | (e.dd ? 0x8 : 0) | (e.encrypted ? 0x1 : 0);
    const { time, date } = e.mtime === null ? { time: 0, date: 0 } : dos(e.mtime || new Date(2026, 5, 24, 12, 26, 8));
    const extra = e.extra || Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method || 0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.dd ? 0 : crc, 14); local.writeUInt32LE(e.dd ? 0 : csize, 18); local.writeUInt32LE(e.dd ? 0 : usize, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (e.dd) {
      descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(csize, 8); descriptor.writeUInt32LE(usize, 12);
    }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(((e.madeBy ?? 3) << 8) | 20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8); head.writeUInt16LE(e.method || 0, 10); head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(csize, 20); head.writeUInt32LE(usize, 24);
    head.writeUInt16LE(name.length, 28); head.writeUInt16LE(extra.length, 30); head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34); head.writeUInt16LE(0, 36); head.writeUInt32LE(e.dir && e.madeBy === 0 ? 0x10 : 0, 38);
    head.writeUInt32LE(e.offset ?? offset, 42);
    central.push(Buffer.concat([head, name, extra]));
    const blob = Buffer.concat([local, name, extra, comp, descriptor]);
    parts.push(blob);
    offset += blob.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  parts.push(cd);
  if (opts.zip64Record) {
    // A ZIP64 end record and its locator, in front of a classic end record
    // whose numbers all fit — what some writers emit whatever the size.
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4);
    r.writeBigUInt64LE(BigInt(entries.length), 24); r.writeBigUInt64LE(BigInt(entries.length), 32);
    r.writeBigUInt64LE(BigInt(cd.length), 40); r.writeBigUInt64LE(BigInt(cdOffset), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(offset + cd.length), 8); l.writeUInt32LE(1, 16);
    parts.push(r, l);
  }
  const comment = Buffer.from(opts.comment || '', 'utf8');
  const end = Buffer.alloc(22);
  const o = opts.end || {};
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.disk ?? 0, 4); end.writeUInt16LE(o.cdDisk ?? 0, 6);
  end.writeUInt16LE(o.onDisk ?? o.count ?? entries.length, 8); end.writeUInt16LE(o.count ?? entries.length, 10);
  end.writeUInt32LE(o.cdSize ?? cd.length, 12); end.writeUInt32LE(o.cdOffset ?? cdOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  parts.push(end, comment);
  return Buffer.concat(parts);
}

const asFile = (buf, name, type = 'application/zip') => new File([buf], name, { type, lastModified: Date.UTC(2026, 5, 25) });
async function refusedWith(promise) {
  try { await promise; return null; } catch (err) { return (err && err.message) || String(err); }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. photo-zip.js, under Node
// ═════════════════════════════════════════════════════════════════════════════

async function nodeHalf() {
  section('Opening a zip — what is in it, and what is the zipper\'s');

  const jpg1 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40000), Buffer.from([0xff, 0xd9])]);
  const jpg2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30000, 7), Buffer.from([0xff, 0xd9])]);
  const jpg3 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo taken by a zipper streaming its output'), Buffer.from([0xff, 0xd9])]);
  const heic = Buffer.concat([Buffer.from('\0\0\0\x18ftypheic', 'latin1'), crypto.randomBytes(500)]);
  const cp437 = Buffer.from([0x43, 0x61, 0x66, 0x82, 0x2e, 0x6a, 0x70, 0x67]);        // Caf + 0x82 (é in CP437) + .jpg
  const entries = [
    { name: 'DCIM/', dir: true },
    { name: 'DCIM/IMG_0001.JPG', data: jpg1, method: 0 },
    { name: 'DCIM/Gatton — café/IMG_0002.jpeg', data: jpg2, method: 8, utf8: true },
    { rawName: cp437, data: jpg1.subarray(0, 1000), method: 8 },
    { name: 'streamed.jpg', data: jpg3, method: 8, dd: true },
    { name: 'IMG_0003.HEIC', data: heic, method: 8, extra: utExtra(Date.UTC(2026, 5, 24, 2, 26, 8) / 1000) },
    { name: '__MACOSX/DCIM/._IMG_0001.JPG', data: Buffer.from('resource fork') },
    { name: 'DCIM/.DS_Store', data: Buffer.from('folder settings') },
    { name: 'DCIM/Thumbs.db', data: Buffer.from('thumbnail cache') },
    { name: 'notes.txt', data: Buffer.from('the gauge boards are loose'), method: 8 },
    { name: 'older/visit.zip', data: Buffer.from('PK\x05\x06'), method: 0 },
  ];
  const buf = zipOf(entries);
  const z = await PhotoZip.open(asFile(buf, 'site-visit.zip'));
  ok('five photos in a zip of eleven entries: stored, deflated, UTF-8, CP437, a data descriptor, a HEIC',
    J(z.photos.map(p => p.name)) === J(['IMG_0001.JPG', 'IMG_0002.jpeg', 'Café.jpg', 'streamed.jpg', 'IMG_0003.HEIC']),
    J(z.photos.map(p => p.path)));
  ok('…each named by its own name, not its path, and typed by its extension',
    z.photos[1].path === 'DCIM/Gatton — café/IMG_0002.jpeg' && z.photos[0].type === 'image/jpeg' && z.photos[4].type === 'image/heic');
  ok('a folder is a folder; __MACOSX, .DS_Store and Thumbs.db are the zipper\'s, counted and not listed',
    z.folders === 1 && z.junk === 3, J({ folders: z.folders, junk: z.junk }));
  ok('what is not a photo is left out, saying why — and a zip inside the zip says to unzip it',
    J(z.leftOut) === J([{ name: 'notes.txt', why: 'not a photo' },
                        { name: 'older/visit.zip', why: 'a zip inside the zip — unzip it and drop that in on its own' }]), J(z.leftOut));
  ok('dated by the zip: DOS\'s local time, and Info-ZIP\'s Unix time where it is there',
    z.photos[0].mtime === new Date(2026, 5, 24, 12, 26, 8).getTime() && z.photos[4].mtime === Date.UTC(2026, 5, 24, 2, 26, 8),
    `${new Date(z.photos[0].mtime).toISOString()} ${new Date(z.photos[4].mtime).toISOString()}`);

  const want = [jpg1, jpg2, jpg1.subarray(0, 1000), jpg3, heic];
  const got = [];
  for (const p of z.photos) got.push(Buffer.from(await (await PhotoZip.file(asFile(buf, 'site-visit.zip'), p)).arrayBuffer()));
  ok('every photo unzips to its own bytes — stored, inflated, and behind a data descriptor',
    got.every((g, i) => g.equals(want[i])), got.map((g, i) => `${z.photos[i].name}:${g.equals(want[i])}`).join(' '));
  const f = await PhotoZip.file(asFile(buf, 'site-visit.zip'), z.photos[0]);
  ok('…as a File with the photo\'s name, type and date', f instanceof File && f.name === 'IMG_0001.JPG' && f.type === 'image/jpeg'
    && f.lastModified === z.photos[0].mtime && f.size === jpg1.length, J({ n: f.name, t: f.type, s: f.size }));

  const prefix = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(1232)]);
  const sfx = await PhotoZip.open(asFile(zipOf(entries, { prefix }), 'self-extracting.exe.zip'));
  const sfxBytes = Buffer.from(await PhotoZip.extract(asFile(zipOf(entries, { prefix }), 'x.zip'), sfx.photos[1]));
  ok('something in front of the zip (a self-extractor) shifts every offset, and is allowed for', sfx.photos.length === 5 && sfxBytes.equals(jpg2));
  const commented = await PhotoZip.open(asFile(zipOf(entries, { comment: 'Gatton, 24 June — '.repeat(60) }), 'c.zip'));
  ok('a comment after the end record is stepped over', commented.photos.length === 5);
  const z64r = await PhotoZip.open(asFile(zipOf(entries, { zip64Record: true }), 'z64r.zip'));
  const z64Bytes = Buffer.from(await PhotoZip.extract(asFile(zipOf(entries, { zip64Record: true }), 'z64r.zip'), z64r.photos[0]));
  ok('a ZIP64 record in front of an end record whose numbers fit is read past, not refused', z64r.photos.length === 5 && z64Bytes.equals(jpg1));
  ok('isZip: by name, by type, and not a photo', PhotoZip.isZip({ name: 'Pack.ZIP' }) && PhotoZip.isZip({ name: 'x', type: 'application/x-zip-compressed' })
    && !PhotoZip.isZip({ name: 'IMG_0001.JPG', type: 'image/jpeg' }));

  section('Refusing — a whole zip, one entry at a time, and each in a sentence');

  const one = extra => zipOf([{ name: 'IMG_0001.JPG', data: jpg1, method: 8 }, extra]);
  const left = async (buf2) => (await PhotoZip.open(asFile(buf2, 'r.zip'))).leftOut.map(l => l.why);
  let why = await left(one({ name: 'secret.jpg', data: jpg2, method: 0, encrypted: true }));
  ok('a password-protected photo is left out as encrypted', /^encrypted — a password-protected zip cannot be read here$/.test(why[0] || ''), J(why));
  why = await left(one({ name: 'IMG_0009.jpg', data: jpg2, method: 12, compressed: Buffer.from('BZh91AY&SY') }));
  ok('bzip2 is left out, by name, with what to do instead', /^compressed with bzip2, which a browser cannot unpack — zip it again with ordinary compression$/.test(why[0] || ''), J(why));
  why = await left(one({ name: 'IMG_0010.jpg', data: jpg2, method: 99, compressed: crypto.randomBytes(100) }));
  ok('WinZip\'s AES (method 99) is encryption, not a method', /^encrypted/.test(why[0] || ''), J(why));
  why = await left(one({ name: 'IMG_0011.jpg', data: Buffer.alloc(100), method: 8, usize: 30 * 1048576 }));
  ok('a photo over 24 MB is left out, before a byte of it is read', /^30\.0 MB, over the 24\.0 MB a photo may be$/.test(why[0] || ''), J(why));

  let err = await refusedWith(PhotoZip.open(asFile(zipOf([{ name: 'a.jpg', data: jpg1 }], { end: { count: 0xffff, onDisk: 0xffff } }), 'z64.zip')));
  ok('a ZIP64 archive is refused whole, saying why and what to do', /^it is a ZIP64 archive \(over 4 GB, or over 65,535 files\), which this tab does not open/.test(err || ''), err);
  err = await refusedWith(PhotoZip.open(asFile(zipOf([{ name: 'a.jpg', data: jpg1 }], { end: { disk: 1, cdDisk: 1 } }), 'split.z01')));
  ok('one part of a split zip is refused, and told to join the parts', /spanned or split zip \(\.z01, \.z02 …\) — join the parts/.test(err || ''), err);
  const many = zipOf(Array.from({ length: 2001 }, (_, i) => ({ name: `f${String(i).padStart(4, '0')}.txt`, data: Buffer.from([i & 255]) })));
  err = await refusedWith(PhotoZip.open(asFile(many, 'many.zip')));
  ok('2,001 files is more than a pack may hold — refused before its directory is read', /^it holds 2,001 files, and a pack may hold 2,000 — split it/.test(err || ''), err);
  err = await refusedWith(PhotoZip.open(asFile(zipOf([{ name: 'a.jpg', data: Buffer.alloc(600, 1) }, { name: 'b.jpg', data: Buffer.alloc(600, 2) }]), 'big.zip'),
    { limits: { total: 1000 } }));
  ok('photos that come to more than a pack may hold, by what the zip declares, are refused', /^its photos come to 1 kB unpacked, over the 1 kB one pack may hold/.test(err || ''), err);
  err = await refusedWith(PhotoZip.open(asFile(buf.subarray(0, buf.length >> 1), 'half.zip')));
  ok('a zip cut in half has no end record, and says it may be cut short', /^it is not a zip, or it is cut short/.test(err || ''), err);
  err = await refusedWith(PhotoZip.open(asFile(Buffer.from('not a zip at all'), 'fake.zip')));
  ok('…as does something that is not a zip at all', /cut short|too short/.test(err || ''), err);

  // The bomb: 4 MB of noughts, deflated to a few kilobytes, declared as three.
  const bombData = Buffer.alloc(4 * 1048576);
  const bomb = zipOf([{ name: 'bomb.jpg', data: bombData, method: 8, usize: 3000, crc: crc32(bombData.subarray(0, 3000)) }]);
  const bz = await PhotoZip.open(asFile(bomb, 'bomb.zip'));
  const t0 = Date.now();
  err = await refusedWith(PhotoZip.extract(asFile(bomb, 'bomb.zip'), bz.photos[0]));
  ok(`a bomb is unzipped only as far as it declares, and refused there (${Date.now() - t0} ms)`,
    /^it unpacks to more than the 3 kB the zip says it holds — the zip is damaged, or not what it claims$/.test(err || '') && bz.photos[0].usize === 3000, err);
  const badCrc = zipOf([{ name: 'a.jpg', data: jpg1, method: 0, crc: 0xdeadbeef }]);
  err = await refusedWith(PhotoZip.extract(asFile(badCrc, 'a.zip'), (await PhotoZip.open(asFile(badCrc, 'a.zip'))).photos[0]));
  ok('a wrong checksum is a damaged zip — refused, not a photo with a grey band in it', /^its checksum does not match — the zip is damaged$/.test(err || ''), err);
  const short = zipOf([{ name: 'a.jpg', data: jpg1, method: 8, usize: jpg1.length + 10 }]);
  err = await refusedWith(PhotoZip.extract(asFile(short, 's.zip'), (await PhotoZip.open(asFile(short, 's.zip'))).photos[0]));
  ok('an entry that unpacks to less than it declares is refused as cut short', /^it unpacks to less than the zip says it holds/.test(err || ''), err);
  const lost = zipOf([{ name: 'a.jpg', data: jpg1, method: 0, offset: 7 }]);
  err = await refusedWith(PhotoZip.extract(asFile(lost, 'l.zip'), (await PhotoZip.open(asFile(lost, 'l.zip'))).photos[0]));
  ok('a directory pointing at something that is not an entry is refused, saying so', /nothing is where the zip's directory says it is/.test(err || ''), err);
  ok('a DOS date of nought is no date, not 1980', PhotoZip.dosTime(0, 0) === null && PhotoZip.dosTime(0x5cd8, 0x6344) != null);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The tab, in Chromium
// ═════════════════════════════════════════════════════════════════════════════

const NE = fs.readFileSync(repo('test', 'fixtures', 'photos', 'solocator-gatton-ne.jpg'));
// Three phone photos with GPS and a time in their EXIF, so the OCR is never
// asked and the check is about the zip, not the reading: a few metres apart
// around the Gatton gauge.
const phone = (lat, lon, local) => jpegWith(NE, { tiff: tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
  exif: [[0x9003, 2, local], [0x9011, 2, '+10:00']],
  gps: gpsEntries({ lat, lon, alt: 96, heading: 118, accuracy: 4 }),
}) });
const P1 = phone(-27.55484, 152.27518, '2026:06:25 09:15:00');
const P2 = phone(-27.55490, 152.27530, '2026:06:25 09:16:00');
const P4 = phone(-27.55470, 152.27500, '2026:06:25 09:18:00');

async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const store = storageStore();
  const db = photoProject({ types: seedRows(attachmentsSql(), 'attachment_type') });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installPhotoProject(page, db, store);
    await installStorage(page, store);
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(t)) return;
      errors.push(t);
    });

    await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => { dbSetAccessToken('test-token'); switchTab('photos'); });
    await page.waitForFunction(() => !!document.getElementById('fp-files') && state.photos.types, null, { timeout: LOAD_TIMEOUT });

    const queue = () => page.evaluate(() => FieldPhotos._queue());
    const packs = () => page.evaluate(() => FieldPhotos.packs());
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
    const settled = () => page.waitForFunction(() => !state.photos.reading && !state.photos.uploading
      && state.photos.queue.every(i => !['waiting', 'reading', 'ocr', 'queued', 'uploading'].includes(i.status))
      && (state.photos.packs || []).every(p => p.status !== 'opening'), null, { timeout: READ_TIMEOUT });

    section('A zip dropped with loose photos');
    ok('the file picker offers zips as well as photos', /\.zip/.test(await page.getAttribute('#fp-files', 'accept') || '')
      && /Choose photos or zips/.test(await text('#fp-drop')), await page.getAttribute('#fp-files', 'accept'));

    const bombData = Buffer.alloc(4 * 1048576);
    const pack = zipOf([
      { name: 'DCIM/', dir: true },
      { name: 'DCIM/IMG_2001.JPG', data: P1, method: 8 },
      { name: 'DCIM/IMG_2002.JPG', data: P2, method: 0 },
      { name: '__MACOSX/DCIM/._IMG_2001.JPG', data: Buffer.from('fork') },
      { name: '.DS_Store', data: Buffer.from('settings') },
      { name: 'notes.txt', data: Buffer.from('gauge boards loose'), method: 8 },
      { name: 'secret.jpg', data: P4, method: 0, encrypted: true },
      { name: 'DCIM/IMG_2003.JPG', data: P4, method: 12, compressed: Buffer.from('BZh91AY&SY') },
      { name: 'bomb.jpg', data: bombData, method: 8, usize: 5000, crc: crc32(bombData.subarray(0, 5000)) },
    ]);
    await page.setInputFiles('#fp-files', [
      { name: 'site-visit.zip', mimeType: 'application/zip', buffer: pack },
      { name: 'IMG_2004.jpg', mimeType: 'image/jpeg', buffer: P4 },
      { name: 'copy of IMG_2002.JPG', mimeType: 'image/jpeg', buffer: P2 },
      { name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
    ]);
    const added = await page.evaluate(() => state.photos.msg && state.photos.msg.text);
    ok('the line says two photos added and a zip being opened, and the loose text file left out',
      /^2 photos added and 1 zip being opened — 1 file was not a photo and was left out\. Reading them…$/.test(added || ''), added);
    await settled();
    let q = await queue();
    const by = n => q.find(i => i.name === n);
    const z1 = by('IMG_2001.JPG'), z2 = by('IMG_2002.JPG'), l4 = by('IMG_2004.jpg'), copy = by('copy of IMG_2002.JPG'), bomb = by('bomb.jpg');
    ok('five in the list: the two loose photos first, then the zip\'s three photos',
      J(q.map(i => i.name)) === J(['IMG_2004.jpg', 'copy of IMG_2002.JPG', 'IMG_2001.JPG', 'IMG_2002.JPG', 'bomb.jpg']), J(q.map(i => i.name)));
    ok('each photo out of the zip says which zip, and the loose ones say nothing',
      [z1, z2, bomb].every(i => i && i.from === 'site-visit.zip' && i.pack) && [l4, copy].every(i => i && !i.from),
      J(q.map(i => [i.name, i.from])));
    ok('the deflated photo is read as the loose ones are: placed from its EXIF, filed under Gatton, its hash the photo\'s own',
      z1 && z1.status === 'ready' && z1.pos && z1.pos.placement === 'exif' && z1.station && z1.station.id === 'gatton'
        && z1.sha === sha256(P1) && z1.width === 1545 && z1.taken && z1.taken.local === '2026-06-25T09:15:00', J(z1));
    ok('the same photo in the zip and beside it is one photo — the second refused before it is read further',
      copy && copy.status === 'ready' && z2 && z2.status === 'refused' && /same photo is already in this list/.test(z2.note), J({ copy: copy && copy.status, z2 }));
    ok('the bomb is refused when its turn comes, in a sentence, and nothing else is held up by it',
      bomb && bomb.status === 'refused' && /it unpacks to more than the 5 kB the zip says it holds/.test(bomb.note), bomb && bomb.note);
    ok('once read, a zipped photo is let go — the list holds its hash and thumbnail, not its bytes',
      z1 && z1.held === false && z1.bytes === P1.length && z1.thumb && l4 && l4.held === true, J({ z1: z1 && { held: z1.held, bytes: z1.bytes }, l4: l4 && l4.held }));
    const pk = (await packs())[0];
    ok('the zip has one line: three photos found; what was left out and why; the zipper\'s files counted',
      pk && pk.status === 'open' && pk.photos === 3 && pk.junk === 2
        && /^3 photos found; 3 left out: notes\.txt \(not a photo\); secret\.jpg \(encrypted — a password-protected zip cannot be read here\); DCIM\/IMG_2003\.JPG \(compressed with bzip2, which a browser cannot unpack — zip it again with ordinary compression\); 2 system files skipped \(__MACOSX, \.DS_Store, Thumbs\.db\)\.$/.test(pk.note),
      pk && pk.note);
    ok('…drawn above the list', /site-visit\.zip/.test(await text('#fp-queue .fp-packs')) && (await page.$$eval('.fp-q-from', e => e.length)) === 3,
      await text('#fp-queue .fp-packs'));
    let audit = await auditHandlers(page);
    ok(`the queue with a pack: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));

    section('Uploading them');
    await page.click('#fp-upload');
    await settled();
    q = await queue();
    const adds = db.calls.filter(c => c.fn === 'add_field_photo');
    ok('three uploaded — the two loose photos and the zip\'s deflated one — and the two refused stay refused',
      q.filter(i => i.status === 'done').length === 3 && q.filter(i => i.status === 'refused').length === 2 && adds.length === 3,
      q.map(i => `${i.name}:${i.status}`).join(', '));
    const rec = adds.find(c => c.body.p_photo.title === 'IMG_2001.JPG');
    const obj = rec && store.uploads.find(u => u.path === rec.body.p_photo.storage_path);
    ok('the zipped photo, unzipped again to upload: the bytes that went up are the photo\'s own',
      obj && obj.data.equals(P1) && obj.contentType === 'image/jpeg', obj ? `${obj.bytes} bytes, equal: ${obj.data.equals(P1)}` : 'no object');
    ok('…and its record is a loose photo\'s: its hash, its size, its name as the title, placed from its EXIF',
      rec && rec.body.p_photo.sha256 === sha256(P1) && rec.body.p_photo.byte_size === P1.length && rec.body.p_photo.placement === 'exif'
        && rec.body.p_photo.content_type === 'image/jpeg' && /^photo\/[0-9a-f-]{36}\.jpg$/.test(rec.body.p_photo.storage_path), J(rec && rec.body.p_photo));
    await page.waitForFunction(() => true);
    const logs = db.calls.filter(c => c.fn === 'log_field_photo_upload');
    const rows = logs.flatMap(c => c.body.p_rows);
    const row = n => rows.find(r => r.file_name === n);
    ok('what became of each is logged once, in one batch, with the zip it came out of',
      logs.length === 1 && rows.length === 5 && new Set(rows.map(r => r.batch_id)).size === 1
        && row('IMG_2001.JPG').archive_name === 'site-visit.zip' && row('IMG_2001.JPG').outcome === 'imported'
        && row('IMG_2001.JPG').photo_id === db.photos.find(p => p.title === 'IMG_2001.JPG').id
        && row('IMG_2004.jpg').outcome === 'imported' && !('archive_name' in row('IMG_2004.jpg'))
        && row('IMG_2002.JPG').outcome === 'refused' && /same photo/.test(row('IMG_2002.JPG').reason)
        && row('bomb.jpg').outcome === 'refused' && row('bomb.jpg').archive_name === 'site-visit.zip',
      J(rows.map(r => [r.file_name, r.outcome, r.archive_name || null])));
    await page.click('button:has-text("Clear finished")');
    ok('"Clear finished" takes the pack\'s line with its photos', (await queue()).length === 0 && (await packs()).length === 0);

    section('A zip refused whole, one dropped on the drop zone, and one in a folder');
    const z64 = zipOf([{ name: 'a.jpg', data: P4 }], { end: { count: 0xffff, onDisk: 0xffff } });
    await page.setInputFiles('#fp-files', [{ name: 'huge.zip', mimeType: 'application/zip', buffer: z64 }]);
    await settled();
    const p64 = (await packs())[0];
    ok('a ZIP64 zip is refused whole, its line saying why, and nothing queued from it',
      p64 && p64.status === 'refused' && /^Not opened — it is a ZIP64 archive/.test(p64.note) && (await queue()).length === 0, p64 && p64.note);
    await page.click('button:has-text("Clear finished")').catch(() => {});
    await page.evaluate(() => FieldPhotos.clearFinished());

    const dropped = zipOf([{ name: 'IMG_3001.JPG', data: phone(-27.5549, 152.2752, '2026:06:26 10:00:00'), method: 8 }]);
    await page.evaluate(async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.zip', { type: 'application/zip' }));
      const zone = document.getElementById('fp-drop');
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, dropped.toString('base64'));
    await settled();
    q = await queue();
    ok('a zip dropped on the drop zone is opened the same way', q.length === 1 && q[0].name === 'IMG_3001.JPG' && q[0].from === 'dropped.zip'
      && q[0].status === 'ready', J(q));
    await page.evaluate(() => { state.photos.queue = []; state.photos.packs = []; });

    // A folder, as the folder picker is given one: a zip in a sub-folder of
    // it, beside a loose photo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photozip-'));
    try {
      fs.mkdirSync(path.join(dir, 'run 3'));
      fs.writeFileSync(path.join(dir, 'run 3', 'in-a-folder.zip'),
        zipOf([{ name: 'IMG_3002.JPG', data: phone(-27.5548, 152.2753, '2026:06:26 10:05:00'), method: 0 }]));
      fs.writeFileSync(path.join(dir, 'IMG_3003.jpg'), phone(-27.5547, 152.2754, '2026:06:26 10:06:00'));
      await page.setInputFiles('#fp-folder', dir);
      await settled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    q = await queue();
    ok('…and so is one found in a folder chosen through the folder picker, beside a loose photo',
      q.length === 2 && q.some(i => i.name === 'IMG_3002.JPG' && i.from === 'in-a-folder.zip' && i.status === 'ready')
        && q.some(i => i.name === 'IMG_3003.jpg' && !i.from && i.status === 'ready'), J(q.map(i => [i.name, i.from, i.status])));

    ok('nothing threw and the console stayed clean', errors.length === 0, errors.slice(0, 4).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  await nodeHalf();
  await browserHalf();
} catch (err) {
  failures++;
  console.log(`\nThe zip pack check could not finish:\n${err.stack || err}`);
}
console.log(`\n  ${passes + failures} assertion(s).`);
if (failures) {
  console.log(`\nFAIL — ${failures} of ${passes + failures}.`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — a zip of photos opens in the browser, and its photos go in as photos.');
}
