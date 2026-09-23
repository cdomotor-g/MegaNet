// MegaNet — map-controls.js
//
//   makeBaseLayers  the shared base-map tile set, as fresh Leaflet layers.
//   addBaseLayers   put that set on a map, blendable: a checkbox and an
//                   opacity slider per base, in 🗺️ Map display.
//   MapChrome       the map's corner: one column of icons, grouped and
//                   separated by what they are for. An icon is either a panel
//                   — a flyout that opens when the pointer is over it, and
//                   when it is clicked, tapped or opened with Enter, and that
//                   can be pinned open, which docks it into the corner for
//                   good — or a plain button that does one thing.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc and escAttr, and across to
// map-elevation.js for the Elevation base map — all from inside its own
// functions; the IIFE body only defines, so this file's position among the
// modules is free.
//
// ── Why this file exists (#164) ──────────────────────────────────────────────
// Seven Leaflet maps live in this app — Stations, the Workbench case map, the
// Map Generator's view picker, the Message Log, the Bit Flipper, Network View
// and the ALERT2 decoder — and every one of them wants the same furniture in
// its corners. The base-map picker was already shared (addBaseLayers lived in
// app.js and all seven called it); what was *not* shared was everything else,
// because until this issue the Stations map's own controls were not on the map
// at all. They were three panels in the sidebar beside it, reachable from
// nowhere else.
//
// Moving them onto the map is what this file is for, and moving them meant
// deciding *once* what an on-map control is, rather than three times. So the
// base-map picker moved here too and is built out of the same primitive: one
// answer to "an icon in the corner that opens a panel", used four times on the
// Stations map and available to the other six maps unchanged.
//
// ── The two open states, and why there are two ───────────────────────────────
// A panel that is merely *hovered* is a flyout: it is positioned absolutely,
// opening leftward out of its icon, and it covers the map while the pointer is
// over it. That is the right shape for a glance — nothing below it moves, so
// the icon under the one you are pointing at does not run away from the cursor,
// which is exactly what happens with a stack of Leaflet's own expanding
// controls.
//
// A panel that is *pinned* is docked: it drops back into the corner's own
// column and takes its space there, so two pinned panels stack instead of
// overlapping. Pinning is the operator saying "I am using this one", and a tool
// in use should not be sharing pixels with the map underneath it if it can be
// helped. The pin is remembered between visits (see state.mapPanelsPinned) —
// an operator who pins the legend means it.
//
// ── And why the third state has to be "shut" ─────────────────────────────────
// The pin is the *only* way a panel stays on the map, and that is the contract
// rather than an implementation detail: a map is the one surface in this app
// where the content is the whole panel, so anything covering a corner of it
// without being asked to is in the way. Everything below that keeps a flyout
// open is therefore written to expire — hover ends when the pointer moves, the
// click toggle shuts what it can see, and the focus promotion fires only for
// focus the *keyboard* moved.
//
// That last clause is load-bearing, and it was missing. Clicking any control
// inside a panel focuses it, an ungated focusin promoted the panel to open-for-
// real on that focus, and so the ordinary act of using Draw & measure, Base map
// or Map display left its flyout on the map for good — three of them stacked
// over the corner, none of them asked for. The rule to hold to when editing
// this file: **a pointer gesture inside a panel must never leave state behind
// that outlives the pointer.** Only the pin and the icon may do that.

