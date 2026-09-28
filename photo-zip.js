// MegaNet — photo-zip.js
//
//   PhotoZip   a zip of photos, opened in the browser: which of the files in it
//              are photos, each one's name and date, and — one at a time, when
//              it is its turn — its bytes, checked against the zip's own
//              checksum before anything else sees them.
//
// After core.js, before field-photos.js, which is its one caller — index.html
// holds the order and the reasons. Pure: a Blob in, entries and bytes out; no
// page, no `state`, no network. The IIFE body only declares, so its position
// among the modules is free (`npm run toplevel`), and it is require()d under
// Node by test/photozip.mjs through the `module.exports` at the foot — Node 22
// has Blob, File and DecompressionStream, which are all this file needs.
//
// ── Why a zip at all ─────────────────────────────────────────────────────────
//
// A crew back from a run of sites has a phone full of photos and a laptop, and
// the laptop's easiest way to send "these forty" is to zip them — or they
// arrive zipped, off an email or a shared drive. Unzipping first is one more
// step on a Windows PC and none on a phone, where there is nowhere to unzip
// to. So a .zip dropped on the Field Photos tab is opened, and every photo in
// it goes into the queue exactly as if it had been dropped on its own: the
// same hash, the same reading, the same placing, the same upload. Only the
// queue knows it came out of a zip, and says so.
//
// ── Why this and not a library ───────────────────────────────────────────────
//
// Reading a zip is the End of Central Directory record, the central directory
// it points at, and each entry's local header — a few hundred lines — and the
// one hard part, inflating, the browser already does: DecompressionStream
// ('deflate-raw'), native, streaming, in every browser this app supports. A
// library would be a second copy of an inflater the platform has, pinned and
// fetched from somewhere, for the two methods (stored and deflate) that every
// zip a phone, Windows, macOS or 7-Zip makes by default uses.
//
// ── What it will not open, and says so ───────────────────────────────────────
//
// A sentence, never a silent skip. The whole archive is refused when it is
// ZIP64 (over 4 GB or 65,535 files: the classic records are saturated and the
// real numbers are somewhere this reader does not look), spanned or split
// (.z01, .z02 …: the directory is on another disk), or bigger than a pack may
// be (below). One entry is left out, and the pack's line in the queue says
// why, when it is encrypted (a password is not something this tab asks for),
// compressed with anything but stored or deflate (Deflate64, bzip2, LZMA, zstd
// — none of which a browser can unpack), a zip inside the zip, over the size a
// photo may be, or not a photo at all. Folders, `__MACOSX/` (the resource
// forks macOS's Compress writes beside every file), dotfiles (`.DS_Store`,
// `._IMG_0042.JPG`) and Windows' `Thumbs.db` are the zipper's, not the crew's,
// and are counted as such rather than listed one by one.
//
// ── Zip bombs, and memory ────────────────────────────────────────────────────
//
// A zip says how big its contents are, and can lie. So: at most 2,000 entries;
// at most 2 GB of photos, by the sizes the directory declares; no entry over
// the largest a photo may be (meganet.attachment_type's biggest limit, 24 MB,
// which the caller passes); and an entry is inflated against its declared size
// and abandoned the moment it passes it — a 42 kB file that unpacks to 4 GB
// stops at the declared 3 MB, not at 4 GB. Its CRC-32 is then checked, so a
// damaged zip is a refused photo rather than a photo with a grey band across
// it.
//
// Nothing holds the archive's contents. Opening reads the last 64 kB and the
// directory; an entry's bytes are read out of the Blob with slice() when the
// queue gets to it — one at a time, as the queue reads — and a stored entry
// (the zipper did not compress it, as it often does not for a JPEG) is never
// copied at all: its File is a slice of the zip on disk. The caller lets an
// inflated entry go once it has read it and inflates it again to upload it,
// so a two-hundred-photo zip is never two hundred photos in memory.
//
// Format: PKWARE's APPNOTE.TXT (6.3.10), sections 4.3 and 4.4.

