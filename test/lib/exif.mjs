// Photos with metadata in them, built byte by byte (the Field Photos checks).
//
// photo-meta.js reads EXIF out of four containers, and the only honest test of
// a reader is a file whose every byte the test put there — the twin check's
// GeoTIFF is built the same way, for the same reason. So: a TIFF (which is what
// EXIF is) with IFD0, the Exif IFD and the GPS IFD, in either byte order; and
// the four ways a photo carries one — a JPEG's APP1, a HEIC's Exif item
// (located by `iloc`, in the file or in `idat`), a PNG's eXIf chunk and a
// WebP's EXIF chunk — plus an XMP packet for the fields that live there.
//
// Shared by test/photos.mjs and tools/field-photos/test/, which is why it is a
// lib: two copies of a byte-level fixture are two things that drift, and the
// half that drifts is always the one nobody is looking at.

import zlib from 'node:zlib';

// ── TIFF ──────────────────────────────────────────────────────────────────────
// An entry is [tag, type, values]. Types: 1 BYTE, 2 ASCII (a string), 3 SHORT,
// 4 LONG, 5 RATIONAL ([num, den] pairs), 7 UNDEFINED (a Buffer), 10 SRATIONAL.

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

function encodeValue(type, v, le) {
  if (type === 2) return Buffer.from(`${v}\0`, 'latin1');
  if (type === 7) return Buffer.from(v);
  if (type === 1) return Buffer.from(v);
  const list = type === 5 || type === 10 ? v : v;
  const b = Buffer.alloc(list.length * SIZE[type]);
  list.forEach((x, i) => {
    if (type === 3) le ? b.writeUInt16LE(x, i * 2) : b.writeUInt16BE(x, i * 2);
    else if (type === 4) le ? b.writeUInt32LE(x, i * 4) : b.writeUInt32BE(x, i * 4);
    else if (type === 5) {
      le ? b.writeUInt32LE(x[0], i * 8) : b.writeUInt32BE(x[0], i * 8);
      le ? b.writeUInt32LE(x[1], i * 8 + 4) : b.writeUInt32BE(x[1], i * 8 + 4);
    } else if (type === 10) {
      le ? b.writeInt32LE(x[0], i * 8) : b.writeInt32BE(x[0], i * 8);
      le ? b.writeInt32LE(x[1], i * 8 + 4) : b.writeInt32BE(x[1], i * 8 + 4);
    }
  });
  return b;
}

function countOf(type, v) {
  if (type === 2) return Buffer.byteLength(`${v}\0`, 'latin1');
  return type === 7 || type === 1 ? v.length : v.length;
}

// Three IFDs laid end to end after the header, pointers filled in — the shape
// every camera writes, minus the thumbnail IFD nobody here reads.
export function tiff({ le = true, ifd0 = [], exif = [], gps = [] } = {}) {
  const u16 = (b, o, v) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (b, o, v) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const blocks = [];
  const plan = [
    { name: 'ifd0', entries: [...ifd0] },
    { name: 'exif', entries: [...exif] },
    { name: 'gps', entries: [...gps] },
  ].filter(p => p.name === 'ifd0' || p.entries.length);
  const ifd0Plan = plan[0];
  if (plan.some(p => p.name === 'exif')) ifd0Plan.entries.push([0x8769, 4, [0]]);
  if (plan.some(p => p.name === 'gps'))  ifd0Plan.entries.push([0x8825, 4, [0]]);
  for (const p of plan) p.entries.sort((a, b) => a[0] - b[0]);

  // Offsets: header (8), then each IFD followed by its out-of-line values.
  let at = 8;
  for (const p of plan) {
    p.at = at;
    const head = 2 + p.entries.length * 12 + 4;
    let ext = 0;
    for (const [, type, v] of p.entries) {
      const n = countOf(type, v) * SIZE[type];
      if (n > 4) ext += n + (n & 1);
    }
    p.size = head + ext;
    at += p.size;
  }
  const buf = Buffer.alloc(at);
  buf.write(le ? 'II' : 'MM', 0, 'latin1');
  u16(buf, 2, 42);
  u32(buf, 4, plan[0].at);
  const where = Object.fromEntries(plan.map(p => [p.name, p.at]));
  for (const p of plan) {
    let o = p.at;
    u16(buf, o, p.entries.length); o += 2;
    let ext = p.at + 2 + p.entries.length * 12 + 4;
    for (const [tag, type, v0] of p.entries) {
      let v = v0;
      if (tag === 0x8769) v = [where.exif];
      if (tag === 0x8825) v = [where.gps];
      const bytes = encodeValue(type, v, le);
      u16(buf, o, tag); u16(buf, o + 2, type); u32(buf, o + 4, countOf(type, v));
      if (bytes.length <= 4) bytes.copy(buf, o + 8);
      else { u32(buf, o + 8, ext); bytes.copy(buf, ext); ext += bytes.length + (bytes.length & 1); }
      o += 12;
    }
    u32(buf, o, 0);
  }
  return buf;
}

// A coordinate as EXIF writes it: degrees, minutes and seconds as rationals.
export function dmsRationals(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a), mFull = (a - d) * 60, m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
}

