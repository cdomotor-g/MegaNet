// MegaNet — twin-cadastre.js
//
//   TwinCadastre   the Queensland cadastre in the Digital Twin: every lot's
//                  boundary lying on the twin's ground with its lot number and
//                  plan written in it, and the road reserve — outlined, washed
//                  in the road colour and named. The layers Queensland Globe
//                  draws as land parcels, and the Stations map as Property
//                  boundaries (map-lots.js) and Road parcels (map-roads.js),
//                  in every view the twin has — orbit, top-down and the POV —
//                  on the Digital Twin tab and inside the Stations map.
//
// After digital-twin.js, whose scene it draws into, and before map-twin.js,
// which hosts the same scene — index.html holds the order. Reaches back to
// core.js for esc; across to map-roads.js for the road colour
// (MapRoads.legendColour), so the twin's road reserve and the map's are one
// colour. Everything it draws with — three.js, the scene, the camera, the
// ground and its heights — digital-twin.js hands it through one object (see
// "the seam" below), so it reaches into nothing of the twin's own. Every one of
// those is a runtime call from inside a function, so its position among the
// modules is free; nothing executes at load (`npm run toplevel`).
//
// ── What is asked for, and of whom ───────────────────────────────────────────
//
// The Land Parcel Property Framework — the DCDB as a map service, the one the
// two map layers above already ask, updated nightly, CORS reflecting any
// origin — sublayer "Cadastral parcels", probed by name as map-roads.js probes
// it. One query per patch: every parcel whose shape touches the patch's box,
// as GeoJSON to the centimetre and not generalised (map-roads.js takes ~10 m
// off its road reserves because a map at zoom 13 cannot see ten metres; the
// twin stands on 10 cm imagery and can). A 400 m patch in Gatton is 134
// parcels and 67 KB; the densest patch measured, 1.6 km of Toowoomba, is
// 3,300 parcels and 150 KB on the wire. The service stops at 4,000 a page, so
// a patch is read in pages to MAX_PARCELS and a patch past that says so.
//
// Only two of the four coverage types are asked for. `Base` is the ground
// itself — lots, road reserve, watercourses — and `Easement` the rights over
// it. `Strata` and `Volumetric` subdivide *buildings* (the units in a block,
// the airspace over a road), and drawn on the ground they are a knot of
// overlapping rectangles on every block of units, saying nothing about whose
// ground it is. The Surfers Paradise patch is 380 parcels with them and 217
// without.
//
// Nothing is fetched while both switches are off, nothing outside the
// service's own extent, and one answer per patch is kept for the session
// (CACHE_MAX), so a rebuild — another exaggeration, another station and back —
// is drawn from memory. A patch the service could not answer is not kept:
// Rebuild asks again.
//
// ── How a line lies on the ground ───────────────────────────────────────────
//
// The ground is a 201 × 201 grid, each cell two triangles split along the
// same diagonal PlaneGeometry puts them on. Lifted a few centimetres a
// boundary floats in the air in POV and sinks into every hummock at a
// distance — the wireframe's reason for riding the ground's own vertices
// (digital-twin.js, "polygonOffset pushes the ground back"). So every
// boundary segment is cut wherever it crosses a grid line or a cell's
// diagonal, and each cut point is given the height of the triangle it is on:
// every piece of line then lies *in* one of the ground's triangles, exactly,
// at any exaggeration (the relief is kept per vertex and multiplied).
//
// Exactly on the ground, a line wins the depth test against it only because
// the ground is pushed back. The sharp drape round the station — the 10 cm
// photograph, which is where a boundary matters most — is pulled *forward*
// over the ground by the same trick, on a mesh of its own. Lines cannot take
// a polygon offset, so the lines here take the vertex shader's equivalent:
// every vertex is moved toward the eye along its own line of sight (the same
// pixel on the screen, a nearer depth) by a few pixels' worth of the ground's
// depth at that angle — more at a grazing angle, where a pixel of ground is
// deep, and less looking straight down. Enough to lie over the sharp drape;
// nowhere near enough to show through a bridge deck, a pole or a hill.
//
// A single colour cannot hold over aerial photography — white is lost on a
// roof and a road, dark in a shadow — so each line is the map's own answer,
// a light line over a dark casing: the same line drawn five times, four of
// them a pixel off each way in the casing's colour (a nudge in the same
// vertex shader). Lot boundaries are white, the road reserve is the road
// colour, easements are a white dash with no casing.
//
// ── The road reserve ─────────────────────────────────────────────────────────
//
// Road parcels, and the crossing squares the DCDB files at every junction
// under `'Unlinked parcel or inter'` — joined to the roads whose corners they
// share and otherwise refused, map-roads.js's rule and for its reason (a
// junction left out is a hole in the reserve; an unlinked remnant put in is a
// road that is not there). Drawn as its **outline**: an edge two road parcels
// share is inside the reserve and not drawn, an edge a road shares with a lot
// is drawn once, in the road colour, and not again in white — so the yellow
// line is the reserve's edge and nothing else. Inside it, a wash of the road
// colour, painted on a canvas and laid on the ground's own geometry (shared,
// so it goes wherever the exaggeration takes the ground). The road's name is
// written in it.
//
// ── The lot numbers ─────────────────────────────────────────────────────────
//
// Written on a flat canvas over the stage rather than into the scene: a
// suburb at 1.6 km is 3,000 lots, and a sprite each is 3,000 textures and
// 3,000 draw calls. So each label is a point in the scene — the lot's pole of
// inaccessibility, the point inside it furthest from its edges, which is where
// a map writes a name — projected each time the view changes, and written
// there with a dark halo, in the page's own font, at the page's own
// resolution.
//
// The rule for which labels are written is a map's, measured on the screen:
// a lot's number goes in when the lot is big enough on screen to hold it —
// the circle inside it at that point, its diameter against the label's width
// and, foreshortened by the angle it is seen at, against the label's height
// — so looking down on a town the numbers come in as the camera does, and in
// the POV only the lots near the eye are written. The road's name wants the
// length of its parcel, not its width. Then nearest first, no two labels
// overlapping, none over a sign the scene stands up (the station's name, a
// neighbour's, a radio path's) or under one of the stage's own controls (the
// compass, the flood's scale, the line of help along its foot), none whose
// point a hill between it and the eye hides, at most LABEL_MAX. The lot the
// station stands in is written first and whatever its size — stepped clear of
// the sign over the station if that stands on its point.
//
// ── What the twin says ──────────────────────────────────────────────────────
//
// On the line under the stage: which lot the station stands in, its tenure
// and area, how far it is to the road reserve and which way — or that it
// stands *in* the reserve, and whose road it is — and how well the cadastre
// is plotted there. That last is the DCDB's own accuracy code: 0.3 m in a
// surveyed town, 25 m where it was compiled off a 1:10,000 map, and 126 m
// in the far west. The imagery under the lines is flown to 10 cm, so a
// boundary 25 m off the fences in the photograph is the cadastre being as
// good as it is, not the twin being wrong, and a station plotted that coarse
// gets a note saying so. A click on the ground says which parcel it is in.
// Easements are named there and not written on the ground.
//
// Not in the .glb — Blender gets the site, and a boundary is a statement
// about the site rather than a part of it — and nothing here takes the
// pointer: the labels are a picture, the lines are not in the ray cast, and
// a click on the ground is still a click on the ground.
//
// ── The seam ─────────────────────────────────────────────────────────────────
//
// load(host) is called by the twin's build once its ground is standing, and
// remove() by its teardown. `host` carries everything drawn with:
//
//   THREE, scene, camera, canvas, stage   the renderer's own objects
//   terrain                               the ground's mesh (the wash shares its geometry)
//   ground, origin, box                   the heights, the station, the patch's box
//   exag()                                the vertical exaggeration now
//   toXZ(lat, lon)                        the twin's own lat/lon → metres
//   surfaceY(x, z)                        the ground as drawn, horizon included
//   current()                             whether that build still stands
//   requestFrame(), refresh(), note(list) ask for a frame; the words under the
//                                         stage changed; something needs saying
//
// frame() is called after each frame is drawn, relift() when the exaggeration
// moves, and lineHtml(), pickWords(), attribution() and panelHtml() by the
// parts of the twin that say things.
const TwinCadastre = (function () {
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer';
  // Resolved by name at runtime — map-roads.js's probe, for the same sublayer.
  const FALLBACK_ID = 4;
  const LAYER_RE    = /cadastral\s+parcels/i;
  const WHERE       = "cover_typ IN ('Base','Easement')";
  const FIELDS      = 'lot,plan,parcel_typ,cover_typ,tenure,lot_area,feat_name,locality,shire_name,acc_code';
  const PAGE        = 4000;     // the service's maxRecordCount
  const MAX_PARCELS = 8000;     // two pages: the densest patch measured is 3,300
  const TIMEOUT_MS  = 30000;
  const CACHE_MAX   = 4;
  // The service's own extent — its Web Mercator box taken back to degrees and
  // rounded outward. A patch wholly outside it is not asked about.
  const EXTENT = { west: 137.5, east: 154.1, south: -29.6, north: -8.4 };
  const ATTRIBUTION = 'Cadastre: © State of Queensland (Department of Natural Resources and Mines, '
                    + 'Manufacturing and Regional and Rural Development)';
  // The `parcel_typ` spellings, the second truncated at 24 characters as the
  // DCDB publishes it (map-roads.js's header has the story).
  const LOT_TYPE = 'Lot Type Parcel', ROAD_TYPE = 'Road Type Parcel', NODE_TYPE = 'Unlinked parcel or inter',
        WATER_TYPE = 'Watercourse';
  // What the DCDB writes in `feat_name` for a road nobody named: 64,399 of the
  // State's 383,176 road parcels are called "Road", and a few hundred "Street"
  // or "Lane" (and "Rpad"). Those are not names, and a reserve carrying one is
  // an unnamed reserve — never "the road reserve of Road".
  const NOT_A_NAME = /^(road|rpad|street|lane)$/i;
  const KEY = 'mn-twin-cadastre';

  // ── the look ──
  const CASING      = 0x141414;
  const CASING_A    = 0.55;
  const LOT_COLOUR  = 0xffffff;
  const EASE_COLOUR = 0xffffff;
  const WASH_A      = 0.2;
  const WASH_PX     = 1024;     // the wash's canvas: 0.39 m a pixel at 400 m, under a crisp outline
  const NUDGE_PX    = 1.25;     // the casing's offset each way, CSS pixels
  const PULL_PX     = 3;        // the pull toward the eye, in pixels' worth of ground (see the header)
  const LABEL_MAX   = 160;
  const LABEL_PAD   = 3;        // CSS pixels kept clear round a label
  const LIFT        = 0.5;      // metres: a label's point over its ground, clear of the ground it is written on
  const HALO        = 'rgba(10, 14, 18, 0.88)';
  const FONT_LOT    = '600 12px system-ui, sans-serif';
  const FONT_PLAN   = '500 10.5px system-ui, sans-serif';
  const FONT_NAME   = 'italic 600 12px system-ui, sans-serif';
  const TEXT_LOT    = '#ffffff', TEXT_PLAN = '#dde6ee', TEXT_ROAD = '#ffd166', TEXT_WATER = '#9ad7ff';
  const COARSE_M    = 5;        // plotted coarser than this: a note says the lines can be that far off

  let prefs = null;
  let layerId = null, resolving = null;
  const cache = new Map();      // box key → Promise<{ parcels, capped, failed }>

  // The live state, all of it dropped by remove().
  let host = null;
  let seq = 0;                  // a load that finds this moved stands down
  const cad = {
    status: 'off',              // 'off' | 'outside' | 'loading' | 'fail' | 'empty' | 'ok'
    failed: null, capped: false,
    parcels: null,              // this patch's, in the twin's metres — see prepare()
    station: null,              // { main, easements, road: { d, bearing, p } | null, acc }
    group: null,                // the lines and the wash
    parts: null,                // { lots, lotsAlongRoad, roads, easements, wash }: what is in the group
    labels: [],                 // every label the patch has
    counts: null,
  };
  const lab = { canvas: null, ctx: null, key: null, placed: [] };
  let U = null;                 // the shader uniforms every material here shares

  // ── settings ───────────────────────────────────────────────────────────────
  // Both on by default and remembered, the Stations map's two switches' terms:
  // the twin is a close look at one site, which is when "whose land is this
  // on?" is asked, and an operator who turns them off means it.
  function P() {
    if (prefs) return prefs;
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { s = {}; }
    prefs = { lots: s.lots !== false, roads: s.roads !== false };
    return prefs;
  }
  function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(P())); } catch (_) {} }

  function roadColour() {
    return typeof MapRoads !== 'undefined' && MapRoads.legendColour ? MapRoads.legendColour() : '#f9a825';
  }

  // ── asking ─────────────────────────────────────────────────────────────────
  async function askJson(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'the service refused the query');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  function resolveLayer() {
    if (layerId != null) return Promise.resolve(layerId);
    if (resolving) return resolving;
    resolving = askJson(`${SERVICE_URL}?f=json`).then(json => {
      const hit = ((json && json.layers) || [])
        .find(l => LAYER_RE.test(String(l.name || '')) && !/deprecated/i.test(String(l.name || '')));
      layerId = hit ? hit.id : FALLBACK_ID;
      return layerId;
    }).catch(() => { layerId = FALLBACK_ID; return layerId; });
    return resolving;
  }

  function queryUrl(id, box, offset) {
    const q = new URLSearchParams({
      where: WHERE,
      geometry: `${box.west},${box.south},${box.east},${box.north}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: FIELDS, returnGeometry: 'true', geometryPrecision: '7',
      orderByFields: 'objectid', resultOffset: String(offset), resultRecordCount: String(PAGE),
      f: 'geojson',
    });
    return `${SERVICE_URL}/${id}/query?${q}`;
  }

  // Page after page until the service says there is no more, or MAX_PARCELS.
  async function fetchBox(box) {
    const id = await resolveLayer();
    const features = [];
    let more = true;
    while (more && features.length < MAX_PARCELS) {
      const json = await askJson(queryUrl(id, box, features.length));
      const got = (json && json.features) || [];
      for (const f of got) features.push(f);
      more = got.length > 0 && !!(json.exceededTransferLimit || (json.properties && json.properties.exceededTransferLimit));
    }
    return { parcels: compact(features), capped: more };
  }

  function boxKey(b) { return [b.west, b.south, b.east, b.north].map(v => Number(v).toFixed(6)).join(','); }

  function overlaps(b, lim) {
    return b.east > lim.west && b.west < lim.east && b.north > lim.south && b.south < lim.north;
  }

  function parcelsFor(box) {
    const key = boxKey(box);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); cache.set(key, hit);
      return hit;
    }
    const p = fetchBox(box).then(r => ({ ...r, failed: null }))
      .catch(err => ({ parcels: [], capped: false, failed: (err && err.message) || 'unreachable' }));
    cache.set(key, p);
    p.then(r => { if (r.failed && cache.get(key) === p) cache.delete(key); });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return p;
  }

  // ── what came back ─────────────────────────────────────────────────────────
  // GeoJSON features to what is kept: the attributes, and each ring as a flat
  // [lon, lat, lon, lat, …] — the doubles exactly as the service printed them,
  // since the joins below match corners by their text.
  function compact(features) {
    const out = [];
    for (const f of features || []) {
      const g = f && f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      const parts = [];
      for (const poly of polys || []) {
        const rings = [];
        for (const ring of poly || []) {
          const a = [];
          for (const c of ring || []) if (c && isFinite(c[0]) && isFinite(c[1])) a.push(+c[0], +c[1]);
          if (a.length >= 8) rings.push(Float64Array.from(a));
        }
        if (rings.length) parts.push(rings);
      }
      if (!parts.length) continue;
      const p = f.properties || {};
      const str = v => (v == null ? '' : String(v).trim());
      out.push({
        parts,
        lot: str(p.lot).replace(/^0+(?=\d)/, ''), plan: str(p.plan),
        typ: str(p.parcel_typ), cover: str(p.cover_typ), tenure: str(p.tenure),
        area: isFinite(p.lot_area) ? Number(p.lot_area) : 0,
        name: str(p.feat_name), locality: str(p.locality), shire: str(p.shire_name), acc: str(p.acc_code),
      });
    }
    return out;
  }

  // What each parcel is, for drawing and for words:
  //   'lot'       a lot — its number is written in it
  //   'road'      road reserve — a road parcel, or a junction joined to one
  //   'water'     a watercourse parcel — its name is written in it
  //   'easement'  a right over other land — dashed, named only when clicked
  //   'other'     a parcel with a boundary and nothing to call it
  function classify(list) {
    const out = [];
    const seen = new Set();
    for (const p of list) {
      let kind = 'other';
      if (p.cover === 'Easement') kind = 'easement';
      else if (p.typ === ROAD_TYPE) kind = 'road';
      else if (p.typ === NODE_TYPE) kind = 'node';
      else if (p.typ === WATER_TYPE) kind = 'water';
      else if (p.typ === LOT_TYPE && p.lot && p.plan) kind = 'lot';
      // The same lot recorded twice — '0BUP755' and '00000BUP755' over the
      // one outline, which the scheme land of a building units plan often
      // is — is drawn and written once.
      if (kind === 'lot' || kind === 'easement') {
        const sig = `${kind}|${p.lot}|${p.plan}|${signature(p)}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
      }
      out.push({ ...p, kind, node: false, joins: [], name: kind === 'road' && NOT_A_NAME.test(p.name) ? '' : p.name });
    }
    // Junctions: road reserve when they share a corner with a road, a
    // boundary like any other when they share none (map-roads.js's joinNodes).
    const meeting = new Map();
    for (const p of out) {
      if (p.kind !== 'road') continue;
      eachVertex(p, k => {
        let names = meeting.get(k);
        if (!names) meeting.set(k, names = new Set());
        names.add(p.name);
      });
    }
    for (const p of out) {
      if (p.kind !== 'node') continue;
      const names = new Set();
      let joined = false;
      eachVertex(p, k => {
        const at = meeting.get(k);
        if (!at) return;
        joined = true;
        for (const nm of at) if (nm) names.add(nm);
      });
      if (joined) { p.kind = 'road'; p.node = true; p.joins = [...names].sort(); }
      else p.kind = 'other';
    }
    return out;
  }

  // Order-free: the same outline started at another corner is the same outline.
  function signature(p) {
    let n = 0, sx = 0, sy = 0;
    for (const part of p.parts) for (const r of part) {
      const m = r.length / 2 - (r[0] === r[r.length - 2] && r[1] === r[r.length - 1] ? 1 : 0);
      for (let i = 0; i < m; i++) { sx += r[2 * i]; sy += r[2 * i + 1]; n++; }
    }
    return `${n}|${sx.toFixed(7)}|${sy.toFixed(7)}`;
  }

  function eachVertex(p, fn) {
    for (const part of p.parts) for (const r of part) for (let i = 0; i < r.length; i += 2) fn(`${r[i]},${r[i + 1]}`);
  }

  // ── the ground's own triangles ─────────────────────────────────────────────
  // The height of the drawn ground over the station's, at a scene point — not
  // the bilinear height the twin quotes, but the plane of the triangle the
  // point is on: cell (ix, iz) is split along the diagonal from its south-west
  // corner to its north-east, PlaneGeometry's (a, b, d) / (b, c, d), which in
  // the cell's own u east and v south is u + v = 1.
  function reliefAt(g, x, z) {
    const n = Math.round(Math.sqrt(g.elev.length));
    const step = g.size / (n - 1);
    const fx = (x + g.half) / step, fz = (z + g.half) / step;
    const ix = Math.min(n - 2, Math.max(0, Math.floor(fx))), iz = Math.min(n - 2, Math.max(0, Math.floor(fz)));
    const u = fx - ix, v = fz - iz;
    const e = g.elev, h0 = g.h0;
    const at = k => (isFinite(e[k]) ? e[k] : h0);
    const A = at(iz * n + ix), D = at(iz * n + ix + 1), B = at((iz + 1) * n + ix), C = at((iz + 1) * n + ix + 1);
    const h = u + v <= 1 ? A + u * (D - A) + v * (B - A) : C + (1 - u) * (B - C) + (1 - v) * (D - C);
    return h - h0;
  }

  // One segment, clipped to the patch (Liang–Barsky), or null.
  function clip(ax, az, bx, bz, L) {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    const p = [-dx, dx, -dz, dz], q = [ax + L, L - ax, az + L, L - az];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return t1 - t0 > 1e-12 ? [ax + t0 * dx, az + t0 * dz, ax + t1 * dx, az + t1 * dz] : null;
  }

  // A segment cut wherever it crosses a grid line (x or z) or a cell's
  // diagonal (x + z), so each piece is inside one triangle; pushed as pairs of
  // points (xz) with the relief at each (rel). Everything it pushes is on the
  // ground exactly.
  function drape(g, ax, az, bx, bz, xz, rel) {
    const n = Math.round(Math.sqrt(g.elev.length));
    const step = g.size / (n - 1), half = g.half;
    const ts = [0, 1];
    const cross = (a, b, off) => {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (hi - lo < 1e-12) return;
      for (let k = Math.floor((lo - off) / step) + 1; off + k * step < hi; k++) ts.push((off + k * step - a) / (b - a));
    };
    cross(ax, bx, -half);
    cross(az, bz, -half);
    cross(ax + az, bx + bz, -2 * half);
    ts.sort((p, q) => p - q);
    let px = null, pz = null, pr = null, last = -1;
    for (const t of ts) {
      if (t - last < 1e-9) continue;
      last = t;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, r = reliefAt(g, x, z);
      if (px !== null) { xz.push(px, pz, x, z); rel.push(pr, r); }
      px = x; pz = z; pr = r;
    }
  }

  // ── the lines ──────────────────────────────────────────────────────────────
  // Every ring's edges, each drawn once and by the class it belongs to — the
  // header's rules for the road reserve's outline. Keyed by the corners' text,
  // so a boundary two parcels share is one edge.
  function edgesOf(parcels) {
    const road = new Map(), lot = new Map(), ease = new Map();
    for (const p of parcels) {
      const into = p.kind === 'road' ? road : p.kind === 'easement' ? ease : lot;
      for (const part of p.xz) {
        for (const r of part.rings) {
          for (let i = 2; i < r.length; i += 2) {
            const ka = `${r.ll[i - 2]},${r.ll[i - 1]}`, kb = `${r.ll[i]},${r.ll[i + 1]}`;
            if (ka === kb) continue;
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const had = into.get(key);
            if (had) { had.n++; continue; }
            into.set(key, { ax: r[i - 2], az: r[i - 1], bx: r[i], bz: r[i + 1], n: 1 });
          }
        }
      }
    }
    const pick = (m, keep) => { const out = []; for (const [k, s] of m) if (keep(k, s)) out.push(s); return out; };
    return {
      roads:         pick(road, (k, s) => s.n === 1),
      lots:          pick(lot, k => !road.has(k)),
      lotsAlongRoad: pick(lot, k => road.has(k)),
      easements:     pick(ease, k => !road.has(k) && !lot.has(k)),
    };
  }

  function lineGeometry(THREE, g, segs, exag) {
    const xz = [], rel = [];
    for (const s of segs) {
      const c = clip(s.ax, s.az, s.bx, s.bz, g.half);
      if (c) drape(g, c[0], c[1], c[2], c[3], xz, rel);
    }
    const pos = new Float32Array(rel.length * 3);
    for (let i = 0; i < rel.length; i++) { pos[3 * i] = xz[2 * i]; pos[3 * i + 1] = rel[i] * exag; pos[3 * i + 2] = xz[2 * i + 1]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.userData.rel = Float32Array.from(rel);
    sphere(THREE, geo);
    return geo;
  }

  // A line set with nothing in it (a patch with no easements) is given an
  // empty sphere rather than one computed from no points, which three reports
  // as a radius of NaN.
  function sphere(THREE, geo) {
    if (geo.attributes.position.count) geo.computeBoundingSphere();
    else geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), -1);
  }

  // The pull toward the eye and the casing's nudge, spliced in after three's
  // own projection so everything else about the material — fog included — is
  // three's. One program for every material of a kind; the nudge is each
  // material's own.
  const PROJECT = `#include <project_vertex>
    {
      vec3 twcUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      float twcSin = abs(dot(normalize(mvPosition.xyz), twcUp));
      mvPosition.xyz *= 1.0 - min(0.08, twcPull / max(twcSin, 0.02));
      gl_Position = projectionMatrix * mvPosition;
      gl_Position.xy += twcNudge * twcPx * gl_Position.w;
    }`;
  function pulled(THREE, mat, nx = 0, ny = 0) {
    const nudge = { value: new THREE.Vector2(nx, ny) };
    mat.onBeforeCompile = sh => {
      sh.uniforms.twcPull = U.pull;
      sh.uniforms.twcPx = U.px;
      sh.uniforms.twcNudge = nudge;
      sh.vertexShader = 'uniform float twcPull;\nuniform vec2 twcPx;\nuniform vec2 twcNudge;\n'
                      + sh.vertexShader.replace('#include <project_vertex>', PROJECT);
    };
    mat.customProgramCacheKey = () => 'mn-twin-cadastre-1';
    return mat;
  }

  // A line set as the header draws it: the casing four times, a pixel off each
  // way, then the line itself — twice, half a pixel apart, so it holds its
  // weight on a screen with two device pixels to the CSS pixel.
  function casedLines(THREE, geo, colour, order, name) {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [nx, ny] of [[NUDGE_PX, 0], [-NUDGE_PX, 0], [0, NUDGE_PX], [0, -NUDGE_PX]]) {
      const m = pulled(THREE, new THREE.LineBasicMaterial({ color: CASING, transparent: true, opacity: CASING_A, depthWrite: false }), nx, ny);
      const o = new THREE.LineSegments(geo, m);
      o.renderOrder = order;
      o.name = `${name} casing`;
      grp.add(o);
    }
    for (const [nx, ny] of [[0, 0], [0.5, 0.5]]) {
      const m = pulled(THREE, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.95, depthWrite: false }), nx, ny);
      const o = new THREE.LineSegments(geo, m);
      o.renderOrder = order + 0.05;
      o.name = name;
      grp.add(o);
    }
    return grp;
  }

  function dashedLines(THREE, geo, order, name) {
    const o = new THREE.LineSegments(geo, pulled(THREE, new THREE.LineDashedMaterial({
      color: EASE_COLOUR, dashSize: 1.2, gapSize: 1.0, transparent: true, opacity: 0.85, depthWrite: false })));
    o.computeLineDistances();
    o.renderOrder = order;
    o.name = name;
    return o;
  }

  // The reserve's wash: its parcels painted on a canvas the size of the patch,
  // laid on the ground's own mesh.
  function washMesh(THREE, g, terrain, roads) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = WASH_PX;
    const cx = cv.getContext('2d');
    const k = WASH_PX / g.size;
    const hex = roadColour().replace('#', '');
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);
    cx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${WASH_A})`;
    for (const p of roads) {
      for (const part of p.xz) {
        cx.beginPath();
        for (const r of part.rings) {
          for (let i = 0; i < r.length; i += 2) {
            const X = (r[i] + g.half) * k, Y = (r[i + 1] + g.half) * k;
            if (i) cx.lineTo(X, Y); else cx.moveTo(X, Y);
          }
          cx.closePath();
        }
        cx.fill('evenodd');
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = pulled(THREE, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const mesh = new THREE.Mesh(terrain.geometry, mat);
    mesh.name = 'road reserve wash';
    mesh.renderOrder = 1;
    mesh.userData.export = false;
    mesh.userData.sharedGeometry = true;
    return mesh;
  }

  // ── where a label goes ─────────────────────────────────────────────────────
  // A ring clipped to the patch (Sutherland–Hodgman), flat [x, z, …].
  function clipRing(r, L) {
    let pts = [];
    for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
    const edges = [[0, -1, L], [0, 1, L], [1, -1, L], [1, 1, L]];   // axis, sign, limit: sign·p[axis] ≤ L
    for (const [ax, sg, lim] of edges) {
      if (!pts.length) break;
      const out = [];
      const inside = p => sg * p[ax] <= lim;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) {
          const t = (sg * lim - a[ax]) / (b[ax] - a[ax]);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      pts = out;
    }
    const flat = [];
    for (const p of pts) flat.push(p[0], p[1]);
    return flat;
  }

  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] + r[i]) * (r[j + 1] - r[i + 1]);
    return Math.abs(a) / 2;
  }

  function segDist2(px, pz, ax, az, bx, bz) {
    let dx = bx - ax, dz = bz - az;
    if (dx || dz) {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
      ax += dx * t; az += dz * t;
    }
    dx = px - ax; dz = pz - az;
    return dx * dx + dz * dz;
  }

  // Signed distance from a point to a polygon's edges: + inside, − outside.
  function signedDist(x, z, rings) {
    let inside = false, min = Infinity;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const ax = r[i], az = r[i + 1], bx = r[j], bz = r[j + 1];
        if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
        const d = segDist2(x, z, ax, az, bx, bz);
        if (d < min) min = d;
      }
    }
    return (inside ? 1 : -1) * Math.sqrt(min);
  }

  // The pole of inaccessibility — Mapbox's polylabel: cells over the polygon,
  // each split while it could still hold a point further inside than the best
  // found. Returns the point and its distance to the nearest edge.
  function polylabel(rings, precision) {
    const outer = rings[0];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]);
      minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]);
    }
    const w = maxX - minX, h = maxZ - minZ, size = Math.min(w, h);
    if (!(size > 0)) return { x: minX, z: minZ, d: 0 };
    const heap = [];
    const push = c => {
      heap.push(c);
      for (let i = heap.length - 1; i > 0;) {
        const up = (i - 1) >> 1;
        if (heap[up].max >= heap[i].max) break;
        [heap[up], heap[i]] = [heap[i], heap[up]]; i = up;
      }
    };
    const pop = () => {
      const top = heap[0], end = heap.pop();
      if (heap.length) {
        heap[0] = end;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l].max > heap[m].max) m = l;
          if (r < heap.length && heap[r].max > heap[m].max) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    const cell = (x, z, hh) => { const d = signedDist(x, z, rings); return { x, z, h: hh, d, max: d + hh * Math.SQRT2 }; };
    // The centroid and the box's middle start the race.
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
      const f = outer[i] * outer[j + 1] - outer[j] * outer[i + 1];
      cx += (outer[i] + outer[j]) * f; cz += (outer[i + 1] + outer[j + 1]) * f; a += f * 3;
    }
    let best = a ? cell(cx / a, cz / a, 0) : cell(outer[0], outer[1], 0);
    const mid = cell(minX + w / 2, minZ + h / 2, 0);
    if (mid.d > best.d) best = mid;
    const half = size / 2;
    for (let x = minX; x < maxX; x += size) for (let z = minZ; z < maxZ; z += size) push(cell(x + half, z + half, half));
    for (let guard = 0; heap.length && guard < 5000; guard++) {
      const c = pop();
      if (c.d > best.d) best = c;
      if (c.max - best.d <= precision) continue;
      const hh = c.h / 2;
      push(cell(c.x - hh, c.z - hh, hh)); push(cell(c.x + hh, c.z - hh, hh));
      push(cell(c.x - hh, c.z + hh, hh)); push(cell(c.x + hh, c.z + hh, hh));
    }
    return { x: best.x, z: best.z, d: Math.max(0, best.d) };
  }

  // A parcel's label, from the largest of its parts inside the patch.
  function labelFor(p, g) {
    let title = '', sub = '';
    if (p.kind === 'lot') { title = `Lot ${p.lot}`; sub = p.plan; }
    else if ((p.kind === 'road' && !p.node) || p.kind === 'water') title = p.name;
    if (!title) return null;
    let best = null;
    for (const part of p.xz) {
      const rings = part.rings.map(r => clipRing(r, g.half)).filter(r => r.length >= 6);
      if (!rings.length || rings[0].length < 6) continue;
      const area = ringArea(rings[0]);
      if (!best || area > best.area) best = { rings, area };
    }
    if (!best) return null;
    const o = best.rings[0];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < o.length; i += 2) {
      minX = Math.min(minX, o[i]); maxX = Math.max(maxX, o[i]); minZ = Math.min(minZ, o[i + 1]); maxZ = Math.max(maxZ, o[i + 1]);
    }
    const pl = polylabel(best.rings, Math.max(0.2, Math.min(maxX - minX, maxZ - minZ) / 40));
    if (!(pl.d > 0)) return null;
    return {
      kind: p.kind, title, sub, x: pl.x, z: pl.z, rel: reliefAt(g, pl.x, pl.z),
      room: pl.d, reach: Math.hypot(maxX - minX, maxZ - minZ) / 2, own: false, parcel: p, w: 0, h: 0,
    };
  }

  // ── what a point is in ─────────────────────────────────────────────────────
  function inPart(part, x, z) {
    let hits = 0;
    for (const r of part.rings) {
      let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const az = r[i + 1], bz = r[j + 1];
        if ((az > z) !== (bz > z) && x < (r[j] - r[i]) * (z - az) / (bz - az) + r[i]) inside = !inside;
      }
      if (inside) hits++;
    }
    return hits % 2 === 1;
  }

  function parcelsAt(x, z) {
    const out = [];
    for (const p of (cad.parcels || [])) {
      const b = p.box;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (p.xz.some(part => inPart(part, x, z))) out.push(p);
    }
    return out;
  }

  // The DCDB's own statement of how well a boundary is plotted, in metres —
  // the figure at the end of its accuracy code ('B&D PLOT CONTROLLED - 0.5M',
  // 'NUMERIC ADJUSTMENT +/- 0.25M', 'PROVISIONAL 1:10000 CADASTRAL MAP - 25M').
  function accuracyM(code) {
    const m = /([\d.]+)\s*M\s*$/i.exec(String(code || ''));
    const v = m ? Number(m[1]) : NaN;
    return isFinite(v) && v > 0 ? v : null;
  }
  // …and how it was plotted, which is the code without that figure.
  function accuracyHow(code) {
    return String(code || '').replace(/\s*[-–]?\s*(\+\/-\s*)?[\d.]+\s*M\s*$/i, '').trim().toLowerCase();
  }

  function areaWords(m2) {
    if (!(m2 > 0)) return '';
    if (m2 < 10000) return `${Math.round(m2).toLocaleString()} m²`;
    const ha = m2 / 10000;
    return `${ha < 100 ? ha.toFixed(ha < 10 ? 2 : 1) : Math.round(ha).toLocaleString()} ha`;
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compass(x, z) { return COMPASS[Math.round(((Math.atan2(x, -z) * 180 / Math.PI + 360) % 360) / 45) % 8]; }

  function parcelWords(p) {
    if (!p) return '';
    if (p.kind === 'road') {
      if (p.node) return p.joins.length ? `the road reserve at the ${p.joins.join(' / ')} intersection` : 'the road reserve at a road intersection';
      return p.name ? `the road reserve of ${p.name}` : 'an unnamed road reserve';
    }
    if (p.kind === 'water') return p.name ? `the watercourse parcel of ${p.name}` : 'a watercourse parcel';
    if (p.kind === 'easement') return p.lot || p.plan ? `Easement ${[p.lot, p.plan].filter(Boolean).join(' on ')}` : 'an easement';
    if (p.kind === 'lot') return `Lot ${p.lot} on ${p.plan}`;
    return 'a parcel the cadastre gives no lot or name';
  }

  function parcelFacts(p) {
    if (!p || p.kind === 'road') return p && p.locality ? p.locality : '';
    return [p.tenure, areaWords(p.area)].filter(Boolean).join(', ');
  }

  function shown(p) { return p.kind === 'road' ? P().roads : P().lots; }

  // Where the station stands, for the line under the stage: the parcel its
  // point is in, the easements over it, and the nearest edge of the road
  // reserve with the way to it.
  function stationFacts(parcels, roadEdges) {
    const at = parcels.filter(p => p.xz.some(part => inPart(part, 0, 0)));
    const main = at.find(p => p.kind === 'road') || at.find(p => p.kind !== 'easement') || null;
    let road = null;
    if (!(main && main.kind === 'road')) {
      for (const s of roadEdges) {
        const dx = s.bx - s.ax, dz = s.bz - s.az, L = dx * dx + dz * dz;
        const t = L > 0 ? Math.max(0, Math.min(1, -(s.ax * dx + s.az * dz) / L)) : 0;
        const x = s.ax + dx * t, z = s.az + dz * t, d = Math.hypot(x, z);
        if (!road || d < road.d) road = { d, x, z, s };
      }
      if (road) {
        // Whose reserve that edge is: the road parcel it bounds.
        const mx = (road.s.ax + road.s.bx) / 2, mz = (road.s.az + road.s.bz) / 2;
        let owner = null, ownerD = Infinity;
        for (const p of parcels) {
          if (p.kind !== 'road') continue;
          for (const part of p.xz) {
            const d = Math.abs(signedDist(mx, mz, part.rings));
            if (d < ownerD) { ownerD = d; owner = p; }
          }
        }
        road = { d: road.d, bearing: compass(road.x, road.z), p: owner };
      }
    }
    const accs = main ? [accuracyM(main.acc)] : parcels.filter(p => p.kind === 'lot').map(p => accuracyM(p.acc));
    const known = accs.filter(v => v != null).sort((a, b) => a - b);
    const acc = known.length ? known[Math.floor(known.length / 2)] : null;
    return { main, easements: at.filter(p => p.kind === 'easement'), road, acc, accCode: main ? main.acc : null };
  }

  // ── building it ────────────────────────────────────────────────────────────
  // The patch's parcels in the twin's metres, each ring keeping its lat/lon
  // text (`ll`) for the edge joins, with a box for the point tests.
  function prepare(list, h) {
    const out = [];
    for (const p of classify(list)) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      const xz = p.parts.map(rings => ({
        rings: rings.map(ll => {
          const r = new Float64Array(ll.length);
          for (let i = 0; i < ll.length; i += 2) {
            const q = h.toXZ(ll[i + 1], ll[i]);
            r[i] = q.x; r[i + 1] = q.z;
            if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
            if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
          }
          r.ll = ll;
          return r;
        }),
      }));
      out.push({ ...p, xz, box: { x0, z0, x1, z1 } });
    }
    return out;
  }

  function build(r) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const h = host, THREE = h.THREE, g = h.ground;
    const parcels = prepare(r.parcels, h);
    const edges = edgesOf(parcels);
    const exag = h.exag();
    const grp = new THREE.Group();
    grp.name = 'cadastre';
    const geos = {
      lots: lineGeometry(THREE, g, edges.lots, exag),
      lotsAlongRoad: lineGeometry(THREE, g, edges.lotsAlongRoad, exag),
      roads: lineGeometry(THREE, g, edges.roads, exag),
      easements: lineGeometry(THREE, g, edges.easements, exag),
    };
    const parts = {
      easements: dashedLines(THREE, geos.easements, 1.1, 'easement lines'),
      lots: casedLines(THREE, geos.lots, LOT_COLOUR, 1.2, 'lot boundaries'),
      lotsAlongRoad: casedLines(THREE, geos.lotsAlongRoad, LOT_COLOUR, 1.2, 'lot boundaries along the road'),
      roads: casedLines(THREE, geos.roads, new THREE.Color(roadColour()).getHex(), 1.4, 'road reserve outline'),
      wash: h.terrain ? washMesh(THREE, g, h.terrain, parcels.filter(p => p.kind === 'road')) : null,
    };
    for (const k of Object.keys(parts)) if (parts[k]) grp.add(parts[k]);
    grp.userData.export = false;
    cad.group = grp;
    cad.parts = parts;
    cad.geos = geos;
    cad.parcels = parcels;
    cad.labels = parcels.map(p => labelFor(p, g)).filter(Boolean);
    cad.station = stationFacts(parcels, edges.roads);
    const own = cad.station.main;
    for (const l of cad.labels) l.own = !!own && l.parcel === own;
    cad.counts = {
      parcels: parcels.length,
      lots: parcels.filter(p => p.kind === 'lot').length,
      roads: parcels.filter(p => p.kind === 'road' && !p.node).length,
      junctions: parcels.filter(p => p.kind === 'road' && p.node).length,
      water: parcels.filter(p => p.kind === 'water').length,
      easements: parcels.filter(p => p.kind === 'easement').length,
      other: parcels.filter(p => p.kind === 'other').length,
    };
    h.scene.add(grp);
    show();
    cad.buildMs = typeof performance !== 'undefined' ? performance.now() - t0 : null;
  }

  function show() {
    const p = cad.parts;
    if (!p) return;
    const lots = P().lots, roads = P().roads;
    p.lots.visible = lots;
    p.easements.visible = lots;
    // A lot's frontage is the reserve's edge: yellow while the reserve is
    // drawn, white when it is not.
    p.lotsAlongRoad.visible = lots && !roads;
    p.roads.visible = roads;
    if (p.wash) p.wash.visible = roads;
    lab.key = null;
  }

  function ensureLabelCanvas(h) {
    if (lab.canvas && lab.canvas.parentNode === h.stage) return;
    const cv = document.createElement('canvas');
    cv.className = 'twin-cad-labels';
    cv.setAttribute('aria-hidden', 'true');
    // Right over the scene's own canvas, under everything else on the stage.
    if (h.canvas && h.canvas.parentNode === h.stage) h.canvas.after(cv);
    else h.stage.appendChild(cv);
    lab.canvas = cv;
    lab.ctx = cv.getContext('2d');
    lab.key = null;
  }

  function notesFor(r) {
    const out = [];
    if (r.capped) {
      out.push(`The cadastre holds more than ${MAX_PARCELS.toLocaleString()} parcels in this patch, and the first ${MAX_PARCELS.toLocaleString()} are drawn; a smaller patch draws them all.`);
    }
    const st = cad.station;
    if (st && st.acc != null && st.acc > COARSE_M) {
      const how = accuracyHow(st.accCode);
      out.push(`The cadastre here is plotted to ±${st.acc} m${how ? ` (${how})` : ''}, so its boundaries can lie that far from the fences in the imagery: they say which parcel is where, not where its corners are.`);
    }
    return out;
  }

  function fetchAndDraw() {
    const h = host;
    if (!h) return Promise.resolve();
    const mine = ++seq;
    if (!overlaps(h.box, EXTENT)) {
      cad.status = 'outside';
      h.refresh();
      return Promise.resolve();
    }
    cad.status = 'loading';
    h.refresh();
    return parcelsFor(h.box).then(r => {
      if (mine !== seq || host !== h || !h.current()) return;
      if (r.failed) {
        cad.status = 'fail';
        cad.failed = r.failed;
        h.note([`The Queensland cadastre could not be asked for this patch's parcels (${r.failed}), so no property boundaries or road parcels are drawn. Press Rebuild to ask it again.`]);
        h.refresh();
        return;
      }
      cad.capped = r.capped;
      if (!r.parcels.length) { cad.status = 'empty'; h.refresh(); return; }
      build(r);
      cad.status = 'ok';
      syncUniforms();
      ensureLabelCanvas(h);
      const said = notesFor(r);
      if (said.length) h.note(said);
      h.refresh();
      h.requestFrame();
    });
  }

  function remove() {
    seq++;
    if (cad.group) {
      if (cad.group.parent) cad.group.parent.remove(cad.group);
      const geos = new Set();
      cad.group.traverse(o => {
        if (o.geometry && !o.userData.sharedGeometry) geos.add(o.geometry);
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      for (const g of geos) g.dispose();
    }
    if (lab.canvas && lab.canvas.parentNode) lab.canvas.parentNode.removeChild(lab.canvas);
    lab.canvas = null; lab.ctx = null; lab.key = null; lab.placed = [];
    host = null;
    Object.assign(cad, { status: 'off', failed: null, capped: false, parcels: null, station: null,
                         group: null, parts: null, geos: null, labels: [], counts: null, buildMs: null });
  }

  function relift() {
    if (!host || !cad.geos) return;
    const exag = host.exag();
    for (const geo of Object.values(cad.geos)) {
      const rel = geo.userData.rel, pos = geo.attributes.position;
      for (let i = 0; i < rel.length; i++) pos.setY(i, rel[i] * exag);
      pos.needsUpdate = true;
      sphere(host.THREE, geo);
    }
    // The dashes are measured along the line, and the line is longer now.
    if (cad.parts && cad.parts.easements) cad.parts.easements.computeLineDistances();
    lab.key = null;
    host.requestFrame();
  }

  // ── the labels, each frame the view changed ────────────────────────────────
  function measure(cx, l) {
    if (l.w) return;
    if (l.kind === 'lot') {
      cx.font = FONT_LOT; const a = cx.measureText(l.title).width;
      cx.font = FONT_PLAN; const b = cx.measureText(l.sub).width;
      l.w = Math.max(a, b) + 6; l.h = 28;
    } else {
      cx.font = FONT_NAME; l.w = cx.measureText(l.title).width + 6; l.h = 16;
    }
  }

  function viewKey(cam, W, H, dpr) {
    const e = cam.matrixWorld.elements, p = cam.projectionMatrix.elements;
    let s = `${W}x${H}@${dpr}|${host.exag()}|${P().lots}${P().roads}|`;
    for (let i = 0; i < 16; i++) s += `${e[i].toFixed(5)},`;
    return s + p[0].toFixed(6) + ',' + p[5].toFixed(6);
  }

  // The signs the scene stands up, as screen boxes: the station's name, a
  // neighbour's, a radio path's, a photo's badge. They are drawn over the
  // scene; a label under one would be written through it.
  function signBoxes(THREE, cam, W, H, focal) {
    const out = [], p = new THREE.Vector3(), s = new THREE.Vector3(), v = new THREE.Vector3();
    host.scene.traverseVisible(o => {
      if (!o.isSprite) return;
      o.getWorldPosition(p); o.getWorldScale(s);
      const dist = p.distanceTo(cam.position);
      if (!(dist > cam.near)) return;
      v.copy(p).project(cam);
      if (v.z > 1) return;
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      const hw = Math.abs(s.x) * focal / dist / 2, hh = Math.abs(s.y) * focal / dist / 2;
      out.push({ x0: sx - hw, x1: sx + hw, y0: sy - hh, y1: sy + hh });
    });
    return out;
  }

  // The stage's own controls as screen boxes — the compass, the flood's scale,
  // the pill, the line of help along the foot, a panel on the stage: a label
  // under one would be written under a control, and half read. Everything on
  // the stage but the two canvases, as it is laid out now.
  function furnitureBoxes() {
    const out = [], st = host.stage, base = st.getBoundingClientRect();
    const ox = base.left + st.clientLeft, oy = base.top + st.clientTop;
    for (const el of st.children) {
      if (el === host.canvas || el === lab.canvas || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      out.push({ x0: r.left - ox, x1: r.right - ox, y0: r.top - oy, y1: r.bottom - oy });
    }
    return out;
  }

  // Whether the ground between the eye and a label's point hides it.
  function occluded(cp, x, y, z, stepM) {
    const dx = x - cp.x, dy = y - cp.y, dz = z - cp.z;
    const d = Math.hypot(dx, dy, dz);
    const n = Math.min(48, Math.max(6, Math.ceil(d / stepM)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t > 0.97) break;
      if (host.surfaceY(cp.x + dx * t, cp.z + dz * t) > cp.y + dy * t + 0.25) return true;
    }
    return false;
  }

  function write(cx, font, s, x, y, fill) {
    cx.font = font;
    cx.lineWidth = 3.2;
    cx.strokeStyle = HALO;
    cx.strokeText(s, x, y);
    cx.fillStyle = fill;
    cx.fillText(s, x, y);
  }

  function drawLabels() {
    const h = host;
    if (!h || !lab.canvas || !h.camera || !h.stage) return;
    const THREE = h.THREE, cam = h.camera, cv = lab.canvas;
    const W = Math.max(1, h.stage.clientWidth), H = Math.max(1, h.stage.clientHeight);
    const dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio || 1, 2);
    cam.updateMatrixWorld();
    const key = viewKey(cam, W, H, dpr);
    if (key === lab.key) return;
    lab.key = key;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const cx = lab.ctx;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    lab.placed = [];
    const list = cad.labels.filter(l => shown(l.parcel));
    if (!list.length) return;
    const cp = cam.position;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const focal = H / (2 * Math.tan(cam.fov * Math.PI / 360));
    const exag = h.exag();
    const v = new THREE.Vector3();
    const cands = [];
    for (const l of list) {
      const y = l.rel * exag + LIFT;
      const dx = l.x - cp.x, dy = y - cp.y, dz = l.z - cp.z;
      if (dx * fwd.x + dy * fwd.y + dz * fwd.z < cam.near * 4) continue;
      const dist = Math.hypot(dx, dy, dz);
      v.set(l.x, y, l.z).project(cam);
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      if (sx < -80 || sx > W + 80 || sy < -30 || sy > H + 30) continue;
      measure(cx, l);
      const k = focal / dist;
      // Seen from above a lot is its full depth; seen along the ground, a
      // sliver of it — which is what keeps the POV's horizon from filling
      // with the names of streets a hundred metres off.
      const steep = Math.min(1, Math.max(0.02, Math.abs(dy) / dist));
      const fits = l.own
        || (l.kind === 'lot'
          ? 2 * l.room * k >= 0.8 * l.w && 2 * l.room * k * steep >= 0.8 * l.h
          : l.reach * k >= 0.6 * l.w && 2 * l.room * k * steep >= 6);
      if (fits) cands.push({ l, sx, sy, dist, y });
    }
    cands.sort((a, b) => (b.l.own - a.l.own) || (a.dist - b.dist));
    const boxes = [...signBoxes(THREE, cam, W, H, focal), ...furnitureBoxes()];
    const stepM = Math.max(1, (h.ground.sample_m || 2) * 2);
    const names = [];
    const rectAt = (l, x, y) => ({ x0: x - l.w / 2 - LABEL_PAD, x1: x + l.w / 2 + LABEL_PAD, y0: y - l.h / 2 - LABEL_PAD, y1: y + l.h / 2 + LABEL_PAD });
    const taken = r => boxes.some(b => r.x0 < b.x1 && r.x1 > b.x0 && r.y0 < b.y1 && r.y1 > b.y0);
    for (const c of cands) {
      if (lab.placed.length >= LABEL_MAX) break;
      const l = c.l;
      let r = rectAt(l, c.sx, c.sy);
      if (taken(r)) {
        // The station's own lot is written whatever: stepped clear of the
        // sign over the station, which is usually what stands on its point.
        if (!l.own) continue;
        const step = l.h + 2 * LABEL_PAD + 4;
        const dy = [step, -step, 2 * step, -2 * step].find(d => !taken(rectAt(l, c.sx, c.sy + d)));
        if (dy === undefined) continue;
        c.sy += dy;
        r = rectAt(l, c.sx, c.sy);
      }
      // A street is several parcels, each with the street's name: once in a
      // stretch of screen is enough.
      if (l.kind !== 'lot' && names.some(n => n.t === l.title && Math.hypot(n.x - c.sx, n.y - c.sy) < 240)) continue;
      if (occluded(cp, l.x, c.y, l.z, stepM)) continue;
      boxes.push(r);
      if (l.kind !== 'lot') names.push({ t: l.title, x: c.sx, y: c.sy });
      lab.placed.push(c);
    }
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.lineJoin = 'round';
    for (const c of lab.placed) {
      const l = c.l;
      if (l.kind === 'lot') {
        write(cx, FONT_LOT, l.title, c.sx, c.sy - 6.5, TEXT_LOT);
        write(cx, FONT_PLAN, l.sub, c.sx, c.sy + 7, TEXT_PLAN);
      } else {
        write(cx, FONT_NAME, l.title, c.sx, c.sy, l.kind === 'road' ? TEXT_ROAD : TEXT_WATER);
      }
    }
  }

  // The two uniforms that depend on the stage: a CSS pixel in clip space, and
  // PULL_PX pixels' worth of the angle a pixel subtends. Set when the lines are
  // built and after every frame; a frame drawn with stale ones (the stage was
  // resized) asks for another, which is drawn with these.
  function syncUniforms() {
    const h = host;
    if (!U || !h || !h.stage) return false;
    const W = Math.max(1, h.stage.clientWidth), H = Math.max(1, h.stage.clientHeight);
    const px = [2 / W, 2 / H];
    const pull = PULL_PX * 2 * Math.tan((h.camera ? h.camera.fov : 50) * Math.PI / 360) / H;
    const moved = Math.abs(U.px.value.x - px[0]) > 1e-9 || Math.abs(U.px.value.y - px[1]) > 1e-9 || Math.abs(U.pull.value - pull) > 1e-9;
    U.px.value.set(px[0], px[1]);
    U.pull.value = pull;
    return moved;
  }

  function frame() {
    if (!host || !cad.group) return;
    if (syncUniforms()) host.requestFrame();
    drawLabels();
  }

  // A switch changed: drawn from what is in hand, or asked for now if nothing
  // was asked for while both were off.
  function apply() {
    if (!host) return;
    if ((P().lots || P().roads) && cad.status === 'off') { fetchAndDraw(); return; }
    show();
    host.refresh();
    host.requestFrame();
  }

  // ── public surface ─────────────────────────────────────────────────────────
  return {
    // The Scene panel's two switches.
    panelHtml() {
      const s = P();
      return `
        <label class="check-label"><input type="checkbox" id="twin-cad-lots" ${s.lots ? 'checked' : ''} onchange="TwinCadastre.setLots(this.checked)"><span>Property boundaries and lot numbers (Queensland cadastre)</span></label>
        <label class="check-label"><input type="checkbox" id="twin-cad-roads" ${s.roads ? 'checked' : ''} onchange="TwinCadastre.setRoads(this.checked)"><span>Road parcels: the road reserve, outlined and named (Queensland cadastre)</span></label>`;
    },
    setLots(on) { P().lots = !!on; savePrefs(); apply(); },
    setRoads(on) { P().roads = !!on; savePrefs(); apply(); },

    // The twin's build, once its ground is standing.
    load(h) {
      remove();
      if (!h || !h.THREE || !h.scene || !h.ground || !h.box) return Promise.resolve();
      host = h;
      if (!U) U = { pull: { value: 0.003 }, px: { value: new h.THREE.Vector2(0.002, 0.002) } };
      if (!P().lots && !P().roads) return Promise.resolve();
      return fetchAndDraw();
    },
    remove,
    relift,
    frame,

    // A click on the ground: which parcel it is in — of what is drawn.
    pickWords(x, z) {
      if (cad.status !== 'ok') return '';
      const at = parcelsAt(x, z).filter(shown);
      const main = at.find(p => p.kind === 'road') || at.find(p => p.kind !== 'easement');
      const ease = at.filter(p => p.kind === 'easement');
      if (!main && !ease.length) return '';
      const facts = parcelFacts(main);
      let s = main ? ` In ${parcelWords(main)}${facts ? ` (${facts})` : ''}` : '';
      if (ease.length) s += `${main ? ', inside' : ' Inside'} ${ease.map(parcelWords).join(' and ')}`;
      return `${s}.`;
    },

    // The station's ground, for the line under the stage.
    lineHtml() {
      if (!host || (!P().lots && !P().roads)) return '';
      const lead = words => `<span class="twin-site-lead"><span aria-hidden="true">🏠</span> ${words}</span>`;
      if (cad.status === 'loading') return lead('Reading the cadastre…');
      if (cad.status === 'outside' || cad.status === 'empty') return lead('No Queensland cadastre in this patch');
      if (cad.status !== 'ok' || !cad.station) return '';
      const st = cad.station, bits = [];
      const main = st.main && shown(st.main) ? st.main : null;
      if (main) {
        const facts = parcelFacts(main);
        bits.push(`${lead('The station stands in')} ${esc(parcelWords(main))}${facts ? ` (${esc(facts)})` : ''}`);
      } else if (!st.main && P().lots) {
        bits.push(lead('No parcel in the cadastre holds the station\'s point'));
      }
      const ease = st.easements.filter(shown);
      if (ease.length) bits.push(`inside ${esc(ease.map(parcelWords).join(' and '))}`);
      if (P().roads && st.road && !(main && main.kind === 'road')) {
        const d = st.road.d, who = st.road.p ? parcelWords(st.road.p) : 'the road reserve';
        const far = `${d < 10 ? d.toFixed(1) : Math.round(d)} m ${st.road.bearing}`;
        bits.push(bits.length ? `${esc(who)} ${far}` : `${lead(esc(who.charAt(0).toUpperCase() + who.slice(1)))} is ${far}`);
      }
      if (st.acc != null && bits.length) bits.push(`boundaries plotted to ±${st.acc} m`);
      return bits.join(' · ');
    },

    attribution() { return cad.status === 'ok' && (P().lots || P().roads) ? ATTRIBUTION : ''; },

    // Read by the check.
    debug() {
      const vis = o => !!o && o.visible;
      const verts = k => (cad.geos && cad.geos[k] ? cad.geos[k].attributes.position.count : 0);
      return {
        prefs: { ...P() }, status: cad.status, failed: cad.failed, capped: cad.capped, buildMs: cad.buildMs,
        counts: cad.counts ? { ...cad.counts } : null,
        lines: cad.parts ? {
          lots: { vertices: verts('lots'), visible: vis(cad.parts.lots) },
          lotsAlongRoad: { vertices: verts('lotsAlongRoad'), visible: vis(cad.parts.lotsAlongRoad) },
          roads: { vertices: verts('roads'), visible: vis(cad.parts.roads) },
          easements: { vertices: verts('easements'), visible: vis(cad.parts.easements) },
          wash: { visible: vis(cad.parts.wash), exported: !!cad.parts.wash && cad.parts.wash.userData.export !== false,
                  sharesGround: !!cad.parts.wash && !!host && !!host.terrain && cad.parts.wash.geometry === host.terrain.geometry },
        } : null,
        labels: {
          total: cad.labels.length,
          lots: cad.labels.filter(l => l.kind === 'lot').map(l => ({ title: l.title, sub: l.sub, x: l.x, z: l.z, room: l.room, own: l.own })),
          names: cad.labels.filter(l => l.kind !== 'lot').map(l => ({ kind: l.kind, title: l.title, x: l.x, z: l.z })),
          placed: lab.placed.map(c => ({ kind: c.l.kind, title: c.l.title, sub: c.l.sub, own: c.l.own, sx: c.sx, sy: c.sy, w: c.l.w, h: c.l.h })),
          canvas: !!lab.canvas && !!lab.canvas.parentNode,
        },
        station: cad.station ? {
          main: cad.station.main ? parcelWords(cad.station.main) : null,
          kind: cad.station.main ? cad.station.main.kind : null,
          easements: cad.station.easements.map(parcelWords),
          road: cad.station.road ? { d: cad.station.road.d, bearing: cad.station.road.bearing,
                                     name: cad.station.road.p ? parcelWords(cad.station.road.p) : null } : null,
          acc: cad.station.acc,
        } : null,
        uniforms: U ? { pull: U.pull.value, px: [U.px.value.x, U.px.value.y] } : null,
      };
    },
    // The check's seams: a line set's own vertices (x, y, z) and the ground's
    // height under them by the triangle they are on, and the pure arithmetic.
    _vertices(k, every = 1) {
      const geo = cad.geos && cad.geos[k];
      if (!geo || !host) return [];
      const pos = geo.attributes.position, exag = host.exag(), out = [];
      for (let i = 0; i < pos.count; i += every) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        out.push({ x, y, z, ground: reliefAt(host.ground, x, z) * exag });
      }
      return out;
    },
    _reliefAt(x, z) { return host ? reliefAt(host.ground, x, z) : null; },
    // Where three itself puts the ground at a point: a ray straight down onto
    // the ground's own mesh — so the check holds the lines against the mesh
    // that is drawn, not against this file's idea of it.
    _meshY(x, z) {
      if (!host || !host.terrain) return null;
      const THREE = host.THREE;
      const rc = new THREE.Raycaster(new THREE.Vector3(x, 1e5, z), new THREE.Vector3(0, -1, 0));
      const hit = rc.intersectObject(host.terrain, false)[0];
      return hit ? hit.point.y : null;
    },
    // Screen boxes of the signs the scene stands up and of the stage's own
    // controls, as the labels see them.
    _signBoxes() {
      if (!host || !host.camera || !host.stage) return [];
      const H = Math.max(1, host.stage.clientHeight);
      return signBoxes(host.THREE, host.camera, Math.max(1, host.stage.clientWidth), H,
                       H / (2 * Math.tan(host.camera.fov * Math.PI / 360)));
    },
    _furnitureBoxes() { return host && host.stage ? furnitureBoxes() : []; },
    _pure: { reliefAt, clip, drape, polylabel, signedDist, clipRing, accuracyM, accuracyHow, areaWords, compact, classify, edgesOf, compass },
    _clearCache() { cache.clear(); layerId = null; resolving = null; },
  };
})();
if (typeof window !== 'undefined') window.TwinCadastre = TwinCadastre;