// ── The base-map set ─────────────────────────────────────────────────────────
// Fresh tile-layer instances for the shared base-map set. A Leaflet layer can
// only live on one map at a time, so every map gets its own instances. The
// first entry (OSM-Topo) is the default base layer; everything after it is
// there to be chosen, and an entry added here is on all seven maps at once.
//
// maxZoom is 19 on every layer whose host serves that far — capped there
// rather than at each host's own ceiling — because a Leaflet map takes its zoom
// limits from whichever base is on: a layer allowing 20 would let the operator
// zoom to somewhere the next base they picked could not follow them to, and the
// view would jump back. OSM-Topo's 17 is the exception, and is the host's.
function makeBaseLayers() {
  return {
    'OSM-Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }),
    // The labels credit covers the two Reference/* services that ride along
    // with the imagery (see the label layers in addBaseLayers) — they carry no
    // attribution of their own because they are only ever on when this is.
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community | Labels © Esri, HERE, Garmin, © OpenStreetMap contributors',
      maxZoom: 19,
    }),
    // ── Dark ────────────────────────────────────────────────────────────────
    // Esri's Dark Gray Canvas, which is the genre's whole point: a base drawn
    // deliberately *badly* — no terrain, no landuse, no colour, roads reduced
    // to hairlines — so that whatever you put on top of it is the only thing
    // with any contrast in the frame. Here that is the network. A topo or
    // satellite base is dense and mid-toned edge to edge, so a white-ringed pin
    // and a white-cased link line are competing with the tiles the whole time;
    // on this one nothing else is bright and the pins and links are all there
    // is left to look at.
    //
    // The `mn-base-dark` class carries a CSS filter (styles.css) that takes
    // Esri's mid-grey the rest of the way to near-black. That is a real
    // requirement rather than taste — "mostly blackish" was the brief — and a
    // filter is the cheapest way to it: the alternative was a second tile host,
    // and the label layer that rides along with this base (see addBaseLayers)
    // must NOT be darkened with it or the names stop being readable, which a
    // filter on this layer alone gets for free.
    //
    // Why not CARTO's Dark Matter, the obvious first pick: as of 2026 the
    // keyless basemaps.cartocdn.com tiles come back stamped "API KEY REQUIRED"
    // across the middle. Verified, not assumed — with a browser Origin and
    // Referer, which changes nothing. Esri needs no key, already serves the
    // Satellite base and every label layer in addBaseLayers, and answers with
    // `access-control-allow-origin: *` the way the Map Generator's canvas
    // compositing needs — so this adds a base map without adding a host.
    'Dark': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS User Community',
      className: 'mn-base-dark', maxZoom: 19,
    }),
    // Elevation was a fifth entry here until #186 and is an overlay now, on the
    // Stations map's Map display panel with an opacity slider — see the note at
    // the top of map-elevation.js. The ground and the place names are not
    // alternatives, which is the one thing a radio button cannot say.
  };
}

