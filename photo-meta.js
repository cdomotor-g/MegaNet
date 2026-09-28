// MegaNet — photo-meta.js
//
//   PhotoMeta   what a field photo says about where and when it was taken:
//               the GPS, the time and the heading its camera wrote into it
//               (EXIF, and XMP where a drone or an editor put them there),
//               and — where a camera app burned them into the pixels
//               instead — the same facts read back off the picture itself,
//               as text, through OCR.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Pure: bytes and text in, numbers and the sentences that say where they came
// from out. It touches no page, no `state` and no network of its own — the one
// thing it will fetch is the OCR engine, and only when a caller asks it to and
// hands it the host that does the fetching. The IIFE body only declares, so its
// position among the modules is free (`npm run toplevel`).
//
// **Two hosts read photos with this file, and that is why it is one file.**
// field-photos.js runs it in the browser on what somebody drops on the Field
// Photos tab; tools/field-photos/sync.mjs runs the very same file under Node on
// what arrives in Dropbox (the `module.exports` at the foot). A photo read one
// way on upload and another way on sync would be two positions for one
// picture, with nothing to say which was right — so the rules for reading it
// are written once, here, and each host supplies only the two things that
// differ between a browser and a server: how to get a band of pixels out of an
// image, and how to run the OCR engine over it.
//
// ── The order a position is believed in ──────────────────────────────────────
//
//   1. **EXIF GPS** — GPSLatitude/GPSLongitude, the heading (GPSImgDirection),
//      the altitude and the horizontal error the phone recorded. Every phone
//      camera writes these when location is on, and so do the field camera
//      apps (Solocator, GPS Map Camera, Timestamp Camera …) as well as burning
//      them into the picture.
//   2. **XMP** — the same fields in the Adobe packet, where an editor moved
//      them, and a DJI drone's own GPS and gimbal yaw and pitch.
//   3. **The picture itself** — a coordinate, heading, altitude and time read
//      off the overlay a field camera app draws, by OCR. Only when 1 and 2
//      are both empty: a photo that has been through Messages, a chat app, a
//      screenshot or an email has usually lost its EXIF and kept its overlay,
//      which is exactly the case this exists for.
//
// A photo that none of the three can place is not guessed at. It is uploaded
// unplaced, and somebody puts it where it belongs.
//
// One number is read off the picture even when the file places the photo: the
// ±. Solocator writes the fix into the EXIF without GPSHPositioningError and
// prints it on the overlay instead (`±13m`), so a photo from an app that does
// that (printsAccuracy) is read for its ± alone — the file's position, time
// and heading still win, and the overlay's ± is taken only for the same fix
// (overlayAccuracy). The viewer flags a fix looser than 7 m.
//
// ── Reading an overlay ───────────────────────────────────────────────────────
//
// The overlay is not one format: every app draws its own, and OCR reads each
// one with its own mistakes. So the parser does not know any app. It looks for
// the *shapes* those facts take in text — a signed decimal pair, a pair with
// hemisphere letters, degrees-minutes-seconds, an MGA/UTM grid reference, a
// heading with a compass word that has to agree with its degrees, ±N m, an
// altitude with its datum, a date and time with its zone — and it reads the
// picture more than once and believes what the readings agree on.
//
// What was measured, on the two Solocator photos the Field Photos issue came
// with (both re-encoded, EXIF gone, overlay kept):
//
//   * The whole frame at once reads badly (seconds per photo, and one of the
//     two longitudes came back cut short): the photograph under the text is
//     most of the pixels, and the page segmenter tries to read the trees.
//     Overlays live at the top and bottom edges, so those two bands are what
//     is read, a fifth of the frame each.
//   * Dark text on a light bar reads best as plain grey with the contrast
//     stretched — `242°SW (T) -27.554294°,152.274116° +4m A 134m (HAE)`.
//   * Coloured text drawn straight on the photograph (Solocator's green)
//     reads not at all as grey, and perfectly once the band is keyed on its
//     own dominant saturated hue into black on white:
//     `Gatton 2026-06-24, 12:26:08 AEST`, at 94 % confidence, in 0.1 s.
//   * One reading in six had a digit wrong or a point missing
//     (`-27.5654294°`, `-27554300°`). Hence the votes: every band is read
//     again with a second segmentation mode when the first found a position,
//     candidates are pooled a metre apart, and the one more readings agree on
//     wins. A latitude printed to one more decimal place than its own
//     longitude is suspect on sight — apps print the pair to one precision.
//
// ── Datums and zones ─────────────────────────────────────────────────────────
//
// The position is WGS84 as the phone had it: within about 1.5 m of GDA2020
// over Australia, which is inside what any phone's GPS claims. The altitude is
// stored with the datum the source named — EXIF says above sea level, and
// Solocator prints `(HAE)`, height above the ellipsoid, some 40 m off AHD in
// Queensland — and is never used to stand a marker on the ground: the ground
// under a photo is the ground the twin reads there.
//
// A time without a zone is not a time. EXIF 2.31's OffsetTimeOriginal is used
// where the camera wrote it; failing that, the zone is worked out from the
// GPS clock (UTC) against the camera's local clock; failing that, from where
// the photo was taken in Australia (Queensland keeps +10:00 all year, New
// South Wales does not), and the result says it was assumed.
//
// ── Reading labels ───────────────────────────────────────────────────────────
//
// The same engine reads the equipment in a photo, when somebody asks it to
// (readLabels, ocrLabels): the whole frame and its four quarters rather than
// the overlay's bands, every reading's text handed back, and nothing decided
// here — photo-equipment.js turns the text into makes, models and serials,
// and an administrator decides what the station's register believes (0036).
//
// Schema: db/migrations/0035_field_photos.sql, 0036_photo_review.sql. The
// rest: docs/field-photos.md.

