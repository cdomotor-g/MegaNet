// tools/field-photos/lib/zip.mjs — the photos in a zip pack, for the sync.
//
// A .zip saved into a linked folder is a pack of photos: the sync opens it here
// and hands each photo in it on as a file of its own (lib/run.mjs says how they
// are named and how a second look at the same zip skips them). Node has the
// inflate (zlib); the zip container is a directory at the end of the file — the
// end-of-central-directory record, the central directory it points at, and a
// local header in front of each entry's bytes — and that is read here, with no
// dependency, the way test/lib/xlsx.mjs reads a workbook.
//
// Stored and deflate only, which is what every zip tool writes unless asked
// otherwise. The rest is refused with a reason rather than guessed at:
//
//   · a password (encrypted entries), which the sync does not have;
//   · ZIP64, the extension for an archive over 4 GB or 65,535 entries — past
//     anything the sync takes anyway. One that carries the ZIP64 records
//     without needing them (every ordinary field still holds its value) is
//     read by its ordinary fields;
//   · a zip split across several files (pack.z01, pack.z02 … pack.zip), whose
//     bytes are not all in this one;
//   · another compression method (bzip2, LZMA, zstd …), photo by photo.
//
// And a zip is never believed about its own size, because a few kilobytes can
// inflate to gigabytes. So: at most 2,000 entries; at most 2 GB of photos all
// told, by what the directory declares; no photo inflated one byte past what
// its directory entry declares (zlib's maxOutputLength), and none over 24 MB,
// which is also what MegaNet takes; and every photo's CRC-32 checked, so a
// damaged pack fails the photo rather than filing a broken one.

import zlib from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({
  entries: 2000,                 // entries in the directory, photos or not
  total: 2 * 1024 ** 3,          // bytes of photos, inflated, all told
  entry: 24 * 1024 * 1024,       // bytes of one photo, inflated
  name: 1024,                    // bytes of one entry's name
});

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

export class ZipError extends Error {
  // `refused`: a zip this does not open, by rule — as against a broken one.
  constructor(message, { refused = false } = {}) { super(message); this.refused = refused; }
}

const damaged = what => new ZipError(`the zip is damaged — ${what}`);
const zip64 = () => new ZipError('it is a ZIP64 archive (over 4 GB, or over 65,535 files), which is not opened — zip the photos in smaller packs', { refused: true });
const split = () => new ZipError('it is one part of a zip split across several files, which is not opened — zip the photos as one file', { refused: true });
const gb = n => (n / 1024 ** 3).toFixed(1).replace(/\.0$/, '');

// CRC-32: zlib's own where Node has it (22.2 on), a table where it does not.
let TABLE = null;
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A name is UTF-8 where the entry says so (flag bit 11), or where its bytes are
// UTF-8 anyway (macOS writes it without saying); otherwise IBM code page 437,
// which is what the format means by a name that says nothing, and what older
// Windows wrote.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
            + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decodeName(raw, flags) {
  if (flags & 0x800) return raw.toString('utf8');
  try { return UTF8.decode(raw); } catch (_) { /* not UTF-8 — code page 437 */ }
  let s = '';
  for (const b of raw) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return s;
}

// The end-of-central-directory record: 22 bytes and a comment of up to 64 KB,
// the last thing in the file — so it is found by scanning back for its
// signature, preferring the one whose comment ends exactly at the end.
function findEocd(buf) {
  if (buf.length < 22) throw new ZipError('not a zip file — too short to be one');
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let loose = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    if (i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
    if (loose < 0) loose = i;
  }
  if (loose >= 0) return loose;
  throw new ZipError('not a zip file, or not the whole of one — it has no end-of-central-directory record');
}

// The zip's photos. `wanted(entry)` picks the entries to hand on — the sync's
// photos — and only those count towards the 2 GB, or refuse the zip for a
// password. Returns { entries, others, read }: the wanted entries, each
// { path, name, size, … }; how many files were left out; and read(entry),
// which returns one entry's bytes, checked, or throws a ZipError.
export function openZip(buf, { wanted = () => true, limits = {} } = {}) {
  const L = { ...ZIP_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8), total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdAt = buf.readUInt32LE(eocd + 16);
  if ([disk, cdDisk, onDisk, total].includes(0xffff) || cdSize === 0xffffffff || cdAt === 0xffffffff) throw zip64();
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw split();
  if (total > L.entries) {
    throw new ZipError(`it holds ${total.toLocaleString('en-AU')} files, over the ${L.entries.toLocaleString('en-AU')} a zip may`, { refused: true });
  }
  if (cdAt + cdSize > eocd) throw damaged('its directory is not where it says');

  const entries = [];
  const paths = new Set();
  let others = 0, declared = 0;
  for (let n = 0, p = cdAt; n < total; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN) throw damaged(`its directory breaks off at entry ${n + 1} of ${total}`);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34), offset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) throw damaged(`its directory breaks off at entry ${n + 1} of ${total}`);
    if (csize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || diskStart === 0xffff) throw zip64();
    if (diskStart !== 0) throw split();
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    p = next;

    // Where it sits in the zip: forward slashes (Windows' own zipper has been
    // known to write backslashes), no leading one. A folder is not a file.
    const named = decodeName(raw, flags);
    if (/[\\/]$/.test(named)) continue;
    const path = named.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.?\/)+/, '');
    if (!path) continue;
    const e = { path, name: path.slice(path.lastIndexOf('/') + 1), size, csize, crc, method, flags, offset,
                encrypted: !!(flags & 1) || method === 99 };
    // A name over a kilobyte is nobody's photo, and would not fit in a query.
    if (nameLen > L.name || paths.has(path) || !wanted(e)) { others++; continue; }
    paths.add(path);
    entries.push(e);
    if (size <= L.entry) declared += size;
  }
  if (entries.some(e => e.encrypted)) {
    throw new ZipError('it is password-protected, and the sync has no password — zip the photos again without one', { refused: true });
  }
  if (declared > L.total) {
    throw new ZipError(`its photos come to ${gb(declared)} GB, over the ${gb(L.total)} GB a zip may hold — split it into smaller packs`, { refused: true });
  }

  function read(e) {
    if (e.encrypted) throw new ZipError(`${e.path} is password-protected`, { refused: true });
    if (e.method !== 0 && e.method !== 8) {
      throw new ZipError(`${e.path} is compressed a way this does not read (method ${e.method}; stored and deflate are) — zip it again with the usual settings`, { refused: true });
    }
    if (e.size > L.entry) throw new ZipError(`${e.path} is over the ${Math.round(L.entry / 1048576)} MB a photo may be`, { refused: true });
    const h = e.offset;
    if (h + 30 > cdAt || buf.readUInt32LE(h) !== LOC) throw damaged(`${e.path} is not where its directory says`);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    if (start + e.csize > cdAt) throw damaged(`${e.path} runs on past the end of the data`);
    const data = buf.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) {
      if (e.csize !== e.size) throw damaged(`${e.path} is stored, but its two sizes differ`);
      out = Buffer.from(data);
    } else {
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
      } catch (_) {
        throw damaged(`${e.path} does not inflate to the ${e.size.toLocaleString('en-AU')} bytes it says it holds`);
      }
    }
    if (out.length !== e.size) throw damaged(`${e.path} inflates to ${out.length.toLocaleString('en-AU')} bytes, not the ${e.size.toLocaleString('en-AU')} it says`);
    if (crc32(out) !== e.crc) throw damaged(`${e.path} does not match its checksum`);
    return out;
  }

  return { entries, others, read };
}
