// MegaNet — map-magnify.js
//
//   MapMagnify  the Stations map's magnifier: a round glass that follows the
//               mouse (or is dragged by a finger) and shows the ground under
//               it closer up — the base maps, with each station's pin shrunk
//               to a dot, its name, where the map names it, barely there,
//               and every line, shape and overlay this app draws left out.
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
// rides along with it. Nothing else is ever added to it, so there is nothing to
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

  let map = null;           // the Stations map
  let on = false;           // survives a rebuild of the map, not leaving the tab
  let power = 4;
  let powerRead = false;
  let glass = null;         // the glass, in the map's container
  let lens = null;          // the map inside it
  let badge = null;
  let pinsCv = null;        // the canvas the dots and the names are painted on
  let painted = { pins: 0, names: 0, r: 0, alpha: 0 };   // the last paint, for checks
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
      + '<canvas class="mn-magnify-pins"></canvas></div>'
      + '<span class="mn-magnify-aim"></span><span class="mn-magnify-power"></span>';
    badge = glass.querySelector('.mn-magnify-power');
    pinsCv = glass.querySelector('.mn-magnify-pins');
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
    lens = removeMap(lens);
    layers = null;
    if (glass) glass.remove();
    glass = badge = pinsCv = null;
    painted = { pins: 0, names: 0, r: 0, alpha: 0 };
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
    drawPins();
    const p = `${shownPower()}×`;
    badge.textContent = performance.now() < hintUntil
      ? `${p} · ${touchOnly() ? 'tap the glass to change' : 'Shift + scroll to change'}`
      : p;
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
    painted = { pins: 0, names: 0, r: 0, alpha: NAME_ALPHA };
    const markers = (typeof state !== 'undefined' && state.mapMarkers) || [];
    if (!markers.length || !d) return;

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
      ? `Magnifier on, ${power} times. The glass shows the ground with the pins as small dots, their names faint, and the lines left out. `
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
      };
    },
    map: () => lens,
  };
})();
if (typeof window !== 'undefined') window.MapMagnify = MapMagnify;
