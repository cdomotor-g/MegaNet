// MegaNet — map-mini.js
//
//   MapMini   the Stations map's minimap: a second, smaller map in the bottom-
//             right corner of the first, further out than it, with the main
//             map's view outlined on it. What it shows and how it moves are
//             its own — set from ⚙ on it, in a dialog — and scrolling over it
//             zooms it rather than the map underneath.
//
// After core.js and map-controls.js, before init.js — index.html
// holds the order and the reasons. Reaches back to core.js for state, esc,
// escAttr, ROLE_COLOR and the map registries, to map-controls.js for
// makeBaseLayers and makeBaseLabels, to app.js for primaryRole and
// isPhoneNav, to map-symbols.js for the owner choice and the pin colours, and
// to map-backbone.js for the backbone paths and to modal.js for its dialog —
// all from inside its own functions. The IIFE body only defines, so its position among the modules is
// free.
//
// ── Why its settings are a dialog, not a pane ────────────────────────────────
// Every other control the Stations map has went into the side panel's rail
// (map-controls.js, dockInto), and the rail is long already: a pane for a map
// inside the map would be one more icon to read past, for something most
// visits set once. So the minimap carries its own two buttons, ⚙ and fold, and
// ⚙ opens its settings in the app's one dialog (modal.js). They apply as they
// are changed — the minimap is in view under the dialog's backdrop — and are
// remembered on this device (`mn-minimap`).
//
// ── Where it lives ───────────────────────────────────────────────────────────
// In the map's stage (.mn-map-stage), beside the cards, rather than in a
// Leaflet corner. A corner is z 1000, over everything drawn over the map — the
// station card, the 3-D view's canvas and the compass it keeps in this same
// corner, the digital twin — and a minimap over any of those is in the way of
// the thing somebody is actually looking at. At 680 in the stage it is over
// the map and under all of them, which is where an overview belongs: on a
// narrow map the station card (690) covers it rather than the other way round,
// and opening 3-D or a twin puts it away without either having to be told.
// Being outside the main map's container is also what keeps its wheel and its
// drags its own: nothing that happens on it reaches the map underneath.
//
// ── How it moves ─────────────────────────────────────────────────────────────
// Following (the default), it is centred on the main map and `out` zoom levels
// further out — never nearer than one, and never further out than the
// continent (FLOOR). Scrolling over it zooms it about its centre, and that *is*
// how far out is set: the main map's next move keeps the new distance.
// Dragging it takes the main map along when it is let go, and a click sends
// the main map to the point clicked. Not following, it stays where it is left —
// dragged and scrolled on its own, its view remembered — and the outline moves
// about inside it.

