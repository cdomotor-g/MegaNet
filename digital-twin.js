// MegaNet — digital-twin.js
//
//   DigitalTwin   the digital twin: one station's patch of ground in three
//                 dimensions — the real relief under it, the aerial imagery
//                 draped over it, a 2 m × 300 mm pole where the station stands
//                 and a 1.75 m figure beside it for scale — to orbit, and to
//                 walk about in at eye height. Exports the scene as a .glb for
//                 Blender. It is drawn inside the Stations map (map-twin.js
//                 hosts it), and its settings are the 🧊 pane of that tab's
//                 side panel (paneHtml, which app.js puts in the dock).
//
// After core.js and terrain.js, before init.js — index.html holds the order and
// the reasons. Reaches back to core.js for state, esc, escAttr, announce,
// cssVar, registerTabTeardown, KM_PER_DEG_LAT and kmPerDegLon; across to
// terrain.js for the ~30 m fallback ground, to elvis.js for the AHD height at
// the pin, to field-photos.js for the field photos taken in the patch (and the
// viewer they open in), to twin-cadastre.js for the property boundaries, lot
// numbers and road reserve drawn on the ground, to map-twin.js for the map it
// is drawn in, and to app.js for switchTab and primaryRole (from inline
// handlers). Every one of those is a runtime call from inside this file's own
// functions, so its position among the modules is free. Nothing executes at
// load (`npm run toplevel`).
//
// ── One twin, in the map ─────────────────────────────────────────────────────
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
// It had a tab of its own as well, once — the same scene in a second host,
// with the settings down its left. Two ways to the one thing, each with half
// the tools, is one too many: the tab's column is the 🧊 pane in the Stations
// side panel now, beside the map the twin opens in, and every "open the twin"
// (the station card, the finder, a field photo) opens it there.
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
// centimetres. Heights are AHD: Queensland's service is, and the tiles'
// EGM96 is put into AHD through geoid.js — AHD = EGM96 − 2.07 m to
// + 0.64 m over the stations (groundFor says why); the panel says by how
// much here. The far sheets of the horizon are left as they come.
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
    orient: null,          // the Orientation tool, open: { id, deg, saving, msg } — see "the way the station faces"
    photos: null,          // the field photos in the patch: { status, spots: [{ x, z, ids, rows, heading, fov, pitch }], count, error }
    photoNear: -1,         // the spot the POV visitor is standing at, or −1
    focusPhotoId: null,    // a photo to stand the camera behind once the markers are up (the viewer's "In the twin")
    flood: null,           // the flood water: { lad, start, top, seed, fill, level, band, … } — see buildFlood
    infoOpen: true,        // the lines over the stage: open, or folded under the bar
    infoPinned: false,     // the operator pressed the fold: it stays as they left it
    infoFor: null,         // the station the fold was last opened for — a new one opens it again
    infoTimer: 0,          // the fold's own clock
    hudTimer: 0,           // a phone's: when the hint goes back to its "?" (see "a phone's stage, kept clear")
    scaleTimer: 0,         // a phone's: when the scale's names stand down
    origin: null,          // { lat, lon } the patch is centred on — the station where it was when built
    neighbours: null,      // the other stations in the patch: { list: [{ id, name, x, z, d, structure, … }], more }
    bridges: null,         // the bridges in the patch: { status, source, list, crossing, failed }
    bridgesFound: null,    // what the sources said, kept to rebuild the decks at another exaggeration
    tier: null,            // the State's finest imagery over the station (imageryAt), or null
  };

  // Ground under a far station that has no recorded height, read off the
  // tiles once and kept for the session — a path's far end is the same place
  // every time it is drawn.
  const farHeightCache = new Map();

  // The live scene — everything the teardown has to dispose of.
  const sc = {
    renderer: null, scene: null, camera: null, canvas: null, stage: null,
    terrain: null, wire: null, pole: null, band: null, figure: null, label: null, paths: null,
    towerStaff: null, towerMarks: null,   // the tower's staff face, and its flood-level bands and call-outs
    station: null, doors: [],   // the station as built, and its doors
    avatars: null, laser: null, dot: null,   // the other visitors, and the visitor's own pointer
    sun: null, hemi: null, texture: null, raf: 0, ro: null, dirty: false,
    horizon: null, shells: null, sky: null,   // the far field's group, its shells' bookkeeping, the dome
    photos: null,     // the field photo markers
    movepin: null,    // the pin being moved (map-move-pin.js): { group, post, head, hit, ring, ghost, leader }
    neighbours: null, // the other stations in the patch, built
    bridges: null,    // the bridges' decks
    sharp: null,      // the sharp drape round the station or the pin: { mesh, x, z, mpp }
    flood: null,      // the flood water and its staff: { water, staff, tex, data, mat, palette }
    off: [],          // listener removers
  };

  // The camera rig: orbit about a target, or walk on the ground.
  const rig = {
    mode: 'orbit',
    target: null, radius: 26, theta: 0.65, phi: 1.05,   // orbit: spherical about target
    px: 3, pz: 6, yaw: -0.45, pitch: -0.08,             // POV: feet position and look
    level: 'ground', climb: 0, climbLatch: false,       // POV: on the ground, on the ladder (climb metres up it), or on the deck
    pointing: false, pointLatch: false,                 // POV: Space held, or the Point button latched
    pinDrag: null,                                      // the pointer holding the pin being moved, or null
    keys: new Set(),
    pointers: new Map(),
    pinch: null,
  };

  const groundCache = new Map();   // `${lat},${lon}|${size}` → tw.ground
  const imageCache  = new Map();   // the same key → tw.image

  // ── settings ───────────────────────────────────────────────────────────────

  // `floodAnim` null is "as the browser prefers": animated, unless it asks for
  // reduced motion. `floodHold` is where still water stands — a level's key,
  // or a fraction of the way from 0 m to the top.
  const DEFAULTS = { size: 400, exag: 1, imagery: true, figure: true, label: true, wire: false, horizon: true,
                     flood: true, floodAnim: null, floodHold: null, fitBridges: true };

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('mn-twin') || '{}') || {}; } catch (_) { s = {}; }
    const out = { ...DEFAULTS };
    if (SIZES.includes(Number(s.size))) out.size = Number(s.size);
    const ex = Number(s.exag);
    if (isFinite(ex) && ex >= 1 && ex <= 3) out.exag = ex;
    for (const k of ['imagery', 'figure', 'label', 'wire', 'horizon', 'flood', 'fitBridges']) if (typeof s[k] === 'boolean') out[k] = s[k];
    if (typeof s.floodAnim === 'boolean') out.floodAnim = s.floodAnim;
    if ((typeof s.floodHold === 'number' && s.floodHold >= 0 && s.floodHold <= 1) || (typeof s.floodHold === 'string' && s.floodHold)) out.floodHold = s.floodHold;
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

  // A number that is there: `isFinite(null)` is true, and a station, or a
  // photo's heading, that is null is not known — never at 0°, 0° or facing north.
  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
  function located(s) { return !!s && known(s.lat) && known(s.lon); }

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
  //
  // Always in AHD where it can be. The State's DTM is; the tiles are heights
  // above the EGM96 geoid, and over the stations AHD = EGM96 − 2.07 m to
  // + 0.64 m (geoid.js), so a tile height — the whole ground, or the State's
  // holes filled — is put into AHD by AHD less EGM96 at the patch's centre,
  // constant to a centimetre or two across a patch. Every level this ground
  // is measured against (a gauge zero, a flood, a deck, a surveyed height) is
  // AHD. Where that number cannot be had the tiles stay in EGM96, the ground
  // says so (`datum`), the flood water refuses to stand AHD levels on it, and
  // it is not cached, so the next build asks again.
  function groundFor(box) {
    const key = `${box.south.toFixed(6)},${box.west.toFixed(6)}|${box.size}`;
    if (groundCache.has(key)) return Promise.resolve(groundCache.get(key));
    return qldGround(box).then(q => {
      if (q.kind === 'ok' && q.holes === 0) return finishGround(box, q.elev, 'qld', 0, 0, null, q, null);
      // Holes, or nothing: the tiles fill what the State does not hold.
      return Promise.all([tileGround(box), geoidAt(box)]).then(([t, sep]) => {
        if (t && sep.ok) for (let i = 0; i < t.elev.length; i++) t.elev[i] += sep.m;
        if (q.kind === 'ok') {
          let filled = 0;
          if (t) {
            for (let i = 0; i < q.elev.length; i++) {
              if (!isFinite(q.elev[i]) && isFinite(t.elev[i])) { q.elev[i] = t.elev[i]; filled++; }
            }
          }
          return finishGround(box, q.elev, 'qld', q.holes, filled, t, q, filled ? sep : null);
        }
        if (!t) return null;
        return finishGround(box, t.elev, 'srtm', 0, 0, t, q, sep);
      });
    }).then(g => {
      if (g && !g.egm96) {
        groundCache.set(key, g);
        while (groundCache.size > CACHE_MAX) groundCache.delete(groundCache.keys().next().value);
      }
      return g;
    });
  }

  // AHD less EGM96 at the middle of a box: { ok, m } or { ok: false, error }.
  function geoidAt(box) {
    if (typeof Geoid === 'undefined') return Promise.resolve({ ok: false, error: 'geoid.js is not loaded' });
    return Geoid.at((box.south + box.north) / 2, (box.west + box.east) / 2).catch(err => ({ ok: false, error: String(err) }));
  }

  // `sep`: the geoid's answer where tile heights went into this ground (null
  // where none did) — { ok: true, m } when they were put into AHD by m, else
  // the reason they could not be, and the ground is EGM96 where they are.
  function finishGround(box, elev, source, holes, filled, tiles, q, sep) {
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
      // AHD, unless tile heights went in and could not be put into it: then
      // the whole ground is EGM96 (`egm96`), or — the State's holes filled
      // in EGM96 — AHD with a note that the fill is not.
      datum: source === 'srtm' && sep && !sep.ok ? 'EGM96' : 'AHD',
      egm96: !!(sep && !sep.ok),
      // AHD less EGM96 here, where tile heights were put into AHD by it.
      geoid: sep && sep.ok ? { m: sep.m, model: sep.model || 'AUSGeoid2020 less EGM96' } : null,
      geoidError: sep && !sep.ok ? sep.error : null,
      attribution: source === 'qld'
        ? (filled ? `${ATTR_QLD_DEM}; gaps: ${(tiles && tiles.attribution) || ''}` : ATTR_QLD_DEM)
        : (tiles && tiles.attribution) || '',
    };
  }

  // ── what covers a point: the State's imagery catalogue ────────────────────
  // The Stations map's offer (map-twin.js) says what the twin would show that
  // the map does not, and the honest form of "high-resolution imagery here"
  // is the resolution and the date of the photography the State holds over
  // the point. The program's ImageServer answers that as a catalog query:
  // every tier whose footprint holds the point — a town's 10 cm flight, the
  // region's 20 cm, the statewide 2.4 m satellite mosaic — with its pixel
  // size in metres (`lowps`), its name and its capture dates. The finest
  // primary tier is what an exportImage of that spot is drawn from. One small
  // request per station, remembered for the session; outside the program's
  // extent the answer is known without asking. A failure is not remembered,
  // so a flaky link is asked again the next time.
  const QLD_IMG_CAT = `${QLD_HOST}/Basemaps/LatestStateProgram_AllUsers/ImageServer/query`;
  const imageryAtCache = new Map();

  // "Lockyer_Valley_Urban_2021_10cm_SISP" → "Lockyer Valley Urban": the
  // catalogue's name less its resolution, its year and its program codes,
  // which the offer says in words of its own (the date from the capture).
  function tierLabel(name) {
    return String(name || '').split('_')
      .filter(t => t && !/^\d+(\.\d+)?(cm|m)$/i.test(t) && !/^(SISP|v\d+)$/i.test(t) && !/^(19|20)\d\d$/.test(t))
      .join(' ') || 'the State\'s imagery';
  }
  function tierWhen(a) {
    const t = Number(a.capturestart || a.captureend);
    if (isFinite(t) && t > 0) {
      const d = new Date(t);
      return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    return a.year ? String(a.year) : '';
  }
  function bestTier(json) {
    const rows = ((json && json.features) || []).map(f => f.attributes || {})
      .filter(a => isFinite(Number(a.lowps)) && Number(a.lowps) > 0);
    if (!rows.length) return null;
    const a = rows.reduce((p, q) => (Number(q.lowps) < Number(p.lowps) ? q : p));
    return {
      res_m: Number(a.lowps), name: a.name || '', label: tierLabel(a.name), when: tierWhen(a),
      satellite: Number(a.acq_platform) === 2 || /satellite|qsat|planet/i.test(`${a.name} ${a.title}`),
    };
  }
  // "10 cm imagery", "2.4 m imagery" — how the status line says a tier.
  function resWords(m) { return `${m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`} imagery`; }

  function imageryAt(lat, lon) {
    if (!known(lat) || !known(lon)) return Promise.resolve(null);
    lat = Number(lat); lon = Number(lon);
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (imageryAtCache.has(key)) return imageryAtCache.get(key);
    const inside = lon >= QLD_IMG_BOX.west && lon <= QLD_IMG_BOX.east && lat >= QLD_IMG_BOX.south && lat <= QLD_IMG_BOX.north;
    let p;
    if (!inside || typeof fetch !== 'function') p = Promise.resolve(inside ? null : { outside: true });
    else {
      const q = new URLSearchParams({
        geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', where: 'category=1',
        outFields: 'name,title,lowps,year,capturestart,captureend,acq_platform',
        returnGeometry: 'false', f: 'json',
      });
      p = fetchBytes(`${QLD_IMG_CAT}?${q}`)
        .then(buf => bestTier(JSON.parse(new TextDecoder().decode(buf))))
        .catch(() => null);
    }
    imageryAtCache.set(key, p);
    p.then(v => { if (v === null) imageryAtCache.delete(key); });
    return p;
  }

  // ── the imagery ────────────────────────────────────────────────────────────
  // Texture width for a patch: 1024 px is 0.4 m/px over 400 m, which is near
  // what the aerial program resolves outside the towns; the two wide patches
  // take 2048 so a 1.6 km square is not 1.6 m blocks.
  function texturePx(size) { return size > 600 ? 2048 : 1024; }

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
    removePhotoMarkers();
    removeFlood();
    removeMovePin();
    removeNeighbours();
    removeBridges();
    removeSharp();
    if (typeof TwinCadastre !== 'undefined') TwinCadastre.remove();
    tw.photoNear = -1;
    sc.pole = null; sc.band = null; sc.doors = []; sc.towerStaff = null;
    remoteClear();
    for (const k of ['terrain', 'wire', 'station', 'figure', 'label', 'paths', 'sky', 'avatars', 'laser', 'dot']) {
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
    sc.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { fitRenderer(); syncCompact(); layoutFloodScale(); requestFrame(); }) : null;
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
    if (sc.sharp) sc.sharp.mesh.visible = want;
    // The bridges' decks wear the same photograph as the ground they span.
    if (sc.bridges) {
      sc.bridges.traverse(o => {
        if (!o.userData.deckMap) return;
        o.material.map = want ? sc.texture : null;
        o.material.color.set(want ? 0xffffff : 0x6f7378);
        o.material.needsUpdate = true;
      });
    }
    requestFrame();
  }

  // ── the imagery, sharp where it matters ───────────────────────────────────
  // The drape is one texture over the whole patch — 1,024 px over 400 m, 0.39 m
  // a pixel — while the State has flown most towns at 10 cm (the offer on the
  // Stations map says so, from its catalogue). A pin put right on 0.39 m
  // pixels is put right to half a metre; on 10 cm ones, to a hand's width.
  // So round the station, and round the pin while it is being moved, a
  // square SHARP_M across is draped again at the finest the catalogue holds
  // there: one more exportImage of SHARP_PX over SHARP_M — 0.098 m a pixel
  // — on a mesh of its own that rides the ground a hair above the patch's
  // (polygonOffset, as the wire does the other way), so the photograph under
  // the station is the one that was flown, not a quarter of it. Only where
  // the catalogue's finest is at least SHARP_GAIN finer than the drape, only
  // from the State's program (Esri's tiles have no catalogue to ask), and
  // never in the .glb, which carries the patch's own texture. It follows the
  // pin in SHARP_STEP jumps, so a drag is one request at its end, not one a
  // frame.
  const SHARP_M = 100, SHARP_PX = 1024, SHARP_GAIN = 1.5, SHARP_STEP = 25;
  let sharpSeq = 0;

  function removeSharp() {
    if (sc.sharp && sc.scene) { sc.scene.remove(sc.sharp.mesh); disposeObject(sc.sharp.mesh); }
    sc.sharp = null;
  }

  // Whether a sharper drape would show anything the patch's does not.
  function sharpWorth() {
    const t = tw.tier, im = tw.image;
    return !!(t && !t.outside && isFinite(t.res_m) && im && im.source === 'qld' && S().imagery
              && t.res_m * SHARP_GAIN < im.mpp && SHARP_M / SHARP_PX < im.mpp);
  }

  // The square's centre for a point: snapped to SHARP_STEP, and kept inside
  // the patch.
  function sharpCentre(x, z) {
    const g = tw.ground, h = SHARP_M / 2;
    const lim = v => Math.max(-g.half + h, Math.min(g.half - h, Math.round(v / SHARP_STEP) * SHARP_STEP));
    return { x: lim(x), z: lim(z) };
  }

  function sharpenAt(x, z) {
    if (!sc.scene || !tw.ground || !tw.origin || !sharpWorth()) return Promise.resolve(false);
    const c = sharpCentre(x, z);
    if (sc.sharp && sc.sharp.x === c.x && sc.sharp.z === c.z) return Promise.resolve(true);
    const seq = tw.seq, mine = ++sharpSeq;
    const ll = latLonAt(c.x, c.z);
    const box = patchBox(ll.lat, ll.lon, SHARP_M);
    return once(() => loadImage(qldImgUrl(box, SHARP_PX))).then(img => {
      if (seq !== tw.seq || mine !== sharpSeq || !sc.scene || !tw.ground) return false;
      const cv = drawToCanvas(img, SHARP_PX);
      if (isBlank(cv)) return false;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, sc.renderer.capabilities.getMaxAnisotropy() || 1);
      const K = Math.round(SHARP_M / tw.ground.sample_m);
      const geo = new THREE.PlaneGeometry(SHARP_M, SHARP_M, K, K);
      geo.rotateX(-Math.PI / 2);
      geo.translate(c.x, 0, c.z);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0,
                                                   polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'sharp imagery';
      mesh.receiveShadow = true;
      mesh.userData.export = false;
      removeSharp();
      sc.sharp = { mesh, x: c.x, z: c.z, mpp: SHARP_M / SHARP_PX };
      placeSharp();
      mesh.visible = !!S().imagery;
      sc.scene.add(mesh);
      requestFrame();
      return true;
    }).catch(() => false);
  }

  // On the ground as drawn: the exaggeration moves it with the patch.
  function placeSharp() {
    if (!sc.sharp) return;
    const pos = sc.sharp.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, yAt(pos.getX(i), pos.getZ(i)));
    pos.needsUpdate = true;
    sc.sharp.mesh.geometry.computeVertexNormals();
    sc.sharp.mesh.geometry.computeBoundingSphere();
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
  // chosen from the record — and, where the record cannot say, nothing is
  // assumed:
  //
  //   * A **Type 3 rainfall station** — the Bureau's green pole with the
  //     tipping-bucket gauge and its ring on top, a small enclosure on the
  //     south face, a solar panel on a bracket to the north, a whip antenna
  //     up the east side, on a concrete pad — for a telemetered station that
  //     reports rainfall and not a river. Its pole is still 2.000 m ×
  //     Ø0.300 m: the brief's ruler, now with the right things on it. A
  //     repeater that measures nothing is the same pole without the gauge.
  //   * A **river-gauge tower** — a 4 m galvanised mast on a flange, a 1.8 m
  //     grating platform with handrails, the cabinet on the platform, the
  //     gauge and the antenna mast with its solar panel, a staff gauge up
  //     the mast's south face, and an extension ladder leaning on the
  //     platform's south edge at 1 in 4 — for a telemetered station the
  //     record says reads a river (a 'Water Level…' or 'Gas Pressure'
  //     sensor, a water_level ALERT address, a Bureau listing typed Water
  //     Level, or the SLS's data type). It stands on a concrete foundation
  //     slab whose top is 100 mm proud of the ground.
  //   * A **manual rainfall station** — the depositional collector an
  //     observer empties and reads: a silver cylinder Ø200 mm and 300 mm tall
  //     standing on the ground, open at the top with its funnel inset.
  //   * A **manual river station** — a white staff gauge 1 m tall on the
  //     ground, graduated as the real plates are: a black E every ten
  //     centimetres, a red figure at each metre.
  //   * A **manual rainfall and river station** — both, side by side: the
  //     record has one coordinate for what are, on the ground, often two
  //     places, and the notes say so.
  //   * **A red post, 1 m tall**, where the record cannot say what the station
  //     is: nothing says whether a person or a radio reads it, or nothing says
  //     what it measures. A model of a Type 3 pole there would be a guess
  //     drawn as confidently as a fact, which is the one thing this tab is
  //     careful never to do; the notes say what is known and what is not.
  //
  // A station type in the record (0039 — asked of every proposal) decides
  // outright: an automatic water level station is the tower, an automatic
  // rain gauge the pole, a manual one the staff or the collector, whatever
  // the sensors and addresses say or do not yet say. Otherwise:
  //
  // Manual is what the Bureau's Service Level Specification says (its gauge
  // type, by bureau number — SLS.forStation, the card's own lookup, which for a
  // station both states' documents list is the one the card quotes first), or, for a
  // station the SLS does not carry, being in the Bureau's list of daily-read
  // gauges (Section 2 of its river height station lists) with nothing in the
  // record saying a radio reads it. Telemetered is the Telemetry field set,
  // a name ending AL, ALERT or TM, ALERT addresses, satcom, or the SLS saying
  // Automatic. What it measures
  // is the sensors, the ALERT addresses, the Bureau's location types and the
  // SLS's data type, together. The SLS file is fetched once (1.2 MB, the
  // card's) before the station is built, and a build that cannot have it
  // decides without it and says so.
  //
  // Inside each enclosure is the electronics the network fits, by telemetry,
  // read first from the Telemetry field (inspection_config_key) and only
  // failing that from the name and addresses: an ELPRO ERRTS ERT-A2 radio for
  // an ALERT station (Telemetry ALERT, a name ending AL or ALERT, or ALERT
  // addresses in the record), a Campbell Scientific CR300 logger and a Beam
  // Iridium SBD modem for a TM station (Telemetry a Campbell or older data
  // logger, a name ending TM, or satcom on). An automatic station whose radio the record cannot name
  // is drawn as TM and the notes say so. Every tower cabinet carries a
  // Kisters HS40 compressor bubbler in its upper compartment, and a Victron
  // charge controller, the telemetry, the terminals and the battery below. A
  // plate inside names the station and its number. The doors open on their
  // own: a pole's when the POV eye comes within DOOR_NEAR of it, the tower's
  // when the visitor is up on the platform — and close again when they leave.
  //
  // The other stations whose positions fall inside the patch are built too,
  // each by the same rules, standing on the ground where they are — see
  // "the neighbours", below.
  // The tower comes in two platform heights (the standard drawing's table:
  // 3.0 m and 4.5 m, each on a 2100 × 2100 footing). Which one a site has is
  // the station's `tower_height` (0040), recorded by an editor here or in the
  // station editor; where nobody has, it is drawn at the 3.0 m default.
  const TOWER_TYPES = { '3.0': { key: '3.0', h: 3.0 }, '4.5': { key: '4.5', h: 4.5 } };
  const TOWER_DEFAULT = '3.0';
  const FOOTING = 2.1;       // the footing, 2100 × 2100, the mast at its centre
  function towerSpec(st) {
    const rec = st && st.tower_height != null ? TOWER_TYPES[Number(st.tower_height).toFixed(1)] : null;
    const spec = rec || TOWER_TYPES[TOWER_DEFAULT];
    const h = spec.h;
    return { key: spec.key, h, recorded: !!rec, deck: h + 0.05,
             ladderZ: LADDER_TOP_Z + (h + 0.05 - SLAB_TOP) * LADDER_RUN,   // the ladder's foot
             staffH: Math.min(3.0, h - 0.2) };                            // the gauge board, kept under the grating
  }
  // The way the station faces (0044): the bearing its front — the side the
  // enclosure door, or a tower's ladder, is on — looks out, clockwise from
  // true north. Every model is built facing south (180), which is also what a
  // station that records nothing is drawn as. The model is built square in its
  // own frame and turned as a whole: `sc.turn` is how far, in radians
  // clockwise from as-built, and toWorld/toLocal carry a point between the
  // station's frame and the scene's — for the ladder, the deck and the footing,
  // which the walk reads in the station's frame.
  const FACING_DEFAULT = 180;
  function facingOf(st) {
    const v = st && st.facing_deg != null && st.facing_deg !== '' ? Number(st.facing_deg) : NaN;
    return Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
  }
  // The bearing drawn now: the Orientation tool's, while it is open on this
  // station, else the station's own, else the default.
  function facingNow(st = currentStation()) {
    if (tw.orient && st && tw.orient.id === st.id) return tw.orient.deg;
    const f = facingOf(st);
    return f == null ? FACING_DEFAULT : f;
  }
  function turnOf(deg) { return (deg - FACING_DEFAULT) * Math.PI / 180; }
  function toWorld(x, z, t = sc.turn || 0) {
    const c = Math.cos(t), s = Math.sin(t);
    return { x: x * c - z * s, z: x * s + z * c };
  }
  function toLocal(x, z, t = sc.turn || 0) {
    const c = Math.cos(t), s = Math.sin(t);
    return { x: x * c + z * s, z: -x * s + z * c };
  }
  const DECK_HALF = 0.9;     // the platform is 1.8 m square
  const RAIL_H    = 1.1;     // handrail over the deck
  const SLAB_TOP  = 0.10;    // the foundation slab stands 100 mm proud of the ground
  // The footing's top, as the drawings have it: 2100 × 2100 with the mast at
  // its centre. The ladder's foot stands beyond it, on the ground.
  const SLAB_N = -FOOTING / 2, SLAB_S = FOOTING / 2, SLAB_HALF_EW = FOOTING / 2;
  // The extension ladder: leaning on the deck's south edge at 1 in 4 (a metre
  // out at its foot for every four up — AS/NZS 1892 and every WorkSafe
  // guide, about 76°), running on a metre past the landing as a handhold.
  const LADDER_RUN   = 0.25;   // horizontal metres per vertical metre
  const LADDER_TOP_Z = 1.005;  // the base section's centre line where it passes the deck's top
  const LADDER_HW = 0.2;     // half the fly section's width (the base's is 0.23)
  const LADDER_OVER = 1.0;   // how far past the landing the stiles run
  const CLIMB_MPS = 1.2;     // up the ladder (Shift doubles it)
  const DOOR_NEAR = 2.2;     // a pole enclosure opens when the eye is this close
  const DOOR_RATE = 2.6;     // radians per second

  // Red-post and manual-kit dimensions, the owner's brief: a collector
  // Ø200 mm × 300 mm, a staff gauge 1 m, a post 1 m.
  const COLLECTOR_R = 0.10, COLLECTOR_H = 0.30;
  const STAFF_H = 1.0, STAFF_W = 0.10;
  const POST_H = 1.0, POST_R = 0.0375;

  // What the record says a station is: its structure and its telemetry, and
  // — where it cannot say — why not (`unsure`, words for the notes).
  //
  //   structure: 'pole' | 'tower' | 'repeater' | 'collector' | 'staff'
  //            | 'collector+staff' | 'post'
  function stationKind(st) {
    const name = String((st && st.name) || '').trim();
    const m = /\s(AL|ALERT|TM)$/i.exec(name);
    const suffix = m ? m[1].toUpperCase() : null;
    const sensors = st && typeof stationSensors === 'function' ? stationSensors(st) : ((st && st.sensors) || []);
    const types = sensors.map(s => String((s && s.type) || ''));
    const aids = (st && st.alert_ids) || {};
    const locs = Array.isArray(st && st.location_types) ? st.location_types : [];
    const stype = String((st && st.station_type) || '');
    const cfg = String((st && st.inspection_config_key) || '');
    // The Service Level Specification, by bureau number, where it has loaded.
    const sls = st && typeof SLS !== 'undefined' && SLS.forStation ? SLS.forStation(st) : null;
    const slsData = sls ? String(sls.data_type || '') : '';
    const slsManual = !!sls && /^manual$/i.test(String(sls.gauge_type || ''));
    const slsAuto = !!sls && /^automatic$/i.test(String(sls.gauge_type || ''));
    const water = types.some(t => /^Water Level|^Gas Pressure/i.test(t))
      || cfg === 'gas_only' || /_water_level$/.test(stype)
      || aids.water_level != null || locs.includes('Water Level') || /river/i.test(slsData);
    const rain = types.some(t => /^Rainfall/i.test(t)) || aids.rainfall != null
      || /_rain_gauge$/.test(stype)
      || locs.includes('Rain Gauge') || /rainfall/i.test(slsData);
    const repeater = (Array.isArray(st && st.roles) && st.roles.includes('repeater'))
      || locs.includes('Repeater') || /repeater/i.test(slsData)
      || cfg === 'base_station';
    const alertEvidence = sensors.some(s => s && s.alert_id != null) || Object.keys(aids).length > 0;
    const satcom = !!(st && st.satcom && st.satcom.enabled);
    // The Telemetry field — the editor's "Telemetry / inspection form", whose
    // six configurations follow the station's telemetry type — says outright
    // what reads the station, so it comes before anything inferred: an ALERT
    // canister is the radio; a Campbell or older data logger is a logger and
    // modem, drawn as TM; Mace (the telephone) and a gas-only site are read
    // automatically by something the kit here does not draw, so the radio
    // stays unnamed. A base station is a repeater's.
    const cfgTelemetry = cfg === 'alert' ? 'alert'
      : cfg === 'campbell_datalogger' || cfg === 'datalogger_old' ? 'tm' : null;
    const cfgAuto = cfgTelemetry != null || cfg === 'mace' || cfg === 'gas_only';
    let telemetry = cfgTelemetry
      || (suffix === 'TM' ? 'tm' : suffix ? 'alert' : alertEvidence ? 'alert' : satcom ? 'tm' : null);
    const known = telemetry != null;
    // The station type (0039), where the record has one — asked of every
    // proposal — is what the station is or is to be, said by a person, and
    // wins over anything read from sensors and listings: an automatic water
    // level station is the tower and an automatic rain gauge the pole, before
    // any ALERT address is assigned to it.
    const typeAuto = /^auto_/.test(stype), typeManual = /^manual_/.test(stype);
    const typeWater = /_water_level$/.test(stype), typeRain = /_rain_gauge$/.test(stype);
    const dailyRead = Array.isArray(st && st.bureau_listings)
      && st.bureau_listings.some(b => b && String(b.section) === '2');
    // Manual: the station type or the SLS says so; or, where neither says
    // either way, the Bureau reads it daily and nothing in the record says a
    // radio does.
    const manual = typeManual
      || (!typeAuto && (slsManual || (!slsAuto && !known && !cfgAuto && dailyRead)));
    const telemetered = !manual && (typeAuto || known || cfgAuto || slsAuto);
    if (!telemetry) telemetry = 'tm';
    let structure, unsure = null;
    if (typeWater || typeRain) {
      structure = manual ? (typeWater ? 'staff' : 'collector') : (typeWater ? 'tower' : 'pole');
    } else if (manual) {
      structure = rain && water ? 'collector+staff' : rain ? 'collector' : water ? 'staff' : 'post';
      if (structure === 'post') unsure = 'it is read by hand, but nothing says whether it measures rainfall or a river';
    } else if (telemetered) {
      structure = water ? 'tower' : rain ? 'pole' : repeater ? 'repeater' : 'post';
      if (structure === 'post') unsure = `a radio reads it${suffix ? ` (its name ends ${suffix})` : ''}, but nothing says whether it measures rainfall or a river`;
    } else {
      structure = 'post';
      const what = rain && water ? 'rainfall and a river' : rain ? 'rainfall' : water ? 'a river' : repeater ? 'as a repeater' : null;
      unsure = what
        ? `the record says it ${what === 'as a repeater' ? 'serves' : 'measures'} ${what}, but not whether a person or a radio reads it`
        : 'the record says neither what it measures nor whether a person or a radio reads it';
    }
    return { structure, telemetry, telemetryKnown: known, telemetered, manual, water, rain, repeater, suffix,
             stationType: stype || null, config: cfg || null,
             sls: sls ? { gauge_type: sls.gauge_type || null, data_type: sls.data_type || null } : null,
             dailyRead, unsure };
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
    // three arms round it — not on a repeater that measures nothing.
    const gauge = kind.structure !== 'repeater';
    if (gauge) {
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
    return { group: g, top: gauge ? POLE_H + 0.35 : POLE_H, poleTop: POLE_H, ladder: null, deck: null };
  }

  // The manual rainfall station: a depositional collector an observer reads,
  // Ø200 mm and 300 mm tall on the ground, silver. Its outside is the brief's
  // cylinder exactly; the rim, the funnel sunk into its mouth and the dark of
  // the throat are inside that envelope, so the ruler is still the ruler.
  function buildCollector(k, x = 0) {
    const g = new THREE.Group();
    g.name = 'rain collector';
    g.position.x = x;
    const silver = new THREE.MeshStandardMaterial({ color: 0xc7ccd1, metalness: 0.85, roughness: 0.28 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(COLLECTOR_R, COLLECTOR_R, COLLECTOR_H, 40, 1, true), silver);
    body.position.y = COLLECTOR_H / 2; body.castShadow = true; body.name = 'collector body';
    const base = new THREE.Mesh(new THREE.CircleGeometry(COLLECTOR_R, 40), silver);
    base.rotation.x = -Math.PI / 2; base.position.y = 0.002; base.name = 'collector base';
    // The funnel: a cone opening upward from the throat to the rim, just
    // inside the mouth.
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(COLLECTOR_R - 0.004, 0.012, 0.07, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide }));
    funnel.position.y = COLLECTOR_H - 0.035; funnel.name = 'collector funnel';
    const throat = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16), k.black);
    throat.rotation.x = -Math.PI / 2; throat.position.y = COLLECTOR_H - 0.069; throat.name = 'collector throat';
    const rim = new THREE.Mesh(new THREE.TorusGeometry(COLLECTOR_R - 0.003, 0.003, 6, 48), silver);
    rim.rotation.x = Math.PI / 2; rim.position.y = COLLECTOR_H - 0.003; rim.name = 'collector rim';
    g.add(body, base, funnel, throat, rim);
    return { group: g, top: COLLECTOR_H };
  }

  // The staff gauge's face: white, a black E every ten centimetres — the
  // pattern real plates carry, each E's teeth a centimetre apart — and the
  // metre figure in red at the foot of each metre. Drawn once per build on a
  // canvas at 64 px a decimetre.
  function staffFace() {
    const PX = 64, W = 64, H = PX * 10;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, W, H);
    for (let dm = 0; dm < 10; dm++) {
      // Canvas y runs down from the top, which is 1.0 m; the decimetre from
      // dm to dm+1 is the band from H − (dm+1)·PX to H − dm·PX.
      const top = H - (dm + 1) * PX;
      const u = PX / 10;   // a centimetre
      cx.fillStyle = '#111111';
      // The E: its spine on the left for even decimetres, the right for odd,
      // as the plates alternate; three teeth, each a centimetre deep, at the
      // decimetre's top, middle and foot.
      const left = dm % 2 === 0;
      const sx = left ? 4 : W - 4 - 10;
      cx.fillRect(sx, top + u * 0.5, 10, u * 9);
      for (const t of [0.5, 4.5, 8.5]) cx.fillRect(left ? sx : W / 2 - 6, top + u * t, W / 2 + 2, u);
    }
    cx.fillStyle = '#d01818';
    cx.font = '700 30px system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'bottom';
    cx.fillText('0', W - 16, H - 2);
    cx.fillText('1', W - 16, 32);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // The manual river station: the staff gauge, 1 m tall and 100 mm wide,
  // standing on the ground on a galvanised post behind it, its face to the
  // south (the scene's opening view looks north across the station).
  function buildStaff(k, x = 0) {
    const g = new THREE.Group();
    g.name = 'staff gauge';
    g.position.x = x;
    // The plate is one white box — one material a mesh, which is what the
    // .glb writer takes — and its graduations are a face laid a hair proud of
    // its front.
    const white = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.55 });
    // Named as a gauge board rather than a staff: the flood water's own
    // staff (see "the flood water") is a simulation and never exported, and
    // the .glb reader tells the two apart by name.
    const plate = new THREE.Mesh(new THREE.BoxGeometry(STAFF_W, STAFF_H, 0.012), white);
    plate.position.set(0, STAFF_H / 2, 0.02); plate.castShadow = true; plate.name = 'gauge board';
    const face = new THREE.Mesh(new THREE.PlaneGeometry(STAFF_W, STAFF_H),
      new THREE.MeshStandardMaterial({ map: staffFace(), roughness: 0.55 }));
    face.position.set(0, STAFF_H / 2, 0.0265); face.name = 'gauge board graduations';
    const post = box(g, k.galv, 0.04, STAFF_H, 0.04, 0, STAFF_H / 2, -0.012, 'gauge board post');
    post.castShadow = true;
    g.add(plate, face);
    return { group: g, top: STAFF_H };
  }

  // A station the record cannot say what it is: a red post, 1 m, and no more.
  function buildPost() {
    const g = new THREE.Group();
    g.name = 'unknown station post';
    const red = new THREE.MeshStandardMaterial({ color: 0xd62020, roughness: 0.5 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 20), red);
    post.position.y = POST_H / 2; post.castShadow = true; post.name = 'red post';
    const cap = new THREE.Mesh(new THREE.SphereGeometry(POST_R, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), red);
    cap.position.y = POST_H; cap.name = 'red post cap';
    g.add(post, cap);
    return { group: g, top: POST_H + POST_R };
  }

  // The manual kit, one or both — side by side when both, 1.2 m apart, the
  // origin between them.
  function buildManual(kind, k) {
    const g = new THREE.Group();
    g.name = 'station';
    let top = 0;
    const both = kind.structure === 'collector+staff';
    if (kind.structure === 'collector' || both) {
      const c = buildCollector(k, both ? -0.6 : 0);
      g.add(c.group); top = Math.max(top, c.top);
    }
    if (kind.structure === 'staff' || both) {
      const t = buildStaff(k, both ? 0.6 : 0);
      g.add(t.group); top = Math.max(top, t.top);
    }
    return { group: g, top, poleTop: top, ladder: null, deck: null };
  }

  // The river-gauge tower.
  function buildTower(st, kind, k, groundAt) {
    const T = towerSpec(st), TOWER_H = T.h, DECK_TOP = T.deck, TOWER_STAFF_H = T.staffH;
    // The ladder's foot is beyond the 2100 footing, on the ground: leant from
    // the deck's edge at 1 in 4 down to wherever the ground is there (found in
    // a few passes, since where it lands depends on how far it falls). Without
    // the ground — nothing built under it yet — it stands level with the slab.
    const standOn = z => { const y = groundAt(0, z); return z <= SLAB_S ? Math.max(y, SLAB_TOP) : y; };
    let footY = SLAB_TOP, footZ = T.ladderZ;
    if (groundAt) {
      for (let i = 0; i < 4; i++) {
        footY = Math.min(DECK_TOP - 1, Math.max(DECK_TOP - 8, standOn(footZ)));
        footZ = LADDER_TOP_Z + (DECK_TOP - footY) * LADDER_RUN;
      }
    }
    const g = new THREE.Group();
    g.name = 'station';
    // The foundation: the footing's top 100 mm proud of the ground (drawn
    // 400 mm deep so a slope under it never shows a gap), and the mast's
    // flange bolted to it. The mast's foot is still the ground at the
    // origin — the footing is cast round it.
    box(g, k.concrete, 2 * SLAB_HALF_EW, 0.4, SLAB_S - SLAB_N, 0, SLAB_TOP - 0.2, (SLAB_N + SLAB_S) / 2, 'foundation slab');
    cyl(g, k.cream, 0.28, 0.28, 0.03, 0, SLAB_TOP + 0.015, 0, 'base flange', 32);
    const mast = cyl(g, k.galv, POLE_R, POLE_R, TOWER_H, 0, TOWER_H / 2, 0, 'station pole', 40);
    sc.pole = mast;
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
    // The staff gauge up the mast's south face, where whoever comes up the
    // ladder can read it: a white board from the slab to 3 m over it, its
    // graduations drawn by towerStaffFace once the ground under it is known.
    box(g, k.galv, 0.05, TOWER_STAFF_H, 0.02, 0, SLAB_TOP + TOWER_STAFF_H / 2, POLE_R + 0.005, 'gauge board post');
    const staffBoard = box(g, new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.55 }),
      STAFF_W, TOWER_STAFF_H, 0.012, 0, SLAB_TOP + TOWER_STAFF_H / 2, POLE_R + 0.021, 'gauge board');
    staffBoard.castShadow = true;
    const staffFaceMesh = new THREE.Mesh(new THREE.PlaneGeometry(STAFF_W, TOWER_STAFF_H),
      new THREE.MeshStandardMaterial({ map: towerStaffFace(SLAB_TOP, TOWER_STAFF_H), roughness: 0.55 }));
    staffFaceMesh.position.set(0, SLAB_TOP + TOWER_STAFF_H / 2, POLE_R + 0.0275);
    staffFaceMesh.name = 'gauge board graduations';
    staffFaceMesh.userData.staffH = TOWER_STAFF_H;
    g.add(staffFaceMesh);
    buildExtensionLadder(g, k, T, footY, footZ);
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
    // The rain gauge on a wing bracket off the cabinet's west side, its foot
    // level with the cabinet's top: a plate on the cabinet's side, a shelf
    // out from it and a brace under the shelf. Then the antenna mast at the
    // north-east corner with its solar panel and the whip.
    const cabTop = DECK_TOP + CH, cz = cab.position.z, side = -CW / 2, gx = side - 0.21;
    box(g, k.galv, 0.008, 0.30, 0.20, side - 0.004, cabTop - 0.15, cz, 'gauge bracket');
    box(g, k.galv, 0.30, 0.012, 0.24, side - 0.15, cabTop - 0.006, cz, 'gauge bracket');
    bar(g, k.galv, 0.012, side - 0.01, cabTop - 0.28, cz, side - 0.27, cabTop - 0.015, cz, 'gauge bracket brace');
    cyl(g, k.steel, 0.10, 0.10, 0.30, gx, cabTop + 0.15, cz, 'rain gauge', 32);
    cyl(g, k.orange, 0.10, 0.07, 0.04, gx, cabTop + 0.32, cz, 'gauge funnel', 32);
    cyl(g, k.galv, 0.025, 0.025, 3.5, 0.75, DECK_TOP + 1.75, -0.75, 'antenna mast', 12);
    cyl(g, k.white, 0.006, 0.006, 3.0, 0.75, DECK_TOP + 3.5 + 1.5, -0.75, 'whip antenna', 8);
    const sp = new THREE.Group();
    sp.position.set(0.75, DECK_TOP + 1.7, -0.75 - 0.05);
    sp.rotation.x = 0.52;
    g.add(sp);
    box(sp, k.galv, 0.58, 0.43, 0.02, 0, 0, 0, 'solar frame');
    box(sp, k.panel, 0.55, 0.40, 0.006, 0, 0, -0.012, 'solar panel');
    return { group: g, top: DECK_TOP + RAIL_H, poleTop: TOWER_H, tower: T,
             ladder: { x: 0, z: footZ, foot: footZ, stand: footZ + 0.22, y: footY, run: LADDER_RUN, halfW: LADDER_HW },
             slab: { n: SLAB_N, s: SLAB_S, halfEW: SLAB_HALF_EW, top: SLAB_TOP },
             deck: { top: DECK_TOP, half: DECK_HALF, front: -H + CD + 0.12 },
             staff: staffFaceMesh };
  }

  // The extension ladder: a base section on the footing and a fly section
  // behind it, run up until the stiles stand a metre past the landing, both
  // leaning on the deck's south edge at 1 in 4. Built square in a group whose
  // local y runs up the stiles and local +z out to the climber, then leant.
  // Rungs every 300 mm, rubber feet, the guide brackets that hold the two
  // sections together, the rung locks on the fly and a tie at the top.
  function buildExtensionLadder(g, k, T, footY, footZ) {
    const DECK_TOP = T.deck;
    const lean = Math.atan(LADDER_RUN);
    const rise = DECK_TOP - footY;
    const len = Math.hypot(rise, rise * LADDER_RUN) + LADDER_OVER;
    const lg = new THREE.Group();
    lg.name = 'extension ladder';
    lg.position.set(0, footY, footZ);
    lg.rotation.x = -lean;
    g.add(lg);
    const baseHW = LADDER_HW + 0.03, BASE_TOP = 3.2, FLY_FOOT = 2.0, FLY_Z = -0.07;
    for (const sx of [-baseHW, baseHW]) {
      box(lg, k.steel, 0.03, BASE_TOP, 0.07, sx, BASE_TOP / 2, 0, 'ladder stile');
      box(lg, k.black, 0.05, 0.05, 0.11, sx, 0.025, 0.01, 'ladder foot');
      box(lg, k.dark, 0.045, 0.08, 0.16, sx, BASE_TOP - 0.06, FLY_Z / 2, 'ladder guide bracket');
    }
    for (const sx of [-LADDER_HW, LADDER_HW]) {
      box(lg, k.steel, 0.03, len - FLY_FOOT, 0.07, sx, (FLY_FOOT + len) / 2, FLY_Z, 'ladder stile');
      box(lg, k.dark, 0.045, 0.08, 0.16, sx, FLY_FOOT + 0.06, FLY_Z / 2, 'ladder guide bracket');
      box(lg, k.orange, 0.05, 0.10, 0.04, sx, FLY_FOOT + 0.20, FLY_Z + 0.05, 'ladder rung lock');
    }
    for (let y = 0.3; y <= BASE_TOP - 0.15; y += 0.3) bar(lg, k.steel, 0.016, -baseHW, y, 0, baseHW, y, 0, 'ladder rung');
    for (let y = FLY_FOOT + 0.15; y <= len - 0.1; y += 0.3) bar(lg, k.steel, 0.016, -LADDER_HW, y, FLY_Z, LADDER_HW, y, FLY_Z, 'ladder rung');
    // The tie: the fly's stiles lashed to the handrail posts either side of
    // the gap, 300 mm over the grating.
    const ty = DECK_TOP + 0.3, tz = footZ - (ty - footY) * LADDER_RUN + FLY_Z, p = DECK_HALF - 0.02, hw = LADDER_HW + 0.1;
    for (const sx of [-1, 1]) bar(g, k.orange, 0.008, sx * LADDER_HW, ty, tz, sx * hw, ty, p, 'ladder tie');
  }

  // The staff gauge's face for the tower's board, TOWER_STAFF_H tall: the
  // same plate as staffFace — a black E every ten centimetres, the metre in
  // red — but reading from `base` at its foot, so the figures are the
  // gauge's own heights wherever its zero is known in AHD. Drawn at 48 px a
  // decimetre.
  function towerStaffFace(base, TOWER_STAFF_H) {
    const PX = 48, W = 64, H = Math.round(PX * TOWER_STAFF_H * 10);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, W, H);
    const yOf = r => H - (r - base) * 10 * PX;   // canvas y of a reading
    const u = PX / 10;
    cx.fillStyle = '#111111';
    for (let dm = Math.floor(base * 10); dm < Math.ceil((base + TOWER_STAFF_H) * 10); dm++) {
      const top = yOf((dm + 1) / 10);
      const left = ((dm % 2) + 2) % 2 === 0;
      const sx = left ? 4 : W - 4 - 10;
      cx.fillRect(sx, top + u * 0.5, 10, u * 9);
      for (const t of [0.5, 4.5, 8.5]) cx.fillRect(left ? sx : W / 2 - 6, top + u * t, W / 2 + 2, u);
    }
    cx.fillStyle = '#d01818';
    cx.font = '700 26px system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'bottom';
    for (let m = Math.ceil(base); m < base + TOWER_STAFF_H; m++) {
      const y = yOf(m);
      cx.fillRect(0, y - 2, W, 3);
      cx.fillText(String(m), W / 2, y - 4);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // What a tower's staff reads at its foot: the height on the gauge where
  // the station's zero is surveyed in AHD, else the height over the ground
  // the tower stands on. Re-draws the board's face; returns the basis.
  function setTowerStaff(face, st, groundAhd) {
    if (!face) return null;
    let zero = null;
    try { zero = typeof FloodStages !== 'undefined' ? FloodStages.ladder(st).ahdZero : null; } catch (_) { zero = null; }
    const onGauge = zero != null && isFinite(groundAhd);
    const base = onGauge ? groundAhd + SLAB_TOP - zero : SLAB_TOP;
    const old = face.material.map;
    face.material.map = towerStaffFace(base, face.userData.staffH);
    face.material.needsUpdate = true;
    if (old) old.dispose();
    face.userData.staff = { base, onGauge };
    return face.userData.staff;
  }

  // The station at the origin: which of the two, built, and remembered.
  // One station, built by its kind, standing at its own origin: what
  // buildStation puts at the patch's centre and what "the neighbours" put
  // wherever theirs are.
  // `groundAt(x, z)` is the ground at a point, in metres over the station's own
  // foot — for what reaches past the station's footing (a tower's ladder).
  function makeStation(st, kind, k, groundAt) {
    switch (kind.structure) {
      case 'tower': return buildTower(st, kind, k, groundAt);
      case 'pole': case 'repeater': return buildPoleStation(st, kind, k);
      case 'collector': case 'staff': case 'collector+staff': return buildManual(kind, k);
      default: {
        const p = buildPost();
        p.group.name = 'station';
        return { group: p.group, top: p.top, poleTop: POST_H, ladder: null, deck: null };
      }
    }
  }

  function buildStation(st) {
    const kind = stationKind(st);
    const k = kitMaterials();
    sc.doors = [];
    sc.pole = null; sc.band = null;
    if (tw.orient && tw.orient.id !== st.id) tw.orient = null;
    sc.turn = turnOf(facingNow(st));
    const built = makeStation(st, kind, k, tw.ground ? (x, z) => { const w = toWorld(x, z); return yAt(w.x, w.z) - yAt(0, 0); } : null);
    built.group.position.y = 0;
    built.group.rotation.y = -sc.turn;
    sc.station = built.group;
    sc.towerStaff = built.staff || null;
    if (built.staff && tw.ground) setTowerStaff(built.staff, st, tw.ground.h0);
    sc.scene.add(built.group);
    tw.model = { ...kind, top: built.top, poleTop: built.poleTop, ladder: built.ladder, deck: built.deck, slab: built.slab || null, tower: built.tower || null,
                 plate: { name: st.name || st.id, number: st.station_number ? String(st.station_number) : '' } };
    refreshTowerField();
    renderOrientPanel();
  }

  // The station as a phrase, for the canvas's name.
  function modelWords(m) {
    switch (m && m.structure) {
      case 'tower': return `a river-gauge tower with its platform ${m.tower ? m.tower.h.toFixed(1) : '3.0'} m up`
                           + (m.tower && !m.tower.recorded ? ' (the default: the station records no height)' : '');
      case 'repeater': return 'a repeater\'s pole 2 m tall';
      case 'collector': return 'a manual rain collector 300 mm tall';
      case 'staff': return 'a 1 m staff gauge';
      case 'collector+staff': return 'a manual rain collector and a 1 m staff gauge';
      case 'post': return 'a 1 m red post — the record does not say what the station is';
      default: return 'a Type 3 rainfall pole 2 m tall';
    }
  }

  // What the build says about the station it stood up, for the notes.
  function stationNote(m) {
    if (!m) return null;
    if (m.structure === 'post') return `There is no telling from the record what this station is — ${m.unsure} — so it is drawn as a red post 1 m tall rather than as a guess.`;
    if (m.structure === 'collector+staff') return 'A manual station that reads both rainfall and a river: the collector and the staff gauge are drawn side by side at its one position, though on the ground they are often apart.';
    if ((m.structure === 'pole' || m.structure === 'tower' || m.structure === 'repeater') && !m.telemetryKnown) {
      return `This station's radio is not in its record — no Telemetry field, no AL or TM in the name, no ALERT addresses, no satcom${m.stationType && /^auto_/.test(m.stationType) ? '; its type says only that it is automatic' : ''}${m.sls && m.sls.gauge_type ? '; the SLS says only that it is automatic' : ''} — so its enclosure is drawn as a TM station's: a CR300 logger and a Beam SBD modem.`;
    }
    return null;
  }

  // Where feet on the ground are: on the tower's footing where they are over
  // it (unless the ground, exaggerated, has risen over it), else the ground.
  // `x`, `z` are the scene's; the footing is the station's, so turned with it.
  function standY(x, z) {
    const y = yAt(x, z);
    const f = tw.model && tw.model.slab;
    if (!f) return y;
    const p = toLocal(x, z);
    if (Math.abs(p.x) <= f.halfEW && p.z >= f.n && p.z <= f.s) return Math.max(y, f.top);
    return y;
  }

  // The ladder's foot, and its height, live: the ground under it moves with
  // the exaggeration, the deck does not.
  function ladderFootY() {
    const m = tw.model;
    if (!m || !m.ladder) return 0;
    const w = toWorld(m.ladder.x, m.ladder.stand);
    return standY(w.x, w.z);
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

  // A person, 1.75 m — boots, legs, a torso, two arms, a head, a hard hat — in
  // the colours asked for (CSS colours: the hat, the shirt, the trousers).
  // Primitives rather than a model: a model is a file to fetch and a licence
  // to carry, and what this figure is for is a sense of scale, which a capsule
  // in orange gives as well as a mesh of a face. The right arm hangs from a
  // shoulder pivot so it can be raised to point. Local −z is the front, so a
  // group turned by −yaw faces the way its owner is looking (the camera's own
  // convention: forward is (sin yaw, ·, −cos yaw)).
  function makeFigure({ hat = '#ffd400', shirt = '#ff6a00', pants = '#1f2a44' } = {}) {
    const grp = new THREE.Group();
    const M = (color, roughness) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness });
    const shirtM = M(shirt, 0.8), pantsM = M(pants, 0.9), skin = M('#c9a07a', 0.7), hatM = M(hat, 0.5), boot = M('#3a2d22', 0.9);
    const add = (parent, geo, mat, x, y, z, name) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.name = name;
      parent.add(m);
      return m;
    };
    // Boots 0–0.12, legs to 0.82, torso to 1.46, head to 1.72, hat crown 1.75.
    add(grp, new THREE.CylinderGeometry(0.075, 0.085, 0.12, 12), boot, -0.11, 0.06, 0.02, 'boot');
    add(grp, new THREE.CylinderGeometry(0.075, 0.085, 0.12, 12), boot,  0.11, 0.06, 0.02, 'boot');
    add(grp, new THREE.CylinderGeometry(0.068, 0.078, 0.70, 14), pantsM, -0.11, 0.47, 0, 'leg');
    add(grp, new THREE.CylinderGeometry(0.068, 0.078, 0.70, 14), pantsM,  0.11, 0.47, 0, 'leg');
    add(grp, new THREE.CapsuleGeometry(0.175, 0.30, 6, 16), shirtM, 0, 1.13, 0, 'torso');
    const la = add(grp, new THREE.CapsuleGeometry(0.052, 0.52, 4, 12), shirtM, -0.27, 1.12, 0, 'arm');
    la.rotation.z = 0.12;
    const shoulder = new THREE.Group();
    shoulder.position.set(0.27, 1.43, 0);
    shoulder.rotation.z = -0.12;
    shoulder.name = 'shoulder';
    grp.add(shoulder);
    add(shoulder, new THREE.CapsuleGeometry(0.052, 0.52, 4, 12), shirtM, 0, -0.312, 0, 'arm');
    add(grp, new THREE.SphereGeometry(0.105, 20, 14), skin, 0, 1.60, 0, 'head');
    add(grp, new THREE.SphereGeometry(0.125, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hatM, 0, 1.625, 0, 'hard hat');
    add(grp, new THREE.CylinderGeometry(0.165, 0.165, 0.012, 24), hatM, 0, 1.627, 0, 'hat brim');
    grp.userData.shoulder = shoulder;
    return grp;
  }

  // The scale figure: a metre east of the station with its feet on the ground
  // there — not at the pole's height.
  function buildFigure() {
    const grp = makeFigure();
    // West of a tower, off its footing, which runs away to the south.
    const tower = tw.model && tw.model.structure === 'tower';
    const fx = tower ? -1.6 : 1.0, fz = tower ? 0.6 : 0.25;
    grp.position.set(fx, yAt(fx, fz), fz);
    grp.rotation.y = Math.atan2(-fx, -fz) + Math.PI;   // facing away from the pole, as if looking at it over a shoulder
    grp.visible = !!S().figure;
    grp.name = 'figure';
    sc.figure = grp;
    sc.scene.add(grp);
  }

  // ── other visitors ─────────────────────────────────────────────────────────
  // The people in this station's room (twin-presence.js): a figure each in
  // the colours they chose, their name over their head, placed where their
  // last pose said and walked to the next one over the time between — and,
  // when they point, the right arm raised along their look and a laser from
  // the hand to whatever it lands on. The visitor's own pointer is the same
  // laser, from beside the eye. Nothing here goes in the .glb.
  const avatars = new Map();   // presence key → { group, sprite, shoulder, laser, dot, info, pose, shown, from, to, t0, dur, laserLen }
  const LASER_MAX = 60;
  const LASER_COLOUR = 0xff2a2a;

  function noExport(o) { o.traverse(x => { x.userData.export = false; }); return o; }
  function avatarsGroup() {
    if (!sc.avatars && sc.scene) { sc.avatars = new THREE.Group(); sc.avatars.name = 'visitors'; sc.scene.add(sc.avatars); }
    return sc.avatars;
  }
  function lookVec(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }
  // How far a ray from `origin` along `dir` goes before it lands on the
  // ground, the station or the far ground — LASER_MAX if nothing.
  function laserHit(origin, dir) {
    const rc = new THREE.Raycaster(origin, dir, 0.05, LASER_MAX);
    const hit = rc.intersectObjects([sc.terrain, sc.station, sc.horizon].filter(Boolean), true)[0];
    return hit ? hit.distance : LASER_MAX;
  }
  function makeLaser(parent, name) {
    const laser = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: LASER_COLOUR, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    laser.visible = false; laser.name = name; laser.userData.export = false; laser.frustumCulled = false;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: LASER_COLOUR, fog: false }));
    dot.visible = false; dot.name = `${name} dot`; dot.userData.export = false;
    parent.add(laser); parent.add(dot);
    return { laser, dot };
  }
  function aimLaser(laser, dot, origin, dir, len) {
    laser.visible = true;
    laser.scale.set(1, len, 1);
    laser.position.copy(origin).addScaledVector(dir, len / 2);
    laser.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    dot.visible = true;
    dot.position.copy(origin).addScaledVector(dir, len);
  }

  function remoteSet(key, info) {
    if (!sc.scene || !THREE) return;
    const a0 = avatars.get(key);
    let keep = null;
    if (a0 && (a0.info.hat !== info.hat || a0.info.shirt !== info.shirt || a0.info.pants !== info.pants || a0.info.name !== info.name)) {
      keep = a0.pose;   // a new colour is the same person in the same place
      remoteRemove(key);
    }
    if (avatars.has(key)) return;
    if (avatars.size >= 8) return;   // the presence module caps the figures; this is the belt to its braces
    const group = noExport(makeFigure(info));
    group.name = `visitor ${info.name || ''}`.trim();
    const sprite = makeSign(info.name || 'Visitor', null);
    sprite.scale.multiplyScalar(0.36);
    sprite.position.set(0, 2.05, 0);
    group.add(sprite);
    group.visible = false;   // until a pose lands
    avatarsGroup().add(group);
    const { laser, dot } = makeLaser(avatarsGroup(), 'visitor laser');
    avatars.set(key, { key, group, sprite, shoulder: group.userData.shoulder, laser, dot, info: { ...info },
                       pose: null, shown: null, from: null, to: null, t0: 0, dur: 0, laserLen: 0 });
    if (keep) remotePose(key, keep);
    requestFrame();
  }
  function remoteRemove(key) {
    const a = avatars.get(key);
    if (!a) return;
    avatars.delete(key);
    if (sc.avatars) { sc.avatars.remove(a.group); sc.avatars.remove(a.laser); sc.avatars.remove(a.dot); }
    disposeObject(a.group); disposeObject(a.laser); disposeObject(a.dot);
    requestFrame();
  }
  function remoteClear() { for (const key of [...avatars.keys()]) remoteRemove(key); }

  // Where a visitor's feet are: on the ground, on the grating, on a rung —
  // from their level and climb, never from a published height, because each
  // viewer's ground is exaggerated by their own setting.
  function feetY(pose, x, z) {
    const m = tw.model;
    if (m && m.deck && pose.level === 'deck') return m.deck.top;
    if (m && m.ladder && pose.level === 'ladder') return ladderFootY() + (pose.climb || 0);
    return standY(x, z);
  }
  function remotePose(key, p) {
    const a = avatars.get(key);
    if (!a || !tw.ground) return;
    const now = performance.now();
    a.pose = p;
    const onPatch = p.mode === 'walk' && Math.abs(p.x) <= tw.ground.half && Math.abs(p.z) <= tw.ground.half;
    if (!onPatch) { a.group.visible = false; a.laser.visible = false; a.dot.visible = false; a.to = null; requestFrame(); return; }
    const target = { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch };
    a.from = a.group.visible && a.shown ? { ...a.shown } : { ...target };
    a.dur = a.group.visible ? Math.min(400, Math.max(60, now - a.t0)) : 0;
    a.t0 = now;
    a.to = target;
    a.group.visible = true;
    // The laser's length is measured once per pose, from where the hand will be.
    if (p.point) {
      const dir = lookVec(p.yaw, p.pitch);
      const hand = new THREE.Vector3(p.x, feetY(p, p.x, p.z) + 1.43, p.z)
        .addScaledVector(new THREE.Vector3(Math.cos(p.yaw), 0, Math.sin(p.yaw)), 0.27)
        .addScaledVector(dir, 0.6);
      a.laserLen = laserHit(hand, dir);
    }
    placeAvatar(a, a.from);
    requestFrame();
  }
  function placeAvatar(a, s) {
    const p = a.pose;
    a.group.position.set(s.x, feetY(p, s.x, s.z), s.z);
    a.group.rotation.y = -s.yaw;
    a.shown = { ...s };
    if (p.point) {
      a.shoulder.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, Math.sin(s.pitch), -Math.cos(s.pitch)).normalize());
      a.group.updateMatrixWorld(true);
      const dir = lookVec(s.yaw, s.pitch);
      const hand = new THREE.Vector3();
      a.shoulder.getWorldPosition(hand);
      hand.addScaledVector(dir, 0.6);
      aimLaser(a.laser, a.dot, hand, dir, a.laserLen || LASER_MAX);
    } else {
      a.shoulder.rotation.set(0, 0, -0.12);
      a.laser.visible = false;
      a.dot.visible = false;
    }
  }
  // A frame of walking each visitor toward their latest pose; true while any
  // of them is still on the way, which is what keeps the loop drawing.
  function animateAvatars(now) {
    let moving = false;
    for (const a of avatars.values()) {
      if (!a.to || !a.group.visible) continue;
      const t = a.dur ? Math.min(1, (now - a.t0) / a.dur) : 1;
      const s = a.shown;
      if (t >= 1 && s && s.x === a.to.x && s.z === a.to.z && s.yaw === a.to.yaw && s.pitch === a.to.pitch) continue;
      const dy = Math.atan2(Math.sin(a.to.yaw - a.from.yaw), Math.cos(a.to.yaw - a.from.yaw));
      placeAvatar(a, t >= 1 ? { ...a.to } : {
        x: a.from.x + (a.to.x - a.from.x) * t, z: a.from.z + (a.to.z - a.from.z) * t,
        yaw: a.from.yaw + dy * t, pitch: a.from.pitch + (a.to.pitch - a.from.pitch) * t });
      moving = true;
    }
    return moving;
  }

  // The visitor's own pointer: a laser from beside the eye along the look,
  // while Space is held or the Point button is latched, in the POV.
  function ensureLocalLaser() {
    if (sc.laser || !sc.scene) return;
    const { laser, dot } = makeLaser(sc.scene, 'laser');
    sc.laser = laser; sc.dot = dot;
  }
  function updateLocalLaser() {
    const on = rig.mode === 'walk' && rig.pointing && sc.camera;
    if (!on) { if (sc.laser) { sc.laser.visible = false; sc.dot.visible = false; } return; }
    ensureLocalLaser();
    const dir = lookVec(rig.yaw, rig.pitch);
    const right = new THREE.Vector3(Math.cos(rig.yaw), 0, Math.sin(rig.yaw));
    const origin = sc.camera.position.clone().addScaledVector(right, 0.22).add(new THREE.Vector3(0, -0.18, 0)).addScaledVector(dir, 0.35);
    aimLaser(sc.laser, sc.dot, origin, dir, laserHit(origin, dir));
  }
  function syncPointUi() {
    for (const btn of document.querySelectorAll('#twin-point')) btn.setAttribute('aria-pressed', rig.pointLatch ? 'true' : 'false');
  }
  function setPointing(on) {
    rig.pointLatch = !!on;
    if (on && rig.mode !== 'walk') enterWalk();
    syncPointUi();
    requestFrame();
  }
  function localPose() {
    return { mode: rig.mode, x: rig.px, z: rig.pz, yaw: rig.yaw, pitch: rig.pitch, level: rig.level, climb: rig.climb, point: !!rig.pointing };
  }

  // ── the room ───────────────────────────────────────────────────────────────
  function presenceJoin(st) {
    if (typeof TwinPresence === 'undefined' || !st) return;
    try { TwinPresence.join(st.id); } catch (_) {}
    refreshPeersLine();
  }
  function refreshPeersLine() {
    const el = document.getElementById('twin-peers');
    if (!el) return;
    const html = typeof TwinPresence !== 'undefined' && tw.live && sc.terrain ? TwinPresence.lineHtml() : '';
    el.innerHTML = html;
    el.hidden = !html;
    el.title = el.textContent;
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

  // ── the field photos ───────────────────────────────────────────────────────
  // Where somebody stood with a camera, drawn where they stood: a post at a
  // photographer's chest height with a camera on it, turned the way the camera
  // faced and tilted as it was, a pale wedge the width of its view on the
  // ground ahead of it, and a badge over it saying how many photos were taken
  // there. Photos within a few metres of each other are one spot — one marker,
  // one carousel (field-photos.js decides which, for the twin and the map
  // alike). Click it; or walk up to it in the POV, and Enter opens them.
  //
  // Asked of the database for the patch's box, and only for a signed-in
  // session: field photos are editors-only (0035). The line under the stage
  // lists every spot as a button — the same numbers for whoever cannot see the
  // picture, and the keyboard's way to them. Not in the .glb: the scene there
  // is the site, and a photo's position is not something to hand to a file.
  const PHOTO_POST_H = 1.45;     // metres — where a camera is held
  const PHOTO_NEAR   = 2.5;      // metres — the POV's prompt comes up this close
  const PHOTO_WEDGE  = 2.6;      // metres — how far ahead the view wedge reaches
  const PHOTO_LINE_CAP = 12;     // spots listed by name under the stage

  function photoColours() {
    return { fill: cssVar('--photo', '#ffc400'), ink: cssVar('--photo-ink', '#3a2a00') };
  }
  function compassWord(deg) {
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  function spotWhere(sp) {
    const d = Math.hypot(sp.x, sp.z);
    if (d < 1.5) return 'at the station';
    const brg = (Math.atan2(sp.x, -sp.z) * 180 / Math.PI + 360) % 360;
    return `${d < 100 ? d.toFixed(0) : Math.round(d / 10) * 10} m ${compassWord(brg)}`;
  }

  // The badge: a camera and the count, on a sprite that always faces the eye.
  function makePhotoBadge(n) {
    const { fill, ink } = photoColours();
    const cv = document.createElement('canvas');
    const W = 320, H = 128;
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    const rr = (x, y, w, h, r) => {
      cx.beginPath();
      if (typeof cx.roundRect === 'function') cx.roundRect(x, y, w, h, r); else cx.rect(x, y, w, h);
    };
    cx.fillStyle = 'rgba(16, 32, 42, 0.86)';
    rr(4, 4, W - 8, H - 8, 32); cx.fill();
    cx.fillStyle = fill;
    rr(28, 40, 96, 60, 12); cx.fill();
    cx.fillRect(52, 28, 32, 16);
    cx.fillStyle = ink;
    cx.beginPath(); cx.arc(76, 70, 22, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = fill;
    cx.beginPath(); cx.arc(76, 70, 12, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#ffffff';
    cx.font = '700 66px system-ui, sans-serif';
    cx.textAlign = 'left';
    cx.textBaseline = 'middle';
    cx.fillText(String(n), 146, H / 2 + 3);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.renderOrder = 10;
    sp.name = 'badge';
    sp.userData.base = { w: 0.8, h: 0.32 };
    sp.scale.set(0.8, 0.32, 1);
    return sp;
  }

  // The view, as a flat fan ahead of the lens: `fov` degrees wide, PHOTO_WEDGE
  // long, in the camera head's own frame (forward is −z) so it turns and tilts
  // with it.
  function makeWedge(fovDeg, mat) {
    const half = Math.min(80, Math.max(10, (known(fovDeg) ? fovDeg : 60) / 2)) * Math.PI / 180;
    const n = 12, pos = [0, 0, 0], idx = [];
    for (let i = 0; i <= n; i++) {
      const a = -half + 2 * half * i / n;
      pos.push(Math.sin(a) * PHOTO_WEDGE, 0, -Math.cos(a) * PHOTO_WEDGE);
    }
    for (let i = 1; i <= n; i++) idx.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const w = new THREE.Mesh(geo, mat);
    w.name = 'view';
    w.position.z = -0.12;
    return w;
  }

  function removePhotoMarkers() {
    if (sc.photos && sc.scene) { sc.scene.remove(sc.photos); disposeObject(sc.photos); }
    sc.photos = null;
  }

  function buildPhotoMarkers() {
    removePhotoMarkers();
    const P = tw.photos;
    if (!P || !P.spots.length || !sc.scene || !THREE) return;
    const { fill, ink } = photoColours();
    const g = new THREE.Group();
    g.name = 'field photos';
    const postMat  = new THREE.MeshStandardMaterial({ color: ink, roughness: 0.7 });
    const bodyMat  = new THREE.MeshStandardMaterial({ color: fill, roughness: 0.45, metalness: 0.05 });
    const lensMat  = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    const wedgeMat = new THREE.MeshBasicMaterial({ color: fill, transparent: true, opacity: 0.3,
                                                   side: THREE.DoubleSide, depthWrite: false });
    P.spots.forEach((sp, k) => {
      const m = new THREE.Group();
      m.name = `photo spot ${k + 1}`;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, PHOTO_POST_H, 10), postMat);
      post.name = 'post';
      post.position.y = PHOTO_POST_H / 2;
      m.add(post);
      const head = new THREE.Group();
      head.name = 'camera';
      head.rotation.order = 'YXZ';
      head.position.y = PHOTO_POST_H + 0.08;
      // Forward is −z; a heading h clockwise from north is (sin h, 0, −cos h)
      // in this scene's x-east, z-south frame, which a turn of −h about y gives.
      if (known(sp.heading)) head.rotation.y = -sp.heading * Math.PI / 180;
      if (known(sp.pitch)) head.rotation.x = Math.max(-85, Math.min(85, sp.pitch)) * Math.PI / 180;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.15, 0.1), bodyMat);
      body.name = 'body';
      head.add(body);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.07, 16), lensMat);
      lens.name = 'lens';
      lens.rotation.x = Math.PI / 2;
      lens.position.z = -0.085;
      head.add(lens);
      m.add(head);
      // A wedge for every way the camera faced from here, each at the camera's
      // height and turned and tilted as that photo was — the head itself faces
      // the first.
      for (const view of (sp.views && sp.views.length ? sp.views : [])) {
        const w = new THREE.Group();
        w.name = 'view';
        w.rotation.order = 'YXZ';
        w.position.y = PHOTO_POST_H + 0.08;
        w.rotation.y = -view.heading * Math.PI / 180;
        if (known(view.pitch)) w.rotation.x = Math.max(-85, Math.min(85, view.pitch)) * Math.PI / 180;
        w.add(makeWedge(view.fov, wedgeMat));
        m.add(w);
      }
      const badge = makePhotoBadge(sp.rows.length);
      badge.position.y = PHOTO_POST_H + 0.6;
      m.add(badge);
      m.userData.badge = badge;
      m.traverse(o => { o.userData.photoSpot = k; o.userData.export = false; });
      g.add(m);
    });
    sc.photos = g;
    sc.scene.add(g);
    placePhotoMarkers();
  }

  // Feet on the ground where each spot is — the ground as drawn, so the
  // exaggeration slider moves them with it.
  function placePhotoMarkers() {
    const P = tw.photos;
    if (!sc.photos || !P) return;
    sc.photos.children.forEach((m, k) => {
      const sp = P.spots[k];
      if (sp) m.position.set(sp.x, yAt(sp.x, sp.z), sp.z);
    });
    requestFrame();
  }

  // A badge a few pixels across from the far side of a 1.6 km patch is a
  // badge nobody finds, so past fourteen metres it grows with the distance
  // and stays about one size on screen.
  function scalePhotoBadges() {
    if (!sc.photos || !sc.camera) return;
    const p = new THREE.Vector3();
    for (const m of sc.photos.children) {
      const b = m.userData.badge;
      if (!b) continue;
      b.getWorldPosition(p);
      const s = Math.max(1, sc.camera.position.distanceTo(p) / 14);
      b.scale.set(b.userData.base.w * s, b.userData.base.h * s, 1);
    }
  }

  function loadPhotos(st, seq) {
    if (typeof FieldPhotos === 'undefined' || !st || !tw.ground) return;
    tw.photoNear = -1;
    if (!FieldPhotos.signedIn()) {
      tw.photos = { status: 'signed-out', spots: [], count: 0 };
      removePhotoMarkers();
      refreshPhotosLine();
      syncPhotoPrompt();
      return;
    }
    tw.photos = Object.assign({ spots: [], count: 0 }, tw.photos && tw.photos.status === 'ok' ? tw.photos : {}, { status: 'loading' });
    refreshPhotosLine();
    const g = tw.ground;
    FieldPhotos.inBox(patchBox(st.lat, st.lon, g.size)).then(rows => {
      if (seq !== tw.seq || !tw.ground) return;
      const half = tw.ground.half;
      const spots = FieldPhotos.spots(rows)
        .map(sp => Object.assign(sp, localXZ(sp.lat, sp.lon, st.lat, st.lon)))
        .filter(sp => Math.abs(sp.x) <= half - 0.3 && Math.abs(sp.z) <= half - 0.3);
      tw.photos = { status: 'ok', spots, count: spots.reduce((n, sp) => n + sp.rows.length, 0) };
      buildPhotoMarkers();
      refreshPhotosLine();
      applyPhotoFocus();
      tw.photoNear = -2;           // re-measured on the next frame
      requestFrame();
    }, err => {
      if (seq !== tw.seq) return;
      const msg = (err && err.message) || String(err);
      tw.photos = { status: 'error', spots: [], count: 0,
                    error: /field_photo/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg)
                      ? 'this database has no field photos table yet (0035 is not applied)' : msg };
      removePhotoMarkers();
      refreshPhotosLine();
    });
  }

  function photosLineHtml(full = false) {
    if (typeof FieldPhotos === 'undefined' || !tw.ground) return '';
    const P = tw.photos;
    const lead = n => `<span class="twin-photos-lead"><span aria-hidden="true">📷</span> Field photos${n ? ` (${n})` : ''}:</span>`;
    if (!P) return '';
    // Inside the Stations map the overlay is a phone's 340 px of map, and a
    // line that only says there is nothing here — or to sign in — is a line
    // of stage given up for no photo. There it is shown when there are photos
    // to list; the 🧊 pane (`full`) says the rest.
    if (tw.hooks && !full && !(P.spots && P.spots.length)) return '';
    if (P.status === 'signed-out') return `${lead()} <button type="button" class="link-btn" onclick="Auth.open()">sign in</button> to see the photos taken here.`;
    if (P.status === 'loading' && !P.spots.length) return `${lead()} looking…`;
    if (P.status === 'error') return `${lead()} could not be read — ${esc(P.error)}.`;
    if (!P.spots.length) return `${lead()} none taken in this patch yet. <button type="button" class="link-btn" onclick="switchTab('photos')">Add some →</button>`;
    const shown = P.spots.slice(0, PHOTO_LINE_CAP).map((sp, k) =>
      `<button type="button" class="link-btn twin-photo" onclick="DigitalTwin.openPhotoSpot(${k})"
               title="Open the photos taken here">${sp.rows.length} ${spotWhere(sp)}</button>`);
    const more = P.spots.length > PHOTO_LINE_CAP ? ` · and ${P.spots.length - PHOTO_LINE_CAP} more spots` : '';
    const all = P.spots.length > 1 ? ` · <button type="button" class="link-btn" onclick="DigitalTwin.openAllPhotos()">all ${P.count}</button>` : '';
    return `${lead(P.count)} ${shown.join(' · ')}${more}${all}`;
  }

  function refreshPhotosLine() {
    const el = document.getElementById('twin-photos');
    if (el) {
      const html = photosLineHtml();
      el.innerHTML = html;
      el.hidden = !html;
      el.title = el.textContent.replace(/\s+/g, ' ').trim();
    }
    // …and the whole of it in the side panel's pane, where there is room.
    const pane = document.getElementById('twin-pane-photos');
    if (pane) {
      const html = tw.live ? photosLineHtml(true) : '';
      pane.innerHTML = html;
      pane.hidden = !html;
    }
  }

  // Which spot the POV visitor is standing at, if any — the prompt over the
  // stage, and what Enter opens. True when it changed.
  function updatePhotoNear() {
    const P = tw.photos;
    let near = -1;
    if (rig.mode === 'walk' && rig.level === 'ground' && P && P.spots.length) {
      let bd = PHOTO_NEAR;
      P.spots.forEach((sp, k) => {
        const d = Math.hypot(sp.x - rig.px, sp.z - rig.pz);
        if (d < bd) { bd = d; near = k; }
      });
    }
    if (near === tw.photoNear) return false;
    tw.photoNear = near;
    syncPhotoPrompt();
    return true;
  }
  function syncPhotoPrompt() {
    const el = document.getElementById('twin-photo-prompt');
    if (!el) return;
    const sp = tw.photos && tw.photoNear >= 0 ? tw.photos.spots[tw.photoNear] : null;
    el.hidden = !sp;
    if (sp) {
      const n = sp.rows.length;
      el.textContent = `📷 ${n} photo${n === 1 ? '' : 's'} taken here — Enter to look`;
    }
  }

  // The spot under the pointer: a badge wherever it is (it is drawn over the
  // hills, so it is clicked over them), a post or a camera only where the
  // ground is not in front of it. Never the wedge — it covers ground people
  // click for its height.
  function photoAt(clientX, clientY) {
    if (!sc.photos || !sc.camera || !sc.canvas) return -1;
    const r = sc.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(nd, sc.camera);
    const ground = sc.terrain ? rc.intersectObject(sc.terrain, false)[0] : null;
    const hits = rc.intersectObject(sc.photos, true)
      .filter(h => h.object.userData.photoSpot != null && h.object.name !== 'view'
                && (h.object.isSprite || !ground || h.distance <= ground.distance + 0.05));
    return hits.length ? hits[0].object.userData.photoSpot : -1;
  }

  function pickPhoto(e) {
    const k = photoAt(e.clientX, e.clientY);
    if (k < 0) return false;
    openPhotoSpot(k);
    return true;
  }

  function openPhotoSpot(k) {
    const P = tw.photos;
    const sp = P && P.spots[k];
    if (!sp || typeof FieldPhotos === 'undefined') return;
    const st = currentStation();
    const where = spotWhere(sp);
    // In the viewer's compass order, from the first (FieldPhotos.openSpot).
    FieldPhotos.openSpot(sp.ids, null,
      `Photos taken ${where === 'at the station' ? 'at ' : `${where} of `}${st ? st.name : 'the station'}`);
  }

  function openAllPhotos() {
    const P = tw.photos;
    if (!P || !P.spots.length || typeof FieldPhotos === 'undefined') return;
    const st = currentStation();
    const ids = P.spots.flatMap(sp => sp.ids);
    FieldPhotos.openSpot(ids, null, `Photos around ${st ? st.name : 'the station'}`);
  }

  // From the viewer's "In the twin": once the markers are up, stand the orbit
  // camera behind that photo's camera, looking the way it looked.
  function applyPhotoFocus() {
    const id = tw.focusPhotoId;
    const P = tw.photos;
    if (!id || !P || !rig.target) return;
    const k = P.spots.findIndex(sp => sp.ids.includes(id));
    if (k < 0) return;
    tw.focusPhotoId = null;
    const sp = P.spots[k];
    // That photo's own heading, not the spot's first: two taken from here up
    // the reach and down it are one spot, and "In the twin" on the second
    // has to look down it.
    const row = sp.rows.find(r => r.id === id);
    const h = row && known(row.heading_deg) ? +row.heading_deg : sp.heading;
    rig.mode = 'orbit';
    rig.target.set(sp.x, yAt(sp.x, sp.z) + PHOTO_POST_H, sp.z);
    rig.radius = 7;
    rig.phi = 1.2;
    rig.theta = known(h) ? -h * Math.PI / 180 : rig.theta;
    syncModeUi();
    requestFrame();
  }

  // ── the neighbours ─────────────────────────────────────────────────────────
  // Other stations whose positions fall inside the patch — a river gauge and
  // the rain gauge beside it, a repeater on the ridge above a town — are
  // built too, by the same rules as the one at the centre (stationKind,
  // makeStation), each standing on the ground where the record puts it with
  // its name over it. The nearest NEIGHBOUR_CAP, which a 1.6 km patch in a
  // town can reach; the line under the stage says if more were left out.
  // Their enclosure doors open as the POV visitor walks up, as the centre's
  // do; a tower's deck is climbed only at the centre, so a neighbour tower's
  // deck doors are not hung. Each name is a button on the line under the
  // stage that goes to that station's own twin, as a radio path's far end
  // does. In the .glb, like the station at the centre: they are the site.
  const NEIGHBOUR_CAP = 40;

  function removeNeighbours() {
    if (sc.neighbours && sc.scene) { sc.scene.remove(sc.neighbours); disposeObject(sc.neighbours); }
    sc.neighbours = null;
    tw.neighbours = null;
  }

  function neighboursOf(st) {
    const g = tw.ground, o = tw.origin;
    if (!g || !o || !st || !state.data) return { list: [], more: 0 };
    const all = [];
    for (const s of state.data.stations) {
      if (s.id === st.id || !located(s)) continue;
      const p = localXZ(Number(s.lat), Number(s.lon), o.lat, o.lon);
      if (Math.abs(p.x) > g.half || Math.abs(p.z) > g.half) continue;
      all.push({ s, x: p.x, z: p.z, d: Math.hypot(p.x, p.z) });
    }
    all.sort((a, b) => a.d - b.d);
    return { list: all.slice(0, NEIGHBOUR_CAP), more: Math.max(0, all.length - NEIGHBOUR_CAP) };
  }

  function buildNeighbours(st) {
    removeNeighbours();
    const { list, more } = neighboursOf(st);
    tw.neighbours = { list: [], more };
    if (!list.length || !sc.scene) { refreshSiteLine(); return; }
    const grp = new THREE.Group();
    grp.name = 'neighbours';
    const k = kitMaterials();
    const keep = { pole: sc.pole, band: sc.band };
    for (const n of list) {
      const kind = stationKind(n.s);
      const before = sc.doors.length;
      const nt = turnOf(facingNow(n.s));
      const built = makeStation(n.s, kind, k, (x, z) => { const w = toWorld(x, z, nt); return yAt(n.x + w.x, n.z + w.z) - yAt(n.x, n.z); });
      built.group.rotation.y = -nt;
      if (built.staff) setTowerStaff(built.staff, n.s, heightAt(n.x, n.z));
      sc.doors = sc.doors.filter((d, i) => i < before || d.when !== 'deck');
      built.group.name = `station ${n.s.name || n.s.id}`;
      built.group.userData.neighbour = n.s.id;
      grp.add(built.group);
      const sign = makeSign(n.s.name || n.s.id, n.s.station_number ? String(n.s.station_number) : null);
      sign.userData.neighbourSign = n.s.id;
      sign.userData.top = built.top;
      // A sign 3 m wide 400 m off is a speck: scaled with its distance, as a
      // radio path's far-end sign is.
      const kk = Math.max(1, n.d / 60);
      sign.scale.multiplyScalar(kk);
      sign.userData.lift = 0.75 * kk;
      sign.visible = !!S().label;
      grp.add(sign);
      tw.neighbours.list.push({ id: n.s.id, name: n.s.name || n.s.id, x: n.x, z: n.z, d: n.d,
                                bearing: (Math.atan2(n.x, -n.z) * 180 / Math.PI + 360) % 360,
                                structure: kind.structure, top: built.top, group: built.group, sign });
    }
    sc.pole = keep.pole; sc.band = keep.band;
    sc.neighbours = grp;
    sc.scene.add(grp);
    placeNeighbours();
    refreshSiteLine();
  }

  // On the ground as drawn: the exaggeration lifts the ground under them.
  function placeNeighbours() {
    if (!tw.neighbours) return;
    for (const n of tw.neighbours.list) {
      const y = yAt(n.x, n.z);
      n.group.position.set(n.x, y, n.z);
      n.sign.position.set(n.x, y + n.top + n.sign.userData.lift, n.z);
    }
    requestFrame();
  }

  // ── the crossings ──────────────────────────────────────────────────────────
  // The ground this tab stands on is bare earth — a LiDAR DTM is made by
  // taking the bridges out — so a road bridge over a creek is, here, a road
  // that dives into the creek and climbs the far bank, and the imagery draped
  // on that ground dives with it. So each bridge in the patch is built as a
  // deck across the gap, with the imagery of the road on its top, girders
  // under it, rails along it and piers down to the bed.
  //
  // Where the bridges are: Queensland's own road network — the "Bridges" layer
  // of RoadsAndTracks, polylines the length of each span, and the railway
  // bridges of OtherTransport — asked for the patch's box, from the same
  // State that serves the ground (CORS reflects any origin). Outside the
  // State, and where it cannot be reached, OpenStreetMap's bridge ways through
  // Overpass (the endpoints map-rivers.js asks). Neither answering leaves the
  // ground as it is and says so; no deck is ever guessed at.
  //
  // How high the deck is:
  //   * **The crossing the gauge is read against**, where the Bureau lists one
  //     (the river height station lists' crossings, 0031: a height on the
  //     gauge for a Bridge, Old Bridge or Highway crossing) and the gauge's
  //     zero is surveyed in AHD: that height, in AHD, on the bridge nearest
  //     the gauge within CROSSING_REACH — level from end to end. It is the
  //     height the Bureau says the crossing goes under at, which is to say
  //     the deck. The flood water, rising, covers it there.
  //   * **Otherwise the banks**: the ground at each end of the span, a few
  //     metres out along the road where the approach meets the abutment
  //     (the higher of the end and that point), and a straight deck between
  //     the two. The bank is the approach road, and the approach road is the
  //     deck's level at each end.
  //
  // The widths are not in either source: a road bridge is drawn 8 m across
  // (two lanes and their shoulders), a railway's 5 m, a track's 4 m. Piers
  // every ~15 m where the deck stands more than 1.5 m over the ground.
  const QLD_GIS = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services';
  const QLD_BRIDGES = [
    { url: `${QLD_GIS}/Transportation/RoadsAndTracks/MapServer/22/query`, kind: 'road' },
    { url: `${QLD_GIS}/Transportation/OtherTransport/MapServer/160/query`, kind: 'rail' },
  ];
  const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const CROSSING_REACH = 250;   // metres from the gauge the listed crossing may be
  const BRIDGE_TYPES = new Set(['B', 'O', 'H']);   // Bridge, Old Bridge, Highway (0031's legend)
  const DECK_THICK = 0.8;       // the deck and its girders
  const BRIDGE_W = { road: 8, rail: 5, track: 4 };
  const bridgeCache = new Map();   // boxKey → Promise<{ list, source, failed }>

  // Bridges are looked for past the patch's edge, not only inside it. A bridge
  // that runs out of the patch, or stands just beyond it, used to be clipped
  // or never asked for: Gatton's Smithfield Road Bridge is 4–20 m past the
  // edge of a patch centred on a station 194 m from the gauge, so that twin
  // had the road diving into the creek where the bridge should be. So the
  // State is asked over the patch grown by BRIDGE_EDGE of its width (30 m at
  // least), and where a bridge that far out could be held whole by a slightly
  // wider patch, the patch is widened to hold it — by 20 m steps, never past
  // BRIDGE_FIT_MAX times the size asked for, never past the widest offered.
  const BRIDGE_EDGE = 0.15;
  const BRIDGE_PAD = 8;         // metres of ground kept beyond a held bridge's far end: the approach its deck lands on
  const BRIDGE_FIT_STEP = 20;
  const BRIDGE_FIT_MAX = 1.5;
  const BRIDGE_FIT_WAIT = 4000; // ms the build waits to hear where the bridges are before standing the patch it was asked for
  const LEND_REACH = 600;       // metres: another station's listed crossing is used within this of the patch's centre
  const MERGE_LATERAL = 6;      // metres: two spans of one kind this close side by side are one bridge drawn twice

  function edgeMargin(size) { return Math.max(30, Math.round(size * BRIDGE_EDGE)); }
  function bridgeQueryBox(lat, lon, size) { return patchBox(lat, lon, size + 2 * edgeMargin(size)); }

  function removeBridges() {
    if (sc.bridges && sc.scene) { sc.scene.remove(sc.bridges); disposeObject(sc.bridges); }
    sc.bridges = null;
  }

  // Each layer is asked with the one retry the ground and the imagery get: a
  // service that drops one request looks, from here, exactly like a place with
  // no bridges.
  function qldBridges(box) {
    const env = `${box.west},${box.south},${box.east},${box.north}`;
    return Promise.all(QLD_BRIDGES.map(src => {
      const q = new URLSearchParams({
        geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json',
      });
      return once(() => fetchBytes(`${src.url}?${q}`).then(buf => {
        const j = JSON.parse(new TextDecoder().decode(buf));
        if (j.error) throw new Error(j.error.message || 'the service refused the query');
        return (j.features || []).flatMap(f => ((f.geometry && f.geometry.paths) || []).map(path => ({
          kind: src.kind === 'rail' ? 'rail' : /track/i.test(String((f.attributes || {}).feature_type || '')) ? 'track' : 'road',
          name: (f.attributes && (f.attributes.name || null)) || null,
          length_m: f.attributes && isFinite(f.attributes.dimension_m) ? Number(f.attributes.dimension_m) : null,
          points: path.map(p => [p[1], p[0]]),
        })));
      }));
    })).then(parts => ({ list: parts.flat(), source: 'qld' }));
  }

  function osmBridges(box) {
    const b = `${box.south},${box.west},${box.north},${box.east}`;
    const ql = `[out:json][timeout:20];(way["bridge"]["highway"](${b});way["bridge"]["railway"](${b}););out geom tags;`;
    const tryAt = i => {
      if (i >= OVERPASS_URLS.length) return Promise.reject(new Error('no Overpass endpoint answered'));
      return fetch(OVERPASS_URLS[i], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                       body: 'data=' + encodeURIComponent(ql) })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .catch(() => tryAt(i + 1));
    };
    return tryAt(0).then(j => ({
      source: 'osm',
      list: ((j && j.elements) || []).filter(e => Array.isArray(e.geometry) && e.geometry.length > 1).map(e => {
        const t = e.tags || {};
        const lanes = Number(t.lanes);
        const width = Number(String(t.width || '').replace(/[^\d.]/g, ''));
        return {
          kind: t.railway ? 'rail' : /track|path|footway|cycleway/.test(t.highway || '') ? 'track' : 'road',
          name: t.name || t.ref || null, length_m: null,
          width_m: isFinite(width) && width > 2 ? width : isFinite(lanes) && lanes > 0 ? lanes * 3.5 + 1.5 : null,
          points: e.geometry.map(p => [p.lat, p.lon]),
        };
      }),
    }));
  }

  function bridgesFor(box) {
    const key = boxKey(box);
    if (bridgeCache.has(key)) return bridgeCache.get(key);
    const p = (insideBox(box, QLD_DEM_BOX) ? qldBridges(box).catch(() => osmBridges(box)) : osmBridges(box))
      .catch(err => ({ list: [], source: null, failed: (err && err.message) || 'unreachable' }));
    bridgeCache.set(key, p);
    p.then(r => { if (r.failed) bridgeCache.delete(key); });
    return p;
  }

  // The crossing the gauge is read against, in AHD, where the record can say.
  function listedCrossing(st) {
    if (!st || typeof FloodStages === 'undefined') return null;
    const lad = FloodStages.ladder(st);
    if (lad.ahdZero == null) return null;
    const rows = [];
    for (const c of (st.crossings || [])) {
      if (c && BRIDGE_TYPES.has(String(c.crossing_type || '').trim()) && isFinite(Number(c.height_m)) && c.height_m !== null && c.height_m !== '') {
        rows.push({ height: Number(c.height_m), type: c.crossing_type, name: c.name || null, as_at: c.as_at || '' });
      }
    }
    for (const c of (st.flood_classes || [])) {
      if (c && BRIDGE_TYPES.has(String(c.crossing_type || '').trim()) && c.crossing_height_m != null && isFinite(Number(c.crossing_height_m))) {
        rows.push({ height: Number(c.crossing_height_m), type: c.crossing_type, name: null, as_at: c.as_at || '' });
      }
    }
    if (!rows.length) return null;
    rows.sort((a, b) => (a.as_at < b.as_at ? 1 : a.as_at > b.as_at ? -1 : 0));
    const r = rows[0];
    return { ...r, ahd: lad.ahdZero + r.height, zero: lad.ahdZero };
  }

  // A bridge's centreline in the patch's metres, densified to ~2 m, with the
  // distance along it — clipped to the patch (a span running out of it is
  // drawn to its edge).
  // The whole span, patch or no patch, in metres from (lat0, lon0).
  function spanMetres(points, lat0, lon0) {
    const raw = points.map(p => localXZ(p[0], p[1], lat0, lon0));
    const out = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      // 60 m is thirty steps of 2 m, not thirty-one of 1.94 because the
      // degrees came back a nanometre long.
      const n = Math.max(1, Math.ceil(L / 2 - 1e-6));
      for (let j = (i ? 1 : 0); j <= n; j++) out.push({ x: a.x + (b.x - a.x) * j / n, z: a.z + (b.z - a.z) * j / n });
    }
    let s = 0;
    for (let i = 0; i < out.length; i++) {
      if (i) s += Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
      out[i].s = s;
    }
    return out;
  }

  // The part in the patch, with the distance along it from its own first point.
  function clipToPatch(all) {
    const g = tw.ground;
    const inside = all.filter(p => Math.abs(p.x) <= g.half && Math.abs(p.z) <= g.half).map(p => ({ x: p.x, z: p.z }));
    let s = 0;
    for (let i = 0; i < inside.length; i++) {
      if (i) s += Math.hypot(inside[i].x - inside[i - 1].x, inside[i].z - inside[i - 1].z);
      inside[i].s = s;
    }
    return inside;
  }

  // Two features of one kind running side by side within MERGE_LATERAL of one
  // another for most of their length are one bridge digitised twice — the
  // State's Gatton railway bridge is two 124 m polylines 3–4 m apart with the
  // one persistent id. Drawn as two, their decks overlap at nearly one height
  // and the imagery on them shimmers, and each has its own rails. Merged: the
  // centreline halfway between, wide enough to cover both.
  function mergeParallel(items) {
    const out = [];
    const nearest = (p, poly) => {
      let best = null, bd = Infinity;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
        const q = { x: a.x + t * dx, z: a.z + t * dz }, d = Math.hypot(p.x - q.x, p.z - q.z);
        if (d < bd) { bd = d; best = q; }
      }
      return { q: best || poly[0], d: bd };
    };
    for (const it of items.slice().sort((a, b) => b.all[b.all.length - 1].s - a.all[a.all.length - 1].s)) {
      const host = out.find(h => {
        if (h.b.kind !== it.b.kind) return false;
        const ds = it.all.filter((_, i) => i % 2 === 0).map(p => nearest(p, h.all).d);
        return ds.filter(d => d <= MERGE_LATERAL).length >= 0.8 * ds.length;
      });
      if (!host) { out.push({ ...it, merged: 0, lateral: 0 }); continue; }
      // The host's centreline moves halfway to the other's.
      let sum = 0;
      host.all = host.all.map(p => {
        const n = nearest(p, it.all);
        sum += n.d;
        return { x: (p.x + n.q.x) / 2, z: (p.z + n.q.z) / 2, s: p.s };
      });
      host.lateral = Math.max(host.lateral, sum / host.all.length);
      host.merged++;
    }
    return out;
  }

  // The bank at one end of a span: the ground at the end and a few metres on
  // along the road, the higher of the two (AHD).
  function bankAt(end, next) {
    const dx = end.x - next.x, dz = end.z - next.z, L = Math.hypot(dx, dz) || 1;
    const out = { x: end.x + dx / L * 4, z: end.z + dz / L * 4 };
    return Math.max(heightAt(end.x, end.z), heightAt(out.x, out.z));
  }

  // One bridge's deck, girders, rails and piers, from its centreline and its
  // deck level at each point (AHD). The deck's top wears the patch's own
  // imagery, mapped as the ground's is, so the road on it is the road the
  // aerial photograph saw.
  function makeBridge(pts, deckAt, width, kind, name) {
    const g = tw.ground, exag = S().exag;
    const grp = new THREE.Group();
    grp.name = `bridge${name ? ` ${name}` : ''}`;
    const half = width / 2;
    const top = [], bot = [], uv = [];
    const side = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;   // across the road
      const y = (deckAt(i) - g.h0) * exag;
      side.push({ nx, nz, y });
      for (const sgn of [-1, 1]) {
        const x = pts[i].x + nx * half * sgn, z = pts[i].z + nz * half * sgn;
        top.push(x, y, z);
        bot.push(x, y - DECK_THICK, z);
        uv.push((x + g.half) / g.size, (g.half - z) / g.size);
      }
    }
    const n = pts.length;
    const quad = (idx, a, b, c, d) => { idx.push(a, b, c, a, c, d); };
    // The top: the imagery, where there is imagery.
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(top, 3));
    tg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const ti = [];
    for (let i = 0; i < n - 1; i++) quad(ti, 2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1);
    tg.setIndex(ti);
    tg.computeVertexNormals();
    const deckMat = new THREE.MeshStandardMaterial({ color: sc.texture && S().imagery ? 0xffffff : 0x6f7378, roughness: 0.9,
                                                     map: sc.texture && S().imagery ? sc.texture : null, side: THREE.DoubleSide });
    const deck = new THREE.Mesh(tg, deckMat);
    deck.name = 'bridge deck';
    deck.castShadow = true; deck.receiveShadow = true;
    deck.userData.deckMap = true;
    grp.add(deck);
    // The girders: the two sides and the soffit, concrete.
    const sg = new THREE.BufferGeometry();
    const pos = [];
    for (let i = 0; i < n; i++) pos.push(...top.slice(6 * i, 6 * i + 6), ...bot.slice(6 * i, 6 * i + 6));
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const si = [];
    for (let i = 0; i < n - 1; i++) {
      const A = 4 * i, B = 4 * (i + 1);
      quad(si, A, A + 2, B + 2, B);           // one side: top-left, bottom-left
      quad(si, A + 1, B + 1, B + 3, A + 3);   // the other
      quad(si, A + 2, A + 3, B + 3, B + 2);   // the soffit
    }
    sg.setIndex(si);
    sg.computeVertexNormals();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9c9b95, roughness: 0.95, side: THREE.DoubleSide });
    const girders = new THREE.Mesh(sg, concrete);
    girders.name = 'bridge girders';
    girders.castShadow = true;
    grp.add(girders);
    // Rails along both edges, a metre up (a track bridge's are timber-low).
    const railH = kind === 'track' ? 0.6 : 1.0;
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.6, roughness: 0.4 });
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const sa = side[i], sb = side[i + 1];
        const ax = a.x + sa.nx * half * sgn, az = a.z + sa.nz * half * sgn;
        const bx = b.x + sb.nx * half * sgn, bz = b.z + sb.nz * half * sgn;
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-6) continue;
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, railH, L), railMat);
        rail.position.set((ax + bx) / 2, (sa.y + sb.y) / 2 + railH / 2, (az + bz) / 2);
        rail.rotation.y = Math.atan2(bx - ax, bz - az);
        rail.name = 'bridge rail';
        grp.add(rail);
      }
    }
    // Piers, where there is room under the deck for one.
    const span = pts[n - 1].s;
    const count = Math.floor(span / 15);
    for (let k = 1; k <= count; k++) {
      const want = span * k / (count + 1);
      let i = 0;
      while (i < n - 1 && pts[i + 1].s < want) i++;
      const p = pts[i], sd = side[i];
      const ground = yAt(p.x, p.z);
      const h = sd.y - DECK_THICK - ground;
      if (h < 1.5) continue;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(width * 0.7, h, 0.8), concrete);
      pier.position.set(p.x, ground + h / 2, p.z);
      pier.rotation.y = Math.atan2(-sd.nz, sd.nx);   // its long side across the road
      pier.name = 'bridge pier';
      pier.castShadow = true;
      grp.add(pier);
    }
    return grp;
  }

  // How wide a patch must be to hold the bridges round a station, from what
  // the State said (pure: no scene needed). Only a bridge that runs to the
  // patch's edge or stands within the margin past it counts, only one that a
  // patch no wider than BRIDGE_FIT_MAX times the size asked for could hold
  // whole; a longer one stays clipped and is said so.
  function fitBridges(found, lat0, lon0, size0) {
    const half0 = size0 / 2, margin = edgeMargin(size0);
    const maxSize = Math.min(SIZES[SIZES.length - 1], size0 * BRIDGE_FIT_MAX);
    let need = half0, held = 0, tooLong = 0;
    for (const b of (found && found.list) || []) {
      const pts = spanMetres(b.points, lat0, lon0);
      if (pts.length < 2) continue;
      let lo = Infinity, hi = 0;
      for (const p of pts) { const e = Math.max(Math.abs(p.x), Math.abs(p.z)); lo = Math.min(lo, e); hi = Math.max(hi, e); }
      if (lo > half0 + margin || hi + 4 <= half0) continue;   // out of reach, or already whole in the patch
      const want = hi + BRIDGE_PAD;
      if (want * 2 > maxSize) { tooLong++; continue; }
      need = Math.max(need, want); held++;
    }
    let size = size0;
    if (need > half0) size = Math.min(maxSize, Math.max(size0, Math.ceil(need * 2 / BRIDGE_FIT_STEP) * BRIDGE_FIT_STEP));
    return { size, size0, widened: size > size0, held, tooLong };
  }

  // The crossings the Bureau lists that bear on this patch: this station's
  // own, then those of gauges beside it. A crossing is a height of a named
  // bridge on a gauge, and the gauge's surveyed zero makes it a level (AHD):
  // the bridge is the same bridge whichever gauge reads it, so a proposed
  // station beside Gatton stands the Smithfield Road Bridge at Gatton's 3.90 m
  // rather than at its banks. Each one says whose it is.
  function crossingSources(st, o) {
    const out = [];
    const own = listedCrossing(st);
    if (own) out.push({ ...own, x: 0, z: 0, d: 0, from: { id: st.id, name: st.name, own: true } });
    const lenders = [];
    for (const s of (state.data && state.data.stations) || []) {
      if (!s || s.id === st.id || !located(s)) continue;
      const p = localXZ(s.lat, s.lon, o.lat, o.lon), d = Math.hypot(p.x, p.z);
      if (d > LEND_REACH) continue;
      const c = listedCrossing(s);
      if (c) lenders.push({ ...c, x: p.x, z: p.z, d, from: { id: s.id, name: s.name, number: s.station_number || null, own: false } });
    }
    lenders.sort((a, b) => a.d - b.d);
    return out.concat(lenders);
  }

  // Which span a crossing goes on: the road bridge nearest the gauge within
  // CROSSING_REACH, else a track's, and a railway's only if nothing else is in
  // reach or the crossing is named for the railway. (It used to be the nearest
  // span of any kind, and at Gatton that was the railway bridge 6 m from the
  // gauge — which stood at the road bridge's level, 14 m under the rails.)
  function pickCarrier(c, cands, taken) {
    const named = /rail/i.test(c.name || '');
    // Only the gauge's own listing may fall back to a railway: a crossing lent by
    // another gauge is put on a road or track bridge or on nothing.
    const strict = !c.from.own && !named;
    const rank = k => (named ? (k === 'rail' ? 0 : 1) : (k === 'road' ? 0 : k === 'track' ? 1 : 2));
    let best = null;
    for (const sp of cands) {
      if (taken.has(sp)) continue;
      let d = Infinity;
      for (const p of sp.all) d = Math.min(d, Math.hypot(p.x - c.x, p.z - c.z));
      if (d > CROSSING_REACH) continue;
      const r = rank(sp.b.kind);
      if (strict && sp.b.kind === 'rail') continue;
      if (!best || r < best.r || (r === best.r && d < best.d)) best = { sp, d, r };
    }
    return best;
  }

  const compassOf = (x, z) => compassWord(((Math.atan2(x, -z) * 180 / Math.PI) + 360) % 360);

  function buildBridges(st, found) {
    removeBridges();
    tw.bridges = { status: 'none', source: found ? found.source : null, list: [], failed: found && found.failed || null, crossing: null, beyond: [], skipped: [] };
    if (!found || !found.list.length || !sc.scene || !tw.ground) { refreshSiteLine(); return []; }
    const g = tw.ground, o = tw.origin;
    const notes = [];
    // Every feature the State returned, whole, and the part of it in the patch.
    let cands = found.list.map(b => ({ b, all: spanMetres(b.points, o.lat, o.lon) })).filter(x => x.all.length >= 2);
    cands = mergeParallel(cands);
    for (const sp of cands) {
      sp.pts = clipToPatch(sp.all);
      sp.drawn = sp.pts.length >= 2 && sp.pts[sp.pts.length - 1].s >= 3;
    }
    // The listed crossings go on their carriers — whether or not the carrier is
    // in the patch, so a road bridge just off it is not passed over for the
    // railway beside it.
    const sources = crossingSources(st, o);
    tw.bridges.crossing = sources.length ? sources[0] : null;
    const taken = new Map();
    for (const c of sources) {
      const pick = pickCarrier(c, cands, new Set(taken.keys()));
      if (!pick) continue;
      const under = pick.sp.drawn ? Math.min(...pick.sp.pts.map(p => heightAt(p.x, p.z))) : -Infinity;
      if (pick.sp.drawn && !(c.ahd > under)) continue;
      taken.set(pick.sp, { c, d: pick.d });
    }
    const grp = new THREE.Group();
    grp.name = 'bridges';
    const half = g.half;
    const inPatch = p => Math.abs(p.x) <= half - 1 && Math.abs(p.z) <= half - 1;
    for (const sp of cands) {
      const nm = sp.b.name || (sp.b.kind === 'rail' ? 'a railway bridge' : 'a bridge');
      if (!sp.drawn) {
        // Not in the patch at all: said, not drawn.
        let best = null;
        for (const p of sp.all) { const e = Math.max(Math.abs(p.x), Math.abs(p.z)); if (!best || e < best.e) best = { e, p }; }
        if (best && best.e <= half + edgeMargin(g.size)) {
          tw.bridges.beyond.push({ name: sp.b.name, kind: sp.b.kind, past: best.e - half, bearing: compassOf(best.p.x, best.p.z), length: sp.all[sp.all.length - 1].s });
        }
        continue;
      }
      const pts = sp.pts, n = pts.length;
      const width = (sp.b.width_m || BRIDGE_W[sp.b.kind] || 8) + (sp.lateral || 0);
      const underMin = Math.min(...pts.map(p => heightAt(p.x, p.z)));
      const aIn = inPatch(sp.all[0]), bIn = inPatch(sp.all[sp.all.length - 1]);
      const cx = taken.get(sp);
      let basis, deckAt;
      if (cx) {
        basis = 'crossing';
        deckAt = () => cx.c.ahd;
      } else if (aIn && bIn) {
        basis = 'banks';
        const hA = bankAt(pts[0], pts[1]), hB = bankAt(pts[n - 1], pts[n - 2]);
        const S0 = pts[n - 1].s || 1;
        deckAt = i => hA + (hB - hA) * pts[i].s / S0;
      } else if (aIn || bIn) {
        // Runs out of the patch. The bank at the end that is in it is known;
        // the far one is not, and the bare ground at the edge is a creek bed
        // as often as a bank. Level from the known bank.
        basis = 'one bank';
        const h = aIn ? bankAt(pts[0], pts[1]) : bankAt(pts[n - 1], pts[n - 2]);
        deckAt = () => h;
      } else {
        // Passes through with both ends out of the patch: nothing says how high.
        tw.bridges.skipped.push({ name: sp.b.name, kind: sp.b.kind });
        continue;
      }
      grp.add(makeBridge(pts, deckAt, width, sp.b.kind, sp.b.name));
      tw.bridges.list.push({
        name: sp.b.name, kind: sp.b.kind, width, basis, length: pts[n - 1].s, cut: !(aIn && bIn), merged: sp.merged || 0,
        deck: [deckAt(0), deckAt(n - 1)], under: underMin, near: cx ? cx.d : null,
        crossing: cx ? { height: cx.c.height, name: cx.c.name, ahd: cx.c.ahd, from: cx.c.from } : null,
        ends: [{ x: pts[0].x, z: pts[0].z }, { x: pts[n - 1].x, z: pts[n - 1].z }],
      });
    }
    const own = sources.find(c => c.from.own);
    if (own && !tw.bridges.list.some(b => b.crossing && b.crossing.from.own)) {
      notes.push(`The Bureau lists the crossing this gauge is read against at ${own.height.toFixed(2)} m on the gauge (${own.ahd.toFixed(2)} m AHD), but no road bridge in this patch is within ${CROSSING_REACH} m of the gauge to carry it, so ${tw.bridges.list.length === 1 ? 'the bridge here stands at its banks' : 'the bridges here stand at their banks'}.`);
    }
    for (const b of tw.bridges.beyond) {
      notes.push(`${b.name || (b.kind === 'rail' ? 'A railway bridge' : 'A bridge')} stands ${Math.round(b.past)} m past the patch's edge to the ${b.bearing}, out of it, so it is not drawn. Widen the patch on the Scene panel to include it.`);
    }
    if (tw.bridges.skipped.length) {
      notes.push(`${tw.bridges.skipped.length === 1 ? 'A bridge passes' : `${tw.bridges.skipped.length} bridges pass`} through the patch with both ends out of it, so nothing here says how high ${tw.bridges.skipped.length === 1 ? 'its deck stands' : 'their decks stand'}; not drawn.`);
    }
    tw.bridges.status = 'ok';
    sc.bridges = grp;
    sc.scene.add(grp);
    refreshSiteLine();
    requestFrame();
    return notes;
  }

  function loadBridges(st, seq, notes, askP) {
    tw.bridges = { status: 'loading', list: [], source: null, failed: null, crossing: null, beyond: [], skipped: [] };
    refreshSiteLine();
    return (askP || bridgesFor(bridgeQueryBox(tw.origin.lat, tw.origin.lon, (tw.fit && tw.fit.size0) || tw.ground.size))).then(found => {
      if (seq !== tw.seq || !sc.scene) return;
      tw.bridgesFound = found;
      const said = buildBridges(st, found);
      if (found.failed) {
        notes.push('Neither Queensland\'s road network nor OpenStreetMap could be asked where the bridges are, so any bridge here is drawn where the bare ground puts its road — down the bank and up the other side.');
      }
      if (said.length) notes.push(...said);
      if (found.failed || said.length) setNotes(notes);
    });
  }

  // ── the cadastre ───────────────────────────────────────────────────────────
  // Every lot's boundary with its lot and plan, and the road reserve, on this
  // ground: twin-cadastre.js asks the State's cadastre for the patch and draws
  // it. This hands it the scene and the ground to draw on and the ways back
  // into the lines over the stage — and nothing else of the twin's.
  function loadCadastre(seq) {
    if (typeof TwinCadastre === 'undefined' || !sc.scene || !tw.ground || !tw.origin) return;
    const o = { ...tw.origin };
    TwinCadastre.load({
      THREE, scene: sc.scene, camera: sc.camera, canvas: sc.canvas, stage: sc.stage, terrain: sc.terrain,
      ground: tw.ground, origin: o, box: patchBox(o.lat, o.lon, tw.ground.size),
      exag: () => S().exag,
      toXZ: (lat, lon) => localXZ(lat, lon, o.lat, o.lon),
      surfaceY,
      current: () => seq === tw.seq && !!sc.scene,
      requestFrame,
      refresh: () => { refreshSiteLine(); refreshAttrib(); },
      note: list => { for (const n of list) if (!tw.notes.includes(n)) tw.notes.push(n); setNotes(tw.notes); },
    });
  }

  // ── what else is in the patch, as words ──────────────────────────────────
  // The neighbours by name — each a button that goes to that station's own
  // twin — and the bridges with the level their decks stand at and why.
  function siteLineHtml() {
    const parts = [];
    // First, the ground the station stands on: whose lot, or whose road.
    const cad = typeof TwinCadastre !== 'undefined' ? TwinCadastre.lineHtml() : '';
    if (cad) parts.push(cad);
    const N_ = tw.neighbours;
    if (N_ && N_.list.length) {
      const btns = N_.list.slice(0, 12).map(n => `<button type="button" class="link-btn twin-site-stn" onclick="DigitalTwin.followPath('${escAttr(n.id)}')"
          title="Go to ${escAttr(n.name)}'s own twin">${esc(n.name)}</button> <span class="twin-path-fact">${Math.round(n.d)} m ${compassWord(n.bearing)}</span>`);
      const more = N_.list.length - 12 + N_.more;
      parts.push(`<span class="twin-site-lead"><span aria-hidden="true">📍</span> Also in this patch (${N_.list.length + N_.more}):</span> ${btns.join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`);
    }
    const B = tw.bridges;
    if (B && B.status === 'loading') parts.push('<span class="twin-site-lead"><span aria-hidden="true">🌉</span> Looking for bridges…</span>');
    else if (B && B.list.length) {
      const words = B.list.map(b => {
        const lvl = b.deck[0] === b.deck[1] || Math.abs(b.deck[0] - b.deck[1]) < 0.005
          ? `${b.deck[0].toFixed(2)} m AHD` : `${b.deck[0].toFixed(2)}–${b.deck[1].toFixed(2)} m AHD`;
        const why = b.basis === 'crossing'
          ? (b.crossing.from.own
              ? `the crossing height the Bureau lists (${b.crossing.height.toFixed(2)} m on the gauge)`
              : `the crossing height the Bureau lists for ${esc(b.crossing.from.name)}${b.crossing.from.number ? ` (${esc(b.crossing.from.number)})` : ''}, ${b.crossing.height.toFixed(2)} m on its gauge`)
          : b.basis === 'one bank' ? 'the height of its bank in the patch — the far end is past the edge'
          : 'the height of its banks';
        return `${esc(b.name || (b.kind === 'rail' ? 'a railway bridge' : 'a bridge'))}, its deck at ${lvl} — ${why}`;
      });
      parts.push(`<span class="twin-site-lead"><span aria-hidden="true">🌉</span> Bridges (${B.list.length}):</span> ${words.join(' · ')}`);
    }
    return parts.join(' <span aria-hidden="true">·</span> ');
  }
  function refreshSiteLine() {
    const el = document.getElementById('twin-site');
    if (!el) return;
    const html = sc.scene || tw.neighbours || tw.bridges ? siteLineHtml() : '';
    el.innerHTML = html;
    el.hidden = !html;
    el.title = el.textContent.replace(/\s+/g, ' ').trim();
  }

  // ── the pin being moved ────────────────────────────────────────────────────
  // The twin is where a station's position can be put right to the
  // centimetre: the ground is the State's LiDAR and the imagery is flown at
  // 10–20 cm over most towns. So the move-pin mode (map-move-pin.js) draws
  // its pin here too — read from MapMovePin.drawn(), never kept here, the way
  // map-3d.js draws it on its terrain: an amber post standing on the ground
  // where the pin is, taller than whatever is built at the station so its
  // head shows over it, a ring round its foot, a grey ring on the ground where
  // the station was and a dashed line along the ground between the two.
  //
  // It is operated like everything else on this stage, with the pointer: a
  // press on the post drags it across the ground (the ray from the pointer to
  // the patch's own mesh — never the horizon's, which is scenery a kilometre
  // off), and a click on the ground puts it there. Every position goes back
  // through MapMovePin.moveTo() as a latitude and longitude, the inverse of
  // localXZ about the station the patch is centred on; the panel on the stage
  // (#twin-movepin-panel, drawn by MapMovePin) reads the numbers back, and
  // Save and Cancel are there. Not in the .glb: it is a question being asked
  // of the site, not part of it.
  const PIN_COLOUR = 0xffc400;   // 2-D's amber (MAP_PIN_HIT, map-move-pin.js's ring)
  const PIN_REACH  = 0.9;        // metres round the post a press still takes hold of it

  function pinAt(latlon) {
    const o = tw.origin;
    if (!o || !latlon) return null;
    const p = localXZ(latlon[0], latlon[1], o.lat, o.lon);
    const g = tw.ground;
    return g && Math.abs(p.x) <= g.half && Math.abs(p.z) <= g.half ? p : null;
  }
  function latLonAt(x, z) {
    const o = tw.origin;
    return { lat: o.lat - z / metresPerDegLat(), lon: o.lon + x / metresPerDegLon(o.lat) };
  }

  function removeMovePin() {
    if (sc.movepin && sc.scene) { sc.scene.remove(sc.movepin.group); disposeObject(sc.movepin.group); }
    sc.movepin = null;
  }

  function makeMovePin() {
    const grp = new THREE.Group();
    grp.name = 'move pin';
    const amber = new THREE.MeshStandardMaterial({ color: PIN_COLOUR, emissive: PIN_COLOUR, emissiveIntensity: 0.35, roughness: 0.45 });
    const H = Math.max(3.5, (tw.model ? tw.model.top : POLE_H) + 1.2);
    const pin = new THREE.Group();
    pin.name = 'pin';
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, H, 12), amber);
    post.position.y = H / 2; post.name = 'pin post';
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), amber);
    head.position.y = H; head.name = 'pin head';
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.045, 8, 40), amber);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.04; ring.name = 'pin ring';
    // What a press takes hold of: wider than the post, never drawn.
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(PIN_REACH, PIN_REACH, H + 0.6, 12),
                               new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = (H + 0.6) / 2; hit.name = 'pin hit';
    pin.add(post, head, ring, hit);
    const ghost = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.58, 40),
      new THREE.MeshBasicMaterial({ color: 0x6b7a89, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ghost.rotation.x = -Math.PI / 2; ghost.name = 'pin was here';
    const leader = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0x0b5cab, dashSize: 0.6, gapSize: 0.4, depthTest: false, transparent: true }));
    leader.renderOrder = 3; leader.name = 'pin leader';
    grp.add(pin, ghost, leader);
    noExport(grp);
    sc.movepin = { group: grp, pin, post, head, hit, ring, ghost, leader, H };
    sc.scene.add(grp);
  }

  // Where the pin is, on the ground as drawn — the exaggeration moves it with
  // the ground, as it moves the figure.
  function placeMovePin() {
    const m = sc.movepin;
    const d = typeof MapMovePin !== 'undefined' && MapMovePin.drawn ? MapMovePin.drawn() : null;
    if (!m || !d) return false;
    const a = pinAt(d.at);
    if (!a) { m.group.visible = false; return false; }
    m.group.visible = true;
    m.pin.position.set(a.x, yAt(a.x, a.z), a.z);
    const f = d.from ? pinAt(d.from) : null;
    m.ghost.visible = !!f;
    m.leader.visible = !!f;
    if (f) {
      m.ghost.position.set(f.x, yAt(f.x, f.z) + 0.03, f.z);
      const pts = [];
      const K = 24;
      for (let i = 0; i <= K; i++) {
        const x = f.x + (a.x - f.x) * i / K, z = f.z + (a.z - f.z) * i / K;
        pts.push(new THREE.Vector3(x, yAt(x, z) + 0.06, z));
      }
      m.leader.geometry.dispose();
      m.leader.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      m.leader.computeLineDistances();
    }
    return true;
  }

  // MapMovePin changed: armed, dragged, saved or cancelled. The pin is drawn
  // when the station armed is one whose pin stands in this patch — usually
  // the station on screen, and any other whose position the patch holds.
  function movePinChanged() {
    const d = typeof MapMovePin !== 'undefined' && MapMovePin.drawn ? MapMovePin.drawn() : null;
    syncMovePinUi();
    if (d && tw.orient) closeOrient();
    if (!sc.scene || !THREE || !tw.ground || !tw.origin) { if (!d) removeMovePin(); return; }
    if (!d) { removeMovePin(); rig.pinDrag = null; requestFrame(); return; }
    if (!sc.movepin) makeMovePin();
    placeMovePin();
    // The sharp drape follows the pin — at the end of a drag, never during.
    if (rig.pinDrag == null && sc.movepin.group.visible) sharpenAt(sc.movepin.pin.position.x, sc.movepin.pin.position.z);
    requestFrame();
  }

  function showsPin() { return !!(sc.movepin && sc.movepin.group.visible); }

  function syncMovePinUi() {
    const btn = document.getElementById('twin-movepin-btn');
    if (!btn) return;
    const st = currentStation();
    const on = !!(st && typeof MapMovePin !== 'undefined' && MapMovePin.armed() === st.id);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = btn.querySelector('.map-twin-label'), sr = btn.querySelector('.sr-only');
    if (label) {
      label.textContent = on ? ' Moving…' : ' Move pin';
      if (sr) sr.textContent = on ? 'Stop moving the pin' : 'Move this station\'s pin';
    } else {
      btn.textContent = on ? '📍 Moving the pin…' : '📍 Move pin';
    }
  }

  // ── The Orientation tool ───────────────────────────────────────────────────
  // Turn the station on its spot to the way it faces on the ground, and save
  // the bearing (0044's facing_deg) — the Move pin of which way round. Open,
  // the model turns as the numbers change and nothing is written until Save;
  // Cancel puts it back. Its panel sits where Move pin's does, so the two are
  // never open together. Anybody may turn the model to look; saving is an
  // editor's, as the tower's height is.
  function norm360(v) { return ((Math.round(Number(v) * 10) / 10 % 360) + 360) % 360; }
  function facingWords(deg) { return `${Math.round(deg)}° ${compassWord(deg)}`; }

  // The model, and a visitor up the ladder or on the deck, turned to what the
  // tool says now. The visitor goes round with the station rather than being
  // left standing in the air where the deck was.
  function applyFacing() {
    const was = sc.turn || 0;
    sc.turn = turnOf(facingNow());
    if (sc.station) sc.station.rotation.y = -sc.turn;
    const d = sc.turn - was;
    if (d && rig.mode === 'walk' && rig.level !== 'ground') {
      const w = toWorld(rig.px, rig.pz, d);
      rig.px = w.x; rig.pz = w.z; rig.yaw += d;
      placeCamera();
    }
    requestFrame();
  }

  function orientPanelHtml() {
    const st = currentStation(), o = tw.orient;
    if (!st || !o) return '';
    const rec = facingOf(st), can = towerCanSave();
    const saved = rec == null ? `not recorded — drawn facing ${facingWords(FACING_DEFAULT)}` : facingWords(rec);
    const why = can ? '' : typeof editorWritesGoToDatabase === 'function' && !editorWritesGoToDatabase()
      ? 'The station list on screen is not from the datastore, so this cannot be saved.'
      : 'Sign in as an editor to save it.';
    const msg = o.msg ? o.msg : why ? { kind: '', text: why } : null;
    const dis = o.saving ? 'disabled' : '';
    return `
      <div class="mn-movepin-head">
        <strong>Orientation</strong>
        <span class="mn-movepin-name">${esc(st.name || st.id)}</span>
      </div>
      <p class="mn-movepin-hint">The bearing the station's front — its enclosure door, or a tower's ladder — faces. Turn it to match the imagery, or orbit round to where the front should be and press Face the view.</p>
      <div class="twin-orient-row">
        <button type="button" class="pill" onclick="DigitalTwin.orientBy(-15)" ${dis} title="Turn it 15° anticlockwise" aria-label="Turn 15 degrees anticlockwise">⟲ 15°</button>
        <label class="twin-orient-deg"><span class="sr-only">Faces, degrees from north</span>
          <input type="number" id="twin-orient-deg" min="0" max="359.9" step="1" inputmode="decimal" value="${norm360(o.deg)}" ${dis}
                 oninput="DigitalTwin.orientTo(this.value, 'box')">°</label>
        <span class="twin-orient-word" id="twin-orient-word">${compassWord(o.deg)}</span>
        <button type="button" class="pill" onclick="DigitalTwin.orientBy(15)" ${dis} title="Turn it 15° clockwise" aria-label="Turn 15 degrees clockwise">15° ⟳</button>
      </div>
      <input type="range" class="twin-orient-range" id="twin-orient-range" min="0" max="359" step="1" value="${Math.round(o.deg) % 360}" ${dis}
             aria-label="Faces, degrees clockwise from north" oninput="DigitalTwin.orientTo(this.value, 'range')">
      <div class="pill-row twin-orient-quick">
        <button type="button" class="pill" onclick="DigitalTwin.orientFaceView()" ${dis} title="Turn the front toward where you are looking from">👁 Face the view</button>
        <button type="button" class="pill" onclick="DigitalTwin.orientTo(${FACING_DEFAULT})" ${dis} title="Back to facing south, as every station is drawn until it records otherwise">Facing south</button>
      </div>
      <dl class="mn-movepin-read">
        <dt>Saved</dt><dd>${esc(saved)}</dd>
      </dl>
      ${msg ? `<p class="small mn-movepin-msg ${msg.kind === 'error' ? 'txt-bad' : msg.kind === 'ok' ? 'txt-ok' : ''}" role="status">${esc(msg.text)}</p>` : ''}
      <div class="mn-movepin-actions pill-row">
        <button type="button" class="pill is-on" onclick="DigitalTwin.orientSave()" ${o.saving || !can ? 'disabled' : ''}>${o.saving ? 'Saving…' : 'Save orientation'}</button>
        <button type="button" class="pill" onclick="DigitalTwin.orientCancel()" ${dis}>Cancel</button>
      </div>`;
  }
  function renderOrientPanel() {
    const el = document.getElementById('twin-orient-panel');
    if (el) {
      const on = !!(tw.orient && currentStation());
      el.hidden = !on;
      el.innerHTML = on ? orientPanelHtml() : '';
    }
    syncOrientUi();
  }
  // Only the numbers, while they are being changed: a repaint of the panel
  // would take the caret out of the box being typed in.
  function syncOrientFields(from) {
    const o = tw.orient;
    if (!o) return;
    const box = document.getElementById('twin-orient-deg');
    if (box && from !== 'box') box.value = String(norm360(o.deg));
    const rng = document.getElementById('twin-orient-range');
    if (rng && from !== 'range') rng.value = String(Math.round(o.deg) % 360);
    const w = document.getElementById('twin-orient-word');
    if (w) w.textContent = compassWord(o.deg);
  }
  function syncOrientUi() {
    const btn = document.getElementById('twin-orient-btn');
    if (!btn) return;
    const on = !!tw.orient;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = btn.querySelector('.map-twin-label');
    if (label) label.textContent = on ? ' Turning…' : ' Orientation';
    else btn.textContent = on ? '🧭 Turning…' : '🧭 Orientation';
  }
  function openOrient() {
    const st = currentStation();
    if (!st) return;
    // Move pin's panel is where this one goes: one at a time.
    if (typeof MapMovePin !== 'undefined' && MapMovePin.armed()) MapMovePin.cancel();
    tw.orient = { id: st.id, deg: facingNow(st), saving: false, msg: null };
    renderOrientPanel();
  }
  function closeOrient() {
    if (!tw.orient) return;
    tw.orient = null;
    applyFacing();
    renderOrientPanel();
  }
  function orientTo(v, from) {
    const o = tw.orient;
    if (!o || o.saving) return;
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) return;
    o.deg = norm360(n);
    if (o.msg && o.msg.kind !== 'error') o.msg = null;
    applyFacing();
    syncOrientFields(from);
  }

  // The pointer's ray onto the patch's own ground: { x, z } or null.
  function groundUnder(clientX, clientY) {
    if (!sc.terrain || !sc.camera) return null;
    const r = sc.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(nd, sc.camera);
    const hit = rc.intersectObject(sc.terrain, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  // A press on the post takes hold of it.
  function pinUnder(clientX, clientY) {
    if (!showsPin() || !sc.camera) return false;
    const r = sc.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(nd, sc.camera);
    return rc.intersectObject(sc.movepin.hit, false).length > 0;
  }

  // The pin to the ground under the pointer. `silent` while a drag is under
  // way: the panel follows, the note waits for the end of it.
  function pinTo(clientX, clientY, silent) {
    const p = groundUnder(clientX, clientY);
    if (!p || !tw.origin) return false;
    const ll = latLonAt(p.x, p.z);
    MapMovePin.moveTo(ll.lat, ll.lon, { silent });
    return true;
  }

  // Armed, and for a station whose pin this patch shows: the ground's clicks
  // are the pin's.
  function pinArmedHere() {
    return typeof MapMovePin !== 'undefined' && !!MapMovePin.armed() && showsPin();
  }

  // ── the flood water ────────────────────────────────────────────────────────
  // The river at the heights it is known to reach — the Bureau's flood classes,
  // the modelled AEP levels, the peaks it has reached where there are any
  // (flood-stages.js puts them on one ladder in m AHD) — drawn as water over
  // the patch: rising from 0 m on the gauge to the highest level, held there,
  // let out, and round again, coloured by the furthest level it has passed.
  //
  // Water where the river would be, not everywhere low. Every sample carries
  // the lowest level at which it joins the channel by the gauge — the least,
  // over every path from the channel to it, of the highest ground on the path
  // (a priority flood: Dijkstra with max for plus, once per ground). At level L
  // a sample is under water when that is below L, so a hollow behind a bank
  // stays dry until the bank is overtopped, and a dam in the next gully is not
  // flooded by a river it is not joined to. The water itself is one level
  // plane over the patch, masked to those samples and cut by the ground in the
  // depth buffer, so its edge is the true contour wherever the ground makes it.
  // It is only as good as the samples, though: a bank narrower than a few of
  // them (2 m apart at 400 m, 8 m at 1600 m) is crossed on a diagonal beside
  // its crest, and leaks. docs/digital-twin.md says so where a user reads it.
  //
  // A level surface through the whole patch is the model's one simplification
  // worth saying out loud: a real flood slopes downstream (the AEP sheets give
  // the slope — a metre in 600 at Gatton), so across a 1.6 km patch the far
  // edges are a guide, not a map. Not in the .glb: it is a simulation, not the
  // site. Editors and visitors alike see it — the levels are the station
  // card's, and those are public.
  const FLOOD_SEED_M  = 60;    // the channel is looked for this far round the gauge
  const FLOOD_FPS     = 30;    // the rise is redrawn at most this often
  const FLOOD_LINE_HZ = 8;     // the reading under the stage, at most this often
  const FLOOD_ALPHA   = { below: 0.45, level: 0.62 };

  let floodClock = null;       // the check's seam: a shorter cycle

  // The scale's measure, linear or logarithmic (flood-stages.js, "linear or
  // logarithmic"). Every twin opens on a linear scale; a few seconds after
  // the scale first comes up, it turns logarithmic by itself where the
  // station's levels warrant it — the pause is so that the operator sees the
  // metres as they are first, and sees the scale open out where they crowd.
  // Once the operator has pressed Log, on or off, for a station, that is kept
  // for it for the session and nothing turns it by itself again: rebuilt, a
  // new patch size, a return to it later.
  const SCALE_AUTO_MS = 4000;
  let scaleAutoMs = SCALE_AUTO_MS;   // the check's seam: sooner, or never (null)
  const floodScales = new Map();     // station id → 'lin' | 'log', as chosen
  const SCALE_GLIDE_MS = 450;        // the marks and names moving to their new places

  // Levels borrowed from a nearby station, for a station that has none of its
  // own: station id → { donorId, mode }. Asked for by the operator, kept for
  // the session (a rebuild, a new patch size, a return to the station keep
  // it), and never written anywhere — it is a way of looking, not a fact.
  const floodBorrows = new Map();
  const DONORS = 4;            // the nearest stations the modal offers

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function floodAnimating() {
    const s = S();
    return !!s.flood && (s.floodAnim == null ? !reducedMotion() : s.floodAnim);
  }
  function floodPalette() {
    const out = {};
    for (const [k, v] of Object.entries(FloodStages.COLOURS)) out[k] = cssVar(v.token, v.hex) || v.hex;
    return out;
  }
  function floodY(ahd) { const g = tw.ground; return g ? (ahd - g.h0) * S().exag : 0; }

  // The channel by the gauge: the lowest sample within FLOOD_SEED_M of it.
  function floodSeed(g) {
    const step = g.size / (N - 1), c = (N - 1) / 2, r = Math.ceil(FLOOD_SEED_M / step);
    let best = null;
    for (let j = Math.max(0, c - r); j <= Math.min(N - 1, c + r); j++) {
      for (let i = Math.max(0, c - r); i <= Math.min(N - 1, c + r); i++) {
        const x = -g.half + i * step, z = -g.half + j * step;
        if (Math.hypot(x, z) > FLOOD_SEED_M) continue;
        const e = g.elev[j * N + i];
        if (!isFinite(e)) continue;
        if (!best || e < best.elev) best = { idx: j * N + i, i, j, x, z, elev: e };
      }
    }
    return best;
  }

  // For every sample, the level at which it joins the channel (see above).
  // Doubles, whatever the ground came as: a level stored rounded would compare
  // unequal to the one queued, and the sample it was queued for never expand.
  function fillLevels(elev, seed) {
    const n = N * N;
    const fill = new Float64Array(n).fill(Infinity);
    const hk = [], hi = [];
    const push = (k, i) => {
      let c = hk.length; hk.push(k); hi.push(i);
      while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= k) break; hk[c] = hk[p]; hi[c] = hi[p]; c = p; }
      hk[c] = k; hi[c] = i;
    };
    const pop = () => {
      const k0 = hk[0], i0 = hi[0];
      const k = hk.pop(), i = hi.pop();
      const len = hk.length;
      if (len) {
        let c = 0;
        for (;;) {
          let l = 2 * c + 1;
          if (l >= len) break;
          if (l + 1 < len && hk[l + 1] < hk[l]) l++;
          if (hk[l] >= k) break;
          hk[c] = hk[l]; hi[c] = hi[l]; c = l;
        }
        hk[c] = k; hi[c] = i;
      }
      popped[0] = k0; popped[1] = i0;
    };
    const popped = [0, 0];
    fill[seed] = elev[seed];
    push(fill[seed], seed);
    while (hk.length) {
      pop();
      const f = popped[0], cell = popped[1];
      if (f > fill[cell]) continue;
      const cx = cell % N, cy = (cell - cx) / N;
      for (let dy = -1; dy <= 1; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          if ((!dx && !dy) || x < 0 || x >= N) continue;
          const nb = y * N + x;
          const e = elev[nb];
          const nf = isFinite(e) ? Math.max(f, e) : Infinity;
          if (nf < fill[nb]) { fill[nb] = nf; push(nf, nb); }
        }
      }
    }
    return fill;
  }

  function removeFlood() {
    removeTowerMarks();
    if (sc.flood && sc.scene) {
      sc.scene.remove(sc.flood.water); sc.scene.remove(sc.flood.staff);
      disposeObject(sc.flood.water); disposeObject(sc.flood.staff);
      if (sc.flood.tex) sc.flood.tex.dispose();
    }
    sc.flood = null;
  }

  // The ladder, the channel and the fill levels for the station on screen, and
  // the water and its staff if there is a scene to put them in. Returns the
  // notes the build should show.
  function buildFlood(st) {
    removeFlood();
    clearScaleAuto();
    tw.flood = null;
    const g = tw.ground;
    if (!g || !st || typeof FloodStages === 'undefined') { refreshFloodLine(); return []; }
    const seed = floodSeed(g);
    const own = FloodStages.ladder(st);
    let lad = own;
    // Its own levels first, always; borrowed ones only where it has none it
    // can draw, and only where the operator asked for them.
    const pick = floodBorrows.get(st.id);
    if ((!own.levels.length || own.top == null) && pick) {
      const donor = pick.donorId === st.id ? st : stationById(pick.donorId);
      if (donor) {
        const info = donorInfo(st, donor);
        lad = FloodStages.borrowed(donor, pick.mode, seed ? seed.elev : null, info);
      }
    }
    // Every level is in AHD, and so must the ground be that it stands on.
    lad = FloodStages.onGround(lad, g.datum);
    const notes = lad.borrowed ? [...borrowNotes(lad), ...lad.notes] : lad.notes.slice();
    if (!lad.levels.length || lad.top == null) {
      tw.flood = { lad, none: true, notes, own };
      refreshFloodLine();
      return notes;
    }
    const start = FloodStages.start(lad, seed ? seed.elev : null);
    const fill = seed ? fillLevels(g.elev, seed.idx) : null;
    if (seed && seed.elev >= lad.top) {
      notes.push(`Every flood level ${lad.borrowed ? 'borrowed' : 'recorded here'} is below the lowest ground by the gauge in this patch (${seed.elev.toFixed(2)} m AHD against ${lad.top.toFixed(2)} m AHD), so the water has nothing to cover.`);
    }
    // The scale's measure: the bend its levels would take and whether they
    // warrant it, and linear to begin with — or what the operator pressed for
    // this station, which also means nothing turns it by itself.
    const fit = FloodStages.logFit(lad.levels, start.m, lad.top);
    const chose = floodScales.get(st.id) || null;
    const logK = chose === 'log' ? fit.k : null;
    tw.flood = { lad, none: false, notes, seed, fill, start: start.m, startBasis: start.basis, top: lad.top,
                 level: null, band: null, bandKey: undefined, maskLevel: null, flooded: 0,
                 t0: performance.now(), clock: null, lastDraw: 0, lastLine: 0, own,
                 fit, logK, curve: FloodStages.curve(start.m, lad.top, logK), scaleChosen: !!chose, scaleAutoDone: false };
    if (sc.scene && THREE) { makeFlood(); buildTowerMarks(); }
    settleFlood();
    refreshFloodLine();
    return notes;
  }

  // ── borrowing another station's levels ──
  // The words for a station's catchment: its basins by name, else the
  // Bureau's grouping, and its stream — whatever the record has.
  function catchmentWords(s) {
    const names = [];
    const cats = (state.data && state.data.catchments) || [];
    for (const id of (s && s.catchment_ids) || []) {
      const c = cats.find(x => x.id === id);
      names.push(c ? c.name : id);
    }
    const where = names.length ? names.join(', ') : (s && s.basin) || null;
    const stream = s && s.stream ? String(s.stream).toLowerCase().replace(/\b\w/g, m => m.toUpperCase()) : null;
    return where && stream ? `${where} · ${stream}` : where || stream || null;
  }
  function sameCatchment(a, b) {
    const x = new Set((a && a.catchment_ids) || []);
    if ((b && b.catchment_ids || []).some(id => x.has(id))) return true;
    return !!(a && b && a.basin && b.basin && a.basin === b.basin);
  }
  function donorInfo(st, donor) {
    if (donor.id === st.id) return { km: 0, bearing: null, same: true, self: true };
    const km = acmaHaversineKm(st.lat, st.lon, donor.lat, donor.lon);
    return { km, bearing: bearingDeg(st.lat, st.lon, donor.lat, donor.lon), same: sameCatchment(st, donor), self: false };
  }
  // Two notes for borrowed levels: whose, and the datums they crossed — what
  // the other station's heights are measured from, how they were carried, and
  // what they are in here (FloodStages.datumWords).
  function borrowNotes(lad) {
    const b = lad.borrowed;
    const how = b.mode === 'ahd' ? 'its levels in metres AHD, unchanged'
                                 : 'its heights on the gauge, laid over this station\'s channel';
    const whose = b.self
      ? 'These are this station\'s own flood classes, as heights over its channel: its gauge has no zero in AHD to put them on the ground by.'
      : `Flood levels borrowed from ${b.name}, ${fmtKm(b.km)} ${compassWord(b.bearing)}${b.same ? ', in the same catchment' : ', in another catchment'}: `
        + `${how}. A guide, not a model — the river here is not the river there.`;
    const w = floodDatumWords(lad);
    return w ? [whose, `Datums of the borrowed levels — ${w.from} ${w.carried} ${w.here}`] : [whose];
  }
  const BORROW_NOTE_RE = /^Flood levels borrowed from|^These are this station's own flood classes|^Datums of the borrowed levels/;
  // The notes less everything the levels borrowed last said — whose they were,
  // their datums, and what the lender's own record said — so that a new
  // choice, or none, does not leave the old one's words standing.
  function withoutBorrowedNotes(notes) {
    const F = tw.flood;
    const said = new Set(F && F.lad && F.lad.borrowed ? F.notes : []);
    return notes.filter(n => !said.has(n) && !BORROW_NOTE_RE.test(n));
  }

  // How the ground under the water is said where its datum is: what it is,
  // and that it is AHD (and how it got there, for the tiles).
  function groundDatumWords(g) {
    if (!g) return 'this station\'s ground';
    if (g.source === 'qld') {
      return `this station's ground — Queensland's DTM, in AHD${g.filled ? (g.geoid ? `, its gaps filled from ~30 m tiles put into AHD (${geoidWords(g.geoid)})` : ', its gaps filled from ~30 m tiles in EGM96') : ''}`;
    }
    return g.geoid ? `this station's ground — ~30 m terrain tiles, put into AHD from EGM96 (${geoidWords(g.geoid)})`
                   : 'this station\'s ground — ~30 m terrain tiles, in EGM96';
  }
  function floodDatumWords(lad) {
    return FloodStages.datumWords(lad, { ground: groundDatumWords(tw.ground) });
  }

  // The stations nearest this one that have levels to lend, nearest first —
  // and this station itself first where it has classes the ladder could not
  // place (a gauge whose zero is not in AHD): its own heights over its own
  // channel are a better guide than anybody else's.
  function nearestDonors(st, n = DONORS) {
    const out = [];
    if (!st || !located(st) || typeof FloodStages === 'undefined' || !state.data) return out;
    for (const s of state.data.stations) {
      if (s.id === st.id || !located(s)) continue;
      const b = FloodStages.borrowable(s);
      if (!b) continue;
      out.push({ s, b, km: acmaHaversineKm(st.lat, st.lon, s.lat, s.lon) });
    }
    out.sort((a, b) => a.km - b.km);
    const top = out.slice(0, n).map(d => ({ ...d, bearing: bearingDeg(st.lat, st.lon, d.s.lat, d.s.lon), same: sameCatchment(st, d.s) }));
    const self = FloodStages.borrowable(st);
    if (self && self.classes.length) top.unshift({ s: st, b: self, km: 0, bearing: null, same: true, self: true });
    return top;
  }

  function donorHeightsHtml(b) {
    const parts = [];
    if (b.classes.length) {
      parts.push(`${b.classes.map(c => `${c.label.toLowerCase()} ${c.h.toFixed(2)}`).join(' · ')} m on the gauge${b.classesAsAt ? ` <span class="twin-borrow-fact">(${esc(String(b.classesAsAt).slice(0, 10))})</span>` : ''}`);
    }
    if (b.aeps.length) {
      parts.push(`${b.aeps.map(d => `${d.label} AEP ${d.ahd.toFixed(2)}`).join(' · ')} m AHD`);
    }
    if (b.peaks && b.peaks.length) {
      parts.push(`${b.peaks.length} recorded flood${b.peaks.length === 1 ? '' : 's'}`);
    }
    return parts.join('<br>');
  }

  // A lender's gauge zero and its datum, for the modal's Datum column: what
  // its classes are measured from, and whether it is AHD — which decides what
  // can cross in each mode.
  function donorZeroHtml(b) {
    const z = b.zero;
    if (!z) return '<span class="twin-borrow-datum is-off">No surveyed gauge zero</span>';
    const when = z.from ? ` <span class="twin-borrow-fact">(since ${esc(String(z.from).slice(0, 10))})</span>` : '';
    if (z.datum === 'AHD') return `<span class="twin-borrow-datum">Gauge zero ${esc(z.m.toFixed(2))} m AHD</span>${when}`;
    return `<span class="twin-borrow-datum is-off">Gauge zero ${esc(z.m.toFixed(2))} m, ${esc(z.datum ? FloodStages.datumWord(z.datum) : 'no stated datum')} — not AHD</span>${when}`;
  }

  function borrowModalHtml(st) {
    const donors = nearestDonors(st);
    if (!donors.length) return `<p>No station anywhere near ${esc(st.name)} has flood levels to lend.</p>`;
    const pick = floodBorrows.get(st.id);
    const mode = pick ? pick.mode : 'gauge';
    const g = tw.ground;
    const seed = g ? floodSeed(g) : null;
    const rows = donors.map(d => `
          <tr>
            <th scope="row"><strong>${esc(d.self ? `${d.s.name} (its own)` : d.s.name)}</strong>${d.s.station_number ? `<br><span class="twin-borrow-fact">${esc(d.s.station_number)}</span>` : ''}</th>
            <td>${d.self ? 'here' : `${esc(fmtKm(d.km))} ${esc(compassWord(d.bearing))}`}</td>
            <td>${donorHeightsHtml(d.b)}</td>
            <td>${donorZeroHtml(d.b)}</td>
            <td>${esc(catchmentWords(d.s) || '—')}${d.self ? '' : d.same ? ' <span class="twin-borrow-same">same catchment</span>' : ''}</td>
            <td><button type="button" class="primary" onclick="DigitalTwin.useFloodFrom('${escAttr(d.s.id)}')">Use these</button></td>
          </tr>`).join('');
    const ch = seed ? `${seed.elev.toFixed(2)} m ${g.datum}` : null;
    return `
      <p>No flood heights are recorded for <strong>${esc(st.name)}</strong> that can be put on its ground. Here are the ${donors.filter(d => !d.self).length} nearest stations that have some — their distance, their flood heights, the datum their gauge is on, and their catchment. Pick one to draw its levels as water over this station's ground.</p>
      <p class="twin-borrow-here"><strong>Datum here:</strong> ${esc(groundDatumWords(g))}.${ch ? ` The channel by the gauge — the lowest ground within ${FLOOD_SEED_M} m — is at ${esc(ch)}.` : ''} Every height drawn is in metres AHD.</p>
      <fieldset class="twin-borrow-mode">
        <legend>Carry the heights across</legend>
        <label class="check-label"><input type="radio" name="twin-borrow-mode" value="gauge" ${mode === 'gauge' ? 'checked' : ''}><span>As heights on the gauge, laid over this station's channel — the better guide across a river's fall. Only the heights over the other gauge's zero cross, so its zero's datum does not matter: h m on its gauge is drawn at ${ch ? `${esc(seed.elev.toFixed(2))} + h m AHD` : 'h m over the channel'}. Its AEP levels and floods cross only where its zero is AHD.</span></label>
        <label class="check-label"><input type="radio" name="twin-borrow-mode" value="ahd" ${mode === 'ahd' ? 'checked' : ''}><span>As the same heights in metres AHD — only for a station on the same reach, a short way off. Its classes cross only where its zero is AHD; its AEP levels and floods are AHD already.</span></label>
      </fieldset>
      <div class="table-wrap" tabindex="0" role="region" aria-label="The nearest stations with flood levels">
        <table class="twin-borrow-table">
          <caption class="sr-only">The nearest stations with flood levels, nearest first</caption>
          <thead><tr><th scope="col">Station</th><th scope="col">Distance</th><th scope="col">Flood heights</th><th scope="col">Datum</th><th scope="col">Catchment</th><th scope="col"><span class="sr-only">Use</span></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="small">Borrowed levels are drawn only in this twin and only for this session — nothing is saved to the station. The notes under the view and the Scene panel say whose levels they are and every datum they crossed.</p>`;
  }

  function makeFlood() {
    const F = tw.flood, g = tw.ground;
    const pal = floodPalette();
    // The mask: one texel per sample, in the ground's own order (row 0 north),
    // and the plane's corners sampling the corner texels' centres.
    const data = new Uint8Array(N * N * 4);
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(g.size, g.size, 1, 1);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * (N - 1) + 0.5) / N, ((1 - uv.getY(i)) * (N - 1) + 0.5) / N);
    }
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: pal.below, transparent: true, opacity: FLOOD_ALPHA.below,
                                                 alphaMap: tex, depthWrite: false, side: THREE.DoubleSide,
                                                 roughness: 0.2, metalness: 0 });
    const water = new THREE.Mesh(geo, mat);
    water.name = 'flood water';
    water.renderOrder = 2;
    water.userData.export = false;

    // The staff: a white post in the channel from 0 m to the top, a ring at
    // every level in its colour — the gauge board the water is read against.
    const staff = new THREE.Group();
    staff.name = 'flood staff';
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8), postMat);
    post.name = 'staff post';
    staff.add(post);
    for (const l of F.lad.levels) {
      const col = FloodStages.colourOf(l, pal);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(l.kind === 'peak' ? 0.11 : 0.14, 0.03, 8, 24),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.35, roughness: 0.5 }));
      ring.rotation.x = Math.PI / 2;
      ring.name = `level ${l.label}`;
      ring.userData.level = l.key;
      staff.add(ring);
    }
    const at = F.seed || { x: 0, z: 0 };
    staff.position.set(at.x, 0, at.z);
    staff.traverse(o => { o.userData.export = false; });
    sc.flood = { water, staff, tex, data, mat, palette: pal };
    sc.scene.add(water);
    sc.scene.add(staff);
    placeFlood();
  }

  // Heights follow the ground: the exaggeration slider moves them with it.
  function placeFlood() {
    const F = tw.flood;
    if (!F || F.none || !sc.flood) return;
    const y0 = floodY(F.start), y1 = floodY(F.top) + 0.4;
    const post = sc.flood.staff.getObjectByName('staff post');
    post.scale.y = Math.max(0.01, y1 - y0);
    post.position.y = (y0 + y1) / 2;
    for (const ring of sc.flood.staff.children) {
      if (!ring.userData.level) continue;
      const l = F.lad.levels.find(x => x.key === ring.userData.level);
      if (l) ring.position.y = floodY(l.ahd);
    }
    if (F.level != null) sc.flood.water.position.y = floodY(F.level);
    const on = !!S().flood;
    sc.flood.water.visible = on;
    sc.flood.staff.visible = on;
    if (sc.towerMarks) sc.towerMarks.visible = on;
    requestFrame();
  }

  // ── the levels on the tower ──
  // Every level of the station's own that falls on the tower — a flood class,
  // an AEP flood, a flood the river has reached — marked where it is on the
  // structure, in the colour the scale and the slider give it: a band round
  // the mast below the platform, a band round the handrails above it. Each
  // has a call-out to the east of the platform saying what it is and how
  // high, the call-outs spread so none sits on another. Heights are the
  // tower's own metres over the ground at its foot (the level less the
  // ground at the origin), which is where the water meets the tower at the
  // exaggeration it opens with. Borrowed levels are marked like its own, the call-outs
  // and the water's notes saying whose they are. A simulation's marks: never in the .glb.
  const MARK_GAP = 0.45;       // call-outs' middles no nearer than this, metres
  const CALLOUT_W = 1.5;       // a call-out's width, metres; 640 × 180 px

  // A call-out: the level's colour down its left edge, what it is, and how
  // high — large enough to read from the ground at the tower's foot.
  function makeCallout(title, sub, colour) {
    const cv = document.createElement('canvas');
    const W = 640, H = 180;
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(16, 32, 42, 0.86)';
    cx.beginPath();
    if (typeof cx.roundRect === 'function') cx.roundRect(4, 4, W - 8, H - 8, 22);
    else cx.rect(4, 4, W - 8, H - 8);
    cx.fill();
    cx.fillStyle = colour;
    cx.fillRect(4, 4, 30, H - 8);
    cx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; cx.lineWidth = 2;
    cx.strokeRect(4, 4, 30, H - 8);
    cx.textAlign = 'left';
    cx.textBaseline = 'middle';
    const fit = (t, px, weight) => {
      cx.font = `${weight} ${px}px system-ui, sans-serif`;
      while (px > 24 && cx.measureText(t).width > W - 70) { px -= 2; cx.font = `${weight} ${px}px system-ui, sans-serif`; }
    };
    cx.fillStyle = '#ffffff';
    fit(String(title), 66, 700);
    cx.fillText(String(title), 52, 62);
    cx.fillStyle = '#d7e8f7';
    fit(String(sub), 46, 500);
    cx.fillText(String(sub), 52, 132);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.center.set(0, 0.5);
    sp.scale.set(CALLOUT_W, CALLOUT_W * H / W, 1);
    return sp;
  }
  function removeTowerMarks() {
    const g = sc.towerMarks;
    if (g) {
      if (g.parent) g.parent.remove(g);
      disposeObject(g);
    }
    sc.towerMarks = null;
    if (tw.flood) tw.flood.towerMarks = [];
  }

  function towerMarkTitle(l) {
    if (l.kind === 'aep') return `${l.short || l.label.replace(/ AEP$/, '')} AEP`;
    if (l.kind === 'peak') {
      const y = l.date ? String(l.date).slice(0, 4) : null;
      return `${y ? `${y} flood` : 'Recorded flood'}${l.highest ? ' ★' : ''}`;
    }
    return l.label;
  }
  function towerMarkHeight(l) {
    return l.gauge != null ? `${Number(l.gauge).toFixed(2)} m · ${Number(l.ahd).toFixed(2)} AHD`
                           : `${Number(l.ahd).toFixed(2)} m AHD`;
  }

  function buildTowerMarks() {
    removeTowerMarks();
    const F = tw.flood, m = tw.model, g = tw.ground;
    if (!F || F.none || !g || !sc.station || !m || m.structure !== 'tower') return;
    const pal = (sc.flood && sc.flood.palette) || floodPalette();
    const TOWER_H = m.tower.h, railTop = m.tower.deck + RAIL_H;
    const on = F.lad.levels.map(l => ({ l, y: l.ahd - g.h0 })).filter(o => o.y > SLAB_TOP && o.y <= railTop);
    F.towerMarks = on.map(o => ({ key: o.l.key, y: o.y }));
    if (!on.length) return;
    const grp = new THREE.Group();
    grp.name = 'flood level marks';
    const H = DECK_HALF, p = H - 0.02;
    const at = FloodStages.spread(on.map(o => o.y), MARK_GAP, SLAB_TOP, railTop + 3);
    on.forEach((o, i) => {
      const col = FloodStages.colourOf(o.l, pal);
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4, roughness: 0.5, side: THREE.DoubleSide });
      let edge;
      if (o.y < TOWER_H - 0.06) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(POLE_R + 0.035, POLE_R + 0.035, 0.05, 40, 1, true), mat);
        band.position.y = o.y;
        band.name = 'flood level band';
        grp.add(band);
        edge = POLE_R + 0.035;
      } else {
        for (const [w, d, x, z] of [[2 * p, 0.03, 0, p], [2 * p, 0.03, 0, -p], [0.03, 2 * p, p, 0], [0.03, 2 * p, -p, 0]]) {
          const b = box(grp, mat, w, 0.05, d, x, o.y, z, 'flood level band');
          b.castShadow = false;
        }
        edge = p + 0.015;
      }
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), mat);
      dot.position.set(edge, o.y, 0);
      dot.name = 'flood level marker';
      grp.add(dot);
      // The call-out: a leader from the band out past the platform, then up
      // or down to where its label was spread to.
      const x1 = H + 0.2, x2 = H + 0.4;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(edge, o.y, 0), new THREE.Vector3(x1, o.y, 0), new THREE.Vector3(x2, at[i], 0)]),
        new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
      line.renderOrder = 5;
      line.name = 'flood level leader';
      grp.add(line);
      const sign = makeCallout(towerMarkTitle(o.l), towerMarkHeight(o.l), col);
      sign.position.set(x2 + 0.02, at[i], 0);
      sign.renderOrder = 6;
      sign.name = `flood level call-out ${o.l.label}`;
      grp.add(sign);
    });
    grp.traverse(o => { o.userData.export = false; });
    grp.visible = !!S().flood;
    sc.towerMarks = grp;
    sc.station.add(grp);
    requestFrame();
  }

  // Put the water at a level (m AHD, kept between 0 m and the top). True when
  // it moved.
  function setFloodLevel(ahd) {
    const F = tw.flood;
    if (!F || F.none) return false;
    const L = Math.max(F.start, Math.min(F.top, ahd));
    if (F.level != null && Math.abs(L - F.level) < 1e-4) return false;
    F.level = L;
    const band = FloodStages.passed(F.lad, L);
    const key = band ? band.key : 'below';
    if (sc.flood) {
      sc.flood.water.position.y = floodY(L);
      if (F.maskLevel == null || Math.abs(L - F.maskLevel) >= 0.01 || key !== F.bandKey) floodMask(L);
      if (key !== F.bandKey) {
        sc.flood.mat.color.set(FloodStages.colourOf(band, sc.flood.palette));
        sc.flood.mat.opacity = band ? FLOOD_ALPHA.level : FLOOD_ALPHA.below;
      }
    } else if (F.fill) {
      let n = 0;
      for (let i = 0; i < F.fill.length; i++) if (F.fill[i] < L) n++;
      F.flooded = n;
    }
    F.band = band;
    F.bandKey = key;
    scaleWater();
    return true;
  }

  // The water in the scale's track, for every frame the level moves: two
  // custom properties, the rest waiting for the reading's slower beat.
  function scaleWater() {
    const F = tw.flood, track = document.getElementById('twin-scale-track');
    if (!track || !F || F.none || F.level == null || !sc.flood) return;
    const f = F.curve.at(F.level);
    track.style.setProperty('--level', f.toFixed(4));
    track.style.setProperty('--sw', FloodStages.colourOf(F.band, sc.flood.palette));
  }

  function floodMask(L) {
    const F = tw.flood, d = sc.flood.data, fill = F.fill;
    let n = 0;
    for (let i = 0, o = 0; i < N * N; i++, o += 4) {
      const v = fill && fill[i] < L ? 255 : 0;
      if (v) n++;
      d[o] = d[o + 1] = d[o + 2] = d[o + 3] = v;
    }
    sc.flood.tex.needsUpdate = true;
    F.maskLevel = L;
    F.flooded = n;
  }

  // Where still water stands: the level chosen, else the top.
  function floodHoldLevel() {
    const F = tw.flood, h = S().floodHold;
    if (typeof h === 'number' && isFinite(h)) return F.start + Math.max(0, Math.min(1, h)) * (F.top - F.start);
    if (typeof h === 'string') { const l = F.lad.levels.find(x => x.key === h); if (l) return l.ahd; }
    return F.top;
  }

  // The settings, applied: shown or not, rising or held.
  function settleFlood() {
    const F = tw.flood;
    if (!F || F.none) { refreshFloodLine(); return; }
    if (floodAnimating()) {
      // Carried on from where the water is, not from the bottom.
      reanchorFlood();
      if (F.level == null) setFloodLevel(F.start);
    } else {
      setFloodLevel(floodHoldLevel());
    }
    placeFlood();
    syncFloodReading();
    syncFloodControls();
    syncCanvasName();
    requestFrame();
  }

  function floodClockOpts() {
    return floodClock || { rise: FloodStages.RISE_S, hold: FloodStages.HOLD_S, drain: FloodStages.DRAIN_S };
  }

  // The rise's clock set to where the water is on the track now, so that it
  // goes on from there — after a pause, or onto a track of the other measure.
  // The rise runs along the track, not the metres: on a logarithmic one it
  // climbs quickly through the bottom and slowly through the levels.
  function reanchorFlood() {
    const F = tw.flood;
    const f = F.level == null ? 0 : F.curve.at(F.level);
    F.t0 = performance.now() - f * floodClockOpts().rise * 1000;
    F.clock = f * floodClockOpts().rise;
    F.lastDraw = 0;
  }

  // One frame of the rise. True when the scene needs drawing.
  function floodTick(now) {
    const F = tw.flood;
    if (!F || F.none || !floodAnimating()) return false;
    if (now - F.lastDraw < 1000 / FLOOD_FPS) return false;
    F.lastDraw = now;
    // A frame's time can be a moment before the clock was set (it is when the
    // frame began); that is the start, not the end of the last cycle.
    F.clock = Math.max(0, (now - F.t0) / 1000);
    const moved = setFloodLevel(F.curve.of(FloodStages.cycle(F.clock, floodClockOpts())));
    if (now - F.lastLine >= 1000 / FLOOD_LINE_HZ) { F.lastLine = now; syncFloodReading(); }
    return moved;
  }

  // ── the flood line, under the stage, and the pill on it ──
  // "moderate", "the 1% AEP": a level as the reading names it.
  function floodLevelName(l) { return l.kind === 'aep' ? `the ${l.label}` : l.label.toLowerCase(); }
  // Below the first level the water is named by the level it has yet to reach.
  function floodFirst(F) { return F.lad.levels.find(l => l.rank != null) || null; }

  // "on the gauge", or — for heights borrowed from another gauge and laid
  // over this channel — "over the channel": the gauge they are on is not here.
  function floodGaugeWord(F) { return F && F.lad.borrowed ? 'over the channel' : 'on the gauge'; }

  function floodNowText() {
    const F = tw.flood;
    if (!F || F.none || F.level == null) return '';
    const g = F.lad.ahdZero != null ? `${(F.level - F.lad.ahdZero).toFixed(1)} m ${floodGaugeWord(F)}, ` : '';
    const first = floodFirst(F);
    const where = F.band ? `past ${floodLevelName(F.band)}` : first ? `below ${floodLevelName(first)}` : 'below the first level';
    return `water ${g}${F.level.toFixed(2)} m AHD — ${where}`;
  }

  // The pill's few words: how high, and the band — "10.0 m · moderate".
  function floodBrief() {
    const F = tw.flood;
    if (!F || F.none || F.level == null) return '';
    const h = F.lad.ahdZero != null ? `${(F.level - F.lad.ahdZero).toFixed(1)} m` : `${F.level.toFixed(2)} m AHD`;
    const first = floodFirst(F);
    const band = F.band ? (F.band.kind === 'aep' ? F.band.label : F.band.label.toLowerCase())
                        : first ? `below ${first.kind === 'aep' ? first.label : first.label.toLowerCase()}` : 'below';
    return `${h} · ${band}`;
  }

  // The pill on the stage, top left: for a station with no levels of its own
  // and some to borrow, the offer — on a phone's map, where the line has no
  // row, it is the only way to ask. Where there is water, the scale below is
  // the water's control and the pill stands down.
  function syncFloodPill() {
    const el = document.getElementById('twin-flood-pill');
    if (!el) return;
    const F = tw.flood;
    const offer = !!(F && F.none && sc.terrain && canBorrow());
    if (el.hidden !== !offer) el.hidden = !offer;
    if (!offer) return;
    if (el.dataset.mode !== 'borrow') {
      el.dataset.mode = 'borrow';
      el.innerHTML = '<span aria-hidden="true">🌊</span><span class="twin-flood-pill-text"> No flood levels here — borrow…</span>';
      el.title = 'No flood heights are recorded for this station that can be put on its ground. Use a nearby station\'s?';
    }
  }

  // ── the scale on the stage ──
  // The water's control, stood up the left of the stage: ⏸ or ▶ and how high
  // at its head, and under it a track from 0 m on the gauge at the foot to the
  // highest level at the head — the water filling it in its colour — with a
  // mark at every level, to scale, and its name beside it. Labels are moved
  // off their marks only as far as they must be not to sit on one another
  // (FloodStages.scale), a line joining each to its mark; where the stage is
  // too short for them all, the least of them give way and keep their mark.
  // Press a name and the water is held at that level; press or drag on the
  // track and it follows the pointer, taking hold of a level within a few
  // pixels of its mark; the arrow keys move it, Page Up and Page Down go
  // level to level, Home and End to 0 m and the top. Anything but ▶ holds it
  // still.
  const SCALE_GAP  = 18;       // px between two labels' middles: a line of --fs-xs and a hair
  const SCALE_SNAP = 6;        // px: a drag this near a level's mark takes that level

  // Beside the head, the track's measure: one toggle, Log, pressed for the
  // logarithmic track and not for the linear one. A toggle and not a Lin|Log
  // pair, and beside the head rather than under the track, because both of
  // those cost what a phone's stage has least of — the head's width, which
  // the reading needs, and the track's height, which the names do.
  function floodScaleHtml() {
    return `<div class="twin-flood-scale" id="twin-flood-scale" role="group" aria-label="Flood levels" hidden>
            <div class="twin-scale-top">
              <div class="twin-scale-head">
                <button type="button" class="twin-scale-play" id="twin-scale-play" data-flood="scale-play" onclick="DigitalTwin.toggleFloodAnim()"><span class="twin-scale-play-icon" aria-hidden="true">⏸</span><span class="sr-only">Pause the rise</span></button>
                <span class="twin-scale-now" id="twin-scale-now"></span>
              </div>
              <button type="button" class="twin-scale-log" id="twin-scale-log" aria-pressed="false" onclick="DigitalTwin.toggleFloodScale()"
                      title="Logarithmic scale: measured down from the highest level, so the levels crowded near the top have room and the rise slows through them. Off, the scale is linear — every metre the same height">Log</button>
            </div>
            <div class="twin-scale-body" id="twin-scale-body">
              <div class="twin-scale-track" id="twin-scale-track" role="slider" tabindex="0" aria-orientation="vertical"
                   aria-label="Water level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
                   title="Drag to move the water; Page Up and Page Down go level to level">
                <span class="twin-scale-water" aria-hidden="true"></span>
                <span class="twin-scale-marks" id="twin-scale-marks" aria-hidden="true"></span>
                <span class="twin-scale-thumb" aria-hidden="true"></span>
              </div>
              <svg class="twin-scale-leaders" id="twin-scale-leaders" aria-hidden="true" focusable="false"></svg>
              <div class="twin-scale-labels" id="twin-scale-labels"></div>
            </div>
          </div>`;
  }

  // Whether the scale is up: water to control, shown, and a scene to show it in.
  function floodScaleOn() {
    const F = tw.flood;
    return !!(F && !F.none && F.level != null && S().flood && sc.flood);
  }

  // Every level said in full, for a label's title and the track's reading.
  function floodLevelWords(l, onGauge) {
    const F = tw.flood, b = F && F.lad.borrowed;
    const where = floodGaugeWord(F);
    // Whose a borrowed level is, and what it was on the gauge it came from.
    const who = b ? (b.self ? 'its own gauge' : `${b.name}'s gauge`) : '';
    const lent = !b ? '' : b.mode === 'ahd'
      ? (l.lent != null ? ` — ${Number(l.lent).toFixed(2)} m on ${who}` : ` — ${b.self ? 'its own' : `${b.name}'s`}, in m AHD`)
      : ` — ${l.gauge != null ? `${Number(l.gauge).toFixed(2)} m ` : ''}on ${who}, laid over this channel`;
    if (l.kind === 'peak') {
      const when = l.date || 'a date HDB does not give';
      const rec = l.recorded != null ? `${Number(l.recorded).toFixed(2)} m on ${b ? who : 'the gauge'} as it then stood; ` : '';
      return `${l.highest ? 'The highest flood recorded' : 'A flood recorded'}, ${when}: ${rec}${FloodStages.ahdText(l.ahd)}`
           + (onGauge && l.gauge != null ? `, ${FloodStages.gaugeText(l.gauge, where)}${b ? '' : ' today'}` : '')
           + (!b ? '' : b.mode === 'ahd' ? ', as lent in m AHD' : ', laid over this channel');
    }
    return `${FloodStages.levelText(l)}${l.kind !== 'aep' && l.gauge != null ? `${b ? ` ${where}` : ''} (${FloodStages.ahdText(l.ahd)})` : l.gauge != null ? ` (${FloodStages.gaugeText(l.gauge, where)})` : ''}${lent}`;
  }

  // The marks, the labels and the lines between them, for the ladder on
  // screen, the stage's height now and the track's measure. Again whenever
  // any of them changes. `from` is where the marks and names were on the
  // track of the other measure (setScaleMode): they are drawn there first and
  // glide to their new places, the lines to them faded out while they move —
  // so that a scale turning logarithmic by itself is seen to open out, rather
  // than to be a different picture from one frame to the next.
  function layoutFloodScale(from = null) {
    const box = document.getElementById('twin-flood-scale');
    if (!box) return;
    const on = floodScaleOn();
    if (box.hidden !== !on) {
      box.hidden = !on;
      // Up: its names are too, for their few seconds on a phone.
      if (on) scaleNamesShow();
    }
    if (!on) return;
    // Up, and untouched: in a few seconds, logarithmic if the levels warrant it.
    armScaleAuto();
    const F = tw.flood, pal = sc.flood.palette;
    const stage = document.getElementById('twin-stage'), hud = document.getElementById('twin-hud');
    // The foot of the scale clears the hint along the foot of the stage, however
    // many lines the stage's width makes of it.
    if (stage && hud) stage.style.setProperty('--twin-hud-h', `${hud.offsetHeight}px`);
    const body = document.getElementById('twin-scale-body'), track = document.getElementById('twin-scale-track');
    const marks = document.getElementById('twin-scale-marks'), labels = document.getElementById('twin-scale-labels');
    const svg = document.getElementById('twin-scale-leaders');
    if (!body || !track || !marks || !labels || !svg) return;
    const px = Math.max(0, track.clientHeight);
    const onGauge = F.lad.levels.every(l => l.gauge != null);
    const pos = FloodStages.scale(F.lad.levels, { lo: F.start, hi: F.top, px, gap: SCALE_GAP, k: F.logK });
    F.scale = { px, onGauge, pos, k: F.logK };
    const byKey = new Map(F.lad.levels.map(l => [l.key, l]));
    // Where each is drawn first: its old place when it is gliding from one.
    const glide = !!from && !reducedMotion();
    const markAt = p => (glide && from.has(p.key) ? from.get(p.key).mark : p.mark);
    const nameAt = p => (glide && from.has(p.key) && from.get(p.key).at != null ? from.get(p.key).at : p.at);
    marks.innerHTML = pos.map(p => {
      const l = byKey.get(p.key);
      return `<span class="twin-scale-mark${l.kind === 'peak' ? ' is-peak' : ''}" data-level="${escAttr(p.key)}" style="--y:${markAt(p).toFixed(1)}px;--sw:${escAttr(FloodStages.colourOf(l, pal))}"></span>`;
    }).join('');
    // The labels are buttons: each holds the water at its level. The one it is
    // held at says so (aria-pressed), and so does its look.
    const had = labels.contains(document.activeElement) ? document.activeElement.dataset.flood : null;
    labels.innerHTML = pos.filter(p => p.shown).map(p => {
      const l = byKey.get(p.key);
      const words = floodLevelWords(l, onGauge);
      return `<button type="button" class="twin-scale-label${l.kind === 'peak' ? ' is-peak' : ''}" data-flood="${escAttr(p.key)}" aria-pressed="false"
                style="--y:${nameAt(p).toFixed(1)}px" onclick="DigitalTwin.floodAt('${escAttr(p.key)}')"
                title="Hold the water at ${escAttr(words)}" aria-label="Hold the water at ${escAttr(words)}"><span class="twin-flood-sw" style="--sw:${escAttr(FloodStages.colourOf(l, pal))}" aria-hidden="true"></span>${esc(FloodStages.scaleText(l, onGauge))}</button>`;
    }).join('');
    if (had) { const back = labels.querySelector(`[data-flood="${CSS.escape(had)}"]`); if (back) back.focus(); }
    if (glide) {
      // Drawn where they were; now, with the transition on, where they go.
      box.classList.add('is-rescaling');
      void box.offsetWidth;
      const want = new Map(pos.map(p => [p.key, p]));
      for (const el of marks.children) el.style.setProperty('--y', `${want.get(el.dataset.level).mark.toFixed(1)}px`);
      for (const el of labels.children) el.style.setProperty('--y', `${want.get(el.dataset.flood).at.toFixed(1)}px`);
      clearTimeout(tw.glideTimer);
      tw.glideTimer = setTimeout(() => { tw.glideTimer = 0; box.classList.remove('is-rescaling'); }, SCALE_GLIDE_MS);
    }
    // A line from each mark out to its label — straight across where the label
    // is at its mark, a dog-leg where it had to move.
    const b = body.getBoundingClientRect(), t = track.getBoundingClientRect();
    const x0 = t.right - b.left, y0 = t.top - b.top;
    const lx = labels.getBoundingClientRect().left - b.left;
    svg.setAttribute('width', String(Math.round(b.width)));
    svg.setAttribute('height', String(Math.round(b.height)));
    svg.innerHTML = pos.filter(p => p.shown).map(p => {
      const ya = y0 + p.mark, yb = y0 + p.at, xm = x0 + Math.max(2, (lx - x0) * 0.45);
      return `<polyline points="${x0.toFixed(1)},${ya.toFixed(1)} ${xm.toFixed(1)},${ya.toFixed(1)} ${lx.toFixed(1)},${yb.toFixed(1)}"/>`;
    }).join('');
    syncFloodScale();
  }

  // What changes as the water moves: the water in the track, the thumb, ⏸ or
  // ▶, the reading, which label it is held at — cheap enough for every frame.
  function syncFloodScale() {
    const box = document.getElementById('twin-flood-scale');
    if (!box || box.hidden) return;
    const F = tw.flood;
    if (!F || F.none || F.level == null || !sc.flood) return;
    const f = F.curve.at(F.level);
    const track = document.getElementById('twin-scale-track');
    scaleWater();
    // The measure the track is in: Log pressed, or not.
    const logBtn = document.getElementById('twin-scale-log');
    const logOn = F.logK != null ? 'true' : 'false';
    if (logBtn && logBtn.getAttribute('aria-pressed') !== logOn) logBtn.setAttribute('aria-pressed', logOn);
    if (track) {
      const pct = String(Math.round(f * 100));
      if (track.getAttribute('aria-valuenow') !== pct) track.setAttribute('aria-valuenow', pct);
      const words = floodNowText();
      if (track.getAttribute('aria-valuetext') !== words) track.setAttribute('aria-valuetext', words);
    }
    const anim = floodAnimating();
    const play = document.getElementById('twin-scale-play');
    if (play) {
      const verb = anim ? 'Pause the rise' : 'Play the rise';
      const [icon, sr] = play.children;
      if (icon && icon.textContent !== (anim ? '⏸' : '▶')) icon.textContent = anim ? '⏸' : '▶';
      if (sr && sr.textContent !== verb) sr.textContent = verb;
      const title = `${verb} — ${floodNowText()}`;
      if (play.title !== title) play.title = title;
    }
    const now = document.getElementById('twin-scale-now');
    if (now) {
      const brief = floodBrief();
      if (now.textContent !== brief) now.textContent = brief;
    }
    const held = !anim && typeof S().floodHold === 'string' ? S().floodHold : null;
    for (const el of document.querySelectorAll('#twin-scale-labels .twin-scale-label')) {
      const on = el.dataset.flood === held ? 'true' : 'false';
      if (el.getAttribute('aria-pressed') !== on) el.setAttribute('aria-pressed', on);
      el.classList.toggle('is-band', !!(F.band && el.dataset.flood === F.band.key));
    }
  }

  // A place on the track, as a fraction of the way from 0 m to the top in
  // metres — which is what the water is held at (floodHold) whatever the
  // track's measure, so that turning the scale never moves the water.
  function heightFraction(t) {
    const F = tw.flood;
    return F.top > F.start ? Math.max(0, Math.min(1, (F.curve.of(t) - F.start) / (F.top - F.start))) : 1;
  }

  // Where on the track a pointer is, as a fraction of the way from 0 m to the
  // top — or, within SCALE_SNAP of a level's mark, that level.
  function scaleAt(clientY) {
    const F = tw.flood, track = document.getElementById('twin-scale-track');
    if (!F || F.none || !track) return null;
    const r = track.getBoundingClientRect();
    if (!(r.height > 0)) return null;
    const y = Math.max(0, Math.min(r.height, clientY - r.top));
    const pos = F.scale && F.scale.pos;
    if (pos) {
      let best = null;
      for (const p of pos) if (Math.abs(p.mark - y) <= SCALE_SNAP && (!best || Math.abs(p.mark - y) < Math.abs(best.mark - y))) best = p;
      if (best) return { key: best.key };
    }
    return { f: heightFraction(1 - y / r.height) };
  }

  // The water held where the scale was pressed or dragged to, without the
  // round trip through the settings a drag would make at every pixel: the
  // choice is written once, when the pointer lets go.
  function scrubFlood(at, final) {
    const F = tw.flood, s = S();
    if (!F || F.none || !at) return;
    const wasAnim = floodAnimating();
    s.flood = true; s.floodAnim = false;
    s.floodHold = at.key != null ? String(at.key) : Math.max(0, Math.min(1, at.f));
    if (wasAnim || final) { if (final) saveSettings(); settleFlood(); return; }
    setFloodLevel(floodHoldLevel());
    syncFloodReading();
    requestFrame();
  }

  // The keys on the track: a hundredth of the way, a tenth with Shift — of
  // the track, so a step is the same distance on either measure — level to
  // level, and the ends.
  function scaleKey(e) {
    const F = tw.flood;
    if (!F || F.none || F.level == null) return;
    const t = F.curve.at(F.level);
    const levels = F.lad.levels;
    let at = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') at = { f: heightFraction(Math.min(1, t + (e.shiftKey ? 0.1 : 0.01))) };
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') at = { f: heightFraction(Math.max(0, t - (e.shiftKey ? 0.1 : 0.01))) };
    else if (e.key === 'Home') at = { f: 0 };
    else if (e.key === 'End') at = { f: 1 };
    else if (e.key === 'PageUp') { const l = levels.find(x => x.ahd > F.level + 1e-6); at = l ? { key: l.key } : { f: 1 }; }
    else if (e.key === 'PageDown') { const l = levels.slice().reverse().find(x => x.ahd < F.level - 1e-6); at = l ? { key: l.key } : { f: 0 }; }
    if (!at) return;
    e.preventDefault();
    scrubFlood(at, true);
  }

  // ── the scale's measure ──
  // Linear or logarithmic: the track put in the other measure, the marks and names
  // gliding to their new places, the water where it was and the rise going on
  // from it. `auto` is the scale turning itself (armScaleAuto); anything else
  // is the operator's choice, kept for the station for the session.
  function setScaleMode(mode, auto = false) {
    const F = tw.flood;
    if (!F || F.none) return;
    const k = mode === 'log' ? F.fit.k : null;
    if (!auto) {
      F.scaleChosen = true;
      clearScaleAuto();
      const st = currentStation();
      if (st) floodScales.set(st.id, mode === 'log' ? 'log' : 'lin');
    }
    if (F.logK === k) { syncFloodScale(); return; }
    const from = F.scale ? new Map(F.scale.pos.map(p => [p.key, p])) : null;
    F.logK = k;
    F.curve = FloodStages.curve(F.start, F.top, k);
    if (floodAnimating() && F.level != null) reanchorFlood();
    layoutFloodScale(from);
    syncFloodReading();
    requestFrame();
  }

  // Once the scale is up, and only where nothing has chosen for it yet: a few
  // seconds on, the logarithmic track if the levels warrant it. Once a build.
  function armScaleAuto() {
    const F = tw.flood;
    if (!F || F.none || F.scaleChosen || F.scaleAutoDone || F.logK != null || !F.fit.warrant) return;
    if (scaleAutoMs == null || tw.scaleAutoTimer) return;
    tw.scaleAutoTimer = setTimeout(() => {
      tw.scaleAutoTimer = 0;
      if (tw.flood !== F || F.scaleChosen || !floodScaleOn()) return;
      F.scaleAutoDone = true;
      setScaleMode('log', true);
    }, scaleAutoMs);
  }

  function clearScaleAuto() {
    if (tw.scaleAutoTimer) { clearTimeout(tw.scaleAutoTimer); tw.scaleAutoTimer = 0; }
  }

  // Whether the station on screen could borrow levels it lacks: it has none
  // it can draw, and somebody near it (or its own classes) has some.
  function canBorrow() {
    const F = tw.flood, st = currentStation();
    return !!(F && F.none && !F.lad.borrowed && !F.lad.offGround && tw.ground && tw.ground.datum === 'AHD' && st && nearestDonors(st, 1).length);
  }

  function floodLineHtml() {
    const F = tw.flood;
    if (typeof FloodStages === 'undefined' || !tw.ground || !F) return '';
    const st = currentStation();
    if (F.none) {
      if (F.lad.offGround) {
        return `<span class="twin-flood-lead"><span aria-hidden="true">🌊</span> Flood levels:</span> not drawn — the ground here is in ${esc(F.lad.offGround)} and could not be put into AHD, the datum every level is in. `
             + `<button type="button" class="link-btn" data-flood="rebuild" onclick="DigitalTwin.rebuild()">Ask again</button>`
             + (F.lad.borrowed ? ` · <button type="button" class="link-btn" data-flood="unborrow" onclick="DigitalTwin.stopBorrowingFlood()">Stop borrowing</button>` : '');
      }
      if (F.lad.borrowed) {
        return `<span class="twin-flood-lead"><span aria-hidden="true">🌊</span> Flood levels:</span> ${esc(F.lad.borrowed.name)}'s leave no water to draw here. <button type="button" class="link-btn" data-flood="borrow" onclick="DigitalTwin.borrowFlood()">Pick another station…</button> · <button type="button" class="link-btn" data-flood="unborrow" onclick="DigitalTwin.stopBorrowingFlood()">Stop borrowing</button>`;
      }
      if (!canBorrow()) return '';
      return `<span class="twin-flood-lead"><span aria-hidden="true">🌊</span> Flood levels:</span> none recorded for ${esc(st ? st.name : 'this station')} that can be put on its ground. `
           + `<button type="button" class="link-btn" data-flood="borrow" onclick="DigitalTwin.borrowFlood()">Use a nearby station's levels…</button>`;
    }
    const on = !!S().flood, anim = floodAnimating();
    const pal = (sc.flood && sc.flood.palette) || floodPalette();
    const from = F.lad.borrowed;
    const lead = from
      ? `<span class="twin-flood-lead"><span aria-hidden="true">🌊</span> Flood levels, ${from.self ? 'its own, over its channel' : `borrowed from ${esc(from.name)}`} (<button type="button" class="link-btn" data-flood="borrow" onclick="DigitalTwin.borrowFlood()">change</button> · <button type="button" class="link-btn" data-flood="unborrow" onclick="DigitalTwin.stopBorrowingFlood()">stop</button>):</span>`
      : `<span class="twin-flood-lead"><span aria-hidden="true">🌊</span> Flood levels:</span>`;
    // The datum, in a word on the line and in full on hover — the notes and
    // the Scene panel say it in full for every reader.
    const dw = floodDatumWords(F.lad);
    const datum = `<span class="twin-flood-datum" title="${escAttr(dw ? `${dw.from} ${dw.carried} ${dw.here}` : `Every height in metres AHD, on ${groundDatumWords(tw.ground)}.`)}">in ${esc(dw ? dw.brief : 'm AHD')}</span>`;
    if (!on) return `${lead} ${datum} · the water is hidden. <button type="button" class="link-btn" data-flood="show" onclick="DigitalTwin.setFlood(true)">Show it</button>`;
    const levels = F.lad.levels.map(l => `<button type="button" class="link-btn twin-flood-level" data-flood="${escAttr(l.key)}" onclick="DigitalTwin.floodAt('${escAttr(l.key)}')"
                 title="Hold the water at ${escAttr(from ? floodLevelWords(l, F.lad.levels.every(x => x.gauge != null)) : `${FloodStages.levelText(l)}${l.kind !== 'aep' && l.gauge != null ? ` (${FloodStages.ahdText(l.ahd)})` : ''}`)}"><span class="twin-flood-sw" style="--sw:${escAttr(FloodStages.colourOf(l, pal))}" aria-hidden="true"></span>${esc(FloodStages.levelText(l))}</button>`);
    return `${lead} ${datum} <button type="button" class="link-btn twin-flood-play" data-flood="play" onclick="DigitalTwin.toggleFloodAnim()">${anim ? '⏸ Pause the rise' : '▶ Play the rise'}</button>
      <span class="twin-flood-now" id="twin-flood-now">${esc(floodNowText())}</span> · ${levels.join(' · ')}
      · <button type="button" class="link-btn" data-flood="hide" onclick="DigitalTwin.setFlood(false)">Hide the water</button>`;
  }

  // The line is drawn again whenever a setting changes — which is what a press
  // on it does — so the focus is put back on the control that was pressed, or
  // on the one that took its place (Hide the water becomes Show it).
  //
  // Twice: over the stage, cut to one line in the Stations map, and whole in
  // the side panel's 🧊 pane, where every one of its buttons can be reached
  // (the reading's id is the pane's own there).
  function refreshFloodLine() {
    for (const [id, pane] of [['twin-flood', false], ['twin-pane-flood', true]]) {
      const el = document.getElementById(id);
      if (el) {
        const had = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.flood : null;
        const html = pane ? (tw.live ? floodLineHtml().replace('id="twin-flood-now"', 'id="twin-pane-flood-now"') : '') : floodLineHtml();
        el.innerHTML = html;
        el.hidden = !html;
        // The whole line as its tooltip (the Stations map cuts it to one), less
        // the reading, which moves on while the tooltip would stand still.
        const F = tw.flood;
        el.title = !html ? '' : F.none ? el.textContent.replace(/\s+/g, ' ').trim() : (S().flood
          ? `Flood levels${F.lad.borrowed ? ` (${F.lad.borrowed.self ? 'its own, over its channel' : `borrowed from ${F.lad.borrowed.name}`})` : ''}: ${F.lad.levels.map(l => FloodStages.levelText(l)).join(' · ')}. ${(() => { const w = floodDatumWords(F.lad); return w ? `${w.from} ${w.carried} ${w.here}` : `Every height in metres AHD, on ${groundDatumWords(tw.ground)}.`; })()} A level surface through the patch: a real flood slopes downstream, so the far edges of a wide patch are a guide, not a map.`
          : 'Flood levels: the water is hidden.');
        if (had) {
          const back = el.querySelector(`[data-flood="${CSS.escape(had)}"]`) || el.querySelector('button');
          if (back) back.focus();
        }
      }
    }
    syncFloodPill();
    layoutFloodScale();
    refreshBorrowLine();
  }

  function syncFloodReading() {
    for (const id of ['twin-flood-now', 'twin-pane-flood-now']) {
      const el = document.getElementById(id);
      if (el) el.textContent = floodNowText();
    }
    const F = tw.flood;
    const slider = document.getElementById('twin-flood-level');
    if (slider && F && !F.none && F.level != null && document.activeElement !== slider) {
      slider.value = String(Math.round(1000 * F.curve.at(F.level)));
    }
    const out = document.getElementById('twin-flood-out');
    if (out) out.textContent = F && !F.none && F.level != null ? `${F.level.toFixed(2)} m AHD` : '';
    syncFloodPill();
    syncFloodScale();
  }

  // The panel's controls, where the setting changed somewhere else (the line).
  function syncFloodControls() {
    const s = S();
    const on = document.getElementById('twin-flood-on');
    if (on) on.checked = !!s.flood;
    const anim = document.getElementById('twin-flood-anim');
    if (anim) { anim.checked = floodAnimating(); anim.disabled = !s.flood; }
    const slider = document.getElementById('twin-flood-level');
    if (slider) slider.disabled = !s.flood || !(tw.flood && !tw.flood.none);
    refreshFloodLine();
  }

  // The Scene panel's word on borrowing: offered where the station has no
  // levels of its own, said where levels are borrowed.
  function borrowLineHtml() {
    const F = tw.flood;
    if (F && F.lad && F.lad.borrowed) {
      const b = F.lad.borrowed;
      const w = floodDatumWords(F.lad);
      return `${b.self ? 'Its own classes, over its channel' : `Levels borrowed from <strong>${esc(b.name)}</strong>, ${esc(fmtKm(b.km))} ${esc(compassWord(b.bearing))}`}. `
           + `<button type="button" class="link-btn" onclick="DigitalTwin.borrowFlood()">Change…</button> · <button type="button" class="link-btn" onclick="DigitalTwin.stopBorrowingFlood()">Stop borrowing</button>`
           + (w ? `<span class="twin-datum-chain" role="group" aria-label="Datums of the borrowed levels"><span><strong>From</strong> ${esc(w.from)}</span><span><strong>Carried</strong> ${esc(w.carried)}</span><span><strong>Here</strong> ${esc(w.here)}</span></span>` : '');
    }
    if (F && F.lad && F.lad.offGround) return `No flood levels drawn: the ground is in ${esc(F.lad.offGround)} and could not be put into AHD.`;
    if (canBorrow()) return `No flood heights recorded here. <button type="button" class="link-btn" onclick="DigitalTwin.borrowFlood()">Use a nearby station's levels…</button>`;
    if (F && !F.none) return `Every height in metres AHD, on ${esc(groundDatumWords(tw.ground))}.`;
    return '';
  }
  function refreshBorrowLine() {
    const el = document.getElementById('twin-borrow-line');
    if (el) el.innerHTML = borrowLineHtml();
  }

  function floodPanelHtml() {
    const s = S();
    const F = tw.flood;
    const none = !F || F.none;
    return `
        <fieldset class="twin-flood-set">
          <legend>Flood water</legend>
          <label class="check-label"><input type="checkbox" id="twin-flood-on" ${s.flood ? 'checked' : ''} onchange="DigitalTwin.setFlood(this.checked)"><span>Water at the station's flood levels — minor, moderate and major, the AEP floods, the peaks it has reached</span></label>
          <label class="check-label"><input type="checkbox" id="twin-flood-anim" ${floodAnimating() ? 'checked' : ''} ${s.flood ? '' : 'disabled'} onchange="DigitalTwin.setFloodAnim(this.checked)"><span>Animate it: rising from 0 m on the gauge to the highest level, and again</span></label>
          <label class="twin-field">Water level <span class="small" id="twin-flood-out"></span>
            <input type="range" id="twin-flood-level" min="0" max="1000" step="1" value="1000" ${s.flood && !none ? '' : 'disabled'}
                   oninput="DigitalTwin.setFloodFraction(this.value / 1000)">
          </label>
          <p class="small twin-borrow-line" id="twin-borrow-line">${borrowLineHtml()}</p>
        </fieldset>`;
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
    if (rig.level !== 'ground') {
      rig.level = 'ground'; rig.climb = 0;
      const p = toLocal(rig.px, rig.pz);
      setRigLocal(p.x, Math.max(p.z, (tw.model && tw.model.ladder ? tw.model.ladder.foot : 0) + 1.2));
    }
    rig.pointLatch = false; rig.pointing = false;
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
      let feet = standY(rig.px, rig.pz);
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

  // Whether the pointer this page is driven by is a finger: the hint's words
  // follow it (syncModeUi).
  function coarsePointer() {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  // ── a phone's stage, kept clear ──
  // On a phone the stage is the map's size, which is not much of it, and two
  // things on it are words: the scale's names, and the hint along its foot.
  // So there both stand down after a few seconds — the names to the marks on
  // the track they point from, the hint to the "?" it starts with — and come
  // back for as long again when asked: the names by a tap on the track (or
  // focus reaching one of them), the hint by the "?". Anywhere else both stay
  // up, as they always have. The scale's foot stops above the "?" there rather
  // than above the whole hint, so the hint showing lies over the foot of the
  // scale for its few seconds and nothing is laid out again for it.
  const COMPACT_MS = 5000;
  let compactMs = COMPACT_MS;    // the check's seam: sooner, or never (null)

  // A phone: a finger, on a screen whose short side is a phone's — `xs`,
  // whichever way up it is held. Not a tablet, whose stage has the room.
  function compactStage() {
    const xs = typeof BREAKPOINTS !== 'undefined' ? BREAKPOINTS.xs : 560;
    return coarsePointer() && Math.min(window.innerWidth, window.innerHeight) <= xs;
  }

  function clearCompactTimers() {
    if (tw.hudTimer) { clearTimeout(tw.hudTimer); tw.hudTimer = 0; }
    if (tw.scaleTimer) { clearTimeout(tw.scaleTimer); tw.scaleTimer = 0; }
  }

  // The stage told which it is, and what stands on it made to agree: a
  // phone's gets the "?", and whatever is up there has its clock running;
  // anything else has everything up and no clock. Asked on every build (the
  // stage's resize observer answers once as it starts), every mode and every
  // resize — a stage is new each time it is mounted, a rebuild stops the
  // clocks under one that is not (stop()), and a window can stop being a
  // phone's under an emulator.
  function syncCompact() {
    const stage = document.getElementById('twin-stage');
    if (!stage) return;
    const compact = compactStage(), was = stage.classList.contains('is-compact');
    const hud = document.getElementById('twin-hud'), box = document.getElementById('twin-flood-scale');
    if (was !== compact) {
      stage.classList.toggle('is-compact', compact);
      const q = document.getElementById('twin-hud-q');
      if (q) q.hidden = !compact;
    }
    if (!compact) {
      if (!was) return;
      clearCompactTimers();
      if (hud) hud.classList.remove('is-folded');
      if (box) box.classList.remove('is-quiet');
      return;
    }
    if (compactMs == null) return;
    if (hud && !hud.classList.contains('is-folded') && !tw.hudTimer) tw.hudTimer = setTimeout(hudFold, compactMs);
    if (box && !box.hidden && !box.classList.contains('is-quiet') && !tw.scaleTimer) tw.scaleTimer = setTimeout(scaleNamesQuiet, compactMs);
  }

  // The hint in full: for COMPACT_MS on a phone, then back to its "?".
  function hudShow() {
    if (tw.hudTimer) { clearTimeout(tw.hudTimer); tw.hudTimer = 0; }
    const hud = document.getElementById('twin-hud'), q = document.getElementById('twin-hud-q');
    if (hud) hud.classList.remove('is-folded');
    if (q) { q.setAttribute('aria-expanded', 'true'); q.title = 'Hide how to move the view'; }
    if (compactMs != null && compactStage()) tw.hudTimer = setTimeout(hudFold, compactMs);
  }

  function hudFold() {
    if (tw.hudTimer) { clearTimeout(tw.hudTimer); tw.hudTimer = 0; }
    if (!compactStage()) return;
    const hud = document.getElementById('twin-hud'), q = document.getElementById('twin-hud-q');
    if (hud) hud.classList.add('is-folded');
    if (q) { q.setAttribute('aria-expanded', 'false'); q.title = 'How to move the view'; }
  }

  // The "?": the hint for another few seconds, or — pressed while it is up —
  // put away now.
  function toggleHud() {
    const hud = document.getElementById('twin-hud');
    if (hud && !hud.classList.contains('is-folded')) hudFold();
    else hudShow();
  }

  // The scale's names and the lines to them: up for COMPACT_MS on a phone,
  // then gone but for the marks on the track. Called when the scale comes
  // up, and by everything that is a hand on it (attachControls).
  function scaleNamesShow() {
    if (tw.scaleTimer) { clearTimeout(tw.scaleTimer); tw.scaleTimer = 0; }
    const box = document.getElementById('twin-flood-scale');
    if (!box) return;
    box.classList.remove('is-quiet');
    if (compactMs != null && compactStage()) tw.scaleTimer = setTimeout(scaleNamesQuiet, compactMs);
  }

  function scaleNamesQuiet() {
    tw.scaleTimer = 0;
    const box = document.getElementById('twin-flood-scale'), track = document.getElementById('twin-scale-track');
    if (!box || !compactStage()) return;
    // Not from under a finger on the track: its letting go starts the clock
    // again.
    if (track && track.classList.contains('is-dragging')) return;
    box.classList.add('is-quiet');
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
    syncPointUi();
    const hud = document.getElementById('twin-hud');
    if (hud) {
      // A touch screen's words on a touch screen: there is no wheel, no right
      // button and no Escape on a phone, and the hint that named them was the
      // most text on its screen. What a finger does is what attachControls()
      // does with one or two pointers: one orbits (or looks, in the POV), two
      // pinch to zoom and slide to pan (or walk).
      const touch = coarsePointer();
      const ladder = tw.model && tw.model.ladder ? ' Walk into the ladder to climb it.' : '';
      const spots = tw.photos && tw.photos.spots && tw.photos.spots.length;
      hud.textContent = rig.mode === 'walk'
        ? (touch
          ? `POV at eye height: drag to look, slide two fingers up to walk and down to step back, 👁 to leave.${ladder}${spots ? ' Tap a 📷 for its photos.' : ''}`
          : `POV at eye height: W A S D or the arrow keys move, drag to look, Shift to hurry, Space points, Esc to leave.${ladder}${spots ? ' Walk up to a 📷 and press Enter for its photos.' : ''}`)
        : tw.hooks
          ? (touch ? 'Drag to orbit, pinch to zoom, two fingers to pan; tap the ground for its height, a 📷 for its photos. ← Map for the map.'
                   : 'Drag to orbit, wheel to zoom, right-drag to pan; click the ground for its height, a 📷 for its photos. Wheel out past the edge, or Esc, for the map.')
          : (touch ? 'Drag to orbit, pinch to zoom, two fingers to pan. Tap the ground for its height, a 📷 for the photos taken there.'
                   : 'Drag to orbit, wheel to zoom, right-drag or Shift-drag to pan. Click the ground for its height, a 📷 for the photos taken there.');
      // A new mode says its words in full — on a phone for a few seconds,
      // then back to the "?" (see "a phone's stage, kept clear").
      if (hud.dataset.mode !== rig.mode) {
        hud.dataset.mode = rig.mode;
        hudShow();
      }
    }
    syncCompact();
    layoutFloodScale();
    syncCanvasName();
    requestFrame();
  }

  // ── the controls ───────────────────────────────────────────────────────────
  function attachControls() {
    const cv = sc.canvas;
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); sc.off.push(() => el.removeEventListener(ev, fn, opts)); };

    on(cv, 'contextmenu', e => e.preventDefault());

    // The flood scale's track: pressed, it takes the water there; dragged,
    // the water follows; let go, the choice is kept. On a phone with the
    // scale's names stood down (scaleNamesShow), a tap on the track brings
    // them back and does nothing else — the water stays where it was, since
    // the tap was for the names — and a drag from it moves the water as any
    // drag does. Every hand on the scale gives the names their few seconds
    // again.
    const track = document.getElementById('twin-scale-track');
    if (track) {
      let scrub = null, peek = null;
      const stop = e => {
        if (scrub !== e.pointerId) return false;
        scrub = null;
        track.classList.remove('is-dragging');
        return true;
      };
      const begin = e => {
        scrub = e.pointerId;
        track.classList.add('is-dragging');
      };
      on(track, 'pointerdown', e => {
        if (e.button !== 0 || !floodScaleOn()) return;
        e.preventDefault();
        // Asked before the focus below, whose focusin brings the names back.
        const box = document.getElementById('twin-flood-scale');
        const quiet = !!(box && box.classList.contains('is-quiet'));
        try { track.setPointerCapture(e.pointerId); } catch (_) {}
        track.focus({ preventScroll: true });
        scaleNamesShow();
        if (quiet) { peek = { id: e.pointerId, y: e.clientY }; return; }
        begin(e);
        scrubFlood(scaleAt(e.clientY), false);
      });
      on(track, 'pointermove', e => {
        if (peek && peek.id === e.pointerId && Math.abs(e.clientY - peek.y) > 4) { peek = null; begin(e); }
        if (scrub === e.pointerId) scrubFlood(scaleAt(e.clientY), false);
      });
      // Letting go is a hand on the scale too — a press held past the clock
      // has had the names go from under it.
      on(track, 'pointerup', e => {
        if (peek && peek.id === e.pointerId) { peek = null; scaleNamesShow(); return; }
        if (stop(e)) { scrubFlood(scaleAt(e.clientY), true); scaleNamesShow(); }
      });
      on(track, 'pointercancel', e => {
        if (peek && peek.id === e.pointerId) { peek = null; scaleNamesShow(); return; }
        if (stop(e)) { saveSettings(); settleFlood(); scaleNamesShow(); }
      });
      on(track, 'keydown', e => { scaleNamesShow(); scaleKey(e); });
    }
    // Focus reaching the scale — a keyboard, a screen reader walking it — is
    // a hand on it too, and a finger pressing a name (which takes no focus on
    // a phone) is another.
    const scaleBox = document.getElementById('twin-flood-scale');
    if (scaleBox) on(scaleBox, 'focusin', scaleNamesShow);
    const scaleNames = document.getElementById('twin-scale-labels');
    if (scaleNames) on(scaleNames, 'pointerdown', scaleNamesShow);

    on(cv, 'pointerdown', e => {
      if (e.button !== 0 && e.button !== 2) return;
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      rig.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, b: e.button, moved: false });
      // A press on the pin being moved takes hold of it, instead of the
      // camera (see "the pin being moved").
      if (rig.pointers.size === 1 && e.button === 0 && pinArmedHere() && pinUnder(e.clientX, e.clientY)) {
        rig.pinDrag = e.pointerId;
        cv.classList.add('is-dragging-pin');
      }
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
      if (rig.pinDrag === e.pointerId) {
        if (p.moved) pinTo(e.clientX, e.clientY, true);
        requestFrame();
        return;
      }
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
      // The end of a drag of the pin: where it was let go is where it is. A
      // press on it that never moved is not a move — the ray through the
      // post lands on the ground behind it, a hair from where it stands.
      if (rig.pinDrag === e.pointerId) {
        rig.pinDrag = null;
        cv.classList.remove('is-dragging-pin');
        if (p && p.moved && e.type === 'pointerup') pinTo(e.clientX, e.clientY, false);
        return;
      }
      // A field photo's marker first: it stands on the ground, and a click on
      // it is about the photos, not the height under them. Then, with the pin
      // being moved in this patch, the ground is where the pin goes.
      if (p && !p.moved && p.b === 0 && e.type === 'pointerup' && !pickPhoto(e)) {
        if (pinArmedHere()) { pinTo(e.clientX, e.clientY, false); pickGround(e); }
        else pickGround(e);
      }
    };
    on(cv, 'pointerup', up);
    on(cv, 'pointercancel', up);

    // Over a photo marker the pointer says it is something to click. A class
    // rather than an inline style, for the design system's rule (#109).
    let hoverAt = 0;
    on(cv, 'pointermove', e => {
      if (rig.pointers.size || (!sc.photos && !showsPin())) return;
      const now = performance.now();
      if (now - hoverAt < 60) return;
      hoverAt = now;
      cv.classList.toggle('is-over-photo', !!sc.photos && photoAt(e.clientX, e.clientY) >= 0);
      cv.classList.toggle('is-over-pin', pinArmedHere() && pinUnder(e.clientX, e.clientY));
    });
    on(cv, 'pointerleave', () => cv.classList.remove('is-over-photo', 'is-over-pin'));

    on(cv, 'wheel', e => {
      e.preventDefault();
      if (rig.mode === 'walk') walkStep(-e.deltaY * 0.01, 0);
      else {
        // Embedded in the Stations map, a wheel-out past the widest the
        // orbit goes is a zoom out of the twin altogether: the map takes over
        // again, one zoom level out (map-twin.js).
        const atLimit = rig.radius >= maxRadius() - 1e-6;
        dolly(e.deltaY * 0.0015);
        if (atLimit && e.deltaY > 0 && tw.hooks && tw.hooks.leave) { tw.hooks.leave('wheel'); return; }
      }
      requestFrame();
    }, { passive: false });

    // The keys, on the canvas only — it has to be focused, so a keyboard user
    // reaches them by tabbing to it and nothing on the page loses a key it
    // was using. Escape in walk mode is claimed (preventDefault), which is
    // what stands the phone drawer's own Escape down (init.js).
    const WALK_KEYS = ['w', 'a', 's', 'd', 'q', 'e', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift', ' '];
    const keyName = k => (k.length === 1 ? k.toLowerCase() : k);
    on(cv, 'keydown', e => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const k = keyName(e.key);
      if (rig.mode === 'walk') {
        if (k === 'Escape') { e.preventDefault(); leaveWalk(); return; }
        // Standing at a field photo's marker, Enter looks at what was taken there.
        if (k === 'Enter' && tw.photoNear >= 0) { e.preventDefault(); rig.keys.clear(); openPhotoSpot(tw.photoNear); return; }
        if (WALK_KEYS.includes(k)) { e.preventDefault(); rig.keys.add(k); requestFrame(); }
        return;
      }
      if (k === 'Escape' && tw.hooks && tw.hooks.leave) { e.preventDefault(); tw.hooks.leave('escape'); return; }
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
  // north. The ladder, the deck and the hatch are the station's, so they are
  // asked in its frame (toLocal), where the ladder faces its own north —
  // the scene's north turned by `sc.turn`.
  function setRigLocal(x, z) {
    const w = toWorld(x, z);
    rig.px = w.x; rig.pz = w.z;
  }
  function walkStep(f, r) {
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    const nx = rig.px + f * sy + r * cy, nz = rig.pz - f * cy + r * sy;
    const m = tw.model;
    const turn = sc.turn || 0;
    const lcy = Math.cos(rig.yaw - turn);   // facing the station's own north: 1
    if (m && m.deck && rig.level === 'deck') {
      if (rig.climbLatch && f > 0) return;   // just arrived: W has to be pressed again
      const lim = m.deck.half - 0.14;
      const n = toLocal(nx, nz);
      if (n.z > lim && Math.abs(n.x) < m.ladder.halfW && f > 0 && lcy < -0.5) {
        rig.level = 'ladder'; rig.climb = ladderHeight();
        setRigLocal(m.ladder.x, ladderStandZ(rig.climb)); rig.pitch = -0.35;
        // W is still held from the walk out: it must not put the visitor
        // straight back on the deck. Released and pressed again, it does.
        rig.climbLatch = true;
        return;
      }
      setRigLocal(Math.max(-lim, Math.min(lim, n.x)), Math.max(m.deck.front, Math.min(lim, n.z)));
      return;
    }
    const oz = toLocal(rig.px, rig.pz).z;
    rig.px = nx; rig.pz = nz;
    const lim = (tw.ground ? tw.ground.half : 100) - 1;
    rig.px = Math.max(-lim, Math.min(lim, rig.px));
    rig.pz = Math.max(-lim, Math.min(lim, rig.pz));
    if (m && m.ladder && rig.level === 'ground' && f > 0 && lcy > 0.5) {
      // The foot of the ladder is a gate from its feet to 0.9 m south of
      // them (in the station's frame): a step that ends past the gate's
      // south side having started south of the feet — one that lands inside
      // it, or crosses it, however long a slow frame makes it — takes hold.
      const L = m.ladder, gate = L.foot + 0.9;
      const p = toLocal(rig.px, rig.pz);
      const inLine = Math.abs(p.x - L.x) < L.halfW + 0.15;
      if (inLine && p.z < gate && oz > L.foot) {
        rig.level = 'ladder'; rig.climb = 0;
        setRigLocal(L.x, L.stand); rig.yaw = turn; rig.pitch = 0.35;
      }
    }
  }

  // Where the visitor stands, north–south in the station's frame, `climb`
  // metres up the ladder: it leans, so every metre up is a quarter-metre
  // nearer the mast.
  function ladderStandZ(climb) {
    const L = tw.model && tw.model.ladder;
    return L ? L.stand - Math.max(0, climb) * (L.run || 0) : 0;
  }

  // A step up or down the ladder; at the top the deck, at the bottom the ground.
  function climbStep(dy) {
    const m = tw.model;
    if (!m || !m.ladder) { rig.level = 'ground'; rig.climb = 0; return; }
    rig.climb += dy;
    const h = ladderHeight();
    setRigLocal(m.ladder.x, ladderStandZ(Math.min(rig.climb, h)));
    if (rig.climb >= h) {
      if (rig.climbLatch) { rig.climb = h; return; }
      // On the grating at the hatch, facing the cabinet — which is 1.2 m
      // tall and a metre off, so the eye is tilted down into it — and held
      // there until W is pressed afresh, so the climb does not run on into
      // the cabinet.
      rig.level = 'deck'; rig.climb = 0; rig.climbLatch = true;
      setRigLocal(0, m.deck.half - 0.3); rig.yaw = sc.turn || 0; rig.pitch = -0.55;
    } else if (rig.climb <= 0) {
      rig.level = 'ground'; rig.climb = 0;
      setRigLocal(m.ladder.x, m.ladder.foot + 0.6); rig.pitch = -0.06;
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
                      + `${(h - tw.ground.h0) >= 0 ? '+' : ''}${(h - tw.ground.h0).toFixed(2)} m against the station.`
                      + (typeof TwinCadastre !== 'undefined' ? TwinCadastre.pickWords(x, z) : '');
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
    const pointing = rig.mode === 'walk' && (rig.keys.has(' ') || rig.pointLatch);
    if (pointing !== rig.pointing) { rig.pointing = pointing; sc.dirty = true; }
    if (animateDoors(frameDt(now))) sc.dirty = true;
    if (animateAvatars(now)) sc.dirty = true;
    if (updatePhotoNear()) sc.dirty = true;
    if (floodTick(now)) sc.dirty = true;
    lastTick = now;
    // The visitor's own pose, every frame; what leaves the room is gated there.
    if (typeof TwinPresence !== 'undefined' && sc.terrain) TwinPresence.publish(localPose());
    if (!sc.dirty) return;
    sc.dirty = false;
    if (!sc.renderer || !sc.scene) return;
    placeCamera();
    updateLocalLaser();
    scalePhotoBadges();
    sc.scene.background = skyColour();
    if (sc.scene.fog) sc.scene.fog.color.copy(sc.scene.background);
    syncSky();
    sc.renderer.render(sc.scene, sc.camera);
    // The lot numbers and road names, written over the frame just drawn.
    if (typeof TwinCadastre !== 'undefined') TwinCadastre.frame();
    tw.frames++;
  }

  function startLoop() {
    if (!sc.raf && tw.live) sc.raf = requestAnimationFrame(tick);
  }

  // ── the lines over the stage, folded ───────────────────────────────────────
  // The status, the paths, the photos, the water, who else is here and the
  // notes are a line each, and on a map a phone's height tall six lines and a
  // bar were most of the map. So they fold under the bar, behind one button:
  // open when the twin opens — the build is saying what it could and could
  // not get, which is worth a read — and folded INFO_FOLD_MS later, unless
  // the operator has taken the fold in hand (pressed it, either way: from
  // then on it stays as they left it) or is reading it (the pointer over it
  // or the focus in it, which puts the fold off until they are not). Opening
  // again is one press; the button counts the notes while they are folded,
  // so a warning is never folded out of sight without a mark saying so.
  //
  // "When the twin opens" is a new station, or the first build after a
  // teardown — leaving the tab or the map's overlay — and not a rebuild of
  // the same station at another patch size, which keeps the fold where it is.
  // Folded, the status line is out of the accessibility tree with its box, so
  // what it says from then on goes to the app's own live region instead.
  const INFO_FOLD_MS = 10000;
  const INFO_RETRY_MS = 2500;   // put off while being read: look again this often
  let infoFoldMs = INFO_FOLD_MS;   // the check's seam: sooner, or never (null)

  function infoEls() {
    return { box: document.getElementById('twin-info'), btn: document.getElementById('twin-info-toggle') };
  }
  function infoBusy() {
    const { box } = infoEls();
    if (!box) return false;
    return box.contains(document.activeElement) || box.matches(':hover');
  }
  function syncInfo() {
    const { box, btn } = infoEls();
    const open = tw.infoOpen !== false;
    if (box) box.hidden = !open;
    if (!btn) return;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = open ? 'Fold the lines over the view away — the status, the paths, the photos, the water and the notes'
                     : 'Show the lines over the view — the status, the paths, the photos, the water and the notes';
    const icon = btn.querySelector('.twin-info-icon');
    if (icon) icon.textContent = open ? '▴' : '▾';
    const badge = btn.querySelector('.twin-info-badge');
    const n = tw.notes.length;
    if (badge) {
      badge.hidden = open || !n;
      badge.textContent = n ? `⚠ ${n}` : '';
    }
    const sr = btn.querySelector('.sr-only');
    if (sr) sr.textContent = `${open ? 'Hide' : 'Show'} the details${!open && n ? ` (${n} note${n === 1 ? '' : 's'})` : ''}`;
  }
  function clearInfoTimer() {
    if (tw.infoTimer) { clearTimeout(tw.infoTimer); tw.infoTimer = 0; }
  }
  function armInfoFold(ms) {
    clearInfoTimer();
    if (infoFoldMs == null || tw.infoPinned) return;
    tw.infoTimer = setTimeout(() => {
      tw.infoTimer = 0;
      if (tw.infoPinned || tw.infoOpen === false) return;
      if (infoBusy()) { armInfoFold(INFO_RETRY_MS); return; }
      tw.infoOpen = false;
      syncInfo();
      if (sc.renderer) { fitRenderer(); requestFrame(); }
    }, ms);
  }
  // A new station on screen (or the first build after a teardown): open, and
  // fold again later.
  function infoLoaded(stationId) {
    if (tw.infoFor === stationId) { syncInfo(); return; }
    tw.infoFor = stationId;
    tw.infoOpen = true;
    tw.infoPinned = false;
    syncInfo();
    armInfoFold(infoFoldMs);
  }
  function toggleInfo() {
    clearInfoTimer();
    tw.infoPinned = true;
    tw.infoOpen = tw.infoOpen === false;
    syncInfo();
    if (sc.renderer) { fitRenderer(); requestFrame(); }
  }

  // ── the build ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    tw.status = text;
    const el = document.getElementById('twin-status');
    if (el) { el.textContent = text; el.title = text; }
    // Folded, the line's box is out of the tree and its live region with it.
    if (tw.infoOpen === false && el && text) announce(text);
  }

  function setNotes(notes) {
    tw.notes = notes;
    const el = document.getElementById('twin-notes');
    if (!el) return;
    el.innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
    // Inside the map the list is folded under a one-line summary (map-twin.js)
    // that says how many there are; on the tab it is the list itself.
    const fold = el.closest('.map-twin-notes');
    (fold || el).hidden = !notes.length;
    if (fold) el.hidden = false;
    const count = document.getElementById('twin-notes-count');
    if (count) count.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
    // Folded, the fold's button carries the count instead.
    syncInfo();
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
    infoLoaded(st ? st.id : null);
    // A pin being moved from this tab alone (no map under it) belongs to the
    // station it was armed on; another station on the stage ends it.
    if (typeof MapMovePin !== 'undefined' && MapMovePin.armed() && !MapMovePin.onMap()
        && (!st || MapMovePin.armed() !== st.id)) MapMovePin.cancel();
    setNotes([]);
    // Nothing to build: the last station's scene and numbers must not stand
    // in for this one's, so they go, and every panel says so.
    const nothing = (status, placeholder) => {
      tw.ground = null; tw.image = null; tw.elvis = null; tw.picked = null; tw.origin = null;
      tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false; tw.statusBase = ''; tw.model = null;
      tw.photos = null;
      tw.flood = null;
      tw.neighbours = null; tw.bridges = null; tw.bridgesFound = null; tw.tier = null;
      if (typeof TwinPresence !== 'undefined') { try { TwinPresence.leave(); } catch (_) {} }
      clearScene();
      requestFrame();
      refreshSiteLine();
      setStatus(status);
      showPlaceholder(placeholder);
      refreshTruth(); refreshTable(); syncCanvasName(); syncExportButton(); refreshAttrib(); refreshPathsLine(); refreshPeersLine();
      refreshPhotosLine(); syncPhotoPrompt(); refreshFloodLine();
      const pk = document.getElementById('twin-pick');
      if (pk) pk.textContent = '';
    };
    if (!st) { nothing('Pick a station to build its twin.', '<p>No station chosen. Find one in the 🧊 pane of the side panel, or zoom the map to one.</p>'); return; }
    if (!located(st)) { nothing(`${st.name} has no position, so there is no ground to stand it on.`, `<p><strong>${esc(st.name)}</strong> has no coordinates. Give it a position in the station editor and the twin can be built.</p>`); return; }
    const gl = webglOk();
    const size0 = S().size;
    const notes = [];
    // Where the bridges are, asked first and over more than the patch: a bridge
    // that runs to the patch's edge or stands just past it widens the patch to
    // hold it (fitBridges). The State answers in a second or so; the build
    // waits for it no longer than BRIDGE_FIT_WAIT and outside Queensland, where
    // the answer is Overpass's and slow, not at all.
    const askP = bridgesFor(bridgeQueryBox(st.lat, st.lon, size0));
    tw.fit = { size0, size: size0, widened: false, held: 0, tooLong: 0 };

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
    if (S().fitBridges && insideBox(bridgeQueryBox(st.lat, st.lon, size0), QLD_DEM_BOX)) {
      const found = await Promise.race([askP, new Promise(res => setTimeout(() => res(null), BRIDGE_FIT_WAIT))]);
      if (seq !== tw.seq) return;
      if (found && found.source === 'qld' && !found.failed) tw.fit = fitBridges(found, Number(st.lat), Number(st.lon), size0);
    }
    const box = patchBox(st.lat, st.lon, tw.fit.size);
    const imageP = imageryFor(box);
    // The SLS says which stations a person reads — asked for alongside the
    // ground, which takes longer, so the station is not held up by it.
    const slsP = typeof SLS !== 'undefined' && SLS.ensureData ? SLS.ensureData().then(() => true, () => false) : Promise.resolve(false);
    // What the State has flown over the station, for the sharp drape.
    const tierP = imageryAt(st.lat, st.lon).catch(() => null);
    const ground = await groundFor(box);
    if (seq !== tw.seq) return;
    const slsOk = await slsP;
    if (seq !== tw.seq) return;
    if (!slsOk) notes.push('The Service Level Specification could not be read, so whether this station is read by hand or by a radio is decided from its record alone.');
    tw.ground = ground;
    tw.origin = ground ? { lat: Number(st.lat), lon: Number(st.lon) } : null;
    tw.image = null;
    tw.elvis = null;
    tw.horizon = null; tw.horizonImages = null; tw.horizonPending = false; tw.statusBase = ''; tw.model = null;

    if (!ground) {
      // The last station's scene must not stand in for this one's: cleared,
      // its room left, and the stage says why it is empty.
      if (typeof TwinPresence !== 'undefined') { try { TwinPresence.leave(); } catch (_) {} }
      tw.photos = null;
      tw.flood = null;
      clearScene();
      requestFrame();
      refreshPhotosLine(); syncPhotoPrompt(); refreshFloodLine();
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
      notes.push(ground.geoid
        ? `The tiles are heights above the EGM96 geoid, not AHD: ${geoidWords(ground.geoid)}, so the ground is put into AHD by that much — the datum the gauge zeros, the flood levels and the surveyed heights are in.`
        : `The tiles are heights above the EGM96 geoid, not AHD, and how far apart the two are here could not be had (${ground.geoidError || 'no answer'}), so the ground is left in EGM96 — up to 2 m from AHD — and no level in AHD is stood on it. Press Rebuild to ask again.`);
    } else if (ground.filled) {
      notes.push(`${ground.filled.toLocaleString()} of ${(N * N).toLocaleString()} samples were outside the State's data and were filled from ~30 m terrain tiles, `
        + (ground.geoid ? `put into AHD from EGM96 (${geoidWords(ground.geoid)}).`
                        : `in EGM96: how far that is from AHD here could not be had (${ground.geoidError || 'no answer'}), so the fill may stand up to 2 m off the State's ground.`));
    }
    if (tw.fit && tw.fit.widened) {
      notes.push(`The patch is ${tw.fit.size} m, not the ${tw.fit.size0} m asked for: a bridge runs to its edge or stands just past it, and the ground is widened to hold it whole so its deck has ground under both ends. The samples are ${ground.sample_m.toFixed(1)} m apart as a result; the Scene panel can turn this off.`);
    }
    if (tw.fit && tw.fit.tooLong) {
      notes.push(`${tw.fit.tooLong === 1 ? 'A bridge runs' : `${tw.fit.tooLong} bridges run`} past what a patch of up to ${Math.min(SIZES[SIZES.length - 1], Math.round(tw.fit.size0 * BRIDGE_FIT_MAX))} m can hold whole, so ${tw.fit.tooLong === 1 ? 'it is' : 'they are'} drawn only as far as the patch goes, level with the bank that is in it.`);
    }
    if (ground.unfilled) notes.push(`${ground.unfilled.toLocaleString()} samples could not be read from any source and are drawn at the station's own height.`);

    if (lib && ensureRenderer()) {
      clearScene();
      buildSky();
      buildTerrain();
      buildStation(st);
      const said = stationNote(tw.model);
      if (said) notes.push(said);
      buildNeighbours(st);
      buildFigure();
      buildLabel(st);
      buildPaths(st);
      setFog(false);
      resetOrbit();
      presenceJoin(st);
      loadPhotos(st, seq);
      loadBridges(st, seq, notes, askP);
      loadCadastre(seq);
      notes.push(...buildFlood(st));
      // A pin being moved, armed before this build — on the map before the
      // twin was opened, or on this station before a rebuild.
      movePinChanged();
      showPlaceholder('');
      startLoop();
      requestFrame();
    } else if (lib) {
      buildFlood(st);
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
    // And sharp round the station, where the State has flown finer than the
    // drape — the pin's own place, if one is being moved.
    tw.tier = await tierP;
    if (seq !== tw.seq) return;
    const pinNow = sc.movepin && sc.movepin.group.visible ? sc.movepin.pin.position : null;
    sharpenAt(pinNow ? pinNow.x : 0, pinNow ? pinNow.z : 0).then(done => {
      if (!done || seq !== tw.seq || !tw.tier) return;
      tw.statusBase += `; ${resWords(tw.tier.res_m)} (${tw.tier.label}${tw.tier.when ? `, ${tw.tier.when}` : ''}) round ${pinNow ? 'the pin' : 'the station'}`;
      setStatus(`${tw.statusBase}.`);
    });
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
           + `${(g.max - g.min).toFixed(1)} m of relief, ${modelWords(tw.model)} at the station and a 1.75 m figure beside it`
           + (sc.horizon ? `, the country round it to ${HORIZON_M / 1000} km under a sky` : '')
           + (tw.flood && !tw.flood.none && sc.flood && S().flood ? `, and water at its flood levels, up to ${FloodStages.ahdText(tw.flood.top)}. ` : '. ')
           + (rig.mode === 'walk' ? 'POV: W A S D move, drag looks, Escape leaves.'
                                  : 'Drag to orbit, arrow keys turn, plus and minus zoom, F walks, T looks down, R resets.');
    }
    cv.setAttribute('aria-label', name);
  }

  // ── the panels ─────────────────────────────────────────────────────────────
  function fmtM(v, dp = 1) { return isFinite(v) ? `${v.toFixed(dp)} m` : '—'; }
  // "AHD = EGM96 − 0.34 m here": the geoid's answer, said the way round a
  // height is converted.
  function geoidWords(geo) {
    return `AHD = EGM96 ${geo.m < 0 ? '−' : '+'} ${Math.abs(geo.m).toFixed(2)} m here (${geo.model || 'AUSGeoid2020 less EGM96'})`;
  }

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
      rows.push(['Ground at the pin', `${fmtM(g.h0, 2)} ${g.datum} <span class="small">(${g.source === 'qld' ? 'State DTM' : g.geoid ? 'SRTM tiles, from EGM96' : 'SRTM tiles'})</span>`]);
      if (g.geoid || g.egm96) {
        rows.push(['Datum', g.geoid ? `${esc(geoidWords(g.geoid))} <span class="small">— the tiles${g.source === 'qld' ? ' that filled the State\'s gaps' : ''} put into AHD by it</span>`
                                    : `<span class="small">EGM96${g.source === 'qld' ? ' where the tiles filled the State\'s gaps' : ''}: AHD less EGM96 could not be had here — ${esc(g.geoidError || 'no answer')}</span>`]);
      }
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
        : g && g.geoid
          ? 'Terrain tiles are heights above the EGM96 geoid, put into AHD here by AUSGeoid2020 less EGM96 (AHD = EGM96 − 2.07 m to + 0.64 m across the stations) — a datum made right, not a survey: the tiles are still ~30 m.'
          : 'Terrain tiles are heights above the EGM96 geoid — up to 2 m from AHD over Australia, and not a survey.'}
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
        ${tw.live && tw.hooks
          ? `<button type="button" class="link-btn" onclick="MapTwin.leave()" title="Put the twin away and give the map back, as it was">← Map</button>`
          : located(st) ? `<button type="button" class="link-btn" onclick="DigitalTwin.openStation('${escAttr(st.id)}')" title="Open this station's twin on the Stations map">🧊 Open its twin →</button>` : ''}
      </p>`;
  }

  // Exploring together: the switch, the three colours a visitor is seen in,
  // and the name they are seen as (twin-presence.js).
  function avatarPanelHtml() {
    if (typeof TwinPresence === 'undefined') return '';
    const a = TwinPresence.avatar();
    return `
        <label class="check-label"><input type="checkbox" ${TwinPresence.enabled() ? 'checked' : ''} onchange="TwinPresence.setEnabled(this.checked)"><span>Explore together: see who else is at this station, and be seen by them</span></label>
        <div class="twin-avatar-fields">
          <label class="twin-field twin-colour">Hat <input type="color" value="${escAttr(a.hat)}" onchange="TwinPresence.setAvatar({ hat: this.value })"></label>
          <label class="twin-field twin-colour">Shirt <input type="color" value="${escAttr(a.shirt)}" onchange="TwinPresence.setAvatar({ shirt: this.value })"></label>
          <label class="twin-field twin-colour">Pants <input type="color" value="${escAttr(a.pants)}" onchange="TwinPresence.setAvatar({ pants: this.value })"></label>
        </div>
        <p class="small">You appear to the others as <strong>${esc(a.name)}</strong>${a.signedIn ? '' : ' — sign in to appear by name'}. Hold Space in the POV, or press Point, to point where you are looking.</p>`;
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
        <div id="twin-tower-field">${towerFieldHtml()}</div>
        <label class="twin-field">Vertical exaggeration <span class="small" id="twin-exag-out">${s.exag.toFixed(1)}×</span>
          <input type="range" id="twin-exag" min="1" max="3" step="0.1" value="${s.exag}"
                 oninput="DigitalTwin.setExag(this.value)">
        </label>
        <label class="check-label"><input type="checkbox" ${s.imagery ? 'checked' : ''} onchange="DigitalTwin.setImagery(this.checked)"><span>Drape the aerial imagery</span></label>
        ${typeof TwinCadastre !== 'undefined' ? TwinCadastre.panelHtml() : ''}
        <label class="check-label"><input type="checkbox" ${s.fitBridges ? 'checked' : ''} onchange="DigitalTwin.setFitBridges(this.checked)"><span>Widen the patch to hold a bridge at its edge</span></label>
        <label class="check-label"><input type="checkbox" ${s.horizon ? 'checked' : ''} onchange="DigitalTwin.setHorizon(this.checked)"><span>The horizon: far ground to ${HORIZON_M / 1000} km, a sky and haze (a few more requests)</span></label>
        ${floodPanelHtml()}
        ${avatarPanelHtml()}
        <label class="check-label"><input type="checkbox" ${s.wire ? 'checked' : ''} onchange="DigitalTwin.setWire(this.checked)"><span>Show the mesh</span></label>
        <label class="check-label"><input type="checkbox" ${s.figure ? 'checked' : ''} onchange="DigitalTwin.setFigure(this.checked)"><span>Figure beside the pole (1.75 m)</span></label>
        <label class="check-label"><input type="checkbox" ${s.label ? 'checked' : ''} onchange="DigitalTwin.setLabel(this.checked)"><span>Name over the pole</span></label>
      </div>
      <p class="small">The pole is 2.000 m tall and 300 mm across, the figure 1.75 m, at every exaggeration — they are the ruler; only the ground stretches.</p>`;
  }

  // The tower's platform height for the station on screen, when it is a tower:
  // the station's own (0040), changed here by whoever may edit the station and
  // saved to the database, as Move pin saves a position. Anybody else sees it
  // and why they cannot change it.
  function towerCanSave() {
    return typeof stationSaveFields === 'function' && typeof dbCanWrite === 'function' && dbCanWrite()
      && typeof editorWritesGoToDatabase === 'function' && editorWritesGoToDatabase();
  }
  function refreshTowerField() {
    const el = document.getElementById('twin-tower-field');
    if (el) el.innerHTML = towerFieldHtml();
  }
  function towerFieldHtml() {
    const st = currentStation();
    if (!st || !(tw.model ? tw.model.structure === 'tower' : stationKind(st).structure === 'tower')) return '';
    const spec = towerSpec(st), can = towerCanSave();
    const why = can ? (spec.recorded ? 'Saved on the station, for everybody.' : 'Not recorded on the station, so drawn at the 3.0 m default. Picking one saves it, for everybody.')
      : typeof editorWritesGoToDatabase === 'function' && !editorWritesGoToDatabase() ? 'The station list on screen is not from the datastore, so this cannot be saved.'
      : 'Sign in as an editor to change it.';
    return `<label class="twin-field">Tower platform height
          <select id="twin-tower" onchange="DigitalTwin.setTower(this.value)" ${can ? '' : 'disabled'}>
            ${Object.values(TOWER_TYPES).map(t => `<option value="${t.key}" ${t.key === spec.key ? 'selected' : ''}>${t.h.toFixed(1)} m platform, ${FOOTING * 1000} × ${FOOTING * 1000} footing${t.key === TOWER_DEFAULT && !spec.recorded ? ' (default)' : ''}</option>`).join('')}
          </select>
          <span class="small" id="twin-tower-msg">${esc(why)}</span>
        </label>`;
  }

  // The 🧊 pane in the Stations tab's side panel (app.js, dockSkeleton): what
  // the Digital Twin tab's left column was, beside the one twin there is now —
  // the one inside the Stations map (map-twin.js). The station and the finder,
  // the scene's settings, the ground truth, the camera's two moves the map's
  // bar has no room for, the .glb, and the ground as numbers. Written once,
  // with the skeleton, and kept true after by id (syncPane and the refreshes
  // that already write these ids), never rewritten wholesale: the find box
  // has a caret in it.
  function paneHtml() {
    S();
    return `
      <h2 class="sr-only">Digital twin — the station, the scene's settings, the ground truth and the .glb</h2>
      <div class="stack twin-pane">
      <div class="panel">
        <div class="panel-header"><h2>Digital twin</h2></div>
        <p class="small twin-pane-lead" id="twin-pane-lead">${paneLeadHtml()}</p>
        <div id="twin-station-line">${stationLineHtml()}</div>
        <label class="twin-field">Open a station's twin
          <input type="search" id="twin-find" value="${esc(tw.query)}" autocomplete="off" spellcheck="false"
                 placeholder="name, station number or ALERT address"
                 oninput="DigitalTwin.setQuery(this.value)">
        </label>
        <div id="twin-hits">${hitsHtml()}</div>
        <div class="button-group twin-pane-actions">
          <button type="button" id="twin-top" onclick="DigitalTwin.topView()" ${tw.live ? '' : 'disabled'} title="Straight down on the patch">⬇ Top-down</button>
          <button type="button" id="twin-rebuild" onclick="DigitalTwin.rebuild()" ${tw.live ? '' : 'disabled'} title="Fetch the ground and the imagery again">⟳ Rebuild</button>
        </div>
        <p class="small twin-pick" id="twin-pick"></p>
        <p class="small twin-photos" id="twin-pane-photos" hidden></p>
        <p class="small twin-flood" id="twin-pane-flood" hidden></p>
      </div>
      <div class="panel" id="twin-panel-scene">${scenePanelHtml()}</div>
      <div class="panel">
        <div class="panel-header"><h2>Ground truth</h2></div>
        <div id="twin-truth">${truthHtml()}</div>
        <details class="twin-details">
          <summary>The ground under the station, as numbers</summary>
          <div id="twin-table">${tableHtml()}</div>
        </details>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Take it further</h2></div>
        <div class="button-group">
          <button type="button" id="twin-export" onclick="DigitalTwin.exportGlb()" ${tw.ground && tw.live ? '' : 'disabled'}
                  title="Download the scene — ground, imagery, pole and figure — as a glTF binary Blender opens with File → Import → glTF 2.0">⬇ Download .glb for Blender</button>
        </div>
        <p class="small">Metres, y up, origin on the ground at the pole; the file's header carries the station's coordinates and datum. Blender turns it z-up on import. Point cloud data, when it is ingested, will land in this same scene beside the mesh.</p>
      </div>
      ${paneHelpHtml()}
      </div>`;
  }

  // How the twin works, at the pane's foot: what was the Digital Twin tab's
  // help (core.js, TWIN_HELP — authored HTML, like HELP), folded.
  function paneHelpHtml() {
    if (typeof TWIN_HELP === 'undefined') return '';
    const h = TWIN_HELP;
    const href = u => typeof docUrl === 'function' ? docUrl(u) : u;
    return `<details class="panel twin-details twin-help">
        <summary>How the twin works</summary>
        <p class="small">${h.summary}</p>
        <ul class="small twin-help-list">${h.watch.map(w => `<li>${w}</li>`).join('')}</ul>
        ${(h.links || []).map(l => `<p class="small"><a href="${escAttr(href(l.href))}" target="_blank" rel="noopener">${esc(l.label)}</a></p>`).join('')}
      </details>`;
  }

  // The pane's first line: which twin these settings are standing beside, or
  // how to open one.
  function paneLeadHtml() {
    const st = currentStation();
    if (tw.live && tw.hooks && st) return `The twin of <strong>${esc(st.name)}</strong> is open on the map. These settings apply to it as you change them.`;
    return `No twin is open. Pick a station below, or zoom the map to ${typeof MapTwin !== 'undefined' ? MapTwin.zoom : 17} on one and press 🧊 Open the digital twin. The settings here are kept for the next one.`;
  }

  // The pane brought up to date with the twin: on its showing, and whenever
  // a twin is opened or put away. The scene panel is rewritten only when
  // nobody is in it.
  function syncPane() {
    const lead = document.getElementById('twin-pane-lead');
    if (!lead) return;
    lead.innerHTML = paneLeadHtml();
    const line = document.getElementById('twin-station-line');
    if (line) line.innerHTML = stationLineHtml();
    // The hits and the scene panel are rewritten only when nobody is in them:
    // the hit just pressed, or a setting being dragged, keeps its focus.
    const a = document.activeElement;
    const hits = document.getElementById('twin-hits');
    if (hits && !(a && hits.contains(a))) hits.innerHTML = hitsHtml();
    const scene = document.getElementById('twin-panel-scene');
    if (scene && !(a && scene.contains(a))) scene.innerHTML = scenePanelHtml();
    for (const id of ['twin-top', 'twin-rebuild']) {
      const b = document.getElementById(id);
      if (b) b.disabled = !tw.live;
    }
    if (!tw.live) { const pk = document.getElementById('twin-pick'); if (pk) pk.textContent = ''; }
    refreshTruth(); refreshTable(); syncExportButton(); refreshPhotosLine(); refreshFloodLine();
  }

  // The fold's button, for the map overlay's bar:
  // an arrow, a word that goes on a phone (the overlay's .map-twin-label rule),
  // the notes counted while folded, and a name for a reader. syncInfo() keeps
  // all four true after it is drawn.
  function infoToggleHtml() {
    const open = tw.infoOpen !== false;
    return `<button type="button" class="twin-info-toggle" id="twin-info-toggle" aria-controls="twin-info"
              aria-expanded="${open ? 'true' : 'false'}" onclick="DigitalTwin.toggleInfo()"
              title="${open ? 'Fold the lines over the view away' : 'Show the lines over the view'}"><span class="twin-info-icon" aria-hidden="true">${open ? '▴' : '▾'}</span><span class="map-twin-label" aria-hidden="true"> Details</span><span class="twin-info-badge" aria-hidden="true" hidden></span><span class="sr-only">${open ? 'Hide' : 'Show'} the details</span></button>`;
  }

  // The stage — the canvas and what stands over it — for the Stations map's
  // overlay (map-twin.js), the one host there is. The ids are the ones every
  // refresh here writes to.
  //
  // Along its foot, whatever else is up, the caveat: everything in the view is
  // a model — the ground, the imagery on it, the station built from its record,
  // the water — and none of it a survey, a flood map or a forecast. In red, and
  // never folded away with the lines over the stage or a phone's hint: a
  // picture this convincing is one that gets screenshotted and passed round,
  // and the caveat has to go with it. One line at every width (the words
  // shorten with the stage — three lengths, CSS picks one), the whole of it for
  // a screen reader. No tooltip: it takes no pointer, so that a drag started
  // on it still turns the view, and a title nobody can hover is no title.
  const CAVEAT = 'Indicative modelling only. Everything in this view is modelled, not surveyed: the ground from '
    + 'elevation data, the imagery draped over it, the station as built from its record, and the flood water as '
    + 'a level surface at the recorded levels. It is not a flood map or a forecast — check anything that matters '
    + 'on site.';

  function caveatHtml() {
    return `<p class="twin-caveat" id="twin-caveat" role="note"><span class="twin-caveat-long" aria-hidden="true">⚠ Indicative modelling only — the ground, the station and the flood water are modelled, not surveyed. Not a flood map or a forecast.</span><span class="twin-caveat-mid" aria-hidden="true">⚠ Indicative modelling only — not a survey, a flood map or a forecast.</span><span class="twin-caveat-short" aria-hidden="true">⚠ Indicative modelling only</span><span class="sr-only">${esc(CAVEAT)}</span></p>`;
  }

  function stageHtml() {
    return `<div class="twin-stage" id="twin-stage">
          <canvas id="twin-canvas" tabindex="0" aria-label="Three-dimensional view. Nothing is built yet."></canvas>
          <div class="twin-compass" id="twin-compass" aria-hidden="true" style="--twin-heading:0deg">N</div>
          <button type="button" class="twin-flood-pill" id="twin-flood-pill" hidden onclick="DigitalTwin.floodPill()"></button>
          ${floodScaleHtml()}
          <p class="twin-hud" id="twin-hud">Drag to orbit, wheel to zoom, right-drag or Shift-drag to pan. Click the ground for its height.</p>
          <button type="button" class="twin-hud-q" id="twin-hud-q" aria-controls="twin-hud" aria-expanded="true"
                  aria-label="How to move the view" title="How to move the view" onclick="DigitalTwin.toggleHud()" hidden>?</button>
          ${caveatHtml()}
          <button type="button" class="twin-photo-prompt" id="twin-photo-prompt" hidden onclick="DigitalTwin.openNearPhotos()"></button>
          <div class="mn-movepin-panel twin-movepin-panel" id="twin-movepin-panel" role="group" aria-label="Move this station's pin" hidden></div>
          <div class="mn-movepin-panel twin-movepin-panel twin-orient-panel" id="twin-orient-panel" role="group" aria-label="Turn this station to the way it faces" hidden></div>
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
    if (tw.ground && tw.ground.geoid && typeof Geoid !== 'undefined') parts.push(Geoid.attribution);
    if (typeof TwinCadastre !== 'undefined') parts.push(TwinCadastre.attribution());
    return [...new Set(parts.filter(Boolean))].map(esc).join(' · ');
  }

  function refreshAttrib() {
    const el = document.getElementById('twin-attrib');
    if (el) { el.innerHTML = attribHtml(); el.title = el.textContent; }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  function stop() {
    // A pin being moved from the twin's own tab has nothing left to be moved
    // on; one armed on the map goes on there without the twin.
    if (typeof MapMovePin !== 'undefined' && MapMovePin.armed() && !MapMovePin.onMap()) MapMovePin.cancel();
    rig.pinDrag = null;
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
    tw.photos = null; tw.photoNear = -1;
    tw.flood = null;
    tw.neighbours = null; tw.bridges = null; tw.bridgesFound = null;
    rig.pointLatch = false; rig.pointing = false;
    // The next build is an opening: the lines open again, and fold again.
    clearInfoTimer();
    tw.infoFor = null;
    // …and a phone's hint and scale names have nothing left to put away, nor
    // the scale a measure to turn to.
    clearCompactTimers();
    clearScaleAuto();
    if (tw.glideTimer) { clearTimeout(tw.glideTimer); tw.glideTimer = 0; }
    if (typeof TwinPresence !== 'undefined') { try { TwinPresence.leave(); } catch (_) {} }
    // …and the side panel's pane says there is no twin open.
    syncPane();
  }

  function init() {
    registerTabTeardown('DigitalTwin', stop);
    // A render of the Stations tab that did not come through switchTab() — a
    // seed in the harness calling renderMain() — replaces the canvas under a
    // live renderer. Nothing may go on drawing into a node that is not in the
    // document, so that is a teardown first.
    if (sc.canvas && !document.contains(sc.canvas)) stop();
    // No twin up — a setting changed in the side panel's pane with nothing
    // open on the map: the setting is kept for the next one, and there is
    // nothing to build.
    if (!tw.hooks || !document.getElementById('twin-canvas')) { rerenderStationBits(); syncPane(); return; }
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
    const lead = document.getElementById('twin-pane-lead');
    if (lead) lead.innerHTML = paneLeadHtml();
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
        generator: 'Flood-Net digital twin',
        extras: {
          station_id: st ? st.id : null, station_name: st ? st.name : null,
          station_number: st ? (st.station_number || null) : null,
          origin: { lat: tw.origin ? tw.origin.lat : st ? st.lat : null, lon: tw.origin ? tw.origin.lon : st ? st.lon : null,
                    ground_m: g.h0, datum: g.datum, axes: 'x east, y up, z south; metres',
                    ...(g.geoid ? { ahd_less_egm96_m: Number(g.geoid.m.toFixed(3)), datum_from: 'EGM96 (terrain tiles), by AUSGeoid2020 less EGM96' } : {}) },
          ground: { source: g.source, sample_m: g.sample_m, size_m: g.size, exaggeration: S().exag,
                    attribution: g.attribution },
          imagery: tw.image && S().imagery ? { source: tw.image.source, attribution: tw.image.attribution } : null,
          pole: tw.model && (tw.model.structure === 'pole' || tw.model.structure === 'tower' || tw.model.structure === 'repeater')
            ? { height_m: tw.model.poleTop, diameter_m: POLE_R * 2 } : null,
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
      const name = floodnetName(`twin-${(st && st.id) || 'station'}-${tw.ground ? tw.ground.size : S().size}m.glb`);
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
    init, stop,

    // The 🧊 pane in the Stations tab's side panel (app.js).
    paneHtml, syncPane,

    // The station finder: a hit opens that station's twin on the map.
    setQuery(v) {
      tw.query = String(v || '');
      const hits = document.getElementById('twin-hits');
      if (hits) hits.innerHTML = hitsHtml();
    },
    pick(id) { this.openStation(id); },
    // From the station card, the finder, a field photo, or anywhere else with
    // a station in hand: the Stations map, at the station, with its twin up
    // (map-twin.js). The twin used to have a tab of its own for this; it is
    // one twin now, and it lives in the map.
    openStation(id) {
      const s = stationById(id);
      if (!s) return;
      tw.stationId = s.id;
      if (typeof switchTab === 'function' && state.activeTab !== 'stations') switchTab('stations');
      if (!located(s)) {
        rerenderStationBits();
        announce(`${s.name} has no position, so there is no ground to stand its twin on. Give it one in the station editor.`);
        return;
      }
      if (typeof MapTwin !== 'undefined') MapTwin.openStation(s.id);
    },

    // The scene settings — each persisted, each applied without a refetch
    // where it can be.
    setSize(v) {
      const n = Number(v);
      if (!SIZES.includes(n) || n === S().size) return;
      S().size = n; saveSettings();
      init();
    },
    // Saved on the station (0040) and the twin rebuilt from what came back.
    // Picking 3.0 m on a station that records nothing records 3.0 m.
    async setTower(v) {
      const st = currentStation();
      const box = document.getElementById('twin-tower'), msg = document.getElementById('twin-tower-msg');
      const spec = st ? towerSpec(st) : null;
      if (!st || !TOWER_TYPES[v] || (spec.key === v && spec.recorded)) return;
      if (!towerCanSave()) { if (box) box.value = spec.key; return; }
      if (box) box.disabled = true;
      if (msg) msg.textContent = 'Saving…';
      try {
        await stationSaveFields(st.id, { tower_height: TOWER_TYPES[v].h });
        init();
      } catch (err) {
        if (box) { box.value = spec.key; box.disabled = false; }
        if (msg) msg.textContent = typeof editorSaveErrorText === 'function' ? editorSaveErrorText(err) : `Not saved: ${err.message}`;
      }
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
        placeMovePin();
        placeSharp();
        placeNeighbours();
        if (tw.bridgesFound) buildBridges(currentStation(), tw.bridgesFound);
        if (typeof TwinCadastre !== 'undefined') TwinCadastre.relift();
        placePhotoMarkers();
        placeFlood();
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
    setFitBridges(on) { S().fitBridges = !!on; saveSettings(); init(); },
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
    setLabel(on)   {
      S().label = !!on; saveSettings();
      if (sc.label) sc.label.visible = !!on;
      if (tw.neighbours) for (const n of tw.neighbours.list) n.sign.visible = !!on;
      requestFrame();
    },

    // The camera.
    resetView() { resetOrbit(); requestFrame(); },
    topView()   { lookDown(); requestFrame(); },
    toggleWalk() { if (rig.mode === 'walk') leaveWalk(); else enterWalk(); requestFrame(); },
    rebuild() {
      const st = currentStation();
      if (st && located(st)) {
        for (const sz of new Set([S().size, tw.fit ? tw.fit.size : S().size])) {
          const key = boxKey(patchBox(st.lat, st.lon, sz));
          groundCache.delete(key); imageCache.delete(key);
        }
        bridgeCache.delete(boxKey(bridgeQueryBox(st.lat, st.lon, S().size)));
        horizonCache.delete(horizonKey(st));
        for (const h of SHELL_HALF) imageCache.delete(boxKey(shellBox(st.lat, st.lon, h)));
      }
      init();
    },

    exportGlb, buildGlb,

    // Go to the far end of a radio path: the map moves there and, at this
    // zoom, hands over to that station's twin (map-twin.js).
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
      this.openStation(s.id);
    },

    // ── Borrowing flood levels (see "borrowing another station's levels") ──
    // The modal of the nearest stations with levels; the choice; the end of it.
    borrowFlood() {
      const st = currentStation();
      if (!st || typeof Modal === 'undefined') return;
      Modal.open({ title: `Flood levels for ${st.name}, from a nearby station`, html: borrowModalHtml(st), wide: true });
    },
    useFloodFrom(id, mode) {
      const st = currentStation();
      if (!st || !stationById(id)) return;
      const radio = document.querySelector('input[name="twin-borrow-mode"]:checked');
      const how = mode || (radio ? radio.value : 'gauge');
      floodBorrows.set(st.id, { donorId: id, mode: how === 'ahd' ? 'ahd' : 'gauge' });
      if (typeof Modal !== 'undefined') Modal.close();
      const notes = horizonNotes(withoutBorrowedNotes(tw.notes));
      const said = buildFlood(st);
      setNotes([...notes, ...said.filter(n => !notes.includes(n))]);
      syncCanvasName();
      syncFloodControls();
      const F = tw.flood;
      announce(F && !F.none ? `Drawing ${F.lad.borrowed && F.lad.borrowed.self ? 'its own classes over its channel' : `${stationById(id).name}'s flood levels`} as water here.`
                            : 'Those levels leave no water to draw here.');
    },
    stopBorrowingFlood() {
      const st = currentStation();
      if (!st) return;
      floodBorrows.delete(st.id);
      const notes = withoutBorrowedNotes(tw.notes);
      const said = buildFlood(st);
      setNotes([...notes, ...said.filter(n => !notes.includes(n))]);
      syncCanvasName();
      syncFloodControls();
      announce('No longer borrowing flood levels.');
    },
    // The pill on the stage: with no levels of its own, the way to borrow
    // some. (The scale is the water's control where there is water.)
    floodPill() {
      const el = document.getElementById('twin-flood-pill');
      if (el && el.dataset.mode === 'borrow') this.borrowFlood();
    },
    // For the check: where a scene point is on the screen (CSS pixels,
    // viewport), a scene point as a latitude and longitude and back, and the
    // ground's height under one.
    _screen(x, y, z) {
      if (!sc.camera || !sc.canvas) return null;
      sc.scene.updateMatrixWorld(true);
      const v = new THREE.Vector3(x, y, z).project(sc.camera);
      const r = sc.canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, inFront: v.z < 1 };
    },
    _latLonAt(x, z) { return tw.origin ? latLonAt(x, z) : null; },
    _heightAt(x, z) { return heightAt(x, z); },
    _xzOf(lat, lon) { return tw.origin ? localXZ(lat, lon, tw.origin.lat, tw.origin.lon) : null; },
    // For the check: the stations the modal would offer.
    _donors(id) { const st = stationById(id) || currentStation(); return nearestDonors(st).map(d => ({ id: d.s.id, km: d.km, same: d.same, self: !!d.self })); },

    // The memory strip's holder (mem-meter.js): what the caches hold, and
    // the Release button's call.
    cacheBytes, clearCaches,

    // ── Embedded in the Stations map (map-twin.js) ──
    // The stage markup for a host of its own, the build into it, and what the
    // host wants to be told. `hooks.leave(why)` is called when the operator
    // wheels out past the widest orbit (why 'wheel') or presses Escape (why
    // 'escape') — the map's cue to take over again, one zoom level out for
    // the wheel and as it was for the key. stop() is the way out, as it is
    // for the tab.
    stageHtml,
    mountAt(id, hooks) {
      const s = stationById(id);
      if (!s) return false;
      tw.stationId = s.id;
      tw.hooks = hooks || null;
      init();
      syncPane();
      return true;
    },
    // Fetch a station's ground and imagery into the caches ahead of a
    // hand-over that has not happened yet — a station selected on the map
    // at any zoom is a station about to be looked at closely.
    prefetch(id) {
      const s = stationById(id);
      if (!located(s) || typeof fetch !== 'function') return;
      const size0 = S().size, qbox = bridgeQueryBox(s.lat, s.lon, size0);
      const go = size => { const box = patchBox(s.lat, s.lon, size); groundFor(box).catch(() => {}); imageryFor(box).catch(() => {}); };
      // The patch a build would stand: widened for a bridge at its edge, which
      // the State says (and the build then has from the cache).
      if (S().fitBridges && insideBox(qbox, QLD_DEM_BOX)) {
        bridgesFor(qbox).then(f => go(f && f.source === 'qld' && !f.failed ? fitBridges(f, Number(s.lat), Number(s.lon), size0).size : size0), () => go(size0));
      } else go(size0);
    },
    patchSize() { return S().size; },
    embedded() { return !!tw.hooks; },
    // What the State's imagery catalogue says covers a point (map-twin.js's
    // offer): { res_m, label, when, satellite } | { outside } | null.
    imageryAt,

    // ── The move-pin mode (map-move-pin.js) ──
    // Whether this station is the one on the stage, built — the twin's tab
    // is a place the pin can be moved from even with no map under it.
    showing(id) { return tw.live && !!tw.ground && tw.stationId === id; },
    // Whether the pin is drawn here now (its panel on the stage follows it).
    showsPin,
    // The mode changed: armed, dragged, saved, cancelled.
    movePinChanged,
    // A save moved a station: a twin centred on its old spot is rebuilt on
    // the new one.
    stationMoved(id) { if (tw.live && tw.stationId === id) init(); },
    // The 🧭 Orientation tool: the button on the overlay's bar, and its panel's controls.
    toggleOrient() { if (tw.orient) closeOrient(); else openOrient(); },
    orientTo,
    orientBy(d) { if (tw.orient) orientTo(tw.orient.deg + Number(d)); },
    // The front turned toward the camera: orbit to where the door should be,
    // and press.
    orientFaceView() {
      if (!tw.orient || !sc.camera) return;
      const x = sc.camera.position.x, z = sc.camera.position.z;
      if (Math.hypot(x, z) < 0.2) return;
      orientTo((Math.atan2(x, -z) * 180 / Math.PI + 360) % 360);
    },
    orientCancel() { closeOrient(); },
    // Saved on the station (0044) and the twin rebuilt from what came back —
    // the ladder's foot is on different ground once it is turned.
    async orientSave() {
      const st = currentStation(), o = tw.orient;
      if (!st || !o || o.saving || !towerCanSave()) return;
      o.saving = true; o.msg = null;
      renderOrientPanel();
      try {
        await stationSaveFields(st.id, { facing_deg: norm360(o.deg) });
        tw.orient = null;
        renderOrientPanel();
        if (typeof announce === 'function') announce(`${st.name || st.id} saved facing ${facingWords(norm360(o.deg))}`);
        init();
      } catch (err) {
        o.saving = false;
        o.msg = { kind: 'error', text: typeof editorSaveErrorText === 'function' ? editorSaveErrorText(err) : `Not saved: ${err.message}` };
        renderOrientPanel();
      }
    },
    // The check's seam: the bearing drawn, and the turn it is drawn at.
    _facing() { return { deg: facingNow(), turn: sc.turn || 0, open: !!tw.orient }; },
    // The 📍 button on the overlay's bar.
    toggleMovePin() {
      const st = currentStation();
      if (!st || typeof MapMovePin === 'undefined') return;
      if (MapMovePin.armed() === st.id) MapMovePin.cancel();
      else MapMovePin.start(st.id);
    },

    // The lines over the stage: the fold's button (for the overlay's bar),
    // and the press on it.
    infoToggleHtml, toggleInfo,
    // The check's seam: fold after `ms` rather than ten seconds, or never
    // (null) — so a check that is not about the fold is not raced by it.
    _infoFold(ms) { infoFoldMs = ms == null ? null : Math.max(0, Number(ms)); if (infoFoldMs == null) clearInfoTimer(); },
    // A phone's hint, from its "?"; and the same kind of seam for its clock
    // and the scale names' (COMPACT_MS), for the check that holds them:
    // whatever is up folds `ms` from now, or never (null).
    toggleHud,
    _compact(ms) {
      compactMs = ms == null ? null : Math.max(0, Number(ms));
      clearCompactTimers();
      syncCompact();
    },

    // Read by the check and by nothing else: what the scene is standing on.
    libLoaded() { return !!THREE; },
    debug() {
      const g = tw.ground;
      return {
        live: tw.live, lib: !!THREE, built: !!sc.terrain, frames: tw.frames, seq: tw.seq,
        stationId: tw.stationId, mode: rig.mode,
        size: g ? g.size : null, N, sample_m: g ? g.sample_m : null,
        source: g ? g.source : null, holes: g ? g.holes : null, filled: g ? g.filled : null, qld: g ? g.qld : null,
        datum: g ? g.datum : null, geoid: g && g.geoid ? g.geoid.m : null, egm96: g ? !!g.egm96 : null,
        h0: g ? g.h0 : null, min: g ? g.min : null, max: g ? g.max : null,
        imagery: tw.image ? tw.image.source : null, mpp: tw.image ? tw.image.mpp : null,
        exag: S().exag, status: tw.status, notes: tw.notes.slice(),
        pole: sc.pole ? { h: tw.model ? tw.model.poleTop : POLE_H, r: POLE_R, baseY: sc.pole.position.y - (tw.model ? tw.model.poleTop : POLE_H) / 2, x: sc.pole.position.x, z: sc.pole.position.z } : null,
        model: tw.model ? {
          structure: tw.model.structure, telemetry: tw.model.telemetry, telemetryKnown: tw.model.telemetryKnown,
          water: tw.model.water, rain: tw.model.rain, repeater: tw.model.repeater, top: tw.model.top, poleTop: tw.model.poleTop,
          plate: tw.model.plate, ladder: tw.model.ladder ? { ...tw.model.ladder, footY: ladderFootY(), height: ladderHeight() } : null,
          towerStaff: sc.towerStaff && sc.towerStaff.userData.staff ? { ...sc.towerStaff.userData.staff } : null,
          deck: tw.model.deck, level: rig.level, climb: rig.climb, walker: { x: rig.px, z: rig.pz, yaw: rig.yaw },
          doors: sc.doors.map(d => ({ name: d.name, angle: d.angle, open: d.open, when: d.when, wanted: doorWanted(d) })),
          parts: (() => { const n = []; if (sc.station) sc.station.traverse(o => { if (o.isMesh) n.push(o.name); }); return n; })(),
          // The station's own extent, metres: what the brief's sizes are checked against.
          size: (() => {
            if (!sc.station) return null;
            const b = new THREE.Box3().setFromObject(sc.station);
            return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z, minY: b.min.y, maxY: b.max.y };
          })(),
          manual: tw.model.manual, telemetered: tw.model.telemetered, unsure: tw.model.unsure, sls: tw.model.sls,
        } : null,
        figure: sc.figure ? { h: FIGURE_H, x: sc.figure.position.x, z: sc.figure.position.z, baseY: sc.figure.position.y, visible: sc.figure.visible } : null,
        vertices: sc.terrain ? sc.terrain.geometry.attributes.position.count : 0,
        textured: !!(sc.terrain && sc.terrain.material.map),
        contextLost: sc.renderer ? sc.renderer.getContext().isContextLost() : null,
        camera: sc.camera ? { x: sc.camera.position.x, y: sc.camera.position.y, z: sc.camera.position.z } : null,
        paths: tw.paths ? { count: tw.paths.count, source: tw.paths.source, pending: tw.paths.pending, list: tw.paths.list.slice() } : null,
        embedded: !!tw.hooks,
        info: { open: tw.infoOpen !== false, pinned: !!tw.infoPinned, timer: !!tw.infoTimer,
                hidden: (() => { const el = document.getElementById('twin-info'); return el ? el.hidden : null; })() },
        // A phone's stage: whether this is one, the clock, and what is put away.
        compact: (() => {
          const stage = document.getElementById('twin-stage'), hud = document.getElementById('twin-hud');
          const q = document.getElementById('twin-hud-q'), box = document.getElementById('twin-flood-scale');
          return { on: compactStage(), ms: compactMs, staged: !!(stage && stage.classList.contains('is-compact')),
                   hudFolded: !!(hud && hud.classList.contains('is-folded')), q: !!(q && !q.hidden),
                   qExpanded: q ? q.getAttribute('aria-expanded') : null,
                   namesQuiet: !!(box && box.classList.contains('is-quiet')),
                   hudTimer: !!tw.hudTimer, scaleTimer: !!tw.scaleTimer };
        })(),
        origin: tw.origin ? { ...tw.origin } : null,
        tier: tw.tier ? { ...tw.tier } : null,
        sharp: sc.sharp ? { x: sc.sharp.x, z: sc.sharp.z, mpp: sc.sharp.mpp, visible: sc.sharp.mesh.visible,
                            textured: !!sc.sharp.mesh.material.map, size: SHARP_M,
                            onGround: (() => { const p = sc.sharp.mesh.geometry.attributes.position; return Math.abs(p.getY(0) - yAt(p.getX(0), p.getZ(0))) < 1e-6; })() } : null,
        neighbours: tw.neighbours ? {
          more: tw.neighbours.more,
          list: tw.neighbours.list.map(n => ({ id: n.id, name: n.name, x: n.x, z: n.z, d: n.d, structure: n.structure, top: n.top,
            y: n.group.position.y, groundY: yAt(n.x, n.z), signY: n.sign.position.y, signVisible: n.sign.visible,
            parts: (() => { const out = []; n.group.traverse(o => { if (o.isMesh) out.push(o.name); }); return out; })() })),
        } : null,
        bridges: tw.bridges ? {
          status: tw.bridges.status, source: tw.bridges.source, failed: tw.bridges.failed,
          crossing: tw.bridges.crossing ? { ...tw.bridges.crossing } : null,
          list: tw.bridges.list.map(b => ({ ...b, deck: b.deck.slice(), ends: b.ends.map(e => ({ ...e })) })),
          meshes: (() => { const out = []; if (sc.bridges) sc.bridges.traverse(o => { if (o.isMesh) out.push(o.name); }); return out; })(),
          deckTop: (() => { let y = -Infinity; if (sc.bridges) sc.bridges.traverse(o => { if (o.name === 'bridge deck') { o.geometry.computeBoundingBox(); y = Math.max(y, o.geometry.boundingBox.max.y); } }); return isFinite(y) ? y : null; })(),
          textured: (() => { let t = false; if (sc.bridges) sc.bridges.traverse(o => { if (o.name === 'bridge deck' && o.material.map) t = true; }); return t; })(),
        } : null,
        movepin: sc.movepin ? (() => {
          const m = sc.movepin;
          const pos = m.leader.geometry.attributes.position;
          return {
            visible: m.group.visible, x: m.pin.position.x, y: m.pin.position.y, z: m.pin.position.z,
            groundY: yAt(m.pin.position.x, m.pin.position.z), height: m.H,
            ghost: m.ghost.visible ? { x: m.ghost.position.x, z: m.ghost.position.z } : null,
            leader: m.leader.visible && pos ? pos.count : 0, dragging: rig.pinDrag != null,
            exported: (() => { let any = false; m.group.traverse(o => { if (o.userData.export !== false) any = true; }); return any; })(),
          };
        })() : null,
        pointing: !!rig.pointing, pointLatch: !!rig.pointLatch,
        laser: sc.laser && sc.laser.visible ? { len: sc.laser.scale.y, dot: { x: sc.dot.position.x, y: sc.dot.position.y, z: sc.dot.position.z } } : null,
        avatars: [...avatars.values()].map(a => ({
          key: a.key, name: a.info.name, hat: a.info.hat, shirt: a.info.shirt, pants: a.info.pants,
          hatDrawn: `#${a.group.getObjectByName('hard hat').material.color.getHexString()}`,
          visible: a.group.visible, x: a.group.position.x, y: a.group.position.y, z: a.group.position.z, yaw: -a.group.rotation.y,
          pointing: !!(a.pose && a.pose.point), armRaised: Math.abs(a.shoulder.quaternion.x) > 0.01,
          settled: !!(a.shown && a.to && a.shown.x === a.to.x && a.shown.z === a.to.z && a.shown.yaw === a.to.yaw && a.shown.pitch === a.to.pitch),
          laser: a.laser.visible ? { len: a.laser.scale.y, dot: { x: a.dot.position.x, y: a.dot.position.y, z: a.dot.position.z } } : null,
        })),
        presence: typeof TwinPresence !== 'undefined' ? TwinPresence.debug() : null,
        flood: tw.flood ? (() => {
          const F = tw.flood;
          if (F.none) return { none: true, notes: F.notes.slice(), levels: [] };
          const pal = (sc.flood && sc.flood.palette) || null;
          return {
            none: false, on: !!S().flood, animating: floodAnimating(), level: F.level, top: F.top, start: F.start, startBasis: F.startBasis,
            clock: floodAnimating() && F.clock != null ? F.clock : null,
            // The scale's measure: which, the bend, what the levels warrant, and who chose.
            measure: F.logK != null ? 'log' : 'lin', logK: F.logK, fit: { ...F.fit }, chosen: !!F.scaleChosen,
            autoDone: !!F.scaleAutoDone, autoArmed: !!tw.scaleAutoTimer, autoMs: scaleAutoMs,
            zero: F.lad.ahdZero, band: F.band ? F.band.key : null, flooded: F.flooded,
            colour: sc.flood ? `#${sc.flood.mat.color.getHexString()}` : null, opacity: sc.flood ? sc.flood.mat.opacity : null,
            y: sc.flood ? sc.flood.water.position.y : null, visible: sc.flood ? sc.flood.water.visible : null,
            seed: F.seed ? { x: F.seed.x, z: F.seed.z, elev: F.seed.elev } : null,
            levels: F.lad.levels.map(l => ({ key: l.key, kind: l.kind, label: l.label, ahd: l.ahd, gauge: l.gauge, rank: l.rank,
                                            colour: FloodStages.colourOf(l, pal) })),
            staff: sc.flood ? {
              x: sc.flood.staff.position.x, z: sc.flood.staff.position.z, visible: sc.flood.staff.visible,
              rings: sc.flood.staff.children.filter(c => c.userData.level).map(c => ({ key: c.userData.level, y: c.position.y, colour: `#${c.material.color.getHexString()}` })),
              post: (() => { const p = sc.flood.staff.getObjectByName('staff post'); return { bottom: p.position.y - p.scale.y / 2, top: p.position.y + p.scale.y / 2 }; })(),
            } : null,
            towerMarks: sc.towerMarks ? {
              visible: sc.towerMarks.visible,
              marks: (F.towerMarks || []).slice(),
              callouts: sc.towerMarks.children.filter(c => c.isSprite).map(c => ({ name: c.name, y: c.position.y })),
              exported: (() => { let any = false; sc.towerMarks.traverse(x => { if (x.userData.export !== false) any = true; }); return any; })(),
            } : null,
            exported: sc.flood ? (() => { let any = false; for (const o of [sc.flood.water, sc.flood.staff]) o.traverse(x => { if (x.userData.export !== false) any = true; }); return any; })() : null,
            notes: F.notes.slice(),
            // The scale on the stage, as laid out and as drawn.
            scale: (() => {
              const box = document.getElementById('twin-flood-scale');
              if (!box) return null;
              const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
              const track = document.getElementById('twin-scale-track'), stage = document.getElementById('twin-stage');
              const play = document.getElementById('twin-scale-play'), now = document.getElementById('twin-scale-now');
              return {
                hidden: box.hidden || getComputedStyle(box).display === 'none',
                box: rect(box), stage: stage ? rect(stage) : null, track: track ? rect(track) : null,
                play: play ? play.textContent.trim() : null, now: now ? now.textContent : null,
                fill: track ? Number(track.style.getPropertyValue('--level')) : null,
                valuetext: track ? track.getAttribute('aria-valuetext') : null,
                marks: [...document.querySelectorAll('#twin-scale-marks .twin-scale-mark')].map(m => ({ key: m.dataset.level, ...rect(m) })),
                labels: [...document.querySelectorAll('#twin-scale-labels .twin-scale-label')].map(b => ({
                  key: b.dataset.flood, text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') === 'true', ...rect(b) })),
                leaders: document.querySelectorAll('#twin-scale-leaders polyline').length,
                layout: F.scale ? F.scale.pos.map(q => ({ ...q })) : null,
              };
            })(),
          };
        })() : null,
        photos: tw.photos ? {
          status: tw.photos.status, count: tw.photos.count, error: tw.photos.error || null, near: tw.photoNear,
          prompt: (() => { const el = document.getElementById('twin-photo-prompt'); return el && !el.hidden ? el.textContent : null; })(),
          spots: tw.photos.spots.map((sp, k) => {
            const m = sc.photos && sc.photos.children[k];
            const head = m && m.getObjectByName('camera');
            const badge = m && m.userData.badge;
            return {
              x: sp.x, z: sp.z, n: sp.rows.length, ids: sp.ids.slice(), heading: sp.heading, fov: sp.fov,
              y: m ? m.position.y : null, groundY: yAt(sp.x, sp.z),
              yaw: head ? -head.rotation.y * 180 / Math.PI : null, pitch: head ? head.rotation.x * 180 / Math.PI : null,
              wedges: m ? m.children.filter(c => c.name === 'view').map(c => ((-c.rotation.y * 180 / Math.PI) % 360 + 360) % 360) : [],
              badgeScale: badge ? badge.scale.x / badge.userData.base.w : null,
              exported: m ? (() => { let any = false; m.traverse(o => { if (o.userData.export !== false) any = true; }); return any; })() : null,
            };
          }),
        } : null,
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
    // The field photos (field-photos.js holds them; this draws them).
    photosChanged() {
      const st = currentStation();
      if (tw.live && sc.terrain && st && located(st)) loadPhotos(st, tw.seq);
    },
    openPhotoSpot, openAllPhotos,
    openNearPhotos() { if (tw.photoNear >= 0) openPhotoSpot(tw.photoNear); },
    // Stand the orbit camera behind a photo's camera, once its marker is up —
    // now if it already is, after the next build otherwise.
    focusPhoto(id) { tw.focusPhotoId = id || null; applyPhotoFocus(); },
    _photoAt: (x, y) => photoAt(x, y),
    // The flood water: shown or hidden, rising or held — each remembered.
    setFlood(on) {
      S().flood = !!on; saveSettings();
      if (tw.flood && !tw.flood.none && sc.flood && on && tw.flood.level == null) setFloodLevel(tw.flood.start);
      settleFlood();
    },
    setFloodAnim(on) {
      S().floodAnim = !!on; saveSettings();
      settleFlood();
    },
    toggleFloodAnim() {
      S().floodAnim = !floodAnimating();
      // Paused, the water stays where it was caught.
      const F = tw.flood;
      if (!S().floodAnim && F && !F.none && F.level != null && F.top > F.start) S().floodHold = (F.level - F.start) / (F.top - F.start);
      saveSettings();
      settleFlood();
    },
    // Hold the water at one level (its key), or a fraction of the way up the
    // scale's track — on a linear one, that fraction of the way from 0 m to
    // the top; on a logarithmic one, where that place on it stands, as the
    // Scene panel's slider does with the scale — either stops the rise.
    floodAt(key) {
      S().flood = true; S().floodAnim = false; S().floodHold = String(key); saveSettings();
      settleFlood();
    },
    setFloodFraction(v) {
      const t = Math.max(0, Math.min(1, Number(v)));
      if (!isFinite(t)) return;
      const F = tw.flood;
      S().flood = true; S().floodAnim = false; S().floodHold = F && !F.none ? heightFraction(t) : t; saveSettings();
      settleFlood();
    },
    // The scale's measure, chosen: 'lin' or 'log' — and the Log toggle beside
    // the scale's head, which turns it to the other.
    setFloodScale(mode) { setScaleMode(mode === 'log' ? 'log' : 'lin'); },
    toggleFloodScale() { const F = tw.flood; setScaleMode(F && !F.none && F.logK != null ? 'lin' : 'log'); },
    // The check's seam: the scale turns itself `ms` after it comes up rather
    // than four seconds, or never (null); `forget` drops the Log choices the
    // operator pressed, as a new session would.
    _floodScaleAuto(ms, forget = false) {
      scaleAutoMs = ms == null ? null : Math.max(0, Number(ms));
      if (forget) floodScales.clear();
      clearScaleAuto();
      if (scaleAutoMs != null && floodScaleOn()) armScaleAuto();
    },
    // The check's seams: a shorter cycle, and whether a scene point is wet.
    _floodClock(rise, hold, drain) {
      floodClock = rise ? { rise: Number(rise), hold: Number(hold) || 0, drain: Number(drain) || 0.001 } : null;
      const F = tw.flood;
      if (F && !F.none) {
        // From the bottom, now: the water is put at 0 m before the next frame.
        F.t0 = performance.now(); F.lastDraw = 0; F.clock = 0;
        if (floodAnimating()) setFloodLevel(F.start);
        requestFrame();
      }
    },
    _floodWet(x, z) {
      const F = tw.flood, g = tw.ground;
      if (!F || F.none || !F.fill || !g || F.level == null) return false;
      const step = g.size / (N - 1);
      const i = Math.round((x + g.half) / step), j = Math.round((z + g.half) / step);
      if (i < 0 || j < 0 || i >= N || j >= N) return false;
      return F.fill[j * N + i] < F.level;
    },
    _floodFill(x, z) {
      const F = tw.flood, g = tw.ground;
      if (!F || F.none || !F.fill || !g) return null;
      const step = g.size / (N - 1);
      const i = Math.round((x + g.half) / step), j = Math.round((z + g.half) / step);
      return (i < 0 || j < 0 || i >= N || j >= N) ? null : F.fill[j * N + i];
    },
    // Whether the water as drawn covers a scene point: the texel of the mask
    // the plane samples there, found through the plane's own positions and
    // UVs rather than the arithmetic that set them — so a mask drawn turned
    // or flipped against the ground is told apart from one that is not.
    _floodMaskAt(x, z) {
      if (!sc.flood) return null;
      const geo = sc.flood.water.geometry, pos = geo.attributes.position, uv = geo.attributes.uv;
      // A rectangle on the ground: u runs with x alone, v with z alone.
      let bx = -1, bz = -1;
      for (let k = 1; k < pos.count; k++) {
        if (bx < 0 && pos.getX(k) !== pos.getX(0)) bx = k;
        if (bz < 0 && pos.getZ(k) !== pos.getZ(0)) bz = k;
      }
      if (bx < 0 || bz < 0) return null;
      const u = uv.getX(0) + (x - pos.getX(0)) / (pos.getX(bx) - pos.getX(0)) * (uv.getX(bx) - uv.getX(0));
      const v = uv.getY(0) + (z - pos.getZ(0)) / (pos.getZ(bz) - pos.getZ(0)) * (uv.getY(bz) - uv.getY(0));
      const ti = Math.floor(u * N), tj = Math.floor(v * N);
      if (ti < 0 || tj < 0 || ti >= N || tj >= N) return null;
      // three reads an alpha map's green channel.
      return sc.flood.data[(tj * N + ti) * 4 + 1] > 0;
    },
    // The others in the room, driven by twin-presence.js.
    remote: { set: remoteSet, pose: remotePose, remove: remoteRemove, clear: remoteClear },
    presenceChanged() { refreshPeersLine(); },
    togglePoint() { setPointing(!rig.pointLatch); },
    setPointing,
    // The check's seams: the visitor's own pose as published, and notes to fold.
    _pose: localPose,
    _setNotes(list) { setNotes(Array.isArray(list) ? list.map(String) : []); },
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
    // Forget what the State said about bridges, so a check can change its answer.
    _forgetBridges() { bridgeCache.clear(); },
    // Forget the station, so a check can measure the tab with nothing chosen.
    _clear() {
      tw.stationId = null; tw.ground = null; tw.image = null; tw.elvis = null;
      tw.status = ''; tw.notes = []; tw.picked = null; tw.paths = null;
    },
  };
})();
if (typeof window !== 'undefined') window.DigitalTwin = DigitalTwin;
