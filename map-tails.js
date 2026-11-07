// MegaNet — map-tails.js
//
//   MapTails   the radio paths on the Stations map drawn as tails and a
//              spotlight: each path that is not lit shows only a short stroke
//              out of each end, fading as it goes, and the paths of the
//              stations under a circle round the pointer — and of the station
//              pointed at, the one on the card, and the repeater in focus —
//              are drawn whole.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js (initMap attaches it, stopStationsMap detaches it) and
// from map-views.js: the choice of drawing lives in its settings; it asks
// isLit() for every field line's strength (lineOpacity, restyle), calls
// rebuildIndex() at the end of every build and sync() when the settings, the
// hovered pin, the card or the focus change, and asks legendHtml() for the
// legend's Links section. Reads MapViews.settings() and MapViews.hovered(),
// MapOverlay, MapMagnify, Map3D, MapTwin and the map's state
// (state.mapLines, state.mapMarkers, state.stnCard, state.mapFocusRepeaterId)
// live, at call time, and hands MapViews.restyle() the lines whose lit state
// changed. Leaflet is reached the same way, through the map. All of it from
// inside functions, and the IIFE body only declares, so this file's position
// among the modules is free (npm run toplevel), and nothing is measured at
// load.
//
// ── Why ──────────────────────────────────────────────────────────────────────
// Zoomed out, ~1,800 radio paths are a mat: every line crosses a dozen others,
// and the question anybody brings to the map — "where does *this* station's
// path go?" — has no answer in it. Tails keep the one thing the mat does say,
// that a station has paths and which way they leave, and drop the rest: each
// path is a short stroke out of its field station's pin, pointing along it,
// and a shorter one into its repeater, so a hilltop still wears its fan of
// arrivals. Pointing at a part of the map lights the paths of the stations
// there, whole, from end to end; nothing else is in the way of reading them.
//
// ── What is lit ──────────────────────────────────────────────────────────────
// A field path (casing and core, roles 'casing' and 'core') is lit when its
// field station is in the lit set, or when it runs into a repeater that is:
//
//   the spotlight      the field stations whose pins are inside the circle
//   the pointer        the pin under it (MapViews.hovered())
//   the card           the station whose card is open (state.stnCard.id)
//   the focus          the field stations of the focused repeater's drawn
//                      paths (state.mapFocusRepeaterId) — each of them whole,
//                      its paths to other repeaters too
//   a repeater         pointed at or carded: every field path into it
//
// isLit() is that test and nothing else — two Set lookups — because MapViews
// asks it for every line it restyles. The set is worked out again when the
// spotlight moves (a frame at a time at most), when the map settles, and on
// sync(); only the lines whose lit state changed are handed to
// MapViews.restyle(), so moving the pointer repaints the dozen paths it
// crossed, not five thousand. A station is a field station here when the
// index has field paths for it (rebuildIndex: station id → its lines,
// repeater id → the field lines into it), which is also what keeps a
// repeater's or a base's pin out of the spotlight.
//
// Backbone paths are MapViews' to decide (Backbone always in full): drawn
// whole, or — unticked — at nothing, with tails of their own here, in the
// backbone's black. isLit() answers for field lines only.
//
// ── The spotlight ────────────────────────────────────────────────────────────
// With "Spotlight follows the pointer" on, a device with a pointer that hovers
// moves it with the mouse (map mousemove, which Leaflet's canvas already
// throttles to ~30 a second, then one requestAnimationFrame); a touch screen,
// which has no hover, moves it to where the map is tapped. Off, there is no
// spotlight, and a path is lit by its pin being pointed at or its card open.
// It is off while the magnifier is on (it has a lens of its own under the
// pointer) and while the 3-D view or the digital twin covers the map.
//
// The in-circle test is in *layer* pixels — the pins' positions projected
// once per settled view (and again after a build), the pointer's from its
// container point at the time — not container pixels. The two are the same
// scale, but the layer's do not move while the map is dragged, so a frame
// worked out mid-drag still compares like with like.
//
// The map's own mouseout does not fire when the pointer leaves from over the
// shared canvas (Leaflet marks it _leaflet_disable_events), and that canvas
// covers the whole map, so the spotlight is put away on the container's DOM
// mouseleave instead — and while the pointer is over the map's own controls,
// which sit inside the container.
//
// ── Two canvases, one pane ───────────────────────────────────────────────────
// Both on MapOverlay, in pane PANE at PANE_Z — under the shared links-and-pins
// canvas (400), so a pin is never drawn over and a tail comes out from under
// its pin. The spotlight's ring and wash are on a canvas of their own, below
// the tails': the ring follows every movement of the pointer and costs one
// circle, while the tails — a few thousand gradient strokes zoomed out — are
// drawn again only when the lit set, the view or a line's colour changes.
//
// ── The tails ────────────────────────────────────────────────────────────────
// For each field core that is not lit (and each backbone core, when the
// backbone has tails): a stroke from each end along the path, min(Tail length,
// half the path) out of the field station and min(0.7 × Tail length, half the
// path) out of the repeater, so a short path's two tails meet in the middle
// rather than overlap. A linear gradient from the line's own colour at 0.95 to
// nothing, 1.8 px, over a white casing gradient 3.8 px wide at 0.55 — every
// casing first, then every colour, so no casing lies over another tail. The
// colour is read off the line at draw time (frequency, fade margin, a blast's
// red), and a line the focus has dimmed gets tails at the same fifth. A
// bundled path (map-paths.js) is a polyline: its tails walk along its first and
// last segments, round the bend if the bend is that close.
//
// The lines are projected once per zoom (layer pixels, the way map-flow.js
// does it), a tail off the screen is skipped before any gradient is made, and
// the colours are looked at again once a second (WATCH_MS): MapFade, MapLos
// and MapBlast repaint a line's colour without telling anybody but MapArrows.
// The same slow watch notices the 3-D view or the twin closing — neither says
// so — and puts the 2-D lines back to their tails strength through
// MapViews.restyle().
//
// Exposes: attach, detach, sync, isLit, rebuildIndex, schedule, active,
// legendHtml, WORDS, _spotAt, _state.
const MapTails = (function () {
  const PANE = 'mnTails', PANE_Z = 399;
  const FIELD_ROLES = new Set(['casing', 'core']);

  // ── How they look ──
  const REPEATER_SHARE = 0.7;   // the repeater end's tail, as a share of the field end's
  const TAIL_W = 2.4;           // px, × the Sunlight theme's stroke scale
  const CASE_W = 4.8;
  const TAIL_ALPHA = 0.95;      // at the pin; nothing at the tail's far end
  const CASE_ALPHA = 0.55;
  const FOCUS_DIM = 0.2;        // applyMapFocusStyles' dim, for a dimmed line's tails
  const MIN_PATH_PX = 3;        // a path shorter than this on screen gets no tails
  const MIN_TAIL_PX = 1.5;      // …and a tail shorter than this is not drawn
  const PAD = 4;                // px past the screen's edge a tail is still drawn
  const MAX_TAILS = 12000;      // a ceiling on one frame (MapArrows' reasoning)

  // ── The spotlight ──
  const RING_W = 1.6, RING_ALPHA = 0.9;              // white…
  const RING_DARK_W = 4, RING_DARK_ALPHA = 0.35;     // …over a dark ring
  const RING_DARK = '#0b1620';
  const WASH_ALPHA = 0.08;                           // the faint white inside it
  const MOVE_MIN_PX = 0.5;      // a pointer that moved less than this moves nothing

  // ── Pace ──
  const WATCH_MS = 1000;        // colours, 3-D / the twin, the magnifier looked at again

  // The defaults MapViews starts from, for the words below (the settings
  // themselves are MapViews', read at sync()).
  const LEN0 = 24, SPOT0 = 120;

  // The words the legend uses, on hover where they are used (core.js's
  // termHtml); MapViews' "What the words in Views mean" fold carries Tails and
  // Spotlight in its own list. Each one says the numbers that decide it.
  const WORDS = {
    Tails: 'Instead of whole lines, each radio path shows only a short stroke out of each end, fading as it goes: '
      + `${LEN0} pixels out of the field station's pin and ${Math.round(LEN0 * REPEATER_SHARE)} out of the repeater's to `
      + 'begin with (Tail length, in Views), never more than half the path. A path is drawn whole once it is lit.',
    Spotlight: `A circle round the pointer, ${SPOT0} pixels from its middle to begin with (Spotlight size, in Views): `
      + 'every path from a field station whose pin is inside it is drawn whole. On a touch screen it stays where you '
      + 'last tapped the map. It is off while the magnifier is on.',
    'Drawn whole': 'A path drawn as a full line rather than as tails: one from a station in the spotlight, the station '
      + 'under the pointer or on the open card, or a station served by the repeater in focus — and every path into a '
      + 'repeater you point at or whose card is open.',
    'Backbone tails': 'With Backbone always in full unticked, the backbone paths between repeaters and bases are drawn as '
      + `tails too, in the backbone's black: the full Tail length out of the sending end and ${Math.round(REPEATER_SHARE * 100)} % `
      + 'of it into the base — the full length at both ends of a path between two repeaters, which runs both ways.',
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const has = (o, f) => !!o && typeof o[f] === 'function';
  const strokeScale = () => (typeof mapStrokeScale === 'function' ? mapStrokeScale() : 1);
  const key = id => (id == null ? null : String(id));
  const emptyLit = () => ({ st: new Set(), rp: new Set() });
  // What linesNow() answers with no map built yet: one array, so the index
  // is not rebuilt on every look for want of lines.
  const NO_LINES = Object.freeze([]);

  const S = {
    map: null,
    tails: null,           // the MapOverlay handle the tails are drawn on
    spotH: null,           // …and the one under it for the spotlight's ring
    cfg: null,             // the settings as last read (sync)
    colours: null,         // tokens resolved once per sync: { line, backbone }
    byStation: new Map(),  // station id → its field lines (casing and core)
    byRepeater: new Map(), // repeater id → the field lines into it
    idxLines: null,        // the state.mapLines the index was built from…
    idxN: 0,               // …and how many lines it had then
    idxSeq: 0,
    lit: emptyLit(),       // what isLit() answers from: { st: station ids, rp: repeater ids }
    spot: null,            // { x, y } the spotlight's middle, in container pixels, or null
    anchor: null,          // the spotlight's layer point while the map is dragged
    ptr: null,             // the latest pointer, waiting for its frame
    moveRaf: null,
    ptrMode: null,         // 'hover' | 'tap' | null — which pointer events are bound
    container: null,       // the map's container, for mouseleave
    watch: null,
    wasBlocked: false,
    pins: null,            // the field pins in layer pixels (pins())
    geo: null,             // the projected lines (geometry())
    rgb: new Map(),        // colour → { on, off } gradient stops
    colourCode: new Map(), // colour → a small number, for the colour signature
    drawnSig: null,        // the colour signature of the last tails drawn
    last: { tails: 0, lines: 0, ms: 0, lit: 0, delta: 0 },
  };

  // ── What is chosen ─────────────────────────────────────────────────────────

  // The settings as MapViews holds them, with the map as it always was when
  // MapViews is missing (a page that loads this file alone): plain lines.
  function readCfg() {
    let s = null;
    try {
      if (typeof MapViews !== 'undefined' && has(MapViews, 'settings')) s = MapViews.settings();
    } catch (_) { s = null; }
    const t = (s && s.tails) || {};
    return {
      draw: s && typeof s.draw === 'string' ? s.draw : 'lines',
      len: clamp(num(t.len, LEN0), 8, 70),
      spot: clamp(num(t.spot, SPOT0), 60, 260),
      follow: t.follow !== false,
      backboneFull: t.backboneFull !== false,
    };
  }
  function cfg() { if (!S.cfg) S.cfg = readCfg(); return S.cfg; }

  // The 3-D view and the twin draw the network themselves and cover this one.
  function blocked() {
    try {
      return (typeof Map3D !== 'undefined' && has(Map3D, 'active') && !!Map3D.active())
          || (typeof MapTwin !== 'undefined' && has(MapTwin, 'active') && !!MapTwin.active());
    } catch (_) { return false; }
  }
  function magnifying() {
    try { return typeof MapMagnify !== 'undefined' && has(MapMagnify, 'on') && !!MapMagnify.on(); } catch (_) { return false; }
  }
  function hoverCapable() {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches); } catch (_) { return true; }
  }

  // Tails chosen, on a map (the 3-D view may still be over it)…
  const chosen = () => !!S.map && cfg().draw === 'tails';
  // …and drawn by this module now: the 2-D map in view.
  const active = () => chosen() && !blocked();
  // The spotlight wanted at all: tails, following, nothing covering the map
  // or holding a lens under the pointer.
  const spotWanted = () => active() && cfg().follow && !magnifying();

  function colours() {
    if (!S.colours) {
      const cv = (n, f) => (typeof cssVar === 'function' ? cssVar(n, f) : f);
      S.colours = { line: cv('--map-line', '#ff6f00'), backbone: cv('--map-backbone', '#000000') };
    }
    return S.colours;
  }

  // ── The index: which lines belong to which station and repeater ────────────

  function linesNow() { return (typeof state !== 'undefined' && state.mapLines) || NO_LINES; }

  function buildIndex() {
    const lines = linesNow();
    const byS = new Map(), byR = new Map();
    const push = (m, k, l) => { if (k == null) return; const a = m.get(k); if (a) a.push(l); else m.set(k, [l]); };
    for (const l of lines) {
      if (!l || !FIELD_ROLES.has(l.mnLinkRole) || l.mnLinkRepeaterId2 != null) continue;
      push(byS, key(l.mnLinkStationId), l);
      push(byR, key(l.mnLinkRepeaterId), l);
    }
    S.byStation = byS;
    S.byRepeater = byR;
    S.idxLines = lines;
    S.idxN = lines.length;
    S.idxSeq++;
    S.pins = null;
    S.geo = null;
  }
  // Built again when the lines are not the ones it was built from (a build
  // that happened without rebuildIndex, or before this module was attached).
  function ensureIndex() {
    const lines = linesNow();
    if (S.idxLines !== lines || S.idxN !== lines.length) buildIndex();
  }

  // ── The field pins, in layer pixels, once per settled view ─────────────────

  function pins() {
    const m = S.map;
    const markers = (typeof state !== 'undefined' && state.mapMarkers) || [];
    const z = m.getZoom(), po = m.getPixelOrigin();
    const P = S.pins;
    if (P && P.markers === markers && P.n0 === markers.length && P.z === z && P.px === po.x && P.py === po.y
        && P.idx === S.idxSeq) return P;
    const ids = [], xy = [];
    for (const mk of markers) {
      if (!mk || mk.mnStationId == null || !has(mk, 'getLatLng')) continue;
      const k = key(mk.mnStationId);
      if (!S.byStation.has(k)) continue;           // not a field station: no paths of its own to light
      const p = m.latLngToLayerPoint(mk.getLatLng());
      ids.push(k);
      xy.push(p.x, p.y);
    }
    S.pins = { markers, n0: markers.length, z, px: po.x, py: po.y, idx: S.idxSeq, ids, xy: Float64Array.from(xy), n: ids.length };
    return S.pins;
  }

  // ── The lit set ────────────────────────────────────────────────────────────

  function litIn(L, line) {
    const sid = line.mnLinkStationId, rid = line.mnLinkRepeaterId;
    return (sid != null && L.st.size > 0 && L.st.has(String(sid)))
        || (rid != null && L.rp.size > 0 && L.rp.has(String(rid)));
  }

  // isLit(line): what MapViews asks for every field line's strength. Two Set
  // lookups and nothing else — the set is worked out ahead (relight()).
  function isLit(line) {
    if (!line || !FIELD_ROLES.has(line.mnLinkRole) || line.mnLinkRepeaterId2 != null) return false;
    return litIn(S.lit, line);
  }

  function computeLit() {
    const L = emptyLit();
    if (!chosen()) return L;
    ensureIndex();
    // The spotlight: the field pins inside the circle.
    if (S.spot && spotWanted() && S.byStation.size) {
      const P = pins();
      const lp = S.map.containerPointToLayerPoint([S.spot.x, S.spot.y]);
      const r = cfg().spot, r2 = r * r, xy = P.xy;
      for (let i = 0; i < P.n; i++) {
        const dx = xy[2 * i] - lp.x, dy = xy[2 * i + 1] - lp.y;
        if (dx * dx + dy * dy <= r2) L.st.add(P.ids[i]);
      }
    }
    // The pin under the pointer and the card's station: a field station's
    // paths, or every field path into a repeater.
    const one = id => {
      const k = key(id);
      if (k == null) return;
      if (S.byStation.has(k)) L.st.add(k);
      if (S.byRepeater.has(k)) L.rp.add(k);
    };
    try { if (typeof MapViews !== 'undefined' && has(MapViews, 'hovered')) one(MapViews.hovered()); } catch (_) { /* no hover then */ }
    if (typeof state !== 'undefined') {
      one(state.stnCard && state.stnCard.id);
      // The focused repeater: the field stations of its drawn paths, whole.
      const f = key(state.mapFocusRepeaterId);
      if (f != null) {
        for (const l of S.byRepeater.get(f) || []) {
          if (l.mnLinkStationId != null) L.st.add(String(l.mnLinkStationId));
        }
      }
    }
    return L;
  }

  // The lines whose lit state differs between a and b: only the stations and
  // repeaters that came or went can have any, and of their lines only those
  // not still lit some other way.
  function delta(a, b) {
    const cand = new Set();
    const add = (idx, from, to) => {
      for (const k of from) if (!to.has(k)) for (const l of idx.get(k) || []) cand.add(l);
    };
    add(S.byStation, a.st, b.st); add(S.byStation, b.st, a.st);
    add(S.byRepeater, a.rp, b.rp); add(S.byRepeater, b.rp, a.rp);
    const out = [];
    for (const l of cand) if (litIn(a, l) !== litIn(b, l)) out.push(l);
    return out;
  }

  // Work the lit set out again; hand MapViews the lines that changed and
  // redraw the tails when any did. Silent: the set only (a full restyle is
  // about to follow — MapViews.afterBuild, or the 3-D view closing).
  function relight(silent) {
    const next = computeLit();
    const changed = silent ? null : delta(S.lit, next);
    S.lit = next;
    S.last.lit = next.st.size + next.rp.size;
    if (silent) return 0;
    S.last.delta = changed.length;
    if (changed.length) {
      try {
        if (typeof MapViews !== 'undefined' && has(MapViews, 'restyle')) MapViews.restyle(changed);
      } catch (e) { console.error('MapTails: restyle', e); }
      // The tails themselves are not redrawn: a lit path is drawn whole by
      // the map, on the canvas over this one, and covers its own tails. So a
      // spotlight sliding across the map costs the restyle of the paths it
      // lights and puts out, and no tail is made again.
    }
    return changed.length;
  }

  // ── The pointer ────────────────────────────────────────────────────────────

  // Over the map's own buttons and panels (Leaflet's control corners, inside
  // the container) the pointer is not over the map.
  function overControls(ev) {
    const t = ev && ev.target;
    return !!(t && typeof t.closest === 'function' && t.closest('.leaflet-control-container'));
  }

  function onMove(e) {
    if (!e || !e.containerPoint) return;
    S.ptr = overControls(e.originalEvent) ? 'off' : { x: e.containerPoint.x, y: e.containerPoint.y };
    if (S.moveRaf) return;
    S.moveRaf = requestAnimationFrame(applyMove);
  }
  // A frame's worth of pointer: the newest position, once.
  function applyMove() {
    S.moveRaf = null;
    const p = S.ptr;
    S.ptr = null;
    if (!p || !S.map) return;
    if (p === 'off' || !spotWanted()) { putAway(); return; }
    if (S.spot && Math.abs(S.spot.x - p.x) < MOVE_MIN_PX && Math.abs(S.spot.y - p.y) < MOVE_MIN_PX) return;
    S.spot = p;
    relight();
    if (S.spotH) S.spotH.schedule();
  }
  // On a touch screen: the spotlight goes where the map is tapped.
  function onTap(e) {
    if (!e || !e.containerPoint || !S.map || !spotWanted()) return;
    if (overControls(e.originalEvent)) return;
    S.spot = { x: e.containerPoint.x, y: e.containerPoint.y };
    relight();
    if (S.spotH) S.spotH.schedule();
  }
  function onLeave() {
    if (S.moveRaf) { cancelAnimationFrame(S.moveRaf); S.moveRaf = null; }
    S.ptr = null;
    putAway();
  }
  // No spotlight: its paths back to tails, its ring off.
  function putAway() {
    if (!S.spot) return;
    S.spot = null;
    S.anchor = null;
    relight();
    if (S.spotH) S.spotH.schedule();
  }

  // Leaflet's canvas sends no mousemove while the map is dragged, and the
  // pointer drags the map: so the spotlight is held to the ground under it
  // (its layer point) and, when the drag ends, put back where that ground now
  // is on the screen — which is where the pointer is.
  function onDragStart() {
    if (!S.spot || !S.map) return;
    const lp = S.map.containerPointToLayerPoint([S.spot.x, S.spot.y]);
    S.anchor = { x: lp.x, y: lp.y };
  }
  function onDragEnd() {
    if (!S.anchor || !S.map) return;
    const cp = S.map.layerPointToContainerPoint([S.anchor.x, S.anchor.y]);
    S.anchor = null;
    if (S.spot) S.spot = { x: cp.x, y: cp.y };
  }

  // The view settled: the pins are projected again, and the stations under a
  // spotlight that stood still while the map moved under it are new ones.
  function onSettle() {
    S.pins = null;
    if (!chosen()) return;
    if (S.spot) relight();
  }

  function bindPointer() {
    const want = chosen() && cfg().follow ? (hoverCapable() ? 'hover' : 'tap') : null;
    if (want === S.ptrMode) return;
    const m = S.map;
    if (m && S.ptrMode === 'hover') {
      m.off('mousemove', onMove);
      m.off('dragstart', onDragStart);
      m.off('dragend', onDragEnd);
      if (S.container) S.container.removeEventListener('mouseleave', onLeave);
      S.container = null;
    } else if (m && S.ptrMode === 'tap') {
      m.off('click', onTap);
      m.off('dragstart', onDragStart);
      m.off('dragend', onDragEnd);
    }
    if (S.moveRaf) { cancelAnimationFrame(S.moveRaf); S.moveRaf = null; }
    S.ptr = null;
    S.ptrMode = want;
    if (!m || !want) { S.spot = null; S.anchor = null; return; }
    m.on('dragstart', onDragStart);
    m.on('dragend', onDragEnd);
    if (want === 'hover') {
      m.on('mousemove', onMove);
      S.container = has(m, 'getContainer') ? m.getContainer() : null;
      if (S.container) S.container.addEventListener('mouseleave', onLeave);
    } else {
      m.on('click', onTap);
    }
  }

  // ── The lines, projected once per zoom ─────────────────────────────────────

  // Every field core and backbone core in state.mapLines, its points in layer
  // pixels and its length along the way. Kept while the lines, the zoom and
  // the pixel origin are the same (map-flow.js does the same).
  function geometry() {
    const m = S.map;
    const lines = linesNow();
    if (!m) return null;
    const z = m.getZoom(), po = m.getPixelOrigin();
    const g = S.geo;
    if (g && g.lines === lines && g.n === lines.length && g.z === z && g.px === po.x && g.py === po.y) return g;
    const field = [], back = [];
    for (const l of lines) {
      const role = l && l.mnLinkRole;
      if (role !== 'core' && role !== 'backbone') continue;
      let lls = has(l, 'getLatLngs') ? l.getLatLngs() : null;
      if (lls && lls.length && Array.isArray(lls[0])) lls = lls[0];   // a multi-polyline: its first part
      if (!lls || lls.length < 2) continue;
      const n = lls.length;
      const pts = new Float64Array(n * 2);
      let len = 0;
      for (let i = 0; i < n; i++) {
        const p = m.latLngToLayerPoint(lls[i]);
        pts[2 * i] = p.x; pts[2 * i + 1] = p.y;
        if (i) len += Math.hypot(p.x - pts[2 * i - 2], p.y - pts[2 * i - 1]);
      }
      const e = { l, pts, len, two: l.mnArrowDir === 'both' };
      if (role === 'core') { if (l.mnLinkRepeaterId2 == null) field.push(e); } else back.push(e);
    }
    S.geo = { lines, n: lines.length, z, px: po.x, py: po.y, field, back };
    return S.geo;
  }

  // The screen, in the overlay canvas's pixels: canvas = layer − (ox, oy).
  // Right mid-drag, when the canvas has moved with the map and the screen has
  // not (MapOverlay's fromContainer).
  function view(h) {
    const s = h.size();
    const c = h.fromContainer(0, 0);
    const lp = S.map.containerPointToLayerPoint([0, 0]);
    return {
      ox: lp.x - c[0], oy: lp.y - c[1],
      x0: c[0] - PAD, y0: c[1] - PAD, x1: c[0] + s.x + PAD, y1: c[1] + s.y + PAD,
    };
  }

  // ── Drawing the tails ──────────────────────────────────────────────────────

  // A colour's two gradient stops, its own at TAIL_ALPHA and the same colour
  // at nothing (fading to transparent black would grey the tail on the way).
  // The canvas reads any CSS colour back as #rrggbb or rgba(…), which is
  // what is parsed; cached per colour string.
  function stops(ctx, colour) {
    let v = S.rgb.get(colour);
    if (v) return v;
    let s = String(colour || '');
    try { ctx.fillStyle = '#000000'; ctx.fillStyle = s; s = String(ctx.fillStyle); } catch (_) { /* keep it as given */ }
    let r = 0, g = 0, b = 0, m;
    if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
      const n = parseInt(m[1], 16);
      r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
    } else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s))) {
      r = Math.round(+m[1]); g = Math.round(+m[2]); b = Math.round(+m[3]);
    }
    v = { on: `rgba(${r},${g},${b},${TAIL_ALPHA})`, off: `rgba(${r},${g},${b},0)` };
    S.rgb.set(colour, v);
    return v;
  }

  // One tail of entry e, `want` px long, out of its first point (or its last,
  // fromEnd), walking along the polyline: { pts: [x, y, …] in canvas pixels,
  // x0, y0 (at the pin), x1, y1 (the far end) } — or null when it is off the
  // screen or too short to see.
  function tail(e, fromEnd, want, V) {
    if (!(want >= MIN_TAIL_PX)) return null;
    const p = e.pts, n = p.length / 2;
    let i = fromEnd ? n - 1 : 0;
    const step = fromEnd ? -1 : 1;
    let x = p[2 * i] - V.ox, y = p[2 * i + 1] - V.oy;
    // Wholly off the screen: the tail cannot reach further than `want`.
    if (x < V.x0 - want || x > V.x1 + want || y < V.y0 - want || y > V.y1 + want) return null;
    const pts = [x, y];
    let left = want;
    for (let j = i + step; j >= 0 && j < n && left > 0; j += step) {
      const nx = p[2 * j] - V.ox, ny = p[2 * j + 1] - V.oy;
      const d = Math.hypot(nx - x, ny - y);
      if (!(d > 0)) continue;
      if (d >= left) {
        const f = left / d;
        x += (nx - x) * f; y += (ny - y) * f;
        left = 0;
      } else {
        x = nx; y = ny;
        left -= d;
      }
      pts.push(x, y);
    }
    if (pts.length < 4) return null;
    return { pts, x0: pts[0], y0: pts[1], x1: x, y1: y };
  }

  function strokeTail(ctx, t) {
    const pts = t.pts;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
    ctx.stroke();
  }

  // MapOverlay's draw for the tails: the canvas is cleared and scaled already.
  function drawTails(ctx, h) {
    S.last.tails = 0; S.last.lines = 0;
    if (!S.map || !active()) { S.drawnSig = null; return; }
    const t0 = performance.now();
    const G = geometry();
    if (!G || (!G.field.length && !G.back.length)) { S.drawnSig = sigOf(G); return; }
    const c = cfg(), col = colours(), sc = strokeScale();
    const V = view(h);
    const list = [];
    let nLines = 0;
    const both = (e, colour, alpha, fwdLen, backLen) => {
      const a = tail(e, false, Math.min(fwdLen, e.len / 2), V);
      const b = tail(e, true, Math.min(backLen, e.len / 2), V);
      if (a) { a.colour = colour; a.alpha = alpha; list.push(a); }
      if (b) { b.colour = colour; b.alpha = alpha; list.push(b); }
      if (a || b) nLines++;
    };

    // Field paths: the field station is the first point, the repeater the last.
    for (const e of G.field) {
      // Lit or not: a lit path's line covers its tails (see relight).
      if (e.len < MIN_PATH_PX) continue;
      const colour = (e.l.options && e.l.options.color) || col.line;
      both(e, colour, e.l.mnFocusDimmed ? FOCUS_DIM : 1, c.len, c.len * REPEATER_SHARE);
      if (list.length >= MAX_TAILS) break;
    }
    // Backbone paths, when they have tails too: the full length out of the
    // sending end (the first point — the repeater a base path leaves), and
    // both ends in full on a path that runs both ways. In the backbone's black,
    // as MapArrows and MapFlow draw it.
    if (!c.backboneFull && list.length < MAX_TAILS) {
      for (const e of G.back) {
        if (e.len < MIN_PATH_PX) continue;
        both(e, col.backbone, e.l.mnFocusDimmed ? FOCUS_DIM : 1, c.len, e.two ? c.len : c.len * REPEATER_SHARE);
        if (list.length >= MAX_TAILS) break;
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Every casing first, then every colour: no casing over another's tail.
    ctx.lineWidth = CASE_W * sc;
    for (const t of list) {
      const g = ctx.createLinearGradient(t.x0, t.y0, t.x1, t.y1);
      g.addColorStop(0, `rgba(255,255,255,${CASE_ALPHA})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = t.alpha;
      ctx.strokeStyle = g;
      strokeTail(ctx, t);
    }
    ctx.lineWidth = TAIL_W * sc;
    for (const t of list) {
      const st = stops(ctx, t.colour);
      const g = ctx.createLinearGradient(t.x0, t.y0, t.x1, t.y1);
      g.addColorStop(0, st.on);
      g.addColorStop(1, st.off);
      ctx.globalAlpha = t.alpha;
      ctx.strokeStyle = g;
      strokeTail(ctx, t);
    }
    ctx.globalAlpha = 1;
    S.drawnSig = sigOf(G);
    S.last.tails = list.length;
    S.last.lines = nLines;
    S.last.ms = Math.round((performance.now() - t0) * 100) / 100;
  }

  // What the tails' colours depend on, in one number: each core's colour and
  // whether the focus has dimmed it. Looked at once a second (watchTick), so a
  // line MapFade or MapLos has repainted, or a blast turned red, gets tails in
  // its new colour without any of them having to know about tails.
  function sigOf(G) {
    if (!G) return 0;
    let h = G.field.length;
    const code = c => {
      let v = S.colourCode.get(c);
      if (v == null) { v = S.colourCode.size + 1; S.colourCode.set(c, v); }
      return v;
    };
    for (const e of G.field) {
      const o = e.l.options || {};
      h = (Math.imul(h, 31) + code(o.color) * 2 + (e.l.mnFocusDimmed ? 1 : 0)) | 0;
    }
    if (!cfg().backboneFull) for (const e of G.back) h = (Math.imul(h, 31) + (e.l.mnFocusDimmed ? 1 : 0)) | 0;
    return h;
  }

  // ── Drawing the spotlight ──────────────────────────────────────────────────

  function drawSpot(ctx, h) {
    if (!S.map || !S.spot || !spotWanted() || !S.byStation.size) return;
    const [x, y] = h.fromContainer(S.spot.x, S.spot.y);
    const r = cfg().spot, sc = strokeScale();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = WASH_ALPHA;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = RING_DARK_ALPHA;
    ctx.strokeStyle = RING_DARK;
    ctx.lineWidth = RING_DARK_W * sc;
    ctx.stroke();
    ctx.globalAlpha = RING_ALPHA;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = RING_W * sc;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── The slow watch ─────────────────────────────────────────────────────────

  // While tails are chosen: once a second, whether the 3-D view or the twin
  // has come or gone (neither says so), whether the magnifier has taken the
  // pointer, and whether a line's colour has changed under the tails.
  function watchTick() {
    S.watch = null;
    if (!chosen()) return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!hidden && !noticeBlocked()) {
      if (S.spot && magnifying()) putAway();
      if (S.tails && sigOf(geometry()) !== S.drawnSig) S.tails.schedule();
    }
    S.watch = setTimeout(watchTick, WATCH_MS);
  }
  // The 3-D view or the twin come or gone since last looked: covered, no
  // spotlight and nothing drawn (active() is false); uncovered, every 2-D line
  // back to its tails strength — MapViews draws them at full while either is
  // up, and a build under it leaves them so — the lit set first. Asked by the
  // watch and by sync(), whichever comes first. Answers whether it is covered.
  function noticeBlocked() {
    const b = blocked();
    if (b === S.wasBlocked) return b;
    S.wasBlocked = b;
    if (b) {
      S.spot = null; S.anchor = null;
      relight();
    } else {
      relight(true);
      try { if (typeof MapViews !== 'undefined' && has(MapViews, 'restyle')) MapViews.restyle(); } catch (e) { console.error('MapTails: restyle', e); }
    }
    schedule();
    return b;
  }
  function startWatch() { if (!S.watch) S.watch = setTimeout(watchTick, WATCH_MS); }
  function stopWatch() { if (S.watch) { clearTimeout(S.watch); S.watch = null; } }

  // ── Public ─────────────────────────────────────────────────────────────────

  // Both canvases drawn again on the next frame.
  function schedule() {
    if (S.tails) S.tails.schedule();
    if (S.spotH) S.spotH.schedule();
  }

  // Read the settings again and start, stop or redraw to match. MapViews
  // calls this when the drawing settings change, after every build, and when
  // the hovered pin, the card or the focus moves. Nothing is projected here.
  function sync() {
    const before = S.cfg ? JSON.stringify(S.cfg) : '';
    S.cfg = readCfg();
    S.colours = null;
    if (!S.map) return;
    const changed = JSON.stringify(S.cfg) !== before;
    bindPointer();
    if (!chosen()) {
      // Not tails: nothing lit (MapViews does not ask while it is not), the
      // canvases cleared, and the 3-D view's state taken as it is now.
      stopWatch();
      S.spot = null; S.anchor = null;
      S.lit = emptyLit();
      S.wasBlocked = blocked();
      if (changed) schedule();
      return;
    }
    startWatch();
    if (noticeBlocked()) return;    // covered: it has done what there is to do
    // A hover, the card or the focus: relight() redraws the tails if any path
    // changed. A setting (tail length, spotlight size, …): both canvases.
    relight();
    if (changed) schedule();
    else if (S.spotH) S.spotH.schedule();
  }

  // At the end of every build (MapViews.afterBuild, before its restyle): the
  // index of the new lines, and the lit set worked out against them — no
  // restyle of its own, MapViews' follows.
  function rebuildIndex() {
    S.cfg = readCfg();
    buildIndex();
    if (!S.map) { S.lit = emptyLit(); return; }
    relight(true);
    // New lines, and a build that does not move the map moves no overlay:
    // both canvases drawn again on the next frame, after MapViews' restyle.
    schedule();
  }

  // Rows for the Links section of the legend (MapViews.legendHtml), in the
  // legend's own markup, or '' when the paths are not drawn as tails. The
  // swatches are classes in styles.css (legend-line-tails, legend-spot).
  function legendHtml() {
    const c = readCfg();
    if (c.draw !== 'tails' || typeof state === 'undefined') return '';
    const links = !!state.mapShowLinks, bb = !!state.mapShowBackbone;
    if (!links && !bb) return '';
    const term = (w, text) => (typeof termHtml === 'function' ? termHtml(text || w, WORDS[w]) : (text || w));
    const item = (swatch, html) => `
    <span class="legend-item">${swatch}<span class="small">${html}</span></span>`;
    const touch = !hoverCapable();
    const rows = [];
    if (links) {
      rows.push(item('<span class="legend-line legend-line-tails" aria-hidden="true"></span>',
        `${term('Tails')} — a short stroke out of each end of a path, ${Math.round(c.len)} px from the field station; `
        + `a path is ${term('Drawn whole', 'drawn whole')} once it is lit`));
      if (c.follow) {
        rows.push(item('<span class="legend-spot" aria-hidden="true"></span>',
          `${term('Spotlight')} — ${Math.round(c.spot)} px round ${touch ? 'where you last tapped the map' : 'the pointer'}: `
          + 'the paths of the stations inside it are drawn whole'));
      } else {
        rows.push(`
    <span class="legend-item"><span class="small txt-muted">${touch ? 'Tap a station' : 'Point at a station'}, or open its
      card, to draw its paths whole.</span></span>`);
      }
    }
    if (bb && !c.backboneFull) {
      rows.push(item('<span class="legend-line legend-line-tails legend-line-tails-backbone" aria-hidden="true"></span>',
        `${term('Backbone tails', 'Backbone paths')} as tails too, in black`));
    }
    return rows.join('');
  }

  // ── attach / detach ────────────────────────────────────────────────────────

  function attach(map) {
    if (!map) return;
    if (S.map === map && S.tails) { sync(); return; }
    detach();
    if (typeof MapOverlay === 'undefined') return;
    S.map = map;
    S.cfg = readCfg();
    S.wasBlocked = blocked();
    // The spotlight's canvas first, so it is the lower of the two in the pane.
    S.spotH = MapOverlay.create(map, { pane: PANE, z: PANE_Z, className: 'mn-spot-canvas', draw: drawSpot, animating: () => false,
      wanted: () => chosen() });
    S.tails = MapOverlay.create(map, { pane: PANE, z: PANE_Z, className: 'mn-tails-canvas', draw: drawTails, animating: () => false,
      wanted: () => chosen() });
    map.on('moveend zoomend', onSettle);
    sync();
  }

  function detach() {
    stopWatch();
    const m = S.map;
    if (m) {
      // Unbind whichever pointer events are bound, through the one place
      // that knows them.
      S.cfg = { draw: 'lines', len: LEN0, spot: SPOT0, follow: false, backboneFull: true };
      bindPointer();
      m.off('moveend zoomend', onSettle);
    }
    if (S.moveRaf) { cancelAnimationFrame(S.moveRaf); S.moveRaf = null; }
    if (S.tails) S.tails.destroy();
    if (S.spotH) S.spotH.destroy();
    S.map = null; S.tails = null; S.spotH = null; S.cfg = null; S.colours = null;
    S.byStation = new Map(); S.byRepeater = new Map(); S.idxLines = null; S.idxN = 0;
    S.lit = emptyLit();
    S.spot = null; S.anchor = null; S.ptr = null; S.ptrMode = null; S.container = null;
    S.pins = null; S.geo = null; S.drawnSig = null;
    S.wasBlocked = false;
  }

  // For the checks: put the spotlight at a container point (null puts it
  // away), as a pointer would — a headless browser's pointer may not hover.
  function _spotAt(x, y) {
    if (!S.map) return 0;
    if (x == null || y == null || !spotWanted()) { S.spot = null; S.anchor = null; }
    else S.spot = { x: +x, y: +y };
    const n = relight();
    if (S.spotH) S.spotH.schedule();
    return n;
  }

  // For the checks: what is chosen, what is lit and what the last frame drew.
  function _state() {
    const c = cfg();
    return {
      attached: !!S.map,
      draw: c.draw, len: c.len, spotSize: c.spot, follow: c.follow, backboneFull: c.backboneFull,
      chosen: chosen(), active: active(), blocked: blocked(),
      pointer: S.ptrMode,
      spot: S.spot ? { x: S.spot.x, y: S.spot.y } : null,
      lit: { stations: [...S.lit.st], repeaters: [...S.lit.rp] },
      index: { stations: S.byStation.size, repeaters: S.byRepeater.size, pins: S.pins ? S.pins.n : null },
      watching: !!S.watch,
      last: Object.assign({}, S.last),
    };
  }

  return { attach, detach, sync, isLit, rebuildIndex, schedule, active, legendHtml, WORDS, _spotAt, _state };
})();
if (typeof window !== 'undefined') window.MapTails = MapTails;