// Add the shared base-layer set to a map and give it the base-map controls.
//
// The picker was L.control.layers until #164, then a MapChrome panel of its own
// (🗺️ Base map) holding four radios. **It is not a choice of one any more.**
// Every base has a checkbox and an opacity slider, so bases stack and blend —
// Satellite at 40 % over OSM-Topo is contour lines on real ground cover, which
// no single base shows. The stack is the list: the first entry is drawn lowest
// and each one after it paints over it (tile-layer zIndex). Nothing has to be
// on; all four off is a blank sheet under the network, which is a legitimate
// thing to look at.
//
// Where the controls are drawn is the caller's business. The Stations map
// passes `{ panel: false }` and puts `map.mnBases.html()` at the top of its own
// 🗺️ Map display flyout (app.js, mapDisplayControlsHtml) — a second icon that
// was only ever "and also, underneath all that…" was one icon too many. Every
// other map has no Map display of its own, so it gets one here, under the same
// icon, id and title, holding just this section: one kind of control in the
// corner, and the same one on all seven maps.
//
// The mix is remembered (localStorage, `mn-base-maps`) and shared by every map
// — it is a preference about how this operator likes the ground to look, not
// about one map. A saved value that is a bare base name, the single-choice
// shape, is read as that base alone at full strength.
function addBaseLayers(map, opts = {}) {
  const layers  = makeBaseLayers();
  const names   = Object.keys(layers);
  const uid     = String(MapChrome.uid());   // ties this map's inputs to this map's layers
  const STORE   = 'mn-base-maps';

  // ── Names over the bases that have none ────────────────────────────────────
  // Two of the four bases arrive without place names on them and are near-
  // useless for orienting around a station that way: Satellite is bare imagery,
  // and the Dark canvas is deliberately stripped. Esri publishes a matching
  // reference service for each, from the same host as the base itself, and
  // these ride along whenever their base is the chosen one — and only then.
  //
  // Satellite takes two: Boundaries_and_Places carries localities and place
  // names down to street level, Transportation carries roads with their names
  // and route shields. Both serve native tiles past our maxZoom of 19. Esri's
  // third reference service, World_Reference_Overlay, was tried and rejected:
  // it repeats the place names and roads these two already draw (misregistered
  // doubles read as a bug), its tiles stop at level 13 and go blank over
  // Australia from about level 9 anyway. River names are already better served
  // on the Stations map by the Waterways overlay (map-rivers.js), which labels
  // every named river in view and draws above these tiles.
  //
  // Dark takes the one built for it, Dark_Gray_Reference: pale names and
  // hairline boundaries drawn for exactly this base. It is a separate layer
  // rather than the labelled variant of the base because the base is passed
  // through a darkening filter (makeBaseLayers) and the labels must not be —
  // they are the one thing on that map besides the network meant to be read.
  //
  // They live in their own pane just above Leaflet's tilePane (200) so they
  // cover the base but stay under every overlay — the overlay budget
  // (map-survey.js) starts at mnContours' 335. They are on whenever their base
  // is showing, at their base's opacity: a Satellite blended in at 30 % should
  // not bring its names in at full strength over somebody else's.
  if (!map.getPane('mnBaseLabels')) {
    map.createPane('mnBaseLabels').style.zIndex = 250;
  }
  const refLayer = svc => L.tileLayer(
    `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`,
    { pane: 'mnBaseLabels', maxZoom: 19 }   // attribution rides on the base layer
  );
  const companions = {
    'Satellite': ['Reference/World_Boundaries_and_Places',
                  'Reference/World_Transportation'].map(refLayer),
    'Dark':      ['Canvas/World_Dark_Gray_Reference'].map(refLayer),
  };
  // ── What is on, and how strongly ───────────────────────────────────────────
  // { name: { on, op } }, op 0–1. The default is the one the radios had: the
  // first base on at full strength and the rest off. Every read is guarded —
  // private browsing, a full quota or a hand-edited value must still give a map.
  const pick = {};
  for (const n of names) pick[n] = { on: n === names[0], op: 1 };
  (() => {
    let raw = null;
    try { raw = localStorage.getItem(STORE); } catch (_) { return; }
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { saved = raw; }
    if (typeof saved === 'string') {              // the old single choice
      if (pick[saved]) for (const n of names) pick[n] = { on: n === saved, op: 1 };
      return;
    }
    if (!saved || typeof saved !== 'object') return;
    for (const n of names) {
      const s = saved[n];
      if (!s || typeof s !== 'object') continue;
      pick[n].on = !!s.on;
      const op = Number(s.op);
      if (Number.isFinite(op)) pick[n].op = Math.max(0, Math.min(1, op));
    }
  })();
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(pick)); }
    catch (_) { /* the mix still works for this session */ }
  };

  // Stacking order is list order, stated once rather than left to the order
  // the layers happen to be added in — ticking OSM-Topo back on after
  // Satellite must put it back *under* Satellite.
  names.forEach((n, i) => layers[n].setZIndex(i + 1));

  // A base at 0 % is ticked but not fetched: it keeps its place in the mix
  // without costing a tile request for pixels nobody can see.
  const showing = n => pick[n].on && pick[n].op > 0;
  function sync(n) {
    for (const l of [layers[n], ...(companions[n] || [])]) {
      if (showing(n)) { l.setOpacity(pick[n].op); if (!map.hasLayer(l)) l.addTo(map); }
      else if (map.hasLayer(l)) map.removeLayer(l);
    }
  }

  // Which base this map is "on", published on the map itself as mnBaseName.
  // Map3D needs one name because the 3-D view drapes a single raster over the
  // terrain (map-3d.js); with several blended, the fair answer is the one that
  // dominates the picture — the most opaque, and the upper of two equals.
  // Null when nothing is showing, which Map3D reads as its own fallback.
  function lead() {
    let best = null;
    for (const n of names) if (showing(n) && (!best || pick[n].op >= pick[best].op)) best = n;
    return best;
  }
  function publish() {
    const was = map.mnBaseName;
    map.mnBaseName = lead();
    // A no-op unless 3-D is actually open, and only asked when the answer
    // moved: a slider drag is dozens of input events, and each baseChanged()
    // replaces the 3-D view's raster source.
    if (map.mnBaseName !== was && typeof Map3D !== 'undefined') Map3D.baseChanged();
  }

  for (const n of names) sync(n);
  map.mnBaseName = lead();

  // ── The controls ───────────────────────────────────────────────────────────
  // One row per base — checkbox, slider, readout — under a heading, as a flat
  // run of elements: Map display's Find box filters its panel row by row off
  // the direct children of #map-display-block (app.js, mapDisplayRows), and
  // this markup is emitted straight into that list. The slider is disabled
  // while its base is off, the way Link opacity is while links are.
  const pct = n => Math.round(pick[n].op * 100);
  function html() {
    return `<div class="map-display-h">Base maps</div>` + names.map(n => `
      <div class="mn-base-row${pick[n].on ? '' : ' is-off'}">
        <label class="filter-check">
          <input type="checkbox" data-base-map="${uid}" data-base="${escAttr(n)}" ${pick[n].on ? 'checked' : ''}>
          ${esc(n)}
        </label>
        <input type="range" min="0" max="100" step="5" value="${pct(n)}"
               data-base-map="${uid}" data-base="${escAttr(n)}"
               aria-label="${escAttr(n)} opacity" aria-valuetext="${pct(n)} per cent"
               ${pick[n].on ? '' : 'disabled'}>
        <span class="mn-base-val" aria-hidden="true">${pct(n)}%</span>
      </div>`).join('') +
      `<p class="filter-note">Tick more than one to blend them — each is drawn
         over the ones listed above it, at its own opacity. Satellite and Dark
         carry place &amp; road names; Dark strips the ground to near-black so
         the pins and links are the only thing left with any contrast.</p>`;
  }

  // Real listeners rather than inline handlers — `layers` is this map's own set
  // and there is no global to reach it through — delegated from `el`, because
  // the Stations map re-renders its Map display block wholesale and a listener
  // on an input would die with the input. `data-base-map` keeps two maps'
  // controls apart should two ever share a container.
  function bind(el) {
    const which = e => {
      const t = e.target;
      return t && t.dataset && t.dataset.baseMap === uid && pick[t.dataset.base] ? t.dataset.base : null;
    };
    const changed = n => { sync(n); publish(); save(); };
    el.addEventListener('change', e => {
      const n = which(e);
      if (!n || e.target.type !== 'checkbox') return;
      pick[n].on = e.target.checked;
      const row = e.target.closest('.mn-base-row');
      if (row) {
        row.classList.toggle('is-off', !pick[n].on);
        const r = row.querySelector('input[type="range"]');
        if (r) r.disabled = !pick[n].on;
      }
      changed(n);
    });
    // `input`, not `change`: the blend is the thing being judged, so it has to
    // move under the thumb rather than when the thumb is let go.
    el.addEventListener('input', e => {
      const n = which(e);
      if (!n || e.target.type !== 'range') return;
      const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
      pick[n].op = v / 100;
      e.target.setAttribute('aria-valuetext', `${v} per cent`);
      const out = e.target.parentNode.querySelector('.mn-base-val');
      if (out) out.textContent = `${v}%`;
      changed(n);
    });
  }

  // What a host panel needs, and what a check can read back without scraping
  // the tile panes: a copy of the mix, never the live object.
  map.mnBases = { html, bind, mix: () => JSON.parse(JSON.stringify(pick)) };

  // First in the corner, and first in the group about what the map shows:
  // every other icon in that group is a way of drawing something *over* this.
  if (opts.panel !== false) {
    MapChrome.panel(map, {
      id: 'display', icon: '🗺️', title: 'Map display',
      group: 'show', order: 10,
      html, onMount: bind,
    });
  }
  // The credit line, off the map and under it. Every map calls addBaseLayers,
  // so every map gets it — which is the point (see mapAttributionBelow).
  mapAttributionBelow(map);
  // …and how tall a flyout in its corner may be, for the same reason.
  trackMapHeight(map);
  return layers;
}