const MapMini = (function () {
  const STORE = 'mn-minimap';
  // The three sizes, named; their pixels are the stylesheet's (4:3, capped to
  // the map's own rectangle, so a large one on a small map is as large as fits).
  const SIZES = { s: 'Small', m: 'Medium', l: 'Large' };
  const FLOOR = 2;                    // the whole continent in a small box
  const OUT_MIN = 1, OUT_MAX = 8;     // zoom levels out from the main map
  const TOP = 18;                     // its nearest, not following
  const BOX = '#d50000';              // the main map's view: red, cased in white
  const STATIONS = { all: 'Every station', repeaters: 'Repeaters and base stations', none: 'None' };
  const DEFAULTS = {
    open: true, size: 'm', base: 'same', names: true,
    stations: 'all', backbone: false, box: true,
    out: 4, follow: true, jump: true, view: null,
  };

  // 24-unit line drawings in currentColor (styles.css, .mn-minimap-ico).
  const ICO = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    fold: '<path d="M7 7l10 10"/><path d="M17 9v8H9"/>',
    open: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11.5" y="11.5" width="6.5" height="5.5" rx="1"/>',
  };
  const ico = d => `<svg class="mn-minimap-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;

  let cfg = { ...DEFAULTS };
  let main = null, mini = null;       // the Stations map, and this one
  let wrap = null;                    // the stage's child holding both halves
  let base = null, baseOn = null, labels = [], credit = null;
  let dots = null, dotsKey = null, dotsFor = null;
  let paths = null, pathsKey = null, pathsFor = null, pathsRenderer = null;
  let frame = null, frameCase = null, aim = null, boxRenderer = null;
  let syncing = false;                // a move this file made, not the operator
  let leading = false;                // the main map is going where the minimap was dragged
  let raf = 0;
  let baseNames = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const names = () => baseNames || (baseNames = Object.keys(makeBaseLayers()));

  // ── Remembered settings ────────────────────────────────────────────────────
  // Every field is checked on the way in — private browsing, a full quota or a
  // hand-edited value must still give a minimap. A phone starts with it put
  // away, and small when it is brought out: on a map the width of the screen
  // even a small one is a fifth of it.
  function defaults() {
    const phone = typeof isPhoneNav === 'function' && isPhoneNav();
    return { ...DEFAULTS, open: !phone, size: phone ? 's' : DEFAULTS.size };
  }

  function load() {
    const c = defaults();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (_) { return c; }
    if (!saved || typeof saved !== 'object') return c;
    for (const k of ['open', 'names', 'backbone', 'box', 'follow', 'jump']) {
      if (typeof saved[k] === 'boolean') c[k] = saved[k];
    }
    if (SIZES[saved.size]) c.size = saved.size;
    if (STATIONS[saved.stations]) c.stations = saved.stations;
    if (typeof saved.base === 'string') c.base = saved.base;   // checked against the set when drawn
    const out = Math.round(Number(saved.out));
    if (Number.isFinite(out)) c.out = clamp(out, OUT_MIN, OUT_MAX);
    const v = saved.view;
    if (v && [v.lat, v.lng, v.z].every(Number.isFinite)) c.view = { lat: v.lat, lng: v.lng, z: v.z };
    return c;
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); }
    catch (_) { /* the settings still hold for this session */ }
  }

  // A view set by this file, which its own listeners must not read as the
  // operator's. Never animated, so every event it raises has been raised by
  // the time this returns.
  function quietly(fn) {
    syncing = true;
    try { fn(); } finally { syncing = false; }
  }

  // ── Following ──────────────────────────────────────────────────────────────
  // Following, its zoom limits are the distances it may sit at: one to eight
  // levels out, and no further out than the continent — unless the map is out
  // that far itself, when it is one level further still, since a minimap is
  // never nearer than the map. Set on the options rather than through
  // setMinZoom/setMaxZoom, which move the map; the next setView keeps to them.
  // The wheel stops at a limit rather than going past it and bouncing back.
  function limits() {
    const z = main.getZoom();
    const floor = Math.max(0, Math.min(FLOOR, z - OUT_MIN));
    mini.options.minZoom = cfg.follow ? Math.max(z - OUT_MAX, floor) : 0;
    mini.options.maxZoom = cfg.follow ? Math.max(z - OUT_MIN, 0) : TOP;
  }

  const wantZoom = () => clamp(main.getZoom() - cfg.out, mini.getMinZoom(), mini.getMaxZoom());

  function follow() {
    if (!mini || !main || !cfg.follow || leading) return;
    limits();
    quietly(() => mini.setView(main.getCenter(), wantZoom(), { animate: false }));
  }

  // The main map moving: once a frame at most, however many `move` events a
  // drag or a zoom animation raises.
  function onMainMove() {
    if (!mini || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; follow(); drawBox(); });
  }

  function onMainSettled() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    leading = false;
    follow();
    drawBox();
  }

  function onMainBase() {
    if (cfg.base === 'same') setBase();
  }

  // ── The operator on the minimap ────────────────────────────────────────────
  // Scrolled or pinched: following, the distance it was left at is the new
  // `out` (limits() has kept it to one that is allowed).
  function onMiniZoom() {
    if (syncing || !main) return;
    if (cfg.follow) {
      cfg.out = clamp(main.getZoom() - mini.getZoom(), OUT_MIN, OUT_MAX);
      follow();
      label();
    }
    drawBox();
    save();
  }

  // Not following, wherever it is left is remembered.
  function remember() {
    const c = mini.getCenter();
    cfg.view = { lat: c.lat, lng: c.lng, z: mini.getZoom() };
  }

  function onMiniMoved() {
    if (syncing || cfg.follow || !mini) return;
    remember();
    save();
  }

  // Following, a drag is a way of moving the main map: it goes to where the
  // minimap was dragged to, and the minimap stays there rather than snapping
  // back to the old centre for the length of the pan (`leading`).
  function onMiniDragged() {
    if (!cfg.follow || !main) return;
    leading = true;
    main.panTo(mini.getCenter());
  }

  function onMiniClick(e) {
    if (!cfg.jump || !main) return;
    main.panTo(e.latlng);
  }

  // ── What it draws ──────────────────────────────────────────────────────────
  // The base: one of the shared set, never a blend — at this size a blend is
  // mud — and the one the main map is mostly showing unless another is picked.
  // Its credit joins the main map's credit line, which is the only one on the
  // page (map-controls.js, mapAttributionBelow); Leaflet counts a credit given
  // twice, so dropping the minimap's never takes the main map's with it.
  function baseWanted() {
    if (cfg.base === 'none') return null;
    if (cfg.base !== 'same' && names().includes(cfg.base)) return cfg.base;
    return (main && main.mnBaseName) || null;
  }

  function dropBase() {
    if (base) base.remove();
    for (const l of labels) l.remove();
    if (credit && main && main.attributionControl) {
      try { main.attributionControl.removeAttribution(credit); } catch (_) { /* the map went first */ }
    }
    base = baseOn = credit = null;
    labels = [];
  }

  function setBase() {
    if (!mini) return;
    dropBase();
    const name = baseWanted();
    if (!name) return;
    base = makeBaseLayers()[name].addTo(mini);
    baseOn = name;
    credit = base.getAttribution() || null;
    if (credit && main && main.attributionControl) main.attributionControl.addAttribution(credit);
    if (cfg.names) labels = (makeBaseLabels()[name] || []).map(l => l.addTo(mini));
  }

  // The stations as dots in their pins' colours — the role's, or the grey
  // and black Layers gives stations read by hand and TM stations — on the
  // main map's owner choice, so the minimap draws the same network the map
  // does. Repeaters and bases over the field stations, a size up and ringed.
  // Rebuilt only when something it is drawn from has moved: the main map
  // refreshes on every filter keystroke, and ~5,000 dots are not redrawn for
  // a filter the minimap does not show.
  function drawStations(force) {
    const list = state.data && state.data.stations;
    const key = [cfg.stations, state.mapOwner || '', state.mapOwnerMode || '',
                 !!state.mapPinManual, !!state.mapPinTm, list ? list.length : 0].join('|');
    if (!force && key === dotsKey && list === dotsFor) return;
    dotsKey = key;
    dotsFor = list;
    if (dots) { dots.remove(); dots = null; }
    if (!list || cfg.stations === 'none') return;
    const fields = [], hubs = [];
    for (const s of list) {
      if (s.lat == null || s.lon == null || !MapSymbols.ownerDrawn(s)) continue;
      const role = primaryRole(s);
      if (role !== 'field') hubs.push([s, role]);
      else if (cfg.stations === 'all') fields.push([s, role]);
    }
    const dot = ([s, role]) => {
      const sym = MapSymbols.pin(s);
      const fill = sym.manual ? MapSymbols.MANUAL : sym.tm ? MapSymbols.TM : (ROLE_COLOR[role] || ROLE_COLOR.field);
      const hub = role !== 'field';
      return L.circleMarker([s.lat, s.lon], {
        interactive: false, radius: hub ? 3.5 : 2,
        stroke: hub, color: '#ffffff', weight: 1, opacity: .9,
        fillColor: fill, fillOpacity: hub ? 1 : .85,
      });
    };
    dots = L.layerGroup([...fields.map(dot), ...hubs.map(dot)]).addTo(mini);
  }

  // The backbone — repeater to repeater and repeater to base — at the main
  // map's link distance, whether or not the main map is drawing it: at this
  // scale it is the shape of the network. Cased in white like the main map's,
  // so a dark line still reads on the Dark base, and on a canvas in a pane of
  // its own under the dots, whichever of the two was drawn last.
  function drawPaths(force) {
    const list = state.data && state.data.stations;
    const key = `${cfg.backbone}|${state.mapMaxLinkKm}`;
    if (!force && key === pathsKey && list === pathsFor) return;
    pathsKey = key;
    pathsFor = list;
    if (paths) { paths.remove(); paths = null; }
    if (!list || !cfg.backbone || typeof backboneLinks !== 'function') return;
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--map-backbone').trim() || '#000000';
    const pairs = backboneLinks(state.mapMaxLinkKm).map(p => [[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]]);
    const o = { renderer: pathsRenderer, interactive: false };
    paths = L.layerGroup([
      ...pairs.map(ll => L.polyline(ll, { ...o, color: '#ffffff', weight: 3, opacity: .6 })),
      ...pairs.map(ll => L.polyline(ll, { ...o, color: ink, weight: 1.2, opacity: .85 })),
    ]).addTo(mini);
  }

  // The main map's view. In a pane of its own over everything else drawn on
  // the minimap and on an SVG renderer of its own, so moving it every frame of
  // a drag repaints one rectangle rather than the canvas the dots are on. Far
  // enough out that the rectangle is a speck, a ring marks where it is.
  function drawBox() {
    if (!mini || !main) return;
    if (!cfg.box) {
      for (const l of [frameCase, frame, aim]) if (l) l.remove();
      frameCase = frame = aim = null;
      return;
    }
    const b = main.getBounds();
    if (!frame) {
      const o = { renderer: boxRenderer, interactive: false };
      frameCase = L.rectangle(b, { ...o, color: '#ffffff', weight: 4, opacity: .85, fill: false }).addTo(mini);
      frame = L.rectangle(b, { ...o, color: BOX, weight: 2, opacity: 1, fillColor: BOX, fillOpacity: .1 }).addTo(mini);
      aim = L.circleMarker(b.getCenter(), { ...o, radius: 6, color: BOX, weight: 2, fill: false });
    } else {
      frameCase.setBounds(b);
      frame.setBounds(b);
      aim.setLatLng(b.getCenter());
    }
    const sw = mini.latLngToContainerPoint(b.getSouthWest());
    const ne = mini.latLngToContainerPoint(b.getNorthEast());
    const speck = Math.abs(ne.x - sw.x) < 10 && Math.abs(sw.y - ne.y) < 10;
    if (speck !== mini.hasLayer(aim)) { if (speck) aim.addTo(mini); else aim.remove(); }
  }

  // Said to a screen reader on the group's name. The map itself is hidden
  // from it: it is a picture of what the main map already says.
  function label() {
    if (!wrap) return;
    const how = cfg.follow ? `${cfg.out} zoom level${cfg.out === 1 ? '' : 's'} further out than the map`
                           : 'left where you put it';
    wrap.setAttribute('aria-label', `Minimap — ${how}`);
  }

  // ── Building and putting away ──────────────────────────────────────────────
  // Put away, there is no map at all — no tiles fetched, no dots, no
  // listeners — just the button that brings it back.
  function build() {
    if (mini || !wrap || !main) return;
    const el = wrap.querySelector('.mn-minimap-map');
    mini = L.map(el, {
      preferCanvas: true, zoomControl: false, attributionControl: false,
      keyboard: false, boxZoom: false, inertia: false,
      // Two clicks that send the main map somewhere, not a zoom.
      doubleClickZoom: false,
      // About the centre while following, so the centre stays the main
      // map's; about the pointer otherwise, the way every map zooms.
      scrollWheelZoom: cfg.follow ? 'center' : true,
      touchZoom: cfg.follow ? 'center' : true,
    });
    limits();
    // A view before any layer, for initMap()'s reason (app.js).
    quietly(() => {
      if (!cfg.follow && cfg.view) mini.setView([cfg.view.lat, cfg.view.lng], cfg.view.z, { animate: false });
      else mini.setView(main.getCenter(), wantZoom(), { animate: false });
    });
    mini.createPane('mnBaseLabels').style.zIndex = 250;
    mini.createPane('mnMiniPaths').style.zIndex = 390;
    mini.createPane('mnMiniBox').style.zIndex = 450;
    pathsRenderer = L.canvas({ pane: 'mnMiniPaths' });
    boxRenderer = L.svg({ pane: 'mnMiniBox' });
    setBase();
    drawStations(true);
    drawPaths(true);
    drawBox();
    mini.on('zoomend', onMiniZoom);
    mini.on('moveend', onMiniMoved);
    mini.on('dragend', onMiniDragged);
    mini.on('click', onMiniClick);
  }

  function drop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    dropBase();
    mini = removeMap(mini);
    dots = paths = frame = frameCase = aim = boxRenderer = pathsRenderer = null;
    dotsKey = pathsKey = dotsFor = pathsFor = null;
    leading = false;
  }

  function apply() {
    if (!wrap) return;
    wrap.classList.toggle('is-folded', !cfg.open);
    wrap.dataset.size = cfg.size;
    label();
    if (!cfg.open) { drop(); return; }
    if (!mini) { build(); return; }
    mini.options.scrollWheelZoom = mini.options.touchZoom = cfg.follow ? 'center' : true;
    limits();
    mini.invalidateSize({ animate: false });
    follow();
    drawBox();
  }

  function setOpen(open) {
    cfg.open = open;
    save();
    apply();
    // The button pressed has just gone; its opposite number takes the focus.
    const to = wrap && wrap.querySelector(open ? '.mn-map-mini-fold' : '.mn-map-mini-open');
    if (to) to.focus({ preventScroll: true });
  }

  // ── Its settings ───────────────────────────────────────────────────────────
  function outText() {
    return `${cfg.out} level${cfg.out === 1 ? '' : 's'} out`;
  }

  function settingsHtml() {
    const lead = (main && main.mnBaseName) || 'no base';
    const check = (k, text) => `
      <label class="filter-check"><input type="checkbox" data-mmini="${k}"${cfg[k] ? ' checked' : ''}> ${text}</label>`;
    const radios = (k, set) => Object.entries(set).map(([v, text]) => `
      <label class="filter-check"><input type="radio" name="mmini-${k}" data-mmini="${k}" value="${v}"${
        cfg[k] === v ? ' checked' : ''}> ${esc(text)}</label>`).join('');
    const opt = (v, text) => `<option value="${escAttr(v)}"${cfg.base === v ? ' selected' : ''}>${esc(text)}</option>`;
    return `
      <div class="mmini-form" id="mmini-settings">
        <p class="filter-note mmini-lede">The small map in the bottom-right corner of the Stations map.
          Changes apply as you make them, and this device keeps them.</p>
        <div class="map-display-h">What it shows</div>
        <label class="filter-field">Base map
          <select data-mmini="base">
            ${opt('same', `Same as the map (${lead} now)`)}
            ${names().map(n => opt(n, n)).join('')}
            ${opt('none', 'None — the stations on a blank sheet')}
          </select>
        </label>
        ${check('names', 'Place names over Satellite, Dark and Light')}
        <fieldset class="mmini-set"><legend>Stations</legend>${radios('stations', STATIONS)}</fieldset>
        ${check('backbone', 'Backbone paths — repeater to repeater, and to base')}
        ${check('box', 'The map\'s view, outlined in red')}
        <div class="map-display-h">How it moves</div>
        ${check('follow', 'Follow the map')}
        <p class="filter-note">On, it stays centred on the map. Off, it stays where you leave it:
          dragging and scrolling move only the minimap.</p>
        <div class="mmini-range${cfg.follow ? '' : ' is-off'}">
          <label for="mmini-out">How far out</label>
          <input type="range" id="mmini-out" data-mmini="out" min="${OUT_MIN}" max="${OUT_MAX}" step="1"
                 value="${cfg.out}" aria-valuetext="${escAttr(outText())}"${cfg.follow ? '' : ' disabled'}>
          <span class="mmini-val" aria-hidden="true">${esc(outText())}</span>
        </div>
        ${check('jump', 'Click the minimap to send the map there')}
        <fieldset class="mmini-set mmini-set--row"><legend>Size</legend>${radios('size', SIZES)}</fieldset>
        <p class="filter-note">Scrolling over the minimap zooms the minimap, not the map. Following,
          that is how far out it sits; the next move of the map keeps it.</p>
        <div class="modal-foot">
          <button type="button" data-mmini-do="reset">Back to the defaults</button>
          <button type="button" data-mmini-do="done" class="primary">Done</button>
        </div>
      </div>`;
  }

  function onSetting(e) {
    const t = e.target;
    const k = t && t.dataset && t.dataset.mmini;
    if (!k) return;
    if (k === 'out') {
      cfg.out = clamp(Math.round(Number(t.value) || DEFAULTS.out), OUT_MIN, OUT_MAX);
      t.setAttribute('aria-valuetext', outText());
      const v = t.parentNode.querySelector('.mmini-val');
      if (v) v.textContent = outText();
      follow(); drawBox(); label();
    } else if (k === 'base') {
      cfg.base = t.value;
      setBase();
    } else if (k === 'stations' || k === 'size') {
      if (!t.checked) return;
      cfg[k] = t.value;
      if (k === 'stations') drawStations(true); else apply();
    } else {
      cfg[k] = !!t.checked;
      if (k === 'names') setBase();
      else if (k === 'backbone') drawPaths(true);
      else if (k === 'box') drawBox();
      else if (k === 'follow') {
        // Let go, it is left where it is — which is where it is remembered.
        if (cfg.follow) cfg.view = null; else if (mini) remember();
        const r = t.closest('.mmini-form').querySelector('.mmini-range');
        if (r) { r.classList.toggle('is-off', !cfg.follow); r.querySelector('input').disabled = !cfg.follow; }
        apply();
      }
    }
    save();
  }

  function openSettings() {
    Modal.open({ title: 'Minimap settings', html: settingsHtml() });
    const box = document.getElementById('mmini-settings');
    if (!box) return;
    // The slider on `input`, so the minimap moves under the thumb; everything
    // else on `change`.
    box.addEventListener('input', e => { if (e.target.type === 'range') onSetting(e); });
    box.addEventListener('change', e => { if (e.target.type !== 'range') onSetting(e); });
    box.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-mmini-do]');
      if (!b) return;
      if (b.dataset.mminiDo === 'done') { Modal.close(); return; }
      cfg = { ...defaults(), open: true };
      save();
      drop();
      apply();
      openSettings();                 // the controls drawn again, from the defaults
    });
  }

  // ── Attached to the Stations map ───────────────────────────────────────────
  function attach(m) {
    detach();
    main = m;
    cfg = load();
    const stage = main.getContainer().closest('.mn-map-stage');
    if (!stage) { main = null; return; }
    wrap = document.createElement('div');
    wrap.className = 'mn-minimap';
    wrap.setAttribute('role', 'group');
    wrap.innerHTML = `
      <div class="mn-minimap-map" aria-hidden="true"></div>
      <div class="mn-minimap-tools">
        <button type="button" class="mn-minimap-btn mn-map-mini-gear" aria-haspopup="dialog"
                title="Minimap settings — what it shows and how it moves" aria-label="Minimap settings">${ico(ICO.gear)}</button>
        <button type="button" class="mn-minimap-btn mn-map-mini-fold"
                title="Put the minimap away" aria-label="Put the minimap away">${ico(ICO.fold)}</button>
      </div>
      <button type="button" class="mn-minimap-btn mn-map-mini-open"
              title="Show the minimap" aria-label="Show the minimap">${ico(ICO.open)}</button>`;
    stage.appendChild(wrap);
    wrap.querySelector('.mn-map-mini-gear').addEventListener('click', openSettings);
    wrap.querySelector('.mn-map-mini-fold').addEventListener('click', () => setOpen(false));
    wrap.querySelector('.mn-map-mini-open').addEventListener('click', () => setOpen(true));
    // A resize moves the outline as a pan does. The minimap's own size, which
    // the stylesheet caps to the main map's, is re-measured with every other
    // live map's (invalidateMapSizes), not from here: once is the rule.
    main.on('move resize', onMainMove);
    main.on('moveend', onMainSettled);
    main.on('mnbasechange', onMainBase);
    // The file that builds a map registers it and its teardown (npm run
    // registry). stopStationsMap() detaches it as well, on every rebuild of
    // the main map; twice is nothing.
    registerLiveMap('Minimap', () => mini);
    registerTabTeardown('Stations minimap', detach);
    apply();
  }

  function detach() {
    if (main) {
      main.off('move resize', onMainMove);
      main.off('moveend', onMainSettled);
      main.off('mnbasechange', onMainBase);
    }
    drop();
    if (wrap) wrap.remove();
    wrap = null;
    main = null;
  }

  // Called from refreshMapLayers (app.js): the stations and paths again, if
  // anything they are drawn from has moved — and the outline, whose colour
  // does not, but whose map may have been re-fitted.
  function refresh() {
    if (!mini) return;
    drawStations(false);
    drawPaths(false);
    drawBox();
  }

  return {
    attach, detach, refresh, openSettings,
    // For checks: the minimap's map, a copy of its settings, and what is
    // drawn on it, counted rather than read off the pixels.
    map: () => mini,
    settings: () => JSON.parse(JSON.stringify(cfg)),
    drawn: () => ({
      base: baseOn, labels: labels.length, credit,
      dots: dots ? dots.getLayers().length : 0,
      paths: paths ? paths.getLayers().length / 2 : 0,
      box: !!frame, aim: !!(aim && mini && mini.hasLayer(aim)),
    }),
  };
})();
