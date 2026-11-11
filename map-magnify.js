// MegaNet — map-magnify.js
//
//   MapMagnify  the Stations map's magnifier: a round glass that follows the
//               mouse (or is dragged by a finger) and shows the ground under
//               it closer up — the base maps, with each station's pin shrunk
//               to a dot, its name, where the map names it, barely there,
//               the ground's own layers the map is drawing (property lines,
//               road reserves, rivers, survey marks — "The ground's own
//               layers", below), and every other line, shape and overlay
//               this app draws left out.
//
// After core.js and map-controls.js, before init.js — index.html holds the
// order and the reasons. Reaches back to core.js for announce, removeMap,
// registerLiveMap and registerTabTeardown, to map-controls.js for
// makeBaseLayers and makeStateImagery, and across to map-mode.js, map-3d.js and
// map-twin.js only to ask whether they are up — all from inside its own
// functions; the IIFE body only defines. app.js builds its button
// (stationsMapPanels, Tools in the side panel's rail), attaches it in initMap()
// and detaches it in stopStationsMap().
//
// ── Why ──────────────────────────────────────────────────────────────────────
// A pin, its name and the lines out of it sit exactly on the thing somebody is
// trying to see on the imagery: the mast, the hut, the track in, the creek
// crossing. Getting them out of the way meant unticking layers one by one in
// Layers and ticking them back afterwards. The glass is the quick way: switch
// it on, point, and what is under all of it is there, larger.
//
// At first the pins went too, and that lost where the station is: the point
// of looking is the mast or the hut *at* the pin. So the pins came back, asked
// for as "keep the pin, but really small" and the name "barely visible": a
// dot two-fifths of the pin's size in the pin's own colour and ring, and the
// name the map gives it at a fifth of its strength, under the dot. Lines,
// shapes and overlays stay out — they were never what was in the way of one
// station.
//
// ── How it shows the ground and the pins, and nothing else ───────────────────
// The glass is a second, small Leaflet map holding only fresh copies of the
// base maps the main map has on — the same blend, opacities and stacking order
// (map.mnBases, map-controls.js) — and, with Satellite, the State imagery that
// rides along with it. The only other thing ever added to it is the picture of
// a ground layer the map itself is showing (syncGround), so there is nothing to
// hide and nothing a new layer could forget to hide. Esri's place and road
// names over Satellite, Dark and Light are left out as well: they are writing
// over the ground too.
//
// The dots and the faint names are not in that map: they are painted on a
// canvas of their own over it, the glass's size, every time the glass moves
// (drawPins), off the main map's own pins (state.mapMarkers) — where each one
// is, its fill, its ring, its shape, whether a filter has dimmed it, and
// whether the map is naming it just now. Read rather than copied, so a
// restyle, a filter or a label switched on is in the glass at its next move,
// with nothing to keep in step. A pin in one of the map's bubbles (map-
// cluster.js) is still its own dot in the glass, which is closer than the
// map: the bubble is how the map shows a crowd at its own distance.
//
// Its zoom is the main map's plus log2 of the power, and its layers are let go
// to 22, past the main map's 19, stretching each host's own closest tiles. So
// even at the main map's closest the glass is still enlarging, and the State
// imagery shows at its own z20 where it has been flown.
//
// ── Why the glass's map is larger than the glass ─────────────────────────────
// Leaflet moves a map without dropping its tiles only when the move is smaller
// than the map; a larger move resets the view, and every tile is thrown away
// and drawn again — a flash in the glass on every quick flick of the mouse. The
// map inside the glass is twice the glass each way, centred, so a move of up to
// two glasses is a pan, and the tiles round the circle are already there when
// the mouse arrives.
//
// ── Mouse, finger, keyboard ──────────────────────────────────────────────────
// With a mouse the glass follows the pointer and takes no clicks: a click goes
// through it to whatever is underneath, as if it were not there. The pointer
// itself is hidden over the map, the glass's fine cross standing in for it.
// Shift + scroll changes the power — 2×, 4×, 8×, 16× — and is remembered on
// this device (`mn-magnify`). A touch screen has no hover, so there the glass
// is a thing to drag: a finger on it moves it, a tap on it steps the power, and
// everywhere else the map pans and opens pins as it always does. Switched on,
// the glass starts in the middle of the map, which is also what a keyboard has:
// the arrow keys pan the map under a glass that stays where it is. A click or
// a tap on the map moves the glass there. Escape puts it away — unless a mode
// on the map (map-mode.js) is the thing waiting for it, or focus is in a card
// with an Escape of its own.
//
// It is not a mode in map-mode.js's sense: it changes what is drawn, not what a
// click does, so it has no banner. Its switch in the rail says it is on.
//
// ── Where it stands ──────────────────────────────────────────────────────────
// Inside the map's container, so the map's own edge clips it. z 685 (styles.
// css): over the map pane (400 in the stage's stacking context, every pane
// inside it) and the minimap (680); under the station card (690), Leaflet's
// corners (1000) and the ACMA card (1100), so ↺ and the zoom buttons stay on
// top of it. Not in the 3-D view, a digital twin or a drive being followed:
// those draw over the panes it copies, or hide them.
const MapMagnify = (function () {
  const STORE = 'mn-magnify';
  const POWERS = [2, 4, 8, 16];
  const MAX_ZOOM = 22;
  const HINT_MS = 4500;
  const PIN_SCALE = 0.4;    // a pin in the glass, against its size on the map
  const PIN_MIN_R = 1.6;    // …but never smaller than this, in px
  const NAME_ALPHA = 0.2;   // a name in the glass: barely there
  const NAME_GAP = 3;       // px from the dot's edge down to its name

  // The layers that are the ground's own, by the pane each module draws in:
  // what the land is and whose — never what the network does over it.
  const GROUND = new Set(['mnCouncils', 'mnCatchments', 'mnCatchLine', 'mnContours', 'mnLots', 'mnRoads',
    'mnRoadOwners', 'mnRivers', 'mnRiverLines', 'mnSurvey', 'mnBridges', 'mnSiteFeat']);
  const SHARP_MS = 220;     // the glass rests this long before a picture is asked for at its scale
  const SHARP_FAIL_MS = 30000;
  const SHARP_MAX_PX = 1024;
  const MARKS_MAX = 150;    // survey marks, bridges and the like copied into the glass
  const VERTS_MAX = 80000;  // the points of the lines painted in one frame
  const STYLE_MS = 500;     // how long a line's look, read off the page, is kept

  let map = null;           // the Stations map
  let on = false;           // survives a rebuild of the map, not leaving the tab
  let power = 4;
  let powerRead = false;
  let glass = null;         // the glass, in the map's container
  let lens = null;          // the map inside it
  let badge = null;
  let pinsCv = null;        // the canvas the dots and the names are painted on
  let painted = { pins: 0, names: 0, r: 0, alpha: 0, paths: 0 };   // the last paint, for checks
  let marksEl = null;       // where the copied survey marks, bridges and labels stand
  let ground = null;        // { images, paths, marks } off the main map; null when it must be read again
  const mirrors = new Map();   // pane → the glass's copy of that pane's picture
  const marks = new Map();     // a marker on the map → its copy in the glass
  let styles = new WeakMap();  // a line → { at, look }
  let sharpTimer = 0;
  let layers = null;        // { base name: [its layers] }, the glass's own copies
  let at = null;            // the glass's centre, in the map container's px
  let raf = 0;
  let shownBefore = false;  // whether the glass was on screen at the last update
  let hintUntil = 0;
  let hintTimer = 0;
  let wheelAt = 0;
  let wheelHost = null;
  let drag = null;          // a finger on the glass
  let keyOn = false;

  const touchOnly = () => window.matchMedia('(hover: none)').matches;

  function readPower() {
    if (powerRead) return;
    powerRead = true;
    try {
      const v = Number(localStorage.getItem(STORE));
      if (POWERS.includes(v)) power = v;
    } catch (_) { /* private browsing: 4× */ }
  }
  function savePower() {
    try { localStorage.setItem(STORE, String(power)); } catch (_) { /* this visit only */ }
  }

  // The modes that draw over the panes the glass copies, or hide them.
  function covered() {
    if (typeof Map3D !== 'undefined' && Map3D.active()) return true;
    if (typeof MapTwin !== 'undefined' && MapTwin.active()) return true;
    return !!(map && map.getContainer().closest('.is-driving'));
  }
  const showing = () => on && !!map && !covered();

  // The glass's zoom, and the power that makes it: less than was asked for
  // when the main map is already so close that the asked-for one would be
  // past the glass's 22.
  const zoom = () => Math.min(MAX_ZOOM, map.getZoom() + Math.log2(power));
  const shownPower = () => Math.round(2 ** (zoom() - map.getZoom()));

  // The point under the glass's centre, kept on the map. Measured off the
  // container itself rather than Leaflet's getSize(), which is the size at the
  // last invalidateSize() and can be a beat behind a map that has just been
  // given its height (app.js, syncStationsSplitHeight).
  function clampAt() {
    const box = map.getContainer();
    const w = box.clientWidth, h = box.clientHeight;
    if (!at) at = L.point(w / 2, h / 2);
    at = L.point(Math.max(0, Math.min(w, at.x)), Math.max(0, Math.min(h, at.y)));
  }

  // ── The glass's own base maps ──────────────────────────────────────────────
  // Fresh layers, as every map in this app has (makeBaseLayers), let go past
  // the main map's zoom limit: a layer's maxNativeZoom is the closest tiles its
  // host serves, and everything past it up to maxZoom is those tiles stretched.
  function makeLayers() {
    const out = {};
    for (const [name, l] of Object.entries(makeBaseLayers())) {
      const o = l.options;
      if (o.maxNativeZoom == null) o.maxNativeZoom = o.maxZoom;
      o.maxZoom = MAX_ZOOM;
      out[name] = [l, ...(name === 'Satellite' ? makeStateImagery({ maxZoom: MAX_ZOOM }) : [])];
    }
    return out;
  }

  // The main map's blend, copied: what is on, how strongly, in what order.
  // Asked again whenever the glass may have fallen behind it — when it comes
  // on, when the pointer comes back onto the map from the side panel where
  // the blend is set, when a finger takes hold of it, and when the main map
  // says its base has changed.
  function syncBases() {
    if (!lens || !layers || !map || !map.mnBases) return;
    const mix = map.mnBases.mix();
    map.mnBases.order().forEach((name, i) => {
      const set = layers[name];
      const m = mix[name];
      if (!set || !m) return;
      const show = m.on && m.op > 0;
      for (const l of set) {
        if (!show) { if (lens.hasLayer(l)) lens.removeLayer(l); continue; }
        l.setOpacity(m.op);
        l.setZIndex(i + 1);
        if (!lens.hasLayer(l)) l.addTo(lens);
      }
    });
  }

  // ── Building and putting away ──────────────────────────────────────────────
  function build() {
    if (glass || !map) return;
    glass = L.DomUtil.create('div', 'mn-magnify', map.getContainer());
    glass.setAttribute('aria-hidden', 'true');
    glass.innerHTML = '<div class="mn-magnify-lens"><div class="mn-magnify-map"></div>'
      + '<div class="mn-magnify-marks"></div><canvas class="mn-magnify-pins"></canvas></div>'
      + '<span class="mn-magnify-aim"></span><span class="mn-magnify-power"></span>';
    badge = glass.querySelector('.mn-magnify-power');
    pinsCv = glass.querySelector('.mn-magnify-pins');
    marksEl = glass.querySelector('.mn-magnify-marks');
    // Nothing done to the glass reaches the map under it — on a touch screen,
    // where the glass takes the pointer (styles.css), a finger dragging it
    // must not pan the map too, and a tap on it must not open the pin beneath.
    L.DomEvent.disableClickPropagation(glass);
    L.DomEvent.disableScrollPropagation(glass);
    glass.addEventListener('pointerdown', onGlassDown);
    glass.addEventListener('pointermove', onGlassMove);
    glass.addEventListener('pointerup', onGlassUp);
    glass.addEventListener('pointercancel', onGlassUp);
    clampAt();
    place();
    lens = L.map(glass.querySelector('.mn-magnify-map'), {
      zoomControl: false, attributionControl: false,
      dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, inertia: false,
      zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
      zoomSnap: 0, minZoom: 0, maxZoom: MAX_ZOOM,
    });
    // A view before any layer, for initMap()'s reason (app.js).
    lens.setView(map.containerPointToLatLng(at), zoom(), { animate: false });
    layers = makeLayers();
    syncBases();
    shownBefore = true;
  }

  function drop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    clearTimeout(hintTimer);
    hintTimer = 0;
    clearTimeout(sharpTimer);
    sharpTimer = 0;
    for (const m of mirrors.values()) m.seq++;
    mirrors.clear();
    marks.clear();
    ground = null;
    styles = new WeakMap();
    lens = removeMap(lens);
    layers = null;
    if (glass) glass.remove();
    glass = badge = pinsCv = marksEl = null;
    painted = { pins: 0, names: 0, r: 0, alpha: 0, paths: 0 };
    drag = null;
    shownBefore = false;
    if (map) map.getContainer().classList.remove('mn-magnifying');
  }

  function place() {
    if (glass && at) glass.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }

  // ── Keeping it where the pointer is ────────────────────────────────────────
  // At most once a frame, however many pointer moves and map moves asked.
  function schedule() {
    if (!raf) raf = requestAnimationFrame(update);
  }

  function update() {
    raf = 0;
    if (!map) return;
    const show = showing();
    // The pointer hidden over the map while the glass is following it: the
    // glass's cross is where it is. Not on a touch screen, which has none.
    map.getContainer().classList.toggle('mn-magnifying', show && !touchOnly());
    if (!show) {
      if (glass) glass.hidden = true;
      shownBefore = false;
      return;
    }
    if (!glass) build();
    clampAt();
    place();
    if (!shownBefore) {
      // Back from hidden: the size Leaflet holds for it may be one it measured
      // while it was not on screen, which is nothing at all.
      glass.hidden = false;
      lens.invalidateSize({ animate: false, pan: false });
      syncBases();
      shownBefore = true;
    }
    lens.setView(map.containerPointToLatLng(at), zoom(), { animate: false });
    syncGround();
    drawPins();
    const p = `${shownPower()}×`;
    badge.textContent = performance.now() < hintUntil
      ? `${p} · ${touchOnly() ? 'tap the glass to change' : 'Shift + scroll to change'}`
      : p;
  }

  // ── The ground's own layers ────────────────────────────────────────────────
  // Asked for in these words (11 Nov 2026): "please add the layers inside the
  // magnifier (eg property boundaries". The glass first left out everything
  // this app draws; but a lot line, a road reserve, a river or a survey mark
  // is not in the way of the ground — it is what somebody looking at a site
  // closer up wants to read against it. So whatever the map is drawing in a
  // GROUND pane is in the glass too, and nothing else: the radio paths, the
  // links, the coverage and the rest stay out, as before.
  //
  // Read off the map rather than switched on here, as the pins are: a layer
  // the map is not drawing — switched off, or too far out for its scale gate
  // — is not in the glass, and a new ground layer needs only its pane's name
  // in GROUND. Three kinds, each its own way:
  //
  //   pictures  (the lots, easements and tenure, the road owners, the
  //             contours — one image from the State's map server). The map's
  //             own picture is put in the glass at once, stretched, so the
  //             lines are there while the glass moves; and when the glass has
  //             rested SHARP_MS the same request is made for the glass's own
  //             box at its own scale, which is the picture with fine lines
  //             and, close enough, the lot numbers. One request a rest a
  //             picture, none while the sharp one still covers the glass.
  //   lines     (road reserves, rivers, council areas, catchments, the site
  //             features' fences and tracks) painted on the pins' canvas,
  //             under the names and the dots, each with the look it has on
  //             the map at the width it has there.
  //   marks     (survey marks, bridges, a site feature's point, a council's
  //             name) — a copy of the marker's own icon, moved as the glass
  //             moves.
  const isGround = l => !!(l && l.options && (GROUND.has(l.options.pane) || l.options.mnGround));
  function onLayerChange(e) {
    if (!on || !isGround(e.layer)) return;
    ground = null;
    schedule();
  }

  function readGround() {
    const g = { images: [], paths: [], marks: [] };
    const zOf = name => { const p = map.getPane(name); return p ? Number(p.style.zIndex) || 0 : 0; };
    map.eachLayer(l => {
      if (!isGround(l)) return;
      if (l instanceof L.ImageOverlay) g.images.push(l);
      else if (l instanceof L.Polyline) g.paths.push({ l, z: zOf(l.options.pane) });
      else if (l instanceof L.Marker) g.marks.push(l);
    });
    g.paths.sort((a, b) => a.z - b.z);
    return g;
  }

  function lensPane(name) {
    if (!lens.getPane(name)) {
      const p = lens.createPane(name), from = map.getPane(name);
      p.style.zIndex = (from && from.style.zIndex) || 300;
      p.style.pointerEvents = 'none';
    }
    return name;
  }

  // The part of the glass's map the circle shows.
  function glassBounds() {
    const d = glass.clientWidth, off = (lens.getContainer().clientWidth - d) / 2;
    return L.latLngBounds(lens.containerPointToLatLng([off, off + d]), lens.containerPointToLatLng([off + d, off]));
  }

  function dropMirror(pane) {
    const m = mirrors.get(pane);
    if (!m) return;
    m.seq++;
    if (m.soft) m.soft.remove();
    if (m.sharp) m.sharp.remove();
    mirrors.delete(pane);
  }

  function syncGround() {
    if (!lens || !map) return;
    if (!ground) ground = readGround();
    const seen = new Set();
    for (const src of ground.images) {
      const pane = src.options.pane;
      seen.add(pane);
      let m = mirrors.get(pane);
      if (m && m.url !== src._url) { dropMirror(pane); m = null; }
      if (!m) {
        m = { url: src._url, op: src.options.opacity == null ? 1 : src.options.opacity, seq: 0, failedAt: 0,
              soft: L.imageOverlay(src._url, src.getBounds(), { pane: lensPane(pane), interactive: false }).addTo(lens),
              sharp: null, sharpBounds: null, sharpZoom: null };
        mirrors.set(pane, m);
      }
    }
    for (const pane of [...mirrors.keys()]) if (!seen.has(pane)) dropMirror(pane);
    let wanting = false;
    if (mirrors.size) {
      const gb = glassBounds(), z = lens.getZoom();
      for (const m of mirrors.values()) {
        if (m.sharp && m.sharpZoom !== z) { m.sharp.remove(); m.sharp = null; }
        const covered = !!m.sharp && m.sharpBounds.contains(gb);
        m.soft.setOpacity(covered ? 0 : m.op);
        if (!covered) wanting = true;
      }
    }
    clearTimeout(sharpTimer);
    sharpTimer = wanting ? setTimeout(sharpen, SHARP_MS) : 0;
    syncMarks();
  }

  // The map's own request, made again for the glass's box at the glass's
  // scale. Only a map server's export is known how to ask again: its address
  // carries the box and the size, and everything else in it is the picture.
  function sharpUrl(src, bounds, w, h) {
    let u;
    try { u = new URL(src); } catch (_) { return null; }
    const q = u.searchParams;
    if (!/\/export$/.test(u.pathname) || !q.has('bbox') || !q.has('size') || q.get('bboxSR') !== '3857') return null;
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest()), ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    q.set('bbox', `${sw.x},${sw.y},${ne.x},${ne.y}`);
    q.set('size', `${w},${h}`);
    return u.toString();
  }

  function sharpen() {
    sharpTimer = 0;
    if (!lens || !glass || glass.hidden || !mirrors.size) return;
    const bounds = lens.getBounds(), z = lens.getZoom(), gb = glassBounds();
    const box = lens.getContainer();
    let w = box.clientWidth, h = box.clientHeight;
    const over = Math.max(w, h) / SHARP_MAX_PX;
    if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }
    if (!w || !h) return;
    for (const [pane, m] of mirrors) {
      if (m.sharp && m.sharpZoom === z && m.sharpBounds.contains(gb)) continue;
      if (Date.now() - m.failedAt < SHARP_FAIL_MS) continue;
      const url = sharpUrl(m.url, bounds, w, h);
      if (!url) continue;
      const mine = ++m.seq;
      const img = new Image();
      img.onload = () => {
        if (mine !== m.seq || !lens || mirrors.get(pane) !== m) return;
        if (m.sharp) m.sharp.remove();
        m.sharp = L.imageOverlay(url, bounds, { pane: lensPane(pane), opacity: m.op, interactive: false }).addTo(lens);
        m.sharpBounds = bounds;
        m.sharpZoom = z;
        schedule();
      };
      img.onerror = () => { if (mine === m.seq) m.failedAt = Date.now(); };
      img.src = url;
    }
  }

  // The marks: a copy of each marker's own icon, placed where the glass's map
  // puts its point. The copy keeps the icon's size and anchor (they are in
  // its style) and its classes, so it looks as it does on the map.
  function syncMarks() {
    if (!marksEl) return;
    const list = (ground && ground.marks) || [];
    const keep = new Set();
    if (list.length) {
      const d = glass.clientWidth, off = (lens.getContainer().clientWidth - d) / 2, pad = 60;
      const box = L.latLngBounds(lens.containerPointToLatLng([off - pad, off + d + pad]),
                                 lens.containerPointToLatLng([off + d + pad, off - pad]));
      for (const mk of list) {
        if (keep.size >= MARKS_MAX) break;
        const icon = mk._icon;
        if (!icon || !mk._map || icon.style.display === 'none') continue;
        const ll = mk.getLatLng();
        if (!box.contains(ll)) continue;
        let c = marks.get(mk);
        if (!c || c.src !== icon || c.cls !== icon.className) {
          if (c) c.el.remove();
          const el = icon.cloneNode(true);
          el.removeAttribute('id');
          el.removeAttribute('tabindex');
          el.removeAttribute('title');
          el.classList.remove('leaflet-interactive');
          el.style.zIndex = '';
          for (const n of el.querySelectorAll('[id]')) n.removeAttribute('id');
          marksEl.appendChild(el);
          c = { el, src: icon, cls: icon.className };
          marks.set(mk, c);
        }
        const p = lens.latLngToContainerPoint(ll);
        c.el.style.transform = `translate3d(${Math.round(p.x - off)}px, ${Math.round(p.y - off)}px, 0)`;
        keep.add(mk);
      }
    }
    for (const [mk, c] of marks) if (!keep.has(mk)) { c.el.remove(); marks.delete(mk); }
  }

  // A line's look: read off the page where the map draws it as a shape of its
  // own (so a style sheet's say, a hover and a theme are all in it), off the
  // line's own settings where it is on a shared canvas.
  function lookOf(l) {
    const now = performance.now();
    const had = styles.get(l);
    if (had && now - had.at < STYLE_MS) return had.look;
    const o = l.options, el = l._path;
    let look;
    const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
    const dashOf = v => (!v || v === 'none' ? null
      : String(v).split(/[\s,]+/).map(parseFloat).filter(n => isFinite(n) && n >= 0));
    if (el && typeof SVGElement !== 'undefined' && el instanceof SVGElement) {
      const cs = getComputedStyle(el);
      const all = num(cs.opacity, 1);
      look = cs.display === 'none' || cs.visibility === 'hidden' ? null : {
        stroke: cs.stroke && cs.stroke !== 'none' ? cs.stroke : null,
        width: num(cs.strokeWidth, 1), sOp: num(cs.strokeOpacity, 1) * all, dash: dashOf(cs.strokeDasharray),
        cap: cs.strokeLinecap || 'round', join: cs.strokeLinejoin || 'round',
        fill: cs.fill && cs.fill !== 'none' ? cs.fill : null, fOp: num(cs.fillOpacity, 1) * all,
        rule: cs.fillRule === 'nonzero' ? 'nonzero' : 'evenodd',
      };
    } else {
      look = {
        stroke: o.stroke === false ? null : (o.color || '#3388ff'),
        width: num(o.weight, 3), sOp: num(o.opacity, 1), dash: dashOf(o.dashArray),
        cap: o.lineCap || 'round', join: o.lineJoin || 'round',
        fill: o.fill ? (o.fillColor || o.color || '#3388ff') : null, fOp: num(o.fillOpacity, .2),
        rule: o.fillRule === 'nonzero' ? 'nonzero' : 'evenodd',
      };
    }
    if (look && look.dash && !look.dash.some(n => n > 0)) look.dash = null;
    styles.set(l, { at: now, look });
    return look;
  }

  // The lines, on the pins' canvas before the names and the dots. The glass's
  // map is plain web mercator, so a point is placed by that arithmetic here
  // rather than through Leaflet, which makes three objects a point: a river
  // system in view is tens of thousands of them, every frame the glass moves.
  function drawGround(ctx, d) {
    const list = (ground && ground.paths) || [];
    if (!list.length) return;
    const z = lens.getZoom(), scale = 256 * Math.pow(2, z);
    const c = lens.project(lens.getCenter(), z);
    const ox = d / 2 - c.x, oy = d / 2 - c.y;
    const R = Math.PI / 180, MAX_LAT = 85.0511287798;
    const gb = glassBounds().pad(0.15);
    let budget = VERTS_MAX;
    const trace = (pts, close) => {
      let lx = NaN, ly = NaN, n = 0;
      for (const ll of pts) {
        const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, ll.lat));
        const sin = Math.sin(lat * R);
        const x = scale * (ll.lng / 360 + 0.5) + ox;
        const y = scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) + oy;
        if (n && Math.abs(x - lx) < .5 && Math.abs(y - ly) < .5) continue;
        if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        lx = x; ly = y; n++;
      }
      budget -= pts.length;
      if (close && n) ctx.closePath();
    };
    const walk = (a, close) => {
      if (!a || !a.length || budget <= 0) return;
      if (Array.isArray(a[0])) { for (const b of a) walk(b, close); return; }
      trace(a, close);
    };
    for (const { l } of list) {
      if (budget <= 0) break;
      if (!l._map || !l._bounds || !l._bounds.isValid() || !l._bounds.intersects(gb)) continue;
      const look = lookOf(l);
      if (!look || (!look.stroke && !look.fill)) continue;
      const poly = l instanceof L.Polygon;
      ctx.beginPath();
      walk(l._latlngs, poly);
      if (poly && look.fill && look.fOp > 0) {
        ctx.globalAlpha = look.fOp;
        ctx.fillStyle = look.fill;
        ctx.fill(look.rule);
      }
      if (look.stroke && look.width > 0 && look.sOp > 0) {
        ctx.globalAlpha = look.sOp;
        ctx.strokeStyle = look.stroke;
        ctx.lineWidth = look.width;
        ctx.lineCap = look.cap;
        ctx.lineJoin = look.join;
        ctx.setLineDash(look.dash || []);
        ctx.stroke();
      }
      painted.paths++;
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }

  // ── The pins, small, and their names, faint ────────────────────────────────
  // Painted fresh on every update, names first and the dots over them, so a
  // name never lies across a dot. A point in the glass is its map's point less
  // the half-glass its map stands out past the glass on every side. Only the
  // pins inside the glass's square, and a name's width round it, are looked
  // at: a bounds test is cheap, and ~4,900 projections a frame would not be.
  function drawPins() {
    if (!pinsCv || !lens || !glass) return;
    const d = glass.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.round(d * dpr));
    if (pinsCv.width !== px || pinsCv.height !== px) { pinsCv.width = px; pinsCv.height = px; }
    const ctx = pinsCv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    painted = { pins: 0, names: 0, r: 0, alpha: NAME_ALPHA, paths: 0 };
    if (!d) return;
    drawGround(ctx, d);
    const markers = (typeof state !== 'undefined' && state.mapMarkers) || [];
    if (!markers.length) return;

    const off = (lens.getContainer().clientWidth - d) / 2;
    const pad = 120;   // a name hanging into the glass from a pin just outside it
    const box = L.latLngBounds(
      lens.containerPointToLatLng([off - pad, off + d + pad]),
      lens.containerPointToLatLng([off + d + pad, off - pad]));
    const shown = [];
    for (const m of markers) {
      if (!m._map || !m.mnStation) continue;
      const ll = m.getLatLng();
      if (!box.contains(ll)) continue;
      const p = lens.latLngToContainerPoint(ll);
      const o = m.options;
      const r = Math.max(PIN_MIN_R, (m.mnRadius || o.radius || 5) * PIN_SCALE);
      const tip = m.getTooltip();
      shown.push({ m, o, r, x: p.x - off, y: p.y - off, name: tip && tip.options.permanent ? m.mnStation.name : null });
    }
    if (!shown.length) return;

    // The names: the map's own label, small print on its white ground, the
    // whole of it at NAME_ALPHA. A dimmed pin's name in the lighter ink the
    // map gives it.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const fs = Math.round(rem * 0.72 * 10) / 10;
    const family = getComputedStyle(glass).fontFamily || 'sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const s of shown) {
      if (!s.name) continue;
      const dim = !!(s.m.mnFilterDim || s.m.mnFocusDimmed);
      ctx.font = `${dim ? 400 : 600} ${fs}px ${family}`;
      const w = ctx.measureText(s.name).width + 10, h = Math.round(fs * 1.5);
      const x = s.x - w / 2, y = s.y + s.r + NAME_GAP;
      if (x > d || x + w < 0 || y > d || y + h < 0) continue;
      ctx.globalAlpha = NAME_ALPHA;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3); else ctx.rect(x, y, w, h);
      ctx.fillStyle = 'rgba(255, 255, 255, .93)';
      ctx.fill();
      ctx.strokeStyle = dim ? 'rgba(0, 0, 0, .12)' : 'rgba(0, 0, 0, .25)';
      ctx.stroke();
      ctx.fillStyle = dim ? '#616161' : '#1a1a1a';
      ctx.fillText(s.name, s.x, y + h / 2 + .5);
      painted.names++;
    }

    // The dots: the pin's fill and ring, its shape, its dim — a hairline ring
    // at this size, so the colour is what reads.
    for (const s of shown) {
      const { o, r, x, y } = s;
      if (x + r < 0 || x - r > d || y + r < 0 || y - r > d) continue;
      ctx.beginPath();
      if (o.mnShape === 'triangle') {
        const w = r * Math.sqrt(3) / 2;
        ctx.moveTo(x, y - r); ctx.lineTo(x + w, y + r / 2); ctx.lineTo(x - w, y + r / 2); ctx.closePath();
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = o.fillOpacity == null ? 1 : o.fillOpacity;
      ctx.fillStyle = o.fillColor || o.color || '#3388ff';
      ctx.fill();
      ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
      ctx.strokeStyle = o.color || '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
      painted.pins++;
      painted.r = Math.max(painted.r, r);
    }
    ctx.globalAlpha = 1;
  }

  // The badge says how to change the power for a while after the glass comes
  // on, and then just the power.
  function hint() {
    hintUntil = performance.now() + HINT_MS;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintTimer = 0; schedule(); }, HINT_MS + 50);
  }

  function step(dir) {
    const i = POWERS.indexOf(power);
    const next = POWERS[Math.max(0, Math.min(POWERS.length - 1, (i < 0 ? 1 : i) + dir))];
    if (next === power) return;
    power = next;
    savePower();
    schedule();
  }

  // ── The pointer over the map ───────────────────────────────────────────────
  const overControls = e => !!(e.target && e.target.closest && e.target.closest('.leaflet-control-container'));

  function onMove(e) {
    if (!on || e.pointerType === 'touch' || overControls(e)) return;
    at = map.mouseEventToContainerPoint(e);
    schedule();
  }

  function onEnter(e) {
    if (!on || e.pointerType === 'touch') return;
    syncBases();
  }

  // A click or tap on the map puts the glass there — with a mouse it is there
  // already; on a touch screen it is how to look somewhere new in one go.
  function onMapClick(e) {
    if (!on || !e || !e.containerPoint) return;
    at = e.containerPoint;
    schedule();
  }

  // Shift + scroll over the map: the power, not the zoom. Listened for in the
  // capture phase on the stage, ahead of Leaflet's own wheel on the container,
  // so the map does not zoom as well. A scroll without Shift is the map's.
  // A trackpad sends dozens of wheel events for one stroke, so one step per
  // stroke, near enough.
  function onWheel(e) {
    if (!e.shiftKey || !showing()) return;
    const box = map.getContainer();
    if (!box.contains(e.target) || overControls(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Shift turns a wheel sideways on a Mac.
    const d = e.deltaY || e.deltaX;
    const now = performance.now();
    if (!d || now - wheelAt < 160) return;
    wheelAt = now;
    step(d < 0 ? 1 : -1);
  }

  // ── A finger on the glass (a touch screen's glass takes the pointer) ───────
  function onGlassDown(e) {
    if (!on || e.button > 0) return;
    e.preventDefault();
    try { glass.setPointerCapture(e.pointerId); } catch (_) { /* moves still arrive */ }
    clampAt();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: at, moved: false };
    syncBases();
  }

  function onGlassMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    at = L.point(drag.from.x + dx, drag.from.y + dy);
    schedule();
  }

  function onGlassUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const tapped = !drag.moved && e.type === 'pointerup';
    drag = null;
    // A tap steps the power round: 2×, 4×, 8×, 16×, and back to 2×.
    if (tapped) {
      const i = POWERS.indexOf(power);
      power = POWERS[(i + 1) % POWERS.length];
      savePower();
      schedule();
    }
  }

  // ── Escape ─────────────────────────────────────────────────────────────────
  // In the capture phase, so it is ahead of the full-screen map's Escape and
  // one press does one thing; claimed with preventDefault, the app's
  // convention. Only from the map, the page or the switch itself: a card on
  // the map closes on Escape from inside it, and a mode on the map takes it
  // first (map-mode.js).
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !on || !map) return;
    const modal = document.getElementById('app-modal');
    if (modal && modal.style.display !== 'none' && modal.offsetParent !== null) return;
    const t = e.target;
    const fromHere = !t || t === document.body || t === document.documentElement
      || map.getContainer().contains(t) || !!(t.closest && t.closest('.mn-map-magnify'));
    if (!fromHere) return;
    if (typeof MapMode !== 'undefined' && MapMode.shown().length) return;
    e.preventDefault();
    set(false);
  }

  function syncKey(want) {
    if (want && !keyOn) { document.addEventListener('keydown', onKey, true); keyOn = true; }
    else if (!want && keyOn) { document.removeEventListener('keydown', onKey, true); keyOn = false; }
  }

  // ── The switch ─────────────────────────────────────────────────────────────
  // The button in the rail (app.js, stationsMapPanels) is found by its class,
  // wherever it stands, and its title never changes: it says what the glass
  // is, and aria-pressed says whether it is on.
  function syncBtn() {
    for (const b of document.querySelectorAll('.mn-map-magnify')) {
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    }
  }

  function set(want, quiet) {
    want = !!want;
    if (want === on) return;
    on = want;
    if (on) {
      readPower();
      at = null;       // the middle of the map, until the pointer says otherwise
      hint();
    } else {
      drop();
    }
    syncKey(on && !!map);
    syncBtn();
    if (map) schedule();
    if (quiet || !map) return;
    announce(on
      ? `Magnifier on, ${power} times. The glass shows the ground with the pins as small dots, their names faint, the property lines, roads and rivers the map is drawing, and the radio paths left out. `
        + (touchOnly() ? 'Drag the glass to move it.' : 'Move the mouse over the map; Shift and scroll changes how close.')
      : 'Magnifier off.');
  }

  // ── On and off the map ─────────────────────────────────────────────────────
  function attach(m) {
    if (map) detach();
    map = m;
    const box = map.getContainer();
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerenter', onEnter);
    wheelHost = box.parentNode || box;
    wheelHost.addEventListener('wheel', onWheel, { capture: true, passive: false });
    map.on('move zoomend resize', schedule);
    map.on('mnbasechange', syncBases);
    map.on('layeradd layerremove', onLayerChange);
    map.on('click', onMapClick);
    // The file that builds a map registers it and its teardown (npm run
    // registry). Leaving the tab puts the glass away; a rebuild of the map
    // inside the tab does not — it comes back on the new map, where it was.
    registerLiveMap('Magnifier', () => lens);
    registerTabTeardown('Stations magnifier', () => set(false, true));
    syncKey(on);
    syncBtn();
    if (on) schedule();
  }

  function detach() {
    drop();
    syncKey(false);
    if (map) {
      const box = map.getContainer();
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerenter', onEnter);
      box.classList.remove('mn-magnifying');
      map.off('move zoomend resize', schedule);
      map.off('mnbasechange', syncBases);
      map.off('layeradd layerremove', onLayerChange);
      map.off('click', onMapClick);
    }
    if (wheelHost) wheelHost.removeEventListener('wheel', onWheel, { capture: true });
    wheelHost = null;
    map = null;
  }

  return {
    attach, detach,

    // The rail's switch. No argument toggles.
    toggle(want) { set(want == null ? !on : want); },
    on: () => on,

    // How far the glass reaches from the pointer, in px, while it is following
    // a mouse — 0 when it is not. A hover name that opens at the pointer is
    // under the glass; map-property-tip.js stands its own clear of it by this.
    radius() {
      if (!showing() || !glass || glass.hidden || touchOnly()) return 0;
      return glass.clientWidth / 2 + 5;   // …and the glass's ring
    },

    // For checks: what the glass is showing, counted rather than read off its
    // pixels — where it is, how close, which base layers are in it, whether
    // anything else ever got into its map, and the dots and names painted
    // over it at its last move (how many, the largest dot, the names' alpha).
    drawn() {
      const lensLayers = [];
      if (lens) lens.eachLayer(l => lensLayers.push(l));
      return {
        on, power,
        shown: !!(glass && !glass.hidden),
        at: at ? { x: Math.round(at.x), y: Math.round(at.y) } : null,
        zoom: lens ? lens.getZoom() : null,
        mainZoom: map ? map.getZoom() : null,
        centre: lens ? (c => ({ lat: c.lat, lng: c.lng }))(lens.getCenter()) : null,
        layers: lensLayers.length,
        tileLayers: lensLayers.filter(l => l instanceof L.TileLayer).length,
        bases: layers ? Object.keys(layers).filter(n => layers[n].some(l => lens && lens.hasLayer(l))) : [],
        badge: badge ? badge.textContent : '',
        pins: painted.pins, names: painted.names, pinR: painted.r, nameAlpha: painted.alpha,
        // The ground's own layers in the glass: the panes whose picture is in
        // it, which of those have one at the glass's own scale, the lines
        // painted at its last move and the marks copied in.
        ground: {
          pictures: [...mirrors.keys()],
          sharp: [...mirrors].filter(([, m]) => !!m.sharp).map(([p]) => p),
          softShown: [...mirrors].filter(([, m]) => m.soft.options.opacity > 0).map(([p]) => p),
          paths: painted.paths, marks: marks.size,
        },
      };
    },
    map: () => lens,
  };
})();
if (typeof window !== 'undefined') window.MapMagnify = MapMagnify;
