// MegaNet — map-3d.js
//
//   Map3D   the Stations map in three dimensions: the ground with its real
//           relief, the same base map draped over it, the same pins, the same
//           links, and — when asked for — the line of sight over each hop
//           drawn as a vertical sheet between the ray and the ground under it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, cssVar, announce, esc and
// acmaHaversineKm; across to terrain.js for the ground profile, to
// path-profile.js for the physics (pathAnalyse, earthBulge, rmSystemOf,
// PATH_DEFAULT_*), to map-controls.js for the panel it is opened from, and to
// app.js for showStationCard and the base-map choice. Every one of those is
// called from inside this file's own functions, so its position among the
// modules is free.
//
// ── Why a second map rather than a 3-D Leaflet ───────────────────────────────
// Leaflet draws into a 2-D canvas and has no camera: there is no pitch, no
// bearing and no z, and no amount of work on top of it produces one. A
// three-dimensional view is a different renderer, and the honest way to have
// one is to have one — so this is a MapLibre GL map in WebGL, living in the
// same rectangle, fed by the same data, and torn down when it is not being
// looked at.
//
// The seam is the thing to understand. This module does **not** re-derive what
// to draw. `refreshMapLayers()` in app.js has already decided which stations
// are on the map, which links are drawn, which are hidden, which are culled by
// the distance slider, what colour each line is under whichever colouring is
// running (MapFreq / MapFade / MapLos), which pins are matches and which were
// pulled in by a pass range, and what the focus dim has done to all of it. All
// of that lands on ordinary Leaflet layers in `state.mapLines` and
// `state.mapMarkers`, each carrying its geometry and its resolved style. So
// this module **mirrors those two arrays** into GeoJSON and lets MapLibre drape
// them over the terrain.
//
// That is the whole reason 3-D cannot drift from 2-D: there is no second
// opinion for it to drift towards. A colouring added to the Stations map next
// year is in the 3-D view the day it lands, because the 3-D view is reading the
// lines that colouring painted. The alternative — re-running passRangeLinks(),
// backboneLinks(), the filters and the three classifiers here — is a
// second implementation of eleven modules' decisions, and the first time the
// two disagreed the map would be lying in one of its two modes with nothing to
// say which.
//
// ── Why the library is fetched rather than listed in index.html ──────────────
// MapLibre is ~1 MB of WebGL renderer. Leaflet is in index.html because half
// the tabs are unusable without it; this is one optional mode on one tab, and
// most sessions never open it. So it is injected on the first ⛰️ press and
// never again — which also means `npm run smoke`, which opens all twenty tabs
// and never presses anything, does not pay for it and is not exposed to it.
//
// The version is pinned to a **UMD** build for the same reason every other
// script here is a classic script (#129): it defines one global and needs no
// module graph, no import map and no build step. MapLibre 6 ships ESM only,
// which is why this is pinned to the last 5.x rather than to `latest` — and why
// the pin is a deliberate decision with a reason rather than a number that
// drifted. Upgrading past 5.x means either `import()` or a bundler, and both
// are bigger decisions than this file.
//
// ── Every failure here is loud ───────────────────────────────────────────────
// terrain.js's rule, and it reaches further in 3-D than it does in a profile:
// a hillside that failed to load is *flat ground* on screen, and flat ground
// between two stations reads as a clear path. So a DEM that cannot be had, a
// WebGL context that cannot be created and a library that cannot be fetched
// each say so in the panel, in as many words, rather than leaving a plausible
// picture on screen.
const Map3D = (function () {
  // ── the library ──
  // 5.24.0 is the last release with a UMD build (`dist/maplibre-gl.js`, one
  // global `maplibregl`). See the header: 6.x is ESM-only, which this page
  // cannot load without changing what kind of page it is.
  const LIB_VER = '5.24.0';
  const LIB_JS  = `https://unpkg.com/maplibre-gl@${LIB_VER}/dist/maplibre-gl.js`;
  const LIB_CSS = `https://unpkg.com/maplibre-gl@${LIB_VER}/dist/maplibre-gl.css`;

  // The same terrarium tiles terrain.js already decodes for every elevation
  // profile in this app — same host, same encoding, same ~30 m SRTM, same
  // keyless open data — read here by MapLibre's own decoder instead. Two
  // consumers of one source rather than two sources, so the relief on screen
  // and the clearance in the profile card are the same ground.
  const DEM_URL     = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  // The service itself serves to z15 (z16 is a 404), but the data behind it is
  // ~30 m SRTM and past z12 the tiles are resampling their own pixels —
  // terrain.js stops there for that reason and so does this, so the relief on
  // screen and the clearance in the profile card are the same ground at the
  // same resolution. Declaring it is also what makes MapLibre *overzoom* the
  // z12 tile rather than fetch four times as many for no more terrain.
  const DEM_MAXZOOM = 12;
  // raster-dem defaults to 512 in the style spec and these tiles are 256. Get
  // this wrong and MapLibre reads each tile as covering a quarter of the ground
  // it covers: the relief still renders, and every hill is in the wrong place.
  const DEM_TILE_PX = 256;

  // The pitch the camera opens at, and the pitch the tilt button puts it back
  // to. Named because two things now depend on it being the same number: the
  // camera build below and ⛰️'s tilt control, which flattens to nil on the
  // first press and returns *here* on the second (see resetTilt).
  const PITCH_HOME = 62;

  // ── The elevation drape (#194) ──────────────────────────────────────────
  // `MapElevation` paints ground height into a colour ramp on the 2-D map, and
  // until this it simply vanished when the map was tilted: it is a Leaflet tile
  // layer, and every Leaflet pane is under the canvas in this mode. Which is
  // the one layer whose absence is *least* obvious here, because the 3-D view
  // already shows relief through shading — the hills are still there, just no
  // longer coloured by height, and nothing says the switch stopped applying.
  //
  // It is drawn here as a raster source served by a custom MapLibre protocol.
  // The protocol fetches the same terrarium tile from the same URL and hands it
  // to **MapElevation's own painter**, so the bands, the hillshade and the
  // relief switch are that file's and there is no second copy of them here.
  // That is this module's standing rule (see the header) applied to a raster
  // instead of to a line: the first thing that computes its own answer is the
  // first place the two modes can disagree.
  //
  // `?r=` is in the tile template rather than being ignored: MapLibre caches by
  // URL and the relief switch changes the pixels behind the same z/x/y, so the
  // token is what makes a toggle repaint instead of showing yesterday's tiles.
  const ELEV_PROTO = 'mn-elev';

  const SHEET_SAMPLES = 48;   // per hop. MapLos uses 64 for a yes/no verdict;
                              // a sheet is a picture and reads the same at 48,
                              // at three quarters of the tiles
  const SHEET_CONC    = 3;    // profiles in flight; Terrain dedups tiles beneath
  const SHEET_MAX     = 80;   // hops given a sheet at once — see sheetBudget()

  let ml       = null;   // the maplibregl global, once loaded
  let libP     = null;   // the in-flight load, so two presses fetch once
  let libErr   = null;   // why the library could not be had, if it could not
  let map      = null;   // the MapLibre map, while 3-D is open
  let leaflet  = null;   // the Leaflet map it shadows (Map3D.attach)
  let host     = null;   // the div it draws into
  let ready    = false;  // style loaded — nothing may be added before this
  let demFails = 0;      // DEM tiles the renderer could not fetch
  let elevReg  = false;  // the elevation protocol, registered once per page
  let elevKey  = null;   // the tile template the drape is currently built on
  let sheets   = { rows: [], pick: [], queue: [], running: 0, gen: 0,
                   done: 0, failed: 0, dropped: 0, inView: 0 };
  let buf      = null;   // { pos, clr, count } — the sheet geometry, in mercator

  // ── base maps ────────────────────────────────────────────────────────────
  // The four the 2-D map already offers, as MapLibre raster sources. They are
  // the same hosts and the same attributions makeBaseLayers() uses
  // (map-controls.js) because they are the same tiles: the 3-D view is meant to
  // read as *this map, in relief*, and a base map that changed when you tilted
  // would be a different map.
  //
  // Leaflet's `{s}` subdomain placeholder has no MapLibre equivalent — the spec
  // takes a list of URLs and rotates them itself — so each entry that used one
  // is expanded here.
  const BASES = {
    'OSM-Topo': {
      tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      maxzoom: 17,
      attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
    },
    'OpenStreetMap': {
      // The bare host, with no `a.`/`b.`/`c.` in front of it. The OSMF tile
      // policy asks for exactly this URL and says the subdomain forms "may be
      // slower or withdrawn without notice" — they are a leftover from HTTP/1.1
      // connection limits that HTTP/2 made pointless. The 2-D layer in
      // map-controls.js still uses Leaflet's `{s}` form; that is older than this
      // and is left alone here rather than changed in passing.
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    'Satellite': {
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      maxzoom: 19,
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    'Dark': {
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
      maxzoom: 19,
      attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS User Community',
    },
  };

  // Which of them the 2-D map is currently showing. addBaseLayers() records it
  // on the Leaflet map as `mnBaseName`; anything unrecognised falls back to the
  // plain OSM sheet, which is the one that carries roads, localities and
  // watercourses as *names* — what a 3-D view of unfamiliar country is for.
  function baseName() {
    const n = leaflet && leaflet.mnBaseName;
    return BASES[n] ? n : 'OpenStreetMap';
  }

  // ── loading the library ──────────────────────────────────────────────────
  // The tile template the drape is built from, carrying whatever the relief
  // switch currently says. Null when the overlay is off.
  function elevTiles() {
    if (typeof MapElevation === 'undefined' || !MapElevation.active()) return null;
    return `${ELEV_PROTO}://{z}/{x}/{y}?r=${MapElevation.relief() ? 1 : 0}`;
  }

  // One <img>, decoded, or a rejection. `crossOrigin` because the pixels are
  // read back out of a canvas straight after — without it the canvas is
  // tainted and `getImageData` throws, which is the same reason
  // MapElevation's own createTile sets it.
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('elevation tile unavailable'));
      img.src = url;
    });
  }

  // The painted canvas as PNG bytes, which is what a custom protocol hands
  // back for a raster tile.
  function canvasBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b.arrayBuffer())
                            : reject(new Error('elevation tile could not be encoded'))),
                    'image/png');
    });
  }

  // Registered against the library rather than against a map: protocols are
  // global to MapLibre, this one is idempotent, and a map that is torn down and
  // rebuilt (every render of the Stations tab) must not re-register it.
  //
  // A tile that cannot be had throws, which MapLibre reports as a source error
  // and draws as nothing. That is deliberately *not* counted and said out loud
  // the way a missing DEM tile is, and the difference is the point: flat ground
  // where a hill should be reads as a clear path and is the one wrong answer
  // worth a warning, while a gap in this drape shows the base map through it
  // and is visibly a gap.
  function registerElevProtocol() {
    if (elevReg || !ml || typeof ml.addProtocol !== 'function') return;
    elevReg = true;
    ml.addProtocol(ELEV_PROTO, async (params) => {
      const m = /:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url || '');
      if (!m) throw new Error('bad elevation tile url');
      const z = +m[1], x = +m[2], y = +m[3];
      const img = await loadImage(MapElevation.tileUrl(z, x, y));
      return { data: await canvasBytes(MapElevation.paintedTile(img, z, y)) };
    });
  }

  function loadLib() {
    if (ml) return Promise.resolve(ml);
    if (libP) return libP;
    libP = new Promise((resolve, reject) => {
      if (!document.getElementById('mn-maplibre-css')) {
        const css = document.createElement('link');
        css.id = 'mn-maplibre-css';
        css.rel = 'stylesheet';
        css.href = LIB_CSS;
        document.head.appendChild(css);
      }
      const s = document.createElement('script');
      s.src = LIB_JS;
      s.async = true;
      s.onload = () => {
        if (window.maplibregl) {
          ml = window.maplibregl;
          registerElevProtocol();
          resolve(ml);
        } else reject(new Error('the 3-D renderer loaded but defined nothing'));
      };
      s.onerror = () => reject(new Error('the 3-D renderer could not be fetched'));
      document.head.appendChild(s);
    }).catch(err => {
      // A failed fetch is remembered as a failure but not as an answer: the
      // next press tries again, because "offline for a moment" is the common
      // case and a mode that stays broken for the session over one dropped
      // request is worse than one that retries.
      libErr = err.message || String(err);
      libP = null;
      throw err;
    });
    return libP;
  }

  // ── the ground under a hop ───────────────────────────────────────────────
  // MapLos' endpoint rules, and for MapLos' reason: a surveyed elevation_ahd
  // beats a tile pixel at a station, the station's configured antenna height
  // beats the 4 m field default, and the map states the network as filed rather
  // than following the profile card's what-if overrides.
  function endParams(s) {
    const sys = typeof rmSystemOf === 'function' ? rmSystemOf(s) : null;
    return {
      elev: s && s.elevation_ahd != null ? s.elevation_ahd : null,
      agl:  sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
    };
  }

  function freqFor(a, b) {
    for (const s of [a, b]) {
      const r = s && s.repeater;
      if (r && r.rx_mhz > 0) return r.rx_mhz;
    }
    return PATH_DEFAULT_MHZ;
  }

  // ── the mirror: what 2-D drew, as GeoJSON ────────────────────────────────
  // Read off the Leaflet layers rather than recomputed. `options.color` is the
  // colour the line ended up, after MapFreq recorded the channel, MapLos
  // painted an obstruction and MapFade banded a margin — i.e. after every
  // decision the 2-D map made. `mnLinkRole` separates the white casing (which
  // exists to lift a line off the base map and has nothing to say in 3-D, where
  // the line is lifted off it by the terrain) from the core that carries the
  // meaning.
  function linkFeatures() {
    const out = [];
    for (const l of (state.mapLines || [])) {
      const role = l.mnLinkRole;
      if (role === 'casing' || role === 'backbone-casing') continue;
      const pts = typeof l.getLatLngs === 'function' ? l.getLatLngs() : null;
      if (!pts || pts.length < 2) continue;
      out.push({
        type: 'Feature',
        properties: {
          colour: l.options.color || '#ff6f00',
          width:  (l.options.weight || 2) + (role === 'backbone' ? 1 : 0),
          op:     l.options.opacity == null ? 1 : l.options.opacity,
          // A backbone path is three stacked Leaflet lines: a casing, a
          // coloured core and a black dashed overlay. The casing is dropped
          // above; the dash is kept and drawn as a real dash, which is what
          // says "backbone" once the core has taken the colouring's colour.
          dash:   role === 'backbone-dash' ? 1 : 0,
        },
        geometry: { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) },
      });
    }
    return { type: 'FeatureCollection', features: out };
  }

  // The pins, likewise: `fillColor` is the role colour, `color` the ring the
  // filter put on it (white, amber for a match, cyan for a station a pass range
  // pulled in), and the opacities are the focus dim. Circles rather than
  // MapLibre Markers on purpose — a Marker is a DOM node each, and this map
  // draws ~3,174 of them.
  // The What is here pick, as nothing or as one point. Read off MapHere rather
  // than kept here: the pick belongs to that tool and this view is showing it,
  // which is the same relationship the pins and links have with the 2-D map.
  function hereFeature() {
    const p = (typeof MapHere !== 'undefined' && MapHere.point) ? MapHere.point() : null;
    return {
      type: 'FeatureCollection',
      features: p ? [{ type: 'Feature', properties: {},
                       geometry: { type: 'Point', coordinates: [p[1], p[0]] } }] : [],
    };
  }

  function stationFeatures() {
    const out = [];
    for (const m of (state.mapMarkers || [])) {
      const ll = typeof m.getLatLng === 'function' ? m.getLatLng() : null;
      if (!ll) continue;
      out.push({
        type: 'Feature',
        properties: {
          id:   m.mnStationId,
          fill: m.options.fillColor || '#1565c0',
          ring: m.options.color || '#ffffff',
          r:    m.mnRadius || 5,
          w:    m.options.weight || 2,
          op:   m.options.fillOpacity == null ? 1 : m.options.fillOpacity,
        },
        geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
      });
    }
    return { type: 'FeatureCollection', features: out };
  }

  // ── the sheets ───────────────────────────────────────────────────────────
  //
  // One hop, as a vertical surface between the line of sight and the ground
  // under it. The geometry is a triangle strip: at each of SHEET_SAMPLES points
  // along the path, a vertex on the ground and a vertex on the ray.
  //
  // The maths is pathAnalyse's, not a second version of it, and the one
  // transform it needs is worth stating because getting it wrong would draw a
  // picture that disagrees with the profile card about whether a path is clear.
  //
  // A Radio Mobile profile — and path-profile.js, which is written to read like
  // one — keeps the line of sight *straight* and bends the earth up underneath
  // it: `bulged = ground + earthBulge(d1, d2, k)`, and clearance is
  // `los - bulged`. A 3-D view cannot do that: the ground is drawn where the
  // DEM says it is, because that is what the base map is draped over. So the
  // bulge is moved to the other side of the subtraction instead —
  //
  //     clearance = los - (ground + bulge) = (los - bulge) - ground
  //
  // — and the sheet's top edge is drawn at `los - bulge`: a ray that sags
  // towards the horizon exactly as far as the earth curves away under it. The
  // same clearance, the same verdict, the same number, in the frame the terrain
  // is already in.
  //
  // Vertical exaggeration multiplies both edges, so the sheet stays glued to
  // the hillside it belongs to and its apparent thickness scales with the
  // relief around it. The **colour** is computed from the true metres before
  // that multiplication, so a 2× view is a taller picture of the same answer
  // rather than a kinder one.
  function sheetFor(a, b) {
    const pa = endParams(a), pb = endParams(b);
    return Terrain.profile([[a.lat, a.lon], [b.lat, b.lon]], SHEET_SAMPLES).then(prof => {
      if (!prof || !prof.ok) return null;
      const an = pathAnalyse(prof, {
        elevA: pa.elev, elevB: pb.elev, aglA: pa.agl, aglB: pb.agl,
        freqMhz: freqFor(a, b),
      });
      if (!an || !an.ok || !an.pts || an.pts.length < 2) return null;
      const lat = prof.lat, lon = prof.lon;
      const row = [];
      for (let i = 0; i < an.pts.length; i++) {
        const p = an.pts[i];
        if (p.ground == null || lat[i] == null) continue;
        const ray = p.los - p.bulge;               // the ray, in the terrain's own frame
        // r1 is zero at both ends (d1 or d2 is zero), so the ratio there is not
        // a reading — the ends take the nearest interior sample's colour by
        // being given a clearance and no ratio, which the ramp treats as clear.
        row.push({
          lat: lat[i], lon: lon[i],
          ground: p.ground,
          ray: Math.max(ray, p.ground),            // never draw the sheet below ground
          ratio: p.ratio,
        });
      }
      return row.length >= 2 ? row : null;
    }).catch(() => null);
  }

  // Which hops get one. Terrain tiles are the cost, so the budget is spent on
  // what is being looked at: hops whose midpoint is in the current view,
  // nearest the centre first, capped. Whatever the cap drops is *counted and
  // reported* — a silent cap on a picture reads as "that is all of them", which
  // on this map means "none of the rest is obstructed".
  function sheetBudget() {
    if (!map || !state.data) return { pick: [], inView: 0, dropped: 0 };
    const b = map.getBounds();
    const byId = new Map(state.data.stations.map(s => [s.id, s]));
    const c = map.getCenter();
    const cand = [];
    for (const l of (state.mapLines || [])) {
      const role = l.mnLinkRole;
      if (role !== 'core' && role !== 'backbone') continue;
      const a = byId.get(l.mnLinkStationId != null ? l.mnLinkStationId : l.mnLinkRepeaterId);
      const z = byId.get(l.mnLinkRepeaterId2 != null ? l.mnLinkRepeaterId2 : l.mnLinkRepeaterId);
      if (!a || !z || a.lat == null || z.lat == null || a.id === z.id) continue;
      const mlat = (a.lat + z.lat) / 2, mlon = (a.lon + z.lon) / 2;
      if (!b.contains([mlon, mlat])) continue;
      cand.push({ a, z, d: acmaHaversineKm(c.lat, c.lng, mlat, mlon),
                  key: a.id < z.id ? `${a.id}|${z.id}` : `${z.id}|${a.id}` });
    }
    // One sheet per pair: a backbone path is drawn as a core and a dash, and
    // two identical surfaces in the same place is z-fighting, not emphasis.
    const seen = new Set();
    const uniq = cand.filter(x => (seen.has(x.key) ? false : (seen.add(x.key), true)));
    uniq.sort((x, y) => x.d - y.d);
    return { pick: uniq.slice(0, SHEET_MAX), inView: uniq.length,
             dropped: Math.max(0, uniq.length - SHEET_MAX) };
  }

  // Which hops are sheeted, and what each one measured — keyed by the pair, so
  // panning away and back costs nothing and the exaggeration slider costs
  // nothing at all.
  //
  // That last one is not a micro-optimisation, it is the difference between a
  // slider and a re-survey. `map.setTerrain()` fires `moveend`, so an
  // exaggeration change arrives here looking exactly like a pan — and a queue
  // that rebuilt on every arrival threw away every profile and re-fetched the
  // terrain behind it each time the slider moved a tenth. None of it can
  // change: a sheet's ground heights and Fresnel ratios are metres above sea
  // level and have nothing to do with how tall the picture is drawn.
  //
  // MapLos' cache is the model, one level down: it remembers verdicts and this
  // remembers the geometry behind one. It is not persisted, because it is
  // hundreds of samples a hop rather than a one-word verdict, and it is dropped
  // with the map.
  const sheetMem = new Map();   // 'idA|idB' → row of {lat, lon, ground, ray, ratio}

  function queueSheets() {
    sheets.gen++;
    sheets.queue = [];
    // `running` is deliberately NOT reset here. It counts promises that are in
    // flight, which is a fact about the world rather than about a generation:
    // the profiles the last round started are still running whatever this round
    // thinks, and they will each decrement it when they land. Zeroing it made
    // them decrement past zero, and `pending` — queued plus running — went
    // negative, which the panel renders as "-3 still measuring…".
    buf = null;
    if (!state.map3dSheets || !map || !ready) {
      sheets.pick = [];
      collect();
      rebuildSheets();
      return;
    }
    const { pick, inView, dropped } = sheetBudget();
    sheets.inView = inView;
    sheets.dropped = dropped;
    // What is already measured stays measured. Only the pairs that are new to
    // the view are queued, and `rows` is rebuilt from the cache each time so a
    // hop that has panned out of view stops being drawn.
    sheets.pick = pick;
    for (const p of pick) {
      if (!sheetMem.has(p.key)) sheets.queue.push({ ...p, gen: sheets.gen });
    }
    collect();
    rebuildSheets();
    pumpSheets();
  }

  // What is drawn, in the order the budget picked — nearest the centre of the
  // view first, always. Built from the cache rather than accumulated as results
  // land, so the list does not depend on the order tiles happened to arrive in:
  // the same view produces the same buffer whether the sheets were measured
  // just now or three pans ago, which is what makes the picture stable under a
  // slider and the check able to say so.
  function collect() {
    sheets.rows = [];
    sheets.done = sheets.failed = 0;
    for (const p of (sheets.pick || [])) {
      if (!sheetMem.has(p.key)) continue;
      // `null` is a remembered failure: a hop whose terrain could not be had
      // does not get asked again every time the map moves a pixel.
      const hit = sheetMem.get(p.key);
      if (hit) { sheets.rows.push(hit); sheets.done++; } else sheets.failed++;
    }
  }

  function pumpSheets() {
    while (sheets.running < SHEET_CONC && sheets.queue.length) {
      const job = sheets.queue.shift();
      sheets.running++;
      sheetFor(job.a, job.z).then(row => {
        // Remembered whichever generation asked for it — it was real work, and
        // a rebuild that happened while it was in flight does not unmake the
        // ground it measured. Bounded with the rest of the map's memory: the
        // cache dies with the GL context in close().
        sheetMem.set(job.key, row || null);
        if (job.gen !== sheets.gen) return;
        collect();
      }).finally(() => {
        // Always, and before the generation guard: this promise has landed, so
        // the in-flight count owes it a decrement whichever round queued it.
        // Clamped because close() swaps the whole ledger out from under any
        // profile still running, and a counter that can go negative is a
        // counter the panel can quote.
        sheets.running = Math.max(0, sheets.running - 1);
        if (job.gen !== sheets.gen) { pumpSheets(); return; }
        if (!sheets.queue.length && !sheets.running) rebuildSheets();
        else if (sheets.done % 8 === 0) rebuildSheets();   // show progress, not a wait
        setNote();
        pumpSheets();
      });
    }
    setNote();
  }

  // Every sheet in one pair of buffers. A strip per hop would be a draw call
  // per hop; degenerate vertices stitch them into one strip instead, which is
  // the standard trick and the difference between 80 draw calls a frame and one.
  function rebuildSheets() {
    if (!ml || !map) return;
    const exag = state.map3dExag || 1;
    const pos = [], clr = [];
    let count = 0;
    for (const row of sheets.rows) {
      const strip = [];
      for (const p of row) {
        const g = ml.MercatorCoordinate.fromLngLat({ lng: p.lon, lat: p.lat }, p.ground * exag);
        const r = ml.MercatorCoordinate.fromLngLat({ lng: p.lon, lat: p.lat }, p.ray * exag);
        // The ramp reads the Fresnel ratio, which is what pathAnalyse's verdict
        // reads: ≥0.6 clear, ≥0 marginal, <0 obstructed. Clamped either side so
        // a wildly clear hop is one green and not a gradient to white.
        const t = p.ratio == null ? 1 : Math.max(0, Math.min(1, p.ratio / 0.6));
        strip.push([g.x, g.y, g.z, t], [r.x, r.y, r.z, t]);
      }
      if (strip.length < 4) continue;
      // Degenerate joins: repeat the last vertex of the previous strip and the
      // first of this one, so the triangles between them have zero area and
      // draw nothing.
      if (count) { const prev = pos.slice(-3); strip.unshift([prev[0], prev[1], prev[2], 1]); strip.unshift(strip[1]); }
      for (const v of strip) { pos.push(v[0], v[1], v[2]); clr.push(v[3]); count++; }
    }
    buf = count >= 3 ? { pos: new Float32Array(pos), clr: new Float32Array(clr), count } : null;
    if (map.getLayer('mn-sheets')) map.triggerRepaint();
    setNote();
  }

  // ── the custom layer ─────────────────────────────────────────────────────
  // A 3-D custom layer, so MapLibre gives it the same depth buffer the terrain
  // wrote into: a sheet behind a ridge is hidden by the ridge, which is the
  // whole reading — a curtain that disappears into a hill is a hop that does
  // not clear it.
  const sheetLayer = {
    id: 'mn-sheets', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      const vs = `#version 300 es
        uniform mat4 u_matrix;
        in vec3 a_pos;
        in float a_t;
        out float v_t;
        void main() { v_t = a_t; gl_Position = u_matrix * vec4(a_pos, 1.0); }`;
      const fs = `#version 300 es
        precision highp float;
        uniform vec3 u_bad;
        uniform vec3 u_mid;
        uniform vec3 u_good;
        uniform float u_alpha;
        in float v_t;
        out vec4 fragColor;
        void main() {
          vec3 c = v_t < 0.5 ? mix(u_bad, u_mid, v_t * 2.0)
                             : mix(u_mid, u_good, (v_t - 0.5) * 2.0);
          fragColor = vec4(c * u_alpha, u_alpha);
        }`;
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      this.prog = gl.createProgram();
      gl.attachShader(this.prog, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(this.prog, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(this.prog);
      this.aPos   = gl.getAttribLocation(this.prog, 'a_pos');
      this.aT     = gl.getAttribLocation(this.prog, 'a_t');
      this.uMat   = gl.getUniformLocation(this.prog, 'u_matrix');
      this.uBad   = gl.getUniformLocation(this.prog, 'u_bad');
      this.uMid   = gl.getUniformLocation(this.prog, 'u_mid');
      this.uGood  = gl.getUniformLocation(this.prog, 'u_good');
      this.uAlpha = gl.getUniformLocation(this.prog, 'u_alpha');
      this.vbo = gl.createBuffer();
      this.tbo = gl.createBuffer();
      this.uploaded = null;
    },
    onRemove(m, gl) {
      if (this.prog) gl.deleteProgram(this.prog);
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.tbo) gl.deleteBuffer(this.tbo);
      this.prog = this.vbo = this.tbo = this.uploaded = null;
    },
    render(gl, args) {
      if (!buf || !this.prog) return;
      // MapLibre 5 hands `render` a RenderArgs object whose
      // defaultProjectionData.mainMatrix is the one to use (it is the globe-safe
      // path as well as the mercator one). Earlier majors passed the matrix
      // itself as a bare array. Both are accepted here, and a shape that is
      // neither draws nothing rather than throwing on every frame — an
      // exception in a render loop is a dead tab, not a bug report.
      const mat = Array.isArray(args) ? args
        : args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix
        : args && args.modelViewProjectionMatrix ? args.modelViewProjectionMatrix
        : null;
      if (!mat) return;
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uMat, false, mat);
      gl.uniform3fv(this.uBad,  rgb(cssVar('--map-line-blocked', '#d81b60')));
      gl.uniform3fv(this.uMid,  rgb(cssVar('--warn', '#f9a825')));
      gl.uniform3fv(this.uGood, rgb(cssVar('--ok', '#2e7d32')));
      gl.uniform1f(this.uAlpha, 0.42);
      if (this.uploaded !== buf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, buf.pos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tbo);
        gl.bufferData(gl.ARRAY_BUFFER, buf.clr, gl.DYNAMIC_DRAW);
        this.uploaded = buf;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.tbo);
      gl.enableVertexAttribArray(this.aT);
      gl.vertexAttribPointer(this.aT, 1, gl.FLOAT, false, 0, 0);
      // Premultiplied alpha, because that is what MapLibre's own framebuffer
      // is in; ONE_MINUS_SRC_ALPHA against a straight-alpha colour double-darkens
      // everything behind the sheet.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      // A sheet is a surface with two sides and it is meant to be readable from
      // both; and depth *testing* stays on (that is the occlusion) while depth
      // *writing* goes off, so two crossing sheets blend rather than one of
      // them winning the whole overlap.
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, buf.count);
      gl.depthMask(true);
    },
  };

  // '#rrggbb' → [r, g, b] in 0..1, for a shader uniform. Anything that is not a
  // six-digit hex falls back to mid grey rather than to NaN, which renders as
  // nothing at all and would read as "no sheet here".
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return new Float32Array([0.5, 0.5, 0.5]);
    const n = parseInt(m[1], 16);
    return new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
  }

  // ── building and taking down the map ─────────────────────────────────────
  function styleSpec() {
    const base = BASES[baseName()];
    return {
      version: 8,
      sources: {
        'mn-base': { type: 'raster', tiles: base.tiles, tileSize: 256,
                     maxzoom: base.maxzoom, attribution: base.attribution },
        'mn-dem':  { type: 'raster-dem', tiles: [DEM_URL], tileSize: DEM_TILE_PX,
                     maxzoom: DEM_MAXZOOM, encoding: 'terrarium',
                     attribution: Terrain.attribution },
        'mn-links':    { type: 'geojson', data: linkFeatures() },
        'mn-stations': { type: 'geojson', data: stationFeatures() },
        'mn-here':     { type: 'geojson', data: hereFeature() },
      },
      layers: [
        { id: 'mn-base', type: 'raster', source: 'mn-base' },
        // The elevation drape goes between the base and the links, and is added
        // by syncElevation() rather than declared here: it is off by default,
        // its tile template carries the relief switch, and a source whose URL
        // has to change is easier to add and drop than to edit in place.
        // The links, draped: MapLibre lays a line layer on the terrain surface,
        // which is the first of the two depictions — a line that tracks across
        // the ground.
        { id: 'mn-links', type: 'line', source: 'mn-links',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color':   ['get', 'colour'],
            'line-width':   ['get', 'width'],
            'line-opacity': ['get', 'op'],
            'line-dasharray': ['case', ['==', ['get', 'dash'], 1],
                               ['literal', [2, 3]], ['literal', [1, 0]]],
          } },
        { id: 'mn-stations', type: 'circle', source: 'mn-stations',
          paint: {
            'circle-color':        ['get', 'fill'],
            'circle-radius':       ['get', 'r'],
            'circle-stroke-color': ['get', 'ring'],
            'circle-stroke-width': ['get', 'w'],
            'circle-opacity':      ['get', 'op'],
            'circle-stroke-opacity': ['get', 'op'],
            // Left billboarded (the default, `circle-pitch-alignment: viewport`)
            // rather than laid flat on the ground: at 70° of pitch a
            // map-aligned circle is a thin ellipse, and a station pin has to
            // stay a readable dot at every camera angle.
            //
            // What it is NOT doing is deciding whether a pin behind a hill is
            // drawn. MapLibre depth-tests circle layers against the terrain by
            // itself — measured, not assumed: the same two pins either side of
            // a ridge both render with terrain off and only the near one with
            // it on. On this map that is information rather than a defect (a
            // station you can see over the ground is a station you have line of
            // sight to), but it is also a pin that is *missing*, so the panel
            // note says it out loud rather than leaving somebody to conclude a
            // station is not there.
          } },
        // ── Where the last What is here pick was (#194) ───────────────────
        // The 2-D map marks it with a Leaflet marker, which is under the
        // canvas in this mode — so a pick made here would answer about a point
        // with nothing on the map to say which point. Same cyan as
        // `.mn-here-ring` / `.mn-here-dot` in styles.css, as a ring and a dot,
        // drawn over the pins because it is the thing just asked about.
        { id: 'mn-here-ring', type: 'circle', source: 'mn-here',
          paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)',
                   'circle-stroke-color': '#00e5ff', 'circle-stroke-width': 2 } },
        { id: 'mn-here-dot', type: 'circle', source: 'mn-here',
          paint: { 'circle-radius': 3.5, 'circle-color': '#00e5ff',
                   'circle-stroke-color': 'rgba(0,0,0,.5)', 'circle-stroke-width': 2 } },
      ],
      sky: {
        'sky-color': cssVar('--map3d-sky', '#7fb3e8'),
        'horizon-color': cssVar('--map3d-horizon', '#dfeaf5'),
        'fog-color': cssVar('--map3d-fog', '#e8eef5'),
        'fog-ground-blend': 0.6,
        'horizon-fog-blend': 0.6,
      },
    };
  }

  // Add, drop or restyle the elevation drape to match what Map display says.
  // Called when the style loads, and from MapElevation whenever its switch, its
  // slider or its relief toggle moves.
  //
  // Opacity is a paint property and is set in place; the tile template is not,
  // so a relief toggle rebuilds the source. That asymmetry is MapLibre's rather
  // than a choice: `setPaintProperty` cannot change where tiles come from, and
  // the renderer will not refetch a URL it already holds.
  function syncElevation() {
    if (!map || !ready) return;
    const key = elevTiles();
    if (key !== elevKey) {
      if (map.getLayer('mn-elev')) map.removeLayer('mn-elev');
      if (map.getSource('mn-elev')) map.removeSource('mn-elev');
      elevKey = key;
      if (key) {
        map.addSource('mn-elev', {
          type: 'raster', tiles: [key], tileSize: MapElevation.TILE_PX,
          maxzoom: MapElevation.MAX_NATIVE, attribution: MapElevation.attribution,
        });
        // Above the base it is painted over, below everything the network draws
        // on top of it — the same place it occupies in 2-D, where its pane sits
        // at 245 between the base tiles and the overlays.
        map.addLayer({ id: 'mn-elev', type: 'raster', source: 'mn-elev',
                       paint: { 'raster-opacity': elevOpacity() } }, 'mn-links');
      }
      return;
    }
    if (key) map.setPaintProperty('mn-elev', 'raster-opacity', elevOpacity());
  }

  // Keep a click off the 2-D map underneath. The canvas is a child of the
  // Leaflet container, so every click on it bubbles into Leaflet's own
  // container listener and the 2-D map fires a `click` — which `initMap()`
  // wires to `clearMapFocusRepeater()` and map-here.js to its own pick. A
  // click this file has answered must not be answered again down there, with a
  // coordinate from the other camera.
  function stopBubbling(e) {
    const ev = e && e.originalEvent;
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  }

  function elevOpacity() {
    const n = Number(state.mapElevOpacity);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  }

  function build() {
    const c = leaflet.getCenter(), z = leaflet.getZoom();
    map = new ml.Map({
      container: host,
      style: styleSpec(),
      center: [c.lng, c.lat],
      // Leaflet and MapLibre share the Web Mercator zoom scale, but Leaflet's
      // 256 px tiles and MapLibre's reading of the same number differ by one
      // step — the same ground at Leaflet z12 is MapLibre z11.
      zoom: Math.max(0, z - 1),
      pitch: PITCH_HOME,
      bearing: 0,
      maxPitch: 85,
      // Pan, tilt, rotate and zoom are the whole point of this mode, so every
      // one of them is on, including the keyboard's — which is the only way a
      // keyboard user tilts anything.
      dragRotate: true, pitchWithRotate: true, touchPitch: true, keyboard: true,
      attributionControl: { compact: true },
      // A map nobody is looking at must not keep a GPU busy. MapLibre only
      // repaints on demand anyway; this stops the one case where it would not.
      refreshExpiredTiles: false,
      // ~50 tiles of base plus the DEM behind them. The default is unbounded in
      // practice, and this map is opened over a network that spans a state.
      maxTileCacheSize: 120,
    });
    map.addControl(new ml.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new ml.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // The two camera buttons in the ⛰️ cluster are a readout as well as a
    // control — the needle points where north has gone and the quad shows how
    // far the camera has dropped — so they follow the drag rather than waiting
    // for it to end. Both events fire per frame while a right-drag is running
    // and each costs two `innerHTML` writes on a 15 px SVG; `moveend` was the
    // alternative and it is the wrong one, because the whole value of a needle
    // is that it moves *with* the map you are turning.
    map.on('rotate', syncCamera);
    map.on('pitch', syncCamera);

    map.on('style.load', () => {
      ready = true;
      map.setTerrain({ source: 'mn-dem', exaggeration: state.map3dExag || 1 });
      map.addLayer(sheetLayer);
      syncElevation();
      queueSheets();
      setNote();
      syncCamera();
    });

    // A DEM tile that will not come is flat ground on screen, and flat ground
    // reads as a clear path. It is counted and said out loud (see noteHtml).
    map.on('error', e => {
      const src = e && e.sourceId;
      if (src === 'mn-dem') { demFails++; setNote(); }
    });
    map.on('moveend', () => { if (state.map3dSheets) queueSheets(); });
    // ── Clicking a pin (#193) ──────────────────────────────────────────────
    // A pin in 3-D does what a pin in 2-D does, less the one thing this mode
    // has no way to draw. onStationClick() in app.js opens a Leaflet callout
    // on the marker and then paints the card; there are no Leaflet layers on
    // screen here, so the callout half has nowhere to go and the rest is
    // mirrored in the order 2-D runs it:
    //
    //   1. an armed link-budget picker owns the click. mapPickStation() guards
    //      itself on `picking` and returns whether it took the click, so this
    //      is the same fast path 2-D takes without re-reading the flag.
    //   2. a repeater toggles the focus dim, which is a *2-D* overlay — and
    //      that is the point rather than a problem: it restyles the lines and
    //      pins this view is mirroring, so refreshMapLayers() → Map3D.sync()
    //      lands the dim on the terrain a frame later.
    //   3. and the card, which is what was asked for.
    //
    // The station is looked up off `state.mapMarkers` rather than out of
    // `state.data`, for this file's standing reason: that array is what the
    // mirror is built from, so a pin that can be clicked here is by
    // construction a pin the 2-D map drew, with the 2-D map's own idea of what
    // station it is.
    //
    // **One handler, because the precedence matters.** In 2-D these are two
    // separate listeners that never both run, and Leaflet is what keeps them
    // apart: its canvas renderer calls `fakeStop` when a click lands on a
    // layer, which stops the map firing a click of its own, so a pin click is
    // never also a What is here pick. MapLibre has no equivalent — a
    // layer-scoped listener and a plain one both fire, in registration order —
    // so the order is written out here instead of relied upon.
    map.on('click', e => {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['mn-stations'] })[0];
      const id  = hit && hit.properties ? hit.properties.id : null;
      if (id != null) { clickedStation(id, e); return; }
      // Empty ground, with the pick armed: this is the bridge (#194). The 2-D
      // map's own click carries `latlng` for that pixel on the *Leaflet* map,
      // and in this mode that is a different camera — its own centre, zoom,
      // pitch and bearing — so the answer it gives is confidently about the
      // wrong ground, ~150 m out with the camera barely moved and unbounded
      // after a pan. The renderer knows where the pointer actually is on the
      // terrain; that is what MapHere gets, and the Leaflet click is stopped so
      // it cannot also arrive with the other number.
      if (typeof MapHere !== 'undefined' && MapHere.armed()
          && MapHere.pick(e.lngLat.lat, e.lngLat.lng)) {
        stopBubbling(e);
        return;
      }
      // Empty ground with nothing armed is left to bubble into the Leaflet
      // container below, where the 2-D map's own click handler clears the
      // focused repeater and the ACMA highlight. Neither of those reads a
      // coordinate, so the wrong projection cannot hurt them — and they are
      // the one thing in the 2-D click that is still worth having here.
    });

    // A pin. The same things onStationClick() in app.js does, less the Leaflet
    // callout, which has nowhere to open in this mode:
    //
    //   1. an armed link-budget picker owns the click. mapPickStation() guards
    //      itself on `picking` and returns whether it took the click, which is
    //      the same fast path 2-D takes.
    //   2. a repeater toggles the focus dim. That is a *2-D* overlay, and that
    //      is the point rather than a problem: it restyles the lines and pins
    //      this view is mirroring, so refreshMapLayers() → Map3D.sync() lands
    //      the dim on the terrain a frame later.
    //   3. and the card.
    //
    // The station is looked up off `state.mapMarkers` rather than out of
    // `state.data`, for this file's standing reason: that array is what the
    // mirror is built from, so a pin that can be clicked here is by
    // construction a pin the 2-D map drew, with the 2-D map's own idea of what
    // station it is.
    function clickedStation(id, e) {
      stopBubbling(e);
      if (typeof LinkBudget !== 'undefined' && LinkBudget.mapPickStation(id)) return;
      const marker = (state.mapMarkers || []).find(m => m.mnStationId === id);
      const st = marker && marker.mnStation;
      if (st && st.roles && st.roles.includes('repeater')
          && typeof setMapFocusRepeater === 'function') {
        setMapFocusRepeater(state.mapFocusRepeaterId === st.id ? null : st.id);
      }
      if (typeof showStationCard === 'function') showStationCard(id);
    }
    map.on('mouseenter', 'mn-stations', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'mn-stations', () => { map.getCanvas().style.cursor = ''; });
  }

  function makeHost() {
    const el = leaflet && leaflet.getContainer();
    if (!el) return null;
    let h = el.querySelector('#map3d');
    if (!h) {
      h = document.createElement('div');
      h.id = 'map3d';
      // Above every Leaflet pane (the popup pane, the highest, is 700) and below
      // the control *corners* — `.leaflet-top` / `.leaflet-bottom`, which are
      // positioned at 1000 and so stack their contents as a unit, whatever
      // `.leaflet-control`'s own 800 suggests. styles.css holds the window and
      // the reasoning; the value is there, not here.
      //
      // The effect is what matters: the 3-D view covers the 2-D map completely
      // while the on-map panels, the base-map picker and the corner buttons
      // stay where they are and keep working. That is what lets one set of
      // controls drive both modes instead of two sets drifting apart.
      el.appendChild(h);
    }
    return h;
  }

  // The note only. Called on every sheet that lands and every DEM tile that
  // does not, so it must not rebuild the panel under a pointer that is using it.
  function setNote() {
    const el = document.getElementById('map-3d-note');
    if (el) el.innerHTML = noteHtml();
  }

  // The whole panel, and the corner button with it. Called when the *mode*
  // changes, which is the only time the panel's controls change shape.
  function repaintPanel() {
    const body = document.getElementById('map-3d-panel-body');
    if (body && body.parentNode) body.outerHTML = Map3D.panelHtml();
    for (const btn of document.querySelectorAll('.mn-map-3d')) {
      btn.setAttribute('aria-pressed', state.map3d ? 'true' : 'false');
      btn.classList.toggle('is-on', !!state.map3d);
    }
    syncCamera();
  }

  // ── The camera buttons (#192) ──────────────────────────────────────────────
  // 🧭 and the tilt quad, in the ⛰️ cluster in the map's corner. They exist
  // because the two things a right-drag does are the two things it is hardest
  // to undo: a map turned 37° is a map you have to turn 37° back by hand, and
  // a camera dropped to the horizon cannot be raised by any gesture a mouse
  // wheel offers. `levelCamera()` has always done both at once from inside the
  // panel; these are its halves, one press each, without opening anything.
  //
  // They are drawn from the camera rather than labelled once, and that is half
  // of what they are for. A needle at 0° tells you the map is north-up; a
  // needle at 37° is how you *find out* it is not — which is a question
  // somebody four drags into a hillside does not know to ask.
  //
  // Hidden while the map is flat: Leaflet has no camera at all, so in 2-D
  // north is always up and the tilt is always nil, and a control that cannot do
  // anything should not be occupying a corner of the map (map-controls.js says
  // the same thing at more length about flyouts).

  // The needle, pointing at where north has gone. Bearing is the map's
  // rotation, so the needle turns the other way.
  function northIcon(deg) {
    const r = -(((Number(deg) || 0) % 360 + 360) % 360);
    return `<svg class="mn-compass" viewBox="0 0 16 16" width="15" height="15"`
         + ` aria-hidden="true" style="transform: rotate(${r.toFixed(1)}deg)">`
         + `<polygon class="mn-compass-n" points="8,1.5 10.8,8.4 5.2,8.4"/>`
         + `<polygon class="mn-compass-s" points="8,14.5 10.8,7.6 5.2,7.6"/></svg>`;
  }

  // A patch of ground, seen from wherever the camera is. Square when it is
  // straight overhead, foreshortened into a trapezoid as it drops — the same
  // picture the view itself is showing, which is what makes it readable without
  // a legend. Clamped against MapLibre's own maxPitch so the far edge cannot
  // cross the near one.
  function tiltIcon(deg) {
    const k  = Math.max(0, Math.min(1, (Number(deg) || 0) / 85));
    const tw = 6 - 3.6 * k;                    // the far edge, foreshortened
    const y  = (4 + 1.6 * k).toFixed(1);       // …and dropping towards the horizon
    return `<svg class="mn-tilt" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">`
         + `<polygon points="${(8 - tw).toFixed(1)},${y} ${(8 + tw).toFixed(1)},${y}`
         + ` 14,12.6 2,12.6"/></svg>`;
  }

  // Both buttons, redrawn and relabelled from the camera. Called on every
  // rotate and every pitch while 3-D is open, and by repaintPanel() when the
  // mode itself changes — which is what shows them and what puts them away.
  function syncCamera() {
    const on = !!state.map3d && !!map;
    const b  = on ? Math.round(((map.getBearing() % 360) + 360) % 360) % 360 : 0;
    const p  = on ? Math.round(map.getPitch()) : 0;
    for (const el of document.querySelectorAll('.mn-map-north')) {
      el.hidden = !on;
      const ico = el.querySelector('.mn-mapctl-ico');
      if (ico) ico.innerHTML = northIcon(b);
      // The label carries the reading, because the needle does not: an operator
      // who cannot see it has no other way to be told the map is turned.
      label(el, b ? `Face north again — the map is turned ${b}°` : 'Facing north already');
    }
    for (const el of document.querySelectorAll('.mn-map-tilt')) {
      el.hidden = !on;
      const ico = el.querySelector('.mn-mapctl-ico');
      if (ico) ico.innerHTML = tiltIcon(p);
      // Two presses rather than one, and the label always says which one this
      // is. A reset that only ever flattens leaves the operator who pressed it
      // by accident with no way back that does not involve discovering the
      // right-drag; the second press is that way back.
      label(el, p > 1 ? `Look straight down — the camera is tilted ${p}°`
                      : `Tilt back to ${PITCH_HOME}°`);
    }
  }

  // The tooltip and the accessible name are the same sentence, as they are on
  // every other button in that corner (MapChrome).
  function label(el, text) {
    el.title = text;
    el.setAttribute('aria-label', text);
  }

  function noteHtml() {
    if (libErr) {
      return `<span class="txt-bad">The 3-D view could not start — ${esc(libErr)}.</span>
              It needs its renderer from unpkg.com and terrain tiles from
              elevation-tiles-prod, so a blocked network or an offline session
              has no 3-D view. The 2-D map is unaffected.`;
    }
    if (!state.map3d) {
      return `Tilt the map and see the ground it is drawn on. The same base map,
              the same pins and the same links, draped over ~30 m SRTM terrain.
              Drag to pan, right-drag (or Ctrl-drag) to tilt and rotate, scroll to
              zoom. Terrain and tiles are fetched for the view you are looking at,
              so a session costs what you look at and no more.`;
    }
    const bits = [];
    if (demFails) {
      bits.push(`<span class="txt-warn">${demFails} terrain tile${demFails === 1 ? '' : 's'}
                 could not be fetched — that ground is drawn flat, which reads as
                 a clear path and is not one.</span>`);
    }
    if (state.map3dSheets) {
      if (sheets.done) bits.push(`${sheets.done} hop${sheets.done === 1 ? '' : 's'} sheeted`);
      const pending = sheets.queue.length + sheets.running;
      if (pending) bits.push(`${pending} still measuring…`);
      if (sheets.dropped) {
        bits.push(`<span class="txt-warn">${sheets.dropped} of ${sheets.inView} hops in view
                   were not sheeted — the cap is ${SHEET_MAX}. Zoom in to sheet the rest;
                   an unsheeted hop is not a clear one.</span>`);
      }
      if (sheets.failed) {
        bits.push(`<span class="txt-warn">${sheets.failed} could not be measured —
                   terrain tiles unreachable?</span>`);
      }
      if (!bits.length) bits.push('no hops in view to sheet');
    }
    const caveat = `A pin behind a hill is hidden by it — which is worth knowing both
      ways round: a station you cannot see from here has no line of sight from here,
      and a station you are looking for may be over the next ridge rather than absent.
      Relief is ~30 m SRTM above the EGM96 geoid, and the sheet is the
      Path profile tool’s own geometry — k-factor earth, filed antenna heights,
      no trees. Green clears the 60% Fresnel zone, amber is inside it, red is
      blocked. Indicative, like the profile.`;
    return `${bits.length ? bits.join(' · ') + '<br>' : ''}${caveat}`;
  }

  return {
    // initMap calls this on every render of the Stations tab, with the map it
    // has just built. 3-D does not survive a rebuild — the container it drew
    // into went with the old map — so it is closed rather than re-parented.
    attach(m) {
      close();
      leaflet = m;
    },

    active() { return !!state.map3d; },

    // The ⛰️ corner button, and the panel's own switch.
    toggle() { return state.map3d ? (close(), Promise.resolve(false)) : open(); },

    // refreshMapLayers has rebuilt every line and pin, so the mirror is stale.
    // Cheap when 3-D is shut, which is almost always: two early returns.
    sync() {
      if (!state.map3d || !map || !ready) return;
      const ls = map.getSource('mn-links'), ss = map.getSource('mn-stations');
      if (ls) ls.setData(linkFeatures());
      if (ss) ss.setData(stationFeatures());
      const hs = map.getSource('mn-here');
      if (hs) hs.setData(hereFeature());
      queueSheets();
    },

    // The vertical sheets. Off by default and not remembered — MapLos'
    // reasoning, and the same cost: this one fetches terrain tiles per hop.
    setSheets(on) {
      state.map3dSheets = !!on;
      queueSheets();
      setNote();
      announce(on ? 'Line-of-sight sheets on' : 'Line-of-sight sheets off');
    },

    // Vertical exaggeration. Remembered, because it is how this operator reads
    // a landscape rather than something they are doing right now.
    setExaggeration(x) {
      const v = Math.max(1, Math.min(3, Number(x) || 1));
      state.map3dExag = v;
      try { localStorage.setItem('mn-3d-exag', String(v)); } catch (_) {}
      const out = document.getElementById('map-3d-exag-out');
      if (out) out.textContent = `${v.toFixed(1)}×`;
      if (map && ready) {
        map.setTerrain({ source: 'mn-dem', exaggeration: v });
        rebuildSheets();
      }
    },

    // The 🗺️ picker changed the 2-D base map, so the drape changes with it.
    // The raster source's tiles cannot be swapped in place, so the source is
    // replaced and the layer re-added above the links — which keeps the layer
    // order right without rebuilding the map, the terrain or the sheets.
    baseChanged() {
      if (!state.map3d || !map || !ready) return;
      const base = BASES[baseName()];
      if (map.getLayer('mn-base')) map.removeLayer('mn-base');
      if (map.getSource('mn-base')) map.removeSource('mn-base');
      map.addSource('mn-base', { type: 'raster', tiles: base.tiles, tileSize: 256,
                                 maxzoom: base.maxzoom, attribution: base.attribution });
      // Under the elevation drape when there is one, and under the links
      // either way — a base re-added over the top of the ramp would put the
      // picker's choice where Map display's overlay belongs.
      map.addLayer({ id: 'mn-base', type: 'raster', source: 'mn-base' },
                   map.getLayer('mn-elev') ? 'mn-elev' : 'mn-links');
    },

    // Map display's elevation switch, its opacity slider or its relief toggle
    // moved (map-elevation.js). A no-op unless 3-D is actually open.
    elevationChanged() { syncElevation(); },

    // What is here picked a point, or closed. Same shape, and for the same
    // reason: the pick is that tool's and this view is only showing it.
    hereChanged() {
      if (!map || !ready) return;
      const s = map.getSource('mn-here');
      if (s) s.setData(hereFeature());
    },

    // Put the camera back overhead without leaving 3-D — the gesture that gets
    // somebody un-lost after a rotate, and the one thing a tilted map makes
    // genuinely hard to do by hand. Both halves at once; the two corner buttons
    // below are each of them on its own.
    levelCamera() {
      if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
    },

    // North, keeping whatever tilt the operator has chosen. The 🧭 button.
    resetNorth() {
      if (!map) return;
      map.easeTo({ bearing: 0, duration: 400 });
      announce('Facing north');
    },

    // Tilt, keeping whatever bearing they are on — and a press at a time.
    // Flat is the reset, PITCH_HOME is the way back, and the button's own label
    // says which press this is (syncCamera). A control that only flattens is a
    // control somebody presses once and then has to find the right-drag to
    // undo, which is the gesture they were avoiding by reaching for a button.
    resetTilt() {
      if (!map) return;
      const flat = map.getPitch() <= 1;
      map.easeTo({ pitch: flat ? PITCH_HOME : 0, duration: 400 });
      announce(flat ? `Tilted back to ${PITCH_HOME} degrees` : 'Looking straight down');
    },

    // What app.js builds those two buttons' icons out of, so the markup for a
    // needle and a foreshortened quad lives with the camera it describes rather
    // than in the file that decides where in the corner they go.
    northIcon, tiltIcon,

    // The 3-D panel, in the idiom every other on-map panel is written in:
    // `.filter-check` switches, a `.filter-range` slider, bare buttons and a
    // `.filter-note` under them. Re-rendered in place by rerenderMap3dPanel()
    // rather than by rebuilding the map, so entering 3-D does not throw away
    // the panel that was used to enter it.
    panelHtml() {
      const on = !!state.map3d;
      const ex = state.map3dExag || 1;
      return `
        <div class="map3d-panel" id="map-3d-panel-body">
          <div class="map3d-actions">
            <button type="button" id="map-3d-toggle" class="${on ? '' : 'primary'}"
                    aria-pressed="${on}" onclick="Map3D.toggle()">
              ${on ? 'Leave 3-D' : 'Enter 3-D'}
            </button>
            <button type="button" onclick="Map3D.levelCamera()" ${on ? '' : 'disabled'}
                    title="Point the camera straight down and north-up again — the 🧭 and tilt
                           buttons in the corner do one each">Level the camera</button>
          </div>
          <label class="filter-check"
                 title="A surface between each hop's line of sight and the ground under it, shaded green where it clears the 60% Fresnel zone and red where the ground is above the line. Costs terrain tiles, so it is off until asked for.">
            <input type="checkbox" ${state.map3dSheets ? 'checked' : ''}
                   ${on ? '' : 'disabled'}
                   onchange="Map3D.setSheets(this.checked)">
            Line-of-sight sheets
          </label>
          <label class="filter-range${on ? '' : ' is-off'}">
            <span>Vertical exaggeration
              <strong id="map-3d-exag-out" aria-hidden="true">${ex.toFixed(1)}×</strong></span>
            <input type="range" id="map-3d-exag" min="1" max="3" step="0.1" value="${ex}"
                   aria-label="Vertical exaggeration"
                   aria-valuetext="${ex.toFixed(1)} times"
                   ${on ? '' : 'disabled'}
                   oninput="Map3D.setExaggeration(this.value)">
          </label>
          <p class="filter-note">The base map is whichever one the 🗺️ picker is on, and the
            pins and links are the ones the 2-D map has drawn — the same filters, the same
            colouring, the same hidden and culled sets.</p>
          <p class="filter-note" id="map-3d-note">${noteHtml()}</p>
        </div>`;
    },

    noteHtml,

    // Registered from initMap as its own teardown key, so leaving the Stations
    // tab takes the GL context down with it rather than leaving one live behind
    // whatever tab replaced it. `map.remove()` is MapLibre's own full teardown:
    // the context, the workers and every tile with it.
    stop() { close(); },

    // For the check (test/map3d.mjs): what the mirror and the sheets currently
    // say, in metres and degrees, without a browser having to read a WebGL
    // buffer back. The geometry in `buf` is the same numbers run through
    // MercatorCoordinate, so asserting these asserts the picture — and asserting
    // them in metres is what makes the assertions arithmetic rather than
    // "whatever the shader drew".
    _mirror() { return { links: linkFeatures(), stations: stationFeatures() }; },
    _sheets() { return { rows: sheets.rows.length, done: sheets.done,
                         failed: sheets.failed, dropped: sheets.dropped,
                         inView: sheets.inView, verts: buf ? buf.count : 0,
                         // Queued plus in flight — the only honest "is it
                         // finished". `rows` and `done` count the same thing,
                         // so a caller waiting for those to agree waits for
                         // nothing (test/map3d.mjs found this the hard way).
                         pending: sheets.queue.length + sheets.running }; },
    _sheetRows() { return sheets.rows; },
    // The same profile the sheet is built from, computed on demand for one
    // named pair — so the check can hold the sheet against pathAnalyse's own
    // numbers rather than against a copy of them.
    _sheetFor(a, b) { return sheetFor(a, b); },
    _map() { return map; },
  };

  // ── open / close ─────────────────────────────────────────────────────────
  // Declared below the return because nothing here runs at load (#142) and the
  // pair reads better next to each other than split around the public face.
  function open() {
    if (state.map3d || !leaflet) return Promise.resolve(false);
    host = makeHost();
    if (!host) return Promise.resolve(false);
    host.classList.add('is-loading');
    return loadLib().then(() => {
      state.map3d = true;
      demFails = 0;
      libErr = null;
      host.classList.remove('is-loading');
      host.classList.add('is-on');
      build();
      repaintPanel();
      announce('3-D view on. Right-drag or Ctrl-drag to tilt and rotate.');
      return true;
    }).catch(() => {
      host.classList.remove('is-loading');
      repaintPanel();
      announce('The 3-D view could not start.');
      return false;
    });
  }

  function close() {
    if (map) { try { map.remove(); } catch (_) {} }
    map = null;
    ready = false;
    buf = null;
    elevKey = null;   // the drape goes with the map; the next one builds its own
    // Hundreds of samples a hop, and every one of them re-derivable from tiles
    // Terrain still has cached. It goes with the map.
    sheetMem.clear();
    sheets = { rows: [], pick: [], queue: [], running: 0, gen: sheets.gen + 1,
               done: 0, failed: 0, dropped: 0, inView: 0 };
    if (host) { host.classList.remove('is-on', 'is-loading'); host.remove(); }
    host = null;
    if (state.map3d) {
      state.map3d = false;
      repaintPanel();
      announce('3-D view off');
    }
  }
})();
if (typeof window !== 'undefined') window.Map3D = Map3D;
