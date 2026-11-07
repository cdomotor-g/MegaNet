// MegaNet — map-flow.js
//
//   MapFlow   the radio paths on the Stations map drawn as flow: short dashes
//             running along every path the way the traffic goes (Everything
//             flows), or the repeaters on the screen lighting their paths one
//             at a time (Repeaters take turns), or the network's own readings
//             running along them as they land (Live readings, which is
//             ⏱️ Latency's message animation, switched on from here).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js (initMap attaches it and stopStationsMap detaches it)
// and from map-views.js (the choice of drawing lives in its settings; it calls
// sync() when they change, after every build and when the card or the focus
// moves; it reads turn() for its note, legendHtml() and WORDS for the legend
// and its "What the words in Views mean" fold). Reads MapViews.settings(),
// MapOverlay, MapLatency, MapCluster, Map3D, MapTwin and the map's state
// (state.mapLines, state.mapMarkers, state.mapFocusRepeaterId) live, at call
// time. Leaflet is reached the same way. All of it from inside functions, and
// the IIFE body only declares, so this file's position among the modules is
// free (npm run toplevel), and nothing is measured at load.
//
// ── Why ──────────────────────────────────────────────────────────────────────
// A still line says "these two can hear each other". It does not say which way
// anything goes, and on this network that is most of the story: a field
// station reports *in* to the repeater whose window covers it, and a repeater
// passes it *on* to a base. MapArrows says so with chevrons, from zoom 10 in.
// Flow says it at every zoom by moving: the lines underneath go faint (the
// "Lines underneath" share, map-views.js) and dashes run along them, into each
// repeater and on to the base, so a fan of paths converging on one hilltop
// reads as traffic arriving there.
//
// ── Everything flows ─────────────────────────────────────────────────────────
// A dash DASH_ON px long every DASH_PERIOD px, moving at FIELD_PX_S px a
// second × Speed, from the field station's end to the repeater's. The phase is
// measured from the *end* of each path, not its start: every path into one
// repeater delivers a dash to it at the same moment, so a repeater pulses.
// (For a path of on-screen length L at distance travelled d, the dash pattern
// starts at (L + d) mod period from the path's start — the same arithmetic as
// canvas's lineDashOffset = −((d + L) mod period), done by hand; see "Batched
// by colour" for why.) A backbone path to a base runs one way, longer and
// slower dashes in the backbone's own black; a repeater-to-repeater path runs
// both ways at once — the two-way notation MapArrows uses, moving.
//
// ── Repeaters take turns ─────────────────────────────────────────────────────
// The repeaters on the screen that have a field path drawn, west to east, each
// get TURN_S seconds (÷ Speed, and never longer than at half speed), fading
// in and out over FADE_S: its field paths drawn in full on this overlay with
// bright dashes running in, its backbone paths stronger, a ring round it and
// its name beside it. With a repeater in focus (state.mapFocusRepeaterId) the
// turn holds on it. turn() says whose turn it is, for the Views note.
//
// ── Live readings ────────────────────────────────────────────────────────────
// Nothing of its own: ⏱️ Latency already runs a pulse along a station's path
// to the base as each of its readings lands in the database
// (MapLatency.setAnim). Choosing Live readings switches that on — quietly, and
// remembering that this module did it — and choosing anything else switches it
// back off, but only if it was this module that switched it on: a person who
// had it on in the ⏱️ Latency pane keeps it. The ownership is kept under
// LS_OWN as well, so a page closed in Live readings still knows, next time,
// that the animation was Flow's to turn off. The switch is made a microtask
// later, never inside a build: MapLatency.setAnim can rebuild the map (its
// "through hidden links" option), and sync() is called at the end of one.
//
// detach() does *not* switch it back: stopStationsMap runs at the top of every
// render of the Stations tab, not only on the way out, and flipping the
// remembered ⏱️ Latency switch off and on again on every render would be churn
// (and a rebuild during a teardown). Off the tab nothing animates anyway —
// MapLatency only watches the log while the Stations map is up.
//
// ── Still, and at thirty frames a second ─────────────────────────────────────
// Playing is the person's own choice (settings.flow.playing) when they have
// made one, and otherwise the device's: a device that asks for less motion
// (prefers-reduced-motion) starts with the dashes standing still, in place,
// until Play is pressed. Moving, a frame is drawn about every FRAME_MS — the
// dashes move a few pixels a frame, and sixty a second would only double the
// work for a picture nobody can tell apart. MapOverlay clears its canvas
// before every frame it draws, so a skipped frame cannot be skipped inside
// draw(); instead this module paces its own requestAnimationFrame loop and asks
// the overlay for one frame at a time (schedule()), and tells the overlay it
// is never animating on its own. Standing still, the one frame is redrawn
// once a second (STILL_MS) so it keeps up with the focus, a repaint of a
// line's colour, or a repeater's turn being held.
//
// Nothing runs while the page is hidden, or while the 3-D view or the digital
// twin covers the map: neither has an event for opening or closing, so while
// one is up a slow watch (STILL_MS) looks again, and when it goes it asks
// MapViews.restyle() to put the 2-D lines back to their Flow strength.
//
// ── Batched by colour, clipped to the screen ─────────────────────────────────
// About 1,800 field paths are drawn at the default distance, and this is a
// loop. So:
//   - Each path's points are projected once per zoom (layer pixels, the same
//     rounding Leaflet draws the line with), with their lengths along the
//     path, and re-projected only when the zoom, the pixel origin or the set
//     of lines changes — never per frame.
//   - A path whose box is off the screen is skipped; for one on it, only the
//     part of each segment inside the screen gets dashes (clipped
//     Liang–Barsky), so zoomed in on one valley a 60 km path costs the few
//     dashes in view, not hundreds.
//   - The dashes are generated by hand as short subpaths rather than drawn
//     with setLineDash, because every path has its own dash offset and a
//     canvas stroke has one: by hand, every path of one colour goes into one
//     Path2D, and the frame is one casing stroke and one colour stroke per
//     colour, not two strokes per path.
//   - A path with its far end inside the cluster bubble its station is grouped
//     into (MapCluster.bubbleOf) is wholly under the bubble, and skipped. One
//     that leaves the bubble is drawn: this overlay sits under the pins'
//     canvas, so the bubble covers the part inside it, and the rest is a path
//     the map is drawing.
//
// ── Where it sits ────────────────────────────────────────────────────────────
// Pane PANE at PANE_Z, under the shared links-and-pins canvas (400): a pin is
// never drawn over, and the faint lines lie over the dashes, which read through
// them. Pointer events are off (MapOverlay): nothing here is a click target.
//
// Exposes: attach, detach, sync, schedule, turn, playing, active, legendHtml,
// WORDS, _state.
const MapFlow = (function () {
  const PANE = 'mnFlow', PANE_Z = 399;
  const MODES = ['all', 'turns', 'live'];
  const DRAWS = ['lines', 'flow', 'tails'];
  const LS_OWN = 'mn-map-flow-live';   // '1' while ⏱️ Latency's animation is Flow's to turn off

  // ── Everything flows ──
  const DASH_ON = 6, DASH_PERIOD = 50;   // px: 6 on, 44 gap
  const FIELD_PX_S = 42;                 // px a second at Speed 1
  const FIELD_W = 1.6;                   // px, × the Sunlight theme's stroke scale
  const CASE_EXTRA = 1.4;                // the white casing is this much wider…
  const CASE_ALPHA = 0.4;                // …at this alpha
  const FIELD_ALPHA = 0.95;
  const DIM_ALPHA = 0.25;                // a line the focus has dimmed
  const BB_SPEED = 0.7;                  // backbone dashes move at this share of the field's
  const BB_ON = 12, BB_PERIOD = 66;      // repeater → base, one way: 12 on, 54 gap
  const BB2_ON = 6, BB2_PERIOD = 70;     // repeater ↔ repeater, both ways: 6 on, 64 gap
  const BB_W = 2.6;
  const BB_ALPHA = 0.9;

  // ── Repeaters take turns ──
  const TURN_S = 2.6;                    // seconds a turn at Speed 1
  const TURN_MIN_SPEED = 0.5;            // turns never last longer than at half speed
  const FADE_S = 0.3;                    // in and out
  const TURN_W = 1.8, TURN_ALPHA = 0.85, TURN_CASE_ALPHA = 0.55;
  const SPARK_W = 2.0;                   // the bright dashes along its paths
  const TURN_BB_W = 2.6, TURN_BB_ALPHA = 0.7, TURN_BB_CASE = 4.0, TURN_BB_CASE_ALPHA = 0.5;
  const RING_GAP = 5, RING_W = 2, RING_CASE_W = 4.5;
  const LABEL_PX = 12;

  // ── Pace ──
  const FRAME_MS = 1000 / 30;            // ~30 frames a second while moving
  const MAX_STEP_S = 0.1;                // a late frame moves the dashes no further than this
  const STILL_MS = 1000;                 // the still frame redrawn, and 3-D / the twin watched
  const BUBBLE_MS = 500;                 // who is under a cluster bubble, looked at again
  const PAD = 8;                         // px past the screen's edge a dash is still drawn
  const MAX_DASHES = 30000;              // a ceiling on one frame (MapArrows' reasoning)

  const FONT = `600 ${LABEL_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  // The words the legend and the Views section use, on hover where they are
  // used and in MapViews' "What the words in Views mean" fold (core.js's rule:
  // hover never reaches a finger). Each one says the numbers that decide it.
  const WORDS = {
    Flow: 'The radio paths are drawn faint and short dashes run along them the way the traffic goes: from each field '
      + `station into its repeater, and from a repeater on to the base. A dash every ${DASH_PERIOD} pixels, moving about `
      + `${FIELD_PX_S} pixels a second at normal speed; every path into one repeater delivers a dash to it at the same moment.`,
    'Everything flows': `Every path on the screen carries moving dashes at once. Backbone paths to a base carry longer, `
      + 'slower dashes in black; a path between two repeaters carries them both ways, because it works both ways.',
    'Take turns': `The repeaters on the screen light up one at a time, west to east, for ${TURN_S} seconds each at normal `
      + 'speed (shorter when Speed is up): its paths drawn in full with dashes running in, its backbone paths stronger, a '
      + 'ring round it and its name beside it. While a repeater is in focus the turn stays on it.',
    'Live readings': 'Nothing moves until a reading arrives. As each station\'s reading lands in the database (looked for '
      + 'every 15 seconds), a pulse runs from the station along its path to the base — the same animation as '
      + '⏱️ Latency\'s "messages flash on the map". The lines stay faint so the pulses show.',
    'Lines underneath': 'How strong the ordinary lines stay under the moving dashes, as a share of the Link opacity they '
      + 'would otherwise have: 35 % to start. At 0 % only the dashes show; backbone paths never go below half.',
    Speed: `How fast the dashes move and how long each repeater's turn lasts, from Calm (0.3 times) to Busy (2.5 times). `
      + `Normal is about ${FIELD_PX_S} pixels a second and ${TURN_S} seconds a turn.`,
    'Play and pause': 'Stops the dashes where they are, or sets them moving again. A device set to reduce motion starts '
      + 'with them standing still; pressing Play here overrides that on this device.',
  };

  const keep = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private browsing — this session only */ } };
  const owned = () => { try { return localStorage.getItem(LS_OWN) === '1'; } catch (_) { return false; } };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mod = (a, m) => ((a % m) + m) % m;
  const strokeScale = () => (typeof mapStrokeScale === 'function' ? mapStrokeScale() : 1);
  const has = (o, f) => !!o && typeof o[f] === 'function';

  const S = {
    map: null,
    h: null,               // the MapOverlay handle
    cfg: null,             // the settings as last read (sync)
    colours: null,         // tokens resolved once per sync: { line, backbone }
    raf: null,             // the pacing loop
    watch: null,           // the slow timer while still, or under 3-D / the twin
    lastPaint: 0,          // performance.now() of the last frame asked for
    prev: 0,               // …and the one before, for the clock
    clock: 0,              // seconds the flow has moved (stops while still)
    travel: 0,             // px a field dash has moved (Speed folded in, so a change does not jump)
    wasBlocked: false,
    geo: null,             // the projected lines (geometry())
    geoSeq: 0,
    hidAt: 0, hidGeo: -1, anyHid: false,
    turn: null,            // { id, t0, held, lx } whose turn it is
    turnList: null, turnKey: '',
    inLive: false,         // Live readings has been entered since attach
    ownLat: false,         // …and ⏱️ Latency's animation was switched on by it
    liveQueued: false,
    syncing: false,
    mq: null, onMq: null,
    last: { field: 0, backbone: 0, dashes: 0, ms: 0 },
    buckets: new Map(),
  };

  // ── What is chosen ─────────────────────────────────────────────────────────

  // The settings as MapViews holds them, with the map as it always was when
  // MapViews is missing (a page that loads this file alone): plain lines.
  function readCfg() {
    let s = null;
    try {
      if (typeof MapViews !== 'undefined' && has(MapViews, 'settings')) s = MapViews.settings();
    } catch (_) { s = null; }
    const f = (s && s.flow) || {};
    return {
      draw: s && DRAWS.includes(s.draw) ? s.draw : 'lines',
      mode: MODES.includes(f.mode) ? f.mode : 'all',
      speed: clamp(Number.isFinite(+f.speed) && +f.speed > 0 ? +f.speed : 1, 0.3, 2.5),
      playing: f.playing === true || f.playing === false ? f.playing : null,
    };
  }
  function cfg() { if (!S.cfg) S.cfg = readCfg(); return S.cfg; }

  // A device that asks for less motion (the same media query MapLatency's
  // calm() and map-3d.js read).
  function calm() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  // Moving or still: the person's choice, else the device's.
  function playing(c = cfg()) { return c.playing == null ? !calm() : !!c.playing; }

  // The 3-D view and the twin draw the network themselves and cover this one.
  function blocked() {
    return (typeof Map3D !== 'undefined' && has(Map3D, 'active') && !!Map3D.active())
        || (typeof MapTwin !== 'undefined' && has(MapTwin, 'active') && !!MapTwin.active());
  }

  // Drawn by this overlay now: Flow chosen, a mode with drawing of its own,
  // and the 2-D map in view.
  function active() {
    const c = cfg();
    return !!(S.map && S.h && c.draw === 'flow' && c.mode !== 'live' && !blocked());
  }

  function colours() {
    if (!S.colours) {
      const cv = (n, f) => (typeof cssVar === 'function' ? cssVar(n, f) : f);
      S.colours = { line: cv('--map-line', '#ff6f00'), backbone: cv('--map-backbone', '#000000') };
    }
    return S.colours;
  }

  // ── The lines, projected once per zoom ─────────────────────────────────────

  // Every field core and backbone core in state.mapLines, its points in layer
  // pixels (Leaflet's own rounding, so the dashes sit on the lines) and its
  // length along the way. Kept while the lines, the zoom and the pixel origin
  // are the same; a rebuild makes a new state.mapLines, a zoom a new origin.
  function geometry() {
    const m = S.map;
    const lines = typeof state !== 'undefined' ? state.mapLines : null;
    if (!m || !lines) return null;
    const z = m.getZoom(), po = m.getPixelOrigin();
    const g = S.geo;
    if (g && g.lines === lines && g.n === lines.length && g.z === z && g.px === po.x && g.py === po.y) return g;
    const field = [], back = [], fieldByRep = new Map(), backByRep = new Map();
    const push = (map, k, v) => { if (k == null) return; const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
    for (const l of lines) {
      const role = l.mnLinkRole;
      if (role !== 'core' && role !== 'backbone') continue;
      let lls = has(l, 'getLatLngs') ? l.getLatLngs() : null;
      if (lls && lls.length && Array.isArray(lls[0])) lls = lls[0];   // a multi-polyline: its first part
      if (!lls || lls.length < 2) continue;
      const n = lls.length;
      const pts = new Float64Array(n * 2), cum = new Float64Array(n);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, len = 0;
      for (let i = 0; i < n; i++) {
        const p = m.latLngToLayerPoint(lls[i]);
        pts[2 * i] = p.x; pts[2 * i + 1] = p.y;
        if (i) len += Math.hypot(p.x - pts[2 * i - 2], p.y - pts[2 * i - 1]);
        cum[i] = len;
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
      }
      const e = {
        l, pts, cum, len, minx, miny, maxx, maxy, hid: false,
        sid: l.mnLinkStationId, rid: l.mnLinkRepeaterId, rid2: l.mnLinkRepeaterId2,
        two: l.mnArrowDir === 'both',
      };
      if (role === 'core') { field.push(e); push(fieldByRep, e.rid, e); }
      else { back.push(e); push(backByRep, e.rid, e); push(backByRep, e.rid2, e); }
    }
    S.geo = { id: ++S.geoSeq, lines, n: lines.length, z, px: po.x, py: po.y, field, back, fieldByRep, backByRep };
    S.turnList = null;
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
      vx0: c[0], vy0: c[1], vx1: c[0] + s.x, vy1: c[1] + s.y,          // the screen itself
      x0: c[0] - PAD, y0: c[1] - PAD, x1: c[0] + s.x + PAD, y1: c[1] + s.y + PAD,   // and a little past it
      w: s.x, h: s.y,
    };
  }
  const offView = (e, V) => e.maxx - V.ox < V.x0 || e.minx - V.ox > V.x1 || e.maxy - V.oy < V.y0 || e.miny - V.oy > V.y1;

  // A path wholly under a cluster bubble: its station is in one and so is its
  // far end. Asked at most every BUBBLE_MS, and again after a re-projection —
  // the bubbles are under the pins' canvas's control, not this one's, and a
  // path drawn for half a second under a bubble is a path nobody sees.
  function markHidden(G, now) {
    if (S.hidGeo === G.id && now - S.hidAt < BUBBLE_MS) return;
    S.hidAt = now; S.hidGeo = G.id;
    const on = typeof MapCluster !== 'undefined' && has(MapCluster, 'bubbleOf')
      && (!has(MapCluster, 'active') || MapCluster.active());
    if (!on) {
      if (S.anyHid) { for (const e of G.field) e.hid = false; for (const e of G.back) e.hid = false; }
      S.anyHid = false;
      return;
    }
    const centres = new Map();
    const at = b => {
      let c = centres.get(b.key);
      if (!c) {
        const p = S.map.latLngToLayerPoint(b.latlng);
        const r = (b.radius || 0) + (MapCluster.EDGE_PX || 2.5);
        c = { x: p.x, y: p.y, r2: r * r };
        centres.set(b.key, c);
      }
      return c;
    };
    let any = false;
    for (const e of G.field) {
      const b = MapCluster.bubbleOf(e.sid);
      if (!b) { e.hid = false; continue; }
      const c = at(b), n = e.pts.length;
      const dx = e.pts[n - 2] - c.x, dy = e.pts[n - 1] - c.y;
      e.hid = dx * dx + dy * dy <= c.r2;
      any = any || e.hid;
    }
    for (const e of G.back) {
      const a = MapCluster.bubbleOf(e.rid), b = a ? MapCluster.bubbleOf(e.rid2) : null;
      e.hid = !!(a && b && a.key === b.key);
      any = any || e.hid;
    }
    S.anyHid = any;
  }

  // ── Dashes, by hand ────────────────────────────────────────────────────────

  // Liang–Barsky: the part of segment (ax, ay)→(bx, by) inside the rectangle,
  // as parameters ct0..ct1 along it; false when none of it is. Module-level
  // results, so the loop allocates nothing.
  let ct0 = 0, ct1 = 1;
  function edge(p, q) {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > ct1) return false; if (r > ct0) ct0 = r; }
    else { if (r < ct0) return false; if (r < ct1) ct1 = r; }
    return true;
  }
  function clip(ax, ay, bx, by, V) {
    ct0 = 0; ct1 = 1;
    const dx = bx - ax, dy = by - ay;
    return edge(-dx, ax - V.x0) && edge(dx, V.x1 - ax) && edge(-dy, ay - V.y0) && edge(dy, V.y1 - ay) && ct1 > ct0;
  }

  // The dashes of one path that are on the screen, into `path`: dashes `on` px
  // long starting at base + k × period along it (px from its first point).
  // Each segment's visible part gets its own pieces, so a dash across a bend
  // of a bundled curve is two pieces meeting at the bend — with round caps,
  // the same as a round join.
  function dashes(path, e, V, base, on, period) {
    const pts = e.pts, cum = e.cum, n = cum.length;
    let count = 0;
    for (let i = 0; i < n - 1; i++) {
      const seg = cum[i + 1] - cum[i];
      if (!(seg > 0)) continue;
      const ax = pts[2 * i] - V.ox, ay = pts[2 * i + 1] - V.oy;
      const bx = pts[2 * i + 2] - V.ox, by = pts[2 * i + 3] - V.oy;
      if (!clip(ax, ay, bx, by, V)) continue;
      const sa = cum[i] + ct0 * seg, sb = cum[i] + ct1 * seg;
      for (let d = base + Math.ceil((sa - on - base) / period) * period; d < sb; d += period) {
        const u0 = d > sa ? d : sa, u1 = d + on < sb ? d + on : sb;
        if (u1 <= u0) continue;
        const f0 = (u0 - cum[i]) / seg, f1 = (u1 - cum[i]) / seg;
        path.moveTo(ax + (bx - ax) * f0, ay + (by - ay) * f0);
        path.lineTo(ax + (bx - ax) * f1, ay + (by - ay) * f1);
        count++;
      }
    }
    return count;
  }
  // Where the pattern starts for a path running first point → last at
  // distance travelled d, measured from the path's end (see the header)…
  const fwdBase = (e, d, period) => mod(e.len + d, period);
  // …and for the train running the other way, last point → first, measured
  // from *its* end (the first point): the same lattice, mirrored.
  const backBase = (e, d, on, period) => mod(e.len - on - mod(e.len + d, period), period);

  // The whole path, solid, into `path`.
  function solid(path, e, V) {
    const pts = e.pts;
    path.moveTo(pts[0] - V.ox, pts[1] - V.oy);
    for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i] - V.ox, pts[i + 1] - V.oy);
  }

  // One Path2D per colour (and per dimmed or not), reused through a frame.
  function bucket(colour, dim) {
    const k = dim ? `${colour}\u0000d` : colour;
    let b = S.buckets.get(k);
    if (!b) { b = { colour, dim, path: new Path2D(), n: 0 }; S.buckets.set(k, b); }
    return b;
  }
  // Every bucket's casing first, then every bucket's colour: a casing never
  // lies over another path's dash.
  function strokeBuckets(ctx, core, casing, alpha, caseAlpha, colourOverride) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (casing > 0 && caseAlpha > 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = casing;
      for (const b of S.buckets.values()) {
        if (!b.n) continue;
        ctx.globalAlpha = caseAlpha * (b.dim ? DIM_ALPHA : 1);
        ctx.stroke(b.path);
      }
    }
    ctx.lineWidth = core;
    for (const b of S.buckets.values()) {
      if (!b.n) continue;
      ctx.globalAlpha = alpha * (b.dim ? DIM_ALPHA : 1);
      ctx.strokeStyle = colourOverride || b.colour;
      ctx.stroke(b.path);
    }
    S.buckets.clear();
  }

  // ── Everything flows ───────────────────────────────────────────────────────

  function drawAll(ctx, G, V) {
    const sc = strokeScale(), col = colours();
    const d = S.travel;
    let nField = 0, nBack = 0, nDash = 0;

    S.buckets.clear();
    for (const e of G.field) {
      if (e.hid || offView(e, V)) continue;
      const b = bucket((e.l.options && e.l.options.color) || col.line, !!e.l.mnFocusDimmed);
      const k = dashes(b.path, e, V, fwdBase(e, d, DASH_PERIOD), DASH_ON, DASH_PERIOD);
      if (k) { b.n += k; nField++; nDash += k; }
      if (nDash > MAX_DASHES) break;
    }
    strokeBuckets(ctx, FIELD_W * sc, (FIELD_W + CASE_EXTRA) * sc, FIELD_ALPHA, CASE_ALPHA);

    // The backbone over the field, as on the map: its own black, slower.
    const db = d * BB_SPEED;
    for (const e of G.back) {
      if (e.hid || offView(e, V)) continue;
      const b = bucket(col.backbone, !!e.l.mnFocusDimmed);
      let k;
      if (e.two) {
        k = dashes(b.path, e, V, fwdBase(e, db, BB2_PERIOD), BB2_ON, BB2_PERIOD)
          + dashes(b.path, e, V, backBase(e, db, BB2_ON, BB2_PERIOD), BB2_ON, BB2_PERIOD);
      } else {
        k = dashes(b.path, e, V, fwdBase(e, db, BB_PERIOD), BB_ON, BB_PERIOD);
      }
      if (k) { b.n += k; nBack++; nDash += k; }
      if (nDash > MAX_DASHES) break;
    }
    strokeBuckets(ctx, BB_W * sc, (BB_W + CASE_EXTRA) * sc, BB_ALPHA, CASE_ALPHA);
    S.last.field = nField; S.last.backbone = nBack; S.last.dashes = nDash;
  }

  // ── Repeaters take turns ───────────────────────────────────────────────────

  const turnSeconds = () => TURN_S / Math.max(TURN_MIN_SPEED, cfg().speed);

  // The repeaters on the screen with a field path drawn into them, west to
  // east, by where their paths end. Worked out again only when the screen or
  // the lines change.
  function turnList(G, V) {
    const key = `${G.id}|${Math.round(V.vx0)}|${Math.round(V.vy0)}|${V.w}|${V.h}`;
    if (S.turnList && S.turnKey === key) return S.turnList;
    const out = [];
    for (const [id, arr] of G.fieldByRep) {
      const pts = arr[0].pts, n = pts.length;
      const lx = pts[n - 2], ly = pts[n - 1];
      const x = lx - V.ox, y = ly - V.oy;
      if (x >= V.vx0 && x <= V.vx1 && y >= V.vy0 && y <= V.vy1) out.push({ id, lx });
    }
    out.sort((a, b) => a.lx - b.lx || String(a.id).localeCompare(String(b.id)));
    S.turnList = out; S.turnKey = key;
    return out;
  }

  // Whose turn it is now. Held on the focused repeater while there is one with
  // a path drawn; otherwise the next one east when a turn runs out (or wrapping
  // to the westernmost), or the first on the screen when the current one has
  // gone off it. Standing still, a turn never runs out.
  function advance(G, list, moving) {
    const T = S.clock;
    const focus = typeof state !== 'undefined' ? state.mapFocusRepeaterId : null;
    if (focus != null && (G.fieldByRep.has(focus) || G.backByRep.has(focus))) {
      if (!S.turn || S.turn.id !== focus) {
        S.turn = { id: focus, t0: moving ? T : T - FADE_S, held: true, lx: placeOf(G, focus).lx };
      } else S.turn.held = true;
      return;
    }
    const cur = S.turn;
    const listed = !!cur && !cur.held && list.some(r => r.id === cur.id);
    if (listed && (!moving || T - cur.t0 < turnSeconds())) return;
    if (!list.length) { S.turn = null; return; }
    // The next one east of the one whose turn it was — including a focused
    // repeater just let go, or one the map has moved off the screen.
    let next = list[0];
    if (cur) {
      const i = listed ? list.findIndex(r => r.id === cur.id) : -1;
      next = i >= 0 ? list[(i + 1) % list.length] : (list.find(r => r.lx > cur.lx) || list[0]);
    }
    // Standing still, a new turn is already faded in, so pressing Play does
    // not dip it to nothing first.
    S.turn = { id: next.id, t0: moving ? T : T - FADE_S, held: false, lx: next.lx };
  }

  // A repeater's place (layer px), its name, the colour its paths are drawn
  // in, and its paths: from its field lines' far ends, or from a backbone
  // path's end for a base, which has no field lines.
  function placeOf(G, id) {
    const f = G.fieldByRep.get(id) || [];
    const bk = G.backByRep.get(id) || [];
    let lx = NaN, ly = NaN, st = null;
    if (f.length) {
      const pts = f[0].pts, n = pts.length;
      lx = pts[n - 2]; ly = pts[n - 1];
      st = f[0].l.mnTip && f[0].l.mnTip.b;
    } else if (bk.length) {
      const e = bk[0], pts = e.pts, n = pts.length;
      const first = e.rid === id;
      lx = first ? pts[0] : pts[n - 2]; ly = first ? pts[1] : pts[n - 1];
      st = e.l.mnTip && (first ? e.l.mnTip.a : e.l.mnTip.b);
    }
    if (!st && typeof state !== 'undefined' && state.data && state.data.stations) {
      st = state.data.stations.find(s => s.id === id) || null;
    }
    const colour = (f.length && f[0].l.options && f[0].l.options.color) || (f.length ? colours().line : colours().backbone);
    return { lx, ly, name: (st && st.name) || String(id), colour, field: f, back: bk };
  }

  // The pin's radius, for the ring to clear it; once per turn.
  function pinRadius(id) {
    const ms = typeof state !== 'undefined' && state.mapMarkers;
    if (ms) for (const m of ms) if (m.mnStationId === id) return (m.options && m.options.radius) || 7;
    return 7;
  }

  function drawTurns(ctx, G, V, moving) {
    const list = turnList(G, V);
    advance(G, list, moving);
    const t = S.turn;
    S.last.field = 0; S.last.backbone = 0; S.last.dashes = 0;
    if (!t) return;
    const P = placeOf(G, t.id);
    if (!t.info || t.info.id !== t.id || t.info.n !== P.field.length) {
      t.info = { id: t.id, name: P.name, n: P.field.length, r: pinRadius(t.id) };
    }
    const e0 = S.clock - t.t0, dur = turnSeconds();
    const a = !moving ? 1 : t.held ? clamp(e0 / FADE_S, 0, 1)
      : clamp(Math.min(e0 / FADE_S, (dur - e0) / FADE_S), 0, 1);
    if (a <= 0.01) return;
    const sc = strokeScale(), col = colours();
    const d = S.travel;
    let nDash = 0;

    // Its field paths in full, in their own colours…
    S.buckets.clear();
    const shown = [];
    for (const e of P.field) {
      if (offView(e, V)) continue;
      const b = bucket((e.l.options && e.l.options.color) || col.line, !!e.l.mnFocusDimmed);
      solid(b.path, e, V); b.n++;
      shown.push(e);
    }
    strokeBuckets(ctx, TURN_W * sc, (TURN_W + CASE_EXTRA) * sc, TURN_ALPHA * a, TURN_CASE_ALPHA * a);
    // …with bright dashes running in along them.
    for (const e of shown) {
      const b = bucket('#ffffff', !!e.l.mnFocusDimmed);
      const k = dashes(b.path, e, V, fwdBase(e, d, DASH_PERIOD), DASH_ON, DASH_PERIOD);
      b.n += k; nDash += k;
    }
    strokeBuckets(ctx, SPARK_W * sc, 0, a, 0);

    // Its backbone paths stronger, their dashes the way they run.
    const bshown = [];
    for (const e of P.back) {
      if (offView(e, V)) continue;
      const b = bucket(col.backbone, !!e.l.mnFocusDimmed);
      solid(b.path, e, V); b.n++;
      bshown.push(e);
    }
    strokeBuckets(ctx, TURN_BB_W * sc, TURN_BB_CASE * sc, TURN_BB_ALPHA * a, TURN_BB_CASE_ALPHA * a);
    const db = d * BB_SPEED;
    for (const e of bshown) {
      const b = bucket('#ffffff', !!e.l.mnFocusDimmed);
      const k = e.two
        ? dashes(b.path, e, V, fwdBase(e, db, BB2_PERIOD), BB2_ON, BB2_PERIOD)
          + dashes(b.path, e, V, backBase(e, db, BB2_ON, BB2_PERIOD), BB2_ON, BB2_PERIOD)
        : dashes(b.path, e, V, fwdBase(e, db, BB_PERIOD), BB_ON, BB_PERIOD);
      b.n += k; nDash += k;
    }
    strokeBuckets(ctx, SPARK_W * sc, 0, a, 0);
    S.last.field = shown.length; S.last.backbone = bshown.length; S.last.dashes = nDash;

    // A ring round it and its name beside it.
    const x = P.lx - V.ox, y = P.ly - V.oy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const r = (t.info.r || 7) + RING_GAP;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.9 * a;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = RING_CASE_W * sc;
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.strokeStyle = P.colour;
    ctx.lineWidth = RING_W * sc;
    ctx.stroke();

    ctx.font = sc > 1 ? FONT.replace(`${LABEL_PX}px`, `${Math.round(LABEL_PX * 1.25)}px`) : FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.globalAlpha = 0.95 * a;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(t.info.name, x + r + 5, y);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#16202a';
    ctx.fillText(t.info.name, x + r + 5, y);
  }

  // ── The frame ──────────────────────────────────────────────────────────────

  // MapOverlay's draw: the canvas is cleared and scaled to CSS pixels already.
  function draw(ctx, h) {
    if (!S.map || !active()) { S.last.field = S.last.backbone = S.last.dashes = 0; return; }
    const t0 = performance.now();
    const G = geometry();
    if (!G || (!G.field.length && !G.back.length)) return;
    const V = view(h);
    markHidden(G, t0);
    if (cfg().mode === 'turns') drawTurns(ctx, G, V, playing());
    else drawAll(ctx, G, V);
    S.last.ms = Math.round((performance.now() - t0) * 100) / 100;
  }

  // ── Pace: moving, still, or nothing ────────────────────────────────────────

  // 'run' — a frame every FRAME_MS; 'still' — the one frame kept current, or
  // 3-D / the twin watched; 'off' — nothing of this module's on the map.
  function want() {
    const c = cfg();
    if (!S.map || !S.h || c.draw !== 'flow' || c.mode === 'live') return 'off';
    if (blocked()) return 'still';
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 'still';
    const lines = typeof state !== 'undefined' ? state.mapLines : null;
    if (!lines || !lines.length) return 'still';
    return playing(c) ? 'run' : 'still';
  }

  // When the 3-D view or the twin has just gone, the 2-D lines are put back
  // to their Flow strength (MapViews draws them full under 3-D) and the frame
  // drawn again.
  function noticeBlocked() {
    const b = blocked();
    if (b !== S.wasBlocked) {
      S.wasBlocked = b;
      if (!b) {
        try { if (typeof MapViews !== 'undefined' && has(MapViews, 'restyle')) MapViews.restyle(); } catch (_) { /* the frame still comes */ }
        if (S.h) S.h.schedule();
      }
    }
    return b;
  }

  function stopPacer() {
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
    S.prev = 0;
  }
  function stopWatch() {
    if (S.watch) { clearTimeout(S.watch); S.watch = null; }
  }

  // Start whichever is wanted, stop the other. Safe to call any time.
  function drive() {
    // Noted here as well as in the loops: a 3-D view that any call here saw
    // open is then seen to go, even if neither loop looked while it was up.
    if (S.map && cfg().draw === 'flow') noticeBlocked();
    const w = want();
    if (w === 'run') {
      stopWatch();
      if (!S.raf) S.raf = requestAnimationFrame(tick);
    } else {
      stopPacer();
      if (w === 'still') { if (!S.watch) S.watch = setTimeout(watchTick, STILL_MS); } else stopWatch();
    }
  }

  // The moving loop: every animation frame looks, about every FRAME_MS one is
  // asked for. The clock moves by the time since the last frame asked for,
  // never more than MAX_STEP_S, so a frame late from a busy main thread does
  // not throw the dashes forward.
  function tick(now) {
    S.raf = null;
    noticeBlocked();
    if (want() !== 'run') { drive(); if (S.h) S.h.schedule(); return; }
    if (now - S.lastPaint >= FRAME_MS - 2) {
      const dt = S.prev ? Math.min(MAX_STEP_S, Math.max(0, (now - S.prev) / 1000)) : 0;
      S.prev = now;
      S.lastPaint = now;
      S.clock += dt;
      S.travel += FIELD_PX_S * cfg().speed * dt;
      S.h.schedule();
    }
    S.raf = requestAnimationFrame(tick);
  }

  // The slow watch: standing still, the frame redrawn; under 3-D or the twin,
  // nothing drawn, and the moment they go noticed.
  function watchTick() {
    S.watch = null;
    const b = noticeBlocked();
    if (!b && S.h) S.h.schedule();
    drive();
  }

  function onVisible() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') stopPacer();
    S.prev = 0;
    drive();
  }

  // ── Live readings: ⏱️ Latency's animation ──────────────────────────────────

  function liveWanted() {
    const c = cfg();
    return !!S.map && c.draw === 'flow' && c.mode === 'live';
  }
  function queueLive() {
    if (S.liveQueued) return;
    S.liveQueued = true;
    Promise.resolve().then(() => {
      try { liveSync(); } catch (e) {
        S.liveQueued = false;
        if (typeof console !== 'undefined') console.error('MapFlow: Live readings could not switch ⏱️ Latency', e);
      }
    });
  }
  function liveSync() {
    S.liveQueued = false;
    if (typeof MapLatency === 'undefined' || !has(MapLatency, 'setAnim') || !has(MapLatency, 'anim')) return;
    if (!S.map) return;   // detached in between: leave it to the next attach
    const want = liveWanted();
    if (want && !S.inLive) {
      S.inLive = true;
      if (!MapLatency.anim()) {
        S.ownLat = true;
        keep(LS_OWN, '1');
        MapLatency.setAnim(true, { quiet: true });
      } else {
        // On already: the person's own, unless an earlier visit or session
        // of this module switched it on and never got to switch it off.
        S.ownLat = owned();
      }
    } else if (!want && (S.inLive || owned())) {
      const mine = S.ownLat || owned();
      S.inLive = false;
      S.ownLat = false;
      keep(LS_OWN, null);
      if (mine && MapLatency.anim()) MapLatency.setAnim(false, { quiet: true });
    }
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  // Read the settings again and start, stop or redraw to match. MapViews
  // calls this when any of the drawing settings change, after every build,
  // and when the card or the focus moves; the device's reduced-motion setting
  // changing calls it too. Cheap: nothing is projected here.
  function sync() {
    if (S.syncing) return;
    S.syncing = true;
    try {
      S.cfg = readCfg();
      S.colours = null;
      S.turnList = null;
      queueLive();
      if (!S.h) return;
      S.h.schedule();
      drive();
    } finally {
      S.syncing = false;
    }
  }

  // One frame, on the next animation frame — for a caller that repainted a
  // line and wants the dashes to follow while they stand still.
  function schedule() { if (S.h) S.h.schedule(); }

  // Whose turn it is, for the Views note: { repeaterId, name, n (its field
  // paths drawn), held (on the focused repeater) }, or null when the
  // repeaters are not taking turns or none on the screen has a path.
  function turn() {
    const c = cfg();
    if (!S.map || c.draw !== 'flow' || c.mode !== 'turns' || !S.turn) return null;
    const t = S.turn;
    const G = geometry();
    if (!G) return null;
    const info = t.info && t.info.id === t.id ? t.info : { name: placeOf(G, t.id).name };
    const n = (G.fieldByRep.get(t.id) || []).length;
    return { repeaterId: t.id, name: info.name, n, held: !!t.held };
  }

  // Rows for the Links section of the legend, in the legend's own markup, or
  // '' when the paths are not drawn as flow. The dashed swatches are classes
  // in styles.css (legend-line-flow, legend-line-flow-live).
  function legendHtml() {
    const c = cfg();
    if (c.draw !== 'flow') return '';
    if (typeof state !== 'undefined' && !state.mapShowLinks && !state.mapShowBackbone) return '';
    const term = (w, text) => (typeof termHtml === 'function' ? termHtml(text || w, WORDS[w]) : (text || w));
    const item = (swatch, html) => `<span class="legend-item">${swatch}<span class="small">${html}</span></span>`;
    const rows = [];
    if (c.mode === 'live') {
      rows.push(item('<span class="legend-line legend-line-flow-live"></span>',
        `${term('Live readings')} — a pulse runs along a station's path to the base as its reading lands`));
      return rows.join('');
    }
    if (c.mode === 'turns') {
      const secs = Math.round(turnSeconds() * 10) / 10;
      rows.push(item('<span class="legend-line legend-line-flow"></span>',
        `${term('Take turns', 'Repeaters take turns')} — one at a time, west to east, ${secs} s each: its paths in full with dashes running in, a ring round it`));
    } else {
      rows.push(item('<span class="legend-line legend-line-flow"></span>',
        `${term('Flow', 'Moving dashes')} run the way the traffic does — into each repeater, and on to the base`));
    }
    if (!playing(c)) {
      rows.push(`<span class="legend-item"><span class="small txt-muted">Standing still${c.playing == null && calm()
        ? ', because this device asks for less motion' : ''} — ${term('Play and pause', 'Play')} in Views sets them moving.</span></span>`);
    }
    return rows.join('');
  }

  // ── attach / detach ────────────────────────────────────────────────────────

  function attach(map) {
    if (!map) return;
    if (S.map === map && S.h) { sync(); return; }
    detach();
    if (typeof MapOverlay === 'undefined') return;
    S.map = map;
    S.cfg = readCfg();
    S.wasBlocked = blocked();
    // Never animating as far as MapOverlay is concerned: this module paces
    // its own frames (see the header) and asks for them one at a time.
    S.h = MapOverlay.create(map, { pane: PANE, z: PANE_Z, className: 'mn-flow-canvas', draw, animating: () => false });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    try {
      if (window.matchMedia) {
        S.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        S.onMq = () => sync();
        if (has(S.mq, 'addEventListener')) S.mq.addEventListener('change', S.onMq);
        else if (has(S.mq, 'addListener')) S.mq.addListener(S.onMq);
      }
    } catch (_) { S.mq = null; S.onMq = null; }
    sync();
  }

  // Off the map. ⏱️ Latency's animation is left as it is (see the header):
  // the ownership stays remembered under LS_OWN for the next attach.
  function detach() {
    stopPacer();
    stopWatch();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (S.mq && S.onMq) {
      try {
        if (has(S.mq, 'removeEventListener')) S.mq.removeEventListener('change', S.onMq);
        else if (has(S.mq, 'removeListener')) S.mq.removeListener(S.onMq);
      } catch (_) { /* gone with the page */ }
    }
    if (S.h) S.h.destroy();
    S.map = null; S.h = null; S.mq = null; S.onMq = null;
    S.cfg = null; S.colours = null; S.geo = null; S.turn = null; S.turnList = null; S.turnKey = '';
    S.inLive = false; S.ownLat = false;
    S.hidAt = 0; S.hidGeo = -1; S.anyHid = false;
    S.buckets.clear();
    // The clock and the distance travelled stay: back on the tab, the dashes
    // carry on from where they were rather than starting again at the ends.
  }

  // For the checks: what is chosen and what the last frame drew.
  function _state() {
    const c = cfg();
    return {
      attached: !!S.map,
      draw: c.draw, mode: c.mode, speed: c.speed, playingSetting: c.playing,
      playing: playing(c),
      active: active(),
      pace: S.raf ? 'run' : S.watch ? 'still' : 'off',
      inLive: S.inLive, ownLatency: S.ownLat, ownStored: owned(),
      clock: S.clock, travel: S.travel,
      turn: turn(),
      turnList: S.turnList ? S.turnList.map(r => r.id) : null,
      lines: S.geo ? { field: S.geo.field.length, backbone: S.geo.back.length } : null,
      last: Object.assign({}, S.last),
      frameMs: FRAME_MS,
    };
  }

  return {
    attach, detach, sync, schedule, turn, legendHtml, WORDS, _state,
    playing: () => playing(), active,
  };
})();
if (typeof window !== 'undefined') window.MapFlow = MapFlow;