// Publish the map's own height to its container as --mn-map-h, so a control
// drawn *inside* the map can be capped against the map rather than against the
// viewport (styles.css, .mn-mapctl-content).
//
// The caps were vh figures — 42vh for a flyout — and a vh figure is only ever
// right for one of the shapes this map takes. The Stations map is min(62vh,
// 720px) in the page, 52dvh on a phone, the full window in full screen and a
// column's worth beside the station list in the side-by-side split, and a panel
// capped at 42vh is a panel with room to spare in two of those and its last
// control cut off by the map's edge in the others. The map knows its own
// height; this is how the stylesheet gets to read it.
function trackMapHeight(map) {
  const el = map.getContainer();
  const sync = () => {
    const h = el.clientHeight;
    if (h > 0) el.style.setProperty('--mn-map-h', `${h}px`);
  };
  map.on('resize', sync);
  sync();
}

// ── The credit line, under the map instead of on it ──────────────────────────
//
// Leaflet puts the attribution control in the map's bottom-right corner, where
// it is a floating box *over* the map — and on this app's maps it is not a
// short one: the Stations map credits four base services, the drainage basins,
// the maintenance hubs, the wind regions and OpenStreetMap, which wraps to two
// full-width lines across the foot of the map.
//
// Anything else that wants the bottom of a map is then underneath it. That is
// how it was found — the move-pin panel's Save and Cancel buttons sit bottom
// left and the credit line was covering them — but the move-pin panel is not
// the problem, it is the first thing to want that corner. A control in a map
// corner is a control an operator is meant to be able to press, and a credit
// line that must always be on screen will always be in the way of one.
//
// So the credit line leaves the map. The control itself stays exactly as it
// is — Leaflet collects attributions from layers as they are added and removed
// and writes them into `_container`, and none of that cares where in the
// document that container sits — and only the container is re-parented, into a
// strip immediately below the map. The credits stay live, stay complete, stay
// attached to the map they describe, and stop covering it.
//
// Called from addBaseLayers, so it applies to all seven maps without any of
// them asking, and to whatever map is written next.
function mapAttributionBelow(map) {
  const ctrl  = map && map.attributionControl;
  const mapEl = map && map.getContainer && map.getContainer();
  const box   = ctrl && ctrl.getContainer && ctrl.getContainer();
  if (!ctrl || !mapEl || !box || !mapEl.parentNode) return null;
  // One strip per map, reused across rebuilds: initMap() tears the Stations
  // map down and builds another on every render of the tab, and a strip per
  // build would stack empty boxes under the map for the life of the page.
  //
  // "Below the map" means below everything drawn over the map, not just below
  // the map element: the Stations map wraps its container and its on-map cards
  // in a stage (.mn-map-stage) precisely so that the cards can be positioned
  // against the map's own rectangle, and a credit line inside that stage would
  // put it back inside the box the cards measure themselves against. Every
  // other map in the app has no stage and no cards, and the strip goes directly
  // under the container.
  const after = (mapEl.closest && mapEl.closest('.mn-map-stage')) || mapEl;
  let strip = after.nextElementSibling;
  if (!strip || !strip.classList.contains('mn-map-attrib')) {
    strip = document.createElement('div');
    strip.className = 'mn-map-attrib';
    after.parentNode.insertBefore(strip, after.nextSibling);
  }
  strip.textContent = '';
  strip.appendChild(box);
  return strip;
}

