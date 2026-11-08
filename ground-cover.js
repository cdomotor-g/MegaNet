// MegaNet — ground-cover.js
//
//   GroundCover   how tall the trees are round a place, read from Meta and
//                 WRI's Canopy Height Maps v2 (CHMv2), and the trees stood on
//                 it — a trunk and a crown for every tree top, as GeoJSON a
//                 MapLibre fill-extrusion layer draws as it is (the ⛰️ 3-D
//                 view, #278).
//
// Load order: none. The IIFE body only declares — no request, no timer, no
// DOM — and everything it reaches for (fetch, DecompressionStream, Blob,
// Response) is a browser global looked up at call time, so its position among
// the modules is free (`npm run toplevel`). Node 22 has every one of them,
// which is how the files were checked (see "Checked against the real files").
//
// ── The files ────────────────────────────────────────────────────────────────
//
// docs/ground-cover-sources.md ("Trees", "Recommendation") has the research.
// One cloud-optimised GeoTIFF per zoom-10 map square (quadkey of 10 digits
// 0–3), on Meta's S3 bucket, which refuses cross-site reads — so the app reads
// them through its own Worker, `/api/canopy/<quadkey>.tif` (worker/canopy.js),
// one byte range at a time. What is inside, as read off the files themselves
// (Beechmont 3112130033, the Gold Coast 3112130122, Goondiwindi 3112121211):
//
//   - classic TIFF, little-endian (not BigTIFF — read here all the same), the
//     GDAL COG layout: header and IFDs first, then the blocks;
//   - EPSG:3857 (Web Mercator), 32,768 × 32,768 pixels of 1.1943 m — exactly
//     one zoom-10 square, so the pixel grid is the same across every file and
//     a box that straddles two files is read without a seam;
//   - one band, 8-bit unsigned, whole metres; 512 × 512 blocks, deflate
//     (zlib-wrapped, compression 8), no predictor;
//   - overviews at 2.39, 4.78, 9.55, 19.1, 38.2 and 76.4 m (16,384 down to 512
//     pixels across);
//   - no NoData value: GDAL masks ride along (interleaved 1-bit blocks), and
//     where a mask says "no reading" (the open sea at the coast) the height is
//     already 0, so the masks are never read. 0 means no tree, or nothing known;
//     a square with no file at all (open sea) answers 404 and reads as 0 too.
//
// The reader is general rather than tuned to those numbers: BigTIFF, strips as
// well as tiles, predictor 2, 16-bit and float samples, raw deflate as well as
// zlib, EPSG:4326 as well as 3857, and the GDAL_NODATA tag are all handled, so
// a re-cut of the files does not quietly break the trees.
//
// ── Reading a box ────────────────────────────────────────────────────────────
//
// canopy(box, metresPerPx) works out the quadkeys the box touches, reads each
// file's header once (16 KB, then 64 KB more only if the IFDs run further, as
// they do in some of the files) and keeps it, picks the coarsest level that is
// still at least as fine as asked, reads that level's block table, and fetches
// only the blocks the box overlaps — neighbouring blocks in one request, four
// requests in flight at most. Decoded blocks are kept, most recently used
// first, up to 40 MB. The answer is one grid over the box on the Web Mercator
// pixel grid of the level read, so for these files nothing is resampled: each
// cell is the file's own pixel.
//
// ── Trees ────────────────────────────────────────────────────────────────────
//
// trees(box) reads the canopy at ~1.2 m (2.4 m for a box wider than 1.5 km),
// and stands a tree on each tree top: a local high point of the (lightly
// smoothed) canopy at least 3 m tall, the highest within a window as wide as
// the crown it would carry, so one crown gives one top, and no two tops closer
// than 2 m or most of the taller one's crown. Each tree is two polygons for a
// fill-extrusion: a square trunk from the ground to 35 % of the height, and an
// eight-sided crown from 30 % to the top. The crown is as wide as the patch of
// canopy the top owns — the cells nearer to it than to any other top that
// reach above its crown base — as a circle of the same area, 1.5 to 8 m
// across the radius. The map is smooth, so a closed canopy has few tops; a
// radius from the height alone (0.18 × height + 1 m, which still sets the
// window, the spacing and the trunk) drew a fifth of a forest's canopy and
// left the rest bare between lollipops, this draws three-fifths to
// two-thirds of it. The tallest 6,000 are kept, and the collection's `meta`
// says how many there were. The canopy is read 24 m beyond the box, so a tree
// on the edge is weighed against the neighbours past it, and two boxes side by
// side stand the same trees along their shared edge.
//
// ── API ──────────────────────────────────────────────────────────────────────
//
//   canopy(box, metresPerPx)  → Promise<{ w, h, data: Uint8Array (metres, row
//       by row from the north-west; 0 = no tree or nothing known), box (the
//       grid's own edges, snapped out to whole cells), mpp (ground metres per
//       cell), level, res (EPSG:3857 metres per cell), quadkeys, missing
//       (quadkeys with no file), published (the files' date, 'YYYY-MM-DD') }>
//   trees(box)                → Promise<GeoJSON FeatureCollection>; each tree a
//       trunk and a crown Polygon, properties { kind: 'trunk'|'crown', base,
//       top, h, r }, and `meta` { trees, found, capped, mpp, minHeight,
//       source, published, attribution, missing }. A box over TREES_MAX_M
//       (3 km, 10 % grace) is refused: ask canopy() at 9.6 m or coarser.
//   setSource(fn)             where a quadkey's file is: fn(qk) → URL; null
//       for /api/canopy/<qk>.tif again. Drops everything kept.
//   quadkeysFor(box), treesFromGrid(grid, opts), parseTiffHeader(buffer),
//   crownRadius(h)            the pure parts, for the checks.
//   stats(), clearCache(), WORDS, ATTRIBUTION, MAX_TREES, TREES_MAX_M.
//
// A box is { west, south, east, north } in degrees (or [w, s, e, n], or a
// MapLibre LngLatBounds). Requests that fail reject; a square with no file
// does not.