// The GPS IFD for a position and whatever else is given.
export function gpsEntries({ lat, lon, alt, altRef = 0, heading, headingRef = 'T', accuracy, date, time, datum } = {}) {
  const e = [[0x0000, 1, Buffer.from([2, 3, 0, 0])]];
  if (isFinite(lat)) { e.push([0x0001, 2, lat < 0 ? 'S' : 'N']); e.push([0x0002, 5, dmsRationals(lat)]); }
  if (isFinite(lon)) { e.push([0x0003, 2, lon < 0 ? 'W' : 'E']); e.push([0x0004, 5, dmsRationals(lon)]); }
  if (isFinite(alt)) { e.push([0x0005, 1, Buffer.from([altRef])]); e.push([0x0006, 5, [[Math.round(alt * 100), 100]]]); }
  if (time) e.push([0x0007, 5, time.map(x => [Math.round(x * 100), 100])]);
  if (datum) e.push([0x0012, 2, datum]);
  if (isFinite(heading)) { e.push([0x0010, 2, headingRef]); e.push([0x0011, 5, [[Math.round(heading * 100), 100]]]); }
  if (date) e.push([0x001d, 2, date]);
  if (isFinite(accuracy)) e.push([0x001f, 5, [[Math.round(accuracy * 100), 100]]]);
  return e;
}

// ── Containers ────────────────────────────────────────────────────────────────

// APP1 "Exif\0\0" + TIFF, spliced in after the JPEG's SOI (and APP0, if any) —
// where a camera puts it. `xmp` adds an APP1 XMP packet the same way.
export function jpegWith(jpeg, { tiff: t = null, xmp = null } = {}) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  const segs = [];
  const seg = (payload) => {
    const b = Buffer.alloc(4);
    b[0] = 0xff; b[1] = 0xe1; b.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([b, payload]);
  };
  if (t) segs.push(seg(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])));
  if (xmp) segs.push(seg(Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xmp, 'utf8')])));
  return Buffer.concat([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}

// A minimal JPEG's worth of markers for a reader that never decodes pixels:
// SOI, a baseline SOF0 with the size, EOI.
export function jpegShell(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
                           0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function box(type, ...parts) {
  const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 255) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
}
const u16be = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32be = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };

// A HEIC as far as a metadata reader goes: ftyp, a meta box whose item table
// names an Exif item (and optionally an XMP one) and an image, iloc saying
// where each is — in the file (construction method 0) or in idat (method 1,
// `inIdat`) — ispe for the size, and the bytes in mdat.
export function heicWith({ tiff: t, width = 4032, height = 3024, inIdat = false, xmp = null }) {
  const exifPayload = Buffer.concat([u32be(6), Buffer.from('Exif\0\0', 'latin1'), t]);
  const xmpPayload = xmp ? Buffer.from(xmp, 'utf8') : null;
  const infe = (id, type, name, contentType) => fullBox('infe', 2, 0, u16be(id), u16be(0), Buffer.from(type, 'latin1'),
    Buffer.from(`${name}\0`, 'utf8'), contentType ? Buffer.from(`${contentType}\0`, 'utf8') : Buffer.alloc(0));
  const items = [infe(1, 'hvc1', 'Image'), infe(2, 'Exif', 'Exif')];
  if (xmpPayload) items.push(infe(3, 'mime', 'XMP', 'application/rdf+xml'));
  const iinf = fullBox('iinf', 0, 0, u16be(items.length), ...items);
  const ispe = fullBox('ispe', 0, 0, u32be(width), u32be(height));
  const iprp = box('iprp', box('ipco', ispe));
  const hdlr = fullBox('hdlr', 0, 0, u32be(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from('\0'));
  const pitm = fullBox('pitm', 0, 0, u16be(1));

  // iloc v1: offset_size 4, length_size 4, base_offset_size 0, index_size 0.
  const build = (offsets) => {
    const entries = [];
    const entry = (id, method, off, len) => Buffer.concat([u16be(id), u16be(method), u16be(0), u16be(1), u32be(off), u32be(len)]);
    entries.push(entry(1, 0, offsets.image, 4));
    entries.push(entry(2, inIdat ? 1 : 0, offsets.exif, exifPayload.length));
    if (xmpPayload) entries.push(entry(3, 0, offsets.xmp, xmpPayload.length));
    const iloc = fullBox('iloc', 1, 0, Buffer.from([0x44, 0x00]), u16be(entries.length), ...entries);
    const idat = inIdat ? box('idat', exifPayload) : Buffer.alloc(0);
    const meta = fullBox('meta', 0, 0, hdlr, pitm, iloc, iinf, iprp, idat);
    const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32be(0), Buffer.from('mif1heic', 'latin1'));
    const mdatBody = Buffer.concat([Buffer.from([0, 0, 0, 0]), inIdat ? Buffer.alloc(0) : exifPayload, xmpPayload || Buffer.alloc(0)]);
    const mdat = box('mdat', mdatBody);
    return { ftyp, meta, mdat };
  };
  // Two passes: the second knows where mdat's bytes land.
  let parts = build({ image: 0, exif: 0, xmp: 0 });
  const mdatAt = parts.ftyp.length + parts.meta.length + 8;
  parts = build({
    image: mdatAt,
    exif: inIdat ? 0 : mdatAt + 4,
    xmp: mdatAt + 4 + (inIdat ? 0 : exifPayload.length),
  });
  return Buffer.concat([parts.ftyp, parts.meta, parts.mdat]);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// A tiny real PNG (a grey square) with an eXIf chunk, which PNG 1.5 allows
// before or after the image data — put after it here, the harder place.
export function pngWith({ tiff: t, width = 8, height = 6, xmp = null }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 128);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw))];
  if (t) chunks.push(pngChunk('eXIf', t));
  if (xmp) chunks.push(pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(xmp, 'utf8')])));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

// A WebP with VP8X (the size) and an EXIF chunk — the extended format a camera
// app writes when it keeps metadata.
export function webpWith({ tiff: t, width = 1600, height = 1200 }) {
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;                                   // the EXIF flag
  vp8x.writeUIntLE(width - 1, 4, 3); vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), chunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]))]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// An XMP packet with whatever attributes are given, as a camera writes them.
export function xmpPacket(attrs) {
  const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join('\n   ');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"
   ${a}/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}
