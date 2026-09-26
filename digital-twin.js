// MegaNet — digital-twin.js
//
//   DigitalTwin   the Digital Twin tab: one station's patch of ground in three
//                 dimensions — the real relief under it, the aerial imagery
//                 draped over it, a 2 m × 300 mm pole where the station stands
//                 and a 1.75 m figure beside it for scale — to orbit, and to
//                 walk about in at eye height. Exports the scene as a .glb for
//                 Blender.
//
// After core.js and terrain.js, before init.js — index.html holds the order and
// the reasons. Reaches back to core.js for state, esc, escAttr, announce,
// cssVar, registerTabTeardown, KM_PER_DEG_LAT and kmPerDegLon; across to
// terrain.js for the ~30 m fallback ground, to elvis.js for the AHD height at
// the pin, and to app.js for switchTab, goToStation and primaryRole (from
// inline handlers). Every one of those is a runtime call from inside this
// file's own functions, so its position among the modules is free. Nothing
// executes at load (`npm run toplevel`).
//
// ── Why a tab of its own, and not a mode on the Stations map ─────────────────
//
// The Stations map's 3-D view (map-3d.js) is the whole network on the ground —
// tens of kilometres of terrain at ~30 m, links and pins draped over it, and a
// camera that stays a map camera: it tilts and turns, but it never goes below
// the terrain and it never stands on it. This is the other scale entirely: a
// few hundred metres around one site, the ground to 1 m where the State holds
// LiDAR, and a camera that can be put at a technician's eye height beside the
// pole. Those are different renderers for different questions, and the honest
// thing is two of them rather than one that half-answers both.
//
// ── Where the ground comes from, in order ─────────────────────────────────
//
// 1. **Queensland's own elevation service** — `Elevation/QldDem`, an ArcGIS
//    ImageServer on spatial-img.information.qld.gov.au: the State's public
//    LiDAR DTMs at 0.5–1 m where they exist, SRTM elsewhere, bare-earth, in
//    AHD. It is the same Queensland LiDAR that Elvis (elevation.fsdf.org.au)
//    lists under "QLD Government", served by the agency that flew it. One
//    `exportImage` request answers with a GeoTIFF of 32-bit floats for the
//    whole patch — 201 × 201 samples in ~250 KB, uncompressed and tiled, which
//    a hundred lines below read without a library. CORS reflects any origin,
//    including `null` for file://. Nothing is asked for outside the service's
//    own extent, and a patch it holds nothing for comes back as an empty TIFF
//    (tile byte counts of zero), which is treated as "no data here", never as
//    flat ground at 0 m.
//
//    Why not Elvis's own API for this: Elvis exposes one keyless call a browser
//    can make — the height at a point, ~2.5 s each, no batch (elvis.js measured
//    it). 40,000 samples is not a request it can answer, and its bulk download
//    is a job that arrives by email. So Elvis gives this tab the one number it
//    is best at — the AHD height at the pin, and which dataset it came from —
//    and the State's raster service gives the surface.
//
// 2. **AWS Terrain Tiles** via terrain.js — the ~30 m SRTM every profile in
//    this app reads — wherever Queensland's service has nothing: New South
//    Wales stations, the sea, a service outage. A patch built on these says so
//    in the notes, because the difference is the whole point: at 30 m the
//    channel a gauge sits in is smoothed away and the bank it is on is a
//    gentle slope. terrain.js's rule holds here too — a ground that could not
//    be had is said out loud, never drawn flat.
//
// The imagery follows the same shape: Queensland's aerial program
// (`Basemaps/LatestStateProgram_AllUsers`, 10–20 cm in towns, coarser in the
// bush, Planet satellite where nothing was flown) as one `exportImage` JPEG of
// the patch, then Esri World Imagery tiles stitched on a canvas where that is
// blank or unreachable, then a height ramp where neither can be had.
//
// ── The renderer, and why it is imported rather than listed ──────────────────
//
// three.js is ~750 KB of WebGL. Like MapLibre for the 3-D map it is fetched on
// the first visit to this tab and never for a session that does not come here.
// Unlike MapLibre it has no UMD build any more — three r160 was the last, and
// it prints a deprecation warning on every load — so it is brought in with a
// dynamic `import()` of the pinned ESM build. That is the one place this app
// uses a module: `import()` is a call from inside a function, not a change to
// what kind of page this is (#129) — index.html stays classic scripts in one
// global scope, and `npm run toplevel`, `names` and `smoke` all parse and run
// this file as such. The build imports its core by a relative path, so no
// import map is needed and file:// still works.
//
// ── Coordinates ──────────────────────────────────────────────────────────────
//
// The scene is in metres, y up, with the origin on the ground at the station:
// x east, z south (three.js is right-handed with y up, so north is −z). The
// lat/lon → metres step is the equirectangular one core.js already carries
// (KM_PER_DEG_LAT, kmPerDegLon), which over a 1.6 km patch is exact to a few
// centimetres. Heights are AHD from Queensland's service and EGM96 from the
// tiles — the same metre-or-so apart terrain.js's header describes — and the
// panel names which one the ground is standing on.
//
// Vertical exaggeration scales the relief only. The pole is 2.000 m tall and
// 0.300 m across at every setting, and the figure 1.75 m — they are the ruler.
const DigitalTwin = (function () {
  // ── the renderer ──
  // r185.1 is the last release that ships a minified ESM build (0.186 dropped
  // `three.module.min.js` and ships 2 MB of unminified source instead). The
  // file imports `./three.core.min.js` beside it, so two fetches, ~750 KB.
  const LIB_VER = '0.185.1';
  const LIB_URL = `https://unpkg.com/three@${LIB_VER}/build/three.module.min.js`;

  // ── the ground ──
  const QLD_HOST = 'https://spatial-img.information.qld.gov.au/arcgis/rest/services';
  const QLD_DEM  = `${QLD_HOST}/Elevation/QldDem/ImageServer/exportImage`;
  const QLD_IMG  = `${QLD_HOST}/Basemaps/LatestStateProgram_AllUsers/ImageServer/exportImage`;
  const ESRI_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  // The two Queensland services' own extents (their `extent` in Web Mercator,
  // taken back to degrees and rounded outward). A patch outside is not asked
  // for: the answer is known, and the request would be a wasted round trip on
  // a network that may be metering them.
  const QLD_DEM_BOX = { west: 137.8, east: 160.1, south: -29.7, north: -9.0 };
  const QLD_IMG_BOX = { west: 137.6, east: 153.9, south: -29.6, north: -8.9 };

  const ATTR_QLD_DEM = 'Ground: Queensland Government (Department of Natural Resources and Mines, '
                     + 'Manufacturing, and Regional and Rural Development) elevation service — LiDAR DTM '
                     + 'and SRTM, AHD; includes material © Geoscience Australia';
  const ATTR_QLD_IMG = 'Imagery: © State of Queensland (Department of Natural Resources and Mines, '
                     + 'Manufacturing and Regional and Rural Development) — aerial photography; '
                     + 'Planet Labs satellite where none was flown';
  const ATTR_ESRI    = 'Imagery: Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

  // ── the objects ──
  const POLE_H     = 2.0;     // metres — the brief: 2 m high
  const POLE_R     = 0.15;    // metres — 300 mm across
  const FIGURE_H   = 1.75;    // metres — a person, for scale
  const EYE_H      = 1.70;    // metres — walk mode's camera
  const SIZES      = [200, 400, 800, 1600];   // patch widths offered, metres
  const N          = 201;     // samples per side; odd, so the centre sample IS the station
  const FETCH_MS   = 45000;   // a raster that has not arrived by now has failed
  const CACHE_MAX  = 6;       // ground grids kept decoded — 162 KB each
  const IMAGE_CACHE_BYTES = 40 * 1024 * 1024;   // decoded imagery kept — one wide patch and a few narrow ones

  // ── module state ──
  // `tw.s` is the remembered settings (localStorage); the rest is the live scene
  // and is thrown away on teardown. THREE is the imported module namespace,
  // kept for the session once it has arrived.
  let THREE = null;
  let libP  = null;
  let libErr = null;

  const tw = {
    s: null,           // settings, loaded on first render
    stationId: null,   // the station on screen (or about to be)
    query: '',         // the station finder's text
    seq: 0,            // build sequence; an async step that finds it moved stands down
    status: '',        // the status line
    notes: [],         // the warnings under it
    ground: null,      // { elev: Float32Array N*N (AHD), source, resolution_m, attribution, holes, filled, min, max, h0 }
    image: null,       // { canvas, source, attribution, mpp } or null
    elvis: null,       // Elvis.at() result for the pin, or null
    live: false,       // a renderer exists
    frames: 0,         // frames actually drawn (the check reads it to see the loop stop)
    picked: null,      // the last ground point clicked: { x, z, h }
    paths: null,       // the radio paths drawn: { count, source, list }
    hooks: null,       // set when embedded in the Stations map (map-twin.js): { leave }
  };

  // Ground under a far station that has no recorded height, read off the
  // tiles once and kept for the session — a path's far end is the same place
  // every time it is drawn.
  const farHeightCache = new Map();

  // The live scene — everything the teardown has to dispose of.
  const sc = {
    renderer: null, scene: null, camera: null, canvas: null, stage: null,
    terrain: null, wire: null, pole: null, band: null, figure: null, label: null, paths: null,
    sun: null, hemi: null, texture: null, raf: 0, ro: null, dirty: false,
    off: [],          // listener removers
  };

  // The camera rig: orbit about a target, or walk on the ground.
  const rig = {
    mode: 'orbit',
    target: null, radius: 26, theta: 0.65, phi: 1.05,   // orbit: spherical about target
    px: 3, pz: 6, yaw: -0.45, pitch: -0.08,             // walk: feet position and look
    keys: new Set(),
    pointers: new Map(),
    pinch: null,
  };

  const groundCache = new Map();   // `${lat},${lon}|${size}` → tw.ground
  const imageCache  = new Map();   // the same key → tw.image

  // ── settings ───────────────────────────────────────────────────────────────

  const DEFAULTS = { size: 400, exag: 1, imagery: true, figure: true, label: true, wire: false };

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('mn-twin') || '{}') || {}; } catch (_) { s = {}; }
    const out = { ...DEFAULTS };
    if (SIZES.includes(Number(s.size))) out.size = Number(s.size);
    const ex = Number(s.exag);
    if (isFinite(ex) && ex >= 1 && ex <= 3) out.exag = ex;
    for (const k of ['imagery', 'figure', 'label', 'wire']) if (typeof s[k] === 'boolean') out[k] = s[k];
    return out;
  }

  function saveSettings() {
    try { localStorage.setItem('mn-twin', JSON.stringify(tw.s)); } catch (_) {}
  }

  function S() { if (!tw.s) tw.s = loadSettings(); return tw.s; }

  // ── the station ────────────────────────────────────────────────────────────

  function stationById(id) {
    return (state.data && state.data.stations || []).find(s => s.id === id) || null;
  }

  // The station on screen: the one picked here, else the Stations tab's
  // selection, else nothing — never a guess. A station with no position cannot
  // be built and is said to be that.
  function currentStation() {
    if (tw.stationId) {
      const s = stationById(tw.stationId);
      if (s) return s;
      tw.stationId = null;
    }
    if (state.selectedId) {
      const s = stationById(state.selectedId);
      if (s) { tw.stationId = s.id; return s; }
    }
    return null;
  }

  function located(s) { return !!s && isFinite(s.lat) && isFinite(s.lon); }

  // ── geometry on the ground ─────────────────────────────────────────────────
  // Metres east and south of the station, equirectangular: exact to centimetres
  // over the widest patch offered. `z` is south because three.js is y-up and
  // right-handed, so north has to be −z.
  function metresPerDegLon(lat) { return kmPerDegLon(lat) * 1000; }
  function metresPerDegLat()    { return KM_PER_DEG_LAT * 1000; }

  function localXZ(lat, lon, lat0, lon0) {
    return { x: (lon - lon0) * metresPerDegLon(lat0), z: -(lat - lat0) * metresPerDegLat() };
  }

  // The patch: `size` metres square, centred on the station.
  function patchBox(lat0, lon0, size) {
    const half = size / 2;
    const dLat = half / metresPerDegLat();
    const dLon = half / metresPerDegLon(lat0);
    return { west: lon0 - dLon, east: lon0 + dLon, south: lat0 - dLat, north: lat0 + dLat, half, size };
  }

  function insideBox(box, lim) {
    return box.west >= lim.west && box.east <= lim.east && box.south >= lim.south && box.north <= lim.north;
  }

  // Ground height (AHD, metres) at a scene point, bilinear in the N × N grid.
  // Row 0 is the north edge (z = −half), column 0 the west edge (x = −half) —
  // the raster's own order. Outside the patch, the station's own height: the
  // camera clamp and the figure both ask, and neither should fall off the edge
  // of the world.
  function heightAt(x, z) {
    const g = tw.ground;
    if (!g) return 0;
    const step = g.size / (N - 1);
    const fx = Math.min(N - 1, Math.max(0, (x + g.half) / step));
    const fy = Math.min(N - 1, Math.max(0, (z + g.half) / step));
    const ix = Math.min(N - 2, Math.floor(fx)), iy = Math.min(N - 2, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy;
    const e = g.elev;
    const a = e[iy * N + ix], b = e[iy * N + ix + 1], c = e[(iy + 1) * N + ix], d = e[(iy + 1) * N + ix + 1];
    const v = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    return isFinite(v) ? v : g.h0;
  }

  // The same, as a scene y: relief from the station, exaggerated.
  function yAt(x, z) {
    const g = tw.ground;
    if (!g) return 0;
    return (heightAt(x, z) - g.h0) * S().exag;
  }

  // ── the GeoTIFF the State answers with ─────────────────────────────────────
  // ArcGIS `exportImage?format=tiff&pixelType=F32` is one of the plainest TIFFs
  // there is: one band, 32-bit IEEE floats, no compression, laid out in
  // 128 × 128 tiles (or strips for a small request), little-endian, with GDAL's
  // NoData tag. That is a hundred lines to read and nothing to depend on. It
  // refuses anything else rather than guessing — a compressed or integer TIFF
  // is a service that changed, and the fallback ground is the honest answer.
  //
  // A patch entirely outside the data comes back as a TIFF whose tile byte
  // counts are all zero. Those cells are NaN here, and NaN is what "no data"
  // means everywhere below.
  function readTiffF32(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 16) throw new Error('not a TIFF');
    const bom = dv.getUint16(0, false);
    const le = bom === 0x4949;
    if (!le && bom !== 0x4D4D) throw new Error('not a TIFF');
    if (dv.getUint16(2, le) !== 42) throw new Error('not a classic TIFF');
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = dv.getUint16(e, le), typ = dv.getUint16(e + 2, le), cnt = dv.getUint32(e + 4, le);
      const sz = SZ[typ] || 1;
      const at = sz * cnt <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      const vals = new Array(cnt);
      for (let k = 0; k < cnt; k++) {
        const p = at + k * sz;
        vals[k] = typ === 3 ? dv.getUint16(p, le)
                : typ === 4 ? dv.getUint32(p, le)
                : typ === 11 ? dv.getFloat32(p, le)
                : typ === 12 ? dv.getFloat64(p, le)
                : typ === 16 ? Number(dv.getBigUint64(p, le))
                : dv.getUint8(p);
      }
      tags[tag] = vals;
    }
    const W = tags[256] && tags[256][0], H = tags[257] && tags[257][0];
    const bits = tags[258] ? tags[258][0] : 0;
    const comp = tags[259] ? tags[259][0] : 1;
    const fmt  = tags[339] ? tags[339][0] : 1;
    const spp  = tags[277] ? tags[277][0] : 1;
    if (!(W > 0 && H > 0)) throw new Error('TIFF has no size');
    if (bits !== 32 || fmt !== 3 || spp !== 1) throw new Error('TIFF is not one band of 32-bit floats');
    if (comp !== 1) throw new Error('TIFF is compressed');
    // GDAL_NODATA (42113) is ASCII, "-9999\0". Anything at or below it, and any
    // wildly negative value, is a hole: no ground in Australia is 9 km down.
    let nodata = -9999;
    if (tags[42113]) {
      const s = String.fromCharCode(...tags[42113]).replace(/\0[\s\S]*$/, '').trim();
      const v = Number(s);
      if (isFinite(v)) nodata = v;
    }
    const isHole = v => !isFinite(v) || v <= nodata + 1e-3 || v < -9000;
    // GeoTIFF's own statement of where the pixels are: ModelPixelScale
    // (33550, the size of a pixel in degrees, x then y) and ModelTiepoint
    // (33922, raster (0,0,0) → model (lon, lat, 0) of the top-left corner).
    // Read so the caller can check the service put the pixels where they
    // were asked for — see qldGround.
    const pixelScale = tags[33550] && tags[33550].length >= 2 ? [tags[33550][0], tags[33550][1]] : null;
    const tiepoint   = tags[33922] && tags[33922].length >= 6 ? [tags[33922][3], tags[33922][4]] : null;
    const out = new Float32Array(W * H).fill(NaN);
    if (tags[324]) {                                    // tiled
      const tw_ = tags[322][0], th = tags[323][0];
      const offs = tags[324], counts = tags[325] || [];
      const ntx = Math.ceil(W / tw_);
      for (let t = 0; t < offs.length; t++) {
        if (!counts[t]) continue;                       // an empty tile: no data
        const tx = t % ntx, ty = Math.floor(t / ntx);
        const base = offs[t];
        if (base + tw_ * th * 4 > buf.byteLength) throw new Error('TIFF tile runs past the file');
        for (let r = 0; r < th; r++) {
          const y = ty * th + r;
          if (y >= H) break;
          for (let c = 0; c < tw_; c++) {
            const x = tx * tw_ + c;
            if (x >= W) break;
            const v = dv.getFloat32(base + (r * tw_ + c) * 4, le);
            out[y * W + x] = isHole(v) ? NaN : v;
          }
        }
      }
    } else if (tags[273]) {                             // stripped
      const rps = tags[278] ? tags[278][0] : H;
      const offs = tags[273], counts = tags[279] || [];
      for (let s = 0; s < offs.length; s++) {
        if (!counts[s]) continue;
        const rows = Math.min(rps, H - s * rps);
        const base = offs[s];
        if (base + rows * W * 4 > buf.byteLength) throw new Error('TIFF strip runs past the file');
        for (let r = 0; r < rows; r++) {
          for (let x = 0; x < W; x++) {
            const v = dv.getFloat32(base + (r * W + x) * 4, le);
            out[(s * rps + r) * W + x] = isHole(v) ? NaN : v;
          }
        }
      }
    } else {
      throw new Error('TIFF has neither tiles nor strips');
    }
    return { W, H, data: out, pixelScale, tiepoint };
  }

  // ── fetching, bounded ──────────────────────────────────────────────────────
  function fetchBytes(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    return fetch(url, { signal: ctl ? ctl.signal : undefined })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .finally(() => clearTimeout(timer));
  }

  // One more go, after a breath, for the two big requests: a field laptop's
  // link drops a request now and then, and the difference between "the State
  // has no data here" and "one packet went missing" is worth one retry — not
  // a loop, which on a host that is genuinely down would only hold the tab.
  // A request that ran the full FETCH_MS and was cut off is not retried:
  // that host is answering slowly or not at all, and a second wait would
  // only double the time the stage says "Reading…" for.
  function timedOut(err) {
    return !!err && (err.name === 'AbortError' || err.timeout === true);
  }
  function once(fn) {
    return fn().catch(err => {
      if (timedOut(err)) throw err;
      return new Promise(res => setTimeout(res, 800)).then(fn).catch(() => { throw err; });
    });
  }

  // What a failed request is called in the notes, from the error it threw.
  function failureWord(err) {
    if (timedOut(err)) return 'it timed out';
    const m = (err && err.message) || '';
    if (/^HTTP \d+/.test(m)) return `it answered ${m}`;
    if (/extent|answered/.test(m)) return m;
    return 'it could not be reached';
  }

  // One <img>, decoded, with CORS asked for — the pixels are read back out of a
  // canvas straight after, and without it the canvas is tainted and
  // getImageData / toBlob throw. Rejects on error or timeout; never hangs.
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let done = false;
      const finish = (ok, v) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve(v) : reject(v); };
      const timer = setTimeout(() => finish(false, Object.assign(new Error('image timed out'), { timeout: true })), FETCH_MS);
      img.crossOrigin = 'anonymous';
      img.onload  = () => finish(true, img);
      img.onerror = () => finish(false, new Error('image unavailable'));
      img.src = url;
    });
  }

  // ── the ground, from the State ─────────────────────────────────────────────
  // The request box is the patch grown by half a sample on every side, so that
  // the N pixel *centres* the service returns land exactly on the N mesh
  // vertices — the middle one on the station itself — rather than half a
  // sample off. (An ImageServer samples a pixel at its centre, and `size`
  // pixels over a bbox have their centres at bbox.min + (i + ½) · pixel.)
  //
  // `adjustAspectRatio=false`, and it is load-bearing. A patch that is square
  // in metres is not square in degrees — a degree of longitude is cos(lat) of
  // a degree of latitude — and the ImageServer's default (`true`) quietly
  // widens the shorter axis so the pixels come out square in the image's own
  // units: measured live, a 402 m box at Brisbane came back 450 m north to
  // south, every row 2.24 m apart on the ground where the mesh had them at
  // 2.00 m, the centre pixel still on the station and nothing to see. With
  // the parameter off the service honours the box as asked; qldGround checks
  // the GeoTIFF's own pixel scale against the request rather than trusting
  // that, and a raster that came back a different shape is a failure, not a
  // ground.
  function demBox(box) {
    const step = box.size / (N - 1);
    const hLat = step / 2 / metresPerDegLat();
    const hLon = step / 2 / metresPerDegLon((box.south + box.north) / 2);
    return { west: box.west - hLon, south: box.south - hLat, east: box.east + hLon, north: box.north + hLat };
  }

  function qldDemUrl(box) {
    const b = demBox(box);
    const bb = [b.west, b.south, b.east, b.north].map(v => v.toFixed(8)).join(',');
    return `${QLD_DEM}?bbox=${bb}&bboxSR=4326&imageSR=4326&size=${N},${N}&adjustAspectRatio=false`
         + '&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation&f=image';
  }

  function qldImgUrl(box, px) {
    const bb = [box.west, box.south, box.east, box.north].map(v => v.toFixed(8)).join(',');
    return `${QLD_IMG}?bbox=${bb}&bboxSR=4326&imageSR=4326&size=${px},${px}&adjustAspectRatio=false&format=jpg&f=image`;
  }

  // The State's raster, as an N × N grid, or the reason there is none — and
  // the reasons are kept apart, because they mean different things to the
  // person reading the notes: `outside` and `empty` say the State holds
  // nothing here, `failed` says a request went wrong and Rebuild is worth
  // pressing. A patch with *some* holes comes back with them as NaN for the
  // caller to fill.
  //   { kind: 'ok', elev, holes } | { kind: 'outside' | 'empty' | 'failed', error? }
  function qldGround(box) {
    if (!insideBox(box, QLD_DEM_BOX)) return Promise.resolve({ kind: 'outside' });
    if (typeof fetch !== 'function') return Promise.resolve({ kind: 'failed', error: 'no fetch' });
    return once(() => fetchBytes(qldDemUrl(box))).then(buf => {
      const t = readTiffF32(buf);
      if (t.W !== N || t.H !== N) throw new Error(`it answered ${t.W} × ${t.H} pixels, not ${N} × ${N}`);
      // The pixels have to be where they were asked for, on both axes, or
      // the rows land on the wrong vertices — see qldDemUrl. Half a percent is
      // rounding; the aspect snap this guards against is 4–15%.
      const b = demBox(box);
      const wantX = (b.east - b.west) / N, wantY = (b.north - b.south) / N;
      if (t.pixelScale && (Math.abs(t.pixelScale[0] - wantX) > wantX * 0.005
                        || Math.abs(t.pixelScale[1] - wantY) > wantY * 0.005)) {
        throw new Error('it answered a different extent from the one asked for');
      }
      if (t.tiepoint && (Math.abs(t.tiepoint[0] - b.west) > wantX || Math.abs(t.tiepoint[1] - b.north) > wantY)) {
        throw new Error('it answered a different extent from the one asked for');
      }
      let holes = 0;
      for (let i = 0; i < t.data.length; i++) if (!isFinite(t.data[i])) holes++;
      if (holes === t.data.length) return { kind: 'empty' };
      return { kind: 'ok', elev: t.data, holes };
    }).catch(err => ({ kind: 'failed', error: err }));
  }

  // ── the ground, from the tiles ─────────────────────────────────────────────
  // terrain.js's lattice at about the tiles' own spacing, then bilinear up to
  // N × N. Sampling the tiles at N × N directly would be nearest-pixel at
  // 30 m — a staircase of 15 flat steps across the patch — where a bilinear
  // lift of a coarse lattice is at least a surface.
  function tileGround(box) {
    if (typeof Terrain === 'undefined') return Promise.resolve(null);
    const n = Math.max(9, Math.min(65, Math.ceil(box.size / 30) + 1));
    return Terrain.grid({ west: box.west, east: box.east, south: box.south, north: box.north }, n, n)
      .then(r => {
        if (!r || !r.ok) return null;
        return { elev: upsample(r.elev, r.nx, r.ny, N), resolution_m: r.resolution_m, attribution: r.attribution };
      })
      .catch(() => null);
  }

  // Bilinear resample of an nx × ny grid (row 0 north) to an N × N one over the
  // same box. A NaN in the source stays a hole rather than bleeding: a corner
  // that is NaN takes its cell's nearest finite neighbour, and a cell with no
  // finite corner is NaN.
  function upsample(src, nx, ny, n) {
    const out = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const fy = (j / (n - 1)) * (ny - 1);
      const iy = Math.min(ny - 2, Math.floor(fy)), ty = fy - iy;
      for (let i = 0; i < n; i++) {
        const fx = (i / (n - 1)) * (nx - 1);
        const ix = Math.min(nx - 2, Math.floor(fx)), tx = fx - ix;
        let a = src[iy * nx + ix], b = src[iy * nx + ix + 1], c = src[(iy + 1) * nx + ix], d = src[(iy + 1) * nx + ix + 1];
        const fin = [a, b, c, d].filter(isFinite);
        if (fin.length === 0) { out[j * n + i] = NaN; continue; }
        if (fin.length < 4) {
          const m = fin.reduce((s, v) => s + v, 0) / fin.length;
          if (!isFinite(a)) a = m; if (!isFinite(b)) b = m; if (!isFinite(c)) c = m; if (!isFinite(d)) d = m;
        }
        out[j * n + i] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      }
    }
    return out;
  }

  // The ground for a patch, from the best source that answers, with what it is
  // and what was filled from where written on it. Resolves — never rejects —
  // to null only when nothing at all could be had, which the caller says out
  // loud rather than drawing.
  function groundFor(box) {
    const key = `${box.south.toFixed(6)},${box.west.toFixed(6)}|${box.size}`;
    if (groundCache.has(key)) return Promise.resolve(groundCache.get(key));
    return qldGround(box).then(q => {
      if (q.kind === 'ok' && q.holes === 0) return finishGround(box, q.elev, 'qld', 0, 0, null, q);
      // Holes, or nothing: the tiles fill what the State does not hold.
      return tileGround(box).then(t => {
        if (q.kind === 'ok') {
          let filled = 0;
          if (t) {
            for (let i = 0; i < q.elev.length; i++) {
              if (!isFinite(q.elev[i]) && isFinite(t.elev[i])) { q.elev[i] = t.elev[i]; filled++; }
            }
          }
          return finishGround(box, q.elev, 'qld', q.holes, filled, t, q);
        }
        if (!t) return null;
        return finishGround(box, t.elev, 'srtm', 0, 0, t, q);
      });
    }).then(g => {
      if (g) {
        groundCache.set(key, g);
        while (groundCache.size > CACHE_MAX) groundCache.delete(groundCache.keys().next().value);
      }
      return g;
    });
  }

  function finishGround(box, elev, source, holes, filled, tiles, q) {
    const c = elev[Math.floor(N / 2) * N + Math.floor(N / 2)];
    let min = Infinity, max = -Infinity, nan = 0;
    for (let i = 0; i < elev.length; i++) {
      const v = elev[i];
      if (!isFinite(v)) { nan++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return null;
    // A hole nothing could fill is drawn at the station's own level, and
    // counted — flat ground is the one lie this app is careful never to tell
    // silently, so the count goes in the notes.
    const h0 = isFinite(c) ? c : (min + max) / 2;
    if (nan) for (let i = 0; i < elev.length; i++) if (!isFinite(elev[i])) elev[i] = h0;
    const step = box.size / (N - 1);
    return {
      elev, size: box.size, half: box.half, source, h0, min, max, holes, filled, unfilled: nan,
      // Why the State's raster is not the whole answer, when it is not:
      // 'outside' | 'empty' | 'failed' (or 'ok'), and for a failure, what
      // went wrong in the notes' own words.
      qld: (q && q.kind) || 'ok',
      qldError: q && q.kind === 'failed' ? failureWord(q.error) : null,
      sample_m: step,
      // What the surface can honestly claim: the State's LiDAR is 0.5–1 m
      // (and SRTM where it holds none — the service does not say which per
      // pixel, so the note says both), the tiles ~30 m whatever they were
      // sampled at.
      native_m: source === 'qld' ? 1 : (tiles && tiles.resolution_m) || 30,
      datum: source === 'qld' ? 'AHD' : 'EGM96',
      attribution: source === 'qld'
        ? (filled ? `${ATTR_QLD_DEM}; gaps: ${(tiles && tiles.attribution) || ''}` : ATTR_QLD_DEM)
        : (tiles && tiles.attribution) || '',
    };
  }

  // ── the imagery ────────────────────────────────────────────────────────────
  // Texture width for a patch: 1024 px is 0.4 m/px over 400 m, which is near
  // what the aerial program resolves outside the towns; the two wide patches
  // take 2048 so a 1.6 km square is not 1.6 m blocks.
  function texturePx(size) { return size > 400 ? 2048 : 1024; }

  // The State answers a patch it has no photography for with a plain grey
  // sheet rather than an error. Sixty-four pixels on an 8 × 8 lattice across
  // the sheet tell the two apart: real ground has variance, a "no data" fill
  // has none. A lattice, not a stride through the buffer — a stride that is
  // a multiple of the width walks down one column, and a sheet whose west
  // edge is sea or the grey pad beyond the data reads as blank.
  function isBlank(canvas) {
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    let min = 255, max = 0;
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 8; i++) {
        const x = Math.floor((i + 0.5) * w / 8), y = Math.floor((j + 0.5) * h / 8);
        const d = cx.getImageData(x, y, 1, 1).data;
        const v = (d[0] + d[1] + d[2]) / 3;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return max - min < 6;
  }

  function drawToCanvas(img, px) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = px;
    cv.getContext('2d').drawImage(img, 0, 0, px, px);
    return cv;
  }

  // The State's photography, or why not — on qldGround's terms:
  //   { kind: 'ok', canvas, … } | { kind: 'outside' | 'blank' | 'failed' }
  function qldImagery(box, px) {
    if (!insideBox(box, QLD_IMG_BOX)) return Promise.resolve({ kind: 'outside' });
    return once(() => loadImage(qldImgUrl(box, px))).then(img => {
      const cv = drawToCanvas(img, px);
      if (isBlank(cv)) return { kind: 'blank' };
      return { kind: 'ok', canvas: cv, source: 'qld', attribution: ATTR_QLD_IMG, mpp: box.size / px };
    }).catch(() => ({ kind: 'failed' }));
  }

  // Esri's tiles, stitched onto one canvas the patch's size. Web Mercator, as
  // the tiles are; within 1.6 km the difference between a Mercator square and
  // a lat/lon one is a uniform scale, which mapping the box's corners to the
  // texture's corners already absorbs.
  function tileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function tileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  // Zoom: fine enough that a tile pixel is no coarser than a texel, then
  // coarser until the patch fits in the tile budget — a 1.6 km patch at z18
  // is 170 tiles, at z17 it is 36, and 1 m texels over 1.6 km is still a
  // drape and not a mosaic of requests.
  const ESRI_MAX_TILES = 64;
  function esriImagery(box, px) {
    const midLat = (box.south + box.north) / 2;
    const want = box.size / px;                                   // metres per texel
    const mpp = zz => 156543.03392 * Math.cos(midLat * Math.PI / 180) / Math.pow(2, zz);
    let z = 0;
    while (z < 19 && mpp(z) > want) z++;
    let x0, x1, y0, y1, cols, rows;
    for (;;) {
      x0 = tileX(box.west, z); x1 = tileX(box.east, z);
      y0 = tileY(box.north, z); y1 = tileY(box.south, z);
      cols = Math.floor(x1) - Math.floor(x0) + 1; rows = Math.floor(y1) - Math.floor(y0) + 1;
      if (cols * rows <= ESRI_MAX_TILES || z === 0) break;
      z--;
    }
    const jobs = [];
    for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++) {
      for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
        const url = ESRI_TILE.replace('{z}', z).replace('{y}', ty).replace('{x}', tx);
        jobs.push(loadImage(url).then(img => ({ img, tx, ty }), () => null));
      }
    }
    return Promise.all(jobs).then(tiles => {
      const got = tiles.filter(Boolean);
      if (!got.length) return null;
      const cv = document.createElement('canvas');
      cv.width = cv.height = px;
      const cx = cv.getContext('2d');
      // White under the tiles, so a tile that did not arrive is a white gap
      // — as the note says — rather than the black a transparent texel
      // renders as on an opaque material, and composites to in the JPEG.
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, px, px);
      const sx = px / (x1 - x0), sy = px / (y1 - y0);            // texels per tile unit
      for (const t of got) {
        cx.drawImage(t.img, (t.tx - x0) * sx, (t.ty - y0) * sy, sx + 0.5, sy + 0.5);
      }
      // What the drape actually resolves: the tile's pixel, where that is
      // coarser than the texel it was drawn into.
      return { canvas: cv, source: 'esri', attribution: ATTR_ESRI, mpp: Math.max(want, mpp(z)),
               partial: got.length < tiles.length };
    });
  }

  function imageryFor(box) {
    const key = `${box.south.toFixed(6)},${box.west.toFixed(6)}|${box.size}`;
    if (imageCache.has(key)) return Promise.resolve(imageCache.get(key));
    const px = texturePx(box.size);
    return qldImagery(box, px)
      .then(q => {
        if (q.kind === 'ok') return q;
        return esriImagery(box, px).then(e => (e ? { ...e, qld: q.kind } : null), () => null);
      })
      .catch(() => null)
      .then(im => {
        if (im) {
          im.bytes = im.canvas.width * im.canvas.height * 4;
          imageCache.set(key, im);
          // Bounded by bytes, not entries: a decoded canvas is width × height
          // × 4 — 4 MB at 1024, 16 MB at 2048 — and six of the wide ones
          // would be 100 MB of bitmaps no browser cache can evict. The bound
          // holds one wide patch and a few narrow ones; the ground grids
          // beside them are 162 KB each and are not what the budget is for.
          let total = 0;
          for (const v of imageCache.values()) total += v.bytes;
          while (total > IMAGE_CACHE_BYTES && imageCache.size > 1) {
            const k = imageCache.keys().next().value;
            total -= imageCache.get(k).bytes;
            imageCache.delete(k);
          }
        }
        return im;
      });
  }

  // What the two caches are holding, for the memory strip — and one call to
  // give it back (MemMeter's Release), the way Terrain.clear() does.
  function cacheBytes() {
    let b = 0;
    for (const v of imageCache.values()) b += v.bytes || 0;
    for (const g of groundCache.values()) b += g.elev ? g.elev.byteLength : 0;
    return b;
  }
  function clearCaches() { imageCache.clear(); groundCache.clear(); }

  // ── the renderer ───────────────────────────────────────────────────────────
  // A module that failed to fetch is remembered as failed by the browser's
  // module map: import() of the same URL again rejects at once without a
  // request leaving the page. So each try after a failure keys the URL with a
  // query — a different specifier, a fresh fetch — which unpkg ignores, and
  // which the module's own relative import of its core does not inherit.
  let libTry = 0;
  function loadLib() {
    if (THREE) return Promise.resolve(THREE);
    if (libP) return libP;
    const url = libTry ? `${LIB_URL}?r=${libTry}` : LIB_URL;
    libP = import(url).then(m => {
      if (!m || !m.WebGLRenderer) throw new Error('the 3-D renderer loaded but defined nothing');
      THREE = m;
      libErr = null;
      return m;
    }).catch(err => {
      // Remembered as a failure, not as an answer: the next build tries again.
      libErr = (err && err.message) || String(err);
      libP = null;
      libTry++;
      throw err;
    });
    return libP;
  }

  function webglOk() {
    try {
      const cv = document.createElement('canvas');
      return !!(cv.getContext('webgl2') || cv.getContext('webgl'));
    } catch (_) { return false; }
  }

  // ── the scene ──────────────────────────────────────────────────────────────
  function disposeObject(o) {
    if (!o) return;
    o.traverse(x => {
      if (x.geometry) x.geometry.dispose();
      const mats = Array.isArray(x.material) ? x.material : (x.material ? [x.material] : []);
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    });
  }

  function clearScene() {
    if (!sc.scene) return;
    for (const k of ['terrain', 'wire', 'pole', 'band', 'figure', 'label', 'paths']) {
      if (sc[k]) { sc.scene.remove(sc[k]); disposeObject(sc[k]); sc[k] = null; }
    }
    if (sc.texture) { sc.texture.dispose(); sc.texture = null; }
  }

  function skyColour() {
    return new THREE.Color(cssVar('--twin-sky', state.theme === 'dark' ? '#101a26' : '#cfe3f5'));
  }

  function ensureRenderer() {
    if (sc.renderer) return true;
    const canvas = document.getElementById('twin-canvas');
    const stage  = document.getElementById('twin-stage');
    if (!canvas || !stage) return false;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (_) {
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    // PCFShadowMap, not PCFSoftShadowMap: r185 deprecates the soft variant
    // (and warns on every load) in favour of this one with a larger map.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    sc.renderer = renderer;
    sc.canvas = canvas;
    sc.stage = stage;
    sc.scene = new THREE.Scene();
    sc.camera = new THREE.PerspectiveCamera(50, 1, 0.2, 60000);
    rig.target = new THREE.Vector3(0, 1, 0);

    sc.hemi = new THREE.HemisphereLight(0xdfeeff, 0x6b5a3a, 1.1);
    sc.scene.add(sc.hemi);
    // The sun to the north, as it is here, high enough that a pole throws a
    // short shadow the eye reads as "standing on the ground". The shadow camera
    // covers only the objects — the terrain neither casts nor needs to.
    sc.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sc.sun.position.set(18, 50, -34);
    sc.sun.castShadow = true;
    sc.sun.shadow.mapSize.set(2048, 2048);
    sc.sun.shadow.camera.left = -12; sc.sun.shadow.camera.right = 12;
    sc.sun.shadow.camera.top = 12;   sc.sun.shadow.camera.bottom = -12;
    sc.sun.shadow.camera.near = 1;   sc.sun.shadow.camera.far = 140;
    sc.sun.shadow.bias = -0.0006;
    sc.scene.add(sc.sun);

    fitRenderer();
    sc.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { fitRenderer(); requestFrame(); }) : null;
    if (sc.ro) sc.ro.observe(stage);
    attachControls();
    tw.live = true;
    return true;
  }

  function fitRenderer() {
    if (!sc.renderer || !sc.stage) return;
    const w = Math.max(1, sc.stage.clientWidth), h = Math.max(1, sc.stage.clientHeight);
    // `false`: the canvas is sized by the stylesheet (100% of the stage); the
    // renderer only sets the drawing buffer. Three's default would write an
    // inline width/height on the canvas, which is the one thing the design
    // system's check forbids (design-system.md §6).
    sc.renderer.setSize(w, h, false);
    sc.camera.aspect = w / h;
    sc.camera.updateProjectionMatrix();
  }

  // The ground: one plane, N × N, its vertices lifted to the grid. Row 0 of the
  // raster is north; PlaneGeometry's first row is its top, which rotateX(−90°)
  // sends to −z — north. So the raster indexes the vertices directly, and the
  // default UVs (v = 1 along that first row) put the top of the imagery on it.
  function buildTerrain() {
    const g = tw.ground;
    const size = g.size, exag = S().exag;
    const geo = new THREE.PlaneGeometry(size, size, N - 1, N - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const span = Math.max(1, g.max - g.min);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = g.elev[i];
      pos.setY(i, (h - g.h0) * exag);
      // The height ramp, for when there is no imagery: dark green in the low
      // ground through olive and tan to a pale crest. Linear-space colours,
      // as three wants vertex colours.
      const t = (h - g.min) / span;
      c.setHSL(0.30 - 0.22 * t, 0.42 - 0.18 * t, 0.22 + 0.42 * t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // polygonOffset pushes the ground back a hair in the depth buffer, so the
    // wireframe drawn on the very same vertices wins every fragment. Lifting
    // the wire a few centimetres instead loses it to the ground wherever the
    // depth buffer's resolution runs out — a sixth of it from the top-down
    // view of a wide patch.
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true,
                                                 polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    sc.terrain = mesh;
    sc.scene.add(mesh);

    // The wireframe rides the same geometry, so the mesh's sample spacing can
    // be seen against the imagery.
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x1b2a3a, transparent: true, opacity: 0.35 }));
    wire.visible = !!S().wire;
    wire.name = 'wireframe';
    wire.userData.export = false;
    sc.wire = wire;
    sc.scene.add(wire);
    applyImagery();
  }

  function applyImagery() {
    if (!sc.terrain) return;
    const mat = sc.terrain.material;
    const want = !!S().imagery && !!tw.image;
    if (want && !sc.texture) {
      const tex = new THREE.CanvasTexture(tw.image.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, sc.renderer.capabilities.getMaxAnisotropy() || 1);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      sc.texture = tex;
    }
    mat.map = want ? sc.texture : null;
    mat.vertexColors = !want;
    mat.needsUpdate = true;
    requestFrame();
  }

  // The station: a 2.000 m × Ø0.300 m galvanised pole, its foot on the ground
  // at the origin, and a band in the station's role colour near the top so
  // the thing on the ground reads as the pin on the map.
  function buildPole(station) {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(POLE_R, POLE_R, POLE_H, 40, 1, false),
      new THREE.MeshStandardMaterial({ color: 0x9aa4ae, metalness: 0.65, roughness: 0.38 }));
    shaft.position.y = POLE_H / 2;
    shaft.castShadow = true;
    shaft.name = 'station pole';
    sc.pole = shaft;
    sc.scene.add(shaft);

    const role = typeof primaryRole === 'function' ? primaryRole(station) : 'field';
    const colour = (typeof ROLE_COLOR !== 'undefined' && ROLE_COLOR[role]) || '#107c10';
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(POLE_R + 0.008, POLE_R + 0.008, 0.12, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), metalness: 0.1, roughness: 0.6 }));
    band.position.y = POLE_H - 0.18;
    band.name = 'role band';
    sc.band = band;
    sc.scene.add(band);
  }

  // A person, 1.75 m, in hi-vis, a metre east of the pole with their feet on
  // the ground there. Primitives rather than a model: a model is a file to
  // fetch and a licence to carry, and what this figure is for is a sense of
  // scale, which a capsule in orange gives as well as a mesh of a face.
  function buildFigure() {
    const grp = new THREE.Group();
    const hiVis = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.8 });
    const navy  = new THREE.MeshStandardMaterial({ color: 0x1f2a44, roughness: 0.9 });
    const skin  = new THREE.MeshStandardMaterial({ color: 0xc9a07a, roughness: 0.7 });
    const hat   = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.5 });
    const boot  = new THREE.MeshStandardMaterial({ color: 0x3a2d22, roughness: 0.9 });
    const add = (geo, mat, x, y, z, name) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.name = name;
      grp.add(m);
      return m;
    };
    // Boots 0–0.12, legs to 0.82, torso to 1.46, head to 1.72, hat crown 1.75.
    add(new THREE.CylinderGeometry(0.075, 0.085, 0.12, 12), boot, -0.11, 0.06, 0.02, 'boot');
    add(new THREE.CylinderGeometry(0.075, 0.085, 0.12, 12), boot,  0.11, 0.06, 0.02, 'boot');
    add(new THREE.CylinderGeometry(0.068, 0.078, 0.70, 14), navy, -0.11, 0.47, 0, 'leg');
    add(new THREE.CylinderGeometry(0.068, 0.078, 0.70, 14), navy,  0.11, 0.47, 0, 'leg');
    add(new THREE.CapsuleGeometry(0.175, 0.30, 6, 16), hiVis, 0, 1.13, 0, 'torso');
    const la = add(new THREE.CapsuleGeometry(0.052, 0.52, 4, 12), hiVis, -0.27, 1.12, 0, 'arm');
    const ra = add(new THREE.CapsuleGeometry(0.052, 0.52, 4, 12), hiVis,  0.27, 1.12, 0, 'arm');
    la.rotation.z =  0.12; ra.rotation.z = -0.12;
    add(new THREE.SphereGeometry(0.105, 20, 14), skin, 0, 1.60, 0, 'head');
    add(new THREE.SphereGeometry(0.125, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hat, 0, 1.625, 0, 'hard hat');
    add(new THREE.CylinderGeometry(0.165, 0.165, 0.012, 24), hat, 0, 1.627, 0, 'hat brim');
    const fx = 1.0, fz = 0.25;
    grp.position.set(fx, yAt(fx, fz), fz);
    grp.rotation.y = Math.atan2(-fx, -fz) + Math.PI;   // facing away from the pole, as if looking at it over a shoulder
    grp.visible = !!S().figure;
    grp.name = 'figure';
    sc.figure = grp;
    sc.scene.add(grp);
  }

  // A sign on a sprite — a title and, under it, a second line — sized in
  // metres and always facing the camera. Rasterised at 2× for the retina
  // case. The station's name over the pole is one; the far end of every
  // radio path is another.
  function makeSign(title, sub, { bar = null } = {}) {
    const cv = document.createElement('canvas');
    const W = 640, H = sub ? 160 : 112;
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(16, 32, 42, 0.82)';
    cx.beginPath();
    if (typeof cx.roundRect === 'function') cx.roundRect(4, 4, W - 8, H - 8, 28);
    else cx.rect(4, 4, W - 8, H - 8);
    cx.fill();
    if (bar) { cx.fillStyle = bar; cx.fillRect(4, 4, 22, H - 8); }
    cx.fillStyle = '#ffffff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.font = '600 58px system-ui, sans-serif';
    let t = String(title || '');
    while (t.length > 3 && cx.measureText(t).width > W - 70) t = t.slice(0, -2) + '…';
    cx.fillText(t, W / 2, sub ? 60 : H / 2);
    if (sub) {
      cx.font = '400 40px system-ui, sans-serif';
      cx.fillStyle = '#cfe3f5';
      cx.fillText(String(sub), W / 2, 114);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(3.2, 3.2 * H / W, 1);
    sp.userData.export = false;
    return sp;
  }

  // The station's name over the pole.
  function buildLabel(station) {
    const sp = makeSign(station.name || station.id, station.station_number ? String(station.station_number) : null);
    sp.position.set(0, POLE_H + 0.75, 0);
    sp.visible = !!S().label;
    sp.name = 'label';
    sc.label = sp;
    sc.scene.add(sp);
  }

  // ── the radio paths ────────────────────────────────────────────────────────
  // What joins this station to the rest of the network, as rays from its
  // antenna. Two sources, and the first is the one that matters:
  //
  //   * The Stations map's own lines, where that map is up — the seam
  //     map-3d.js reads (`state.mapLines`): the same filters, the same
  //     colouring (channel, fade margin or line of sight, whichever is on),
  //     the same hidden and culled sets. Nothing is re-derived, so this view
  //     cannot disagree with the map it was opened from.
  //   * On the Digital Twin tab there is no map to mirror (leaving the
  //     Stations tab takes its lines with it), so the relations themselves are
  //     asked — the pass-range and backbone indexes app.js draws the lines
  //     from, through its own functions — in the plain colours. The notes say
  //     which, because "as the map colours them" and "as recorded" are
  //     different claims.
  //
  // A path's far end is beyond the patch almost always, so the ray is drawn
  // from the antenna to the patch's edge, along the line of sight to the far
  // antenna: over a hop this short the earth's bulge is millimetres and is
  // left out. Vertical exaggeration scales the ray's relief with the
  // ground's — its rise from the antenna is (far altitude − near altitude) ×
  // d/D × exaggeration — so the clearance it shows over the ground is the
  // true clearance at 1× and stretches with the ground above that; the
  // antenna height itself, like the pole, is never scaled.
  function antennaAgl(st) {
    const sys = typeof rmSystemOf === 'function' ? rmSystemOf(st) : null;
    if (sys && isFinite(sys.antenna_height_m)) return Number(sys.antenna_height_m);
    return typeof PATH_DEFAULT_AGL === 'number' ? PATH_DEFAULT_AGL : 4;
  }

  function pathsFor(station) {
    const out = new Map();
    const add = (far, colour, opacity, kind) => {
      if (!far || far.id === station.id || !located(far) || out.has(far.id)) return;
      out.set(far.id, { far, colour, opacity, kind });
    };
    const lines = (typeof state !== 'undefined' && state.map && state.mapLines) || [];
    if (lines.length) {
      for (const l of lines) {
        const role = l.mnLinkRole;
        if (role !== 'core' && role !== 'backbone') continue;
        const ids = [l.mnLinkStationId, l.mnLinkRepeaterId, l.mnLinkRepeaterId2].filter(x => x != null);
        if (!ids.includes(station.id)) continue;
        const farId = ids.find(x => x !== station.id);
        add(stationById(farId), (l.options && l.options.color) || '#ff6f00',
            l.options && l.options.opacity != null ? l.options.opacity : 1,
            role === 'backbone' ? 'backbone' : 'field');
      }
      return { paths: [...out.values()], source: 'map' };
    }
    const lineC = cssVar('--map-line', '#ff6f00'), bbC = cssVar('--map-backbone', '#000000');
    const roles = station.roles || [];
    if (typeof passRangeLinks === 'function' && roles.includes('field')) {
      for (const p of passRangeLinks([station])) add(p.r, lineC, 1, 'field');
    }
    if (typeof findStationMatches === 'function' && roles.includes('repeater')) {
      for (const f of findStationMatches(station)) add(f, lineC, 1, 'field');
    }
    if (typeof backboneLinks === 'function') {
      const maxKm = typeof state !== 'undefined' && state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : Infinity;
      for (const p of backboneLinks(maxKm)) {
        if (p.a.id === station.id) add(p.b, bbC, 1, 'backbone');
        else if (p.b.id === station.id) add(p.a, bbC, 1, 'backbone');
      }
    }
    return { paths: [...out.values()], source: 'data' };
  }

  // The ground under a far station: its recorded height, else what the tiles
  // say (fetched once), else — until the tiles answer — the near station's
  // own, which draws the ray level and is corrected the moment they do.
  function farGround(far) {
    if (far.elevation_ahd != null && isFinite(far.elevation_ahd)) return Number(far.elevation_ahd);
    if (farHeightCache.has(far.id)) return farHeightCache.get(far.id);
    return null;
  }

  function buildPaths(station) {
    if (sc.paths) { sc.scene.remove(sc.paths); disposeObject(sc.paths); sc.paths = null; }
    const g = tw.ground;
    if (!g || !THREE || !sc.scene || !station) { tw.paths = null; return; }
    const seq = tw.seq;
    const { paths, source } = pathsFor(station);
    const grp = new THREE.Group();
    grp.name = 'radio paths';
    const agl0 = antennaAgl(station);
    const exag = S().exag;
    // A mast from the pole's top to the antenna, where the antenna is higher
    // than the pole — the ray has to leave from somewhere the eye can see.
    if (agl0 > POLE_H + 0.05) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, agl0 - POLE_H, 12),
                                  new THREE.MeshStandardMaterial({ color: 0x8d97a1, metalness: 0.6, roughness: 0.4 }));
      mast.position.y = POLE_H + (agl0 - POLE_H) / 2;
      mast.castShadow = true;
      mast.name = 'mast';
      grp.add(mast);
    }
    const list = [];
    const missing = [];
    for (const p of paths) {
      const D = acmaHaversineKm(station.lat, station.lon, p.far.lat, p.far.lon) * 1000;
      if (!(D > 0.5)) continue;
      const brg = bearingDeg(station.lat, station.lon, p.far.lat, p.far.lon);
      const rad = brg * Math.PI / 180;
      const ux = Math.sin(rad), uz = -Math.cos(rad);
      const edge = g.half / Math.max(Math.abs(ux), Math.abs(uz), 1e-9);
      const dE = Math.min(D, edge);
      let hF = farGround(p.far);
      if (hF == null) { missing.push(p.far); hF = g.h0; }
      const aglF = antennaAgl(p.far);
      const slope = ((hF + aglF) - (g.h0 + agl0)) / D;
      const yEnd = agl0 + slope * dE * exag;
      const a = new THREE.Vector3(0, agl0, 0), b = new THREE.Vector3(ux * dE, yEnd, uz * dE);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, 0.12, 8, false),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(p.colour), transparent: p.opacity < 1, opacity: p.opacity }));
      tube.name = `path to ${p.far.name || p.far.id}`;
      tube.userData.path = p.far.id;
      grp.add(tube);
      // The far end named twice: on the ray beside the pole, where the
      // opening view is looking, and again at the ray's end, scaled with its
      // distance so it reads from wherever the camera has gone — a 3 m sign
      // 200 m off is a speck.
      const words = `${(D / 1000).toFixed(D < 10000 ? 1 : 0)} km · ${Math.round(brg)}°${p.kind === 'backbone' ? ' · backbone' : ''}`;
      const dNear = Math.min(dE * 0.45, 9 + list.length * 3);
      const near = makeSign(`→ ${p.far.name || p.far.id}`, words, { bar: p.colour });
      near.position.set(ux * dNear, agl0 + slope * dNear * exag + 0.9, uz * dNear);
      grp.add(near);
      const sign = makeSign(p.far.name || p.far.id, words, { bar: p.colour });
      const k = Math.max(1, dE / 40);
      sign.scale.multiplyScalar(k);
      sign.position.copy(b).add(new THREE.Vector3(0, 0.5 * k, 0));
      grp.add(sign);
      list.push({ farId: p.far.id, far: p.far.name, colour: p.colour, opacity: p.opacity, kind: p.kind,
                  km: D / 1000, bearing: brg, agl0, aglF, hF, farKnown: farGround(p.far) != null,
                  end: { x: b.x, y: b.y, z: b.z } });
    }
    sc.paths = grp;
    sc.scene.add(grp);
    tw.paths = { count: list.length, source, list, pending: missing.length };
    refreshPathsLine();
    requestFrame();
    // The tiles for the far ends nobody surveyed, then the rays again with
    // the ground they stand on — once, all together.
    if (missing.length && typeof Terrain !== 'undefined') {
      Promise.all(missing.map(f => Terrain.sample(f.lat, f.lon).then(h => { if (isFinite(h)) farHeightCache.set(f.id, h); }, () => {})))
        .then(() => { if (seq === tw.seq && sc.scene && tw.ground) buildPaths(station); });
    }
  }

  // ── the camera ─────────────────────────────────────────────────────────────
  function resetOrbit() {
    rig.mode = 'orbit';
    if (rig.target) rig.target.set(0, 1, 0);
    rig.radius = 26; rig.theta = 0.65; rig.phi = 1.05;
    syncModeUi();
  }

  function lookDown() {
    rig.mode = 'orbit';
    if (rig.target) rig.target.set(0, 0, 0);
    rig.radius = tw.ground ? tw.ground.size * 0.9 : 120;
    rig.phi = 0.06;
    syncModeUi();
  }

  function enterWalk() {
    if (!tw.ground) return;
    // Start where the orbit camera was standing if that is on the patch, else
    // a few metres off the pole looking at it.
    const half = tw.ground.half - 2;
    const cam = sc.camera;
    if (cam && Math.abs(cam.position.x) < half && Math.abs(cam.position.z) < half && rig.mode === 'orbit') {
      rig.px = cam.position.x; rig.pz = cam.position.z;
      const dx = -rig.px, dz = -rig.pz;
      rig.yaw = Math.atan2(dx, -dz);
    } else {
      rig.px = 3; rig.pz = 6; rig.yaw = Math.atan2(-3, 6);
    }
    rig.pitch = -0.06;
    rig.mode = 'walk';
    syncModeUi();
    if (sc.canvas) sc.canvas.focus({ preventScroll: true });
  }

  function leaveWalk() {
    if (rig.mode !== 'walk') return;
    // Orbit again, from about where the walker stood, looking at the pole.
    rig.mode = 'orbit';
    if (rig.target) rig.target.set(0, 1, 0);
    rig.radius = Math.max(4, Math.hypot(rig.px, rig.pz));
    rig.theta = Math.atan2(rig.px, rig.pz);
    rig.phi = 1.35;
    syncModeUi();
  }

  function placeCamera() {
    const cam = sc.camera;
    if (!cam) return;
    if (rig.mode === 'walk') {
      const y = yAt(rig.px, rig.pz) + EYE_H;
      cam.position.set(rig.px, y, rig.pz);
      const cp = Math.cos(rig.pitch);
      cam.lookAt(rig.px + Math.sin(rig.yaw) * cp, y + Math.sin(rig.pitch), rig.pz - Math.cos(rig.yaw) * cp);
    } else {
      const sp = Math.sin(rig.phi);
      const x = rig.target.x + rig.radius * sp * Math.sin(rig.theta);
      const z = rig.target.z + rig.radius * sp * Math.cos(rig.theta);
      let y = rig.target.y + rig.radius * Math.cos(rig.phi);
      // Never under the hill between the camera and the pole: a camera inside
      // the ground shows the underside of the world, which reads as nothing.
      y = Math.max(y, yAt(x, z) + 0.9);
      cam.position.set(x, y, z);
      cam.lookAt(rig.target);
    }
    syncCompass();
  }

  // The camera's heading, for the compass rose: 0 looking north. The rose is
  // turned the other way so its N points where north is on screen.
  function syncCompass() {
    const el = document.getElementById('twin-compass');
    if (!el || !sc.camera) return;
    const v = new THREE.Vector3();
    sc.camera.getWorldDirection(v);
    const heading = Math.atan2(v.x, -v.z) * 180 / Math.PI;
    el.style.setProperty('--twin-heading', `${(-heading).toFixed(1)}deg`);
  }

  function syncModeUi() {
    const stage = document.getElementById('twin-stage');
    if (stage) stage.classList.toggle('is-walk', rig.mode === 'walk');
    const btn = document.getElementById('twin-walk');
    if (btn) {
      btn.setAttribute('aria-pressed', rig.mode === 'walk' ? 'true' : 'false');
      btn.textContent = rig.mode === 'walk' ? '🚶 Stop walking' : '🚶 Walk';
    }
    const hud = document.getElementById('twin-hud');
    if (hud) hud.textContent = rig.mode === 'walk'
      ? 'Walking at 1.7 m: W A S D or the arrow keys move, drag to look, Shift to hurry, Esc to stop.'
      : (tw.hooks ? 'Drag to orbit, wheel to zoom, right-drag to pan; click the ground for its height. Wheel out past the edge, or Esc, for the map.'
                  : 'Drag to orbit, wheel to zoom, right-drag or Shift-drag to pan. Click the ground for its height.');
    syncCanvasName();
    requestFrame();
  }

  // ── the controls ───────────────────────────────────────────────────────────
  function attachControls() {
    const cv = sc.canvas;
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); sc.off.push(() => el.removeEventListener(ev, fn, opts)); };

    on(cv, 'contextmenu', e => e.preventDefault());

    on(cv, 'pointerdown', e => {
      if (e.button !== 0 && e.button !== 2) return;
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      rig.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, b: e.button, moved: false });
      if (rig.pointers.size === 2) {
        const [a, b] = [...rig.pointers.values()];
        rig.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
      cv.focus({ preventScroll: true });
    });

    on(cv, 'pointermove', e => {
      const p = rig.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 4) p.moved = true;
      if (rig.pointers.size === 2 && rig.pinch) {
        const [a, b] = [...rig.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (rig.mode === 'orbit') {
          if (rig.pinch.d > 0) dolly(Math.log(rig.pinch.d / Math.max(1, d)));
          pan(mx - rig.pinch.mx, my - rig.pinch.my);
        } else {
          walkStep((rig.pinch.my - my) * 0.02, 0);
        }
        rig.pinch = { d, mx, my };
        requestFrame();
        return;
      }
      if (rig.mode === 'walk') {
        rig.yaw   += dx * 0.004;
        rig.pitch  = Math.max(-1.2, Math.min(1.2, rig.pitch - dy * 0.003));
      } else if (p.b === 2 || e.shiftKey || e.ctrlKey || e.metaKey) {
        pan(dx, dy);
      } else {
        rig.theta -= dx * 0.005;
        rig.phi    = Math.max(0.06, Math.min(1.53, rig.phi - dy * 0.005));
      }
      requestFrame();
    });

    const up = e => {
      const p = rig.pointers.get(e.pointerId);
      rig.pointers.delete(e.pointerId);
      if (rig.pointers.size < 2) rig.pinch = null;
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      if (p && !p.moved && p.b === 0 && e.type === 'pointerup') pickGround(e);
    };
    on(cv, 'pointerup', up);
    on(cv, 'pointercancel', up);

    on(cv, 'wheel', e => {
      e.preventDefault();
      if (rig.mode === 'walk') walkStep(-e.deltaY * 0.01, 0);
      else {
        // Embedded in the Stations map, a wheel-out past the widest the
        // orbit goes is the gesture that brought the twin up run backwards:
        // the map takes over again, one zoom level out (map-twin.js).
        const atLimit = rig.radius >= maxRadius() - 1e-6;
        dolly(e.deltaY * 0.0015);
        if (atLimit && e.deltaY > 0 && tw.hooks && tw.hooks.leave) { tw.hooks.leave(); return; }
      }
      requestFrame();
    }, { passive: false });

    // The keys, on the canvas only — it has to be focused, so a keyboard user
    // reaches them by tabbing to it and nothing on the page loses a key it
    // was using. Escape in walk mode is claimed (preventDefault), which is
    // what stands the phone drawer's own Escape down (init.js).
    const WALK_KEYS = ['w', 'a', 's', 'd', 'q', 'e', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift'];
    const keyName = k => (k.length === 1 ? k.toLowerCase() : k);
    on(cv, 'keydown', e => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const k = keyName(e.key);
      if (rig.mode === 'walk') {
        if (k === 'Escape') { e.preventDefault(); leaveWalk(); return; }
        if (WALK_KEYS.includes(k)) { e.preventDefault(); rig.keys.add(k); requestFrame(); }
        return;
      }
      if (k === 'Escape' && tw.hooks && tw.hooks.leave) { e.preventDefault(); tw.hooks.leave(); return; }
      const step = 0.08;
      switch (k) {
        case 'ArrowLeft':  rig.theta += step; break;
        case 'ArrowRight': rig.theta -= step; break;
        case 'ArrowUp':    rig.phi = Math.max(0.06, rig.phi - step); break;
        case 'ArrowDown':  rig.phi = Math.min(1.53, rig.phi + step); break;
        case '+': case '=': dolly(-0.2); break;
        case '-': case '_': dolly(0.2); break;
        case 'w': pan(0, 24); break;
        case 's': pan(0, -24); break;
        case 'a': pan(24, 0); break;
        case 'd': pan(-24, 0); break;
        case 'r': resetOrbit(); break;
        case 't': lookDown(); break;
        case 'f': enterWalk(); break;
        default: return;
      }
      e.preventDefault();
      requestFrame();
    });
    on(cv, 'keyup', e => rig.keys.delete(keyName(e.key)));
    on(cv, 'blur', () => rig.keys.clear());
  }

  function maxRadius() { return tw.ground ? tw.ground.size * 2.2 : 400; }
  function dolly(amount) {
    rig.radius = Math.min(maxRadius(), Math.max(1.5, rig.radius * Math.exp(amount)));
  }

  // Pan the orbit target across the ground, screen-relative: the ground follows
  // the pointer, whatever the heading. Dragging right moves the target left
  // (−right); dragging down brings the near ground toward the viewer, so the
  // target goes forward.
  function pan(dx, dy) {
    if (!rig.target) return;
    const k = rig.radius * 0.0016;
    const st = Math.sin(rig.theta), ct = Math.cos(rig.theta);
    // The camera sits at target + r·(sinφ sinθ, cosφ, sinφ cosθ) and looks at
    // the target, so on the ground plane forward is (−sinθ, 0, −cosθ) and
    // right is forward × up = (cosθ, 0, −sinθ).
    rig.target.x += (-ct * dx - st * dy) * k;
    rig.target.z += (st * dx - ct * dy) * k;
    const lim = tw.ground ? tw.ground.half : 200;
    rig.target.x = Math.max(-lim, Math.min(lim, rig.target.x));
    rig.target.z = Math.max(-lim, Math.min(lim, rig.target.z));
    rig.target.y = yAt(rig.target.x, rig.target.z) + 1;
  }

  // One step of walking: `f` metres forward, `r` metres right, on the ground.
  function walkStep(f, r) {
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    rig.px += f * sy + r * cy;
    rig.pz += -f * cy + r * sy;
    const lim = (tw.ground ? tw.ground.half : 100) - 1;
    rig.px = Math.max(-lim, Math.min(lim, rig.px));
    rig.pz = Math.max(-lim, Math.min(lim, rig.pz));
  }

  // Held keys, applied per frame at a walking pace.
  let lastTick = 0;
  function walkKeys(now) {
    if (rig.mode !== 'walk' || !rig.keys.size) return false;
    const dt = Math.min(0.05, (now - lastTick) / 1000 || 0.016);
    const speed = (rig.keys.has('Shift') ? 4.5 : 1.6) * dt;
    let f = 0, r = 0;
    if (rig.keys.has('w') || rig.keys.has('ArrowUp'))    f += speed;
    if (rig.keys.has('s') || rig.keys.has('ArrowDown'))  f -= speed;
    if (rig.keys.has('d') || rig.keys.has('ArrowRight')) r += speed;
    if (rig.keys.has('a') || rig.keys.has('ArrowLeft'))  r -= speed;
    if (rig.keys.has('q')) rig.yaw -= 1.4 * dt;
    if (rig.keys.has('e')) rig.yaw += 1.4 * dt;
    if (f || r) walkStep(f, r);
    return true;
  }

  // A click on the ground: where it is from the pole and how high it is —
  // the digital twin's "what is here".
  function pickGround(e) {
    if (!sc.terrain || !sc.camera) return;
    const r = sc.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(nd, sc.camera);
    const hit = rc.intersectObject(sc.terrain, false)[0];
    const out = document.getElementById('twin-pick');
    if (!hit) { if (out) out.textContent = ''; return; }
    const x = hit.point.x, z = hit.point.z;
    const h = heightAt(x, z);
    tw.picked = { x, z, h };
    if (out) {
      const ew = x >= 0 ? `${x.toFixed(1)} m E` : `${(-x).toFixed(1)} m W`;
      const ns = z <= 0 ? `${(-z).toFixed(1)} m N` : `${z.toFixed(1)} m S`;
      const d  = Math.hypot(x, z);
      out.textContent = `Clicked: ${ew}, ${ns} of the pole (${d.toFixed(1)} m away) — ground ${h.toFixed(2)} m ${tw.ground.datum}, `
                      + `${(h - tw.ground.h0) >= 0 ? '+' : ''}${(h - tw.ground.h0).toFixed(2)} m against the station.`;
    }
  }

  // ── the frame loop ─────────────────────────────────────────────────────────
  // Renders only when something changed — a still scene costs nothing — and
  // every frame while a walk key is held. Stopped outright by the teardown.
  function requestFrame() { sc.dirty = true; }

  function tick(now) {
    if (!tw.live) { sc.raf = 0; return; }
    sc.raf = requestAnimationFrame(tick);
    if (walkKeys(now)) sc.dirty = true;
    lastTick = now;
    if (!sc.dirty) return;
    sc.dirty = false;
    if (!sc.renderer || !sc.scene) return;
    placeCamera();
    sc.scene.background = skyColour();
    if (sc.scene.fog) sc.scene.fog.color.copy(sc.scene.background);
    sc.renderer.render(sc.scene, sc.camera);
    tw.frames++;
  }

  function startLoop() {
    if (!sc.raf && tw.live) sc.raf = requestAnimationFrame(tick);
  }

  // ── the build ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    tw.status = text;
    const el = document.getElementById('twin-status');
    if (el) { el.textContent = text; el.title = text; }
  }

  function setNotes(notes) {
    tw.notes = notes;
    const el = document.getElementById('twin-notes');
    if (!el) return;
    el.innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
    el.hidden = !notes.length;
  }

  function showPlaceholder(html) {
    const el = document.getElementById('twin-placeholder');
    if (!el) return;
    el.innerHTML = html || '';
    el.hidden = !html;
  }

  // Everything the tab needs, in order, each step standing down if the station
  // or the size changed under it. Loud about what it could not get, and it
  // draws what it did get.
  async function build() {
    const seq = ++tw.seq;
    const st = currentStation();
    setNotes([]);
    // Nothing to build: the last station's scene and numbers must not stand
    // in for this one's, so they go, and every panel says so.
    const nothing = (status, placeholder) => {
      tw.ground = null; tw.image = null; tw.elvis = null; tw.picked = null;
      clearScene();
      requestFrame();
      setStatus(status);
      showPlaceholder(placeholder);
      refreshTruth(); refreshTable(); syncCanvasName(); syncExportButton(); refreshAttrib(); refreshPathsLine();
      const pk = document.getElementById('twin-pick');
      if (pk) pk.textContent = '';
    };
    if (!st) { nothing('Pick a station to build its twin.', '<p>No station chosen. Find one on the left, or select one on the Stations tab and come back.</p>'); return; }
    if (!located(st)) { nothing(`${st.name} has no position, so there is no ground to stand it on.`, `<p><strong>${esc(st.name)}</strong> has no coordinates. Give it a position in the station editor and the twin can be built.</p>`); return; }
    const gl = webglOk();
    const box = patchBox(st.lat, st.lon, S().size);
    const notes = [];

    // The renderer, only where it can draw: without WebGL there is no point
    // fetching three quarters of a megabyte to be told so.
    let lib = null;
    if (gl) {
      setStatus('Fetching the 3-D renderer…');
      showPlaceholder('<p>Loading…</p>');
      try { lib = await loadLib(); } catch (_) { lib = null; }
      if (seq !== tw.seq) return;
      if (!lib) notes.push(`The 3-D renderer could not be fetched (${libErr || 'offline, or blocked'}). The ground is still read and tabled below; press Rebuild to try again.`);
    } else {
      notes.push('WebGL is not available in this browser, so nothing three-dimensional can be drawn here; the ground is still read and tabled below.');
      showPlaceholder('<p>WebGL is not available in this browser — the twin needs it. The ground has been read and is tabled below.</p>');
    }

    // The ground first, drawn the moment it lands; the imagery follows and is
    // draped when it arrives. Waiting for both held a ground that took
    // seconds behind an imagery host that took a minute to say no.
    setStatus('Reading the ground…');
    const imageP = imageryFor(box);
    const ground = await groundFor(box);
    if (seq !== tw.seq) return;
    tw.ground = ground;
    tw.image = null;
    tw.elvis = null;

    if (!ground) {
      // The last station's scene must not stand in for this one's: cleared,
      // and the stage says why it is empty.
      clearScene();
      requestFrame();
      setStatus('No ground could be read for this patch — offline, or every elevation service is blocked.');
      setNotes([...notes, 'Neither Queensland\'s elevation service nor the terrain tiles answered. Nothing is drawn: a flat patch would read as flat ground, and that is the one wrong answer worth refusing.']);
      showPlaceholder('<p>No ground could be read. Check the network, then press <strong>Rebuild</strong>.</p>');
      refreshTruth();
      refreshTable();
      syncCanvasName();
      syncExportButton();
      refreshPathsLine();
      imageP.catch(() => {});
      return;
    }
    if (ground.source === 'srtm') {
      notes.push(ground.qld === 'failed'
        ? `Queensland's elevation service did not answer — ${ground.qldError || 'it could not be reached'} — so the ground is the ~30 m SRTM every profile in this app reads: the relief is smoothed and a channel narrower than a pixel is not there. Press Rebuild to ask it again.`
        : 'Queensland\'s elevation service holds nothing here, so the ground is the ~30 m SRTM every profile in this app reads — the relief is smoothed and a channel narrower than a pixel is not there. Elvis lists finer LiDAR for much of NSW; it is not yet a source this tab can read.');
    } else if (ground.filled) {
      notes.push(`${ground.filled.toLocaleString()} of ${(N * N).toLocaleString()} samples were outside the State's data and were filled from ~30 m terrain tiles.`);
    }
    if (ground.unfilled) notes.push(`${ground.unfilled.toLocaleString()} samples could not be read from any source and are drawn at the station's own height.`);

    if (lib && ensureRenderer()) {
      clearScene();
      buildTerrain();
      buildPole(st);
      buildFigure();
      buildLabel(st);
      buildPaths(st);
      sc.scene.fog = new THREE.Fog(skyColour(), ground.size * 1.1, ground.size * 4);
      resetOrbit();
      showPlaceholder('');
      startLoop();
      requestFrame();
    } else if (lib) {
      notes.push('A WebGL context could not be created on this canvas, so nothing is drawn; the numbers below are still the ground.');
      showPlaceholder('<p>WebGL is not available here. The ground has been read and is tabled below.</p>');
    } else if (gl) {
      showPlaceholder('<p>The 3-D renderer could not be fetched. The ground has been read and is tabled below; press <strong>Rebuild</strong> to try the renderer again.</p>');
    }
    syncExportButton();
    const groundLine = `${st.name}: ${ground.size} m of ground at ${ground.sample_m.toFixed(1)} m samples `
                     + `(${ground.source === 'qld' ? 'Queensland LiDAR/SRTM DTM' : 'SRTM ~30 m'}), `
                     + `${(ground.max - ground.min).toFixed(1)} m of relief`;
    setStatus(`${groundLine}; fetching the imagery…`);
    setNotes(notes);
    refreshTruth();
    refreshTable();
    syncCanvasName();
    if (typeof Elvis !== 'undefined') {
      Elvis.at(st.lat, st.lon).then(r => {
        if (seq !== tw.seq) return;
        tw.elvis = r;
        refreshTruth();
      }, () => {});
    }

    const image = await imageP;
    if (seq !== tw.seq) return;
    tw.image = image;
    if (!image) notes.push('No imagery could be fetched — the ground is coloured by height instead.');
    else if (image.source === 'esri') {
      notes.push(image.qld === 'failed'
        ? 'Queensland\'s aerial imagery could not be fetched, so Esri World Imagery is draped instead. Press Rebuild to ask for it again.'
        : 'Queensland\'s aerial imagery holds nothing here, so Esri World Imagery is draped instead.');
    }
    if (image && image.partial) notes.push('Some imagery tiles did not arrive; the gaps in the drape are white.');
    if (sc.terrain) applyImagery();
    setStatus(`${groundLine}, ${image ? (image.source === 'qld' ? 'Queensland aerial imagery' : 'Esri imagery') + ` at ${image.mpp.toFixed(2)} m/px` : 'no imagery'}.`);
    setNotes(notes);
    refreshTruth();
    refreshAttrib();
    syncCanvasName();
  }

  // The canvas is the control (the thing that takes focus and is operated) and
  // its name carries the headline numbers, rebuilt where the view changes
  // rather than where it is drawn — design-system.md's chart pattern.
  function syncCanvasName() {
    const cv = document.getElementById('twin-canvas');
    if (!cv) return;
    const st = currentStation();
    const g = tw.ground;
    let name = 'Three-dimensional view. No station is built yet.';
    if (st && g) {
      name = `Three-dimensional view of ${st.name}: ${g.size} m of ground at ${g.sample_m.toFixed(1)} m, `
           + `${(g.max - g.min).toFixed(1)} m of relief, a 2 m pole at the station and a 1.75 m figure beside it. `
           + (rig.mode === 'walk' ? 'Walking: W A S D move, drag looks, Escape stops.'
                                  : 'Drag to orbit, arrow keys turn, plus and minus zoom, F walks, T looks down, R resets.');
    }
    cv.setAttribute('aria-label', name);
  }

  // ── the panels ─────────────────────────────────────────────────────────────
  function fmtM(v, dp = 1) { return isFinite(v) ? `${v.toFixed(dp)} m` : '—'; }

  function truthHtml() {
    const st = currentStation();
    const g = tw.ground;
    if (!st) return '<p class="small">Nothing to compare until a station is chosen.</p>';
    const rows = [];
    const surveyed = st.elevation_ahd != null && isFinite(st.elevation_ahd) ? Number(st.elevation_ahd) : null;
    rows.push(['Position', `${Number(st.lat).toFixed(5)}, ${Number(st.lon).toFixed(5)}`]);
    if (surveyed != null) {
      rows.push([st.elevation_source ? 'Recorded height' : 'Surveyed height',
        `${fmtM(surveyed)} AHD${st.elevation_source ? ` <span class="small">(modelled: ${esc(st.elevation_source)})</span>` : ' <span class="small">(surveyed)</span>'}`]);
    } else {
      rows.push(['Surveyed height', '<span class="small">none on file</span>']);
    }
    if (g) {
      rows.push(['Ground at the pin', `${fmtM(g.h0, 2)} ${g.datum} <span class="small">(${g.source === 'qld' ? 'State DTM' : 'SRTM tiles'})</span>`]);
      if (surveyed != null) {
        const d = surveyed - g.h0;
        rows.push(['Difference', `${d >= 0 ? '+' : ''}${d.toFixed(2)} m <span class="small">recorded − ground</span>`]);
      }
      rows.push(['Ground model', g.source === 'qld'
        ? `Queensland Government DTM — LiDAR at 0.5–1 m where flown, SRTM elsewhere; sampled every ${g.sample_m.toFixed(1)} m over ${g.size} m`
        : `AWS Terrain Tiles — SRTM at ~${g.native_m} m, lifted to ${g.sample_m.toFixed(1)} m samples over ${g.size} m`]);
      rows.push(['Relief in the patch', `${fmtM(g.min)} to ${fmtM(g.max)} ${g.datum} (${fmtM(g.max - g.min)})`]);
    }
    const e = tw.elvis;
    if (e && e.ok) {
      rows.push(['Elvis at the pin', `${fmtM(e.height_m, 2)} AHD <span class="small">${esc(e.resolution || '')}${e.source ? ` · ${esc(e.source)}` : ''}${e.dataset ? ` · ${esc(e.dataset)}` : ''}</span>`]);
    } else if (e && !e.ok) {
      rows.push(['Elvis at the pin', `<span class="small">${esc(e.error || 'not answered')}</span>`]);
    } else if (g) {
      rows.push(['Elvis at the pin', '<span class="small">asking…</span>']);
    }
    const im = tw.image;
    if (g) rows.push(['Imagery', im ? `${im.source === 'qld' ? 'Queensland aerial program' : 'Esri World Imagery'} at ${im.mpp.toFixed(2)} m/px` : 'none']);
    return `<dl class="twin-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      <p class="small twin-truth-note">${g && g.source === 'qld'
        ? 'The State\'s DTM is bare earth in AHD, the datum every surveyed height in this file is in.'
        : 'Terrain tiles are heights above the EGM96 geoid — within about a metre of AHD over Australia, and not a survey.'}
        A recorded height well above the ground here usually means the coordinate is the gauge down in the channel and the mark is the hut on the bank — a flag on the position, not a correction to the height.</p>`;
  }

  function refreshTruth() {
    const el = document.getElementById('twin-truth');
    if (el) el.innerHTML = truthHtml();
  }

  // Part 3 of the chart pattern: the ground, as numbers, one activation away.
  // Two lines through the station — west to east and south to north — at
  // offsets that fit the patch.
  const TABLE_OFFSETS = [-400, -200, -100, -50, -20, -10, 0, 10, 20, 50, 100, 200, 400];

  function tableHtml() {
    const g = tw.ground;
    const st = currentStation();
    if (!g || !st) return '<p class="small">The table fills in once a twin is built.</p>';
    const offs = TABLE_OFFSETS.filter(o => Math.abs(o) <= g.half);
    const cell = v => `<td>${v.toFixed(1)}</td>`;
    return `
      <div class="table-wrap">
        <table class="twin-table">
          <caption>Ground height through ${esc(st.name)}, in metres ${esc(g.datum)}, along two lines that cross at the pole</caption>
          <thead><tr><th scope="col">Line</th>${offs.map(o => `<th scope="col">${o === 0 ? 'pole' : (o > 0 ? '+' : '') + o + ' m'}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><th scope="row">West → east</th>${offs.map(o => cell(heightAt(o, 0))).join('')}</tr>
            <tr><th scope="row">South → north</th>${offs.map(o => cell(heightAt(0, -o))).join('')}</tr>
          </tbody>
        </table>
      </div>`;
  }

  // The radio paths as a line of words under the stage — every far station
  // named, with its distance and bearing, each a button that goes there:
  // in the Stations map the map moves to it and the hand-over follows, on
  // the tab the twin is rebuilt for it. What the rays say, for whoever is
  // not looking at the picture, and the answer to "where does this link go"
  // without finding the sign on the ray.
  function pathsLineHtml() {
    const P = tw.paths;
    if (!P || !P.count) return '';
    const items = P.list.map(p =>
      `<button type="button" class="link-btn twin-path" onclick="DigitalTwin.followPath('${escAttr(p.farId)}')"
               title="${escAttr(p.kind === 'backbone' ? 'Backbone path' : 'Radio path')} to ${escAttr(p.far)} — go there">`
      + `<i class="twin-path-dot" style="--dot:${escAttr(p.colour)}"></i>${esc(p.far)}</button> `
      + `<span class="twin-path-fact">${p.km.toFixed(p.km < 10 ? 1 : 0)} km at ${Math.round(p.bearing)}°</span>`);
    return `<span class="twin-paths-lead">Radio path${P.count === 1 ? '' : 's'}${P.source === 'map' ? '' : ' (as recorded)'}:</span> ${items.join(' · ')}`;
  }

  function refreshPathsLine() {
    const el = document.getElementById('twin-paths');
    if (!el) return;
    const html = pathsLineHtml();
    el.innerHTML = html;
    el.hidden = !html;
  }

  function refreshTable() {
    const el = document.getElementById('twin-table');
    if (el) el.innerHTML = tableHtml();
  }

  // The station finder: the same shape as the Map Generator's and the
  // Inspections picker's — a search box, a capped list of hits, each a button.
  const FIND_CAP = 30;

  function hitsHtml() {
    const q = tw.query.trim().toLowerCase();
    if (!state.data) return '<p class="small">No stations file is loaded.</p>';
    if (!q) return `<p class="small" id="twin-find-lead">Type to search ${state.data.stations.length.toLocaleString()} stations by name, number or ALERT address.</p>`;
    const hits = [];
    for (const s of state.data.stations) {
      if ((s.name || '').toLowerCase().includes(q)
          || String(s.station_number || '').toLowerCase().includes(q)
          || String(s.id || '').toLowerCase().includes(q)
          || Object.values(s.alert_ids || {}).some(id => String(id) === q)) {
        hits.push(s);
        if (hits.length > FIND_CAP) break;
      }
    }
    const more = hits.length > FIND_CAP;
    const shown = more ? hits.slice(0, FIND_CAP) : hits;
    const lead = !hits.length ? `No station matches “${esc(tw.query)}”.`
               : more ? `More than ${FIND_CAP} match — keep typing to narrow it.`
               : `${hits.length} match${hits.length === 1 ? '' : 'es'}.`;
    if (!shown.length) return `<p class="small" id="twin-find-lead">${lead}</p>`;
    return `<p class="small" id="twin-find-lead">${lead}</p>
      <div class="twin-hits" role="group" aria-labelledby="twin-find-lead">
        ${shown.map(s => `
          <button type="button" class="twin-hit${s.id === tw.stationId ? ' is-here' : ''}" ${located(s) ? '' : 'disabled'}
                  onclick="DigitalTwin.pick('${escAttr(s.id)}')"
                  title="${located(s) ? 'Build this station\'s twin' : 'No coordinates on file'}">
            <span class="twin-hit-name">${esc(s.name)}</span>
            <span class="small">${esc(s.station_number || '—')}${located(s) ? '' : ' · no position'}</span>
          </button>`).join('')}
      </div>`;
  }

  function stationLineHtml() {
    const st = currentStation();
    if (!st) return '<p class="small">No station chosen.</p>';
    const role = typeof primaryRole === 'function' ? primaryRole(st) : 'field';
    return `<p class="twin-station"><strong>${esc(st.name)}</strong>
        <span class="small">${esc(st.station_number || st.id)} · ${esc(role)}${located(st) ? '' : ' · no position'}</span>
        <button type="button" class="link-btn" onclick="goToStation('${escAttr(st.id)}')" title="Open this station on the Stations map">Show on the map →</button>
      </p>`;
  }

  function scenePanelHtml() {
    const s = S();
    return `
      <div class="panel-header"><h2>Scene</h2></div>
      <div class="twin-fields">
        <label class="twin-field">Ground patch
          <select id="twin-size" onchange="DigitalTwin.setSize(this.value)">
            ${SIZES.map(v => `<option value="${v}" ${v === s.size ? 'selected' : ''}>${v} m square</option>`).join('')}
          </select>
        </label>
        <label class="twin-field">Vertical exaggeration <span class="small" id="twin-exag-out">${s.exag.toFixed(1)}×</span>
          <input type="range" id="twin-exag" min="1" max="3" step="0.1" value="${s.exag}"
                 oninput="DigitalTwin.setExag(this.value)">
        </label>
        <label class="check-label"><input type="checkbox" ${s.imagery ? 'checked' : ''} onchange="DigitalTwin.setImagery(this.checked)"><span>Drape the aerial imagery</span></label>
        <label class="check-label"><input type="checkbox" ${s.wire ? 'checked' : ''} onchange="DigitalTwin.setWire(this.checked)"><span>Show the mesh</span></label>
        <label class="check-label"><input type="checkbox" ${s.figure ? 'checked' : ''} onchange="DigitalTwin.setFigure(this.checked)"><span>Figure beside the pole (1.75 m)</span></label>
        <label class="check-label"><input type="checkbox" ${s.label ? 'checked' : ''} onchange="DigitalTwin.setLabel(this.checked)"><span>Name over the pole</span></label>
      </div>
      <p class="small">The pole is 2.000 m tall and 300 mm across, the figure 1.75 m, at every exaggeration — they are the ruler; only the ground stretches.</p>`;
  }

  function render() {
    S();
    const st = currentStation();
    return `
  <div class="layout twin-layout">
    <aside class="sidebar stack" aria-label="Digital twin controls">
      <div class="panel">
        <div class="panel-header"><h2>Station</h2></div>
        <div id="twin-station-line">${stationLineHtml()}</div>
        <label class="twin-field">Find a station
          <input type="search" id="twin-find" value="${esc(tw.query)}" autocomplete="off" spellcheck="false"
                 placeholder="name, station number or ALERT address"
                 oninput="DigitalTwin.setQuery(this.value)">
        </label>
        <div id="twin-hits">${hitsHtml()}</div>
      </div>
      <div class="panel" id="twin-panel-scene">${scenePanelHtml()}</div>
      <div class="panel">
        <div class="panel-header"><h2>Ground truth</h2></div>
        <div id="twin-truth">${truthHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Take it further</h2></div>
        <div class="button-group">
          <button type="button" id="twin-export" onclick="DigitalTwin.exportGlb()" ${tw.ground && tw.live ? '' : 'disabled'}
                  title="Download the scene — ground, imagery, pole and figure — as a glTF binary Blender opens with File → Import → glTF 2.0">⬇ Download .glb for Blender</button>
        </div>
        <p class="small">Metres, y up, origin on the ground at the pole; the file's header carries the station's coordinates and datum. Blender turns it z-up on import. Point cloud data, when it is ingested, will land in this same scene beside the mesh.</p>
      </div>
    </aside>
    <div class="stack">
      <div class="panel">
        <div class="panel-header">
          <h2 id="twin-heading">${st ? `Digital twin — ${esc(st.name)}` : 'Digital twin'}</h2>
          <div class="button-group">
            <button type="button" onclick="DigitalTwin.resetView()" title="Back to the opening view of the pole">↺ Reset view</button>
            <button type="button" onclick="DigitalTwin.topView()" title="Straight down on the patch">⬇ Top-down</button>
            <button type="button" id="twin-walk" aria-pressed="false" onclick="DigitalTwin.toggleWalk()" title="Stand on the ground at eye height and walk with the keys">🚶 Walk</button>
            <button type="button" onclick="DigitalTwin.rebuild()" title="Fetch the ground and the imagery again">⟳ Rebuild</button>
          </div>
        </div>
        <p class="twin-status" id="twin-status" role="status">${esc(tw.status || 'Building…')}</p>
        <p class="small twin-paths" id="twin-paths" hidden></p>
        <ul class="twin-notes" id="twin-notes" ${tw.notes.length ? '' : 'hidden'}>${tw.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        ${stageHtml()}
        <p class="small twin-pick" id="twin-pick"></p>
        <details class="twin-details">
          <summary>The ground under the station, as numbers</summary>
          <div id="twin-table">${tableHtml()}</div>
        </details>
        <p class="small twin-attrib" id="twin-attrib">${attribHtml()}</p>
      </div>
    </div>
  </div>`;
  }

  // The stage — the canvas and what stands over it — for the tab and for the
  // Stations map alike (map-twin.js puts this in its overlay). The ids are the
  // ones every refresh here writes to, and the two hosts are never on screen
  // together: the overlay lives in the Stations tab's map, the panel in this
  // tab's page.
  function stageHtml() {
    return `<div class="twin-stage" id="twin-stage">
          <canvas id="twin-canvas" tabindex="0" aria-label="Three-dimensional view. Nothing is built yet."></canvas>
          <div class="twin-compass" id="twin-compass" aria-hidden="true" style="--twin-heading:0deg">N</div>
          <p class="twin-hud" id="twin-hud">Drag to orbit, wheel to zoom, right-drag or Shift-drag to pan. Click the ground for its height.</p>
          <div class="twin-placeholder" id="twin-placeholder" hidden></div>
        </div>`;
  }

  function attribHtml() {
    const parts = [];
    if (tw.ground) parts.push(tw.ground.attribution);
    if (tw.image) parts.push(tw.image.attribution);
    if (typeof Elvis !== 'undefined') parts.push(Elvis.attribution);
    return parts.filter(Boolean).map(esc).join(' · ');
  }

  function refreshAttrib() {
    const el = document.getElementById('twin-attrib');
    if (el) { el.innerHTML = attribHtml(); el.title = el.textContent; }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  function stop() {
    tw.seq++;
    tw.live = false;
    if (sc.raf) { cancelAnimationFrame(sc.raf); sc.raf = 0; }
    if (sc.ro) { sc.ro.disconnect(); sc.ro = null; }
    for (const off of sc.off) { try { off(); } catch (_) {} }
    sc.off = [];
    rig.keys.clear(); rig.pointers.clear(); rig.pinch = null;
    clearScene();
    if (sc.renderer) {
      try { sc.renderer.dispose(); sc.renderer.forceContextLoss(); } catch (_) {}
    }
    sc.renderer = null; sc.scene = null; sc.camera = null; sc.canvas = null; sc.stage = null;
    sc.sun = null; sc.hemi = null;
    tw.hooks = null;
    tw.paths = null;
  }

  function init() {
    registerTabTeardown('DigitalTwin', stop);
    // A render of the tab that did not come through switchTab() — a seed in
    // the harness calling renderMain() — replaces the canvas under a live
    // renderer. Nothing may go on drawing into a node that is not in the
    // document, so that is a teardown first.
    if (sc.canvas && !document.contains(sc.canvas)) stop();
    build().catch(err => {
      setStatus('The twin could not be built.');
      setNotes([`${(err && err.message) || err}`]);
    }).then(refreshAttrib);
  }

  function syncExportButton() {
    const ex = document.getElementById('twin-export');
    if (ex) ex.disabled = !(tw.ground && tw.live && sc.terrain);
  }

  function rerenderStationBits() {
    const line = document.getElementById('twin-station-line');
    if (line) line.innerHTML = stationLineHtml();
    const hits = document.getElementById('twin-hits');
    if (hits) hits.innerHTML = hitsHtml();
    const h = document.getElementById('twin-heading');
    const st = currentStation();
    if (h) h.textContent = st ? `Digital twin — ${st.name}` : 'Digital twin';
    syncExportButton();
  }

  // ── the .glb ───────────────────────────────────────────────────────────────
  // A glTF 2.0 binary written here rather than through three's GLTFExporter,
  // which is a second module to fetch for a format this scene needs a
  // twentieth of. Everything with a mesh goes in with its world transform
  // baked into the vertices, one node each; the ground carries the imagery as
  // an embedded JPEG. y up and metres, which is what glTF specifies and what
  // Blender's importer turns into z-up on the way in.
  function pad4(n) { return (4 - (n % 4)) % 4; }

  async function buildGlb() {
    if (!sc.scene || !tw.ground || !THREE) return null;
    const st = currentStation();
    const g = tw.ground;
    const json = {
      asset: {
        version: '2.0',
        generator: 'MegaNet digital twin',
        extras: {
          station_id: st ? st.id : null, station_name: st ? st.name : null,
          station_number: st ? (st.station_number || null) : null,
          origin: { lat: st ? st.lat : null, lon: st ? st.lon : null,
                    ground_m: g.h0, datum: g.datum, axes: 'x east, y up, z south; metres' },
          ground: { source: g.source, sample_m: g.sample_m, size_m: g.size, exaggeration: S().exag,
                    attribution: g.attribution },
          imagery: tw.image && S().imagery ? { source: tw.image.source, attribution: tw.image.attribution } : null,
          pole: { height_m: POLE_H, diameter_m: POLE_R * 2 },
          figure: { height_m: FIGURE_H },
          generated: new Date().toISOString(),
        },
      },
      scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [],
      accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
    };
    const parts = [];
    let offset = 0;
    const addView = (bytes, target) => {
      const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength };
      if (target) view.target = target;
      json.bufferViews.push(view);
      parts.push(bytes);
      offset += bytes.byteLength;
      const p = pad4(offset);
      if (p) { parts.push(new Uint8Array(p)); offset += p; }
      return json.bufferViews.length - 1;
    };
    const addAccessor = (arr, type, componentType, count, target, minmax) => {
      const acc = { bufferView: addView(arr, target), componentType, count, type };
      if (minmax) { acc.min = minmax.min; acc.max = minmax.max; }
      json.accessors.push(acc);
      return json.accessors.length - 1;
    };
    const materialIndex = new Map();
    const materialFor = async (mat, withMap) => {
      const key = `${mat.uuid}|${withMap ? 'map' : ''}`;
      if (materialIndex.has(key)) return materialIndex.get(key);
      const m = { name: mat.name || '', pbrMetallicRoughness: {
        baseColorFactor: withMap ? [1, 1, 1, 1] : [mat.color.r, mat.color.g, mat.color.b, 1],
        metallicFactor: isFinite(mat.metalness) ? mat.metalness : 0,
        roughnessFactor: isFinite(mat.roughness) ? mat.roughness : 1,
      } };
      if (withMap && tw.image) {
        const blob = await new Promise(res => tw.image.canvas.toBlob(res, 'image/jpeg', 0.9));
        if (blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          json.images = json.images || [];
          json.textures = json.textures || [];
          json.samplers = json.samplers || [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
          json.images.push({ bufferView: addView(bytes), mimeType: 'image/jpeg', name: 'imagery' });
          json.textures.push({ sampler: 0, source: json.images.length - 1 });
          m.pbrMetallicRoughness.baseColorTexture = { index: json.textures.length - 1 };
        }
      }
      json.materials.push(m);
      materialIndex.set(key, json.materials.length - 1);
      return json.materials.length - 1;
    };

    sc.scene.updateMatrixWorld(true);
    const meshes = [];
    // traverseVisible, not traverse: a figure switched off is a hidden
    // *group*, and its parts keep visible = true of their own. What is not in
    // the frame is not in the file.
    sc.scene.traverseVisible(o => { if (o.isMesh && o.userData.export !== false && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    for (const mesh of meshes) {
      let geo = mesh.geometry.index ? mesh.geometry : mesh.geometry;   // both fine; index optional
      geo = geo.clone().applyMatrix4(mesh.matrixWorld);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const pos = geo.attributes.position.array;
      const n = geo.attributes.position.count;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
        const v = pos[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      const attributes = {
        POSITION: addAccessor(new Float32Array(pos), 'VEC3', 5126, n, 34962, { min, max }),
        NORMAL:   addAccessor(new Float32Array(geo.attributes.normal.array), 'VEC3', 5126, n, 34962),
      };
      const withMap = mesh === sc.terrain && !!mesh.material.map;
      if (geo.attributes.uv && withMap) {
        // glTF's v runs down the image; three's runs up.
        const uv = new Float32Array(geo.attributes.uv.array);
        for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];
        attributes.TEXCOORD_0 = addAccessor(uv, 'VEC2', 5126, n, 34962);
      }
      if (!withMap && geo.attributes.color && mesh.material.vertexColors) {
        attributes.COLOR_0 = addAccessor(new Float32Array(geo.attributes.color.array), 'VEC3', 5126, n, 34962);
      }
      const prim = { attributes, mode: 4, material: await materialFor(mesh.material, withMap) };
      if (geo.index) {
        const idx = geo.index.array;
        const wide = n > 65535;
        const arr = wide ? new Uint32Array(idx) : new Uint16Array(idx);
        prim.indices = addAccessor(arr, 'SCALAR', wide ? 5125 : 5123, idx.length, 34963);
      }
      json.meshes.push({ name: mesh.name || 'mesh', primitives: [prim] });
      json.nodes.push({ name: mesh.name || 'mesh', mesh: json.meshes.length - 1 });
      json.scenes[0].nodes.push(json.nodes.length - 1);
      geo.dispose();
    }
    json.buffers[0].byteLength = offset;

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = pad4(jsonBytes.byteLength);
    const binLen = offset;
    const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + binLen;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let p = 0;
    dv.setUint32(p, 0x46546C67, true); dv.setUint32(p + 4, 2, true); dv.setUint32(p + 8, total, true); p += 12;
    dv.setUint32(p, jsonBytes.byteLength + jsonPad, true); dv.setUint32(p + 4, 0x4E4F534A, true); p += 8;
    out.set(jsonBytes, p); p += jsonBytes.byteLength;
    for (let i = 0; i < jsonPad; i++) out[p++] = 0x20;
    dv.setUint32(p, binLen, true); dv.setUint32(p + 4, 0x004E4942, true); p += 8;
    for (const part of parts) { out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), p); p += part.byteLength; }
    return out.buffer;
  }

  function exportGlb() {
    const st = currentStation();
    buildGlb().then(buf => {
      if (!buf) { setStatus('Nothing to export yet — build a twin first.'); return; }
      const name = `twin-${(st && st.id) || 'station'}-${tw.ground ? tw.ground.size : S().size}m.glb`;
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })),
        download: name,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      announce(`Downloaded ${name}`);
    }).catch(err => setStatus(`The export failed: ${(err && err.message) || err}`));
  }

  // ── public surface ─────────────────────────────────────────────────────────
  return {
    render, init, stop,

    // The station finder.
    setQuery(v) {
      tw.query = String(v || '');
      const hits = document.getElementById('twin-hits');
      if (hits) hits.innerHTML = hitsHtml();
    },
    pick(id) {
      const s = stationById(id);
      if (!s) return;
      tw.stationId = s.id;
      rerenderStationBits();
      init();
    },
    // From the station card, or anywhere else with a station in hand.
    openStation(id) {
      const s = stationById(id);
      if (!s) return;
      tw.stationId = s.id;
      switchTab('twin');
    },

    // The scene settings — each persisted, each applied without a refetch
    // where it can be.
    setSize(v) {
      const n = Number(v);
      if (!SIZES.includes(n) || n === S().size) return;
      S().size = n; saveSettings();
      init();
    },
    setExag(v) {
      const n = Math.max(1, Math.min(3, Number(v) || 1));
      S().exag = n; saveSettings();
      const out = document.getElementById('twin-exag-out');
      if (out) out.textContent = `${n.toFixed(1)}×`;
      if (sc.terrain && tw.ground) {
        const pos = sc.terrain.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setY(i, (tw.ground.elev[i] - tw.ground.h0) * n);
        pos.needsUpdate = true;
        sc.terrain.geometry.computeVertexNormals();
        sc.terrain.geometry.computeBoundingSphere();
        if (sc.wire) { sc.wire.geometry.dispose(); sc.wire.geometry = new THREE.WireframeGeometry(sc.terrain.geometry); }
        if (sc.figure) sc.figure.position.y = yAt(sc.figure.position.x, sc.figure.position.z);
        if (sc.paths) buildPaths(currentStation());
        requestFrame();
      }
    },
    setImagery(on) { S().imagery = !!on; saveSettings(); applyImagery(); },
    setWire(on)    { S().wire = !!on; saveSettings(); if (sc.wire) { sc.wire.visible = !!on; requestFrame(); } },
    setFigure(on)  { S().figure = !!on; saveSettings(); if (sc.figure) { sc.figure.visible = !!on; requestFrame(); } },
    setLabel(on)   { S().label = !!on; saveSettings(); if (sc.label) { sc.label.visible = !!on; requestFrame(); } },

    // The camera.
    resetView() { resetOrbit(); requestFrame(); },
    topView()   { lookDown(); requestFrame(); },
    toggleWalk() { if (rig.mode === 'walk') leaveWalk(); else enterWalk(); requestFrame(); },
    rebuild() {
      const st = currentStation();
      if (st && located(st)) {
        const box = patchBox(st.lat, st.lon, S().size);
        const key = `${box.south.toFixed(6)},${box.west.toFixed(6)}|${box.size}`;
        groundCache.delete(key); imageCache.delete(key);
      }
      init();
    },

    exportGlb, buildGlb,

    // Go to the far end of a radio path. Inside the Stations map, the map
    // moves there and, at this zoom, hands over to that station's twin
    // (map-twin.js); on the tab, the twin is rebuilt for it.
    followPath(id) {
      const s = stationById(id);
      if (!s || !located(s)) return;
      if (tw.hooks) {
        // The card is the map's memory of what you are looking at and the
        // twin's first choice of station (map-twin.js), so the far station
        // goes on it and the map moves there at this zoom: the move's end is
        // the hand-over to its twin. Not goToStation(), which rebuilds the
        // tab and the map and lands at zoom 11.
        if (typeof showStationCard === 'function') showStationCard(s.id);
        if (typeof state !== 'undefined' && state.map) {
          const z = Math.max(state.map.getZoom(), typeof MapTwin !== 'undefined' ? MapTwin.zoom : 17);
          state.map.setView([s.lat, s.lon], z, { animate: false });
        }
        return;
      }
      tw.stationId = s.id;
      rerenderStationBits();
      init();
    },

    // The memory strip's holder (mem-meter.js): what the caches hold, and
    // the Release button's call.
    cacheBytes, clearCaches,

    // ── Embedded in the Stations map (map-twin.js) ──
    // The stage markup for a host of its own, the build into it, and what the
    // host wants to be told. `hooks.leave` is called when the operator wheels
    // out past the widest orbit or presses Escape — the map's cue to take
    // over again. stop() is the way out, as it is for the tab.
    stageHtml,
    mountAt(id, hooks) {
      const s = stationById(id);
      if (!s) return false;
      tw.stationId = s.id;
      tw.hooks = hooks || null;
      init();
      return true;
    },
    // Fetch a station's ground and imagery into the caches ahead of a
    // hand-over that has not happened yet — a station selected on the map
    // at any zoom is a station about to be looked at closely.
    prefetch(id) {
      const s = stationById(id);
      if (!located(s) || typeof fetch !== 'function') return;
      const box = patchBox(s.lat, s.lon, S().size);
      groundFor(box).catch(() => {});
      imageryFor(box).catch(() => {});
    },
    patchSize() { return S().size; },
    embedded() { return !!tw.hooks; },

    // Read by the check and by nothing else: what the scene is standing on.
    libLoaded() { return !!THREE; },
    debug() {
      const g = tw.ground;
      return {
        live: tw.live, lib: !!THREE, built: !!sc.terrain, frames: tw.frames,
        stationId: tw.stationId, mode: rig.mode,
        size: g ? g.size : null, N, sample_m: g ? g.sample_m : null,
        source: g ? g.source : null, holes: g ? g.holes : null, filled: g ? g.filled : null, qld: g ? g.qld : null,
        h0: g ? g.h0 : null, min: g ? g.min : null, max: g ? g.max : null,
        imagery: tw.image ? tw.image.source : null, mpp: tw.image ? tw.image.mpp : null,
        exag: S().exag, status: tw.status, notes: tw.notes.slice(),
        pole: sc.pole ? { h: POLE_H, r: POLE_R, baseY: sc.pole.position.y - POLE_H / 2, x: sc.pole.position.x, z: sc.pole.position.z } : null,
        figure: sc.figure ? { h: FIGURE_H, x: sc.figure.position.x, z: sc.figure.position.z, baseY: sc.figure.position.y, visible: sc.figure.visible } : null,
        vertices: sc.terrain ? sc.terrain.geometry.attributes.position.count : 0,
        textured: !!(sc.terrain && sc.terrain.material.map),
        contextLost: sc.renderer ? sc.renderer.getContext().isContextLost() : null,
        camera: sc.camera ? { x: sc.camera.position.x, y: sc.camera.position.y, z: sc.camera.position.z } : null,
        paths: tw.paths ? { count: tw.paths.count, source: tw.paths.source, pending: tw.paths.pending, list: tw.paths.list.slice() } : null,
        embedded: !!tw.hooks,
        heightAt, yAt,
        vertexY: i => (sc.terrain ? sc.terrain.geometry.attributes.position.getY(i) : NaN),
        vertexX: i => (sc.terrain ? sc.terrain.geometry.attributes.position.getX(i) : NaN),
        vertexZ: i => (sc.terrain ? sc.terrain.geometry.attributes.position.getZ(i) : NaN),
      };
    },
    // Seams for the check: the raster reader and the geometry, so the arithmetic
    // under test is the arithmetic that runs.
    _readTiffF32: readTiffF32,
    _localXZ: localXZ,
    _patchBox: patchBox,
    _upsample: upsample,
    _sizes: () => SIZES.slice(),
    _libUrl: () => LIB_URL,
    // Forget the station, so a check can measure the tab with nothing chosen.
    _clear() {
      tw.stationId = null; tw.ground = null; tw.image = null; tw.elvis = null;
      tw.status = ''; tw.notes = []; tw.picked = null; tw.paths = null;
    },
  };
})();
if (typeof window !== 'undefined') window.DigitalTwin = DigitalTwin;
