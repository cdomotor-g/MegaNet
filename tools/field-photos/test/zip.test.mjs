// lib/zip.mjs against a zip a real tool wrote — test/fixtures/pack.zip, made by
// Info-ZIP's zip 3.0 (`zip -r pack.zip DCIM/ -x DCIM/IMG_1002.jpg`, then
// `zip -0 pack.zip DCIM/IMG_1002.jpg`, then `zip -r pack.zip __MACOSX readme.txt`):
//
//   DCIM/                         a folder entry
//   DCIM/IMG_1001.jpg             1,390 bytes, deflated — a 48×36 phone photo
//                                 with GPS and a time in its EXIF
//   DCIM/IMG_1002.jpg             1,616 bytes, stored — another
//   __MACOSX/DCIM/._IMG_1001.jpg  the resource fork macOS zips beside a file:
//                                 a .jpg by name, not a photo
//   readme.txt
//
// — and then the same bytes with one field changed at a time, for each thing
// the reader must refuse rather than guess at: a password, ZIP64, a zip split
// across files, a zip bomb, a photo that does not match its checksum.
//
//   cd tools/field-photos && npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip, ZipError } from '../lib/zip.mjs';
import { PhotoMeta } from '../lib/read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = fs.readFileSync(path.join(HERE, 'fixtures', 'pack.zip'));
const SHA = {
  'DCIM/IMG_1001.jpg': 'b2f4648fdf6f6adf0522492a5bd41d360fbc92f86c63eafa2ab481341a9538c6',
  'DCIM/IMG_1002.jpg': '1930c6b3cdb47151e644d32c8ff97cc16ca402ddca583908293335c7b597c30d',
};
const photos = e => /\.(jpe?g|png|heic|heif|webp)$/i.test(e.name) && !e.name.startsWith('._') && !/(^|\/)__MACOSX\//.test(e.path);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// Where an entry's central directory record starts, and where the
// end-of-central-directory record does (the fixture has no comment).
const EOCD = PACK.length - 22;
function cd(buf, name) {
  let p = buf.readUInt32LE(EOCD + 16);
  for (let n = buf.readUInt16LE(EOCD + 10); n > 0; n--) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const len = buf.readUInt16LE(p + 28);
    if (buf.toString('latin1', p + 46, p + 46 + len) === name) return p;
    p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`no ${name} in the fixture`);
}
// The fixture with some bytes changed.
function patched(edit) { const b = Buffer.from(PACK); edit(b); return b; }
const refusal = (fn, re) => assert.throws(fn, err => err instanceof ZipError && err.refused === true && re.test(err.message));
const damage = (fn, re) => assert.throws(fn, err => err instanceof ZipError && err.refused === false && re.test(err.message));

test('what Info-ZIP wrote reads back byte for byte — the deflated photo and the stored one — and the rest is left out', () => {
  const z = openZip(PACK, { wanted: photos });
  assert.deepEqual(z.entries.map(e => [e.path, e.name, e.method, e.size]),
    [['DCIM/IMG_1001.jpg', 'IMG_1001.jpg', 8, 1390], ['DCIM/IMG_1002.jpg', 'IMG_1002.jpg', 0, 1616]]);
  assert.equal(z.others, 2, 'the macOS fork and the readme; the folders are not files at all');
  for (const e of z.entries) {
    const bytes = z.read(e);
    assert.equal(sha256(bytes), SHA[e.path], e.path);
    const meta = PhotoMeta.read(bytes);
    assert.equal(meta.format, 'jpeg');
    assert.ok(meta.gps && meta.taken, `${e.path} carries its GPS and time`);
  }
  const all = openZip(PACK);
  assert.deepEqual(all.entries.map(e => e.path), ['DCIM/IMG_1001.jpg', 'DCIM/IMG_1002.jpg', '__MACOSX/DCIM/._IMG_1001.jpg', 'readme.txt']);
  assert.equal(all.read(all.entries[3]).toString(), 'Gatton, 23 June 2026 - two photos from the gauge.\n');
});

test('a password-protected zip is refused with a reason, not guessed at', () => {
  const locked = patched(b => { const at = cd(b, 'DCIM/IMG_1001.jpg'); b.writeUInt16LE(b.readUInt16LE(at + 8) | 1, at + 8); });
  refusal(() => openZip(locked, { wanted: photos }), /password-protected/);
  // A locked readme in a pack of open photos is nobody's business.
  const readme = patched(b => { const at = cd(b, 'readme.txt'); b.writeUInt16LE(b.readUInt16LE(at + 8) | 1, at + 8); });
  assert.equal(openZip(readme, { wanted: photos }).entries.length, 2);
});

