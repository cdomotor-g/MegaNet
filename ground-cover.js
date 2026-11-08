// MegaNet — ground-cover.js
//
//   GroundCover   how tall the trees are round a place, read from Meta and
//                 WRI's Canopy Height Maps v2 (CHMv2), and the trees stood on
//                 it — a trunk and a crown for every tree top, as GeoJSON a
//                 MapLibre fill-extrusion layer draws as it is (the ⛰️ 3-D
//                 view, #278). And the buildings round it, as plain outlines
//                 with a height each, for a view with no MapLibre to read the
//                 tiles (the digital twin, #280): the State's LiDAR outlines
//                 where Queensland has surveyed, Overture Maps' everywhere else.
//
// Load order: none. The IIFE body only declares — no request, no timer, no
// DOM — and everything it reaches for (fetch, DecompressionStream, Blob,
// Response, TextDecoder) is a browser global looked up at call time, so its
// position among the modules is free (`npm run toplevel`). Node 22 has every
// one of them, which is how the files were checked (see "Checked against the
// real files"). The one module it brings in, `pmtiles` for Overture's file, is
// a dynamic `import()` from inside a function, as map-3d.js brings in MapLibre
// — not a change to what kind of page this is.
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
// ── Buildings ────────────────────────────────────────────────────────────────
//
// buildings(box) reads the zoom-14 tiles the box touches (one to four for the
// twin's widest patch), each from one place only — the 3-D view's rule
// (map-3d.js, "Trees and buildings"; docs/ground-cover-sources.md, "In the
// digital twin"): the State's tile (/api/ground/qld-buildings, worker/
// ground.js) where meta.json says the tiles are built and its bounds touch the
// tile, and the State has one there; else Overture's (buildings.pmtiles, read
// with the `pmtiles` library, the file opened once a page and shared with the
// 3-D view). Each tile is a Mapbox Vector Tile, read here by a small decoder —
// protobuf varints, zigzag, MoveTo / LineTo / ClosePath — rather than by a
// library: the outlines are all that is wanted of it. A tile's buildings run
// a buffer past its edge, and the next tile holds the rest, so each outline is
// cut to its own tile's square. Heights: the State's `h` (its measured roof,
// floored at 2 m in the tiles); Overture's `height`, else 3.2 m a floor
// (`num_floors`), else one storey (3.5 m), never under 3 m, those it marks
// `is_underground` left out — the 3-D view's OVT_HEIGHT, the same numbers.
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
//   buildings(box, opts)      → Promise<{ buildings: [{ ring: [[lng, lat], …]
//       (the outline, not closed), holes: [ring, …], h (metres above the
//       ground), src: 'state'|'overture' }], found, capped, tiles ({ 'z/x/y':
//       'state'|'overture'|'none' }), tally ({ state, overture, none, failed,
//       stateFailed, decodeFailed } tiles), state ('built'|'not built'|
//       'unreachable'), overture ('ready'|'failed'|'unasked'), release,
//       credit }>. opts.within (a box, the box itself by default): only the
//       buildings whose middle is in it. Never rejects for a source that
//       cannot be reached — the tally and the states say so; a box over
//       TREES_MAX_M is refused.
//   overture()                → Promise<{ file (a PMTiles), release } | null>:
//       Overture's buildings file, opened once a page and shared with the 3-D
//       view; null when it cannot be had (asked afresh next time).
//   overtureState(), forgetOverture(), setOvertureOpener(fn) (the checks'
//       stand-in for the opener; null for the real one).
//   quadkeysFor(box), treesFromGrid(grid, opts), parseTiffHeader(buffer),
//   crownRadius(h), decodeTile(bytes, layers), buildingsFromTile(bytes, z, x,
//   y, src), buildingHeight(props, src), latestRelease(catalogue)
//                             the pure parts, for the checks.
//   stats(), clearCache(), WORDS, ATTRIBUTION, OVERTURE_CREDIT, MAX_TREES,
//   TREES_MAX_M, PMTILES_VER.
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
    'Building height': 'How tall a building is drawn, from the ground to its roof. In Queensland’s surveyed towns '
      + 'it is the roof the State measured by laser survey (none under 2 m); everywhere else it is Overture '
      + 'Maps’ height where it gives one — mostly estimates from photos, which run low — or 3.2 m a floor, or '
      + 'one storey (3.5 m) where it gives neither, and never under 3 m.',
    'LiDAR': 'Laser survey from the air: an aircraft sweeps a laser over the ground and times the echoes, which '
      + 'measures the ground and what stands on it to within centimetres. Queensland has flown its towns this way.',
    'Overture Maps': 'A free map of the world’s buildings: OpenStreetMap’s outlines, drawn by volunteers, and '
      + 'Microsoft’s, traced by a computer from aerial photos where OpenStreetMap has none. Used wherever the '
      + 'State has not surveyed — the rest of Queensland, and New South Wales.',
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

  // ── Buildings ──────────────────────────────────────────────────────────────
  // The outlines as plain polygons, for a view that has no MapLibre to decode
  // its tiles (the digital twin, #280). Each zoom-14 tile from one place only,
  // the same rule as the 3-D view's (map-3d.js, "Trees and buildings"): the
  // State's tile if it has one, else Overture's — never both, so a house is
  // never stood twice.
  const BLD_Z = 14;
  const BLD_MAX_TILES = 16;                 // a 3 km box at the equator is 4 × 4
  const MAX_BUILDINGS = 15000;
  const STATE_BASE = '/api/ground/qld-buildings';
  const STATE_MIN_M = 2;                    // the State's tiles floor at this already
  const FLOOR_M = 3.2;                      // an Overture building with floors and no height
  const ONE_STOREY_M = 3.5;                 // …with neither
  const OVT_MIN_M = 3;                      // …and never lower: most of its heights are estimates that run low
  const TILES_KEPT = 24;
  const OVERTURE_CREDIT = '© OpenStreetMap contributors, Overture Maps Foundation (ODbL)';

  // ── A vector tile, read ──
  // A Mapbox Vector Tile is protobuf: a tile is layers (3), a layer its name
  // (1), features (2), keys (3), values (4) and extent (5), a feature its tags
  // (2, packed key/value index pairs), type (3; 3 is a polygon) and geometry
  // (4, packed commands). Just that much of protobuf is read here.
  function pbVarint(r) {
    let v = 0, mul = 1, byte, n = 0;
    do {
      if (r.p >= r.end || n++ > 9) throw new Error('vector tile: a number runs off the end');
      byte = r.b[r.p++];
      v += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return v;
  }
  function pbSkip(r, wire) {
    if (wire === 0) pbVarint(r);
    else if (wire === 1) r.p += 8;
    else if (wire === 2) { const n = pbVarint(r); r.p += n; }
    else if (wire === 5) r.p += 4;
    else throw new Error(`vector tile: wire type ${wire} is not one this reads`);
    if (r.p > r.end) throw new Error('vector tile: a field runs off the end');
  }
  // The message at the reader, as a reader of its own.
  function pbSub(r) {
    const n = pbVarint(r);
    if (r.p + n > r.end) throw new Error('vector tile: a message runs off the end');
    const sub = { b: r.b, p: r.p, end: r.p + n };
    r.p += n;
    return sub;
  }
  function pbPacked(r) {
    const s = pbSub(r), out = [];
    while (s.p < s.end) out.push(pbVarint(s));
    return out;
  }
  const unzig = n => (n % 2 ? -(n + 1) / 2 : n / 2);
  // A signed 64-bit varint (an MVT int_value): a negative one is ten bytes of
  // two's complement, which a double cannot add up exactly — so as a BigInt.
  function pbInt64(r) {
    let v = 0n, shift = 0n, byte, n = 0;
    do {
      if (r.p >= r.end || n++ > 9) throw new Error('vector tile: a number runs off the end');
      byte = r.b[r.p++];
      v |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return Number(BigInt.asIntN(64, v));
  }

  function pbValue(r) {
    const s = pbSub(r);
    const dv = new DataView(s.b.buffer, s.b.byteOffset, s.b.byteLength);
    let v = null;
    while (s.p < s.end) {
      const key = pbVarint(s), field = Math.floor(key / 8), wire = key % 8;
      if (field === 1 && wire === 2) { const t = pbSub(s); v = new TextDecoder().decode(s.b.subarray(t.p, t.end)); }
      else if (field === 2 && wire === 5) { v = dv.getFloat32(s.p, true); s.p += 4; }
      else if (field === 3 && wire === 1) { v = dv.getFloat64(s.p, true); s.p += 8; }
      else if (field === 4 && wire === 0) v = pbInt64(s);
      else if (field === 5 && wire === 0) v = pbVarint(s);
      else if (field === 6 && wire === 0) v = unzig(pbVarint(s));
      else if (field === 7 && wire === 0) v = pbVarint(s) !== 0;
      else pbSkip(s, wire);
    }
    return v;
  }

  // The commands of one feature → its rings in tile units (MoveTo starts a
  // ring, LineTo adds to it, ClosePath ends it; each point relative to the
  // last, zigzag-coded).
  function geometryRings(cmds) {
    const rings = [];
    let x = 0, y = 0, ring = null, i = 0;
    while (i < cmds.length) {
      const c = cmds[i++], id = c & 7, count = c >> 3;
      if (id === 1 || id === 2) {
        for (let k = 0; k < count && i + 1 < cmds.length; k++) {
          x += unzig(cmds[i++]); y += unzig(cmds[i++]);
          if (id === 1) { ring = [[x, y]]; rings.push(ring); } else if (ring) ring.push([x, y]);
        }
      } else if (id === 7) ring = null;
      else break;                                   // not a command: the rest is not geometry
    }
    return rings;
  }

  // A tile's bytes → { layerName: { extent, features: [{ type, props, rings }] } },
  // for the layers named (all of them when `names` is not given).
  function decodeTile(bytes, names) {
    const want = names ? new Set(names) : null;
    const top = { b: bytes, p: 0, end: bytes.length };
    const out = {};
    while (top.p < top.end) {
      const key = pbVarint(top), field = Math.floor(key / 8), wire = key % 8;
      if (field !== 3 || wire !== 2) { pbSkip(top, wire); continue; }
      const L = pbSub(top);
      let name = '', extent = 4096;
      const keys = [], values = [], feats = [];
      while (L.p < L.end) {
        const k = pbVarint(L), f = Math.floor(k / 8), w = k % 8;
        if (f === 1 && w === 2) { const t = pbSub(L); name = new TextDecoder().decode(L.b.subarray(t.p, t.end)); }
        else if (f === 2 && w === 2) feats.push(pbSub(L));         // read once the keys and values are known
        else if (f === 3 && w === 2) { const t = pbSub(L); keys.push(new TextDecoder().decode(L.b.subarray(t.p, t.end))); }
        else if (f === 4 && w === 2) values.push(pbValue(L));
        else if (f === 5 && w === 0) extent = pbVarint(L) || 4096;
        else pbSkip(L, w);
      }
      if (want && !want.has(name)) continue;
      const features = [];
      for (const F of feats) {
        let type = 0, tags = [], geom = [];
        while (F.p < F.end) {
          const k = pbVarint(F), f = Math.floor(k / 8), w = k % 8;
          if (f === 2 && w === 2) tags = pbPacked(F);
          else if (f === 3 && w === 0) type = pbVarint(F);
          else if (f === 4 && w === 2) geom = pbPacked(F);
          else pbSkip(F, w);
        }
        const props = {};
        for (let t = 0; t + 1 < tags.length; t += 2) if (tags[t] < keys.length && tags[t + 1] < values.length) props[keys[tags[t]]] = values[tags[t + 1]];
        features.push({ type, props, rings: geometryRings(geom) });
      }
      out[name] = { extent, features };
    }
    return out;
  }

  // Twice a ring's area by the surveyor's formula, in tile units (y down): an
  // outer ring is positive, a hole negative (the spec's winding).
  function ringArea2(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a;
  }
  // A ring cut to [0, extent] square (Sutherland–Hodgman): a tile's buildings
  // run a buffer past its edge, and the next tile holds the rest of them.
  function clipRing(ring, extent) {
    let pts = ring;
    const edges = [[0, 0, 1], [0, extent, -1], [1, 0, 1], [1, extent, -1]];   // axis, at, keep side
    for (const [ax, at, side] of edges) {
      if (!pts.length) break;
      const inside = p => (p[ax] - at) * side >= 0;
      const cut = (a, b) => {
        const t = (at - a[ax]) / (b[ax] - a[ax]);
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      };
      const next = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
        if (inside(b)) { if (!inside(a)) next.push(cut(a, b)); next.push(b); }
        else if (inside(a)) next.push(cut(a, b));
      }
      pts = next;
    }
    return pts;
  }
  // A polygon feature's rings → [{ outer, holes }]: each outer ring and the
  // holes after it. The first ring's winding is taken as the outer one's, so a
  // tile wound the other way round is still read.
  function polygonsOf(rings) {
    const out = [];
    let sign = 0;
    for (const r of rings) {
      if (r.length < 3) continue;
      const a = ringArea2(r);
      if (!a) continue;
      if (!sign) sign = Math.sign(a);
      if (Math.sign(a) === sign || !out.length) out.push({ outer: r, holes: [] });
      else out[out.length - 1].holes.push(r);
    }
    return out;
  }

  // How tall a building is drawn: the State's measured roof (`h`), or
  // Overture's `height`, else 3.2 m a floor, else one storey — and never lower
  // than 3 m. The 3-D view's OVT_HEIGHT says the same to MapLibre.
  function buildingHeight(props, src) {
    const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
    if (src === 'state') {
      const h = num(props.h);
      return Number.isFinite(h) ? Math.max(STATE_MIN_M, h) : ONE_STOREY_M;
    }
    let h;
    if (props.height !== undefined && props.height !== null) h = num(props.height);
    else if (props.num_floors !== undefined && props.num_floors !== null) h = num(props.num_floors) * FLOOR_M;
    else h = ONE_STOREY_M;
    if (!Number.isFinite(h)) h = ONE_STOREY_M;
    return Math.max(OVT_MIN_M, h);
  }

  // One tile's buildings, as polygons in degrees: [{ ring, holes, h, src }],
  // `ring` the outline (not closed: the last point is not the first again),
  // cut to the tile's own square. `src` is 'state' (layer `buildings`) or
  // 'overture' (layer `building`, those it marks under the ground left out).
  function buildingsFromTile(bytes, z, x, y, src) {
    const layer = src === 'state' ? 'buildings' : 'building';
    const L = decodeTile(bytes, [layer])[layer];
    if (!L) return [];
    const n = 2 ** z, ext = L.extent;
    const lng = px => r7((x + px / ext) / n * 360 - 180);
    const lat = py => r7(Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / ext) / n))) / rad);
    const deg = r => r.map(p => [lng(p[0]), lat(p[1])]);
    const out = [];
    for (const f of L.features) {
      if (f.type !== 3) continue;
      if (src !== 'state' && f.props.is_underground === true) continue;
      const h = r2(buildingHeight(f.props, src));
      for (const poly of polygonsOf(f.rings)) {
        const outer = clipRing(poly.outer, ext);
        if (outer.length < 3 || Math.abs(ringArea2(outer)) < 1e-6) continue;
        const holes = poly.holes.map(r => clipRing(r, ext)).filter(r => r.length >= 3);
        out.push({ ring: deg(outer), holes: holes.map(deg), h, src });
      }
    }
    return out;
  }

  // The zoom-14 tiles a box touches.
  function tilesFor(b, z) {
    const n = 2 ** z;
    const tx = lon => Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
    const ty = lat => {
      const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * rad);
      return Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)));
    };
    const out = [];
    for (let y = ty(b.north); y <= ty(b.south); y++) for (let x = tx(b.west); x <= tx(b.east); x++) out.push({ z, x, y });
    return out;
  }
  function tileBounds(t) {
    const n = 2 ** t.z;
    const lat = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) / rad;
    return { west: t.x / n * 360 - 180, east: (t.x + 1) / n * 360 - 180, north: lat(t.y), south: lat(t.y + 1) };
  }

  // ── The State's tiles ──
  // meta.json once a page: { status: 'built', meta } with its bounds and
  // credit, 'not built' (404), or 'unreachable' — which is not kept, so the
  // next box asks again.
  let stateMetaP = null;
  function stateMeta() {
    if (stateMetaP) return stateMetaP;
    const p = stateMetaP = fetch(`${STATE_BASE}/meta.json`).then(async res => {
      if (res.status === 404) return { status: 'not built', meta: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = await res.json();
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('meta.json is not an object');
      return { status: 'built', meta: m };
    }).catch(() => {
      if (stateMetaP === p) stateMetaP = null;
      return { status: 'unreachable', meta: null };
    });
    return p;
  }
  function stateMayHave(meta, t) {
    const b = meta && meta.bounds;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return true;
    const k = tileBounds(t);
    return k.west <= b[2] && k.east >= b[0] && k.south <= b[3] && k.north >= b[1];
  }
  // A State tile's bytes, or null where it has none (204, 404). The Worker
  // serves a gzipped tile with Content-Encoding, which the browser undoes;
  // one that arrives still gzipped is undone here.
  async function stateTile(t) {
    const res = await fetch(`${STATE_BASE}/${t.z}/${t.x}/${t.y}.pbf`);
    if (res.status === 204 || res.status === 404) { drop(res); return null; }
    if (!res.ok) { drop(res); throw new Error(`HTTP ${res.status}`); }
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await inflateWith('gzip', bytes);
    return bytes.length ? bytes : null;
  }

  // ── Overture's buildings ──
  // One PMTiles file for the whole world, read a tile at a time by the
  // `pmtiles` library with range requests. The library is imported from unpkg
  // the first time a tile needs it, pinned; `?module` is unpkg rewriting its
  // one bare import (fflate, its fallback where a browser has no
  // DecompressionStream) into an address a browser can follow. A failed
  // import stays failed in the module map, so a retry is a fresh specifier.
  // Overture deletes each release a couple of months on, so the file's name is
  // looked up in their catalogue — the child marked latest — once a page.
  // All three hosts allow cross-site reads, and the file is read with plain
  // single-range GETs, which need no preflight (Overture's server refuses
  // one). Opened once a page and shared by the 3-D view and the twin; a
  // failure is not kept, so the next asker tries again.
  const PMTILES_VER = '4.5.0';
  const PMTILES_JS = `https://unpkg.com/pmtiles@${PMTILES_VER}/dist/esm/index.js?module`;
  const OVT_CATALOG = 'https://stac.overturemaps.org/catalog.json';
  const OVT_FILE = release => `https://tiles.overturemaps.org/${release}/buildings.pmtiles`;
  let pmLib = null;       // the library's module namespace, once imported
  let pmTry = 0;          // failed imports so far
  let ovt = null;         // { p, file, release, failed, error }
  let ovtOpener = null;   // the checks' stand-in for openOverture
  // The release the catalogue marks latest, in Overture's own form
  // (2026-10-21.0), or null. Nothing else is put into the file's address.
  function latestRelease(cat) {
    const ok = r => (typeof r === 'string' && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(r) ? r : null);
    const links = cat && Array.isArray(cat.links) ? cat.links : [];
    const child = links.find(l => l && l.rel === 'child' && l.latest === true && typeof l.href === 'string');
    const m = child && /\/([^/]+)\/catalog\.json$/.exec(child.href);
    return ok(m && m[1]) || ok(cat && cat.latest);
  }
  async function openOverture() {
    if (!pmLib) {
      const url = pmTry ? `${PMTILES_JS}&r=${pmTry}` : PMTILES_JS;
      const lib = await import(url).catch(() => { pmTry++; return null; });
      if (!lib || typeof lib.PMTiles !== 'function') throw new Error('the buildings reader could not be fetched');
      pmLib = lib;
    }
    const res = await fetch(OVT_CATALOG);
    const release = latestRelease(res.ok ? await res.json() : null);
    if (!release) throw new Error('Overture’s catalogue names no current release');
    const file = new pmLib.PMTiles(OVT_FILE(release));
    const head = await file.getHeader();
    // 1 is vector tiles; a file that stops short of zoom 14 has no tile to give.
    if (!head || head.tileType !== 1 || head.maxZoom < BLD_Z) throw new Error('not Overture’s buildings tiles');
    return { file, release };
  }
  // → Promise<{ file (getZxy), release } | null>, never rejecting.
  function overture() {
    if (ovt && !ovt.failed) return ovt.p;
    const o = ovt = { p: null, file: null, release: null, failed: false, error: null };
    o.p = Promise.resolve().then(() => (ovtOpener ? ovtOpener() : openOverture())).then(r => {
      if (!r || !r.file || typeof r.file.getZxy !== 'function') throw new Error('no buildings file');
      o.file = r.file; o.release = r.release || null;
      return { file: o.file, release: o.release };
    }).catch(err => { o.failed = true; o.error = String((err && err.message) || err); return null; });
    return o.p;
  }
  function overtureState() {
    return { state: !ovt ? 'unasked' : ovt.failed ? 'failed' : ovt.file ? 'ready' : 'opening',
             release: ovt ? ovt.release : null, error: ovt ? ovt.error : null };
  }

  // ── buildings() ──
  // One tile, from one place: the State's where it may have one and does,
  // else Overture's. → { from: 'state'|'overture'|'none', bytes, stateFailed,
  // failed }. A tile read whole is kept (the last TILES_KEPT), so a rebuild of
  // the same place asks nothing again.
  const bldTiles = new Map();
  async function buildingTile(t, meta, ovtP) {
    const key = `${t.z}/${t.x}/${t.y}|${meta.status}`;
    if (bldTiles.has(key)) { const v = bldTiles.get(key); bldTiles.delete(key); bldTiles.set(key, v); return v; }
    let stateFailed = false;
    if (meta.meta && stateMayHave(meta.meta, t)) {
      try {
        const bytes = await stateTile(t);
        if (bytes) return keep(key, { from: 'state', bytes, stateFailed, failed: false });
      } catch (_) { stateFailed = true; }
    }
    const o = await ovtP();
    if (!o) return { from: 'none', bytes: null, stateFailed, failed: false, ovtMissing: true };
    let got;
    try { got = await o.file.getZxy(t.z, t.x, t.y); } catch (_) { return { from: 'none', bytes: null, stateFailed, failed: true }; }
    const v = got && got.data && got.data.byteLength
      ? { from: 'overture', bytes: new Uint8Array(got.data), stateFailed, failed: false }
      : { from: 'none', bytes: null, stateFailed, failed: false };
    return stateFailed ? v : keep(key, v);
  }
  function keep(key, v) {
    bldTiles.set(key, v);
    while (bldTiles.size > TILES_KEPT) bldTiles.delete(bldTiles.keys().next().value);
    return v;
  }

  async function buildings(box, opts) {
    const b = normBox(box);
    const o = Object.assign({ within: b, max: MAX_BUILDINGS }, opts || {});
    const m = boxMetres(b);
    const across = Math.max(m.w, m.h);
    if (across > TREES_MAX_M * 1.1) {
      throw new RangeError(`buildings: the box is ${(across / 1000).toFixed(1)} km across; at most ${TREES_MAX_M / 1000} km`);
    }
    const tiles = tilesFor(b, BLD_Z);
    if (tiles.length > BLD_MAX_TILES) throw new RangeError(`buildings: the box spans ${tiles.length} tiles (at most ${BLD_MAX_TILES})`);
    const within = normBox(o.within);
    const meta = await stateMeta();
    let ovtP = null;
    const askOverture = () => (ovtP || (ovtP = overture()));
    const tally = { state: 0, overture: 0, none: 0, failed: 0, stateFailed: 0, decodeFailed: 0 };
    const from = {};
    const found = [];
    await Promise.all(tiles.map(async t => {
      const r = await buildingTile(t, meta, askOverture);
      const key = `${t.z}/${t.x}/${t.y}`;
      from[key] = r.from;
      tally[r.from]++;
      if (r.failed) tally.failed++;
      if (r.stateFailed) tally.stateFailed++;
      if (!r.bytes) return;
      let list;
      try { list = buildingsFromTile(r.bytes, t.z, t.x, t.y, r.from); } catch (_) { tally.decodeFailed++; return; }
      for (const bd of list) {
        let sx = 0, sy = 0;
        for (const p of bd.ring) { sx += p[0]; sy += p[1]; }
        const cx = sx / bd.ring.length, cy = sy / bd.ring.length;
        if (cx >= within.west && cx <= within.east && cy >= within.south && cy <= within.north) found.push(bd);
      }
    }));
    const ov = overtureState();
    const used = { state: tally.state > 0, overture: tally.overture > 0 };
    const credit = [used.state && meta.meta && meta.meta.attribution ? String(meta.meta.attribution) : used.state ? 'Buildings: © State of Queensland (CC BY 4.0)' : '',
                    used.overture ? OVERTURE_CREDIT : ''].filter(Boolean).join('; ');
    return {
      buildings: found.slice(0, o.max),
      found: found.length,
      capped: found.length > o.max,
      tiles: from,
      tally,
      state: meta.status,                         // 'built' | 'not built' | 'unreachable'
      overture: ovtP ? ov.state : 'unasked',      // 'ready' | 'failed' | 'unasked'
      release: ovtP ? ov.release : null,
      credit,
    };
  }

  return {
    canopy, trees, buildings,
    overture, overtureState,
    forgetOverture() { ovt = null; stateMetaP = null; bldTiles.clear(); },
    setOvertureOpener(fn) {
      if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('setOvertureOpener: a function, or null');
      ovtOpener = fn || null; ovt = null; bldTiles.clear();
    },
    decodeTile, buildingsFromTile, buildingHeight, latestRelease,
    setSource(fn) {
      if (fn !== null && fn !== undefined && typeof fn !== 'function') throw new TypeError('setSource: a function of the quadkey, or null');
      sourceFn = fn || null;
      files.clear(); blocks.clear(); pending.clear(); blockBytes = 0;
    },
    quadkeysFor, treesFromGrid, parseTiffHeader,
    crownRadius,
    stats: () => ({ ...counters, cachedBlocks: blocks.size, cachedBytes: blockBytes, files: files.size, buildingTiles: bldTiles.size }),
    clearCache() { files.clear(); blocks.clear(); pending.clear(); blockBytes = 0; bldTiles.clear(); stateMetaP = null; },
    WORDS, ATTRIBUTION, OVERTURE_CREDIT, MAX_TREES, TREES_MAX_M, PMTILES_VER,
  };
})();
if (typeof window !== 'undefined') window.GroundCover = GroundCover;