const PhotoMeta = (function () {

  // ── The OCR engine ─────────────────────────────────────────────────────────
  // Tesseract.js, fetched on the first photo that needs reading and never for
  // a session that does not have one — the three.js and MapLibre terms. All of
  // it from unpkg, which the Bureau's filter already allows for Leaflet: the
  // library's own defaults would fetch its worker and core from jsDelivr and
  // its language data from a third host nobody has asked the filter about.
  // Pinned, as every library here is pinned; the check serves exactly these
  // versions from its devDependencies and aborts any other.
  const OCR_VER      = '7.0.0';
  const OCR_CORE_VER = '7.0.0';
  const OCR_LANG_VER = '1.0.0';
  const OCR_LIB   = `https://unpkg.com/tesseract.js@${OCR_VER}/dist/tesseract.min.js`;
  const OCR_WORKER = `https://unpkg.com/tesseract.js@${OCR_VER}/dist/worker.min.js`;
  const OCR_CORE  = `https://unpkg.com/tesseract.js-core@${OCR_CORE_VER}`;
  const OCR_LANG  = `https://unpkg.com/@tesseract.js-data/eng@${OCR_LANG_VER}/4.0.0_best_int`;

  // The bands an overlay is looked for in, as fractions of the frame, and the
  // widest a band is handed to the engine at: 2,000 px puts a phone overlay's
  // text at 30–45 px tall, which is where Tesseract reads best, and keeps a
  // pass under a second.
  const BANDS = [
    { name: 'top',    y0: 0,    y1: 0.22 },
    { name: 'bottom', y0: 0.78, y1: 1 },
  ];
  const OCR_MAX_W = 2000;
  const OCR_MIN_W = 1200;
  const OCR_MAX_PASSES = 8;

  // Equipment labels (readLabels, below) are not in a band: they are wherever
  // the equipment is, and small. So the whole frame is read once at a size a
  // label's larger print survives, then in four overlapping quarters at the
  // photo's own resolution — enlarged where the photo is small — which is
  // where a serial number's 3 mm print is still 20 px tall. Bounded: six
  // passes at most, a few seconds each, and a caller may ask for fewer.
  const LABEL_WHOLE_W = 2400;
  const LABEL_TILE_MAX = 2600;
  const LABEL_TILE_MIN = 1400;
  const LABEL_OVERLAP = 0.08;
  const LABEL_PASSES = 6;

  // ── Small readers ──────────────────────────────────────────────────────────

  function bytesOf(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (buf && buf.buffer instanceof ArrayBuffer) return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    // A Node Buffer from another realm (the vm the checks load this into) is
    // not `instanceof` this realm's Uint8Array, and is still one.
    if (buf && typeof buf.length === 'number' && typeof buf.subarray === 'function') return buf;
    return new Uint8Array(0);
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
  function u32le(b, o) { return ((b[o + 3] << 24) >>> 0) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o]); }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function startsWith(b, o, s) {
    if (o + s.length > b.length) return false;
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  }

  // UTF-8, by hand: a vm context (the checks, the sync) has no TextDecoder, and
  // an ImageDescription or an XMP packet is as likely to be UTF-8 as ASCII.
  function utf8(b, start, end) {
    let s = '';
    for (let i = start; i < end;) {
      const c = b[i++];
      if (c < 0x80) { s += String.fromCharCode(c); continue; }
      let n = 0, cp = 0;
      if (c >= 0xf0) { n = 3; cp = c & 0x07; } else if (c >= 0xe0) { n = 2; cp = c & 0x0f; } else if (c >= 0xc0) { n = 1; cp = c & 0x1f; } else { s += '�'; continue; }
      for (let k = 0; k < n && i < end; k++) cp = (cp << 6) | (b[i++] & 0x3f);
      s += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
    }
    return s;
  }

  // ── TIFF, which is what EXIF is ────────────────────────────────────────────
  // One reader for every container: a JPEG's APP1, a HEIC's Exif item, a PNG's
  // eXIf chunk and a WebP's EXIF chunk all hold the same TIFF structure. Every
  // offset in it is relative to its own header and every read is bounds-checked
  // against the container's slice, because a photo is somebody else's file.

  const TIFF_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  function readTiff(b, start, end) {
    if (start + 8 > end) return null;
    const le = b[start] === 0x49 && b[start + 1] === 0x49;
    const be = b[start] === 0x4d && b[start + 1] === 0x4d;
    if (!le && !be) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = o => dv.getUint16(o, le);
    const u32 = o => dv.getUint32(o, le);
    if (u16(start + 2) !== 42) return null;

    function value(type, count, o) {
      const arr = [];
      switch (type) {
        case 2: {
          let e = o;
          while (e < o + count && b[e]) e++;
          return utf8(b, o, e).trim();
        }
        case 1: case 7:
          return count === 1 ? b[o] : b.subarray(o, o + count);
        case 6:
          for (let i = 0; i < count; i++) arr.push(dv.getInt8(o + i));
          break;
        case 3:
          for (let i = 0; i < count; i++) arr.push(u16(o + i * 2));
          break;
        case 8:
          for (let i = 0; i < count; i++) arr.push(dv.getInt16(o + i * 2, le));
          break;
        case 4:
          for (let i = 0; i < count; i++) arr.push(u32(o + i * 4));
          break;
        case 9:
          for (let i = 0; i < count; i++) arr.push(dv.getInt32(o + i * 4, le));
          break;
        case 5: case 10:
          for (let i = 0; i < count; i++) {
            const num = type === 5 ? u32(o + i * 8) : dv.getInt32(o + i * 8, le);
            const den = type === 5 ? u32(o + i * 8 + 4) : dv.getInt32(o + i * 8 + 4, le);
            arr.push(den ? num / den : NaN);
          }
          break;
        case 11:
          for (let i = 0; i < count; i++) arr.push(dv.getFloat32(o + i * 4, le));
          break;
        case 12:
          for (let i = 0; i < count; i++) arr.push(dv.getFloat64(o + i * 8, le));
          break;
        default:
          return null;
      }
      return count === 1 ? arr[0] : arr;
    }

    function ifd(off) {
      const out = new Map();
      const at = start + off;
      if (!off || at + 2 > end) return out;
      const n = u16(at);
      if (n > 1000) return out;
      for (let i = 0; i < n; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > end) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = TIFF_SIZE[type] || 0;
        if (!size || count > 1048576) continue;
        const total = size * count;
        const vo = total <= 4 ? e + 8 : start + u32(e + 8);
        if (vo < start || vo + total > end) continue;
        const v = value(type, count, vo);
        if (v !== null && v !== undefined) out.set(tag, v);
      }
      return out;
    }

    const ifd0 = ifd(u32(start + 4));
    const exifOff = ifd0.get(0x8769), gpsOff = ifd0.get(0x8825);
    return {
      littleEndian: le,
      ifd0,
      exif: typeof exifOff === 'number' ? ifd(exifOff) : new Map(),
      gps:  typeof gpsOff === 'number' ? ifd(gpsOff) : new Map(),
    };
  }

  // ── The containers ─────────────────────────────────────────────────────────

  function sniff(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && startsWith(b, 1, 'PNG\r\n\x1a\n')) return 'png';
    if (b.length >= 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
    if (b.length >= 12 && startsWith(b, 4, 'ftyp')) {
      const brand = fourcc(b, 8);
      if (/^(avif|avis)$/.test(brand)) return 'avif';
      return 'heic';
    }
    return 'unknown';
  }

  // A JPEG's segments, to the start of the scan. APP1 carries EXIF ("Exif\0\0"
  // then a TIFF header) or XMP (the Adobe namespace and a packet); a start-of-
  // frame carries the pixel size.
  const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
  function walkJpeg(b, out) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      const len = u16be(b, o + 2);
      const seg = o + 4, end = o + 2 + len;
      if (len < 2 || end > b.length) break;
      if (m === 0xe1) {
        if (startsWith(b, seg, 'Exif\0')) out.tiffs.push([seg + 6, end]);
        else if (startsWith(b, seg, XMP_NS)) out.xmp = (out.xmp || '') + utf8(b, seg + XMP_NS.length, end);
      } else if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (seg + 5 <= end) { out.height = u16be(b, seg + 1); out.width = u16be(b, seg + 3); }
      }
      o = end;
    }
  }

  // ISO BMFF (HEIC, HEIF, AVIF): the `meta` box's item table. The Exif item is
  // found by type in `iinf`, located by `iloc` (in the file or in `idat`), and
  // opens with a 4-byte offset to its TIFF header. `ispe` gives the size.
  function boxAt(b, o, end) {
    if (o + 8 > end) return null;
    let size = u32be(b, o), hdr = 8;
    const type = fourcc(b, o + 4);
    if (size === 1) { if (o + 16 > end) return null; size = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr) return null;
    return { type, start: o, data: o + hdr, end: Math.min(end, o + size) };
  }
  function children(b, start, end) {
    const out = [];
    for (let o = start; o < end;) {
      const bx = boxAt(b, o, end);
      if (!bx) break;
      out.push(bx);
      if (bx.end <= o) break;
      o = bx.end;
    }
    return out;
  }
  function cstring(b, o, end) {
    let e = o;
    while (e < end && b[e]) e++;
    return { s: utf8(b, o, e), next: Math.min(end, e + 1) };
  }
  function readN(b, o, n) {
    if (n === 0) return 0;
    if (n === 4) return u32be(b, o);
    if (n === 8) return u32be(b, o) * 4294967296 + u32be(b, o + 4);
    if (n === 2) return u16be(b, o);
    return 0;
  }
  function walkBmff(b, out) {
    const top = children(b, 0, b.length);
    const meta = top.find(x => x.type === 'meta');
    if (!meta) return;
    const kids = children(b, meta.data + 4, meta.end);   // meta is a full box
    const items = new Map();   // id → { type, contentType }
    const locs = new Map();    // id → { method, base, extents: [[off, len]] }
    let idat = null;
    let bestArea = 0;
    for (const k of kids) {
      if (k.type === 'iinf') {
        const v = b[k.data];
        const n = v === 0 ? u16be(b, k.data + 4) : u32be(b, k.data + 4);
        const first = k.data + (v === 0 ? 6 : 8);
        for (const infe of children(b, first, k.end).slice(0, Math.min(n, 4096))) {
          if (infe.type !== 'infe') continue;
          const iv = b[infe.data];
          if (iv < 2) continue;
          let p = infe.data + 4;
          const id = iv === 2 ? u16be(b, p) : u32be(b, p);
          p += iv === 2 ? 2 : 4;
          p += 2;                               // item_protection_index
          const type = fourcc(b, p); p += 4;
          const name = cstring(b, p, infe.end);
          let contentType = '';
          if (type === 'mime') contentType = cstring(b, name.next, infe.end).s;
          items.set(id, { type, contentType });
        }
      } else if (k.type === 'iloc') {
        const v = b[k.data];
        let p = k.data + 4;
        const offSize = b[p] >> 4, lenSize = b[p] & 15, baseSize = b[p + 1] >> 4;
        const idxSize = (v === 1 || v === 2) ? b[p + 1] & 15 : 0;
        p += 2;
        const n = v < 2 ? u16be(b, p) : u32be(b, p);
        p += v < 2 ? 2 : 4;
        for (let i = 0; i < n && p < k.end; i++) {
          const id = v < 2 ? u16be(b, p) : u32be(b, p);
          p += v < 2 ? 2 : 4;
          let method = 0;
          if (v === 1 || v === 2) { method = u16be(b, p) & 15; p += 2; }
          p += 2;                               // data_reference_index
          const base = readN(b, p, baseSize); p += baseSize;
          const ne = u16be(b, p); p += 2;
          const extents = [];
          for (let e = 0; e < ne && p < k.end; e++) {
            p += idxSize;
            const off = readN(b, p, offSize); p += offSize;
            const len = readN(b, p, lenSize); p += lenSize;
            extents.push([off, len]);
          }
          locs.set(id, { method, base, extents });
        }
      } else if (k.type === 'idat') {
        idat = k.data;
      } else if (k.type === 'iprp') {
        for (const c of children(b, k.data, k.end)) {
          if (c.type !== 'ipco') continue;
          for (const p of children(b, c.data, c.end)) {
            if (p.type !== 'ispe' || p.data + 12 > p.end) continue;
            const w = u32be(b, p.data + 4), h = u32be(b, p.data + 8);
            if (w * h > bestArea) { bestArea = w * h; out.width = w; out.height = h; }
          }
        }
      }
    }
    const where = id => {
      const l = locs.get(id);
      if (!l || !l.extents.length) return null;
      const [off, len] = l.extents[0];
      const abs = l.method === 1 ? (idat === null ? -1 : idat + l.base + off) : l.base + off;
      if (abs < 0 || abs >= b.length) return null;
      return [abs, Math.min(b.length, abs + (len || b.length - abs))];
    };
    for (const [id, it] of items) {
      if (it.type === 'Exif') {
        const w = where(id);
        if (!w || w[0] + 4 > w[1]) continue;
        const skip = u32be(b, w[0]);
        const at = w[0] + 4 + skip;
        if (at < w[1]) out.tiffs.push([at, w[1]]);
      } else if (it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType)) {
        const w = where(id);
        if (w) out.xmp = (out.xmp || '') + utf8(b, w[0], w[1]);
      }
    }
  }

  function walkPng(b, out) {
    for (let o = 8; o + 12 <= b.length;) {
      const len = u32be(b, o), type = fourcc(b, o + 4), d = o + 8, end = d + len;
      if (end + 4 > b.length) break;
      if (type === 'IHDR') { out.width = u32be(b, d); out.height = u32be(b, d + 4); }
      else if (type === 'eXIf') out.tiffs.push([startsWith(b, d, 'Exif\0') ? d + 6 : d, end]);
      else if (type === 'iTXt' && startsWith(b, d, 'XML:com.adobe.xmp\0')) {
        const p = d + 18;
        if (b[p] === 0) {                       // uncompressed
          let q = p + 2;
          q = cstring(b, q, end).next;          // language tag
          q = cstring(b, q, end).next;          // translated keyword
          out.xmp = (out.xmp || '') + utf8(b, q, end);
        }
      } else if (type === 'IEND') break;
      o = end + 4;
    }
  }

  function walkWebp(b, out) {
    for (let o = 12; o + 8 <= b.length;) {
      const type = fourcc(b, o), len = u32le(b, o + 4), d = o + 8, end = Math.min(b.length, d + len);
      if (type === 'VP8X' && d + 10 <= end) {
        out.width  = 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16));
        out.height = 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16));
      } else if (type === 'VP8 ' && d + 10 <= end && out.width == null) {
        out.width  = (b[d + 6] | (b[d + 7] << 8)) & 0x3fff;
        out.height = (b[d + 8] | (b[d + 9] << 8)) & 0x3fff;
      } else if (type === 'EXIF') {
        out.tiffs.push([startsWith(b, d, 'Exif\0') ? d + 6 : d, end]);
      } else if (type === 'XMP ') {
        out.xmp = (out.xmp || '') + utf8(b, d, end);
      }
      o = d + len + (len & 1);
    }
  }

  // ── EXIF, into the facts ───────────────────────────────────────────────────

  // A number that is there. `isFinite(null)` is true — null is nought to it —
  // and a field that is null means "not known", never nought: a photo with no
  // pitch is not one held level, and one with no heading does not face north.
  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : (Array.isArray(v) && isFinite(v[0]) ? v[0] : null); }
  function dms(v, ref) {
    if (!Array.isArray(v) || !v.length) return typeof v === 'number' && isFinite(v) ? v * (/^[SW]/i.test(ref || '') ? -1 : 1) : null;
    const [d, m = 0, s = 0] = v;
    if (![d, m, s].every(isFinite)) return null;
    const x = Math.abs(d) + m / 60 + s / 3600;
    return /^[SW]/i.test(ref || '') || d < 0 ? -x : x;
  }
  function validPair(lat, lon) {
    return known(lat) && known(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      && !(Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9);        // (0, 0) is "no fix", not the Gulf of Guinea
  }
  function pad(n, w = 2) { return String(n).padStart(w, '0'); }
  function normHeading(h) { return known(h) ? ((h % 360) + 360) % 360 : null; }

  // EXIF writes `2026:06:24 12:26:08` (some writers use dashes or a T).
  function exifLocal(s) {
    const m = /^(\d{4})[:\-/.](\d{2})[:\-/.](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
    if (!m) return null;
    const [, Y, M, D, h, mi, se = '00'] = m;
    if (+M < 1 || +M > 12 || +D < 1 || +D > 31 || +h > 23 || +mi > 59 || +se > 60) return null;
    if (+Y < 1990) return null;                  // 0000:00:00 and the 1970 of a phone with no clock
    return `${Y}-${M}-${D}T${h}:${mi}:${se}`;
  }
  function offsetOk(s) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s || '').trim());
    return m ? `${m[1]}${m[2]}:${m[3]}` : null;
  }
  function localMs(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
  }
  function offsetMinutes(off) {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(off || '');
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
  }
  function fmtOffset(min) {
    const s = min < 0 ? '-' : '+', a = Math.abs(min);
    return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  // The instant, from a local time and its offset.
  function isoFrom(local, off) {
    if (!local) return null;
    if (!off) return null;
    return `${local}${off}`;
  }
  function utcIso(local, off) {
    const ms = localMs(local), om = offsetMinutes(off);
    if (!isFinite(ms) || om === null) return null;
    return new Date(ms - om * 60000).toISOString();
  }

  // Where a photo was taken decides its zone when nothing in it says. Only
  // Australia is known, and only as well as a sketch of its borders: the one
  // place it matters is a photo from within a few kilometres of the
  // Queensland–New South Wales line, taken in summer, by a camera that wrote
  // no offset and no GPS clock. The result says it was assumed.
  const QLD_NSW = [[141, -29], [148.95, -29], [151.0, -28.95], [151.4, -28.75], [152.0, -28.55], [153.2, -28.25], [153.6, -28.17]];
  function qldNswBorder(lon) {
    for (let i = 1; i < QLD_NSW.length; i++) {
      const [x0, y0] = QLD_NSW[i - 1], [x1, y1] = QLD_NSW[i];
      if (lon <= x1) return y0 + (y1 - y0) * Math.max(0, (lon - x0) / (x1 - x0));
    }
    return QLD_NSW[QLD_NSW.length - 1][1];
  }
  function firstSunday(y, m) {
    const dow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((7 - dow) % 7);
  }
  // Southern daylight saving: the first Sunday in October to the first Sunday
  // in April. Decided on the date alone — the two hours either side of a
  // change are not worth a guess about.
  function southernDst(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(local || '');
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo > 10 || mo < 4) return true;
    if (mo === 10) return d >= firstSunday(y, 10);
    if (mo === 4) return d < firstSunday(y, 4);
    return false;
  }
  function auZone(lat, lon, local) {
    if (!known(lat) || !known(lon) || lat > -9 || lat < -44.5 || lon < 112 || lon > 154.5) return null;
    if (lon < 129) return { offset: '+08:00', zone: 'AWST' };
    if (lon < 138 && lat > -26) return { offset: '+09:30', zone: 'ACST' };
    if (lon < 141 && lat <= -26) return southernDst(local) ? { offset: '+10:30', zone: 'ACDT' } : { offset: '+09:30', zone: 'ACST' };
    if (lat > qldNswBorder(lon)) return { offset: '+10:00', zone: 'AEST' };
    return southernDst(local) ? { offset: '+11:00', zone: 'AEDT' } : { offset: '+10:00', zone: 'AEST' };
  }

  // A horizontal field of view from the 35 mm equivalent focal length. The
  // equivalent is defined on the diagonal (43.27 mm), so the side the picture
  // is wide along gets its share of that diagonal by the frame's own aspect.
  function fovFrom35(f35, w, h) {
    if (!known(f35) || f35 <= 0) return null;
    const W = known(w) && w > 0 ? w : 4, H = known(h) && h > 0 ? h : 3;
    const side = 43.27 * W / Math.hypot(W, H);
    return 2 * Math.atan(side / (2 * f35)) * 180 / Math.PI;
  }

  function userComment(v) {
    if (!(v instanceof Uint8Array) && !(v && typeof v.length === 'number' && typeof v.subarray === 'function')) return typeof v === 'string' ? v : '';
    if (v.length < 8) return '';
    const head = String.fromCharCode(...Array.from(v.subarray(0, 8))).replace(/\0+$/, '');
    if (head === 'UNICODE') {
      let s = '';
      for (let i = 8; i + 1 < v.length; i += 2) {
        const c = (v[i] << 8) | v[i + 1];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      // Byte order is the TIFF's; a comment that reads as CJK was the other one.
      if (/[㐀-鿿]/.test(s)) {
        s = '';
        for (let i = 8; i + 1 < v.length; i += 2) { const c = v[i] | (v[i + 1] << 8); if (!c) break; s += String.fromCharCode(c); }
      }
      return s.trim();
    }
    if (head === 'ASCII' || head === '') return utf8(v, 8, v.length).replace(/\0[\s\S]*$/, '').trim();
    return '';
  }

  function fromTiff(t, into) {
    const { ifd0, exif, gps } = t;
    if (ifd0.has(0x010f)) into.make = String(ifd0.get(0x010f));
    if (ifd0.has(0x0110)) into.model = String(ifd0.get(0x0110));
    if (ifd0.has(0x0131)) into.software = String(ifd0.get(0x0131));
    if (ifd0.has(0x010e)) into.description = String(ifd0.get(0x010e));
    const orient = num(ifd0.get(0x0112));
    if (orient >= 1 && orient <= 8) into.orientation = orient;
    if (exif.has(0xa434)) into.lens = String(exif.get(0xa434));
    const comment = userComment(exif.get(0x9286));
    if (comment) into.comment = comment;
    const pw = num(exif.get(0xa002)), ph = num(exif.get(0xa003));
    if (pw && ph && !into.exifWidth) { into.exifWidth = pw; into.exifHeight = ph; }
    const f35 = num(exif.get(0xa405));
    if (f35) into.focal35 = f35;

    // The shutter, in the camera's own local time, and its zone if written.
    const local = exifLocal(exif.get(0x9003)) || exifLocal(exif.get(0x9004));
    if (local && !into.local) {
      into.local = local;
      into.localSource = exif.has(0x9003) ? 'DateTimeOriginal' : 'DateTimeDigitized';
      const off = offsetOk(exif.get(0x9011)) || offsetOk(exif.get(0x9012)) || offsetOk(exif.get(0x9010));
      if (off) into.offset = off;
    }
    if (!into.modified) into.modified = exifLocal(ifd0.get(0x0132));

    // GPS.
    const lat = dms(gps.get(0x0002), gps.get(0x0001));
    const lon = dms(gps.get(0x0004), gps.get(0x0003));
    if (validPair(lat, lon) && !into.gps) {
      const g = { lat, lon, source: 'exif' };
      const alt = num(gps.get(0x0006));
      if (alt !== null) { g.alt = num(gps.get(0x0005)) === 1 ? -alt : alt; g.altRef = 'MSL'; }
      const dir = num(gps.get(0x0011));
      if (dir !== null && isFinite(dir)) { g.heading = normHeading(dir); g.headingRef = /^M/i.test(gps.get(0x0010) || '') ? 'M' : 'T'; }
      const err = num(gps.get(0x001f));
      if (err !== null && err > 0 && err < 100000) g.accuracy = err;
      const datum = gps.get(0x0012);
      if (typeof datum === 'string' && datum) g.datum = datum;
      const ds = gps.get(0x001d), ts = gps.get(0x0007);
      if (typeof ds === 'string' && Array.isArray(ts) && ts.length === 3 && ts.every(isFinite)) {
        const d = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(ds);
        if (d) {
          const secs = Math.round(ts[0] * 3600 + ts[1] * 60 + ts[2]);
          g.utc = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]) + secs * 1000).toISOString();
        }
      }
      into.gps = g;
    }
  }

  // ── XMP, into the same facts ───────────────────────────────────────────────
  // Attribute and element forms both, and the rdf:Alt a description sits in.
  function xmpGet(x, key) {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m = new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`).exec(x);
    if (m) return m[1];
    m = new RegExp(`<${k}>\\s*(?:<rdf:Alt>\\s*<rdf:li[^>]*>)?([^<]*)`).exec(x);
    return m ? m[1].trim() : null;
  }
  function xmpNum(s) {
    if (s == null || s === '') return null;
    const r = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(s);
    if (r) return +r[2] ? +r[1] / +r[2] : null;
    const v = parseFloat(s);
    return isFinite(v) ? v : null;
  }
  // XMP's exif:GPSLatitude is `DDD,MM,SSk` or `DDD,MM.mmk`.
  function xmpCoord(s) {
    const m = /^\s*(\d{1,3}),(\d{1,2}(?:\.\d+)?)(?:,(\d{1,2}(?:\.\d+)?))?\s*([NSEW])\s*$/i.exec(s || '');
    if (m) {
      const x = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0);
      return /[SW]/i.test(m[4]) ? -x : x;
    }
    const v = parseFloat(s);
    return isFinite(v) ? v : null;
  }
  function xmpLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s || '').trim());
    if (!m) return null;
    const off = m[7] === 'Z' ? '+00:00' : offsetOk(m[7]);
    return { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`, offset: off };
  }
  function fromXmp(x, into) {
    if (!x) return;
    into.xmp = true;
    if (!into.gps) {
      let lat = xmpCoord(xmpGet(x, 'exif:GPSLatitude')), lon = xmpCoord(xmpGet(x, 'exif:GPSLongitude'));
      let source = 'xmp';
      if (!validPair(lat, lon)) {
        // DJI writes its own, and spells longitude two ways across firmware.
        lat = xmpNum(xmpGet(x, 'drone-dji:GpsLatitude'));
        lon = xmpNum(xmpGet(x, 'drone-dji:GpsLongitude') || xmpGet(x, 'drone-dji:GpsLongtitude'));
        source = 'xmp-dji';
      }
      if (validPair(lat, lon)) {
        const g = { lat, lon, source };
        const alt = xmpNum(xmpGet(x, 'exif:GPSAltitude'));
        if (alt !== null) { g.alt = xmpGet(x, 'exif:GPSAltitudeRef') === '1' ? -alt : alt; g.altRef = 'MSL'; }
        else {
          const abs = xmpNum(xmpGet(x, 'drone-dji:AbsoluteAltitude'));
          if (abs !== null) { g.alt = abs; g.altRef = 'MSL'; }
        }
        const dir = xmpNum(xmpGet(x, 'exif:GPSImgDirection'));
        if (dir !== null) { g.heading = normHeading(dir); g.headingRef = /^M/i.test(xmpGet(x, 'exif:GPSImgDirectionRef') || '') ? 'M' : 'T'; }
        const err = xmpNum(xmpGet(x, 'exif:GPSHPositioningError'));
        if (err !== null && err > 0) g.accuracy = err;
        into.gps = g;
      }
    }
    // A drone's camera points where its gimbal does, not where the aircraft is
    // headed, and the gimbal's pitch is the one a straight-down survey shot has.
    const yaw = xmpNum(xmpGet(x, 'drone-dji:GimbalYawDegree'));
    const pitch = xmpNum(xmpGet(x, 'drone-dji:GimbalPitchDegree'));
    if (into.gps && into.gps.heading == null && yaw !== null) { into.gps.heading = normHeading(yaw); into.gps.headingRef = 'T'; }
    if (pitch !== null && into.pitch == null) into.pitch = pitch;
    if (!into.local) {
      const t = xmpLocal(xmpGet(x, 'exif:DateTimeOriginal') || xmpGet(x, 'photoshop:DateCreated') || xmpGet(x, 'xmp:CreateDate'));
      if (t) { into.local = t.local; into.localSource = 'xmp'; if (t.offset) into.offset = t.offset; }
    }
    if (!into.description) {
      const d = xmpGet(x, 'dc:description');
      if (d) into.description = d;
    }
  }

  // Everything a file says about itself, without decoding a pixel — so it
  // works on a HEIC in a browser that cannot draw one.
  function read(buf) {
    const b = bytesOf(buf);
    const out = { format: sniff(b), tiffs: [], xmp: null, width: null, height: null };
    try {
      if (out.format === 'jpeg') walkJpeg(b, out);
      else if (out.format === 'heic' || out.format === 'avif') walkBmff(b, out);
      else if (out.format === 'png') walkPng(b, out);
      else if (out.format === 'webp') walkWebp(b, out);
    } catch (_) { /* a truncated or odd file reads as far as it goes */ }

    const facts = {};
    for (const [s, e] of out.tiffs) {
      try { const t = readTiff(b, s, e); if (t) fromTiff(t, facts); } catch (_) { /* next */ }
    }
    try { fromXmp(out.xmp, facts); } catch (_) { /* no XMP facts */ }

    const width = out.width || facts.exifWidth || null;
    const height = out.height || facts.exifHeight || null;
    const orientation = facts.orientation || 1;
    // What the picture looks like upright: orientations 5–8 turn it a quarter.
    const turned = orientation >= 5;
    const uprightW = turned ? height : width, uprightH = turned ? width : height;

    // The time, and how its zone was known.
    let taken = null;
    if (facts.local) {
      let offset = facts.offset || null, zoneSource = offset ? 'exif' : null;
      if (!offset && facts.gps && facts.gps.utc) {
        const diff = Math.round((localMs(facts.local) - Date.parse(facts.gps.utc)) / 900000) * 15;
        if (Math.abs(diff) <= 14 * 60) { offset = fmtOffset(diff); zoneSource = 'gps-clock'; }
      }
      if (!offset && facts.gps) {
        const z = auZone(facts.gps.lat, facts.gps.lon, facts.local);
        if (z) { offset = z.offset; zoneSource = 'assumed'; }
      }
      taken = { local: facts.local, offset, iso: offset ? utcIso(facts.local, offset) : null,
                source: facts.localSource === 'xmp' ? 'xmp' : 'exif', zoneSource };
    }

    const gps = facts.gps || null;
    return {
      format: out.format,
      width, height, orientation, uprightWidth: uprightW, uprightHeight: uprightH,
      make: facts.make || null, model: facts.model || null, software: facts.software || null, lens: facts.lens || null,
      description: facts.description || null, comment: facts.comment || null,
      hasExif: out.tiffs.length > 0, hasXmp: !!facts.xmp,
      gps,
      pitch: facts.pitch != null ? facts.pitch : null,
      focal35: facts.focal35 || null,
      fov: fovFrom35(facts.focal35, uprightW, uprightH),
      taken,
      modified: facts.modified || null,
    };
  }

  // ── The overlay, as text ───────────────────────────────────────────────────

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compassDeg(word) {
    const i = COMPASS.indexOf(String(word || '').toUpperCase());
    return i < 0 ? null : i * 22.5;
  }
  function compassPoint(deg, points = 16) {
    if (!known(deg)) return '';
    const step = 360 / points;
    const i = Math.round(normHeading(deg) / step) % points;
    return COMPASS[i * (16 / points)];
  }
  function angleDiff(a, b) { const d = Math.abs(normHeading(a) - normHeading(b)); return d > 180 ? 360 - d : d; }

  // The confusions OCR makes on exactly these characters, undone before any
  // pattern is tried: the minus sign and its dashes, the degree sign's lookalikes
  // (and the letter o it becomes after a digit), primes and quotes, ± written
  // out, and a decimal point with a space either side of it.
  function normalise(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/[−‒–—‐‑﹣－]/g, '-')
      .replace(/[º˚°°˚]/g, '°')
      .replace(/[′’‘`´]/g, "'")
      .replace(/[″”“]/g, '"')
      .replace(/\+\s*\/\s*-|\+\s*-(?=\s*\d)/g, '±')
      .replace(/(\d)\s+\.\s*(?=\d)|(\d)\s*\.\s+(?=\d)/g, (m, a, b) => `${a || b}.`)
      .replace(/(\d)\s*[oO*](?=\s*[,;:(]|\s*[NSEWnsew]\b|\s*$|\s+-?\d)/gm, '$1°')
      .replace(/[ \t]+/g, ' ');
  }

  function decimals(s) { const m = /\.(\d+)/.exec(s); return m ? m[1].length : 0; }

  // Every coordinate the text holds, each with how it was written — which is
  // what the vote weighs: a pair with hemisphere letters or labels cannot
  // have its latitude's sign wrong; a bare pair can.
  function coordCandidates(t, opts) {
    const out = [];
    const home = opts && opts.home;
    const add = (lat, lon, kind, at, text, extra = {}) => {
      if (!validPair(lat, lon)) return;
      out.push(Object.assign({ lat, lon, kind, at, text }, extra));
    };
    let m;

    // A signed or bare decimal pair: `-27.554294°, 152.274116°`. On one line —
    // an overlay prints a pair together, and two numbers a line apart are as
    // likely to be the compass ribbon's as a position.
    const pairRe = /(^|[^\d.])(-?[ \t]?\d{1,2}\.\d{2,9})[ \t]*°?[ \t]*([NS](?![a-z]))?[ \t]*[,;/]?[ \t]*(-?[ \t]?\d{1,3}\.\d{2,9})[ \t]*°?[ \t]*([EW](?![a-z]))?/gim;
    while ((m = pairRe.exec(t))) {
      const latS = m[2].replace(/\s/g, ''), lonS = m[4].replace(/\s/g, '');
      const hemi = !!(m[3] || m[5]);
      const dl = decimals(latS), dn = decimals(lonS);
      if (!hemi && (dl < 3 || dn < 3)) continue;
      let lat = parseFloat(latS), lon = parseFloat(lonS);
      if (m[3]) lat = /S/i.test(m[3]) ? -Math.abs(lat) : Math.abs(lat);
      if (m[5]) lon = /W/i.test(m[5]) ? -Math.abs(lon) : Math.abs(lon);
      const extra = { precision: [dl, dn] };
      if (!hemi && !latS.startsWith('-') && home && known(home.lat)) {
        // A latitude with no sign and no letter: the side of the equator the
        // network is on, and the reading says it guessed.
        if (Math.abs(-lat - home.lat) < Math.abs(lat - home.lat)) { lat = -lat; extra.signGuessed = true; }
      }
      add(lat, lon, hemi ? 'hemisphere' : 'decimal', m.index + m[1].length, m[0].slice(m[1].length).trim(), extra);
    }

    // Hemisphere first: `S 27.554294 E 152.274116`.
    const preRe = /\b([NS])[ \t]*(\d{1,2}\.\d{2,9})[ \t]*°?[ \t]*[,;]?[ \t]*([EW])[ \t]*(\d{1,3}\.\d{2,9})[ \t]*°?/gi;
    while ((m = preRe.exec(t))) {
      const lat = parseFloat(m[2]) * (/S/i.test(m[1]) ? -1 : 1), lon = parseFloat(m[4]) * (/W/i.test(m[3]) ? -1 : 1);
      add(lat, lon, 'hemisphere', m.index, m[0], { precision: [decimals(m[2]), decimals(m[4])] });
    }

    // Labelled, in either order and not necessarily side by side.
    const latL = /\blat(?:itude)?\.?\s*[:=]?\s*(-?\d{1,2}\.\d{2,9})\s*°?\s*([NS](?![a-z]))?/i.exec(t);
    const lonL = /\b(?:lon|lng|long|longitude)\.?\s*[:=]?\s*(-?\d{1,3}\.\d{2,9})\s*°?\s*([EW](?![a-z]))?/i.exec(t);
    if (latL && lonL) {
      let lat = parseFloat(latL[1]), lon = parseFloat(lonL[1]);
      if (latL[2]) lat = /S/i.test(latL[2]) ? -Math.abs(lat) : Math.abs(lat);
      if (lonL[2]) lon = /W/i.test(lonL[2]) ? -Math.abs(lon) : Math.abs(lon);
      const extra = { precision: [decimals(latL[1]), decimals(lonL[1])] };
      if (!latL[2] && !latL[1].startsWith('-') && home && known(home.lat) && Math.abs(-lat - home.lat) < Math.abs(lat - home.lat)) {
        lat = -lat; extra.signGuessed = true;
      }
      add(lat, lon, 'labelled', Math.min(latL.index, lonL.index), `${latL[0]} ${lonL[0]}`, extra);
    }

    // Degrees, minutes and seconds — or degrees and decimal minutes — with the
    // hemisphere after or before: `27°33'15.46"S 152°16'26.82"E`.
    const part = '(\\d{1,3})\\s*°\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*\'?\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|\'\')?)?';
    const dmsAfter = new RegExp(`${part}\\s*([NS])\\b[\\s,;]*${part}\\s*([EW])\\b`, 'gi');
    while ((m = dmsAfter.exec(t))) {
      const lat = (+m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0)) * (/S/i.test(m[4]) ? -1 : 1);
      const lon = (+m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0)) * (/W/i.test(m[8]) ? -1 : 1);
      if (+m[2] < 60 && +m[6] < 60 && (!m[3] || +m[3] < 60) && (!m[7] || +m[7] < 60)) add(lat, lon, 'dms', m.index, m[0]);
    }
    const dmsBefore = new RegExp(`\\b([NS])\\s*${part}[\\s,;]*([EW])\\s*${part}`, 'gi');
    while ((m = dmsBefore.exec(t))) {
      const lat = (+m[2] + +m[3] / 60 + (m[4] ? +m[4] / 3600 : 0)) * (/S/i.test(m[1]) ? -1 : 1);
      const lon = (+m[6] + +m[7] / 60 + (m[8] ? +m[8] / 3600 : 0)) * (/W/i.test(m[5]) ? -1 : 1);
      if (+m[3] < 60 && +m[7] < 60) add(lat, lon, 'dms', m.index, m[0]);
    }

    // A grid reference: MGA or UTM, zone, easting, northing. Australia is south
    // of the equator, and a band letter south of N says so too.
    const gridRes = [
      /\b(?:MGA|UTM|GDA)?\s*(?:94|2020)?\s*(?:zone)?\s*(?<!\d)(4[89]|5[0-7])(?!\d)\s*([C-HJ-NP-X])?\s*[,:]?\s*(?:E|mE|Easting)\s*[:=]?\s*(\d{6}(?:\.\d+)?)\s*m?\s*[,;]?\s*(?:N|mN|Northing)\s*[:=]?\s*(\d{7}(?:\.\d+)?)/gi,
      /\b(4[89]|5[0-7])\s*([C-HJ-NP-X])\s+(\d{6}(?:\.\d+)?)\s*m?\s*E?\s+(\d{7}(?:\.\d+)?)\s*m?\s*N?\b/g,
    ];
    for (const re of gridRes) {
      while ((m = re.exec(t))) {
        const zone = +m[1], band = (m[2] || '').toUpperCase();
        const south = band ? band < 'N' : true;
        const ll = utmToLatLon(zone, parseFloat(m[3]), parseFloat(m[4]), south);
        if (ll) add(ll.lat, ll.lon, 'grid', m.index, m[0], { grid: { zone, band: band || null, e: parseFloat(m[3]), n: parseFloat(m[4]) } });
      }
    }

    // A latitude that lost its decimal point to the OCR, beside a longitude
    // that kept its own: `-27554300°,152.274115°`. Put back after two digits
    // where that gives the same precision as the longitude — and weighed as
    // the repair it is.
    const lostRe = /(^|[^\d.])(-?)(\d{2})(\d{3,8})\s*°\s*[,;]\s*(-?\d{1,3}\.(\d{3,9}))\s*°/g;
    while ((m = lostRe.exec(t))) {
      if (m[4].length !== m[6].length) continue;
      const lat = parseFloat(`${m[2]}${m[3]}.${m[4]}`), lon = parseFloat(m[5]);
      add(lat, lon, 'repaired', m.index + m[1].length, m[0].slice(m[1].length), { precision: [m[4].length, m[6].length], repaired: true });
    }

    return out;
  }

  // A heading: degrees with a compass word that agrees with them (`242°SW (T)`,
  // `46°NE`), or degrees after a label (`Heading: 242°`). A latitude followed
  // by S is not a heading, because 27.5° is nowhere near south — which is the
  // whole reason the word has to agree. Unlabelled, it needs its degree sign or
  // its (T)/(M), and it has to be on one line: a compass ribbon prints bare
  // numbers under its letters, and `300` over `NW` is not a heading. (T) is
  // also read as (1), (l) or (I), which is what the OCR makes of it.
  function headingCandidates(t) {
    const out = [];
    let m;
    const wordRe = /(^|[^\d.])(\d{1,3}(?:\.\d)?)[ \t]*(°)?[ \t]*(NNE|NNW|SSE|SSW|ENE|ESE|WNW|WSW|NE|NW|SE|SW|N|E|S|W)\b[ \t]*(?:\([ \t]*([TMtm1lI|])[ \t]*\)?|\b(true|mag(?:netic)?)\b)?/g;
    while ((m = wordRe.exec(t))) {
      const deg = parseFloat(m[2]);
      if (!(deg >= 0 && deg <= 360)) continue;
      const want = compassDeg(m[4]);
      if (want === null || angleDiff(deg, want) > 33.75) continue;
      const r = (m[5] || m[6] || '').toUpperCase();
      if (!m[3] && !r) continue;
      out.push({ heading: normHeading(deg), ref: /^M/.test(r) ? 'M' : (r ? 'T' : null), word: m[4], at: m.index + m[1].length, text: m[0].slice(m[1].length).trim() });
    }
    const labelRe = /\b(?:heading|hdg|bearing|brg|direction|dir|azimuth|azi|az|facing|course|compass)[ \t]*[:=]?[ \t]*(\d{1,3}(?:\.\d+)?)[ \t]*°?[ \t]*(NNE|NNW|SSE|SSW|ENE|ESE|WNW|WSW|NE|NW|SE|SW|N|E|S|W)?\b[ \t]*(?:\(?[ \t]*(T|M|true|mag(?:netic)?)[ \t]*\)?)?/gi;
    while ((m = labelRe.exec(t))) {
      const deg = parseFloat(m[1]);
      if (!(deg >= 0 && deg <= 360)) continue;
      if (m[2] && angleDiff(deg, compassDeg(m[2])) > 33.75) continue;
      out.push({ heading: normHeading(deg), ref: m[3] ? (/^M/i.test(m[3]) ? 'M' : 'T') : null, word: m[2] || null, at: m.index, text: m[0], labelled: true });
    }
    return out;
  }

  function accuracyCandidates(t, coords) {
    const out = [];
    let m;
    const re = /±\s*(\d{1,5}(?:\.\d+)?)\s*m\b|\b(?:acc(?:uracy)?|h?err(?:or)?|hacc|epe|precision)\s*[:=]?\s*[±+]?\s*(\d{1,5}(?:\.\d+)?)\s*m\b/gi;
    while ((m = re.exec(t))) out.push({ accuracy: parseFloat(m[1] || m[2]), at: m.index });
    // `+4m` straight after a coordinate: the ± the OCR read as a plus.
    for (const c of coords) {
      const tail = t.slice(c.at + c.text.length, c.at + c.text.length + 12);
      const p = /^\s*[+±]\s*(\d{1,5}(?:\.\d+)?)\s*m\b/.exec(tail);
      if (p) out.push({ accuracy: parseFloat(p[1]), at: c.at + c.text.length });
    }
    return out.filter(a => a.accuracy > 0 && a.accuracy <= 10000);
  }

  const ALT_DATUM = { HAE: 'HAE', ELL: 'HAE', ELLIPSOID: 'HAE', WGS84: 'HAE', 'WGS-84': 'HAE', MSL: 'MSL', AMSL: 'MSL', ASL: 'MSL', EGM96: 'MSL', 'EGM-96': 'MSL', AHD: 'AHD' };
  function altitudeCandidates(t) {
    const out = [];
    let m;
    const datum = '(?:\\(?\\s*(HAE|ELL(?:IPSOID)?|WGS-?84|MSL|AMSL|ASL|EGM-?96|AHD)\\s*\\)?)';
    const labelled = new RegExp(`(?:\\balt(?:itude)?|\\belev(?:ation)?|\\bheight|\\bhgt|▲|△)\\.?\\s*[:=]?\\s*(-?\\d{1,5}(?:\\.\\d+)?)\\s*(m|ft)\\b\\s*${datum}?`, 'gi');
    while ((m = labelled.exec(t))) {
      const v = parseFloat(m[1]) * (m[2].toLowerCase() === 'ft' ? 0.3048 : 1);
      out.push({ altitude: v, ref: m[3] ? ALT_DATUM[m[3].toUpperCase().replace(/^ELL.*/, 'ELL')] || null : null, at: m.index });
    }
    const dated = new RegExp(`(^|[^\\d.])(-?\\d{1,5}(?:\\.\\d+)?)\\s*(m|ft)\\s*${datum}`, 'gi');
    while ((m = dated.exec(t))) {
      const v = parseFloat(m[2]) * (m[3].toLowerCase() === 'ft' ? 0.3048 : 1);
      out.push({ altitude: v, ref: ALT_DATUM[m[4].toUpperCase().replace(/^ELL.*/, 'ELL')] || null, at: m.index + m[1].length });
    }
    return out.filter(a => a.altitude > -500 && a.altitude < 9000);
  }

  // Zones by the names Australian overlays print, and the forms a numeric one
  // takes. An abbreviation outside this list is not guessed at.
  const ZONES = { AEST: '+10:00', AEDT: '+11:00', ACST: '+09:30', ACDT: '+10:30', AWST: '+08:00', AWDT: '+09:00',
                  NZST: '+12:00', NZDT: '+13:00', UTC: '+00:00', GMT: '+00:00', Z: '+00:00' };
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function zoneOffset(z) {
    if (!z) return null;
    const s = z.replace(/[()\s]/g, '').toUpperCase();
    if (ZONES[s]) return ZONES[s];
    const m = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
    if (!m || +m[2] > 14) return null;
    return `${m[1]}${pad(+m[2])}:${pad(+(m[3] || 0))}`;
  }
  function timeCandidates(t) {
    const out = [];
    const TIME = '(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:\\s*([aApP])\\.?\\s*[mM]\\.?)?';
    const ZONE = '(?:\\s*\\(?\\s*(AEST|AEDT|ACST|ACDT|AWST|AWDT|NZST|NZDT|(?:GMT|UTC)\\s*[+-]\\s*\\d{1,2}(?::?\\d{2})?|UTC|GMT|Z|[+-]\\d{2}:?\\d{2})\\b\\s*\\)?)?';
    const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)[a-z]*\\.?';
    const push = (Y, M, D, h, mi, s, ap, z, at, text, ambiguous) => {
      Y = +Y; M = +M; D = +D; h = +h; mi = +mi; s = +(s || 0);
      if (ap) { if (h < 1 || h > 12) return; h = (h % 12) + (/p/i.test(ap) ? 12 : 0); }
      if (Y < 1990 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || s > 59) return;
      const local = `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
      const offset = zoneOffset(z);
      out.push({ local, offset, zone: z ? z.replace(/[()\s]/g, '').toUpperCase() : null, at, text, ambiguous: !!ambiguous });
    };
    let m;
    const ymd = new RegExp(`(\\d{4})[-/.:](\\d{1,2})[-/.:](\\d{1,2})[,\\sT]+(?:at\\s+)?${TIME}${ZONE}`, 'g');
    while ((m = ymd.exec(t))) push(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m.index, m[0]);
    const dmy = new RegExp(`(^|[^\\d])(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})[,\\s]+(?:at\\s+)?${TIME}${ZONE}`, 'g');
    while ((m = dmy.exec(t))) {
      let d = +m[2], mo = +m[3], amb = false;
      // Day first, as an Australian overlay writes it, unless the numbers say
      // otherwise; a date both ways round is flagged.
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      else if (d <= 12 && mo <= 12 && d !== mo) amb = true;
      push(m[4], mo, d, m[5], m[6], m[7], m[8], m[9], m.index + m[1].length, m[0].slice(m[1].length), amb);
    }
    const dMonY = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})[,\\s]+(?:at\\s+)?${TIME}${ZONE}`, 'gi');
    while ((m = dMonY.exec(t))) push(m[3], MONTHS[m[2].toLowerCase()], m[1], m[4], m[5], m[6], m[7], m[8], m.index, m[0]);
    const monDY = new RegExp(`${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})[,\\s]+(?:at\\s+)?${TIME}${ZONE}`, 'gi');
    while ((m = monDY.exec(t))) push(m[3], MONTHS[m[1].toLowerCase()], m[2], m[4], m[5], m[6], m[7], m[8], m.index, m[0]);
    return out;
  }

  // One reading of an overlay: everything the text holds, as candidates. The
  // vote below is what turns several of these into an answer.
  function parseOverlay(text, opts = {}) {
    const t = normalise(text);
    const coords = coordCandidates(t, opts);
    return {
      text: t,
      coords,
      headings: headingCandidates(t),
      accuracies: accuracyCandidates(t, coords),
      altitudes: altitudeCandidates(t),
      times: timeCandidates(t),
    };
  }

  // Several readings, one answer — each field chosen by how many readings
  // agree on it, then by how it was written.
  function vote(readings, opts = {}) {
    const parsed = readings.map(r => (typeof r === 'string' ? parseOverlay(r, opts) : (r && r.coords ? r : parseOverlay(r && r.text, opts))));
    const home = opts.home;

    // Positions, pooled about a metre apart.
    const pools = [];
    parsed.forEach((p, i) => {
      for (const c of p.coords) {
        let pool = pools.find(x => Math.abs(x.lat - c.lat) < 1.2e-5 && Math.abs(x.lon - c.lon) < 1.2e-5);
        if (!pool) { pool = { lat: c.lat, lon: c.lon, readings: new Set(), items: [] }; pools.push(pool); }
        pool.readings.add(i);
        pool.items.push(c);
      }
    });
    let coords = null;
    if (pools.length) {
      const score = pool => {
        const votes = [...pool.readings].reduce((s, i) => s + (pool.items.some(c => !c.repaired && parsed[i].coords.includes(c)) ? 1 : 0.5), 0);
        const best = pool.items.find(c => !c.repaired) || pool.items[0];
        let s = votes * 10;
        if (best.precision && best.precision[0] === best.precision[1]) s += 3;
        if (best.precision && Math.abs(best.precision[0] - best.precision[1]) > 1) s -= 4;
        if (best.kind === 'hemisphere' || best.kind === 'labelled' || best.kind === 'dms' || best.kind === 'grid') s += 2;
        if (best.signGuessed) s -= 1;
        if (home && known(home.lat) && known(home.lon)) {
          const km = Math.hypot((pool.lat - home.lat) * 111, (pool.lon - home.lon) * 111 * Math.cos(home.lat * Math.PI / 180));
          if (km < (home.km || 3000)) s += 1;
        }
        return { s, votes, best };
      };
      const ranked = pools.map(p => Object.assign(p, score(p))).sort((a, b) => b.s - a.s);
      const top = ranked[0], best = top.best;
      const precisionOk = !best.precision || best.precision[0] === best.precision[1];
      coords = {
        lat: best.lat, lon: best.lon, kind: best.kind, text: best.text,
        votes: top.votes, readings: parsed.length,
        confidence: top.votes >= 2 ? 'high' : (precisionOk && !best.signGuessed && !best.repaired ? 'medium' : 'low'),
        signGuessed: !!best.signGuessed, grid: best.grid || null,
        rivals: ranked.slice(1, 3).map(r => ({ lat: r.lat, lon: r.lon, votes: r.votes })),
      };
    }

    // The same for the other fields: pooled where they agree, the pool more
    // readings are in wins, and from it the fullest item — the reading that
    // also caught the (T), the datum or the zone.
    const tally = (list, eq, rich) => {
      const pools2 = [];
      list.forEach(({ item, i }) => {
        let pool = pools2.find(p => eq(p.items[0], item));
        if (!pool) { pool = { items: [], readings: new Set() }; pools2.push(pool); }
        pool.items.push(item);
        pool.readings.add(i);
      });
      const richest = p => p.items.reduce((a, b) => (rich(b) > rich(a) ? b : a));
      pools2.sort((a, b) => b.readings.size - a.readings.size || rich(richest(b)) - rich(richest(a)));
      return pools2.length ? Object.assign({}, richest(pools2[0]), { votes: pools2[0].readings.size }) : null;
    };
    const all = key => parsed.flatMap((p, i) => p[key].map(item => ({ item, i })));

    const heading = tally(all('headings'), (a, b) => angleDiff(a.heading, b.heading) < 0.6,
      h => (h.labelled ? 2 : 0) + (h.ref ? 1 : 0));
    const accuracy = tally(all('accuracies'), (a, b) => a.accuracy === b.accuracy, () => 0);
    const altitude = tally(all('altitudes'), (a, b) => Math.abs(a.altitude - b.altitude) < 0.6 && (a.ref === b.ref || !a.ref || !b.ref),
      a => (a.ref ? 1 : 0));
    const time = tally(all('times'), (a, b) => a.local === b.local && (a.offset === b.offset || !a.offset || !b.offset),
      x => (x.offset ? 2 : 0) + (x.ambiguous ? 0 : 1));

    return { coords, heading, accuracy, altitude, time, readings: parsed.length };
  }

  // ── Grid references ────────────────────────────────────────────────────────
  // Transverse Mercator to latitude and longitude, by Krüger's series to the
  // third order (Karney 2011) — millimetres across a zone. GRS80, which is
  // MGA's ellipsoid and WGS84's to a tenth of a millimetre at this scale.
  function utmToLatLon(zone, E, N, south) {
    if (!(zone >= 1 && zone <= 60) || !known(E) || !known(N)) return null;
    const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
    const n = f / (2 - f), n2 = n * n, n3 = n2 * n;
    const A = a / (1 + n) * (1 + n2 / 4 + n2 * n2 / 64);
    const xi = (N - (south ? 10000000 : 0)) / (k0 * A);
    const eta = (E - 500000) / (k0 * A);
    const beta = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96, n2 / 48 + n3 / 15, 17 * n3 / 480];
    let xi1 = xi, eta1 = eta;
    for (let j = 1; j <= 3; j++) {
      xi1  -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
    const delta = [2 * n - 2 * n2 / 3 - 2 * n3, 7 * n2 / 3 - 8 * n3 / 5, 56 * n3 / 15];
    let phi = chi;
    for (let j = 1; j <= 3; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
    const lon0 = zone * 6 - 183;
    const lat = phi * 180 / Math.PI;
    const lon = lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI;
    return validPair(lat, lon) ? { lat, lon } : null;
  }

  // ── OCR: the plan, and the pixels ──────────────────────────────────────────
  // Host-agnostic: these work on RGBA arrays, which a browser gets out of a
  // canvas and the Dropbox sync out of a JPEG decoder.

  // Where to look, and at what size to read it.
  function bandPlan(width, height) {
    return BANDS.map(b => {
      const y0 = Math.floor(b.y0 * height), y1 = Math.ceil(b.y1 * height);
      const scale = Math.min(OCR_MAX_W / width, Math.max(1, OCR_MIN_W / width), 4);
      return { name: b.name, x: 0, y: y0, w: width, h: y1 - y0,
               outW: Math.max(1, Math.round(width * scale)), outH: Math.max(1, Math.round((y1 - y0) * scale)) };
    });
  }

  function hsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max / 255];
  }

  // A band's readable versions: grey with its contrast stretched (dark text on
  // a light bar, or light on dark — the engine inverts for itself), its one
  // dominant saturated hue keyed to black on white (coloured text straight on
  // the photograph), and its bright neutrals keyed the same way (white text).
  // A key that would be most of the band is a sky or a bar, not text, and is
  // not offered.
  //
  // The grey version carries `bar`: the share of the band's rows that are
  // mostly one tone. A field camera's info bar is a run of such rows, and a
  // photograph almost never is — so a band with a bar is read grey first, and
  // one without is read grey last, if at all: two seconds of the engine
  // reading tree bark as letters is the most expensive nothing there is.
  function prepare(px) {
    const { data, width: w, height: h } = px;
    const n = w * h;
    const lum = new Uint8Array(n);
    const hist = new Uint32Array(256);
    const hues = new Uint32Array(36);
    let white = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const y = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      lum[i] = y; hist[y]++;
      if ((i & 1) === 0) {
        const [hh, s, v] = hsv(r, g, b);
        if (s > 0.7 && v > 0.7) hues[Math.floor(hh / 10) % 36]++;
        if (s < 0.18 && v > 0.86) white++;
      }
    }
    // Stretch between the 1st and 99th percentiles.
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    const grey = new Uint8Array(n);
    for (let i = 0; i < n; i++) grey[i] = Math.max(0, Math.min(255, Math.round((lum[i] - lo) * 255 / span)));
    // Rows that are mostly one tone: two-thirds of the row within 18 levels of
    // its own middle value.
    let flat = 0;
    const rowHist = new Uint32Array(64);
    for (let y = 0; y < h; y++) {
      rowHist.fill(0);
      const base = y * w;
      for (let x = 0; x < w; x += 2) rowHist[lum[base + x] >> 2]++;
      let peak = 0, at = 0;
      for (let k = 0; k < 64; k++) if (rowHist[k] > peak) { peak = rowHist[k]; at = k; }
      let near = 0;
      for (let k = Math.max(0, at - 4); k <= Math.min(63, at + 4); k++) near += rowHist[k];
      if (near >= (w / 2) * 0.66) flat++;
    }
    const out = [{ variant: 'grey', gray: grey, width: w, height: h, bar: h ? flat / h : 0 }];

    const half = n / 2;
    let bestHue = -1, bestCount = 0;
    for (let i = 0; i < 36; i++) if (hues[i] > bestCount) { bestCount = hues[i]; bestHue = i; }
    if (bestHue >= 0 && bestCount > half * 0.002 && bestCount < half * 0.15) {
      const centre = bestHue * 10 + 5;
      const key = new Uint8Array(n).fill(255);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const [hh, s, v] = hsv(data[p], data[p + 1], data[p + 2]);
        if (s > 0.55 && v > 0.55 && angleDiff(hh, centre) < 25) key[i] = 0;
      }
      out.push({ variant: `key-${centre}`, gray: key, width: w, height: h });
    }
    if (white > half * 0.003 && white < half * 0.15) {
      const key = new Uint8Array(n).fill(255);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const [, s, v] = hsv(data[p], data[p + 1], data[p + 2]);
        if (s < 0.2 && v > 0.84) key[i] = 0;
      }
      out.push({ variant: 'white', gray: key, width: w, height: h });
    }
    return out;
  }

  // An RGBA box filter: the band at the size it is read at. Only for the
  // Node host — a browser has drawImage, which does this better and in C.
  function resample(src, sw, sh, rect, ow, oh) {
    const out = new Uint8ClampedArray(ow * oh * 4);
    const fx = rect.w / ow, fy = rect.h / oh;
    for (let y = 0; y < oh; y++) {
      const y0 = rect.y + y * fy, y1 = Math.min(rect.y + rect.h, y0 + Math.max(1, fy));
      for (let x = 0; x < ow; x++) {
        const x0 = rect.x + x * fx, x1 = Math.min(rect.x + rect.w, x0 + Math.max(1, fx));
        let r = 0, g = 0, b = 0, a = 0, c = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < sh; yy++) {
          for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < sw; xx++) {
            const p = (yy * sw + xx) * 4;
            r += src[p]; g += src[p + 1]; b += src[p + 2]; a += src[p + 3]; c++;
          }
        }
        const q = (y * ow + x) * 4;
        if (c) { out[q] = r / c; out[q + 1] = g / c; out[q + 2] = b / c; out[q + 3] = a / c; }
      }
    }
    return { data: out, width: ow, height: oh };
  }

  // Turn decoded pixels upright by their EXIF orientation — the Node host
  // decodes raw scanlines, which a browser would already have turned.
  function orient(src, w, h, o) {
    if (!o || o === 1) return { data: src, width: w, height: h };
    const turned = o >= 5;
    const W = turned ? h : w, H = turned ? w : h;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let X, Y;
        switch (o) {
          case 2: X = w - 1 - x; Y = y; break;
          case 3: X = w - 1 - x; Y = h - 1 - y; break;
          case 4: X = x; Y = h - 1 - y; break;
          case 5: X = y; Y = x; break;
          case 6: X = h - 1 - y; Y = x; break;
          case 7: X = h - 1 - y; Y = w - 1 - x; break;
          case 8: X = y; Y = w - 1 - x; break;
          default: X = x; Y = y;
        }
        const s = (y * w + x) * 4, d = (Y * W + X) * 4;
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
      }
    }
    return { data: out, width: W, height: H };
  }

  // One line of a prepared band, cut out with a margin: what a position is
  // confirmed on. The engine reads a single line (mode 7) far more surely than
  // a band with a compass ribbon over it.
  function cropLine(v, box) {
    const padY = Math.round((box.y1 - box.y0) * 0.35) + 4, padX = 12;
    const x0 = Math.max(0, box.x0 - padX), x1 = Math.min(v.width, box.x1 + padX);
    const y0 = Math.max(0, box.y0 - padY), y1 = Math.min(v.height, box.y1 + padY);
    const w = x1 - x0, h = y1 - y0;
    if (w < 8 || h < 8) return null;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) gray.set(v.gray.subarray((y0 + y) * v.width + x0, (y0 + y) * v.width + x1), y * w);
    return { variant: `${v.variant}-line`, gray, width: w, height: h };
  }

  // The engine's lines, flattened out of Tesseract.js's block tree.
  function linesOf(data) {
    const out = [];
    for (const b of (data && data.blocks) || []) {
      for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push({ text: l.text || '', bbox: l.bbox });
    }
    return out;
  }

  // Read a picture's overlay. The host supplies `width`, `height`, `pixels(band)`
  // → RGBA at the band's out size, and `recognize(variant, psm)` → the text, or
  // `{ text, lines: [{ text, bbox }] }` where it can say where each line was.
  //
  //   1. The bands that have a bar are read grey, and every band's coloured
  //      text keyed out of it, in one block (mode 6).
  //   2. A position is read again the moment it is first seen, before it is
  //      believed: on the one line it was found on, as a single line (mode 7),
  //      and if that does not settle it, as a raw line (mode 13) and then the
  //      whole band in the other two modes. Two readings that agree carry it.
  //   3. Only if a position or a time is still missing, the rest: white text,
  //      then the grey of a band with no bar.
  //
  // Stops as soon as a position two readings agree on and a time are both in
  // hand. Measured on the two Solocator photos: four passes each, 1.4 s and
  // 4.8 s under Node, both positions carried by two readings. Every reading's
  // text comes back with the answer, because what the OCR saw is part of the
  // record.
  async function readOverlay(host, opts = {}) {
    const plan = bandPlan(host.width, host.height);
    const budget = opts.maxPasses || OCR_MAX_PASSES;
    const readings = [];
    const variants = new Map();          // band name → prepared variants
    let answer = vote([], opts);
    let passes = 0;

    const run = async (band, v, psm) => {
      if (!v || passes >= budget) return null;
      passes++;
      let got = null;
      try { got = await host.recognize(v, psm); } catch (err) { got = null; }
      const text = typeof got === 'string' ? got : String((got && got.text) || '');
      const lines = got && typeof got === 'object' && Array.isArray(got.lines) ? got.lines : [];
      readings.push({ band: band.name, variant: v.variant, psm, text, lines, v });
      answer = vote(readings.map(r => r.text), opts);
      if (opts.onPass) { try { opts.onPass(passes, answer); } catch (_) { /* a progress line is not worth a failure */ } }
      return text;
    };
    const settled = () => answer.coords && answer.coords.votes >= 2 && answer.time;

    for (const band of plan) {
      let px = null;
      try { px = await host.pixels(band); } catch (_) { px = null; }
      variants.set(band.name, px ? prepare(px) : []);
    }

    // 2, which 1 and 3 call.
    const confirm = async () => {
      if (!answer.coords || answer.coords.votes >= 2) return;
      const want = answer.coords;
      const src = readings.find(r => parseOverlay(r.text, opts).coords.some(c => Math.abs(c.lat - want.lat) < 1.2e-5 && Math.abs(c.lon - want.lon) < 1.2e-5));
      if (!src) return;
      const band = plan.find(b => b.name === src.band);
      const digits = String(Math.abs(want.lat)).replace('.', '').slice(0, 4);
      const line = src.lines.find(l => l.bbox && normalise(l.text).replace(/\D/g, '').includes(digits))
                || src.lines.find(l => l.bbox && parseOverlay(l.text, opts).coords.length);
      const cut = line ? cropLine(src.v, line.bbox) : null;
      for (const [v, psm] of [[cut, '7'], [cut, '13'], [src.v, '3'], [src.v, '11']]) {
        if (!v || (answer.coords && answer.coords.votes >= 2)) continue;
        await run(band, v, psm);
      }
    };

    // 1.
    const white = [], flat = [];
    for (const band of plan) {
      for (const v of variants.get(band.name)) {
        if (v.variant === 'white') { white.push([band, v]); continue; }
        if (v.variant === 'grey' && !(v.bar >= 0.25)) { flat.push([band, v]); continue; }
        if (settled()) break;
        await run(band, v, '6');
        await confirm();
      }
    }

    // 3.
    for (const [band, v] of white.concat(flat)) {
      if (answer.coords && answer.time) break;
      await run(band, v, '6');
      await confirm();
    }
    return Object.assign({}, answer, {
      passes,
      texts: readings.map(r => ({ band: r.band, variant: r.variant, psm: r.psm, text: r.text })),
    });
  }

  // ── Labels: the whole frame, for the equipment in it ───────────────────────
  // What photo-equipment.js reads a make, a model and a serial number out of.
  // The overlay's bands are the wrong place to look — a logger's label is in
  // the middle of the cabinet — and the overlay's votes are the wrong shape:
  // there is no one answer that two readings have to agree on, only whatever
  // text each part of the picture holds. So this reads regions, not bands,
  // hands back every reading's text, and decides nothing.

  // The whole frame, long edge LABEL_WHOLE_W, and four quarters that overlap
  // by LABEL_OVERLAP, each at its own resolution between LABEL_TILE_MIN and
  // LABEL_TILE_MAX wide.
  function labelPlan(width, height) {
    const out = [];
    const whole = Math.min(3, LABEL_WHOLE_W / Math.max(width, height));
    out.push({ name: 'whole', x: 0, y: 0, w: width, h: height,
               outW: Math.max(1, Math.round(width * whole)), outH: Math.max(1, Math.round(height * whole)) });
    const span = 0.5 + LABEL_OVERLAP;
    for (const [ry, rx, name] of [[0, 0, 'top left'], [0, 1, 'top right'], [1, 0, 'bottom left'], [1, 1, 'bottom right']]) {
      const x = Math.floor(rx ? width * (1 - span) : 0), y = Math.floor(ry ? height * (1 - span) : 0);
      const w = Math.ceil(width * span), h = Math.ceil(height * span);
      const s = w > LABEL_TILE_MAX ? LABEL_TILE_MAX / w : w < LABEL_TILE_MIN ? Math.min(3, LABEL_TILE_MIN / w) : 1;
      out.push({ name, x, y, w: Math.min(w, width - x), h: Math.min(h, height - y),
                 outW: Math.max(1, Math.round(Math.min(w, width - x) * s)), outH: Math.max(1, Math.round(Math.min(h, height - y) * s)) });
    }
    return out;
  }

  // Grey with its contrast stretched between the 1st and 99th percentiles —
  // prepare()'s first variant, alone: a label is dark print on a light plate
  // or the reverse, the engine inverts for itself, and the coloured-text keys
  // prepare() also makes are for an overlay drawn on a photograph.
  function greyStretch(px) {
    const { data, width: w, height: h } = px;
    const n = w * h;
    const lum = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const y = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 | 0;
      lum[i] = y; hist[y]++;
    }
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) lum[i] = Math.max(0, Math.min(255, Math.round((lum[i] - lo) * 255 / span)));
    return { variant: 'grey', gray: lum, width: w, height: h };
  }

  // Read every region of a picture for text. The host is readOverlay()'s:
  // `width`, `height`, `pixels(region)` → RGBA at the region's out size, and
  // `recognize(variant, psm)` → the text. Sparse-text mode (11) first — a
  // cabinet is a scatter of labels, not a page — over the whole frame and the
  // four quarters, then the whole frame again as a page (3) if the budget
  // allows. One region's pixels at a time.
  //
  // → { passes, texts: [{ region, variant, psm, text }] }
  async function readLabels(host, opts = {}) {
    const plan = labelPlan(host.width, host.height);
    const budget = Math.max(1, Math.min(opts.maxPasses || LABEL_PASSES, LABEL_PASSES));
    const order = plan.map(r => [r, '11']).concat([[plan[0], '3']]);
    const total = Math.min(budget, order.length);
    const texts = [];
    let passes = 0;
    for (const [region, psm] of order) {
      if (passes >= budget) break;
      let px = null;
      try { px = await host.pixels(region); } catch (_) { px = null; }
      if (!px) continue;
      const v = greyStretch(px);
      px = null;
      passes++;
      let got = null;
      try { got = await host.recognize(v, psm); } catch (_) { got = null; }
      texts.push({ region: region.name, variant: v.variant, psm, text: typeof got === 'string' ? got : String((got && got.text) || '') });
      if (opts.onPass) { try { opts.onPass(passes, total); } catch (_) { /* a progress line is not worth a failure */ } }
    }
    return { passes, texts };
  }

  // ── The browser's OCR host ─────────────────────────────────────────────────
  // Tesseract.js, loaded by a script element on first use (a UMD build, like
  // MapLibre's), and one worker for the session, kept while there is work and
  // let go after a quiet minute — it holds ~100 MB of WebAssembly heap.
  //
  // One worker, and two things that may ask it at once — the queue reading an
  // overlay while somebody reads a photo's labels — each of which sets the
  // page segmentation mode and then recognises. Interleaved, one would read in
  // the other's mode. So each set-then-read is one turn, taken in order.

  let libP = null, workerP = null, idleTimer = 0, busy = 0;
  let turn = Promise.resolve();
  function inTurn(fn) {
    const p = turn.then(() => fn());
    turn = p.catch(() => {});
    return p;
  }
  function loadTesseract() {
    if (typeof window === 'undefined') return Promise.reject(new Error('no browser here'));
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (libP) return libP;
    libP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCR_LIB;
      s.async = true;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('the OCR library loaded but defined nothing')));
      s.onerror = () => { libP = null; reject(new Error('the OCR library could not be fetched (unpkg.com)')); };
      document.head.appendChild(s);
    });
    return libP;
  }
  function worker() {
    if (workerP) return workerP;
    workerP = loadTesseract().then(T => T.createWorker('eng', 1, {
      workerPath: OCR_WORKER, corePath: OCR_CORE, langPath: OCR_LANG, gzip: true,
    })).catch(err => { workerP = null; throw err; });
    return workerP;
  }
  function releaseSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (busy || !workerP) return;
      const p = workerP; workerP = null;
      p.then(w => w.terminate()).catch(() => {});
    }, 60000);
  }

  // The host readOverlay() and readLabels() ask for pixels and for text: a
  // canvas to cut a region out of something a canvas can draw, and the one
  // worker, in turn. `params` are set with the page segmentation mode, each
  // turn.
  function canvasHost(w, img, width, height, params = {}) {
    return {
      width, height,
      pixels(band) {
        const cv = document.createElement('canvas');
        cv.width = band.outW; cv.height = band.outH;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, band.x, band.y, band.w, band.h, 0, 0, band.outW, band.outH);
        const id = cx.getImageData(0, 0, band.outW, band.outH);
        return { data: id.data, width: id.width, height: id.height };
      },
      async recognize(v, psm) {
        const cv = document.createElement('canvas');
        cv.width = v.width; cv.height = v.height;
        const cx = cv.getContext('2d');
        const id = cx.createImageData(v.width, v.height);
        for (let i = 0, p = 0; i < v.gray.length; i++, p += 4) {
          id.data[p] = id.data[p + 1] = id.data[p + 2] = v.gray[i]; id.data[p + 3] = 255;
        }
        cx.putImageData(id, 0, 0);
        return inTurn(async () => {
          await w.setParameters(Object.assign({ tessedit_pageseg_mode: String(psm) }, params));
          const r = await w.recognize(cv, {}, { text: true, blocks: true });
          return r && r.data ? { text: r.data.text || '', lines: linesOf(r.data) } : '';
        });
      },
    };
  }

  // Read the overlay off something a canvas can draw — an ImageBitmap, an
  // <img> or a canvas — `width` × `height` upright.
  async function ocrImage(img, width, height, opts = {}) {
    busy++;
    clearTimeout(idleTimer);
    try {
      return await readOverlay(canvasHost(await worker(), img, width, height), opts);
    } finally {
      busy--;
      releaseSoon();
    }
  }

  // Read the labels off one: every region's text, for PhotoEquipment.parse().
  // Seconds a photo — which is why it runs when somebody asks, never on
  // every upload.
  //
  // The modes a label is read in (11 and 3) analyse the page's layout, and
  // Tesseract narrates that — "Estimating resolution as 812", "Detected 32
  // diacritics" — on stderr, which its WebAssembly build writes to the
  // browser's console as errors. Its `debug_file` sends that narration to the
  // engine's own /dev/null instead: a console full of an engine talking to
  // itself is one where the next real error is not seen.
  async function ocrLabels(img, width, height, opts = {}) {
    busy++;
    clearTimeout(idleTimer);
    try {
      return await readLabels(canvasHost(await worker(), img, width, height, { debug_file: '/dev/null' }), opts);
    } finally {
      busy--;
      releaseSoon();
    }
  }

  // ── What a photo says, reconciled ──────────────────────────────────────────
  // The file's own facts first, the overlay's where the file is silent — the
  // order in the header — as one reading both hosts upload from. `meta` is
  // read()'s answer, `ocr` readOverlay()'s or null.
  function needsOcr(meta) {
    if (!(meta && meta.gps && meta.taken)) return true;
    return !known(meta.gps.accuracy) && printsAccuracy(meta);
  }

  // A camera app that prints the fix's ± on the picture and leaves it out of
  // the EXIF it writes, by the Software tag it signs the file with. Solocator
  // does both — its GPS block has the position, altitude and heading and no
  // GPSHPositioningError, and its overlay reads `±13m` — so a photo it took is
  // read for that one number. An app is added here when a photo of its shows
  // the same gap; a phone's own camera writes the ± into the file.
  const PRINTS_ACCURACY = /\bsolocator\b/i;
  function printsAccuracy(meta) { return !!meta && PRINTS_ACCURACY.test(String(meta.software || '')); }

  // The ± an overlay printed, for a position that came from somewhere else —
  // the file, or the database for a photo already stored. Taken only when the
  // overlay's own position, where it could be read, is the same fix: within
  // ACC_SAME_FIX_M, which forgives a misread last digit and nothing more. An
  // overlay that printed somewhere else printed that place's ±. Null for no ±.
  const ACC_SAME_FIX_M = 50;
  function overlayAccuracy(ocr, pos) {
    const a = ocr && ocr.accuracy;
    if (!a || !known(a.accuracy) || !(a.accuracy > 0)) return null;
    const c = ocr.coords;
    if (c && pos && known(pos.lat) && known(pos.lon)) {
      const dy = (c.lat - pos.lat) * 110574;
      const dx = (c.lon - pos.lon) * 111320 * Math.cos(pos.lat * Math.PI / 180);
      if (Math.hypot(dx, dy) > ACC_SAME_FIX_M) return null;
    }
    return a.accuracy;
  }

  function reconcile(meta, ocr) {
    const out = { pos: null, heading: null, altitude: null, taken: null, pitch: null, fov: null, ocr: null };
    const g = meta && meta.gps;
    if (g) {
      out.pos = { lat: g.lat, lon: g.lon, placement: g.source === 'exif' ? 'exif' : 'xmp',
                  accuracy: known(g.accuracy) ? g.accuracy : null };
      if (known(g.heading)) out.heading = { deg: g.heading, ref: g.headingRef || 'T' };
      if (known(g.alt)) out.altitude = { m: g.alt, ref: g.altRef || 'MSL' };
    }
    if (meta && known(meta.pitch)) out.pitch = meta.pitch;
    if (meta && known(meta.fov)) out.fov = meta.fov;
    if (meta && meta.taken) {
      out.taken = { local: meta.taken.local, iso: meta.taken.iso, source: meta.taken.source === 'xmp' ? 'xmp' : 'exif',
                    zone: meta.taken.zoneSource || null };
    }
    if (ocr) {
      out.ocr = {
        confidence: ocr.coords ? ocr.coords.confidence : null, votes: ocr.coords ? ocr.coords.votes : 0,
        kind: ocr.coords ? ocr.coords.kind : null, passes: ocr.passes || 0,
        signGuessed: ocr.coords ? !!ocr.coords.signGuessed : false,
        texts: (ocr.texts || []).map(t => ({ band: t.band, variant: t.variant, psm: t.psm, text: String(t.text || '').slice(0, 600) })),
      };
      if (!out.pos && ocr.coords) {
        out.pos = { lat: ocr.coords.lat, lon: ocr.coords.lon, placement: 'ocr',
                    accuracy: ocr.accuracy ? ocr.accuracy.accuracy : null, confidence: ocr.coords.confidence };
        if (!out.heading && ocr.heading) out.heading = { deg: ocr.heading.heading, ref: ocr.heading.ref || 'T' };
        if (!out.altitude && ocr.altitude) out.altitude = { m: ocr.altitude.altitude, ref: ocr.altitude.ref || null };
      }
      if (!out.taken && ocr.time) {
        let offset = ocr.time.offset, zone = offset ? 'printed' : null;
        if (!offset && out.pos) {
          const z = auZone(out.pos.lat, out.pos.lon, ocr.time.local);
          if (z) { offset = z.offset; zone = 'assumed'; }
        }
        out.taken = { local: ocr.time.local, iso: offset ? utcIso(ocr.time.local, offset) : null, source: 'ocr', zone };
      }
      // The file placed it and said nothing of the ±; the overlay may have.
      if (out.pos && out.pos.placement !== 'ocr' && !known(out.pos.accuracy)) {
        const acc = overlayAccuracy(ocr, out.pos);
        if (acc !== null) { out.pos.accuracy = acc; out.pos.accuracySource = 'ocr'; }
      }
    }
    return out;
  }

  // What the database is told about a photo (meganet.add_field_photo's
  // p_photo), less the object paths and what the stored bytes are, which only
  // the host that uploaded them knows. `r` is reconcile()'s reading plus the
  // file's name, size and type, its pixel size, and any hand edits.
  function record(r) {
    const m = r.meta || {};
    const p = {
      title: String(r.name || '').slice(0, 300), caption: r.caption || '',
      width: r.width || null, height: r.height || null,
      meta: {
        file: { format: m.format || null, exif: !!m.hasExif, xmp: !!m.hasXmp, size: r.size || null, type: r.type || null },
        camera: { make: m.make || null, model: m.model || null, software: m.software || null, lens: m.lens || null },
      },
    };
    if (r.converted) p.meta.converted = { from: r.type || 'image/heic', bytes: r.size || null };
    if (m.description) p.meta.description = String(m.description).slice(0, 500);
    if (m.comment) p.meta.comment = String(m.comment).slice(0, 500);
    if (m.gps && m.gps.datum) p.meta.gps = { datum: m.gps.datum, utc: m.gps.utc || null };
    if (r.ocr) p.meta.ocr = r.ocr;
    if (r.taken) {
      p.taken_local = r.taken.local || null;
      p.taken_at = r.taken.iso || null;
      p.taken_source = r.taken.source;
      p.meta.taken = { zone_source: r.taken.zone || null };
    }
    if (r.pos) {
      p.lat = +Number(r.pos.lat).toFixed(7);
      p.lon = +Number(r.pos.lon).toFixed(7);
      p.placement = r.pos.placement;
      if (known(r.pos.accuracy)) p.accuracy_m = r.pos.accuracy;
      if (known(r.pos.accuracy) && r.pos.accuracySource === 'ocr') p.meta.accuracy = { source: 'ocr' };
    }
    if (r.heading && known(r.heading.deg)) { p.heading_deg = +(normHeading(r.heading.deg)).toFixed(2) % 360; p.heading_ref = r.heading.ref || 'T'; }
    if (r.altitude && known(r.altitude.m)) { p.altitude_m = r.altitude.m; if (r.altitude.ref) p.altitude_ref = r.altitude.ref; }
    if (known(r.pitch)) p.pitch_deg = Math.max(-90, Math.min(90, r.pitch));
    if (known(r.fov)) p.fov_deg = +Math.max(1, Math.min(180, r.fov)).toFixed(1);
    return p;
  }

  // PGM: the simplest image the engine's decoder reads, so a Node host can
  // hand it a prepared band without an encoder of its own.
  function pgm(v) {
    const head = `P5\n${v.width} ${v.height}\n255\n`;
    const out = new Uint8Array(head.length + v.gray.length);
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
    out.set(v.gray, head.length);
    return out;
  }

  return {
    read, parseOverlay, vote, readOverlay, ocrImage, needsOcr, printsAccuracy, overlayAccuracy, reconcile, record,
    readLabels, ocrLabels, labelPlan, greyStretch,
    utmToLatLon, auZone, compassPoint, fovFrom35, instant: utcIso,
    bandPlan, prepare, resample, orient, pgm, normalise, linesOf, cropLine,
    OCR: { lib: OCR_LIB, worker: OCR_WORKER, core: OCR_CORE, lang: OCR_LANG, version: OCR_VER },
  };
})();

// The Dropbox sync is Node and require()s this same file — see the header — so
// a photo is read the same way whichever door it came in by. Guarded so the
// browser, where `module` is undefined, never runs it; constrains nothing below.
if (typeof module !== 'undefined' && module.exports) module.exports = PhotoMeta;
