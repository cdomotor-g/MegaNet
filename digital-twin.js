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
// Vertical exaggeration scales the relief only. The station is built at its
// true size at every setting, and the figure is 1.75 m — they are the ruler.
// What the station is — a Type 3 rainfall pole or a river-gauge tower, and
// what is inside its enclosure — is read from the record; "the station as
// built" below has the rules.
//
// ── The horizon ──────────────────────────────────────────────────────────────
//
// A patch of ground floating in a flat colour reads as a model on a table; the
// same patch with the country running off to a horizon reads as a place. So
// past the patch's edge there is far ground to 60 km, a sky, and haze:
//
// * **Three sheets of heights**, each 201 × 201 like the patch: ±4 km, ±20 km
//   and ±60 km about the station. The inner one is the State's raster
//   resampled to 40 m (one request, AHD like the patch) where its box is
//   inside the service's extent; the outer two are the ~30 m tiles at the
//   zoom terrain.js picks for 200 m and 600 m samples — four to nine tiles
//   and one to four. Nothing here is fetched until the patch is standing.
// * **One mesh of concentric squares**, not a second grid: the innermost square
//   *is* the patch's 800 edge vertices, and each square out is a few percent
//   wider than the last, so the sampling is fine where the eye is close and
//   coarse at 60 km, in ~50,000 vertices. Every side keeps 200 segments to
//   1.5 patch-halves, 100 to 4, then 50; where a square is finer than the
//   one outside it, its odd vertices are put on the straight line between
//   their neighbours, so there is no crack. The seam with the patch is exact
//   — same vertices, same heights — and the tiles' heights just outside it
//   are lifted by however much they differ from the LiDAR at the edge, a
//   lift that fades to nothing by three patch-halves out. The eye sees a
//   continuous ground, and the notes still say which is which.
// * **The Earth's curve**: every far vertex is dropped by d²/2R with R the
//   Earth's radius over (1 − 0.13), the light's own refraction — 27 m at
//   20 km, 245 m at 60 km — which is what puts a horizon where one belongs
//   and hides the far side of a plain below it, as the depth buffer then
//   does on its own. The drop starts at the patch's circumscribed circle so
//   the seam is untouched; the 9 cm that costs at 60 km is not a number.
// * **A sky**: a dome that rides with the camera, shaded from zenith to horizon
//   to the haze below it, and exponential fog in the horizon's colour so the
//   far ground fades into the sky rather than ending at an edge — the
//   colours are tokens, so the dark theme is a dusk and the light a day.
// * **The depth buffer**: 24 bits with a near plane of 0.2 m (the walker can
//   stand against the pole) cannot tell 40 km from 40.5. Rather than a
//   logarithmic depth — which writes gl_FragDepth, and so loses the polygon
//   offset the wireframe rides on — the far mesh's triangles are simply put
//   in the index outermost first, shell by shell, so where the buffer cannot
//   decide, the later-drawn nearer ridge wins, as a painter would have it.
//   The camera is never more than a few kilometres from the station, so the
//   station's order is the camera's to within the resolution in question.
// * **It is scenery**: not in the `.glb` (Blender wants the site, and 12 MB of
//   satellite sheet is not the site), not clickable, and switchable off in
//   the Scene panel — it is a few more requests, and the setting is kept.
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

  // The horizon (see the header): the three sheets' half-widths, the texels
  // each is draped with (8, 39 and 117 m/px), how far out the tiles are
  // lifted to meet the LiDAR edge (in patch-halves), the Earth the eye sees
  // (its radius over 1 − 0.13, the standard optical refraction), the haze's
  // density (95 % at 60 km, 3 % at 5 km) and the sky dome's radius.
  const SHELL_HALF   = [4000, 20000, 60000];
  const HORIZON_M    = SHELL_HALF[SHELL_HALF.length - 1];
  const SHELL_PX     = 1024;
  const BLEND_OUT    = 3;
  const EARTH_R_EYE  = 7320000;
  const HAZE_DENSITY = 2.9e-5;
  const SKY_R        = 100000;
  const CAMERA_FAR   = 250000;

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
    model: null,       // the station as built: { structure, telemetry, telemetryKnown, top, poleTop, ladder, deck, plate }
    horizon: null,     // the far field's sheets: { lat, lon, grids: [ { elev, n, rows, source, zoom, box, … } | null ] }
    horizonImages: null,   // the sheets' imagery, one per shell, as they land
    horizonOffsets: null,  // the lift the tiles need to meet the LiDAR at each of the patch's edge vertices
    horizonUnfilled: 0,    // edge vertices no sheet had a height under
    horizonPending: false, // a fetch is in flight
    statusBase: '',        // the status line without the horizon's clause
  };

  // Ground under a far station that has no recorded height, read off the
  // tiles once and kept for the session — a path's far end is the same place
  // every time it is drawn.
  const farHeightCache = new Map();

  // The live scene — everything the teardown has to dispose of.
  const sc = {
    renderer: null, scene: null, camera: null, canvas: null, stage: null,
    terrain: null, wire: null, pole: null, band: null, figure: null, label: null, paths: null,
    station: null, doors: [],   // the station as built, and its doors
    sun: null, hemi: null, texture: null, raf: 0, ro: null, dirty: false,
    horizon: null, shells: null, sky: null,   // the far field's group, its shells' bookkeeping, the dome
    off: [],          // listener removers
  };

  // The camera rig: orbit about a target, or walk on the ground.
  const rig = {
    mode: 'orbit',
    target: null, radius: 26, theta: 0.65, phi: 1.05,   // orbit: spherical about target
    px: 3, pz: 6, yaw: -0.45, pitch: -0.08,             // POV: feet position and look
    level: 'ground', climb: 0, climbLatch: false,       // POV: on the ground, on the ladder (climb metres up it), or on the deck
    keys: new Set(),
    pointers: new Map(),
    pinch: null,
  };

  const groundCache = new Map();   // `${lat},${lon}|${size}` → tw.ground
  const imageCache  = new Map();   // the same key → tw.image

  // ── settings ───────────────────────────────────────────────────────────────

  const DEFAULTS = { size: 400, exag: 1, imagery: true, figure: true, label: true, wire: false, horizon: true };

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('mn-twin') || '{}') || {}; } catch (_) { s = {}; }
    const out = { ...DEFAULTS };
    if (SIZES.includes(Number(s.size))) out.size = Number(s.size);
    const ex = Number(s.exag);
    if (isFinite(ex) && ex >= 1 && ex <= 3) out.exag = ex;
    for (const k of ['imagery', 'figure', 'label', 'wire', 'horizon']) if (typeof s[k] === 'boolean') out[k] = s[k];
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

  // The ground as drawn, wherever the camera is: the patch on it, the horizon
  // off it (when there is one), the station's own level where neither knows.
  function surfaceY(x, z) {
    const g = tw.ground;
    if (g && sc.horizon && Math.max(Math.abs(x), Math.abs(z)) > g.half) {
      const r = ringSurface(x, z);
      if (isFinite(r)) return r;
    }
    return yAt(x, z);
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

  function boxKey(box) { return `${box.south.toFixed(6)},${box.west.toFixed(6)}|${box.size}`; }

  function imageryFor(box, px = texturePx(box.size)) {
    const key = boxKey(box);
    if (imageCache.has(key)) return Promise.resolve(imageCache.get(key));
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
    for (const hz of horizonCache.values()) for (const g of hz.grids) b += g && g.elev ? g.elev.byteLength : 0;
    return b;
  }
  function clearCaches() { imageCache.clear(); groundCache.clear(); horizonCache.clear(); }

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
    removeHorizon();
    sc.pole = null; sc.band = null; sc.doors = [];
    for (const k of ['terrain', 'wire', 'station', 'figure', 'label', 'paths', 'sky']) {
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
    // The far plane holds the sky dome and the horizon's corners (85 km);
    // it is the near plane, not this, that sets the depth buffer's grain.
    sc.camera = new THREE.PerspectiveCamera(50, 1, 0.2, CAMERA_FAR);
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

  // The height ramp, for when there is no imagery: dark green in the low
  // ground through olive and tan to a pale crest, over [lo, hi]. Linear-space
  // colours, as three wants vertex colours. The patch alone is coloured over
  // its own range; with the horizon standing, both are coloured over the two
  // ranges together, so the seam is one colour and a far hill is a hill.
  function rampColour(c, h, lo, hi) {
    const t = Math.min(1, Math.max(0, (h - lo) / Math.max(1, hi - lo)));
    c.setHSL(0.30 - 0.22 * t, 0.42 - 0.18 * t, 0.22 + 0.42 * t);
    return c;
  }
  function paintPatchRamp(lo, hi) {
    const g = tw.ground;
    if (!g || !sc.terrain) return;
    const col = sc.terrain.geometry.attributes.color, c = new THREE.Color();
    for (let i = 0; i < col.count; i++) { rampColour(c, g.elev[i], lo, hi); col.setXYZ(i, c.r, c.g, c.b); }
    col.needsUpdate = true;
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
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = g.elev[i];
      pos.setY(i, (h - g.h0) * exag);
      rampColour(c, h, g.min, g.max);
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

  // ── the horizon ────────────────────────────────────────────────────────────
  // Everything past the patch's edge — the header has the shape of it. Three
  // sheets of heights about the station, one mesh of concentric squares that
  // starts on the patch's own edge, a dome for the sky and haze to fade into
  // it. Fetched only once the patch is standing, cached by station, and
  // drawn from the cache when the station comes round again.
  const horizonCache = new Map();   // `${lat},${lon}` → { lat, lon, grids }

  function shellBox(lat, lon, half) { return patchBox(lat, lon, half * 2); }

  // One sheet's heights, N × N over its box, or null. The inner sheet is the
  // State's raster where the box is inside its extent — the LiDAR resampled
  // to 40 m, in AHD like the patch, one request — and the tiles where it is
  // not or where the State holds holes; the outer two are the tiles at the
  // zoom terrain.js picks for the spacing. A grid from the tiles has its
  // rows even in Mercator y (terrain.js's lattice), the State's in latitude;
  // both have their columns even in longitude, and `rows` says which.
  function shellGrid(box, k) {
    const tiles = () => {
      if (typeof Terrain === 'undefined') return Promise.resolve(null);
      return Terrain.grid({ west: box.west, east: box.east, south: box.south, north: box.north }, N, N)
        .then(r => (r && r.ok
          ? { elev: r.elev, n: N, rows: 'merc', source: 'srtm', zoom: r.zoom, resolution_m: r.resolution_m,
              missing: r.missing, attribution: r.attribution, box }
          : null))
        .catch(() => null);
    };
    if (k !== 0) return tiles();
    return qldGround(box).then(q => (q.kind === 'ok' && q.holes === 0
      ? { elev: q.elev, n: N, rows: 'lat', source: 'qld', zoom: null, resolution_m: box.size / (N - 1),
          missing: 0, attribution: ATTR_QLD_DEM, box }
      : tiles()), () => tiles());
  }

  function horizonKey(st) { return `${st.lat.toFixed(6)},${st.lon.toFixed(6)}`; }

  // The three sheets, in parallel; resolves — never rejects — to what came,
  // with a null for a sheet that did not. Cached while at least one did.
  function horizonFor(st) {
    const key = horizonKey(st);
    if (horizonCache.has(key)) return Promise.resolve(horizonCache.get(key));
    return Promise.all(SHELL_HALF.map((h, k) => shellGrid(shellBox(st.lat, st.lon, h), k))).then(grids => {
      const hz = { key, lat: st.lat, lon: st.lon, grids };
      if (grids.some(Boolean)) {
        horizonCache.set(key, hz);
        while (horizonCache.size > CACHE_MAX) horizonCache.delete(horizonCache.keys().next().value);
      }
      return hz;
    });
  }

  function mercY(lat) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  }

  // A sheet's height at a scene point, bilinear between its nodes; NaN off
  // the sheet or on a tile that did not arrive.
  function gridAt(g, x, z, lat0, lon0) {
    const b = g.box, n = g.n;
    const lat = lat0 - z / metresPerDegLat(), lon = lon0 + x / metresPerDegLon(lat0);
    let fx = (lon - b.west) / (b.east - b.west) * (n - 1);
    let fy = (g.rows === 'merc'
      ? (mercY(lat) - mercY(b.north)) / (mercY(b.south) - mercY(b.north))
      : (b.north - lat) / (b.north - b.south)) * (n - 1);
    const eps = 1e-6;
    if (!(fx >= -eps && fx <= n - 1 + eps && fy >= -eps && fy <= n - 1 + eps)) return NaN;
    fx = Math.min(n - 1, Math.max(0, fx)); fy = Math.min(n - 1, Math.max(0, fy));
    const ix = Math.min(n - 2, Math.floor(fx)), iy = Math.min(n - 2, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy, e = g.elev;
    const a = e[iy * n + ix], bb = e[iy * n + ix + 1], c = e[(iy + 1) * n + ix], d = e[(iy + 1) * n + ix + 1];
    return a * (1 - tx) * (1 - ty) + bb * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }

  // The far ground's own height (AHD or EGM96, as the sheet has it) at a scene
  // point: the finest sheet that holds it. NaN where none does.
  function ringHeight(x, z) {
    const hz = tw.horizon;
    if (!hz) return NaN;
    for (const g of hz.grids) {
      if (!g) continue;
      const v = gridAt(g, x, z, hz.lat, hz.lon);
      if (isFinite(v)) return v;
    }
    return NaN;
  }

  // The squares. Vertex t of a square of half-width h with M segments a side
  // goes clockwise seen from above: the north edge west → east, the east
  // north → south, the south east → west, the west south → north. The
  // innermost square has M0 = N − 1 segments, so its vertices are the
  // patch's own edge vertices.
  const M0 = N - 1;
  function squareXZ(h, M, t) {
    const side = Math.floor(t / M), u = (t % M) / M;
    switch (side) {
      case 0:  return { x: -h + 2 * h * u, z: -h };
      case 1:  return { x: h, z: -h + 2 * h * u };
      case 2:  return { x: h - 2 * h * u, z: h };
      default: return { x: -h, z: h - 2 * h * u };
    }
  }

  // The inverse: where a point stands round its own square, as a (fractional)
  // index into the innermost square's 4·M0 vertices — which is what the lift
  // at the patch's edge is stored by.
  function perimeterT(x, z) {
    const hq = Math.max(Math.abs(x), Math.abs(z));
    if (hq === 0) return 0;
    let side, u;
    if (-z >= Math.abs(x))     { side = 0; u = (x + hq) / (2 * hq); }
    else if (x >= Math.abs(z)) { side = 1; u = (z + hq) / (2 * hq); }
    else if (z >= Math.abs(x)) { side = 2; u = (hq - x) / (2 * hq); }
    else                       { side = 3; u = (hq - z) / (2 * hq); }
    return (side + u) * M0;
  }

  // The squares from the patch's edge to the horizon: 200 segments a side to
  // 1.5 patch-halves, 100 to 4, then 50 all the way; each a few percent wider
  // than the last, a run of them ending exactly on each sheet's edge so a
  // shell's mesh starts and stops on a square.
  function squareList(half) {
    const segs = [[half, 1.5 * half, M0], [1.5 * half, 4 * half, M0 / 2], [4 * half, SHELL_HALF[0], M0 / 4]];
    for (let k = 1; k < SHELL_HALF.length; k++) segs.push([SHELL_HALF[k - 1], SHELL_HALF[k], M0 / 4]);
    const out = [{ h: half, M: M0 }];
    for (const [a, b, M] of segs) {
      if (!(b > a)) continue;
      const n = Math.max(1, Math.ceil(Math.log(b / a) / Math.log(1 + 3 / M)));
      const q = Math.pow(b / a, 1 / n);
      for (let i = 1; i <= n; i++) out.push({ h: i === n ? b : a * Math.pow(q, i), M });
    }
    return out;
  }

  // The lift at the patch's edge, linear between the edge vertices, wrapping.
  function offsetAt(t) {
    const o = tw.horizonOffsets;
    if (!o) return 0;
    const L = o.length, f = ((t % L) + L) % L;
    const i = Math.floor(f), w = f - i;
    return o[i] * (1 - w) + o[(i + 1) % L] * w;
  }

  // The Earth's curve, from the patch's circumscribed circle out.
  function earthDrop(d, half) { return Math.max(0, d * d - 2 * half * half) / (2 * EARTH_R_EYE); }

  // The far ground as drawn, at any point outside the patch: the sheet's
  // height, lifted to meet the LiDAR edge where that is near, exaggerated
  // like the patch, and dropped by the Earth's curve. NaN inside the patch,
  // and the station's own level where no sheet has a height.
  function ringSurface(x, z) {
    const g = tw.ground;
    if (!g || !tw.horizon) return NaN;
    const hq = Math.max(Math.abs(x), Math.abs(z));
    if (hq < g.half) return NaN;
    const w = Math.min(1, Math.max(0, (hq / g.half - 1) / (BLEND_OUT - 1)));
    const r = ringHeight(x, z);
    const H = (isFinite(r) ? r : g.h0) + (1 - w) * offsetAt(perimeterT(x, z));
    return (H - g.h0) * S().exag - earthDrop(Math.hypot(x, z), g.half);
  }

  function removeHorizon() {
    if (sc.shells) for (const sh of sc.shells) if (sh.tex) { sh.tex.dispose(); sh.tex = null; }
    if (sc.horizon && sc.scene) { sc.scene.remove(sc.horizon); disposeObject(sc.horizon); }
    const had = !!sc.horizon;
    sc.horizon = null; sc.shells = null;
    setFog(false);
    if (had && tw.ground) paintPatchRamp(tw.ground.min, tw.ground.max);
  }

  // Haze: the near fog fades the patch's own edges when there is nothing past
  // them; the far one is the air between here and 60 km.
  function setFog(far) {
    if (!sc.scene || !tw.ground) return;
    const c = skyColour();
    sc.scene.fog = far ? new THREE.FogExp2(c, HAZE_DENSITY) : new THREE.Fog(c, tw.ground.size * 1.1, tw.ground.size * 4);
  }

  // The mesh: one BufferGeometry per sheet, its squares' vertices in order,
  // its triangles outermost square first (the header says why), a shell's
  // own texture coordinates over its sheet's box, and a colour ramp on the
  // patch's own scale for when there is no imagery. Heights are set by
  // liftHorizon(), which the exaggeration slider calls again.
  function buildHorizon() {
    removeHorizon();
    const g = tw.ground, hz = tw.horizon;
    if (!g || !hz || !hz.grids.some(Boolean) || !sc.scene) return;
    const off = new Float32Array(4 * M0);
    let unfilled = 0;
    for (let t = 0; t < 4 * M0; t++) {
      const p = squareXZ(g.half, M0, t);
      const r = ringHeight(p.x, p.z);
      if (!isFinite(r)) unfilled++;
      off[t] = heightAt(p.x, p.z) - (isFinite(r) ? r : g.h0);
    }
    tw.horizonOffsets = off;
    tw.horizonUnfilled = unfilled;
    const squares = squareList(g.half);
    const group = new THREE.Group();
    group.name = 'horizon';
    const shells = [];
    for (let k = 0; k < SHELL_HALF.length; k++) {
      // A sheet that did not arrive is a shell not drawn — a ring of nothing,
      // rather than a ring of flat ground at the station's level.
      if (!hz.grids[k]) continue;
      const outerH = SHELL_HALF[k], innerH = k === 0 ? g.half : SHELL_HALF[k - 1];
      const mine = squares.filter(s => s.h >= innerH - 1e-6 && s.h <= outerH + 1e-6);
      if (mine.length < 2) continue;
      const base = [];
      let count = 0;
      for (const s of mine) { base.push(count); count += 4 * s.M; }
      const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2), col = new Float32Array(count * 3);
      const isInner = new Uint8Array(count), meta = new Int32Array(count * 2);
      for (let qi = 0; qi < mine.length; qi++) {
        const s = mine[qi];
        for (let t = 0; t < 4 * s.M; t++) {
          const i = base[qi] + t, p = squareXZ(s.h, s.M, t);
          pos[i * 3] = p.x; pos[i * 3 + 2] = p.z;
          uv[i * 2] = (p.x + outerH) / (2 * outerH); uv[i * 2 + 1] = (outerH - p.z) / (2 * outerH);
          isInner[i] = s.h === g.half ? 1 : 0;
          meta[i * 2] = qi; meta[i * 2 + 1] = t;
        }
      }
      // Outermost pair of squares first. Between a square and a coarser one
      // outside it, every second vertex of the finer is used; its odd ones
      // are the seam list, put on the line between their neighbours.
      const idx = [], seams = [];
      for (let qi = mine.length - 2; qi >= 0; qi--) {
        const A = mine[qi], B = mine[qi + 1], r = A.M / B.M, nA = 4 * A.M, nB = 4 * B.M;
        for (let t = 0; t < nB; t++) {
          const a = base[qi] + (t * r) % nA, b = base[qi] + ((t + 1) * r) % nA;
          const c = base[qi + 1] + (t + 1) % nB, d = base[qi + 1] + t;
          idx.push(a, b, c, a, c, d);
          if (r === 2) seams.push(base[qi] + (t * r + 1) % nA, a, b);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `horizon ${k}`;
      mesh.renderOrder = SHELL_HALF.length - k;    // the far shell first
      mesh.userData.export = false;
      group.add(mesh);
      shells.push({ k, mesh, half: outerH, squares: mine, base, isInner, meta, tex: null,
                    seams: Int32Array.from(seams), seamSet: new Set(seams.filter((_, i) => i % 3 === 0)) });
    }
    if (!shells.length) return;
    sc.horizon = group; sc.shells = shells;
    sc.scene.add(group);
    liftHorizon();
    setFog(true);
    applyHorizonImagery();
  }

  function liftHorizon() {
    const g = tw.ground;
    if (!g || !sc.shells) return;
    const c = new THREE.Color(), exag = S().exag;
    let lo = g.min, hi = g.max;
    const heights = [];
    for (const sh of sc.shells) {
      const pos = sh.mesh.geometry.attributes.position;
      const H = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        const y = sh.isInner[i] ? yAt(x, z) : ringSurface(x, z);
        pos.setY(i, isFinite(y) ? y : 0);
        H[i] = (pos.getY(i) + earthDrop(Math.hypot(x, z), g.half)) / exag + g.h0;
        if (H[i] < lo) lo = H[i];
        if (H[i] > hi) hi = H[i];
      }
      const s = sh.seams;
      for (let j = 0; j < s.length; j += 3) pos.setY(s[j], (pos.getY(s[j + 1]) + pos.getY(s[j + 2])) / 2);
      pos.needsUpdate = true;
      sh.mesh.geometry.computeVertexNormals();
      sh.mesh.geometry.computeBoundingSphere();
      heights.push(H);
    }
    // One ramp over the patch and the far ground together.
    sc.shells.forEach((sh, k) => {
      const col = sh.mesh.geometry.attributes.color, H = heights[k];
      for (let i = 0; i < col.count; i++) { rampColour(c, H[i], lo, hi); col.setXYZ(i, c.r, c.g, c.b); }
      col.needsUpdate = true;
    });
    paintPatchRamp(lo, hi);
    requestFrame();
  }

  function applyHorizonImagery() {
    if (!sc.shells || !sc.renderer) return;
    const ims = tw.horizonImages || [];
    for (const sh of sc.shells) {
      const im = ims[sh.k];
      const want = !!S().imagery && !!im;
      if (want && !sh.tex) {
        const tex = new THREE.CanvasTexture(im.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, sc.renderer.capabilities.getMaxAnisotropy() || 1);
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        sh.tex = tex;
      }
      const mat = sh.mesh.material;
      mat.map = want ? sh.tex : null;
      mat.vertexColors = !want;
      mat.needsUpdate = true;
    }
    requestFrame();
  }

  // ── the sky ────────────────────────────────────────────────────────────────
  // A dome round the camera, shaded by the direction seen: the zenith colour
  // overhead, the horizon's at the horizon, the haze's below it (which is
  // what shows past the far ground's edge from a high camera). Its depth is
  // neither written nor tested, and it is drawn first, so everything else is
  // in front of it whatever the distance.
  const SKY_VERT = `varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const SKY_FRAG = `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 haze; varying vec3 vDir;
void main() {
  float h = normalize(vDir).y;
  vec3 c = h >= 0.0 ? mix(horizon, zenith, pow(h, 0.5)) : mix(horizon, haze, pow(-h, 0.35));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

  function skyTones() {
    const dark = typeof state !== 'undefined' && state.theme === 'dark';
    return {
      horizon: cssVar('--twin-sky',    dark ? '#3f5168' : '#cfe3f5'),
      zenith:  cssVar('--twin-zenith', dark ? '#0c1524' : '#5f9bd6'),
      haze:    cssVar('--twin-haze',   dark ? '#26303c' : '#b8c3cc'),
    };
  }

  function buildSky() {
    if (sc.sky || !sc.scene) return;
    const mat = new THREE.ShaderMaterial({
      uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, haze: { value: new THREE.Color() } },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 48, 24), mat);
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    mesh.name = 'sky';
    mesh.userData.export = false;
    sc.sky = mesh;
    sc.scene.add(mesh);
    skyKey = '';
    syncSky();
  }

  let skyKey = '';
  function syncSky() {
    if (!sc.sky) return;
    const t = skyTones(), key = t.horizon + t.zenith + t.haze;
    if (key !== skyKey) {
      skyKey = key;
      const u = sc.sky.material.uniforms;
      u.horizon.value.set(t.horizon); u.zenith.value.set(t.zenith); u.haze.value.set(t.haze);
    }
    if (sc.camera) sc.sky.position.copy(sc.camera.position);
  }

  // The far field, once the patch is standing: the sheets, the mesh, then the
  // imagery a shell at a time. Every await checks the build sequence, as
  // build() does, and the status line's last clause is the horizon's.
  function horizonWords(hz) {
    const srcs = hz.grids.filter(Boolean).map(g => g.source);
    const qld = srcs.includes('qld'), srtm = srcs.includes('srtm');
    return `horizon to ${HORIZON_M / 1000} km from ${qld && srtm ? 'the State\'s raster and the ~30 m tiles' : qld ? 'the State\'s raster' : 'the ~30 m tiles'}`;
  }

  function horizonNotes(notes) { return notes.filter(n => !/horizon/i.test(n)); }

  async function fetchHorizon(st, seq, notes) {
    tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false;
    if (!S().horizon || !sc.terrain) { setStatus(`${tw.statusBase}.`); return; }
    tw.horizonPending = true;
    setStatus(`${tw.statusBase}; fetching the horizon…`);
    const hz = await horizonFor(st);
    // Moved on, or switched off while it was coming: nothing to draw.
    if (seq !== tw.seq || !S().horizon) return;
    tw.horizon = hz;
    const have = hz.grids.filter(Boolean).length;
    if (!have) {
      tw.horizonPending = false;
      notes.push('The horizon could not be fetched — the terrain tiles did not answer — so the patch stands alone against the sky. Press Rebuild to try again.');
      setNotes(notes);
      setStatus(`${tw.statusBase}; no horizon.`);
      return;
    }
    buildHorizon();
    if (have < SHELL_HALF.length) {
      notes.push(`${SHELL_HALF.length - have} of the horizon's ${SHELL_HALF.length} sheets could not be fetched; the far ground is drawn where it was read.`);
    }
    const missing = hz.grids.reduce((s, g) => s + (g && g.missing ? g.missing : 0), 0);
    if (missing) {
      notes.push(`${missing} of the horizon's terrain tiles did not arrive; the ground under them is the next sheet out where there is one, and the station's own level where there is not.`);
    }
    setNotes(notes);
    refreshAttrib();
    syncCanvasName();
    if (S().imagery) await drapeHorizon(st, seq, notes);
    else { tw.horizonPending = false; setStatus(`${tw.statusBase}; ${horizonWords(hz)}.`); }
  }

  async function drapeHorizon(st, seq, notes) {
    if (!tw.horizon || !sc.shells) return;
    tw.horizonPending = true;
    const words = horizonWords(tw.horizon);
    setStatus(`${tw.statusBase}; ${words}, draping it…`);
    const ims = tw.horizonImages || (tw.horizonImages = []);
    for (let k = 0; k < SHELL_HALF.length; k++) {
      if (ims[k]) continue;
      const im = await imageryFor(shellBox(st.lat, st.lon, SHELL_HALF[k]), SHELL_PX).catch(() => null);
      if (seq !== tw.seq || !S().horizon || !sc.shells) return;
      ims[k] = im;
      applyHorizonImagery();
    }
    tw.horizonPending = false;
    const missing = ims.filter(im => !im).length;
    if (missing) {
      notes.push(missing === SHELL_HALF.length
        ? 'No imagery could be fetched for the horizon; it is coloured by height.'
        : `Imagery for ${missing} of the horizon's ${SHELL_HALF.length} sheets could not be fetched; those are coloured by height.`);
    }
    setNotes(notes);
    setStatus(`${tw.statusBase}; ${words}.`);
    refreshAttrib();
  }

  // ── the station as built ───────────────────────────────────────────────────
  // What stands at the origin is the station the network actually puts there,
  // in two shapes, chosen from the record:
  //
  //   * A **Type 3 rainfall station** — the Bureau's green pole with the
  //     tipping-bucket gauge and its ring on top, a small enclosure on the
  //     south face, a solar panel on a bracket to the north, a whip antenna
  //     up the east side, on a concrete pad — for a station that reports
  //     rainfall only, for a rain-and-repeater, and for any station the
  //     record does not say has a water-level sensor. Its pole is still
  //     2.000 m × Ø0.300 m: the brief's ruler, now with the right things on it.
  //   * A **river-gauge tower** — a 4 m galvanised mast on a flange, a 1.8 m
  //     grating platform with handrails, the cabinet on the platform, the
  //     gauge and the antenna mast with its solar panel, and a ladder up the
  //     south side — for a station the record says has a water-level sensor
  //     (a 'Water Level…' or 'Gas Pressure' sensor, a water_level ALERT
  //     address, or a Bureau listing typed Water Level). The foundation is
  //     below the ground and so not drawn.
  //
  // Inside each enclosure is the electronics the network fits, by telemetry:
  // an ELPRO ERRTS ERT-A2 radio for an ALERT station (a name ending AL or
  // ALERT, or ALERT addresses in the record), a Campbell Scientific CR300
  // logger and a Beam Iridium SBD modem for a TM station (a name ending TM,
  // or satcom on). A station the record cannot place is drawn as TM and the
  // notes say so. Every tower cabinet carries a Kisters HS40 compressor
  // bubbler in its upper compartment, and a Victron charge controller, the
  // telemetry, the terminals and the battery below. A plate inside names the
  // station and its number. The doors open on their own: a pole's when the
  // POV eye comes within DOOR_NEAR of it, the tower's when the visitor is up
  // on the platform — and close again when they leave.
  const TOWER_H   = 4.0;     // the mast, ground to the platform's underside
  const DECK_TOP  = 4.05;    // the grating's walking surface
  const DECK_HALF = 0.9;     // the platform is 1.8 m square
  const RAIL_H    = 1.1;     // handrail over the deck
  const LADDER_Z  = 0.98;    // the ladder's stiles, just south of the deck's edge
  const LADDER_HW = 0.2;     // half the ladder's width
  const CLIMB_MPS = 1.2;     // up the ladder (Shift doubles it)
  const DOOR_NEAR = 2.2;     // a pole enclosure opens when the eye is this close
  const DOOR_RATE = 2.6;     // radians per second

  // What the record says a station is: its structure and its telemetry.
  function stationKind(st) {
    const name = String((st && st.name) || '').trim();
    const m = /\s(AL|ALERT|TM)$/i.exec(name);
    const suffix = m ? m[1].toUpperCase() : null;
    const sensors = st && typeof stationSensors === 'function' ? stationSensors(st) : ((st && st.sensors) || []);
    const types = sensors.map(s => String((s && s.type) || ''));
    const aids = (st && st.alert_ids) || {};
    const water = types.some(t => /^Water Level|^Gas Pressure/i.test(t))
      || aids.water_level != null
      || (Array.isArray(st && st.location_types) && st.location_types.includes('Water Level'));
    const rain = types.some(t => /^Rainfall/i.test(t)) || aids.rainfall != null
      || (Array.isArray(st && st.location_types) && st.location_types.includes('Rain Gauge'));
    const alertEvidence = sensors.some(s => s && s.alert_id != null) || Object.keys(aids).length > 0;
    const satcom = !!(st && st.satcom && st.satcom.enabled);
    let telemetry = suffix === 'TM' ? 'tm' : suffix ? 'alert' : alertEvidence ? 'alert' : satcom ? 'tm' : null;
    const known = telemetry != null;
    if (!known) telemetry = 'tm';
    return { structure: water ? 'tower' : 'pole', telemetry, telemetryKnown: known, water, rain,
             repeater: Array.isArray(st && st.roles) && st.roles.includes('repeater'), suffix };
  }

  // The kit of parts: materials made once per build, and three shapes placed
  // by their centre — a box, a cylinder, and a bar from one point to another.
  function kitMaterials() {
    const M = (color, roughness, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    return {
      galv:     M(0x9aa4ae, 0.38, 0.65),
      steel:    M(0xc9ced3, 0.30, 0.80),
      green:    M(0x4a5d33, 0.70, 0.10),
      concrete: M(0x9c9b95, 0.95),
      cream:    M(0xd9d3b0, 0.60, 0.20),
      copper:   M(0x8a5a2b, 0.45, 0.60),
      black:    M(0x161819, 0.60),
      white:    M(0xe9ebe8, 0.55),
      light:    M(0xd6d9d6, 0.60),
      dark:     M(0x3a3f44, 0.60),
      blue:     M(0x1e6fd1, 0.50),
      stripe:   M(0x2f80d6, 0.50),
      orange:   M(0xff7a1a, 0.55),
      panel:    M(0x14213d, 0.25, 0.30),
      terminal: M(0x2fa84f, 0.60),
      led:      new THREE.MeshStandardMaterial({ color: 0x35d06a, emissive: 0x35d06a, emissiveIntensity: 0.8, roughness: 0.5 }),
      ledBlue:  new THREE.MeshStandardMaterial({ color: 0x4aa3ff, emissive: 0x4aa3ff, emissiveIntensity: 0.8, roughness: 0.5 }),
      tube:     M(0xf2f2f2, 0.40),
      tubeBlue: M(0x4aa3ff, 0.40),
    };
  }
  function box(parent, mat, w, h, d, x, y, z, name) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.name = name;
    parent.add(m);
    return m;
  }
  function cyl(parent, mat, rTop, rBot, h, x, y, z, name, seg = 24) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.name = name;
    parent.add(m);
    return m;
  }
  function bar(parent, mat, r, ax, ay, az, bx, by, bz, name) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    m.castShadow = true; m.name = name;
    parent.add(m);
    return m;
  }
  // A plate with words on it: the station's name and number inside the
  // enclosure, and the makers' names on the kit. Metres wide and high.
  function makePlate(title, sub, w, h, name = 'name plate') {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 192;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#e8e8e4'; cx.fillRect(0, 0, 512, 192);
    cx.strokeStyle = '#555'; cx.lineWidth = 8; cx.strokeRect(6, 6, 500, 180);
    cx.fillStyle = '#111'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.font = '700 60px system-ui, sans-serif';
    let t = String(title || '');
    while (t.length > 3 && cx.measureText(t).width > 470) t = t.slice(0, -2) + '…';
    cx.fillText(t, 256, sub ? 70 : 96);
    if (sub) { cx.font = '500 50px system-ui, sans-serif'; cx.fillText(String(sub), 256, 138); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    m.name = name;
    return m;
  }
  function plateAt(parent, title, sub, w, h, x, y, z, name) {
    const p = makePlate(title, sub, w, h, name);
    p.position.set(x, y, z);
    parent.add(p);
    return p;
  }
  // Steel grating: bars with dark gaps between, repeated over the deck.
  function gratingMaterial() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#2b2f33'; cx.fillRect(0, 0, 128, 128);
    cx.fillStyle = '#8b9399';
    for (let x = 0; x < 128; x += 8) cx.fillRect(x, 0, 3, 128);
    for (let y = 0; y < 128; y += 32) cx.fillRect(0, y, 128, 3);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(7, 7);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.6, metalness: 0.5 });
  }

  // A door: a panel on a pivot group at its hinge. `open` is the angle it
  // swings to; `when` says what opens it — 'near' the POV eye, or 'deck'.
  function addDoor(parent, mat, hx, hy, hz, w, h, d, sign, open, when, name) {
    const pivot = new THREE.Group();
    pivot.position.set(hx, hy, hz);
    pivot.name = `${name} hinge`;
    parent.add(pivot);
    // The panel hangs from the hinge to one side of it (sign: +1 east, −1 west).
    const panel = box(pivot, mat, w, h, d, sign * w / 2, 0, 0, name);
    const handle = box(pivot, kitMaterials().steel, 0.02, 0.06, 0.02, sign * (w - 0.05), 0, d / 2 + 0.01, `${name} handle`);
    handle.castShadow = false;
    const door = { pivot, panel, open, when, angle: 0, name };
    sc.doors.push(door);
    return door;
  }

  // The telemetry inside an enclosure, on a backplate whose centre is (x, y)
  // and whose face is at z (the kit sits proud of it). The same kit in a
  // pole's enclosure and in a tower's cabinet, at the same size.
  function addTelemetry(parent, k, kind, x, y, z) {
    if (kind.telemetry === 'alert') {
      const r = box(parent, k.light, 0.17, 0.22, 0.06, x, y, z + 0.03, 'ERT-A2');
      box(parent, k.stripe, 0.022, 0.20, 0.004, x + 0.04, y, z + 0.062, 'ERT-A2 stripe');
      for (let i = 0; i < 4; i++) {
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), k.led);
        led.position.set(x - 0.06, y + 0.07 - i * 0.02, z + 0.061);
        led.name = 'ERT-A2 LED';
        parent.add(led);
      }
      plateAt(parent, 'ELPRO ERRTS', 'ERT-A2', 0.07, 0.024, x - 0.03, y + 0.085, z + 0.061, 'label');
      // The coax up to the antenna, out of the top of the radio.
      cyl(parent, k.black, 0.004, 0.004, 0.10, x - 0.05, y + 0.16, z + 0.03, 'coax');
      return r;
    }
    const logger = box(parent, k.dark, 0.14, 0.09, 0.05, x, y + 0.06, z + 0.025, 'CR300');
    box(parent, k.terminal, 0.13, 0.014, 0.012, x, y + 0.02, z + 0.052, 'CR300 terminals');
    plateAt(parent, 'CAMPBELL SCIENTIFIC', 'CR300', 0.09, 0.028, x, y + 0.075, z + 0.051, 'label');
    const modem = box(parent, k.black, 0.10, 0.05, 0.03, x, y - 0.045, z + 0.015, 'Beam SBD modem');
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), k.ledBlue);
    led.position.set(x + 0.035, y - 0.03, z + 0.031);
    led.name = 'modem LED';
    parent.add(led);
    plateAt(parent, 'BEAM', 'IRIDIUM SBD', 0.06, 0.022, x - 0.01, y - 0.045, z + 0.031, 'label');
    cyl(parent, k.black, 0.004, 0.004, 0.08, x - 0.05, y + 0.14, z + 0.02, 'coax');
    return logger;
  }

  // A DIN rail with terminals and a coax connector, at (x, y) on a face at z.
  function addTerminals(parent, k, x, y, z, n = 8) {
    box(parent, k.galv, 0.05 + n * 0.014, 0.035, 0.008, x, y, z + 0.004, 'DIN rail');
    const tops = [k.black, k.orange, k.terminal, k.light, k.light, k.black, k.orange, k.light, k.light, k.black];
    for (let i = 0; i < n; i++) {
      const tx = x - (n - 1) * 0.007 + i * 0.014;
      box(parent, k.light, 0.012, 0.045, 0.03, tx, y, z + 0.02, 'terminal');
      box(parent, tops[i % tops.length], 0.012, 0.008, 0.03, tx, y + 0.026, z + 0.02, 'terminal tag');
    }
    cyl(parent, k.steel, 0.008, 0.008, 0.05, x - n * 0.007 - 0.035, y, z + 0.02, 'coax connector', 12);
  }
  function addGlands(parent, k, x, y, z, n = 3, vertical = false) {
    for (let i = 0; i < n; i++) {
      const g = cyl(parent, k.black, 0.012, 0.012, 0.024, vertical ? x + i * 0.05 : x, vertical ? y : y - i * 0.045, z, 'cable gland', 12);
      if (!vertical) g.rotation.x = Math.PI / 2;
      g.castShadow = false;
    }
  }

  // The Type 3 rainfall station.
  function buildPoleStation(st, kind, k) {
    const g = new THREE.Group();
    g.name = 'station';
    box(g, k.concrete, 1.2, 0.12, 1.2, 0, 0, 0, 'concrete pad');
    const shaft = cyl(g, k.green, POLE_R, POLE_R, POLE_H, 0, POLE_H / 2, 0, 'station pole', 40);
    sc.pole = shaft;
    // The tipping-bucket gauge on the pole's top, its funnel, and the ring on
    // three arms round it.
    cyl(g, k.steel, 0.10, 0.10, 0.32, 0, POLE_H + 0.16, 0, 'rain gauge', 32);
    cyl(g, k.copper, 0.095, 0.06, 0.03, 0, POLE_H + 0.335, 0, 'gauge funnel', 32);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.008, 8, 48), k.steel);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = POLE_H + 0.30;
    ring.name = 'gauge ring';
    ring.castShadow = true;
    g.add(ring);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      const arm = box(g, k.steel, 0.12, 0.008, 0.008, Math.cos(a) * 0.16, POLE_H + 0.30, Math.sin(a) * 0.16, 'ring arm');
      arm.rotation.y = -a;
      arm.castShadow = false;
    }
    // The role band, as before, below the enclosure's top.
    const role = typeof primaryRole === 'function' ? primaryRole(st) : 'field';
    const colour = (typeof ROLE_COLOR !== 'undefined' && ROLE_COLOR[role]) || '#107c10';
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(POLE_R + 0.008, POLE_R + 0.008, 0.12, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), metalness: 0.1, roughness: 0.6 }));
    band.position.y = POLE_H - 0.25;
    band.name = 'role band';
    sc.band = band;
    g.add(band);
    // The enclosure on the south face: five faces, the door the sixth.
    const encl = new THREE.Group();
    encl.name = 'enclosure';
    encl.position.set(0, 1.25, POLE_R + 0.09);
    g.add(encl);
    const W = 0.30, H = 0.40, D = 0.18, t = 0.01;
    box(encl, k.green, W, H, t, 0, 0, -D / 2 + t / 2, 'enclosure back');
    box(encl, k.green, W, t, D, 0, H / 2 - t / 2, 0, 'enclosure top');
    box(encl, k.green, W, t, D, 0, -H / 2 + t / 2, 0, 'enclosure bottom');
    box(encl, k.green, t, H, D, -W / 2 + t / 2, 0, 0, 'enclosure side');
    box(encl, k.green, t, H, D, W / 2 - t / 2, 0, 0, 'enclosure side');
    const face = -D / 2 + t + 0.004;
    box(encl, k.light, W - 0.02, H - 0.02, 0.004, 0, 0, face - 0.002, 'backplate');
    addTelemetry(encl, k, kind, -0.03, 0.06, face);
    plateAt(encl, st.name || st.id, st.station_number ? String(st.station_number) : '', 0.10, 0.036, 0.085, 0.10, face + 0.002, 'name plate');
    addTerminals(encl, k, 0.0, -0.06, face, 8);
    addGlands(encl, k, 0.105, -0.05, face + 0.012, 3, false);
    cyl(encl, k.light, 0.003, 0.003, 0.09, -0.05, -0.01, face + 0.03, 'wire', 6);
    cyl(encl, k.black, 0.003, 0.003, 0.09, -0.01, -0.01, face + 0.03, 'wire', 6);
    addDoor(encl, k.green, -W / 2, 0, D / 2 - t / 2, W, H, t, +1, -1.9, 'near', 'enclosure door');
    // The solar panel on a bracket to the north, tilted to face north and up.
    box(g, k.galv, 0.04, 0.50, 0.04, 0, 1.55, -POLE_R - 0.04, 'solar bracket');
    box(g, k.galv, 0.04, 0.04, 0.24, 0, 1.78, -POLE_R - 0.16, 'solar arm');
    const sp = new THREE.Group();
    sp.position.set(0, 1.78, -POLE_R - 0.30);
    sp.rotation.x = 0.52;
    g.add(sp);
    box(sp, k.galv, 0.38, 0.28, 0.02, 0, 0, 0, 'solar frame');
    box(sp, k.panel, 0.35, 0.25, 0.006, 0, 0, -0.012, 'solar panel');
    // The whip antenna up the east side, on two brackets.
    box(g, k.galv, 0.10, 0.03, 0.03, POLE_R + 0.03, 1.30, 0, 'antenna bracket');
    box(g, k.galv, 0.10, 0.03, 0.03, POLE_R + 0.03, 1.80, 0, 'antenna bracket');
    cyl(g, k.white, 0.006, 0.006, 3.0, POLE_R + 0.07, 1.6 + 1.5, 0, 'whip antenna', 8);
    return { group: g, top: POLE_H + 0.35, poleTop: POLE_H, ladder: null, deck: null };
  }

  // The river-gauge tower.
  function buildTower(st, kind, k) {
    const g = new THREE.Group();
    g.name = 'station';
    cyl(g, k.cream, 0.28, 0.28, 0.03, 0, 0.015, 0, 'base flange', 32);
    const mast = cyl(g, k.galv, POLE_R, POLE_R, TOWER_H, 0, TOWER_H / 2, 0, 'station pole', 40);
    sc.pole = mast;
    const role = typeof primaryRole === 'function' ? primaryRole(st) : 'field';
    const colour = (typeof ROLE_COLOR !== 'undefined' && ROLE_COLOR[role]) || '#107c10';
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(POLE_R + 0.008, POLE_R + 0.008, 0.12, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), metalness: 0.1, roughness: 0.6 }));
    band.position.y = 1.6;
    band.name = 'role band';
    sc.band = band;
    g.add(band);
    // The platform: struts from the mast, the grating, toe boards, handrails
    // with a gap at the south for the ladder.
    const H = DECK_HALF;
    for (const [x, z] of [[H - 0.05, 0], [-H + 0.05, 0], [0, H - 0.05], [0, -H + 0.05]]) {
      bar(g, k.galv, 0.025, 0, TOWER_H - 0.8, 0, x, TOWER_H - 0.03, z, 'strut');
    }
    box(g, k.galv, 2 * H, 0.06, 0.06, 0, TOWER_H - 0.03, 0, 'bearer');
    box(g, k.galv, 0.06, 0.06, 2 * H, 0, TOWER_H - 0.03, 0, 'bearer');
    box(g, gratingMaterial(), 2 * H, 0.05, 2 * H, 0, TOWER_H + 0.025, 0, 'platform grating');
    box(g, k.galv, 2 * H, 0.10, 0.02, 0, DECK_TOP + 0.05, -H + 0.01, 'toe board');
    box(g, k.galv, 0.02, 0.10, 2 * H, H - 0.01, DECK_TOP + 0.05, 0, 'toe board');
    box(g, k.galv, 0.02, 0.10, 2 * H, -H + 0.01, DECK_TOP + 0.05, 0, 'toe board');
    box(g, k.galv, H - LADDER_HW - 0.1, 0.10, 0.02, -(H + LADDER_HW + 0.1) / 2, DECK_TOP + 0.05, H - 0.01, 'toe board');
    box(g, k.galv, H - LADDER_HW - 0.1, 0.10, 0.02, (H + LADDER_HW + 0.1) / 2, DECK_TOP + 0.05, H - 0.01, 'toe board');
    const p = H - 0.02, top = DECK_TOP + RAIL_H, mid = DECK_TOP + RAIL_H / 2, hw = LADDER_HW + 0.1;
    for (const [x, z] of [[p, p], [-p, p], [p, -p], [-p, -p], [p, 0], [-p, 0], [0, -p], [hw, p], [-hw, p]]) {
      cyl(g, k.galv, 0.018, 0.018, RAIL_H, x, DECK_TOP + RAIL_H / 2, z, 'handrail post', 10);
    }
    for (const y of [top, mid]) {
      bar(g, k.galv, 0.016, -p, y, -p, p, y, -p, 'handrail');
      bar(g, k.galv, 0.016, p, y, -p, p, y, p, 'handrail');
      bar(g, k.galv, 0.016, -p, y, -p, -p, y, p, 'handrail');
      bar(g, k.galv, 0.016, -p, y, p, -hw, y, p, 'handrail');
      bar(g, k.galv, 0.016, hw, y, p, p, y, p, 'handrail');
    }
    // The ladder up the south side: stiles that run on past the deck as
    // handholds, rungs every 300 mm, two brackets back to the mast.
    for (const sx of [-LADDER_HW, LADDER_HW]) {
      cyl(g, k.galv, 0.016, 0.016, DECK_TOP + RAIL_H - 0.25, sx, (DECK_TOP + RAIL_H + 0.25) / 2, LADDER_Z, 'ladder stile', 10);
      for (const y of [1.5, 3.0]) bar(g, k.galv, 0.012, sx, y, LADDER_Z, sx * 0.6, y, POLE_R + 0.02, 'ladder bracket');
    }
    for (let y = 0.4; y <= TOWER_H + 0.01; y += 0.3) bar(g, k.galv, 0.013, -LADDER_HW, y, LADDER_Z, LADDER_HW, y, LADDER_Z, 'ladder rung');
    // The cabinet on the north of the platform, its door to the south, facing
    // whoever comes up the ladder. Two compartments: the bubbler above, the
    // power and the telemetry below.
    const cab = new THREE.Group();
    cab.name = 'cabinet';
    const CW = 0.60, CH = 1.20, CD = 0.45, t = 0.012;
    cab.position.set(0, DECK_TOP + CH / 2, -H + CD / 2 + 0.08);
    g.add(cab);
    box(cab, k.green, CW, CH, t, 0, 0, -CD / 2 + t / 2, 'cabinet back');
    box(cab, k.green, CW, t, CD, 0, CH / 2 - t / 2, 0, 'cabinet top');
    box(cab, k.green, CW, t, CD, 0, -CH / 2 + t / 2, 0, 'cabinet bottom');
    box(cab, k.green, t, CH, CD, -CW / 2 + t / 2, 0, 0, 'cabinet side');
    box(cab, k.green, t, CH, CD, CW / 2 - t / 2, 0, 0, 'cabinet side');
    box(cab, k.light, CW - 0.04, 0.02, CD - 0.06, 0, 0.02, 0, 'cabinet shelf');
    const face = -CD / 2 + t + 0.004;
    // Upper: the Kisters HS40 compressor bubbler — the panel, the desiccant
    // tube, the pressure gauge, the display, three valves, the compressor
    // control and the compressor, and the tubing between them.
    box(cab, k.white, 0.52, 0.52, 0.006, 0, 0.31, face, 'Kisters HS40 panel');
    plateAt(cab, 'KISTERS', 'HS40 COMPRESSOR BUBBLER', 0.13, 0.036, -0.16, 0.54, face + 0.004, 'label');
    cyl(cab, k.steel, 0.026, 0.026, 0.34, -0.20, 0.30, face + 0.03, 'HS40 desiccant tube', 20);
    const gauge = cyl(cab, k.black, 0.036, 0.036, 0.022, -0.09, 0.47, face + 0.012, 'HS40 pressure gauge', 24);
    gauge.rotation.x = Math.PI / 2;
    const gface = cyl(cab, k.white, 0.030, 0.030, 0.004, -0.09, 0.47, face + 0.025, 'gauge face', 24);
    gface.rotation.x = Math.PI / 2;
    box(cab, k.black, 0.13, 0.07, 0.03, 0.08, 0.47, face + 0.015, 'Kisters HS40 display');
    plateAt(cab, 'KISTERS', 'HS40', 0.07, 0.024, 0.08, 0.47, face + 0.031, 'label');
    for (const y of [0.38, 0.30, 0.22]) {
      const knob = cyl(cab, k.black, 0.022, 0.022, 0.03, -0.03, y, face + 0.016, 'HS40 valve', 16);
      knob.rotation.x = Math.PI / 2;
    }
    box(cab, k.black, 0.10, 0.09, 0.03, -0.17, 0.12, face + 0.015, 'HS40 compressor control');
    plateAt(cab, 'COMPRESSOR', 'CONTROL', 0.07, 0.024, -0.17, 0.13, face + 0.031, 'label');
    box(cab, k.galv, 0.16, 0.10, 0.10, 0.10, 0.12, face + 0.05, 'HS40 compressor');
    cyl(cab, k.tubeBlue, 0.004, 0.004, 0.26, -0.06, 0.30, face + 0.03, 'tubing', 6);
    bar(cab, k.tube, 0.004, -0.03, 0.40, face + 0.03, -0.09, 0.45, face + 0.03, 'tubing');
    bar(cab, k.tube, 0.004, -0.20, 0.47, face + 0.03, -0.12, 0.47, face + 0.03, 'tubing');
    bar(cab, k.tubeBlue, 0.004, -0.03, 0.20, face + 0.03, 0.06, 0.16, face + 0.03, 'tubing');
    // Lower: the backplate, the Victron charge controller, the telemetry,
    // the terminals, the battery.
    box(cab, k.light, 0.54, 0.54, 0.004, 0, -0.30, face - 0.002, 'backplate');
    box(cab, k.blue, 0.13, 0.19, 0.05, -0.17, -0.12, face + 0.025, 'Victron charge controller');
    plateAt(cab, 'VICTRON', 'ENERGY', 0.08, 0.026, -0.17, -0.07, face + 0.051, 'label');
    addTelemetry(cab, k, kind, 0.13, -0.13, face);
    addTerminals(cab, k, 0.02, -0.30, face, 10);
    plateAt(cab, st.name || st.id, st.station_number ? String(st.station_number) : '', 0.12, 0.042, 0.17, -0.30, face + 0.002, 'name plate');
    box(cab, k.black, 0.30, 0.19, 0.17, 0, -0.485, face + 0.085, 'battery');
    box(cab, k.blue, 0.28, 0.06, 0.004, 0, -0.47, face + 0.172, 'battery label');
    plateAt(cab, 'INVICTA', '', 0.09, 0.026, 0, -0.47, face + 0.175, 'label');
    addGlands(cab, k, -0.08, -CH / 2 + t + 0.012, 0.05, 3, true);
    addDoor(cab, k.green, CW / 2, 0, CD / 2 - t / 2, CW, CH, t, -1, 1.9, 'deck', 'cabinet door');
    // The gauge on the platform's west, and the antenna mast at the north-
    // east corner with its solar panel and the whip.
    cyl(g, k.galv, 0.025, 0.025, 0.55, -0.62, DECK_TOP + 0.275, 0.25, 'gauge post', 12);
    cyl(g, k.steel, 0.10, 0.10, 0.30, -0.62, DECK_TOP + 0.70, 0.25, 'rain gauge', 32);
    cyl(g, k.orange, 0.10, 0.07, 0.04, -0.62, DECK_TOP + 0.87, 0.25, 'gauge funnel', 32);
    cyl(g, k.galv, 0.025, 0.025, 3.5, 0.75, DECK_TOP + 1.75, -0.75, 'antenna mast', 12);
    cyl(g, k.white, 0.006, 0.006, 3.0, 0.75, DECK_TOP + 3.5 + 1.5, -0.75, 'whip antenna', 8);
    const sp = new THREE.Group();
    sp.position.set(0.75, DECK_TOP + 1.7, -0.75 - 0.05);
    sp.rotation.x = 0.52;
    g.add(sp);
    box(sp, k.galv, 0.58, 0.43, 0.02, 0, 0, 0, 'solar frame');
    box(sp, k.panel, 0.55, 0.40, 0.006, 0, 0, -0.012, 'solar panel');
    return { group: g, top: DECK_TOP + RAIL_H, poleTop: TOWER_H,
             ladder: { x: 0, z: LADDER_Z, stand: LADDER_Z + 0.22, halfW: LADDER_HW },
             deck: { top: DECK_TOP, half: DECK_HALF, front: -H + CD + 0.12 } };
  }

  // The station at the origin: which of the two, built, and remembered.
  function buildStation(st) {
    const kind = stationKind(st);
    const k = kitMaterials();
    sc.doors = [];
    const built = kind.structure === 'tower' ? buildTower(st, kind, k) : buildPoleStation(st, kind, k);
    built.group.position.y = 0;
    sc.station = built.group;
    sc.scene.add(built.group);
    tw.model = { ...kind, top: built.top, poleTop: built.poleTop, ladder: built.ladder, deck: built.deck,
                 plate: { name: st.name || st.id, number: st.station_number ? String(st.station_number) : '' } };
  }

  // The ladder's foot, and its height, live: the ground under it moves with
  // the exaggeration, the deck does not.
  function ladderFootY() {
    const m = tw.model;
    return m && m.ladder ? yAt(m.ladder.x, m.ladder.stand) : 0;
  }
  function ladderHeight() {
    const m = tw.model;
    return m && m.ladder ? m.deck.top - ladderFootY() : 0;
  }

  // The doors: a frame at a time toward open or closed, as the visitor comes
  // and goes. Returns whether any moved.
  const _doorPos = () => new THREE.Vector3();
  function doorWanted(d) {
    if (rig.mode !== 'walk' || !sc.camera) return false;
    if (d.when === 'deck') return rig.level === 'deck';
    return d.pivot.getWorldPosition(_doorPos()).distanceTo(sc.camera.position) < DOOR_NEAR;
  }
  function animateDoors(dt) {
    if (!sc.doors || !sc.doors.length) return false;
    let moving = false;
    for (const d of sc.doors) {
      const want = doorWanted(d) ? d.open : 0;
      const step = DOOR_RATE * dt;
      const next = Math.abs(want - d.angle) <= step ? want : d.angle + Math.sign(want - d.angle) * step;
      if (next !== d.angle) { d.angle = next; d.pivot.rotation.y = next; moving = true; }
    }
    return moving;
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
    sp.position.set(0, (tw.model ? tw.model.top : POLE_H) + 0.75, 0);
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
    const poleTop = tw.model ? tw.model.poleTop : POLE_H;
    if (agl0 > poleTop + 0.05) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, agl0 - poleTop, 12),
                                  new THREE.MeshStandardMaterial({ color: 0x8d97a1, metalness: 0.6, roughness: 0.4 }));
      mast.position.y = poleTop + (agl0 - poleTop) / 2;
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
    rig.level = 'ground'; rig.climb = 0;
    rig.mode = 'walk';
    syncModeUi();
    if (sc.canvas) sc.canvas.focus({ preventScroll: true });
  }

  function leaveWalk() {
    if (rig.mode !== 'walk') return;
    // Orbit again, from about where the visitor stood, looking at the station.
    // Off the ladder or the deck, back on the ground.
    if (rig.level !== 'ground') { rig.level = 'ground'; rig.climb = 0; rig.pz = Math.max(rig.pz, LADDER_Z + 1.2); }
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
      // Feet on the ground, or on a rung, or on the grating.
      const m = tw.model;
      let feet = yAt(rig.px, rig.pz);
      if (m && m.deck && rig.level === 'deck') feet = m.deck.top;
      else if (m && m.ladder && rig.level === 'ladder') feet = ladderFootY() + rig.climb;
      const y = feet + EYE_H;
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
      // Past the patch's edge that hill is the horizon's.
      y = Math.max(y, surfaceY(x, z) + 0.9);
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
      // The map's overlay button is an icon, a word that hides on a phone,
      // and a name for a reader; the tab's is plain text.
      const label = btn.querySelector('.map-twin-label'), sr = btn.querySelector('.sr-only');
      if (label) {
        label.textContent = rig.mode === 'walk' ? ' Leave POV' : ' POV';
        if (sr) sr.textContent = rig.mode === 'walk' ? 'Leave the point of view' : 'Point of view';
      } else {
        btn.textContent = rig.mode === 'walk' ? '👁 Leave POV' : '👁 POV';
      }
    }
    const hud = document.getElementById('twin-hud');
    if (hud) hud.textContent = rig.mode === 'walk'
      ? `POV at eye height: W A S D or the arrow keys move, drag to look, Shift to hurry, Esc to leave.${tw.model && tw.model.ladder ? ' Walk into the ladder to climb it.' : ''}`
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
        case 'f': case 'p': enterWalk(); break;
        default: return;
      }
      e.preventDefault();
      requestFrame();
    });
    on(cv, 'keyup', e => { rig.keys.delete(keyName(e.key)); if (!rig.keys.has('w') && !rig.keys.has('ArrowUp')) rig.climbLatch = false; });
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

  // One step of walking: `f` metres forward, `r` metres right. On the ground
  // it is the patch that holds the visitor in; on the deck, the toe boards
  // and the cabinet. Walking into the foot of the ladder, facing it, is how
  // the ladder is taken; walking out through the hatch on the deck, facing
  // it, is how it is taken down. Forward is (sin yaw, −cos yaw): yaw 0 is
  // north, which is the way the ladder faces.
  function walkStep(f, r) {
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    const nx = rig.px + f * sy + r * cy, nz = rig.pz - f * cy + r * sy;
    const m = tw.model;
    if (m && m.deck && rig.level === 'deck') {
      if (rig.climbLatch && f > 0) return;   // just arrived: W has to be pressed again
      const lim = m.deck.half - 0.14;
      if (nz > lim && Math.abs(nx) < m.ladder.halfW && f > 0 && cy < -0.5) {
        rig.level = 'ladder'; rig.climb = ladderHeight();
        rig.px = m.ladder.x; rig.pz = m.ladder.stand; rig.pitch = -0.35;
        // W is still held from the walk out: it must not put the visitor
        // straight back on the deck. Released and pressed again, it does.
        rig.climbLatch = true;
        return;
      }
      rig.px = Math.max(-lim, Math.min(lim, nx));
      rig.pz = Math.max(m.deck.front, Math.min(lim, nz));
      return;
    }
    const oz = rig.pz;
    rig.px = nx; rig.pz = nz;
    const lim = (tw.ground ? tw.ground.half : 100) - 1;
    rig.px = Math.max(-lim, Math.min(lim, rig.px));
    rig.pz = Math.max(-lim, Math.min(lim, rig.pz));
    if (m && m.ladder && rig.level === 'ground' && f > 0 && cy > 0.5) {
      // The foot of the ladder is a gate 0.9 m south of the rungs: a step
      // that lands inside it, or one long enough to cross it, takes hold.
      const L = m.ladder, gate = L.z + 0.9;
      const inLine = Math.abs(rig.px - L.x) < L.halfW + 0.15;
      if (inLine && rig.pz < gate && (rig.pz > L.z || oz >= gate)) {
        rig.level = 'ladder'; rig.climb = 0;
        rig.px = L.x; rig.pz = L.stand; rig.yaw = 0; rig.pitch = 0.35;
      }
    }
  }

  // A step up or down the ladder; at the top the deck, at the bottom the ground.
  function climbStep(dy) {
    const m = tw.model;
    if (!m || !m.ladder) { rig.level = 'ground'; rig.climb = 0; return; }
    rig.climb += dy;
    const h = ladderHeight();
    if (rig.climb >= h) {
      if (rig.climbLatch) { rig.climb = h; return; }
      // On the grating at the hatch, facing the cabinet — which is 1.2 m
      // tall and a metre off, so the eye is tilted down into it — and held
      // there until W is pressed afresh, so the climb does not run on into
      // the cabinet.
      rig.level = 'deck'; rig.climb = 0; rig.climbLatch = true;
      rig.px = 0; rig.pz = m.deck.half - 0.3; rig.yaw = 0; rig.pitch = -0.55;
    } else if (rig.climb <= 0) {
      rig.level = 'ground'; rig.climb = 0;
      rig.pz = m.ladder.z + 0.6; rig.pitch = -0.06;
    }
  }

  // Held keys, applied per frame: a brisk walk, a run with Shift, a climb on
  // the ladder. The step is the wall time since the last frame, capped so a
  // tab that was asleep does not lurch — but capped high, because a phone
  // that draws this scene at four frames a second still has to walk at
  // 3.2 m/s and not at a fifth of it.
  const WALK_MPS = 3.2, HURRY_MPS = 9.0;
  const MAX_DT = 0.5;
  let lastTick = 0;
  function frameDt(now) { return Math.min(MAX_DT, (now - lastTick) / 1000 || 0.016); }
  function walkKeys(now) {
    if (rig.mode !== 'walk' || !rig.keys.size) return false;
    const dt = frameDt(now);
    const hurry = rig.keys.has('Shift');
    const speed = (hurry ? HURRY_MPS : WALK_MPS) * dt;
    let f = 0, r = 0;
    if (rig.keys.has('w') || rig.keys.has('ArrowUp'))    f += 1;
    if (rig.keys.has('s') || rig.keys.has('ArrowDown'))  f -= 1;
    if (rig.keys.has('d') || rig.keys.has('ArrowRight')) r += 1;
    if (rig.keys.has('a') || rig.keys.has('ArrowLeft'))  r -= 1;
    if (rig.keys.has('q')) rig.yaw -= 1.4 * dt;
    if (rig.keys.has('e')) rig.yaw += 1.4 * dt;
    if (f <= 0) rig.climbLatch = false;
    if (rig.level === 'ladder') { if (f) climbStep(f * CLIMB_MPS * (hurry ? 2 : 1) * dt); }
    else if (f || r) walkStep(f * speed, r * speed);
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
    if (animateDoors(frameDt(now))) sc.dirty = true;
    lastTick = now;
    if (!sc.dirty) return;
    sc.dirty = false;
    if (!sc.renderer || !sc.scene) return;
    placeCamera();
    sc.scene.background = skyColour();
    if (sc.scene.fog) sc.scene.fog.color.copy(sc.scene.background);
    syncSky();
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
      tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false; tw.statusBase = ''; tw.model = null;
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
    tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false; tw.statusBase = ''; tw.model = null;

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
      buildSky();
      buildTerrain();
      buildStation(st);
      if (tw.model && !tw.model.telemetryKnown) {
        notes.push('This station\'s telemetry is not in its record — no AL or TM in the name, no ALERT addresses, no satcom — so its enclosure is drawn as a TM station\'s: a CR300 logger and a Beam SBD modem.');
      }
      buildFigure();
      buildLabel(st);
      buildPaths(st);
      setFog(false);
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
    tw.statusBase = `${groundLine}, ${image ? (image.source === 'qld' ? 'Queensland aerial imagery' : 'Esri imagery') + ` at ${image.mpp.toFixed(2)} m/px` : 'no imagery'}`;
    setStatus(`${tw.statusBase}.`);
    setNotes(notes);
    refreshTruth();
    refreshAttrib();
    syncCanvasName();

    // The horizon last, and only round a patch that is drawn: it is scenery,
    // and the numbers above never wait on it — nor does the patch fall with it.
    try {
      await fetchHorizon(st, seq, notes);
    } catch (err) {
      if (seq !== tw.seq) return;
      notes.push(`The horizon could not be drawn: ${(err && err.message) || err}. The patch stands alone against the sky.`);
      setNotes(notes);
      setStatus(`${tw.statusBase}; no horizon.`);
    }
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
           + `${(g.max - g.min).toFixed(1)} m of relief, ${tw.model && tw.model.structure === 'tower' ? 'a river-gauge tower with its platform 4 m up' : 'a Type 3 rainfall pole 2 m tall'} at the station and a 1.75 m figure beside it`
           + (sc.horizon ? `, the country round it to ${HORIZON_M / 1000} km under a sky. ` : '. ')
           + (rig.mode === 'walk' ? 'POV: W A S D move, drag looks, Escape leaves.'
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
        <label class="check-label"><input type="checkbox" ${s.horizon ? 'checked' : ''} onchange="DigitalTwin.setHorizon(this.checked)"><span>The horizon: far ground to ${HORIZON_M / 1000} km, a sky and haze (a few more requests)</span></label>
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
            <button type="button" id="twin-walk" aria-pressed="false" onclick="DigitalTwin.toggleWalk()" title="Point of view: stand on the ground at eye height, walk with the keys, climb the ladder">👁 POV</button>
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
    // The horizon's sources, where they are not the patch's already.
    if (tw.horizon) for (const g of tw.horizon.grids) if (g) parts.push(g.attribution);
    if (tw.horizonImages) for (const im of tw.horizonImages) if (im) parts.push(im.attribution);
    if (typeof Elvis !== 'undefined') parts.push(Elvis.attribution);
    return [...new Set(parts.filter(Boolean))].map(esc).join(' · ');
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
    tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false;
    tw.model = null;
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
          pole: { height_m: tw.model ? tw.model.poleTop : POLE_H, diameter_m: POLE_R * 2 },
          station: tw.model ? { structure: tw.model.structure, telemetry: tw.model.telemetry, telemetry_known: tw.model.telemetryKnown } : null,
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
        liftHorizon();
        requestFrame();
      }
    },
    setImagery(on) {
      S().imagery = !!on; saveSettings();
      applyImagery();
      applyHorizonImagery();
      // Switched on with the horizon standing bare: its sheets are fetched now.
      const st = currentStation();
      if (on && sc.shells && st && located(st) && !(tw.horizonImages && tw.horizonImages.every(Boolean))) {
        drapeHorizon(st, tw.seq, horizonNotes(tw.notes)).catch(() => {});
      }
    },
    setHorizon(on) {
      S().horizon = !!on; saveSettings();
      const st = currentStation();
      if (!on) {
        // A fetch in flight sees the setting when it lands and stands down.
        removeHorizon();
        tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false;
        setNotes(horizonNotes(tw.notes));
        if (tw.statusBase) setStatus(`${tw.statusBase}.`);
        refreshAttrib(); syncCanvasName(); requestFrame();
        return;
      }
      if (st && located(st) && sc.terrain && !sc.shells) {
        fetchHorizon(st, tw.seq, horizonNotes(tw.notes)).catch(() => {});
      }
    },
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
        const key = boxKey(patchBox(st.lat, st.lon, S().size));
        groundCache.delete(key); imageCache.delete(key);
        horizonCache.delete(horizonKey(st));
        for (const h of SHELL_HALF) imageCache.delete(boxKey(shellBox(st.lat, st.lon, h)));
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
        pole: sc.pole ? { h: tw.model ? tw.model.poleTop : POLE_H, r: POLE_R, baseY: sc.pole.position.y - (tw.model ? tw.model.poleTop : POLE_H) / 2, x: sc.pole.position.x, z: sc.pole.position.z } : null,
        model: tw.model ? {
          structure: tw.model.structure, telemetry: tw.model.telemetry, telemetryKnown: tw.model.telemetryKnown,
          water: tw.model.water, rain: tw.model.rain, repeater: tw.model.repeater, top: tw.model.top, poleTop: tw.model.poleTop,
          plate: tw.model.plate, ladder: tw.model.ladder ? { ...tw.model.ladder, footY: ladderFootY(), height: ladderHeight() } : null,
          deck: tw.model.deck, level: rig.level, climb: rig.climb, walker: { x: rig.px, z: rig.pz, yaw: rig.yaw },
          doors: sc.doors.map(d => ({ name: d.name, angle: d.angle, open: d.open, when: d.when, wanted: doorWanted(d) })),
          parts: (() => { const n = []; if (sc.station) sc.station.traverse(o => { if (o.isMesh) n.push(o.name); }); return n; })(),
        } : null,
        figure: sc.figure ? { h: FIGURE_H, x: sc.figure.position.x, z: sc.figure.position.z, baseY: sc.figure.position.y, visible: sc.figure.visible } : null,
        vertices: sc.terrain ? sc.terrain.geometry.attributes.position.count : 0,
        textured: !!(sc.terrain && sc.terrain.material.map),
        contextLost: sc.renderer ? sc.renderer.getContext().isContextLost() : null,
        camera: sc.camera ? { x: sc.camera.position.x, y: sc.camera.position.y, z: sc.camera.position.z } : null,
        paths: tw.paths ? { count: tw.paths.count, source: tw.paths.source, pending: tw.paths.pending, list: tw.paths.list.slice() } : null,
        embedded: !!tw.hooks,
        horizon: {
          on: !!S().horizon, up: !!sc.horizon, pending: tw.horizonPending, km: HORIZON_M / 1000,
          earthR: EARTH_R_EYE, blendOut: BLEND_OUT, skyR: SKY_R, far: sc.camera ? sc.camera.far : null, sky: !!sc.sky,
          fog: sc.scene && sc.scene.fog
            ? { exp2: !!sc.scene.fog.isFogExp2, density: sc.scene.fog.density, near: sc.scene.fog.near, far: sc.scene.fog.far }
            : null,
          shells: tw.horizon
            ? tw.horizon.grids.map((g, k) => (g ? { half: SHELL_HALF[k], source: g.source, zoom: g.zoom, rows: g.rows, n: g.n,
                                                    missing: g.missing, resolution_m: g.resolution_m,
                                                    box: { west: g.box.west, east: g.box.east, south: g.box.south, north: g.box.north } }
                                                : null))
            : null,
          images: tw.horizonImages ? tw.horizonImages.map(im => (im ? im.source : null)) : null,
          meshes: sc.shells
            ? sc.shells.map(sh => ({ name: sh.mesh.name, half: sh.half, vertices: sh.mesh.geometry.attributes.position.count,
                                     triangles: sh.mesh.geometry.index.count / 3, textured: !!sh.mesh.material.map,
                                     renderOrder: sh.mesh.renderOrder, squares: sh.squares.length,
                                     innerHalf: sh.squares[0].h, outerHalf: sh.squares[sh.squares.length - 1].h }))
            : [],
          unfilled: tw.horizonUnfilled,
          ringHeight, ringSurface, perimeterT,
          // A shell's vertex: where it is, which square and which vertex of it, whether it is on the patch's edge or a seam.
          vertex: (k, i) => {
            const sh = sc.shells && sc.shells[k];
            if (!sh) return null;
            const p = sh.mesh.geometry.attributes.position, q = sh.meta[i * 2];
            return { x: p.getX(i), y: p.getY(i), z: p.getZ(i), inner: !!sh.isInner[i], square: q, t: sh.meta[i * 2 + 1],
                     h: sh.squares[q].h, M: sh.squares[q].M, seam: sh.seamSet.has(i) };
          },
          // The index of a shell's vertex nearest a point.
          nearest: (k, x, z) => {
            const sh = sc.shells && sc.shells[k];
            if (!sh) return -1;
            const p = sh.mesh.geometry.attributes.position;
            let best = -1, bd = Infinity;
            for (let i = 0; i < p.count; i++) {
              const d = (p.getX(i) - x) ** 2 + (p.getZ(i) - z) ** 2;
              if (d < bd) { bd = d; best = i; }
            }
            return best;
          },
          // How far out the first triangle reaches and how far in the last one
          // does, the smallest square any vertex stands on, the mean normal's lift.
          order: k => {
            const sh = sc.shells && sc.shells[k];
            if (!sh) return null;
            const idx = sh.mesh.geometry.index, p = sh.mesh.geometry.attributes.position, nrm = sh.mesh.geometry.attributes.normal;
            const hq = i => Math.max(Math.abs(p.getX(i)), Math.abs(p.getZ(i)));
            let minHq = Infinity, ny = 0;
            for (let i = 0; i < p.count; i++) { minHq = Math.min(minHq, hq(i)); ny += nrm.getY(i); }
            const tri = j => [idx.getX(j), idx.getX(j + 1), idx.getX(j + 2)].map(hq);
            return { first: Math.max(...tri(0)), last: Math.min(...tri(idx.count - 3)), minHq, meanNormalY: ny / p.count };
          },
        },
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
    // What the record says a station is — the check's way of choosing one.
    _kind: stationKind,
    // Put the POV visitor somewhere on the ground, facing a way.
    _pov({ px, pz, yaw, pitch }) {
      if (rig.mode !== 'walk') enterWalk();
      rig.level = 'ground'; rig.climb = 0;
      if (isFinite(px)) rig.px = px;
      if (isFinite(pz)) rig.pz = pz;
      if (isFinite(yaw)) rig.yaw = yaw;
      if (isFinite(pitch)) rig.pitch = pitch;
      placeCamera();
      requestFrame();
      return sc.camera ? { x: sc.camera.position.x, y: sc.camera.position.y, z: sc.camera.position.z } : null;
    },
    // Turn the POV visitor where they stand.
    _turn({ yaw, pitch }) {
      if (isFinite(yaw)) rig.yaw = yaw;
      if (isFinite(pitch)) rig.pitch = pitch;
      placeCamera();
      requestFrame();
    },
    // Put the orbit camera somewhere and say where it ended up — the check's
    // way of standing it over the far ground.
    _orbit({ radius, theta, phi }) {
      rig.mode = 'orbit';
      if (rig.target) rig.target.set(0, 1, 0);
      if (isFinite(radius)) rig.radius = radius;
      if (isFinite(theta)) rig.theta = theta;
      if (isFinite(phi)) rig.phi = phi;
      placeCamera();
      requestFrame();
      return sc.camera ? { x: sc.camera.position.x, y: sc.camera.position.y, z: sc.camera.position.z } : null;
    },
    // Forget the station, so a check can measure the tab with nothing chosen.
    _clear() {
      tw.stationId = null; tw.ground = null; tw.image = null; tw.elvis = null;
      tw.status = ''; tw.notes = []; tw.picked = null; tw.paths = null;
    },
  };
})();
if (typeof window !== 'undefined') window.DigitalTwin = DigitalTwin;