const PhotoZip = (function () {

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_END = 0x06054b50;

  const LIMITS = {
    entries: 2000,                        // files in one pack, folders and all
    total: 2 * 1024 * 1024 * 1024,        // photos' declared bytes, all told
    entry: 24 * 1024 * 1024,              // one photo — the caller's own limit wins when it has one
    directory: 16 * 1024 * 1024,          // the central directory itself
  };

  // What an extension is, for the entries that carry no type of their own —
  // which is all of them: a zip records names, not MIME types. The same five
  // field-photos.js's looksLikeImage() accepts.
  const IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
                  heic: 'image/heic', heif: 'image/heif' };

  // The methods a zip can name that this cannot unpack, by the name somebody
  // would recognise in a zipper's settings.
  const METHOD = { 1: 'Shrink', 6: 'Implode', 9: 'Deflate64', 12: 'bzip2', 14: 'LZMA', 19: 'LZ77',
                   93: 'Zstandard', 95: 'XZ', 96: 'JPEG (WinZip)', 97: 'WavPack', 98: 'PPMd', 99: 'AES encryption' };

  // IBM code page 437's upper half: what a zip's names are in when the zipper
  // did not set the UTF-8 flag — DOS's encoding, and still Windows Explorer's
  // and older zippers' for anything not plain ASCII. A name decoded any other
  // way is a name with the wrong letters in it.
  const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
              + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

  // ── Small readers ──────────────────────────────────────────────────────────

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function mb(bytes) {
    return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB`
         : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  async function bytesOf(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  // UTF-8 by the platform's decoder where there is one, CP437 by the table.
  function decodeName(bytes, utf8) {
    if (utf8 && typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (_) { /* below */ }
    }
    let s = '';
    for (const c of bytes) s += c < 0x80 ? String.fromCharCode(c) : CP437[c - 0x80];
    return s;
  }

  // ── CRC-32, the zip's own checksum ─────────────────────────────────────────
  let CRC_TABLE = null;
  function crc32(bytes, crc = 0) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── Names and dates ────────────────────────────────────────────────────────

  function baseName(path) {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
  function extensionOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function imageType(name) { return IMAGE[extensionOf(name)] || null; }

  // The zipper's, not the crew's: macOS's resource forks and its folder
  // settings, AppleDouble shadows, and Windows' thumbnail cache.
  function isJunk(path) {
    const segs = String(path || '').split(/[\\/]+/).filter(Boolean);
    if (segs.some(s => s === '__MACOSX')) return true;
    const base = segs.length ? segs[segs.length - 1] : '';
    return base.startsWith('.') || /^(thumbs\.db|desktop\.ini|ehthumbs\.db)$/i.test(base);
  }

  // A DOS date and time — local, to two seconds, no zone — as milliseconds, in
  // the zone the browser is in, which is the only reading of a zone-less time
  // there is. Nought or nonsense is no date.
  function dosTime(date, time) {
    const y = 1980 + (date >> 9), mo = (date >> 5) & 15, d = date & 31;
    const h = time >> 11, mi = (time >> 5) & 63, s = (time & 31) * 2;
    if (!date || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
    const t = new Date(y, mo - 1, d, h, mi, s).getTime();
    return isFinite(t) ? t : null;
  }

  // The extra fields a central directory entry carries that matter here: the
  // Unix modification time Info-ZIP and macOS write (0x5455, UTC, to the
  // second — better than DOS's), and the UTF-8 name some zippers add beside a
  // CP437 one (0x7075), used only while it still describes the same name.
  function extras(b, start, end, nameBytes) {
    const out = { mtime: null, name: null };
    for (let o = start; o + 4 <= end;) {
      const id = u16(b, o), len = u16(b, o + 2), d = o + 4;
      if (d + len > end) break;
      if (id === 0x5455 && len >= 5 && (b[d] & 1)) {
        const t = u32(b, d + 1);
        if (t) out.mtime = t * 1000;
      } else if (id === 0x7075 && len >= 5 && b[d] === 1) {
        if (u32(b, d + 1) === crc32(nameBytes)) out.name = decodeName(b.subarray(d + 5, d + len), true);
      }
      o = d + len;
    }
    return out;
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  function refusal(message) { const e = new Error(message); e.zip = true; return e; }

  // `blob` is the zip as a File or Blob. `opts.limits` overrides LIMITS
  // (field-photos.js passes the largest attachment_type limit as `entry`).
  //
  // → { name, size, photos: [entry], leftOut: [{ name, why }], junk, folders }
  //   where an entry is { path, name, type, method, flags, crc, csize, usize,
  //   offset, mtime } — everything extract() needs, and nothing it has read.
  //
  // Throws, with a sentence as the message, for an archive it will not open.
  async function open(blob, opts = {}) {
    const lim = Object.assign({}, LIMITS, opts.limits || {});
    const size = blob.size;
    if (size < 22) throw refusal('it is too short to be a zip — it may be cut short');

    // The End of Central Directory record: the last 22 bytes, unless the zip
    // carries a comment, which can be up to 65,535 bytes long and follows it.
    const tailStart = Math.max(0, size - 22 - 65535);
    const tail = await bytesOf(blob, tailStart, size);
    let at = -1;
    for (let o = tail.length - 22; o >= 0; o--) {
      if (u32(tail, o) !== SIG_END) continue;
      const commentLen = u16(tail, o + 20);
      if (o + 22 + commentLen === tail.length) { at = o; break; }   // the comment runs to the end: this is it
      if (at < 0 && o + 22 + commentLen <= tail.length) at = o;       // something appended after it: keep looking
    }
    if (at < 0) throw refusal('it is not a zip, or it is cut short — there is no end-of-archive record in it');

    const disk = u16(tail, at + 4), cdDisk = u16(tail, at + 6);
    const onDisk = u16(tail, at + 8), count = u16(tail, at + 10);
    const cdSize = u32(tail, at + 12), cdOffset = u32(tail, at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw refusal('it is a ZIP64 archive (over 4 GB, or over 65,535 files), which this tab does not open — zip the photos in smaller packs');
    }
    if (disk !== 0 || cdDisk !== 0 || onDisk !== count) {
      throw refusal('it is one part of a spanned or split zip (.z01, .z02 …) — join the parts into one zip first');
    }
    if (count > lim.entries) {
      throw refusal(`it holds ${count.toLocaleString('en-AU')} files, and a pack may hold ${lim.entries.toLocaleString('en-AU')} — split it into smaller zips`);
    }
    if (cdSize > lim.directory) throw refusal('its directory is implausibly large — the zip is damaged');

    // Where the directory really is: where the record says, unless the zip
    // has something in front of it — a self-extractor's program, say — which
    // leaves every offset short by that much (unzip allows for it, and so does
    // this), or carries ZIP64 records it did not need in front of the classic
    // one. Each place is tried for the directory's signature; the first that
    // has it is believed.
    const endAt = tailStart + at;
    const tries = [cdOffset, endAt - cdSize];
    if (at >= 20 && u32(tail, at - 20) === 0x07064b50) tries.push(endAt - 20 - 56 - cdSize);
    let cdAt = -1;
    for (const t of tries) {
      if (t < 0 || t + cdSize > endAt) continue;
      if (!count) { cdAt = t; break; }
      const sig = await bytesOf(blob, t, t + 4);
      if (sig.length === 4 && u32(sig, 0) === SIG_CENTRAL) { cdAt = t; break; }
    }
    if (cdAt < 0) throw refusal('its directory is not where the zip says — the zip is damaged or cut short');
    const shift = cdAt - cdOffset;

    const cd = await bytesOf(blob, cdAt, cdAt + cdSize);
    const photos = [], leftOut = [];
    let junk = 0, folders = 0, total = 0;
    let o = 0;
    for (let i = 0; i < count; i++) {
      if (o + 46 > cd.length || u32(cd, o) !== SIG_CENTRAL) throw refusal('its directory is damaged — the zip cannot be read');
      const madeBy = u16(cd, o + 4) >> 8;
      const flags = u16(cd, o + 8), method = u16(cd, o + 10);
      const time = u16(cd, o + 12), date = u16(cd, o + 14);
      const crc = u32(cd, o + 16), csize = u32(cd, o + 20), usize = u32(cd, o + 24);
      const nameLen = u16(cd, o + 28), extraLen = u16(cd, o + 30), commentLen = u16(cd, o + 32);
      const extAttr = u32(cd, o + 38), local = u32(cd, o + 42);
      const nameAt = o + 46, extraAt = nameAt + nameLen, next = extraAt + extraLen + commentLen;
      if (next > cd.length) throw refusal('its directory is damaged — the zip cannot be read');
      const nameBytes = cd.subarray(nameAt, extraAt);
      const ext = extras(cd, extraAt, extraAt + extraLen, nameBytes);
      const path = ext.name || decodeName(nameBytes, !!(flags & 0x800));
      o = next;

      // A folder: named with a trailing slash, or marked one by DOS.
      if (/[\\/]$/.test(path) || (madeBy === 0 && (extAttr & 0x10))) { folders++; continue; }
      if (isJunk(path)) { junk++; continue; }

      const name = baseName(path) || `entry ${i + 1}`;
      const type = imageType(name);
      let why = null;
      if (!type) {
        why = extensionOf(name) === 'zip' ? 'a zip inside the zip — unzip it and drop that in on its own' : 'not a photo';
      } else if ((flags & 0x1) || (flags & 0x40) || method === 99) {
        why = 'encrypted — a password-protected zip cannot be read here';
      } else if (method !== 0 && method !== 8) {
        why = `compressed with ${METHOD[method] || `method ${method}`}, which a browser cannot unpack — zip it again with ordinary compression`;
      } else if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
        why = 'stored as ZIP64, which this tab does not open — zip the photos in smaller packs';
      } else if (usize > lim.entry) {
        why = `${mb(usize)}, over the ${mb(lim.entry)} a photo may be`;
      } else if (method === 0 && csize !== usize) {
        why = 'damaged — stored uncompressed, and yet a different size in the zip';
      }
      if (why) { leftOut.push({ name: path, why }); continue; }

      total += usize;
      photos.push({
        path, name, type, method, flags, crc, csize, usize,
        offset: local + shift,
        mtime: ext.mtime || dosTime(date, time) || (blob.lastModified || null),
      });
    }
    if (total > lim.total) {
      throw refusal(`its photos come to ${mb(total)} unpacked, over the ${mb(lim.total)} one pack may hold — split it into smaller zips`);
    }
    return { name: blob.name || '', size, photos, leftOut, junk, folders };
  }

  // ── One entry's bytes ──────────────────────────────────────────────────────

  // Where an entry's data starts: after its local header, whose name and extra
  // field lengths are its own (they need not match the directory's). A data
  // descriptor (flag bit 3) leaves the local sizes and CRC nought, which is
  // why nothing here reads them: the directory's are the ones believed.
  async function dataStart(blob, entry) {
    const h = await bytesOf(blob, entry.offset, entry.offset + 30);
    if (h.length < 30 || u32(h, 0) !== SIG_LOCAL) {
      throw refusal('its entry in the zip is damaged — nothing is where the zip\'s directory says it is');
    }
    const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
    if (start + entry.csize > blob.size) throw refusal('the zip is cut short — this photo runs past its end');
    return start;
  }

  // The entry's bytes, checked: inflated no further than the size the
  // directory declares, then measured and checksummed against it.
  async function extract(blob, entry) {
    const start = await dataStart(blob, entry);
    const raw = blob.slice(start, start + entry.csize);
    let out;
    if (entry.method === 0) {
      out = new Uint8Array(await raw.arrayBuffer());
    } else {
      if (typeof DecompressionStream === 'undefined') {
        throw refusal('this browser cannot unpack a compressed zip — unzip it, and drop the photos in');
      }
      let ds;
      try { ds = new DecompressionStream('deflate-raw'); } catch (_) {
        throw refusal('this browser cannot unpack a compressed zip — unzip it, and drop the photos in');
      }
      const reader = raw.stream().pipeThrough(ds).getReader();
      const chunks = [];
      let got = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (got > entry.usize) {
            try { await reader.cancel(); } catch (_) { /* already failing */ }
            throw refusal(`it unpacks to more than the ${mb(entry.usize)} the zip says it holds — the zip is damaged, or not what it claims`);
          }
          chunks.push(value);
        }
      } catch (err) {
        if (err && err.zip) throw err;
        throw refusal(`it could not be unpacked — the zip is damaged (${(err && err.message) || err})`);
      }
      out = new Uint8Array(got);
      let p = 0;
      for (const c of chunks) { out.set(c, p); p += c.length; }
    }
    if (out.length !== entry.usize) {
      throw refusal(`it unpacks to ${out.length < entry.usize ? 'less' : 'more'} than the zip says it holds — the zip is damaged or cut short`);
    }
    if (crc32(out) !== entry.crc) throw refusal('its checksum does not match — the zip is damaged');
    return out;
  }

  // The entry as a File, named by its own name and dated by the zip, for a
  // caller that reads Files. A stored entry's File is a slice of the zip —
  // checked here, then read again by whoever reads it, and never held — and an
  // inflated one's holds its bytes, which the caller lets go when it is done.
  async function file(blob, entry) {
    const bytes = await extract(blob, entry);
    const opts = { type: entry.type, lastModified: entry.mtime || Date.now() };
    if (entry.method === 0) {
      const start = await dataStart(blob, entry);
      return new File([blob.slice(start, start + entry.csize)], entry.name, opts);
    }
    return new File([bytes], entry.name, opts);
  }

  function isZip(f) {
    if (!f) return false;
    return /\.zip$/i.test(f.name || '') || /^application\/(x-)?zip(-compressed)?$/i.test(f.type || '');
  }

  return { open, extract, file, isZip, imageType, isJunk, dosTime, crc32, LIMITS };
})();

if (typeof window !== 'undefined') window.PhotoZip = PhotoZip;
// test/photozip.mjs require()s this same file under Node, to hold it against
// zips built byte by byte. Guarded so the browser, where `module` is
// undefined, never runs it; constrains nothing below.
if (typeof module !== 'undefined' && module.exports) module.exports = PhotoZip;
