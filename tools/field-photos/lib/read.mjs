// tools/field-photos/lib/read.mjs — one photo's bytes in, a reading out:
// where and when it was taken and how that was known, a thumbnail, and the
// bytes to store.
//
// The rules are photo-meta.js's — the same file the browser runs on the Field
// Photos tab, required here rather than copied, so a photo is placed the same
// way whichever door it came in by. What is this file's own is only what a
// browser gets for free: decoding the pixels (jpeg-js, pngjs, heic-decode),
// turning them upright, scaling them, and running the OCR engine over a band.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PhotoMeta = require(path.join(HERE, '..', '..', '..', 'photo-meta.js'));

export const THUMB_PX = 480;
const JPEG_LIMITS = { useTArray: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 250 };

// What each container is stored as. A HEIC is converted to a JPEG, because a
// photo stored as something Chrome cannot draw is a photo half the crew cannot
// see; WebP is stored as it came (every browser draws it) but, with no decoder
// here, gets neither a thumbnail nor an OCR reading.
const STORED = {
  jpeg: { contentType: 'image/jpeg', ext: 'jpg' },
  png:  { contentType: 'image/png',  ext: 'png' },
  webp: { contentType: 'image/webp', ext: 'webp' },
  heic: { contentType: 'image/jpeg', ext: 'jpg', convert: true },
  avif: null,
};

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The pixels, upright, as RGBA. null where there is no decoder for the format.
export async function decode(buf, meta) {
  if (meta.format === 'jpeg') {
    const img = jpeg.decode(buf, JPEG_LIMITS);
    return PhotoMeta.orient(img.data, img.width, img.height, meta.orientation);
  }
  if (meta.format === 'png') {
    const png = PNG.sync.read(buf);
    return PhotoMeta.orient(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
                            png.width, png.height, meta.orientation);
  }
  if (meta.format === 'heic') {
    // libheif applies the container's own rotation and mirror (irot/imir),
    // which is where a HEIC keeps them — so no second turn here.
    const { default: heicDecode } = await import('heic-decode');
    const img = await heicDecode({ buffer: buf });
    return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height };
  }
  return null;
}

export function encodeJpeg(px, quality) {
  return jpeg.encode({ data: px.data, width: px.width, height: px.height }, quality).data;
}

export function thumbnail(px) {
  const s = Math.min(1, THUMB_PX / Math.max(px.width, px.height));
  const w = Math.max(1, Math.round(px.width * s)), h = Math.max(1, Math.round(px.height * s));
  const small = PhotoMeta.resample(px.data, px.width, px.height, { x: 0, y: 0, w: px.width, h: px.height }, w, h);
  return encodeJpeg(small, 80);
}

// The OCR host for PhotoMeta.readOverlay: bands of the decoded picture, and a
// Tesseract.js worker reading a prepared band handed over as a PGM.
export function ocrHost(px, worker) {
  return {
    width: px.width,
    height: px.height,
    pixels: band => PhotoMeta.resample(px.data, px.width, px.height, band, band.outW, band.outH),
    async recognize(v, psm) {
      await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
      const r = await worker.recognize(Buffer.from(PhotoMeta.pgm(v)), {}, { text: true, blocks: true });
      return { text: r.data.text || '', lines: PhotoMeta.linesOf(r.data) };
    },
  };
}

// One photo, read. `ocr` is a Tesseract.js worker, or null to skip the overlay
// (the tests' fast path, and a machine with no engine). Throws with a sentence
// when the photo cannot be stored at all.
export async function readPhoto(buf, { name, worker, home } = {}) {
  const meta = PhotoMeta.read(buf);
  const stored = STORED[meta.format];
  if (!stored) throw new Error(`${meta.format === 'unknown' ? 'not a photo this can read' : `${meta.format.toUpperCase()} is not stored`} (${name})`);

  let px = null;
  try { px = await decode(buf, meta); }
  catch (err) { px = null; if (stored.convert) throw new Error(`the ${meta.format.toUpperCase()} could not be decoded — ${(err && err.message) || err}`); }

  let ocr = null, ocrError = null;
  if (px && worker && PhotoMeta.needsOcr(meta)) {
    try { ocr = await PhotoMeta.readOverlay(ocrHost(px, worker), { home }); }
    catch (err) { ocrError = (err && err.message) || String(err); }
  }
  const got = PhotoMeta.reconcile(meta, ocr);

  const upload = stored.convert ? encodeJpeg(px, 90) : buf;
  return {
    sha: sha256(buf),
    meta,
    ...got,
    ocrError,
    width: px ? px.width : meta.uprightWidth || meta.width || null,
    height: px ? px.height : meta.uprightHeight || meta.height || null,
    thumb: px ? thumbnail(px) : null,
    upload,
    contentType: stored.contentType,
    ext: stored.ext,
    converted: !!stored.convert,
    size: buf.length,
    name,
  };
}