const GroundCover = (function () {
  // ── Tunables ───────────────────────────────────────────────────────────────
  const QK_ZOOM = 10;                       // one file per zoom-10 square
  const R = 6378137;                        // Web Mercator's sphere, metres
  const HALF = Math.PI * R;                 // half the world's width in EPSG:3857
  const DEG_M = R * Math.PI / 180;          // EPSG:3857 metres per degree of longitude
  const NOMINAL_RES = 2 * HALF / 2 ** 25;   // 1.1943 m: 32,768 px across a zoom-10 square
  const MAX_LAT = 85.0511287798;
  const HEAD_BYTES = 16384;                 // the first read of a file
  const MORE_BYTES = 65536;                 // each further read, when the IFDs run on
  const MAX_IFDS = 64;
  const MERGE_GAP = 8192;                   // blocks closer than this share a request
  const MERGE_MAX = 4 << 20;                // … up to 4 MB a request
  const PARALLEL = 4;                       // requests in flight at once
  const FETCH_MS = 30000;
  const BLOCK_BYTES = 40 << 20;             // decoded blocks kept
  const FILES_KEPT = 48;                    // file headers kept
  const MAX_FILES = 36;                     // files one box may touch
  const MAX_GRID_PX = 4096 * 4096;          // cells one grid may hold

  const MIN_TREE_M = 3;                     // shorter than this is not a tree here
  const MAX_TREES = 6000;
  const TREES_MAX_M = 3000;                 // the widest box trees() takes (~3 km)
  const FINE_UPTO_M = 1500;                 // wider than this reads the 2.4 m level
  const FINE_MPP = 1.2;
  const COARSE_MPP = 2.4;
  const MIN_SPACING_M = 2;
  const CROWN_MAX_M = 8;
  const TREE_MARGIN_M = 3 * CROWN_MAX_M;    // read round a trees() box

  const ATTRIBUTION = 'Canopy height: Meta and World Resources Institute (WRI), CHMv2, 2026 — '
    + 'source imagery © Vantor (CC BY 4.0)';

  // The words the views that draw these trees put on screen, with what each
  // means there (CLAUDE.md, "Plain words"); a view hands them to termHtml().
  const WORDS = {
    'Tree height': 'How tall the trees are, in whole metres from the ground to the top of the crown, '
      + 'as Meta and WRI’s canopy map estimates it from satellite photos taken between 2010 and 2020 — '
      + 'one reading for every square of about 1.2 m. A tree is drawn on each high point of 3 m or more, '
      + 'its crown as wide as the patch of canopy round that point.',
    'Canopy': 'The tops of the trees taken together — the leafy roof a stand of trees makes. A canopy '
      + 'height of 0 m is open ground, water, a road or a roof: the map does not tell those apart.',
  };

  // ── TIFF ───────────────────────────────────────────────────────────────────
  const TAG = {
    subfile: 254, width: 256, height: 257, bits: 258, compression: 259, photometric: 262,
    stripOffsets: 273, spp: 277, rowsPerStrip: 278, stripCounts: 279, planar: 284,
    predictor: 317, tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileCounts: 325,
    sampleFormat: 339, pixelScale: 33550, tiepoint: 33922, transform: 34264,
    geoKeys: 34735, gdalNodata: 42113,
  };
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

  // A DataView over [off, off + len) of a file, from the chunks of it read so
  // far ([{ off, bytes }]) — only from one chunk that holds all of it, else null.
  function span(chunks, off, len) {
    for (const c of chunks) {
      if (off >= c.off && off + len <= c.off + c.bytes.length) {
        return new DataView(c.bytes.buffer, c.bytes.byteOffset + (off - c.off), len);
      }
    }
    return null;
  }

  function u64(dv, at, little) {
    const lo = dv.getUint32(at + (little ? 0 : 4), little);
    const hi = dv.getUint32(at + (little ? 4 : 0), little);
    return hi * 4294967296 + lo;
  }

  function values(dv, type, count, little) {
    if (type === 2) {
      let s = '';
      for (let i = 0; i < count; i++) {
        const c = dv.getUint8(i);
        if (c) s += String.fromCharCode(c);
      }
      return s;
    }
    const n = TYPE_SIZE[type];
    const out = new Array(count);
    for (let i = 0, at = 0; i < count; i++, at += n) {
      switch (type) {
        case 1: case 7: out[i] = dv.getUint8(at); break;
        case 6: out[i] = dv.getInt8(at); break;
        case 3: out[i] = dv.getUint16(at, little); break;
        case 8: out[i] = dv.getInt16(at, little); break;
        case 4: case 13: out[i] = dv.getUint32(at, little); break;
        case 9: out[i] = dv.getInt32(at, little); break;
        case 5: out[i] = dv.getUint32(at, little) / dv.getUint32(at + 4, little); break;
        case 10: out[i] = dv.getInt32(at, little) / dv.getInt32(at + 4, little); break;
        case 11: out[i] = dv.getFloat32(at, little); break;
        case 12: out[i] = dv.getFloat64(at, little); break;
        case 16: case 18: out[i] = u64(dv, at, little); break;
        case 17: out[i] = Number(dv.getBigInt64(at, little)); break;
        default: out[i] = 0;
      }
    }
    return out;
  }

  // Byte order, classic or BigTIFF, and where the first IFD is.
  function readHead(chunks) {
    const dv = span(chunks, 0, 16);
    if (!dv) throw new Error('canopy file: too short to be a TIFF');
    const order = dv.getUint16(0, false);
    if (order !== 0x4949 && order !== 0x4D4D) throw new Error('canopy file: not a TIFF');
    const little = order === 0x4949;
    const magic = dv.getUint16(2, little);
    if (magic === 42) return { little, big: false, first: dv.getUint32(4, little) };
    if (magic === 43) return { little, big: true, first: u64(dv, 8, little) };
    throw new Error(`canopy file: TIFF version ${magic} is not one this reads`);
  }

  // One IFD at `off`: { ifd } when the bytes are there, { need: [off, len] }
  // when they are not. A value whose bytes are elsewhere and not yet read is
  // kept as { deferred: { type, count, off } }.
  function readIfd(chunks, off, head) {
    const { little, big } = head;
    const cw = big ? 8 : 2, ew = big ? 20 : 12, nw = big ? 8 : 4, inline = big ? 8 : 4;
    const cdv = span(chunks, off, cw);
    if (!cdv) return { need: [off, MORE_BYTES] };
    const n = big ? u64(cdv, 0, little) : cdv.getUint16(0, little);
    if (n > 4096) throw new Error('canopy file: an IFD with too many entries');
    const size = cw + n * ew + nw;
    const dv = span(chunks, off, size);
    if (!dv) return { need: [off, Math.max(size, MORE_BYTES)] };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = cw + i * ew;
      const tag = dv.getUint16(e, little);
      const type = dv.getUint16(e + 2, little);
      const count = big ? u64(dv, e + 4, little) : dv.getUint32(e + 4, little);
      const tsize = TYPE_SIZE[type];
      if (!tsize) continue;                       // a type this reader does not know
      const bytes = tsize * count;
      const at = e + (big ? 12 : 8);
      if (bytes <= inline) {
        tags[tag] = values(new DataView(dv.buffer, dv.byteOffset + at, inline), type, count, little);
      } else {
        const voff = big ? u64(dv, at, little) : dv.getUint32(at, little);
        const vdv = span(chunks, voff, bytes);
        tags[tag] = vdv ? values(vdv, type, count, little) : { deferred: { type, count, off: voff } };
      }
    }
    const next = big ? u64(dv, cw + n * ew, little) : dv.getUint32(cw + n * ew, little);
    return { ifd: { offset: off, next, tags } };
  }

  // Walk the IFD chain as far as the bytes in hand go.
  function walk(chunks, head, from, ifds) {
    let off = from;
    const seen = new Set(ifds.map(d => d.offset));
    while (off && ifds.length < MAX_IFDS) {
      if (seen.has(off)) break;                   // a loop in the chain
      const r = readIfd(chunks, off, head);
      if (r.need) return { ifds, need: r.need };
      seen.add(off);
      ifds.push(r.ifd);
      off = r.ifd.next;
    }
    return { ifds, need: null };
  }

  // Values left { deferred } whose bytes have since been read.
  function fill(chunks, ifds, little) {
    for (const ifd of ifds) {
      for (const tag of Object.keys(ifd.tags)) {
        const d = ifd.tags[tag] && ifd.tags[tag].deferred;
        if (!d) continue;
        const dv = span(chunks, d.off, TYPE_SIZE[d.type] * d.count);
        if (dv) ifd.tags[tag] = values(dv, d.type, d.count, little);
      }
    }
  }

  const one = (v, dflt) => (Array.isArray(v) ? v[0] : v === undefined ? dflt : v);

  // What an IFD is, in words a reader can use.
  function image(ifd) {
    const t = ifd.tags;
    const w = one(t[TAG.width], 0), h = one(t[TAG.height], 0);
    const tiled = t[TAG.tileWidth] !== undefined;
    return {
      offset: ifd.offset,
      w, h,
      tw: tiled ? one(t[TAG.tileWidth]) : w,
      th: tiled ? one(t[TAG.tileHeight]) : Math.min(h, one(t[TAG.rowsPerStrip], h)),
      bits: one(t[TAG.bits], 1),
      format: one(t[TAG.sampleFormat], 1),          // 1 unsigned, 2 signed, 3 float
      compression: one(t[TAG.compression], 1),
      predictor: one(t[TAG.predictor], 1),
      spp: one(t[TAG.spp], 1),
      planar: one(t[TAG.planar], 1),
      mask: (one(t[TAG.subfile], 0) & 4) !== 0 || one(t[TAG.photometric], 1) === 4,
      offsets: tiled ? t[TAG.tileOffsets] : t[TAG.stripOffsets],
      counts: tiled ? t[TAG.tileCounts] : t[TAG.stripCounts],
    };
  }

  // Where the pixels are: CRS, origin and pixel size of the full image.
  function geo(ifd) {
    const t = ifd.tags;
    const keys = {};
    const dir = t[TAG.geoKeys];
    if (Array.isArray(dir)) {
      for (let i = 4; i + 3 < dir.length && i < 4 + dir[3] * 4; i += 4) {
        if (dir[i + 1] === 0) keys[dir[i]] = dir[i + 3];
      }
    }
    const model = keys[1024];                       // 1 projected, 2 geographic
    const raster = keys[1025] || 1;                 // 1 PixelIsArea, 2 PixelIsPoint
    const projected = keys[3072], geographic = keys[2048];
    let crs = null;
    if ([3857, 900913, 3785, 102100, 102113].includes(projected)) crs = 'EPSG:3857';
    else if (projected) crs = `EPSG:${projected}`;
    else if (model === 2 || geographic) crs = !geographic || geographic === 4326 ? 'EPSG:4326' : `EPSG:${geographic}`;
    let sx = null, sy = null, x0 = null, y0 = null;
    const scale = t[TAG.pixelScale], tie = t[TAG.tiepoint], tf = t[TAG.transform];
    if (Array.isArray(scale) && Array.isArray(tie) && tie.length >= 6) {
      sx = scale[0]; sy = scale[1];
      x0 = tie[3] - tie[0] * sx; y0 = tie[4] + tie[1] * sy;
    } else if (Array.isArray(tf) && tf.length >= 16 && !tf[1] && !tf[4]) {
      sx = tf[0]; sy = -tf[5]; x0 = tf[3]; y0 = tf[7];
    }
    if (raster === 2 && sx !== null) { x0 -= sx / 2; y0 += sy / 2; }
    const nd = t[TAG.gdalNodata];
    const nodata = typeof nd === 'string' && nd.trim() !== '' && Number.isFinite(Number(nd)) ? Number(nd) : null;
    return { crs, epsg: crs ? Number(crs.slice(5)) : null, sx, sy, x0, y0, nodata };
  }

  // A TIFF header in a buffer, as far as it goes: byte order, the IFDs, the
  // images among them (full image first, then each overview; masks apart) and
  // where the pixels lie. Values the buffer does not hold stay { deferred }.
  function parseTiffHeader(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const chunks = [{ off: 0, bytes }];
    const head = readHead(chunks);
    const { ifds, need } = walk(chunks, head, head.first, []);
    return summarise(head, ifds, need);
  }

  function summarise(head, ifds, need) {
    const all = ifds.map(image);
    const images = all.filter(d => !d.mask).sort((a, b) => b.w - a.w);
    const masks = all.filter(d => d.mask).sort((a, b) => b.w - a.w);
    const g = ifds.length ? geo(ifds[0]) : null;
    if (g && images.length && g.sx) {
      for (const im of images) {
        im.resX = g.sx * images[0].w / im.w;
        im.resY = g.sy * images[0].h / im.h;
        // EPSG:3857 metres per pixel, the unit the output grid is laid in.
        im.res = g.crs === 'EPSG:3857' ? im.resX : im.resX * DEG_M;
      }
    }
    return {
      littleEndian: head.little, bigTiff: head.big,
      complete: !need, next: need ? need[0] : 0,
      ifds, images, masks, geo: g,
    };
  }

  // ── Fetching ───────────────────────────────────────────────────────────────
  let sourceFn = null;
  const urlFor = qk => (sourceFn ? sourceFn(qk) : `/api/canopy/${qk}.tif`);

  // requestMs adds up every request's time, so parallel requests overlap in it.
  const counters = { requests: 0, bytes: 0, blocks: 0, requestMs: 0 };
  let active = 0;
  const waiting = [];
  function slot() {
    if (active < PARALLEL) { active++; return Promise.resolve(); }
    return new Promise(resolve => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
  function drop(res) {
    try { if (res && res.body) res.body.cancel(); } catch (_) { /* nothing to let go */ }
  }

  // Bytes [start, end] of a file: { bytes, modified } — null when there is no
  // file there (404). A server that ignores Range is refused rather than read:
  // a whole file is hundreds of MB.
  async function getRange(url, start, end) {
    await slot();
    const t0 = Date.now();
    try {
      const opts = { headers: { Range: `bytes=${start}-${end}` } };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(FETCH_MS);
      const res = await fetch(url, opts);
      counters.requests++;
      if (res.status === 404) { drop(res); return null; }
      if (res.status === 416) { drop(res); return { bytes: new Uint8Array(0), modified: null }; }
      let bytes;
      if (res.status === 206) {
        const cr = /bytes\s+(\d+)-/.exec(res.headers.get('Content-Range') || '');
        if (cr && Number(cr[1]) !== start) { drop(res); throw new Error(`canopy: asked for bytes from ${start}, sent from ${cr[1]}`); }
        bytes = new Uint8Array(await res.arrayBuffer());
      } else if (res.status === 200 && res.headers.get('Content-Length') !== null
                 && Number(res.headers.get('Content-Length')) <= (1 << 20)) {
        bytes = new Uint8Array(await res.arrayBuffer()).subarray(start, end + 1);   // a small file, whole
      } else {
        drop(res);
        throw new Error(res.status === 200 ? 'canopy: the source ignored the byte range'
                                           : `canopy: HTTP ${res.status} from ${url}`);
      }
      counters.bytes += bytes.length;
      return { bytes, modified: res.headers.get('Last-Modified') };
    } finally {
      counters.requestMs += Date.now() - t0;
      release();
    }
  }

  // Values left { deferred } — the block tables, the geo tags — read in as
  // few requests as their positions allow.
  async function resolveDeferred(url, head, list) {
    const want = list.filter(x => x && x.v && x.v.deferred).map(x => ({ ...x, d: x.v.deferred }));
    if (!want.length) return;
    want.sort((a, b) => a.d.off - b.d.off);
    const groups = [];
    for (const x of want) {
      const len = TYPE_SIZE[x.d.type] * x.d.count;
      const g = groups[groups.length - 1];
      if (g && x.d.off - g.end <= MERGE_GAP && x.d.off + len - g.start <= MERGE_MAX) {
        g.end = Math.max(g.end, x.d.off + len); g.items.push(x);
      } else groups.push({ start: x.d.off, end: x.d.off + len, items: [x] });
    }
    await Promise.all(groups.map(async g => {
      const got = await getRange(url, g.start, g.end - 1);
      if (!got || got.bytes.length < g.end - g.start) throw new Error('canopy: the file ended inside its own header');
      const chunks = [{ off: g.start, bytes: got.bytes }];
      for (const x of g.items) {
        const len = TYPE_SIZE[x.d.type] * x.d.count;
        x.set(values(span(chunks, x.d.off, len), x.d.type, x.d.count, head.little));
      }
    }));
  }

  // A file's header, read once: null where there is no file (open sea).
  const files = new Map();                        // url → Promise<file|null>
  function openFile(qk) {
    const url = urlFor(qk);
    if (files.has(url)) {
      const p = files.get(url);
      files.delete(url); files.set(url, p);       // most recently used last
      return p;
    }
    const p = readFile(qk, url);
    files.set(url, p);
    p.catch(() => files.delete(url));
    while (files.size > FILES_KEPT) files.delete(files.keys().next().value);
    return p;
  }

  async function readFile(qk, url) {
    const first = await getRange(url, 0, HEAD_BYTES - 1);
    if (!first) return null;
    const chunks = [{ off: 0, bytes: first.bytes }];
    const head = readHead(chunks);
    let r = walk(chunks, head, head.first, []);
    for (let more = 0; r.need && more < 8; more++) {
      const [off, len] = r.need;
      const got = await getRange(url, off, off + len - 1);
      if (!got || !got.bytes.length) break;
      chunks.push({ off, bytes: got.bytes });
      r = walk(chunks, head, off, r.ifds);
    }
    const t0 = r.ifds[0];
    if (!t0) throw new Error(`canopy: no image in ${qk}`);
    fill(chunks, r.ifds, head.little);
    await resolveDeferred(url, head, [TAG.pixelScale, TAG.tiepoint, TAG.geoKeys, TAG.transform, TAG.gdalNodata]
      .map(tag => ({ v: t0.tags[tag], set: v => { t0.tags[tag] = v; } })));
    const info = summarise(head, r.ifds, r.need);
    const g = info.geo;
    if (!g || g.sx === null || !info.images.length) throw new Error(`canopy: ${qk} does not say where its pixels lie`);
    if (g.crs !== 'EPSG:3857' && g.crs !== 'EPSG:4326') throw new Error(`canopy: ${qk} is in ${g.crs || 'an unknown CRS'}`);
    for (const lv of info.images) lv.little = head.little;
    let published = null;
    if (first.modified) {
      const d = new Date(first.modified);
      if (!isNaN(d)) published = d.toISOString().slice(0, 10);
    }
    return { qk, url, head, levels: info.images, geo: g, published };
  }

  // A level's block table (TileOffsets / TileByteCounts), read on first use.
  function tables(file, lv) {
    if (!lv.tablesP) {
      lv.tablesP = resolveDeferred(file.url, file.head, [
        { v: lv.offsets, set: v => { lv.offsets = v; } },
        { v: lv.counts, set: v => { lv.counts = v; } },
      ]).then(() => {
        if (!Array.isArray(lv.offsets) || !Array.isArray(lv.counts)) throw new Error(`canopy: ${file.qk} has no block table`);
      }).catch(err => { lv.tablesP = null; throw err; });
    }
    return lv.tablesP;
  }

  // ── Blocks ─────────────────────────────────────────────────────────────────
  const blocks = new Map();                       // key → Uint8Array (metres)
  const pending = new Map();                      // key → Promise<Uint8Array>
  let blockBytes = 0;
  function cacheGet(key) {
    const v = blocks.get(key);
    if (v) { blocks.delete(key); blocks.set(key, v); }
    return v;
  }
  function cachePut(key, v) {
    if (blocks.has(key)) { blockBytes -= blocks.get(key).length; blocks.delete(key); }
    blocks.set(key, v);
    blockBytes += v.length;
    while (blockBytes > BLOCK_BYTES && blocks.size > 1) {
      const [k, old] = blocks.entries().next().value;
      blocks.delete(k);
      blockBytes -= old.length;
    }
  }

  async function inflateWith(format, bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Deflate as TIFF writers leave it: zlib-wrapped (GDAL, libtiff), or now and
  // then raw. The header says which; the other is tried if it is wrong.
  async function inflate(bytes) {
    const zlib = bytes.length > 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
    try {
      return await inflateWith(zlib ? 'deflate' : 'deflate-raw', bytes);
    } catch (err) {
      try { return await inflateWith(zlib ? 'deflate-raw' : 'deflate', bytes); } catch (_) { throw err; }
    }
  }

  // One block's bytes as it is stored → whole metres, 0..255, 0 = nothing.
  async function decodeBlock(lv, nodata, stored) {
    let raw;
    if (lv.compression === 8 || lv.compression === 32946) raw = await inflate(stored);
    else if (lv.compression === 1) raw = stored;
    else throw new Error(`canopy: compression ${lv.compression} is not one this reads`);
    const { tw, th, bits, format, predictor } = lv;
    const spp = lv.planar === 2 ? 1 : lv.spp;     // planar 2: the first band's blocks come first
    const bps = bits / 8;
    const rowSamples = tw * spp;
    const out = new Uint8Array(tw * th);
    const rows = Math.min(th, Math.floor(raw.length / (rowSamples * bps)));
    if (bits === 8) {
      if (predictor === 2) {
        for (let y = 0; y < rows; y++) {
          const r0 = y * rowSamples;
          for (let x = spp; x < rowSamples; x++) raw[r0 + x] = (raw[r0 + x] + raw[r0 + x - spp]) & 255;
        }
      }
      const signed = format === 2;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < tw; x++) {
          let v = raw[y * rowSamples + x * spp];
          if (signed && v > 127) v -= 256;
          out[y * tw + x] = v === nodata || v < 0 ? 0 : v;
        }
      }
      return out;
    }
    if (bits !== 16 && bits !== 32) throw new Error(`canopy: ${bits}-bit samples are not ones this reads`);
    if (predictor === 3 || (predictor === 2 && format === 3)) throw new Error('canopy: the floating-point predictor is not one this reads');
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const little = lv.little;
    const read = bits === 16
      ? (format === 2 ? i => dv.getInt16(i * 2, little) : i => dv.getUint16(i * 2, little))
      : (format === 3 ? i => dv.getFloat32(i * 4, little) : format === 2 ? i => dv.getInt32(i * 4, little) : i => dv.getUint32(i * 4, little));
    const line = new Float64Array(rowSamples);
    const mod = bits === 16 ? 65536 : 4294967296;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < rowSamples; x++) line[x] = read(y * rowSamples + x);
      if (predictor === 2) {
        for (let x = spp; x < rowSamples; x++) {
          let v = (line[x] + line[x - spp]) % mod;
          if (format === 2 && v >= mod / 2) v -= mod;
          else if (format === 2 && v < -mod / 2) v += mod;
          line[x] = v;
        }
      }
      for (let x = 0; x < tw; x++) {
        const v = line[x * spp];
        out[y * tw + x] = !(v > 0) || v === nodata ? 0 : Math.min(255, Math.round(v));
      }
    }
    return out;
  }

  // The blocks `index`es of one level of one file: Map index → Uint8Array, or
  // null for a block the file leaves out (all nothing).
  async function getBlocks(file, L, indexes) {
    const lv = file.levels[L];
    await tables(file, lv);
    const out = new Map();
    const waits = [];
    const fetchList = [];
    for (const index of indexes) {
      const key = `${file.url}|${L}|${index}`;
      const hit = cacheGet(key);
      if (hit) { out.set(index, hit); continue; }
      if (pending.has(key)) { waits.push(pending.get(key).then(b => out.set(index, b))); continue; }
      const off = lv.offsets[index], len = lv.counts[index];
      if (!off || !len) { out.set(index, null); continue; }
      fetchList.push({ key, index, off, len });
    }
    fetchList.sort((a, b) => a.off - b.off);
    const groups = [];
    for (const b of fetchList) {
      const g = groups[groups.length - 1];
      if (g && b.off - g.end <= MERGE_GAP && b.off + b.len - g.start <= MERGE_MAX) {
        g.end = Math.max(g.end, b.off + b.len); g.items.push(b);
      } else groups.push({ start: b.off, end: b.off + b.len, items: [b] });
    }
    for (const g of groups) {
      const got = getRange(file.url, g.start, g.end - 1);
      for (const b of g.items) {
        const p = got.then(r => {
          if (!r || r.bytes.length < b.off + b.len - g.start) throw new Error('canopy: a block was cut short');
          return decodeBlock(lv, file.geo.nodata, r.bytes.slice(b.off - g.start, b.off - g.start + b.len));
        }).then(block => { counters.blocks++; cachePut(b.key, block); return block; });
        pending.set(b.key, p);
        p.then(() => pending.delete(b.key), () => pending.delete(b.key));
        waits.push(p.then(block => out.set(b.index, block)));
      }
    }
    await Promise.all(waits);
    return out;
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  const rad = Math.PI / 180;
  const mercX = lon => lon * DEG_M;
  const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * rad / 2));
  const lonOf = x => x / DEG_M;
  const latOf = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / rad;

  function normBox(box) {
    if (!box) throw new TypeError('canopy: no box');
    const b = typeof box.getWest === 'function'
      ? { west: box.getWest(), south: box.getSouth(), east: box.getEast(), north: box.getNorth() }
      : Array.isArray(box) ? { west: box[0], south: box[1], east: box[2], north: box[3] }
      : { west: box.west, south: box.south, east: box.east, north: box.north };
    for (const k of ['west', 'south', 'east', 'north']) {
      b[k] = Number(b[k]);
      if (!Number.isFinite(b[k])) throw new TypeError(`canopy: the box has no ${k}`);
    }
    if (b.east <= b.west || b.north <= b.south) throw new RangeError('canopy: the box is empty or upside down');
    return b;
  }

  // Ground metres across and up a box, at its middle.
  function boxMetres(b) {
    const c = Math.cos((b.south + b.north) / 2 * rad);
    return { w: (b.east - b.west) * 111320 * c, h: (b.north - b.south) * 110574 };
  }

  // The zoom-10 squares a box touches, as quadkeys, north-west first.
  function quadkeysFor(box) {
    const b = normBox(box);
    const n = 2 ** QK_ZOOM;
    const fx = lon => (lon + 180) / 360 * n;
    const fy = lat => {
      const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * rad);
      return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    };
    const clamp = v => Math.max(0, Math.min(n - 1, v));
    const x0 = clamp(Math.floor(fx(b.west))), x1 = clamp(Math.max(Math.ceil(fx(b.east)) - 1, Math.floor(fx(b.west))));
    const y0 = clamp(Math.floor(fy(b.north))), y1 = clamp(Math.max(Math.ceil(fy(b.south)) - 1, Math.floor(fy(b.north))));
    const out = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let q = '';
        for (let i = QK_ZOOM; i > 0; i--) {
          const m = 1 << (i - 1);
          q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0);
        }
        out.push(q);
      }
    }
    return out;
  }

  // ── canopy() ───────────────────────────────────────────────────────────────
  async function canopy(box, metresPerPx) {
    const b = normBox(box);
    const want = Number(metresPerPx) > 0 ? Number(metresPerPx) : FINE_MPP;
    const qks = quadkeysFor(b);
    if (qks.length > MAX_FILES) throw new RangeError(`canopy: the box spans ${qks.length} map squares (at most ${MAX_FILES})`);
    const opened = await Promise.all(qks.map(openFile));
    const present = opened.filter(Boolean);
    const latMid = (b.south + b.north) / 2;
    const wantRes = want / Math.cos(latMid * rad);   // asked for in ground metres; the grid is in EPSG:3857 metres
    const ref = present[0];
    const nLevels = ref ? ref.levels.length : 7;
    const resOf = L => (ref ? ref.levels[L].res : NOMINAL_RES * 2 ** L);
    let L = 0;
    for (let i = 0; i < nLevels; i++) if (resOf(i) <= wantRes * 1.1) L = i;
    let res = resOf(L);
    if (wantRes > res * 1.5) res = wantRes;         // coarser than the coarsest overview: sample it

    const gx0 = Math.floor((mercX(b.west) + HALF) / res), gx1 = Math.ceil((mercX(b.east) + HALF) / res);
    const gy0 = Math.floor((HALF - mercY(b.north)) / res), gy1 = Math.ceil((HALF - mercY(b.south)) / res);
    const w = Math.max(1, gx1 - gx0), h = Math.max(1, gy1 - gy0);
    if (w * h > MAX_GRID_PX) throw new RangeError(`canopy: ${w} × ${h} cells is too many; ask for a smaller box or coarser cells`);
    const data = new Uint8Array(w * h);
    const cx = new Float64Array(w), cy = new Float64Array(h);
    for (let i = 0; i < w; i++) cx[i] = (gx0 + i + 0.5) * res - HALF;
    for (let j = 0; j < h; j++) cy[j] = HALF - (gy0 + j + 0.5) * res;

    let published = null;
    await Promise.all(present.map(async file => {
      const Lf = Math.min(L, file.levels.length - 1);
      const lv = file.levels[Lf];
      const g = file.geo, deg = g.crs === 'EPSG:4326';
      const col = new Int32Array(w).fill(-1), row = new Int32Array(h).fill(-1);
      let pxMin = Infinity, pxMax = -1, pyMin = Infinity, pyMax = -1;
      for (let i = 0; i < w; i++) {
        const px = Math.floor(((deg ? lonOf(cx[i]) : cx[i]) - g.x0) / lv.resX);
        if (px >= 0 && px < lv.w) { col[i] = px; if (px < pxMin) pxMin = px; if (px > pxMax) pxMax = px; }
      }
      for (let j = 0; j < h; j++) {
        const py = Math.floor((g.y0 - (deg ? latOf(cy[j]) : cy[j])) / lv.resY);
        if (py >= 0 && py < lv.h) { row[j] = py; if (py < pyMin) pyMin = py; if (py > pyMax) pyMax = py; }
      }
      if (pxMax < 0 || pyMax < 0) return;
      const across = Math.ceil(lv.w / lv.tw);
      const indexes = [];
      for (let by = Math.floor(pyMin / lv.th); by <= Math.floor(pyMax / lv.th); by++) {
        for (let bx = Math.floor(pxMin / lv.tw); bx <= Math.floor(pxMax / lv.tw); bx++) indexes.push(by * across + bx);
      }
      const got = await getBlocks(file, Lf, indexes);
      if (file.published && (!published || file.published > published)) published = file.published;
      for (let j = 0; j < h; j++) {
        const py = row[j];
        if (py < 0) continue;
        const by = Math.floor(py / lv.th), ry = (py - by * lv.th) * lv.tw, o = j * w;
        for (let i = 0; i < w; i++) {
          const px = col[i];
          if (px < 0) continue;
          const bx = Math.floor(px / lv.tw);
          const block = got.get(by * across + bx);
          if (!block) continue;
          const v = block[ry + px - bx * lv.tw];
          if (v > data[o + i]) data[o + i] = v;
        }
      }
    }));

    const west = lonOf(gx0 * res - HALF), east = lonOf(gx1 * res - HALF);
    const north = latOf(HALF - gy0 * res), south = latOf(HALF - gy1 * res);
    return {
      w, h, data,
      box: { west, south, east, north },
      mpp: res * Math.cos((south + north) / 2 * rad),
      level: L,
      res,
      quadkeys: qks,
      missing: qks.filter((q, i) => !opened[i]),
      published,
    };
  }

  // ── Trees ──────────────────────────────────────────────────────────────────
  const crownRadius = h => Math.max(1.5, Math.min(CROWN_MAX_M, 0.18 * h + 1));
  const r7 = v => Math.round(v * 1e7) / 1e7;
  const r2 = v => Math.round(v * 100) / 100;

  // [1 2 1] × [1 2 1] / 16: enough to give a flat-topped crown (whole metres
  // make plateaus) one highest cell, not enough to merge two crowns.
  function smooth(data, w, h) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l = data[o + (x > 0 ? x - 1 : x)], r = data[o + (x < w - 1 ? x + 1 : x)];
        tmp[o + x] = l + 2 * data[o + x] + r;
      }
    }
    for (let y = 0; y < h; y++) {
      const u = (y > 0 ? y - 1 : y) * w, d = (y < h - 1 ? y + 1 : y) * w, o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = (tmp[u + x] + 2 * tmp[o + x] + tmp[d + x]) / 16;
    }
    return out;
  }

  // Tree tops in a canopy grid → a trunk and a crown each, as GeoJSON.
  // opts.within (a box): only the trees standing in it are given back; the
  // rest of the grid is a margin, so a tree is judged against its neighbours
  // whichever side of the box's edge they stand.
  function treesFromGrid(grid, opts) {
    const o = Object.assign({ minHeight: MIN_TREE_M, max: MAX_TREES, within: null }, opts || {});
    const { w, h, data } = grid;
    const box = normBox(grid.box);
    const mpp = grid.mpp > 0 ? grid.mpp : FINE_MPP;
    const s = smooth(data, w, h);
    const tallest = p => {
      const x = p % w, y = (p - x) / w;
      let m = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (data[yy * w + xx] > m) m = data[yy * w + xx];
      }
      return m;
    };
    // q beats p: higher, or as high and first in reading order.
    const beats = (q, p) => s[q] > s[p] || (s[q] === s[p] && q < p);

    const tops = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (s[p] < o.minHeight / 4) continue;
        let top = true;
        for (let dy = -1; dy <= 1 && top; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((!dx && !dy) || xx < 0 || xx >= w) continue;
            if (beats(yy * w + xx, p)) { top = false; break; }
          }
        }
        if (!top) continue;
        const hv = tallest(p);
        if (hv < o.minHeight) continue;
        // The highest within a window as wide as the crown it would carry.
        const rw = Math.max(1, crownRadius(hv) / mpp), rr = rw * rw, ri = Math.ceil(rw);
        for (let dy = -ri; dy <= ri && top; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -ri; dx <= ri; dx++) {
            const xx = x + dx;
            if ((dx <= 1 && dx >= -1 && dy <= 1 && dy >= -1) || xx < 0 || xx >= w || dx * dx + dy * dy > rr) continue;
            if (beats(yy * w + xx, p)) { top = false; break; }
          }
        }
        if (top) tops.push({ x, y, h: hv, s: s[p] });
      }
    }

    const X0 = mercX(box.west), X1 = mercX(box.east), Yn = mercY(box.north), Ys = mercY(box.south);
    const dx = (X1 - X0) / w, dy = (Yn - Ys) / h;
    const inside = (() => {
      if (!o.within) return () => true;
      const wb = normBox(o.within);
      const x0 = (mercX(wb.west) - X0) / dx, x1 = (mercX(wb.east) - X0) / dx;
      const y0 = (Yn - mercY(wb.north)) / dy, y1 = (Yn - mercY(wb.south)) / dy;
      return t => t.x + 0.5 >= x0 && t.x + 0.5 < x1 && t.y + 0.5 >= y0 && t.y + 0.5 < y1;
    })();

    // Tallest first; none closer than MIN_SPACING_M or 0.8 of the taller crown.
    tops.sort((a, b) => b.h - a.h || b.s - a.s || (a.y - b.y) || (a.x - b.x));
    const cell = Math.max(1, Math.ceil(CROWN_MAX_M / mpp));
    const grid2 = new Map();
    const kept = [];
    let found = 0;
    for (const t of tops) {
      const gx = Math.floor(t.x / cell), gy = Math.floor(t.y / cell);
      let ok = true;
      for (let yy = gy - 1; yy <= gy + 1 && ok; yy++) {
        for (let xx = gx - 1; xx <= gx + 1 && ok; xx++) {
          const list = grid2.get(yy * 1e6 + xx);
          if (!list) continue;
          for (const a of list) {
            const d = Math.hypot(a.x - t.x, a.y - t.y) * mpp;
            if (d < Math.max(MIN_SPACING_M, 0.8 * crownRadius(a.h))) { ok = false; break; }
          }
        }
      }
      if (!ok) continue;
      const k = gy * 1e6 + gx;
      if (!grid2.has(k)) grid2.set(k, []);
      grid2.get(k).push(t);
      t.n = 0;
      if (!inside(t)) continue;
      found++;
      if (kept.length < o.max) kept.push(t);
    }

    // How wide each crown is: the canopy round a top that reaches above its
    // crown base (30 % of its height) and is nearer to it than to any other
    // top. A smooth map has few tops in a closed canopy, and a crown sized
    // from the height alone would leave most of a forest bare between them.
    for (let y = 0; y < h; y++) {
      const gy = Math.floor(y / cell);
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x];
        if (v < 2) continue;
        const gx = Math.floor(x / cell);
        let best = null, bd = Infinity;
        for (let yy = gy - 1; yy <= gy + 1; yy++) {
          for (let xx = gx - 1; xx <= gx + 1; xx++) {
            const list = grid2.get(yy * 1e6 + xx);
            if (!list) continue;
            for (const a of list) {
              if (v < 0.3 * a.h) continue;
              const d = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
              if (d < bd) { bd = d; best = a; }
            }
          }
        }
        if (best && Math.sqrt(bd) * mpp <= CROWN_MAX_M) best.n++;
      }
    }

    const features = [];
    const ring = (mx, my, k, pts) => {
      const c = pts.map(([ex, ey]) => [r7(lonOf(mx + ex * k)), r7(latOf(my + ey * k))]);
      c.push(c[0].slice());
      return [c];
    };
    for (const t of kept) {
      const mx = X0 + (t.x + 0.5) * dx, my = Yn - (t.y + 0.5) * dy;
      const k = 1 / Math.cos(latOf(my) * rad);       // ground metres → EPSG:3857 metres here
      const r = Math.max(1.5, Math.min(CROWN_MAX_M, Math.sqrt(t.n / Math.PI) * mpp));
      const q = 0.15 * crownRadius(t.h);            // the trunk's half-width goes with the height alone
      const crown = [];
      for (let a = 0; a < 8; a++) {
        const ang = (a * 45 + 22.5) * rad;          // counter-clockwise, flat to N, S, E and W
        crown.push([r * Math.cos(ang), r * Math.sin(ang)]);
      }
      features.push({
        type: 'Feature',
        properties: { kind: 'trunk', base: 0, top: r2(0.35 * t.h), h: t.h, r: r2(r) },
        geometry: { type: 'Polygon', coordinates: ring(mx, my, k, [[-q, -q], [q, -q], [q, q], [-q, q]]) },
      });
      features.push({
        type: 'Feature',
        properties: { kind: 'crown', base: r2(0.3 * t.h), top: t.h, h: t.h, r: r2(r) },
        geometry: { type: 'Polygon', coordinates: ring(mx, my, k, crown) },
      });
    }
    return {
      type: 'FeatureCollection',
      features,
      meta: {
        trees: kept.length,
        found,
        capped: found > kept.length,
        mpp: r2(mpp),
        minHeight: o.minHeight,
        source: 'Meta/WRI CHMv2',
        published: grid.published || null,
        attribution: ATTRIBUTION,
      },
    };
  }

  async function trees(box) {
    const b = normBox(box);
    const m = boxMetres(b);
    const across = Math.max(m.w, m.h);
    if (across > TREES_MAX_M * 1.1) {
      throw new RangeError(`trees: the box is ${(across / 1000).toFixed(1)} km across; at most ${TREES_MAX_M / 1000} km`);
    }
    // Read a margin round the box, so a tree on its edge is weighed against
    // the neighbours beyond it, and two boxes side by side agree on it.
    const padLat = TREE_MARGIN_M / 110574, padLon = TREE_MARGIN_M / (111320 * Math.cos((b.south + b.north) / 2 * rad));
    const grid = await canopy({ west: b.west - padLon, south: b.south - padLat, east: b.east + padLon, north: b.north + padLat },
      across > FINE_UPTO_M ? COARSE_MPP : FINE_MPP);
    const fc = treesFromGrid(grid, { within: b });
    fc.meta.missing = grid.missing;
    return fc;
  }

  return {
    canopy, trees,
    setSource(fn) {
      if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('setSource: a function of the quadkey, or null');
      sourceFn = fn || null;
      files.clear(); blocks.clear(); pending.clear(); blockBytes = 0;
    },
    quadkeysFor, treesFromGrid, parseTiffHeader,
    crownRadius,
    stats: () => ({ ...counters, cachedBlocks: blocks.size, cachedBytes: blockBytes, files: files.size }),
    clearCache() { files.clear(); blocks.clear(); pending.clear(); blockBytes = 0; },
    WORDS, ATTRIBUTION, MAX_TREES, TREES_MAX_M,
  };
})();
if (typeof window !== 'undefined') window.GroundCover = GroundCover;