// ── The on-map panel ─────────────────────────────────────────────────────────
const MapChrome = (function () {
  // One key holding the pinned set, rather than a key per panel: it is one
  // preference — "which of these do I keep open" — and it is read as a set.
  const STORE = 'mn-map-panels';
  let seq = 0;

  // ── The corner, and why it is one control now (#192) ─────────────────────
  // Eleven icons had accumulated in the Stations map's top-right corner, each
  // one its own Leaflet control carrying Leaflet's own 10 px margin: a 500-pixel
  // column of identical buttons down the side of a map that is 720 px tall at
  // its tallest. Nothing in it said which of them were about what the map
  // *shows*, which were tools you point *at* it, which were about how much
  // screen it gets, and which single one throws your work away — and the two
  // that are the same feature, the ⛰️ that tilts the map and the ⛰️ that
  // carries the tilt's own settings, were four buttons apart with nothing to
  // say they were related at all.
  //
  // So the corner is **one control holding ordered groups** rather than N
  // controls in whatever order the modules happened to attach. Three things
  // follow, and all three are the point:
  //
  //   **The order is declared.** An icon states which group it is in and where
  //   in it, so addBaseLayers (before), stationsMapPanels (next) and
  //   MapPolar.attach (well after) produce the same column whatever order they
  //   run in — and whoever adds the twelfth icon picks a meaning rather than a
  //   position in a list they cannot see.
  //
  //   **The spacing can say something.** Icons inside a group sit 3 px apart;
  //   the groups are separated by a gap and a hairline (styles.css). The column
  //   reads as five short clusters instead of eleven equal buttons, and it is
  //   ~35 px shorter than the stack it replaced with everything shut — and a
  //   great deal shorter than it on a phone, where the icons are 44 px and the
  //   old column was 200 px taller than the map it was drawn on.
  //
  //   **The grouping is not only pixels.** Each group is a labelled ARIA group,
  //   so a screen reader is told "3-D view" where a sighted operator is shown a
  //   hairline. A separator that existed only in the stylesheet would have made
  //   the corner prettier and no more navigable.
  //
  // The group names are the five questions the corner answers. `show` is what
  // is drawn and how to read it; `tools` is what you arm and point at the map;
  // `3d` is the mode and its camera; `screen` is how much of the page this map
  // is being given; `reset` is the one that takes something away, last, for the
  // reason it has always been last (app.js).
  const GROUPS = {
    show:   'What the map shows',
    tools:  'Tools',
    '3d':   '3-D view',
    screen: 'Screen',
    reset:  'Reset',
  };
  const ORDER = Object.keys(GROUPS);

  // Write the pinned set back, as a comma list.
  function persist() {
    try { localStorage.setItem(STORE, [...state.mapPanelsPinned].join(',')); }
    catch (e) { /* private browsing, a full quota — the pin still works this session */ }
  }

  // The one Leaflet control per map corner that every icon is put inside.
  // Made on first use, so a map that only ever calls addBaseLayers gets a bar
  // with one group in it and nothing else changes for the other six maps.
  function bar(map, position) {
    const bars = map._mnBars || (map._mnBars = {});
    if (bars[position]) return bars[position];
    const ctl = L.control({ position });
    ctl.onAdd = () => {
      const el = L.DomUtil.create('div', 'mn-mapbar');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Map controls');
      // Once, for the whole column, rather than once per icon: a click
      // anywhere in here is a click on a control and the map underneath must
      // not also take it, and a scroll over a long flyout must not zoom.
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    };
    ctl.addTo(map);
    bars[position] = ctl.getContainer();
    return bars[position];
  }

  // The group inside that bar, made on first use and inserted in ORDER's order
  // however late the module asking for it attaches.
  function slot(map, opts) {
    const el   = bar(map, opts.position || 'topright');
    const name = GROUPS[opts.group] ? opts.group : 'tools';
    const rank = ORDER.indexOf(name);
    let g = el.querySelector(`.mn-mapbar-group[data-group="${name}"]`);
    if (!g) {
      g = L.DomUtil.create('div', 'mn-mapbar-group');
      g.dataset.group = name;
      g.dataset.rank  = String(rank);
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', GROUPS[name]);
      el.insertBefore(g, [...el.children].find(c => Number(c.dataset.rank) > rank) || null);
    }
    return g;
  }

  // …and the icon's place within it. The same rule one level down and for the
  // same reason: `order` is a number the caller states rather than the moment
  // it happened to call. Gaps of ten, so an icon can be put between two others
  // without renumbering them.
  function place(map, el, opts) {
    const g = slot(map, opts);
    const n = Number(opts.order) || 0;
    el.dataset.order = String(n);
    // Two icons that are one control — the ⛰️ mode and the caret that opens
    // its settings. The stylesheet joins anything carrying the same pair name
    // into a single button with a split bottom; nothing here needs to know
    // which two they are.
    if (opts.pair) el.dataset.pair = opts.pair;
    g.insertBefore(el, [...g.children].find(c => Number(c.dataset.order) > n) || null);
    return el;
  }

  // Push the open/pinned state onto one control's DOM. Called on build and
  // again whenever either changes, so the classes, aria-expanded and
  // aria-pressed never drift apart from each other.
  function apply(wrap) {
    const id     = wrap.dataset.panel;
    const pinned = state.mapPanelsPinned.has(id);
    const open   = wrap.classList.contains('is-open');
    const btn    = wrap.querySelector('.mn-mapctl-btn');
    const pin    = wrap.querySelector('.mn-mapctl-pin');
    wrap.classList.toggle('is-pinned', pinned);
    if (btn) btn.setAttribute('aria-expanded', String(open || pinned));
    if (pin) {
      pin.setAttribute('aria-pressed', String(pinned));
      pin.title = pinned ? 'Unpin — collapse to its icon again' : 'Keep this panel open';
      pin.setAttribute('aria-label', pinned ? 'Unpin this panel' : 'Keep this panel open');
    }
  }

  // Is this control on screen *because the pointer is on it*? Asked before the
  // click handler decides which way to toggle, and gated on the same media
  // query the hover rule in styles.css is gated on — a touch screen reports a
  // stale `:hover` on whatever was tapped last, and reading that would have the
  // first tap on an icon count as "already open" and shut it again.
  function hoverShows(wrap) {
    return window.matchMedia('(hover: hover)').matches && wrap.matches(':hover');
  }

  return {
    // Radio groups and body ids have to be unique across every map on the page.
    uid() { return ++seq; },

    // The corner's groups, for anything that needs to reason about them —
    // `test/mapctl.mjs` asserts the column is in this order and that every
    // group on screen is one of these.
    groups() { return { ...GROUPS }; },

    // Pin or unpin by id, from anywhere. Every control carrying that id is
    // updated, because the same panel can exist on more than one map.
    setPinned(id, on) {
      if (on) state.mapPanelsPinned.add(id);
      else state.mapPanelsPinned.delete(id);
      persist();
      for (const el of document.querySelectorAll(`.mn-mapctl[data-panel="${id}"]`)) apply(el);
    },

    // ── A plain corner button ────────────────────────────────────────────────
    // One press, one thing, nothing disclosed: full screen, side by side,
    // reset, What is here, the ⛰️ mode and the two camera buttons are all this
    // shape. They were five hand-rolled `L.control` blocks in app.js until the
    // corner became a bar — the same six lines of Leaflet plumbing five times,
    // none of which could say which group it belonged to, and each of which
    // built its icon slightly differently from the panels beside it.
    //
    //   icon      the markup inside the button: an emoji, or an SVG for the two
    //             that have to *show* something that changes (Map3D's compass
    //             needle and its tilt)
    //   title     tooltip and accessible name, one string, as for a panel
    //   ariaLabel optional, and the one place the two come apart: ↺'s tooltip
    //             is a sentence about what it clears, which is the right thing
    //             to read on hover and far too much to hear read out as the
    //             name of a button
    //   onClick   what it does, called with the button
    //   className extra classes — which is how the module that owns a button
    //             finds it again to keep it in step (`.mn-map-3d`, …)
    //   pressed   this button is a *mode* rather than an action, and starts
    //             in that state. A mode has to say so from the moment it is
    //             built, not from the first time it changes: ℹ️ and ⛰️ are
    //             both toggles, and a toggle with no aria-pressed is a button
    //             that never tells anyone it is on
    //   hidden    built, placed, and not shown: a control that cannot do
    //             anything yet. Its group keeps the space in the order rather
    //             than the column, so showing it later moves nothing above it
    //   group / order / pair   where it goes — see place() above
    //
    // Returns the button, for a caller that wants to go on syncing it.
    button(map, opts) {
      const b = L.DomUtil.create('button',
        `mn-mapctl-btn${opts.className ? ` ${opts.className}` : ''}`);
      b.type = 'button';
      b.innerHTML = `<span class="mn-mapctl-ico" aria-hidden="true">${opts.icon || ''}</span>`;
      if (opts.title) b.title = opts.title;
      if (opts.title || opts.ariaLabel) {
        b.setAttribute('aria-label', opts.ariaLabel || opts.title);
      }
      if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(!!opts.pressed));
      if (opts.hidden) b.hidden = true;
      // A corner button is not a disclosure and has no body to leave behind,
      // so it needs only what every control in here needs: the click must not
      // reach the map. The bar stops it as well; this stops it at the source,
      // which is what survives a handler that repaints its own button.
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', L.DomEvent.stop);
      if (typeof opts.onClick === 'function') L.DomEvent.on(b, 'click', () => opts.onClick(b));
      return place(map, b, opts);
    },

    // Build one panel and add it to `map`.
    //
    //   id        stable, and the key the pin is remembered under
    //   icon      the one thing on screen while the panel is shut
    //   title     the button's accessible name, its tooltip and the panel's own
    //             heading — one string, so they cannot disagree
    //   btnLabel  optional, and the one exception to that: an icon that is not
    //             a picture of its panel needs to say what pressing it does.
    //             The 3-D caret is ▾ — "3-D view" is the right heading for the
    //             panel and the wrong tooltip for a chevron
    //   caret     draw the icon as the thin lower half of the control above it
    //             rather than as a button of its own (see `pair`)
    //   position  a Leaflet corner; 'topright' unless a caller says otherwise
    //   group / order / pair   where it goes in that corner — see place()
    //   html      () => string, the panel's contents. Called once, here: what
    //             is inside keeps its own ids and is re-rendered by whatever
    //             owned it before it moved onto the map.
    //   onMount   optional, (bodyEl) => void, for a caller that needs real
    //             listeners rather than inline handlers
    //   pinnable  false drops the pin — a panel nobody would want kept open
    //
    // Returns the wrapper element. It was the Leaflet control until the corner
    // became a bar; no caller ever used it, and there is no control of its own
    // to return any more — the panel dies with the bar, which dies with the map
    // like any other control.
    panel(map, opts) {
      const id   = opts.id;
      const wrap = L.DomUtil.create('div', 'mn-mapctl');
      wrap.dataset.panel = id;

      const bodyId = `mn-mapctl-body-${id}-${MapChrome.uid()}`;

      const btn = L.DomUtil.create('button',
        `mn-mapctl-btn${opts.caret ? ' is-caret' : ''}`, wrap);
      btn.type = 'button';
      btn.title = opts.btnLabel || opts.title;
      btn.setAttribute('aria-label', opts.btnLabel || opts.title);
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', bodyId);
      btn.innerHTML = `<span class="mn-mapctl-ico" aria-hidden="true">${opts.icon}</span>`;

      const body = L.DomUtil.create('div', 'mn-mapctl-body', wrap);
      body.id = bodyId;

      const head = L.DomUtil.create('div', 'mn-mapctl-head', body);
      const h3   = L.DomUtil.create('h3', 'mn-mapctl-title', head);
      h3.textContent = opts.title;

      if (opts.pinnable !== false) {
        const pin = L.DomUtil.create('button', 'mn-mapctl-pin', head);
        pin.type = 'button';
        pin.innerHTML = '<span aria-hidden="true">📌</span>';
        L.DomEvent.on(pin, 'click', L.DomEvent.stop)
                  .on(pin, 'click', () => MapChrome.setPinned(id, !state.mapPanelsPinned.has(id)));
      }

      const content = L.DomUtil.create('div', 'mn-mapctl-content', body);
      content.innerHTML = typeof opts.html === 'function' ? opts.html() : (opts.html || '');

      // Click to open, click again to shut. This is the whole of the control
      // on a touch screen, where there is no pointer to hover with, and it is
      // also how a keyboard opens it — the button is a button, so Enter and
      // Space already arrive here. It is a plain disclosure, in other words,
      // and `is-open` is the state aria-expanded reports.
      //
      // What it toggles against is what is **on screen**, not the class on its
      // own. On a mouse the icon cannot be clicked without being hovered
      // first, so the panel is already open by the time the click lands: a
      // bare `toggle('is-open')` there looked like it did nothing, and left
      // the panel open for good — the class it had just set outlived the hover
      // that was doing the showing, and only a second click on the icon could
      // undo it. Clicking a panel you can see shuts it, and `is-shut` is what
      // holds it shut under a pointer that has not moved away yet; the
      // pointerleave below drops that class so the next hover opens it again.
      L.DomEvent.on(btn, 'click', L.DomEvent.stop).on(btn, 'click', () => {
        const hovered = hoverShows(wrap);
        const showing = !wrap.classList.contains('is-shut')
                     && (wrap.classList.contains('is-open') || hovered);
        wrap.classList.toggle('is-open', !showing);
        wrap.classList.toggle('is-shut', showing && hovered);
        apply(wrap);
      });

      // Focus arriving inside a panel that is open on *hover* alone promotes
      // it to open-for-real. Two things go wrong without this, and the second
      // is the one that matters: aria-expanded would read "false" about a
      // panel the operator is typing in, and the panel would shut the moment
      // the mouse moved — with focus inside it, which drops focus to the top
      // of the document. The CSS holds it open while that is settled
      // (.mn-mapctl-body:has(:focus-visible)) and this is what makes the state
      // agree with the pixels.
      //
      // **Keyboard focus only**, and that qualifier is the bug this gate
      // fixes rather than a refinement of it. A *click* on a checkbox, a
      // colour swatch or a draw tool inside the panel focuses that control
      // too, so an ungated promotion fired on every ordinary use of the panel
      // and made it permanent: one tick of "Snap to stations" in Draw &
      // measure, one radio in Base map, one checkbox in Map display, and the
      // flyout stayed on the map until its icon was found and clicked again.
      // That is not a disclosure, it is a panel that will not go away, and
      // with three of them on one corner they stack up over the map.
      //
      // `:focus-visible` is the browser's own answer to "did the keyboard put
      // focus here", so the safety net keeps every case it was built for —
      // including the one that is not a keypress: a text or number field
      // matches it whatever focused it, so the "Place by numbers" inputs still
      // hold their panel open while they are being typed into.
      //
      // The button is excluded on purpose: clicking it focuses it *and* fires
      // the toggle above, and a focusin that opened first would have that
      // toggle close what the click was opening.
      L.DomEvent.on(wrap, 'focusin', e => {
        if (e.target === btn) return;
        if (wrap.classList.contains('is-open') || state.mapPanelsPinned.has(id)) return;
        if (!(e.target.matches && e.target.matches(':focus-visible'))) return;
        wrap.classList.add('is-open');
        apply(wrap);
      });

      // The pointer leaving does two things, both about the frame after it.
      // It clears the shut-by-click suppression above, so the icon opens on
      // hover again. And it takes focus off whatever inside the panel a
      // *click* left it on, because the hover rule is about to hide that
      // element with focus still in it — which drops focus to <body> and
      // starts the next Tab at the top of the document. That is the same
      // defect the promotion above exists to prevent, arriving by the door the
      // :focus-visible gate deliberately leaves open. The icon is where the
      // focus came from and where Tab should carry on from, and moving it
      // there after a pointer gesture draws no focus ring.
      L.DomEvent.on(wrap, 'pointerleave', () => {
        wrap.classList.remove('is-shut');
        if (wrap.classList.contains('is-open') || state.mapPanelsPinned.has(id)) return;
        const active = document.activeElement;
        if (active && active !== btn && wrap.contains(active)) btn.focus({ preventScroll: true });
      });

      // Without these, ticking a checkbox in the panel also drops a draw pin
      // on the map underneath it, and scrolling a long panel zooms the map.
      // The bar carries them too, and both are worth having: this is the pair
      // that goes on working if a panel is ever built somewhere else.
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(wrap);

      // …and without *this*, the one control that repaints its own panel gets
      // the pin anyway. Leaflet's disableClickPropagation does not stop the
      // click; it marks the wrapper and, when the map container later sees the
      // event, walks up from `event.target` looking for that mark. A handler
      // that replaces the panel's innerHTML — MapDraw.setTool() arming a tool
      // is exactly that — has by then detached the button that was clicked, so
      // the walk starts on an orphan, finds no mark, and the map takes the
      // click as its own: arming the line tool dropped its first point under
      // the ✏️ flyout, and the tool came up already waiting for point two.
      //
      // The event path was fixed when the click was dispatched, so this
      // listener still runs on a wrapper whose contents have gone. Stopping
      // here keeps the click off the map without needing the target to still
      // exist. Nothing in this app listens for clicks on document, so nothing
      // downstream loses one.
      L.DomEvent.on(wrap, 'click', L.DomEvent.stopPropagation);

      if (typeof opts.onMount === 'function') opts.onMount(content);
      apply(wrap);
      return place(map, wrap, opts);
    },
  };
})();
