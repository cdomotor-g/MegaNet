// MegaNet — map-paths.js
//
//   MapPaths   which of the field stations' radio paths the Stations map
//              draws — every one, each station's best, the best until the
//              map is zoomed in, every one bundled into trunks, or none at
//              all with each repeater's stations shaded as its area — and the
//              two overlays that go with those choices: the areas with their
//              pins' halos, and the trunks with the "other paths" of the
//              station somebody is pointing at.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js (initMap attaches it and stopStationsMap detaches it;
// refreshMapLayers hands the pass-range links to thin(), the kept ones to
// prepare(), and draws each field line along curve(); the legend and the link
// note ask legendHtml() and noteText()) and from map-views.js (the choice
// itself lives in its settings, and it calls schedule() when a hover, the
// card, the focus or a restyle changes what is drawn here). Reads
// MapViews.settings(), MapViews.hovered(), MapFade.known(), MapFreq and the
// map's state (state.mapLines, state.mapMarkers, state.stnCard,
// state.mapFocusRepeaterId) live, at call time. Leaflet and MapOverlay are
// reached the same way. All of it from inside functions, and the IIFE body
// only declares, so this file's position among the modules is free
// (npm run toplevel).
//
// ── Why ──────────────────────────────────────────────────────────────────────
// About 1,800 pass-range paths are drawn at the default distance, and most
// field stations have two to four of them. Zoomed out, that is a mat of lines
// with the photo and the pins buried under it — and the question people
// mostly ask of a station is "which repeater carries it", which is one path,
// not four. So the Views section (map-views.js) offers four ways to draw
// fewer lines, and this module is the one place that decides what they mean.
// "Every path" is the map as it always was, and the default: nothing here
// changes a line until somebody picks something else.
//
// ── Best path only ───────────────────────────────────────────────────────────
// One path per field station: the one to the repeater most likely to hear it.
// Ranked the way the best repeater finder ranks a hop (map-bestrep.js): the
// biggest fade margin anybody has worked out for it first (MapFade.known —
// a saved figure while its signature holds, else this session's), and where
// no path of the station has a figure, the shortest. Nothing here works a
// margin out — MapFade.work() fetches terrain, and doing that for three
// thousand paths to save drawing some of them would be absurd — but the saved
// figures are asked for once a session, and the map is drawn again if they
// change a station's pick.
//
// The paths left out are not lost. Pointing at a station, opening its card or
// focusing a repeater draws that station's (or that repeater's) other paths
// dashed on an overlay, so a backup route is one hover away.
//
// "Best path until you zoom in" is the same below LOD_ZOOM and every path from
// there in: zoomed in over one valley there are few enough lines to read, and
// the backups are worth seeing.
//
// ── Bundled into trunks ──────────────────────────────────────────────────────
// Every path is drawn, but the long ones coming into one repeater from the
// same direction bend together and arrive along one shared line, like creeks
// joining a river. Per repeater, paths of BUNDLE_MIN_KM or more are put in
// SECTOR_DEG slices of the compass by their bearing from the repeater; a slice
// with two or more becomes a quadratic curve from each station to the
// repeater, through a control point J shared by the slice: halfway (JOIN)
// from the repeater to the slice's stations' middle. Every curve in the slice
// therefore leaves the repeater along the same tangent, which is the bundle.
// A slice of three or more also gets a trunk — a heavier line over the shared
// last stretch, wider for more paths — drawn on the overlay. Short paths, and
// a slice of one, stay straight: bending them hides nothing and lies about
// where the path runs.
//
// ── Areas, no lines ──────────────────────────────────────────────────────────
// No field lines at all. Each repeater is shaded as the patch of country whose
// field stations it carries best — a circle of AREA_KM round each of those
// stations and round the repeater, unioned — and each of those pins wears a
// ring in the same colour, so "which repeater covers this country" is read
// from the colour alone. Repeaters closer than NEIGHBOUR_KM get different
// colours (greedily, the most crowded first), from the eight --map-area-*
// tokens. A station's paths come back, dashed, when it is pointed at, with
// its best path solid — in this mode no line on the map says which one it is.
//
// ── Where the overlays sit ───────────────────────────────────────────────────
// Both under the link-and-pin canvas (overlay pane, 400), so a pin is never
// painted over: the areas and halos in mnAreas (396), the trunks and other
// paths in mnPathsX (398) — over the areas, under the lines and the pins.
// Each is drawn when the view settles, and when schedule() is called; never
// every frame, nothing here moves. Neither is drawn while the 3-D view or the
// digital twin is up: the 2-D map is not what anybody is looking at then.
//
// Exposes: attach, detach, mode, thin, prepare, curve, schedule, counts,
// areaColour, legendHtml, noteText, WORDS, lodZoom, _state.
const MapPaths = (function () {
  const MODES = ['every', 'best', 'lod', 'bundle', 'areas'];

  // Below this zoom "Best path until you zoom in" draws the best path only;
  // from it in, every path. 11 is about one district on a laptop screen —
  // the zoom MapCluster also stops grouping pins at, and for the same reason:
  // from there in, the map is about the stations one by one.
  const LOD_ZOOM = 11;

  // ── Bundles ──
  const BUNDLE_MIN_KM = 16;  // shorter paths stay straight
  const SECTOR_DEG = 36;     // ten slices of the compass per repeater
  const JOIN = 0.5;          // J = R + JOIN × (the slice's middle − R)
  // A path that ends nearer the repeater than J would hook out past its own
  // station to reach a control point beyond it. Its control keeps the slice's
  // direction — so it still arrives on the shared tangent — but reaches only
  // SHORT_REACH of the way to its own station.
  const SHORT_REACH = 0.8;
  const CURVE_STEPS = 16;    // segments per curve (17 points)
  const TRUNK_MIN = 3;       // paths in a slice before it gets a trunk
  const TRUNK_FROM = 0.5;    // a trunk runs from R + TRUNK_FROM × (J − R) to R
  const TRUNK_ALPHA = 0.92, TRUNK_CASE_ALPHA = 0.6;

  // ── Areas ──
  const AREA_KM = 4.5;       // circle round each station, in km on the ground
  const AREA_MIN_PX = 8;     // …but never smaller than this on the screen
  const AREA_ALPHA = 0.32;   // one repeater's union, filled once
  const AREA_DIM = 0.3;      // another repeater's area while one is focused
  const NEIGHBOUR_KM = 60;   // repeaters nearer than this never share a colour
  const HALO_GAP = 3;        // px past the pin's radius
  const HALO_W = 2.5;        // px
  const HALO_ALPHA = 0.95;
  const AREA_TOKENS = ['--map-area-1', '--map-area-2', '--map-area-3', '--map-area-4',
                       '--map-area-5', '--map-area-6', '--map-area-7', '--map-area-8'];
  // What the map draws if a token is missing (core.js's cssVar note says why
  // a fallback is never decoration) — the mock-up's eight, which the tokens
  // in styles.css start from.
  const AREA_FALLBACK = ['#ff8a3d', '#3fd0c9', '#ffd23f', '#b48cff', '#82d64e', '#ff6fb1', '#4aa8ff', '#f2f2f2'];

  // ── Other paths ──
  const OTHER_DASH = [6, 4];
  const OTHER_W = 1.6;       // px, × the Sunlight theme's stroke scale
  const OTHER_ALPHA = 0.9;
  const OTHER_MAX = 800;     // a busy repeater's whole fan, with room to spare

  const PANE_AREAS = 'mnAreas', Z_AREAS = 396;
  const PANE_X = 'mnPathsX', Z_X = 398;

  // The words the legend and the note use, on hover where they are used and
  // in MapViews' "What the words in Views mean" fold (core.js's rule: hover
  // never reaches a finger).
  const WORDS = {
    'Best path': 'Each field station is drawn with one path only: the one to the repeater most likely to hear it — the '
      + 'biggest fade margin (spare signal, in dB) saved for it, or the shortest path when none of its paths has a figure. '
      + 'Point at a station, open its card or focus a repeater to see the other paths too, dashed.',
    'Best path until you zoom in': `Best path only while the map is zoomed out (below zoom ${LOD_ZOOM}, about a district `
      + 'across a laptop screen); zoomed in past that, every path is drawn again.',
    'Bundled into trunks': `Paths of ${BUNDLE_MIN_KM} km or more that come into one repeater from the same direction `
      + `(within a ${SECTOR_DEG}° slice of the compass) bend together and arrive along one shared line, like creeks `
      + 'joining a river. Shorter paths, and a direction with only one path, stay straight. Every path is still drawn.',
    Trunk: `The heavier line where ${TRUNK_MIN} or more bundled paths share their last stretch into a repeater; the more `
      + 'paths it carries, the wider it is.',
    Areas: 'No field lines: each repeater is shaded over the country its field stations cover — '
      + `${AREA_KM} km round every station whose best path goes to it — and those pins wear a ring in the same colour. `
      + `Repeaters less than ${NEIGHBOUR_KM} km apart get different colours.`,
    'Other paths': 'The paths a station also has that this view does not draw. They are drawn dashed for the station you '
      + 'point at, the station whose card is open and the repeater in focus.',
  };

  const S = {
    map: null,
    areasH: null,          // the mnAreas overlay
    xH: null,              // the mnPathsX overlay
    built: null,           // the resolved mode the last thin() ran under
    kept: 0, dropped: 0,   // its counts
    links: null,           // its input, for the re-rank when saved margins land
    dropBySta: new Map(),  // field station id → its paths not drawn
    dropByRep: new Map(),  // repeater id → the paths into it not drawn
    best: new Map(),       // field station id → its best path (best and areas)
    areas: new Map(),      // repeater id → { r, stations: [s] } (areas)
    colourIdx: new Map(),  // repeater id → index into the palette (areas)
    palette: null,         // the eight resolved colours, dropped every thin()
    ctrl: new Map(),       // 's.id|r.id' → { lat, lng } the curve's control (bundle)
    trunks: [],            // { repeaterId, lat, lng, n, colourOf, r, members }
    fadeAsked: false,      // MapFade.ready() asked once a session, never again
    pinIdx: null, pinSrc: null, pinLen: -1,     // station id → pin, cached
    lineIdx: null, lineSrc: null, lineLen: -1,  // 's.id|r.id' → core line, cached
  };

  // ── What is chosen ─────────────────────────────────────────────────────────

  // The choice as the person made it, 'lod' unresolved. MapViews owns the
  // setting; with it missing (a page that loads this file alone) the map is
  // the map as it always was.
  function rawMode() {
    let p = null;
    try {
      if (typeof MapViews !== 'undefined' && typeof MapViews.settings === 'function') p = MapViews.settings().paths;
    } catch (_) { p = null; }
    return MODES.includes(p) ? p : 'every';
  }

  function mapNow() { return S.map || (typeof state !== 'undefined' && state.map) || null; }

  // The choice at this zoom: 'lod' becomes 'best' zoomed out, 'every' in.
  function mode() {
    const p = rawMode();
    if (p !== 'lod') return p;
    const m = mapNow();
    const z = m && typeof m.getZoom === 'function' ? m.getZoom() : 0;
    return z < LOD_ZOOM ? 'best' : 'every';
  }

  // The 3-D view and the twin draw the network themselves; the 2-D overlays
  // under them would only be work nobody sees.
  function blocked() {
    return (typeof Map3D !== 'undefined' && typeof Map3D.active === 'function' && !!Map3D.active())
        || (typeof MapTwin !== 'undefined' && typeof MapTwin.active === 'function' && !!MapTwin.active());
  }

  const pairKey = (sid, rid) => `${sid}|${rid}`;
  const push = (map, k, v) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
  const fmt = n => Number(n || 0).toLocaleString('en-AU');
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const strokeScale = () => (typeof mapStrokeScale === 'function' ? mapStrokeScale() : 1);
  const lineColour = () => (typeof cssVar === 'function' ? cssVar('--map-line', '#ff6f00') : '#ff6f00');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Great-circle km between two stations — only ever for repeaters a few
  // dozen km apart, so the haversine's accuracy is more than enough.
  function km(a, b) {
    const rad = Math.PI / 180;
    const dp = (b.lat - a.lat) * rad, dl = (b.lon - a.lon) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ── Best path ──────────────────────────────────────────────────────────────

  // The figure a path is ranked by: its known fade margin, field station
  // first (the way the traffic runs), or null.
  function marginOf(l) {
    if (typeof MapFade === 'undefined' || typeof MapFade.known !== 'function') return null;
    try {
      const k = MapFade.known(l.s, l.r);
      const m = k && k.margin != null ? Number(k.margin) : null;
      return Number.isFinite(m) ? m : null;
    } catch (_) { return null; }
  }

  // Is path l (margin m) better than the best so far, t (margin tm)? A path
  // with a figure beats one without; between two figures the bigger margin;
  // otherwise the shorter path. A tie keeps the first, so the pick is stable.
  function better(l, m, t, tm) {
    if (m != null && tm == null) return true;
    if (m == null && tm != null) return false;
    if (m != null && tm != null && m !== tm) return m > tm;
    return Number(l.km) < Number(t.km);
  }

  // field station id → its best path. A station with one path skips the
  // ranking, which is most of the cost: known() works out a signature.
  function pickBest(links) {
    const by = new Map();
    for (const l of links) if (l && l.s && l.r) push(by, l.s.id, l);
    const best = new Map();
    for (const [sid, ls] of by) {
      if (ls.length === 1) { best.set(sid, ls[0]); continue; }
      let top = null, topM = null;
      for (const l of ls) {
        const m = marginOf(l);
        if (!top || better(l, m, top, topM)) { top = l; topM = m; }
      }
      best.set(sid, top);
    }
    return best;
  }

  // The saved margins are loaded only when something asks (the fade colouring,
  // or ready()). With the colouring off, nothing else will — so ask once a
  // session, and draw the map again if what they say moves a station's pick.
  // With the colouring on it loads them itself and redraws when they land.
  function askSavedMargins() {
    if (S.fadeAsked) return;
    if (typeof state !== 'undefined' && state.mapFade) return;
    if (typeof MapFade === 'undefined' || typeof MapFade.ready !== 'function') return;
    S.fadeAsked = true;
    let p = null;
    try { p = MapFade.ready(); } catch (_) { p = null; }
    if (!p || typeof p.then !== 'function') return;
    p.then(() => {
      if (!S.map || !S.links || (S.built !== 'best' && S.built !== 'areas')) return;
      const now = pickBest(S.links);
      let moved = false;
      for (const [sid, l] of now) {
        const was = S.best.get(sid);
        if (!was || was.r.id !== l.r.id) { moved = true; break; }
      }
      if (moved && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
    }, () => { /* no datastore — the session's own figures and the distances stand */ });
  }

  // ── Areas ──────────────────────────────────────────────────────────────────

  // repeater id → the field stations whose best path goes to it, then their
  // colours.
  function buildAreas() {
    for (const l of S.best.values()) {
      let a = S.areas.get(l.r.id);
      if (!a) S.areas.set(l.r.id, a = { r: l.r, stations: [] });
      a.stations.push(l.s);
    }
    colourAreas();
  }

  // Greedy colouring: the repeater with the most neighbours first (they are
  // the hard ones), each taking the first colour none of its coloured
  // neighbours has. With all eight taken nearby — not something this network
  // does — the colour whose nearest holder is furthest away. Ties go by id,
  // so the same network is coloured the same way every time it is drawn.
  function colourAreas() {
    const reps = [...S.areas.values()].map(a => a.r).filter(r => r && r.lat != null && r.lon != null);
    const near = new Map(reps.map(r => [r.id, []]));
    for (let i = 0; i < reps.length; i++) {
      for (let j = i + 1; j < reps.length; j++) {
        const d = km(reps[i], reps[j]);
        if (d < NEIGHBOUR_KM) {
          near.get(reps[i].id).push({ id: reps[j].id, d });
          near.get(reps[j].id).push({ id: reps[i].id, d });
        }
      }
    }
    const order = reps.slice().sort((a, b) => near.get(b.id).length - near.get(a.id).length
      || String(a.id).localeCompare(String(b.id)));
    const n = AREA_TOKENS.length;
    for (const r of order) {
      const nb = near.get(r.id).filter(o => S.colourIdx.has(o.id));
      const taken = new Set(nb.map(o => S.colourIdx.get(o.id)));
      let idx = -1;
      for (let i = 0; i < n; i++) if (!taken.has(i)) { idx = i; break; }
      if (idx < 0) {
        let far = -1;
        for (let i = 0; i < n; i++) {
          const d = Math.min(...nb.filter(o => S.colourIdx.get(o.id) === i).map(o => o.d));
          if (d > far) { far = d; idx = i; }
        }
      }
      S.colourIdx.set(r.id, Math.max(0, idx));
    }
  }

  function palette() {
    if (!S.palette) {
      S.palette = AREA_TOKENS.map((t, i) => (typeof cssVar === 'function' ? cssVar(t, AREA_FALLBACK[i]) : AREA_FALLBACK[i]));
    }
    return S.palette;
  }

  function areaColour(repeaterId) {
    if (!S.colourIdx.has(repeaterId)) return null;
    return palette()[S.colourIdx.get(repeaterId)] || null;
  }

  // ── The build: thin, prepare, curve ────────────────────────────────────────

  // links: passRangeLinks items { s, r, km }, already cut by the filter, the
  // distance and hide mode. Returns the ones to draw and the ones not drawn,
  // and remembers the second lot for the "other paths" overlay.
  function thin(links) {
    const list = Array.isArray(links) ? links : [];
    const m = mode();
    S.built = m;
    S.links = list;
    S.dropBySta = new Map();
    S.dropByRep = new Map();
    S.best = new Map();
    S.areas = new Map();
    S.colourIdx = new Map();
    S.palette = null;         // a theme switch refreshes the map; re-read the tokens
    let kept = list, dropped = [];
    if (m === 'best' || m === 'areas') {
      S.best = pickBest(list);
      if (m === 'best') {
        const keep = new Set(S.best.values());
        kept = list.filter(l => keep.has(l));
        dropped = list.filter(l => !keep.has(l));
      } else {
        kept = [];
        dropped = list.slice();
        buildAreas();
      }
      for (const l of dropped) {
        if (!l || !l.s || !l.r) continue;
        push(S.dropBySta, l.s.id, l);
        push(S.dropByRep, l.r.id, l);
      }
      if (list.length) askSavedMargins();
    }
    S.kept = kept.length;
    S.dropped = dropped.length;
    return { kept, dropped };
  }

  // Must be called with the kept list after thin() and before any curve() in
  // the same build: it works out the bundles' control points and the trunks.
  // A no-op (beyond clearing the last build's) in every mode but bundle.
  function prepare(kept) {
    S.ctrl = new Map();
    S.trunks = [];
    if (S.built !== 'bundle') return;
    const groups = new Map();
    for (const l of kept || []) {
      if (!l || !l.s || !l.r || !(Number(l.km) >= BUNDLE_MIN_KM)) continue;
      const s = l.s, r = l.r;
      if (s.lat == null || s.lon == null || r.lat == null || r.lon == null) continue;
      // A local equirectangular frame round the repeater: x east, y north,
      // both in degrees of latitude. Good to well under a percent over a
      // hundred km, which is all a bearing and a midpoint need.
      const c = Math.cos(r.lat * Math.PI / 180) || 1e-6;
      const dx = (s.lon - r.lon) * c, dy = s.lat - r.lat;
      if (!dx && !dy) continue;
      const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      const key = `${r.id}|${Math.floor(deg / SECTOR_DEG)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { r, c, links: [] });
      g.links.push(l);
    }
    for (const g of groups.values()) {
      const n = g.links.length;
      if (n < 2) continue;                       // a slice of one stays straight
      let sx = 0, sy = 0;
      for (const l of g.links) { sx += (l.s.lon - g.r.lon) * g.c; sy += l.s.lat - g.r.lat; }
      const jx = JOIN * sx / n, jy = JOIN * sy / n;   // J − R, in the frame
      const jd = Math.hypot(jx, jy);
      if (!(jd > 0)) continue;
      for (const l of g.links) {
        const sd = Math.hypot((l.s.lon - g.r.lon) * g.c, l.s.lat - g.r.lat);
        const k = Math.min(1, SHORT_REACH * sd / jd);
        S.ctrl.set(pairKey(l.s.id, g.r.id), { lat: g.r.lat + jy * k, lng: g.r.lon + (jx * k) / g.c });
      }
      if (n >= TRUNK_MIN) {
        const t = {
          repeaterId: g.r.id,
          lat: g.r.lat + jy,
          lng: g.r.lon + jx / g.c,
          n,
          r: g.r,
          members: g.links.map(l => l.s.id),
        };
        // The repeater's line colour, read live off one of the slice's drawn
        // core lines — so it follows the frequency or fade colouring and a
        // blast — else the plain link colour.
        t.colourOf = () => {
          const line = trunkLine(t);
          return (line && line.options && line.options.color) || lineColour();
        };
        S.trunks.push(t);
      }
    }
  }

  // The line to draw for one field path, station end first: a quadratic curve
  // through its slice's control point, or null to draw it straight.
  function curve(s, r) {
    if (S.built !== 'bundle' || !s || !r) return null;
    const J = S.ctrl.get(pairKey(s.id, r.id));
    if (!J) return null;
    const pts = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS, u = 1 - t;
      pts.push([u * u * s.lat + 2 * u * t * J.lat + t * t * r.lat,
                u * u * s.lon + 2 * u * t * J.lng + t * t * r.lon]);
    }
    return pts;
  }

  // ── Lookups for the overlays, rebuilt only when the map was ────────────────

  // station id → its pin. state.mapMarkers is a new array every build, so the
  // array and its length say whether the last index still holds.
  function pins() {
    const src = (typeof state !== 'undefined' && state.mapMarkers) || [];
    if (S.pinIdx && S.pinSrc === src && S.pinLen === src.length) return S.pinIdx;
    S.pinIdx = new Map();
    for (const m of src) if (m && m.mnStationId != null) S.pinIdx.set(m.mnStationId, m);
    S.pinSrc = src; S.pinLen = src.length;
    return S.pinIdx;
  }

  // 's.id|r.id' → the drawn core field line of that path.
  function coreLines() {
    const src = (typeof state !== 'undefined' && state.mapLines) || [];
    if (S.lineIdx && S.lineSrc === src && S.lineLen === src.length) return S.lineIdx;
    S.lineIdx = new Map();
    for (const l of src) {
      if (l && l.mnLinkRole === 'core' && l.mnLinkStationId != null) {
        S.lineIdx.set(pairKey(l.mnLinkStationId, l.mnLinkRepeaterId), l);
      }
    }
    S.lineSrc = src; S.lineLen = src.length;
    return S.lineIdx;
  }

  function trunkLine(t) {
    const idx = coreLines();
    for (const sid of t.members) {
      const l = idx.get(pairKey(sid, t.repeaterId));
      if (l) return l;
    }
    return null;
  }

  // How strong a line is before the draw mode thins it (MapViews), for the
  // trunks to follow the strength slider, auto-contrast and Balance.
  function fullOpacityOf(line) {
    if (!line) return null;
    try {
      if (typeof MapViews !== 'undefined' && typeof MapViews.fullOpacity === 'function') return MapViews.fullOpacity(line);
    } catch (_) { /* fall through to the line's own */ }
    return line.mnFullOpacity != null ? line.mnFullOpacity : (line.options && line.options.opacity);
  }

  // The colour a path not drawn would have been drawn in, so its dashes match
  // the lines round it: the channel's colour under the frequency colouring
  // (MapFreq's own pick), the band's under the fade colouring when a figure
  // is known, else the plain link colour. Resolved once a frame.
  function pathColourer() {
    const base = lineColour();
    try {
      if (typeof MapFreq !== 'undefined') {
        if (typeof MapFreq.colourFor === 'function') return (s, r) => MapFreq.colourFor(s, r) || base;
        if (typeof MapFreq.active === 'function' && MapFreq.active()
            && typeof MapFreq.pathChannel === 'function' && typeof MapFreq.rows === 'function') {
          const byMhz = new Map(MapFreq.rows().map(x => [x.mhz, x.colour]));
          return (s, r) => { const c = MapFreq.pathChannel(s, r); return (c && byMhz.get(c.mhz)) || base; };
        }
      }
      if (typeof MapFade !== 'undefined' && typeof MapFade.active === 'function' && MapFade.active()
          && typeof MapFade.bands === 'function' && typeof cssVar === 'function') {
        const b = MapFade.bands();
        const col = {
          good: cssVar('--map-fade-good', base), ok: cssVar('--map-fade-ok', base), bad: cssVar('--map-fade-bad', base),
        };
        return (s, r) => {
          const m = marginOf({ s, r });
          if (m == null) return base;
          return m >= b.good ? col.good : m >= b.ok ? col.ok : col.bad;
        };
      }
    } catch (_) { /* the plain colour, below */ }
    return () => base;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  // Pixels per km on the ground, as a function of latitude: measured once at
  // the view's centre, then scaled by Mercator's 1/cos(lat) — the view is
  // never so tall that the difference matters, but it costs nothing.
  function pxPerKm(h) {
    const m = S.map;
    const c = m.getCenter();
    const rad = Math.PI / 180;
    const cos0 = Math.max(0.01, Math.cos(c.lat * rad));
    const p = h.at(c.lat, c.lng), q = h.at(c.lat, c.lng + 1 / (111.32 * cos0));
    const k0 = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return lat => k0 * cos0 / Math.max(0.01, Math.cos(lat * rad));
  }

  // The areas, then the halos round their pins. Each repeater's circles go in
  // one path and are filled once with the nonzero rule, so where two of its
  // circles overlap the colour is laid down once, not twice — the same pixels
  // an offscreen union composited at AREA_ALPHA would give, without a
  // full-size canvas cleared and copied for every repeater. Two repeaters'
  // areas do overlap each other, on purpose: that is country both can hear.
  function drawAreas(ctx, h) {
    if (blocked() || S.built !== 'areas' || !S.areas.size || !S.map) return;
    const size = h.size();
    const pal = palette();
    const kmPx = pxPerKm(h);
    const focus = typeof state !== 'undefined' ? state.mapFocusRepeaterId : null;
    const TAU = Math.PI * 2;

    for (const [rid, a] of S.areas) {
      ctx.beginPath();
      let any = false;
      for (const st of [a.r].concat(a.stations)) {
        if (!st || st.lat == null || st.lon == null) continue;
        const [x, y] = h.at(st.lat, st.lon);
        const rad = Math.max(AREA_MIN_PX, AREA_KM * kmPx(st.lat));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < -rad || y < -rad || x > size.x + rad || y > size.y + rad) continue;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, TAU);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = AREA_ALPHA * (focus != null && focus !== rid ? AREA_DIM : 1);
      ctx.fillStyle = pal[S.colourIdx.get(rid) || 0];
      ctx.fill('nonzero');
    }

    // "The pin wears its repeater's colour": a ring just outside each pin,
    // under it, so the pin's own ring and fill are untouched. Round the
    // repeater's own pin too, which says whose colour it is. Only where a pin
    // is drawn — one in a cluster bubble has none to ring — and at the pin's
    // position, which the fan-out may have moved off the station's.
    const idx = pins();
    ctx.lineWidth = HALO_W;
    for (const [rid, a] of S.areas) {
      ctx.beginPath();
      let any = false;
      for (const st of [a.r].concat(a.stations)) {
        const m = st && idx.get(st.id);
        if (!m || m._mnClustered || !m._map || typeof m.getLatLng !== 'function') continue;
        const ll = m.getLatLng();
        const [x, y] = h.at(ll.lat, ll.lng);
        const pr = typeof m.getRadius === 'function' ? m.getRadius() : (m.mnRadius || 5);
        const rad = pr + HALO_GAP;
        if (!h.onScreen(x, y, rad + HALO_W)) continue;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, TAU);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = HALO_ALPHA * (focus != null && focus !== rid ? 0.35 : 1);
      ctx.strokeStyle = pal[S.colourIdx.get(rid) || 0];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Is the segment p–q wholly off one side of the screen (padded)?
  function offScreen(p, q, size, pad) {
    return (p[0] < -pad && q[0] < -pad) || (p[1] < -pad && q[1] < -pad)
        || (p[0] > size.x + pad && q[0] > size.x + pad) || (p[1] > size.y + pad && q[1] > size.y + pad);
  }

  function drawTrunks(ctx, h) {
    const size = h.size();
    const sc = strokeScale();
    for (const t of S.trunks) {
      const r = t.r;
      const q = h.at(r.lat, r.lon);
      const p = h.at(r.lat + TRUNK_FROM * (t.lat - r.lat), r.lon + TRUNK_FROM * (t.lng - r.lon));
      if (offScreen(p, q, size, 16)) continue;
      const line = trunkLine(t);
      const colour = (line && line.options && line.options.color) || lineColour();
      // Strong enough to read as the sum of its paths at the default link
      // strength, and following the strength down when the person turns the
      // lines down (or Balance toward the photo); a fifth while focus dims it.
      const full = fullOpacityOf(line);
      const k = (full == null ? 1 : clamp(0.35 + full, 0.5, 1)) * (line && line.mnFocusDimmed ? 0.25 : 1);
      const w = (1.4 + 0.9 * Math.sqrt(t.n)) * sc;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.globalAlpha = TRUNK_CASE_ALPHA * k;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = w + 2.4;
      ctx.stroke();
      ctx.globalAlpha = TRUNK_ALPHA * k;
      ctx.strokeStyle = colour;
      ctx.lineWidth = w;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // The ids whose other paths are asked for: the pin pointed at, the card's
  // station and the focused repeater.
  function askedIds() {
    const ids = [];
    let hov = null;
    try {
      if (typeof MapViews !== 'undefined' && typeof MapViews.hovered === 'function') hov = MapViews.hovered();
    } catch (_) { hov = null; }
    const card = typeof state !== 'undefined' && state.stnCard ? state.stnCard.id : null;
    const focus = typeof state !== 'undefined' ? state.mapFocusRepeaterId : null;
    for (const id of [hov, card, focus]) if (id != null && !ids.includes(id)) ids.push(id);
    return ids;
  }

  // The other paths of the stations asked about: dashed, with a white casing,
  // every casing before any colour (as the map draws its own lines, so one
  // path's casing never cuts through another's colour). In areas mode a
  // station's best path is among them — nothing else on the map says which
  // one it is — and that one is drawn solid and a little heavier.
  function drawOthers(ctx, h) {
    const ids = askedIds();
    if (!ids.length) return;
    const seen = new Set(), list = [];
    for (const id of ids) {
      for (const l of (S.dropBySta.get(id) || []).concat(S.dropByRep.get(id) || [])) {
        if (seen.has(l)) continue;
        seen.add(l);
        list.push(l);
      }
    }
    if (!list.length) return;
    if (list.length > OTHER_MAX) list.length = OTHER_MAX;
    const size = h.size();
    const sc = strokeScale();
    const colourOf = pathColourer();
    const drawn = [];
    for (const l of list) {
      const p = h.at(l.s.lat, l.s.lon), q = h.at(l.r.lat, l.r.lon);
      if (!Number.isFinite(p[0]) || offScreen(p, q, size, 8)) continue;
      drawn.push({ p, q, solid: S.built === 'areas' && S.best.get(l.s.id) === l, colour: colourOf(l.s, l.r) });
    }
    for (const pass of ['casing', 'core']) {
      const casing = pass === 'casing';
      for (const d of drawn) {
        const w = (d.solid ? OTHER_W + 0.4 : OTHER_W) * sc;
        ctx.setLineDash(d.solid ? [] : OTHER_DASH);
        ctx.beginPath();
        ctx.moveTo(d.p[0], d.p[1]);
        ctx.lineTo(d.q[0], d.q[1]);
        ctx.globalAlpha = casing ? OTHER_ALPHA * 0.75 : OTHER_ALPHA;
        ctx.strokeStyle = casing ? '#ffffff' : d.colour;
        ctx.lineWidth = casing ? w + 2 : w;
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawX(ctx, h) {
    if (blocked() || !S.map) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (S.built === 'bundle' && S.trunks.length) drawTrunks(ctx, h);
    if (S.built === 'best' || S.built === 'areas') drawOthers(ctx, h);
  }

  // Both overlays, once, on the next frame. MapViews calls this after a
  // build, a restyle, a hover, the card and the focus.
  function schedule() {
    if (S.areasH) S.areasH.schedule();
    if (S.xH) S.xH.schedule();
  }

  // "Best path until you zoom in" is decided by the zoom; when a zoom crosses
  // LOD_ZOOM the paths drawn change, and that is a rebuild of the lines.
  function onZoom() {
    if (S.built == null || rawMode() !== 'lod') return;
    if (mode() === S.built) return;
    if (typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
  }

  // ── What the panel, the legend and the note say ────────────────────────────

  function counts() { return { kept: S.kept, dropped: S.dropped }; }

  // One line for the link note under the switches, or '' when every path is
  // drawn straight. Plain text: the caller escapes and places it.
  function noteText() {
    const all = S.kept + S.dropped;
    if (!all || !S.built || S.built === 'every') return '';
    if (S.built === 'best') {
      const lod = rawMode() === 'lod';
      return `${lod ? 'Best path until you zoom in' : 'Best path only'}: ${fmt(S.kept)} of ${plural(all, 'path', 'paths')} drawn — `
        + `${lod ? 'zoom in for every path, or ' : ''}point at a station for the rest.`;
    }
    if (S.built === 'areas') {
      return `Areas, no lines: ${plural(all, 'path', 'paths')} shown as the areas of ${plural(S.areas.size, 'repeater', 'repeaters')} — `
        + 'point at a station for its paths.';
    }
    if (S.built === 'bundle') {
      return `Bundled into trunks: every path drawn, ${plural(S.trunks.length, 'trunk', 'trunks')} where `
        + `${TRUNK_MIN} or more come into a repeater from one direction.`;
    }
    return '';
  }

  // Rows for the Links section of the legend, in the legend's own markup, or
  // '' when every path is drawn straight. Colours arrive as --dot, the seam
  // .legend-dot already uses; the line swatches are classes in styles.css.
  function legendHtml() {
    const m = S.built;
    if (!m || m === 'every') return '';
    const term = (w, text) => (typeof termHtml === 'function' ? termHtml(text || w, WORDS[w]) : (text || w));
    const item = (swatch, html) => `<span class="legend-item">${swatch}<span class="small">${html}</span></span>`;
    const rows = [];
    if (m === 'best') {
      const lod = rawMode() === 'lod';
      rows.push(item('<span class="legend-line"></span>',
        `${term(lod ? 'Best path until you zoom in' : 'Best path', lod ? null : 'Best path only')} — one line per field station`));
    }
    if (m === 'bundle') {
      rows.push(item('<span class="legend-line legend-line-trunk"></span>',
        `${term('Trunk')} — ${term('Bundled into trunks', 'bundled')} paths sharing their last stretch into a repeater`));
    }
    if (m === 'areas') {
      const pal = palette();
      const dots = pal.slice(0, 3).map(c => `<span class="legend-dot legend-area" style="--dot:${typeof escAttr === 'function' ? escAttr(c) : c}"></span>`).join('');
      rows.push(item(dots, `${term('Areas')} — a repeater's stations shaded in its colour, their pins ringed in it`));
    }
    if (m === 'best' || m === 'areas') {
      rows.push(item('<span class="legend-line legend-line-other"></span>',
        `${term('Other paths')} of the station you point at — dashed`));
    }
    return rows.join('');
  }

  // ── attach / detach ────────────────────────────────────────────────────────

  function attach(map) {
    if (!map) return;
    if (S.map === map && S.areasH) { schedule(); return; }
    detach();
    if (typeof MapOverlay === 'undefined') return;
    S.map = map;
    S.areasH = MapOverlay.create(map, { pane: PANE_AREAS, z: Z_AREAS, className: 'mn-areas-canvas', draw: drawAreas,
      wanted: () => mode() === 'areas' });
    S.xH = MapOverlay.create(map, { pane: PANE_X, z: Z_X, className: 'mn-paths-canvas', draw: drawX,
      wanted: () => mode() !== 'every' });
    map.on('zoomend', onZoom);
  }

  function detach() {
    if (S.map) S.map.off('zoomend', onZoom);
    if (S.areasH) S.areasH.destroy();
    if (S.xH) S.xH.destroy();
    S.map = null; S.areasH = null; S.xH = null;
    S.built = null; S.links = null; S.kept = 0; S.dropped = 0;
    S.dropBySta = new Map(); S.dropByRep = new Map(); S.best = new Map();
    S.areas = new Map(); S.colourIdx = new Map(); S.palette = null;
    S.ctrl = new Map(); S.trunks = [];
    S.pinIdx = null; S.pinSrc = null; S.pinLen = -1;
    S.lineIdx = null; S.lineSrc = null; S.lineLen = -1;
    // fadeAsked stays: "once a session" outlives one visit to the tab.
  }

  // For the checks: what the last build decided, without the station objects.
  function _state() {
    return {
      attached: !!S.map,
      raw: rawMode(),
      mode: mode(),
      built: S.built,
      kept: S.kept,
      dropped: S.dropped,
      best: S.best.size,
      areas: [...S.areas.entries()].map(([id, a]) => ({ id, stations: a.stations.length, colour: areaColour(id) })),
      curves: S.ctrl.size,
      trunks: S.trunks.map(t => ({ repeaterId: t.repeaterId, lat: t.lat, lng: t.lng, n: t.n })),
      fadeAsked: S.fadeAsked,
    };
  }

  return {
    attach, detach, mode, thin, prepare, curve, schedule, counts,
    areaColour, legendHtml, noteText, WORDS, lodZoom: LOD_ZOOM, _state,
  };
})();
if (typeof window !== 'undefined') window.MapPaths = MapPaths;
