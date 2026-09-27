// A GeoTIFF exactly as the State's elevation service writes one, and the
// aspect snap its exportImage applies — for a check that stands the Digital
// Twin on ground it chose.
//
// twin.mjs grew these first and keeps its own copy (the same practice as
// lib/terrarium.mjs: the existing caller is load-bearing and is left alone);
// this is the one anything new imports. The format is ArcGIS exportImage's for
// pixelType=F32: one band of little-endian floats, no compression, 128 × 128
// tiles padded to the full tile, GDAL's NoData tag, and the two GeoTIFF tags
// that say where the pixels are — ModelPixelScale (33550) and ModelTiepoint
// (33922) — which the app checks against its request.

export function tiffF32(W, H, extent, valueAt, { empty = false } = {}) {
  const TW = 128, TH = 128;
  const ntx = Math.ceil(W / TW), nty = Math.ceil(H / TH), nt = ntx * nty;
  const tileBytes = TW * TH * 4;
  const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
  const bytesFor = (type, val) => {
    if (type === 2) return val;
    const size = type === 3 ? 2 : type === 4 ? 4 : 8;
    const b = Buffer.alloc(val.length * size);
    val.forEach((v, i) => (type === 3 ? b.writeUInt16LE(v, i * size)
                         : type === 4 ? b.writeUInt32LE(v, i * size) : b.writeDoubleLE(v, i * size)));
    return b;
  };
  // Tags ascending, as TIFF requires. The tile offsets are filled in once the
  // data's position is known; their size is known now.
  const entries = [
    [256, 3, [W]], [257, 3, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]],
    [277, 3, [1]], [284, 3, [1]], [322, 3, [TW]], [323, 3, [TH]],
    [324, 4, new Array(nt).fill(0)], [325, 4, new Array(nt).fill(0)], [339, 3, [3]],
    [33550, 12, [pw, ph, 0]], [33922, 12, [0, 0, 0, extent[0], extent[3], 0]],
    [42113, 2, Buffer.from('-9999\0', 'latin1')],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extAt = 8 + ifdSize;
  let extSize = 0;
  for (const [, type, val] of entries) { const n = bytesFor(type, val).length; if (n > 4) extSize += n; }
  const dataAt = extAt + extSize;
  for (let t = 0; t < nt; t++) {
    entries[9][2][t]  = empty ? 0 : dataAt + t * tileBytes;
    entries[10][2][t] = empty ? 0 : tileBytes;
  }
  const buf = Buffer.alloc(dataAt + (empty ? 0 : nt * tileBytes));
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(8, 4);
  let p = 8;
  buf.writeUInt16LE(entries.length, p); p += 2;
  let ext = extAt;
  for (const [tag, type, val] of entries) {
    const bytes = bytesFor(type, val);
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(val.length, p + 4);
    if (bytes.length <= 4) bytes.copy(buf, p + 8);
    else { buf.writeUInt32LE(ext, p + 8); bytes.copy(buf, ext); ext += bytes.length; }
    p += 12;
  }
  buf.writeUInt32LE(0, p);
  if (!empty) {
    for (let t = 0; t < nt; t++) {
      const tx = t % ntx, ty = Math.floor(t / ntx);
      const base = dataAt + t * tileBytes;
      for (let r = 0; r < TH; r++) {
        for (let c = 0; c < TW; c++) {
          const x = tx * TW + c, y = ty * TH + r;
          buf.writeFloatLE(x < W && y < H ? valueAt(x, y) : 0, base + (r * TW + c) * 4);
        }
      }
    }
  }
  return buf;
}

// What an ArcGIS ImageServer does to a request box unless told not to
// (`adjustAspectRatio=false`): it keeps the centre and makes the pixels square
// in the image's own units, widening whichever axis is the shorter per pixel.
// Measured live on the State's service: a 402 m box at Brisbane, square in
// metres and so 1/cos(lat) narrower in degrees of longitude, came back 450 m
// north to south. A request box that is square in metres is *not* square in
// degrees, so the snap is the trap the app has to step round, and the fake
// service sets it exactly as the real one does.
export function snapExtent(bbox, W, H, adjust) {
  if (adjust === 'false') return bbox.slice();
  const pix = Math.max((bbox[2] - bbox[0]) / W, (bbox[3] - bbox[1]) / H);
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  return [cx - pix * W / 2, cy - pix * H / 2, cx + pix * W / 2, cy + pix * H / 2];
}
