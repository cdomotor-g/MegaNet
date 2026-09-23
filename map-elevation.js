// MegaNet — map-elevation.js
//
//   MapElevation   a base map that IS the terrain: ground height, banded into
//                  colours, decoded in the browser from the same terrarium
//                  tiles the elevation profile is built on.
//
// After core.js and before map-controls.js's makeBaseLayers() is *called* —
// index.html holds the order and the reasons. Reaches back to core.js for
// `state` only, and to nothing else in the app: the tile source is written out
// here rather than borrowed from terrain.js because the two want different
// things from it (that one wants metres at a point and caches them decoded,
// this one wants pixels on screen and lets the browser's HTTP cache do the
// keeping), and a shared 128-tile LRU sized for a profile would be thrashed
// flat by a base map. Same URL, same datum, same attribution — said in both
// places rather than reached for.
//
// ── Why an overlay and not a base map (#186) ─────────────────────────────────
// It shipped as a base map, one radio beside OSM-Topo, Satellite and Dark, on
// the reasoning that "what does this country look like" is the question you
// have before you draw anything on it. That reasoning was sound and the answer
// was still wrong, for a reason a radio button cannot express: **the ground and
// the place names are not alternatives.** Picked as a base, the ramp took the
// localities, the roads and the watercourses with it, so the operator who
// wanted to see which of two hills a site sits on lost the names of both.
//
// So it is an overlay now, on the Stations map's Map display panel with an
// opacity slider — the control that makes the two readings one picture instead
// of a choice between them. It draws just above the base tiles and *below* the
// place-name layers that ride along with Satellite and Dark (pane 245, under
// mnBaseLabels' 250), so on those two bases the names stay crisp over the wash;
// on OSM-Topo the names are baked into the tiles and the slider is the whole of
// the answer.
//
// The cost, stated rather than discovered: the other six maps had this in their
// picker and no longer do. Map display is the Stations map's own panel, and a
// second copy of the switch in the shared base picker would be two controls for
// one layer.
//
// The layer is L.TileLayer with createTile overridden to return a <canvas>
// rather than an <img>. Everything else about a tile layer — the tile grid,
// the pyramid, retention on zoom, maxNativeZoom's overzoom arithmetic — is
// Leaflet's and is left alone. maxNativeZoom is terrain.js's MAX_ZOOM for
// terrain.js's reason: the source is ~30 m SRTM, and past z12 the tiles are
// resampling their own pixels. Leaflet stretches the z12 tile from there.
//
// ── The colours ──────────────────────────────────────────────────────────────
// From the Radio Mobile colour file in #184 (twelve heights, twelve colours).
// The colour list in that format runs the way a legend is *drawn* — top of the
// strip first, which is the highest band — while the heights run bottom-up, so
// the two lists are paired end to end rather than head to head. Read the other
// way round the ramp puts pure blue on the mountains and pale yellow on the
// coast, and the grey (8F8F8F) lands on the coastal flats instead of where a
// grey in a hypsometric ramp always is: the bare rock just under the top of
// the scale. Paired as below it reads the way every topographic sheet reads —
// water blue, lowlands cyan, ranges green, tops grey then pale.
//
// Bands, not a gradient: a colour file is a set of bands and Radio Mobile
// draws it as one, so a boundary here is a real height an operator can point
// at rather than a place where two colours happen to blend.
//
// ── The Elvis source: 5 m where the nation has it ───────────────────────────
// A "Height source" menu under the switch picks between the ~30 m tiles above
// and Geoscience Australia's national 5 m LiDAR-derived DEM — the product Elvis
// distributes as "DEM of Australia derived from LiDAR 5 Metre Grid". Neither of
// the Elvis hosts the app already reads can draw a map: elevation-at-point is
// one 1.4–5 s request per *point* (elvis.js), and the coverage cache is a
// picture of the metadata (map-elvis-coverage.js). What can is GA's WCS for
// the same grid, which answers GetCoverage with a real float32 GeoTIFF and
// reflects any Origin back with `Access-Control-Allow-Origin`, so a static page
// reads it with no proxy. Measured against the live service, not assumed:
//
//   • CRS=EPSG:4283 (GDA94) works; CRS=EPSG:4326 answers 400, although the
//     capabilities list it. GDA94 against WGS84 is under 2 m, well inside one
//     5 m cell, so the grid is laid on the Web Mercator tile as if they agreed.
//   • 256×256 comes back uncompressed float32 in 128-px internal tiles — a
//     ~260 KB answer in 1.5–2.8 s, unchanged at 12 in flight (no degraded
//     "No Data" shape turned up, unlike the point API). A reader for that one
//     layout is fifty lines, so no GeoTIFF library comes with it.
//   • Where the grid holds nothing the answer has two shapes: an internal tile
//     never written (offset and length 0), and inside a written one, exactly
//     0.0. Both are "no survey here", and those pixels are painted from the
//     30 m tiles instead — 0.0 is not sea level to this reader, because a
//     half-covered inland tile would otherwise paint its outback half as sea.
//   • A box wholly outside the grid's extent is a 404 with an XML exception,
//     so boxes outside it are never asked for.
//
// Only from ELVIS_MIN_Z: below it a tile pixel is coarser than 30 m and the
// SRTM tiles already out-resolve the screen, so the Elvis setting draws them
// and says so. It caps at ELVIS_MAX_NATIVE (~4 m a pixel at Queensland's
// latitudes) and Leaflet stretches from there. The 3-D drape stays on the 30 m
// tiles — it paints through tileUrl/paintedTile, which are unchanged.
//
// This is a *picture*. Nothing here reaches terrain.js, a profile or a sweep,
// for elvis.js's reason: the physics reads one source everywhere, and a map
// that looks sharper does not change what a clearance was computed from.
const MapElevation = (function () {
  const TILE_URL   = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_PX    = 256;
  const MAX_NATIVE = 12;    // terrain.js's MAX_ZOOM, for terrain.js's reason
  const ATTRIB     = 'Elevation: AWS Terrain Tiles (SRTM/GMTED, ~30 m), height above the EGM96 geoid';

  const ELVIS_WCS  = 'https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer';
  const ELVIS_ATTRIB = 'Elevation: Elvis — Geoscience Australia 5 m LiDAR DEM (AHD) where held; '
                     + 'AWS Terrain Tiles (~30 m, EGM96) elsewhere';
  // W, S, E, N — the coverage's own envelope from DescribeCoverage.
  const ELVIS_EXTENT = [114.0985, -43.4628, 153.6775, -9.8660];
  const ELVIS_MIN_Z      = 13;   // ~17 m a pixel at 27° S: finer than 30 m from here
  const ELVIS_MAX_NATIVE = 15;   // ~4 m a pixel — the grid's own 5 m
  // Politeness rather than a measured ceiling (12 in flight answered cleanly):
  // a whole z15 screen is ~40 tiles and nobody needs them all at once.
  const ELVIS_IN_FLIGHT  = 4;
  const ELVIS_FETCH_MS   = 20000;
  const ELVIS_CACHE_MAX  = 48;   // decoded grids, 256 KB each
  // Three failures in a row — a host the network denies, a service down —
  // stops asking for this long, so a dead host costs three slow tiles a
  // minute rather than one per tile in view.
  const ELVIS_TRIP_AFTER = 3;
  const ELVIS_TRIP_MS    = 60000;

  // Lower bound of each band, ascending, with the colour that band is painted.
  // Anything below the first band is painted the first band's colour — the sea
  // is blue and so is a metre of it.
  const RAMP = [
    { m:    0, hex: '#0000FF' },
    { m:    1, hex: '#6464FF' },
    { m:   50, hex: '#4080FF' },
    { m:  100, hex: '#2F97FF' },
    { m:  150, hex: '#00F4F4' },
    { m:  250, hex: '#88FFFF' },
    { m:  400, hex: '#4B9700' },
    { m:  500, hex: '#00CA00' },
    { m:  700, hex: '#00FF80' },
    { m:  800, hex: '#80FF00' },
    { m:  900, hex: '#8F8F8F' },
    { m: 1000, hex: '#FFFF80' },
  ];

  // The ramp as three flat arrays, built once: a per-pixel loop that reads
  // objects and parses hex strings is the difference between a tile that
  // paints in 4 ms and one that paints in 60.
  const CUT = RAMP.map(b => b.m);
  const R = RAMP.map(b => parseInt(b.hex.slice(1, 3), 16));
  const G = RAMP.map(b => parseInt(b.hex.slice(3, 5), 16));
  const B = RAMP.map(b => parseInt(b.hex.slice(5, 7), 16));

  // ── Relief ──────────────────────────────────────────────────────────────────
  // Twelve bands over a thousand metres is four colours for the whole of
  // coastal Queensland, and a base map that is one flat blue from Bundaberg to
  // Brisbane is not a base map. So the band colour is *shaded* by the ground's
  // own slope — the standard hillshade, light from the north-west at 45°,
  // multiplied over the hue. The hue is still the height and nothing else; the
  // shading only says which way the ground is leaning, which is what makes a
  // ridge line visible between two contours of the same colour.
  //
  // It can be switched off from the Base map panel for anyone comparing this
  // against Radio Mobile's own flat rendering of the same colour file.
  //
  // The gradient at a tile's edge is taken from the pixel one step inside it,
  // rather than from the neighbouring tile that has not been fetched: the
  // outermost row and column of every tile are therefore shaded like their
  // neighbour. That is a one-pixel error at the native zoom and it draws no
  // seam, because both sides of a shared edge make the same substitution.
  const AZIMUTH  = 315 * Math.PI / 180;
  const ZENITH   = 45 * Math.PI / 180;
  const Z_FACTOR = 2.2;     // vertical exaggeration; ~30 m ground detail is
                            // otherwise almost flat at map scale
  const SHADE_LO = 0.62, SHADE_HI = 1.22;

  let relief = (() => { try { return localStorage.getItem('mn-elev-relief') !== 'off'; }
                        catch (_) { return true; } })();
  // 'srtm' or 'elvis'. Remembered like the relief switch; 'srtm' unless a
  // person picked otherwise, because the Elvis source costs a slow request to
  // a government server per close-in tile.
  let source = (() => { try { return localStorage.getItem('mn-map-elev-src') === 'elvis' ? 'elvis' : 'srtm'; }
                        catch (_) { return 'srtm'; } })();

  const live = new Set();   // every layer instance on any map, for a repaint

  // Ground distance one tile pixel covers, which is what turns a height
  // difference into a slope. Web Mercator, at the tile's own centre latitude.
  function metresPerPixel(z, y) {
    const n   = Math.PI - 2 * Math.PI * (y + 0.5) / Math.pow(2, z);
    const lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return 156543.03392804097 * Math.cos(lat) / Math.pow(2, z);
  }

  // Which band a height falls in. Linear over twelve entries, walked from the
  // top down: the tail of the ramp is where the rare heights are, so most
  // pixels answer in the first two or three comparisons.
  function bandOf(m) {
    for (let i = CUT.length - 1; i > 0; i--) if (m >= CUT[i]) return i;
    return 0;
  }

  // Terrarium: elevation_m = (R·256 + G + B/256) − 32768. The canvas is the
  // tile's own, used as scratch — paintHeights overwrites every pixel of it.
  function decodeTerrarium(canvas, img) {
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    const px = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const N = TILE_PX * TILE_PX;
    const h = new Float32Array(N);
    for (let i = 0, j = 0; j < N; i += 4, j++) {
      h[j] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
    }
    return h;
  }

  function paint(canvas, img, z, ty) {
    paintHeights(canvas, decodeTerrarium(canvas, img), z, ty);
  }

  // A grid of metres, 256×256 in the tile's own Web Mercator rows, painted. A
  // NaN is a pixel no source answered for and is left transparent rather than
  // given the sea's blue.
  function paintHeights(canvas, h, z, ty) {
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    const data = cx.createImageData(TILE_PX, TILE_PX);
    const px = data.data;

    const res = metresPerPixel(z, ty);
    const cosZ = Math.cos(ZENITH), sinZ = Math.sin(ZENITH);

    for (let y = 0, j = 0; y < TILE_PX; y++) {
      // Clamped one step inside the tile at both edges — see the note above.
      const yUp = y > 0 ? y - 1 : 0, yDn = y < TILE_PX - 1 ? y + 1 : TILE_PX - 1;
      const spanY = (yDn - yUp) * res;
      for (let x = 0; x < TILE_PX; x++, j++) {
        const v = h[j];
        if (v !== v) continue;   // NaN: no answer, left at alpha 0
        const b = bandOf(v);
        let r = R[b], g = G[b], bl = B[b];

        if (relief) {
          const xL = x > 0 ? x - 1 : 0, xR = x < TILE_PX - 1 ? x + 1 : TILE_PX - 1;
          const spanX = (xR - xL) * res;
          let dzdx = spanX > 0 ? (h[y * TILE_PX + xR] - h[y * TILE_PX + xL]) / spanX : 0;
          // y grows southward, so north-up rise is the row above minus below.
          let dzdy = spanY > 0 ? (h[yUp * TILE_PX + x] - h[yDn * TILE_PX + x]) / spanY : 0;
          if (dzdx !== dzdx) dzdx = 0;   // a neighbour with no answer
          if (dzdy !== dzdy) dzdy = 0;
          const slope  = Math.atan(Z_FACTOR * Math.sqrt(dzdx * dzdx + dzdy * dzdy));
          const aspect = Math.atan2(dzdy, -dzdx);
          const hs = cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(AZIMUTH - aspect);
          // hs runs 0..1 with 0.707 at flat ground, so it is re-centred rather
          // than used raw: flat country must come out the band's own colour.
          const f = Math.max(SHADE_LO, Math.min(SHADE_HI, 1 + (hs - cosZ) * 1.15));
          r  = Math.min(255, r * f);
          g  = Math.min(255, g * f);
          bl = Math.min(255, bl * f);
        }

        const o = j * 4;
        px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = 255;
      }
    }
    cx.putImageData(data, 0, 0);
  }

  // ── Elvis: reading the grid ─────────────────────────────────────────────────
  // The one TIFF layout the WCS sends (see the header): baseline, uncompressed,
  // one sample, float32 or 16/32-bit integers, tiled or stripped, either byte
  // order. Anything else throws, and a throw is a failed tile drawn from the
  // 30 m source — never a plausible-looking wrong grid.
  function readTiff(buf) {
    const dv = new DataView(buf);
    const bo = dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('not a TIFF');
    const le = bo === 0x4949;
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    if (u16(2) !== 42) throw new Error('not a classic TIFF');
    const ifd = u32(4), n = u16(ifd), tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const size = type === 3 ? 2 : type === 4 ? 4 : 1;
      if (type !== 3 && type !== 4 && type !== 2) continue;
      const at = cnt * size <= 4 ? e + 8 : u32(e + 8);
      if (type === 2) {
        tags[tag] = new TextDecoder().decode(new Uint8Array(buf, at, cnt)).replace(/\0+$/, '');
      } else {
        const v = [];
        for (let k = 0; k < cnt; k++) v.push(type === 3 ? u16(at + k * 2) : u32(at + k * 4));
        tags[tag] = v;
      }
    }
    const one = (t, d) => (tags[t] ? tags[t][0] : d);
    const W = one(256), H = one(257), bits = one(258, 1), fmt = one(339, 1);
    if (one(259, 1) !== 1 || one(277, 1) !== 1) throw new Error('compressed or multi-band TIFF');
    const read = fmt === 3 && bits === 32 ? o => dv.getFloat32(o, le)
               : fmt === 2 && bits === 16 ? o => dv.getInt16(o, le)
               : fmt === 2 && bits === 32 ? o => dv.getInt32(o, le)
               : fmt === 1 && bits === 16 ? o => dv.getUint16(o, le)
               : null;
    if (!read || !W || !H) throw new Error('unsupported TIFF sample type');
    const bpp = bits / 8;
    const nodata = tags[42113] != null ? Number(tags[42113]) : NaN;   // GDAL_NODATA
    const out = new Float32Array(W * H).fill(NaN);
    // Tiles and strips are the same walk with a strip being a tile the full
    // width of the image. An offset or length of 0 is a block never written.
    const tiled = !!tags[322];
    const bw = tiled ? one(322) : W, bh = tiled ? one(323) : one(278, H);
    const offs = tags[tiled ? 324 : 273] || [], lens = tags[tiled ? 325 : 279] || [];
    const across = Math.ceil(W / bw);
    for (let b = 0; b < offs.length; b++) {
      if (!offs[b] || !lens[b]) continue;
      const x0 = (b % across) * bw, y0 = Math.floor(b / across) * bh;
      for (let y = 0; y < bh && y0 + y < H; y++) {
        for (let x = 0; x < bw && x0 + x < W; x++) {
          const o = offs[b] + (y * bw + x) * bpp;
          if (o + bpp > buf.byteLength) continue;
          const v = read(o);
          // 0.0 is this service's hole inside a written block (see the header);
          // a float sentinel or GDAL's declared nodata is anyone's.
          if (v === 0 || v === nodata || !(Math.abs(v) < 1e5)) continue;
          out[(y0 + y) * W + x0 + x] = v;
        }
      }
    }
    return { W, H, data: out };
  }

  const tileLat = (z, y) => {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  const tileLon = (z, x) => x / Math.pow(2, z) * 360 - 180;

  // W, S, E, N of a tile, or null where the 5 m grid cannot have anything.
  function elvisBox(z, x, y) {
    const w = tileLon(z, x), e = tileLon(z, x + 1), n = tileLat(z, y), s = tileLat(z, y + 1);
    const [W, S, E, N] = ELVIS_EXTENT;
    return e < W || w > E || n < S || s > N ? null : [w, s, e, n];
  }

  function elvisUrl(box) {
    return `${ELVIS_WCS}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=1`
         + `&CRS=EPSG:4283&BBOX=${box.map(v => v.toFixed(7)).join(',')}`
         + `&WIDTH=${TILE_PX}&HEIGHT=${TILE_PX}&FORMAT=GeoTIFF`;
  }

  // The WCS grid is evenly spaced in latitude; a Web Mercator tile is not. So
  // each output row takes the grid row at its own latitude — nearest neighbour,
  // which at these zooms moves nothing by more than a pixel, but done properly
  // because it costs one atan per row.
  function toTileRows(g, z, ty, box) {
    const out = new Float32Array(TILE_PX * TILE_PX);
    const [, s, , n] = box;
    for (let py = 0; py < TILE_PX; py++) {
      const lat = tileLat(z, ty + (py + 0.5) / TILE_PX);
      const sr = Math.max(0, Math.min(g.H - 1, Math.floor((n - lat) / (n - s) * g.H)));
      for (let px = 0; px < TILE_PX; px++) {
        const sc = Math.min(g.W - 1, Math.floor(px * g.W / TILE_PX));
        out[py * TILE_PX + px] = g.data[sr * g.W + sc];
      }
    }
    return out;
  }

  // ── Elvis: asking for it ───────────────────────────────────────────────────
  // A decoded-grid LRU (so the relief switch and a pan back cost nothing), a
  // queue with a ceiling on what is in flight, and a breaker for a dead host.
  // Leaflet's own updateWhenIdle is the debounce: no tile is asked for until
  // the map stops moving.
  const elvisGrids = new Map();     // 'z/x/y' → Float32Array | null (no cover)
  const elvisQueue = [];
  let elvisInFlight = 0, elvisFails = 0, elvisTrippedAt = 0;

  const elvisTripped = () => elvisTrippedAt && Date.now() - elvisTrippedAt < ELVIS_TRIP_MS;

  function elvisRemember(k, v) {
    elvisGrids.delete(k);
    elvisGrids.set(k, v);
    if (elvisGrids.size > ELVIS_CACHE_MAX) elvisGrids.delete(elvisGrids.keys().next().value);
  }

  function elvisPump() {
    while (elvisInFlight < ELVIS_IN_FLIGHT && elvisQueue.length) {
      const job = elvisQueue.shift();
      if (job.cancelled()) { job.resolve({ cancelled: true }); continue; }
      elvisInFlight++;
      job.run().then(job.resolve, () => job.resolve({ failed: true }))
        .finally(() => { elvisInFlight--; elvisPump(); });
    }
  }

  // Resolves — never rejects — to { grid } (a Float32Array of tile rows, NaN
  // where the grid is empty), { none } (nothing to ask for), { failed } or
  // { cancelled }.
  function elvisGrid(z, x, y, cancelled) {
    const k = `${z}/${x}/${y}`;
    if (elvisGrids.has(k)) {
      const g = elvisGrids.get(k);
      elvisRemember(k, g);
      return Promise.resolve(g ? { grid: g } : { none: true });
    }
    const box = elvisBox(z, x, y);
    if (!box) return Promise.resolve({ none: true });
    if (elvisTripped()) return Promise.resolve({ failed: true });

    return new Promise(resolve => {
      elvisQueue.push({
        cancelled, resolve,
        run() {
          return fetchElvis(box).then(buf => {
            if (buf == null) throw new Error('Elvis: no answer');
            const g = toTileRows(readTiff(buf), z, y, box);
            let any = false;
            for (let i = 0; i < g.length && !any; i++) any = g[i] === g[i];
            elvisFails = 0;
            elvisRemember(k, any ? g : null);
            return any ? { grid: g } : { none: true };
          }).catch(err => {
            if (++elvisFails >= ELVIS_TRIP_AFTER) elvisTrippedAt = Date.now();
            throw err;
          });
        },
      });
      elvisPump();
    });
  }

  function fetchElvis(box) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), ELVIS_FETCH_MS);
    return fetch(elvisUrl(box), { signal: ctl ? ctl.signal : undefined })
      .then(r => {
        const ct = r.headers.get('content-type') || '';
        // A 200 that is not a TIFF is a service exception in XML — a failure,
        // not an empty answer (roadmap rev 98: a 200 is not an answer).
        if (!r.ok || !/tiff/i.test(ct)) return null;
        return r.arrayBuffer();
      })
      .finally(() => clearTimeout(timer));
  }

  // What each tile on the live overlay was drawn from, for the note. Keyed as
  // Leaflet keys its tiles; entries leave with the tile.
  //   'elvis'  all 5 m      'mixed'  5 m where held, 30 m in the gaps
  //   'none'   no 5 m here  'failed' Elvis did not answer — drawn at 30 m
  const tileKinds = new Map();
  let noteTimer = null;

  function noteTile(key, kind) {
    tileKinds.set(key, kind);
    refreshNoteSoon();
  }

  // The note is the one place that says what is on screen, so it follows the
  // tiles — debounced, and by id rather than a panel rebuild, which would
  // take the slider out from under a drag.
  function refreshNoteSoon() {
    if (noteTimer) return;
    noteTimer = setTimeout(() => {
      noteTimer = null;
      const el = typeof document !== 'undefined' && document.getElementById('map-elev-note');
      if (el) el.innerHTML = api.noteHtml();
    }, 250);
  }

  function elvisSummary() {
    const c = { elvis: 0, mixed: 0, none: 0, failed: 0 };
    for (const k of tileKinds.values()) if (k in c) c[k]++;
    return c;
  }

  // L.TileLayer, with the <img> swapped for a <canvas> we draw ourselves.
  // Everything Leaflet does around a tile — the grid, retention, the
  // maxNativeZoom overzoom that hands us native coordinates and a stretched
  // CSS size — is untouched, which is the whole reason for extending the tile
  // layer rather than inventing a layer.
  // Built on first use rather than at load. `L.TileLayer.extend()` is a call
  // into Leaflet, and running it in this file's IIFE body would make Leaflet a
  // real ordering constraint on a file that otherwise only declares — the one
  // property index.html's script list rests on. Nothing asks for a layer until
  // a map is being built, which is long after every script has parsed.
  let ElevationLayer = null;

  function layerClass() {
    if (ElevationLayer) return ElevationLayer;
    ElevationLayer = L.TileLayer.extend({
    initialize(opts) {
      L.TileLayer.prototype.initialize.call(this, TILE_URL, L.extend({
        attribution: ATTRIB,
        maxNativeZoom: MAX_NATIVE,
        maxZoom: 19,
        className: 'mn-base-elev',
      }, opts || {}));
    },

    onAdd(map) {
      live.add(this);
      if (this.options.elvis) this.on('tileunload', this._mnUnload, this);
      return L.TileLayer.prototype.onAdd.call(this, map);
    },

    onRemove(map) {
      live.delete(this);
      const r = L.TileLayer.prototype.onRemove.call(this, map);
      this.off('tileunload', this._mnUnload, this);
      return r;
    },

    // A tile Leaflet has let go of: its queued Elvis request is dropped rather
    // than fetched for nobody, and it stops counting in the note.
    _mnUnload(e) {
      if (e.tile) e.tile._mnGone = true;
      tileKinds.delete(this._tileCoordsToKey(e.coords));
      refreshNoteSoon();
    },

    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = TILE_PX;
      // Whatever else goes wrong, a tile that never calls done() leaves
      // Leaflet holding a loading counter that never reaches zero.
      const z = this._getZoomForUrl();
      let settled = false, timer = null;
      const finish = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(err || null, tile);
      };
      // The 30 m heights for this tile, handed to `use` to paint. The timer
      // starts here rather than at createTile, so time spent in the Elvis
      // queue is not charged to the terrarium fetch.
      const terrarium = use => {
        timer = setTimeout(() => finish(new Error('terrain tile timed out')), 12000);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // A tile that cannot be read back — CORS withdrawn, a tainted canvas —
          // is a blank tile and an error, never a plausible-looking wrong colour.
          try { use(decodeTerrarium(tile, img)); finish(null); }
          catch (e) { finish(e); }
        };
        img.onerror = () => finish(new Error('terrain tile unavailable'));
        img.src = this.getTileUrl(coords);
      };

      if (!this.options.elvis || z < ELVIS_MIN_Z) {
        terrarium(h => paintHeights(tile, h, z, coords.y));
        return tile;
      }

      // Elvis first; the 30 m tile only where it leaves a gap, so a tile the
      // 5 m grid covers whole costs one request rather than two.
      const key = this._tileCoordsToKey(coords);
      elvisGrid(z, coords.x, coords.y, () => !!tile._mnGone).then(r => {
        if (r.cancelled || tile._mnGone) { finish(new Error('tile left the view')); return; }
        const g = r.grid;
        let full = !!g;
        if (g) for (let i = 0; i < g.length && full; i++) full = g[i] === g[i];
        if (full) {
          try { paintHeights(tile, g, z, coords.y); noteTile(key, 'elvis'); finish(null); }
          catch (e) { finish(e); }
          return;
        }
        noteTile(key, g ? 'mixed' : r.none ? 'none' : 'failed');
        terrarium(h => {
          if (g) for (let i = 0; i < h.length; i++) if (g[i] === g[i]) h[i] = g[i];
          paintHeights(tile, h, z, coords.y);
        });
      });
      return tile;
    },
    });
    return ElevationLayer;
  }

  // ── The overlay, on one map at a time ──────────────────────────────────────
  // The Stations map is the one with a Map display panel to switch it from, and
  // the layer is per-map like every other overlay in this app: attached when
  // the map is built, taken down with it.
  const PANE   = 'mnElevation';
  // Above the base tiles (200) and below the place-name layers that ride with
  // Satellite and Dark (mnBaseLabels, 250) — see the note at the top. Well
  // under the 320–350 band the other overlays share (map-survey.js documents
  // it), because this is ground rather than anything drawn on it.
  const PANE_Z = 245;

  let map = null, overlay = null;

  // The 3-D view drapes the same tiles over its terrain, so every switch that
  // changes what this layer draws has to reach it too. A no-op unless 3-D is
  // actually open — the same shape as addBaseLayers' call to Map3D.baseChanged.
  function syncThreeD() {
    if (typeof Map3D !== 'undefined' && Map3D.elevationChanged) Map3D.elevationChanged();
  }

  function sync() {
    syncThreeD();
    if (!map) return;
    if (state.mapElev) {
      if (!overlay) {
        if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
        overlay = new (layerClass())(L.extend({ pane: PANE, opacity: state.mapElevOpacity },
          source === 'elvis' ? {
            elvis: true,
            attribution: ELVIS_ATTRIB,
            maxNativeZoom: ELVIS_MAX_NATIVE,
            // Leaflet's own debounce: no tile is asked for until the map stops
            // moving, and only a ring of one tile is kept beyond the view.
            updateWhenIdle: true,
            keepBuffer: 1,
          } : {}));
      }
      if (!map.hasLayer(overlay)) overlay.addTo(map);
      overlay.setOpacity(state.mapElevOpacity);
    } else if (overlay) {
      overlay.remove();
      overlay = null;
    }
    refreshNoteSoon();
  }

  // ── The same pixels, somewhere Leaflet is not (#194) ───────────────────────
  // The 3-D view drapes this colouring over its terrain, and it must be *this*
  // colouring rather than a second one that agrees today. The ramp, the band
  // edges, the hillshade and its re-centring are the argument this file makes
  // about what the ground looks like; a copy of them in map-3d.js is a second
  // argument, and the first time the two differ the map is wrong in one of its
  // two modes with nothing on screen to say which.
  //
  // So what is exported is the painter itself. map-3d.js fetches the same tile
  // from the same URL, hands the decoded image here, and gets back the canvas
  // `createTile` would have put on the 2-D map — including whatever the relief
  // switch currently says, because `paint` reads it.
  function paintedTile(img, z, ty) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    paint(c, img, z, ty);
    return c;
  }

  const api = {
    RAMP,
    attribution: ATTRIB,

    // What a consumer outside Leaflet needs to fetch and paint a tile itself:
    // the source, its native ceiling, and the painter. See paintedTile above.
    TILE_PX,
    MAX_NATIVE,
    tileUrl(z, x, y) {
      return TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    },
    paintedTile,

    // The name it answers to. Kept as an export because the Map Generator reads
    // it to say which base maps it does *not* offer.
    NAME: 'Elevation',

    layer(opts) { return new (layerClass())(opts); },

    // zoomend keeps the note honest about the Elvis source's zoom floor, which
    // no tile event would otherwise report — tiles below it are just 30 m.
    attach(m) { map = m; m.on('zoomend', refreshNoteSoon); sync(); },

    detach() {
      if (overlay) overlay.remove();
      overlay = null;
      if (map) map.off('zoomend', refreshNoteSoon);
      map = null;
    },

    active() { return !!state.mapElev; },

    // Off by default and remembered, on MapContours' terms rather than
    // MapSurvey's: it fetches a tile per screenful of terrain the moment it is
    // on, so a cold page load has to cost nothing.
    setEnabled(on) {
      state.mapElev = !!on;
      try { localStorage.setItem('mn-map-elev', on ? 'on' : 'off'); } catch (_) {}
      sync();
      rerenderMapDisplayControls();
      rerenderMapLegend();
    },

    // The whole point of it being an overlay: how much of the ground you want
    // against how much of the map under it. Applied in place — the tiles are
    // already drawn, and opacity is a style rather than a redraw.
    setOpacity(v) {
      const n = Math.max(0.1, Math.min(1, Number(v) || 0));
      state.mapElevOpacity = n;
      try { localStorage.setItem('mn-map-elev-opacity', String(n)); } catch (_) {}
      if (overlay) overlay.setOpacity(n);
      syncThreeD();
    },

    opacity() { return state.mapElevOpacity; },

    noteHtml() {
      if (!state.mapElev) {
        return 'Ground height as colour, over whichever base map is picked — the slider decides '
             + 'which of the two you are mostly looking at.';
      }
      const heights = source === 'elvis'
        ? `<span id="map-elev-source">${api.sourceStatus().html}</span>`
        : 'Heights are above the EGM96 geoid, ~30 m sampling.';
      return `Painted at <strong>${Math.round(state.mapElevOpacity * 100)}%</strong> over the base
              map. ${heights} The bands are the Radio Mobile colour file's own. On Satellite and
              Dark the place names draw over the top of it — on OSM-Topo they are in the tiles, so
              the slider is what brings them back. In the ⛰️ 3-D view the same ramp is draped on
              the terrain, slider and relief switch and all${source === 'elvis'
                ? ', from the ~30 m tiles only' : ''}.`;
    },

    // ── Which heights are painted ────────────────────────────────────────────
    source() { return source; },

    // A new layer rather than a redraw: the source changes the layer's native
    // zoom and attribution, which Leaflet reads once, at construction.
    setSource(v) {
      source = v === 'elvis' ? 'elvis' : 'srtm';
      try { localStorage.setItem('mn-map-elev-src', source); } catch (_) {}
      if (overlay) { overlay.remove(); overlay = null; }
      tileKinds.clear();
      elvisTrippedAt = 0; elvisFails = 0;   // picking it again is asking again
      sync();
      rerenderMapDisplayControls();
    },

    // What is on screen right now, for the note: { kind, html }. kind is
    // 'srtm' | 'zoom' (Elvis picked, below its floor) | 'down' | 'elvis' |
    // 'partial' (some tiles 5 m, some 30 m) | 'none' (Elvis picked, no 5 m in
    // view) | 'loading'.
    sourceStatus() {
      if (source !== 'elvis') return { kind: 'srtm', html: '~30 m SRTM tiles.' };
      const z = map ? map.getZoom() : null;
      if (z != null && z < ELVIS_MIN_Z) {
        return { kind: 'zoom', html: `<strong>Elvis 5 m</strong> from zoom ${ELVIS_MIN_Z} — out here a
          screen pixel is coarser than 30 m, so the ~30 m tiles (EGM96) are what is drawn.` };
      }
      const c = elvisSummary();
      const fine = c.elvis + c.mixed, all = fine + c.none + c.failed;
      const down = elvisTripped() || (c.failed && !fine && !c.none);
      if (down) {
        return { kind: 'down', html: `<strong>Elvis could not be reached</strong> — every tile in
          view fell back to the ~30 m tiles. It is asked again in a minute.` };
      }
      if (!all) return { kind: 'loading', html: 'Asking Elvis for 5 m heights…' };
      const failed = c.failed ? ` ${c.failed} tile${c.failed === 1 ? '' : 's'} could not be fetched
        and are 30 m.` : '';
      if (!fine) {
        return { kind: 'none', html: `<strong>No Elvis 5 m grid here</strong> — the national LiDAR
          compilation does not cover this view, so it is the ~30 m tiles (EGM96).${failed}` };
      }
      const kind = fine === all && !c.mixed ? 'elvis' : 'partial';
      const gaps = c.mixed ? ', and the gaps inside partly covered tiles,' : '';
      const rest = kind === 'elvis' ? '' : ` The rest${gaps} fall back to the ~30 m tiles (EGM96).`;
      return { kind, html: `<strong>Elvis 5 m LiDAR DEM</strong> (Geoscience Australia, AHD) on
        ${fine} of ${all} tile${all === 1 ? '' : 's'} in view${c.mixed ? `, ${c.mixed} of them
        partly` : ''}.${rest}${failed}` };
    },

    // Read by the check, which answers the WCS itself through page.route —
    // so the fetch, the content-type test and the reader under test are real.
    _elvisReset() { elvisGrids.clear(); elvisTrippedAt = 0; elvisFails = 0; },
    _elvisUrl(z, x, y) { const b = elvisBox(z, x, y); return b ? elvisUrl(b) : null; },
    _readTiff: readTiff,

    // The hex a height is painted, for anything that wants to agree with this
    // ramp without drawing tiles — the peak markers, a legend, a key.
    colourAt(m) { return m == null || isNaN(m) ? RAMP[0].hex : RAMP[bandOf(m)].hex; },

    relief() { return relief; },

    // Every instance on every map redraws. `redraw()` is Leaflet's own and
    // re-runs createTile for the tiles it is holding.
    setRelief(on) {
      relief = !!on;
      try { localStorage.setItem('mn-elev-relief', relief ? 'on' : 'off'); }
      catch (_) { /* private browsing — the setting still holds this session */ }
      for (const l of live) l.redraw();
      // The 3-D drape is painted through the same function, so its tiles are
      // stale in exactly the same way — and MapLibre will not refetch a URL it
      // already holds, so that side reloads the source rather than redrawing.
      syncThreeD();
    },

    // The ramp as a legend strip, drawn highest band first the way a legend is
    // read — and the way the colour file itself is written.
    rampHtml() {
      return `<ul class="elev-ramp">${RAMP.map((b, i) => {
        const next = RAMP[i + 1];
        const label = next ? `${b.m}–${next.m} m` : `${b.m} m and above`;
        return `<li><i style="--dot:${b.hex}"></i><span>${label}</span></li>`;
      }).reverse().join('')}</ul>`;
    },
  };
  return api;
})();
if (typeof window !== 'undefined') window.MapElevation = MapElevation;