test('ZIP64, and a zip split across several files, are refused with a reason', () => {
  refusal(() => openZip(patched(b => b.writeUInt16LE(0xffff, EOCD + 10))), /ZIP64/);
  refusal(() => openZip(patched(b => b.writeUInt32LE(0xffffffff, EOCD + 16))), /ZIP64/);
  refusal(() => openZip(patched(b => b.writeUInt32LE(0xffffffff, cd(b, 'DCIM/IMG_1002.jpg') + 24))), /ZIP64/);
  refusal(() => openZip(patched(b => { b.writeUInt16LE(2, EOCD + 4); b.writeUInt16LE(2, EOCD + 6); })), /split across several files/);
  refusal(() => openZip(patched(b => b.writeUInt16LE(1, cd(b, 'readme.txt') + 34))), /split across several files/);
});

test('a zip bomb gets nowhere: too many entries, too many bytes of photos, a photo that inflates past what it says', () => {
  refusal(() => openZip(PACK, { limits: { entries: 6 } }), /holds 7 files, over the 6 a zip may/);
  refusal(() => openZip(PACK, { wanted: photos, limits: { total: 3000 } }), /its photos come to .* GB, over the .* GB a zip may hold/);
  // The deflated photo, declaring fewer bytes than it inflates to: zlib stops
  // at what it declared, and the photo is damaged, not read.
  const liar = openZip(patched(b => b.writeUInt32LE(1000, cd(b, 'DCIM/IMG_1001.jpg') + 24)), { wanted: photos });
  damage(() => liar.read(liar.entries[0]), /does not inflate to the 1,000 bytes it says/);
  // A photo over the 24 MB is never inflated, and does not count towards the total.
  const huge = openZip(patched(b => b.writeUInt32LE(30 * 1024 * 1024, cd(b, 'DCIM/IMG_1001.jpg') + 24)), { wanted: photos, limits: { total: 2000 } });
  refusal(() => huge.read(huge.entries[0]), /over the 24 MB a photo may be/);
});

test('a damaged photo fails on its checksum; a method it does not read is refused for that photo alone', () => {
  const crc = openZip(patched(b => { const at = cd(b, 'DCIM/IMG_1002.jpg'); b.writeUInt32LE(b.readUInt32LE(at + 16) ^ 1, at + 16); }), { wanted: photos });
  damage(() => crc.read(crc.entries[1]), /IMG_1002\.jpg does not match its checksum/);
  assert.equal(sha256(crc.read(crc.entries[0])), SHA['DCIM/IMG_1001.jpg'], 'the other photo is fine');
  const bzip2 = openZip(patched(b => b.writeUInt16LE(12, cd(b, 'DCIM/IMG_1001.jpg') + 10)), { wanted: photos });
  refusal(() => bzip2.read(bzip2.entries[0]), /method 12; stored and deflate are/);
  assert.equal(sha256(bzip2.read(bzip2.entries[1])), SHA['DCIM/IMG_1002.jpg']);
});

test('names: UTF-8 when flagged or when the bytes are UTF-8, code page 437 otherwise', () => {
  const rename = (bytes, flag) => patched(b => {
    const at = cd(b, 'DCIM/IMG_1001.jpg');
    bytes.forEach((v, i) => { b[at + 46 + 5 + i] = v; });                 // over "IM" of IMG_1001.jpg
    if (flag) b.writeUInt16LE(b.readUInt16LE(at + 8) | 0x800, at + 8);
  });
  const name = buf => openZip(buf).entries[0].path;
  assert.equal(name(rename([0xc3, 0xbc], true)), 'DCIM/üG_1001.jpg', 'flagged UTF-8');
  assert.equal(name(rename([0xc3, 0xbc], false)), 'DCIM/üG_1001.jpg', 'UTF-8 without the flag, as macOS writes it');
  assert.equal(name(rename([0x81, 0x84], false)), 'DCIM/üäG_1001.jpg', 'code page 437');
});

test('what is not a zip says so, and is damage rather than a refusal', () => {
  damage(() => openZip(Buffer.from('not a zip at all, just some text in a file')), /no end-of-central-directory record/);
  damage(() => openZip(Buffer.alloc(10)), /too short/);
  damage(() => openZip(PACK.subarray(0, PACK.length - 200)), /no end-of-central-directory record/);
});
