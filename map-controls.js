// MegaNet — map-controls.js
//
//   makeBaseLayers  the shared base-map tile set, as fresh Leaflet layers.
//   addBaseLayers   put that set on a map and give it the base-map picker.
//   MapChrome       the on-map panel: an icon in a map corner that opens a
//                   flyout when the pointer is over it, and when it is
//                   clicked, tapped or opened with Enter — and that can be
//                   pinned open, which docks it into the corner for good.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc and escAttr, from inside its own
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
// first entry (OSM-Topo) is the default base layer.
function makeBaseLayers() {
  return {
    'OSM-Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
    }),
  };
}

// Add the shared base-layer set to a map, switch it to the default (OSM-Topo)
// and drop a base-map picker in the top-right corner.
//
// The picker was L.control.layers until #164. It is a MapChrome panel now for
// one reason: it is no longer the only control in that corner. Leaflet's own
// expands *in place*, which was free while it was alone up there and is not
// free with three more icons under it — the Stations map's other three panels
// would have been shoved down the screen every time the pointer crossed it.
// One kind of control in the corner, one set of rules, and the picker reads and
// behaves the same on all seven maps.
function addBaseLayers(map) {
  const layers  = makeBaseLayers();
  const names   = Object.keys(layers);
  const group   = `mn-base-${MapChrome.uid()}`;   // radios only group within one map
  let current   = names[0];
  layers[current].addTo(map);

  MapChrome.panel(map, {
    id:    'basemap',
    icon:  '🗺️',
    title: 'Base map',
    html: () => names.map(n => `
      <label class="filter-check">
        <input type="radio" name="${group}" value="${escAttr(n)}" ${n === current ? 'checked' : ''}>
        ${esc(n)}
      </label>`).join(''),
    // A real listener rather than an inline handler: `layers` is this map's own
    // set of tile layers and there is no global to reach it through.
    onMount(body) {
      body.addEventListener('change', e => {
        const name = e.target && e.target.value;
        if (!layers[name] || name === current) return;
        map.removeLayer(layers[current]);
        layers[name].addTo(map);
        current = name;
      });
    },
  });
  return layers;
}

// ── The on-map panel ─────────────────────────────────────────────────────────
const MapChrome = (function () {
  // One key holding the pinned set, rather than a key per panel: it is one
  // preference — "which of these do I keep open" — and it is read as a set.
  const STORE = 'mn-map-panels';
  let seq = 0;

  // Write the pinned set back, as a comma list.
  function persist() {
    try { localStorage.setItem(STORE, [...state.mapPanelsPinned].join(',')); }
    catch (e) { /* private browsing, a full quota — the pin still works this session */ }
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

    // Pin or unpin by id, from anywhere. Every control carrying that id is
    // updated, because the same panel can exist on more than one map.
    setPinned(id, on) {
      if (on) state.mapPanelsPinned.add(id);
      else state.mapPanelsPinned.delete(id);
      persist();
      for (const el of document.querySelectorAll(`.mn-mapctl[data-panel="${id}"]`)) apply(el);
    },

    // Build one panel and add it to `map`.
    //
    //   id        stable, and the key the pin is remembered under
    //   icon      the one thing on screen while the panel is shut
    //   title     the button's accessible name, its tooltip and the panel's own
    //             heading — one string, so they cannot disagree
    //   position  a Leaflet corner; 'topright' unless a caller says otherwise
    //   html      () => string, the panel's contents. Called once, here: what
    //             is inside keeps its own ids and is re-rendered by whatever
    //             owned it before it moved onto the map.
    //   onMount   optional, (bodyEl) => void, for a caller that needs real
    //             listeners rather than inline handlers
    //   pinnable  false drops the pin — a panel nobody would want kept open
    //
    // Returns the Leaflet control, which dies with the map like any other.
    panel(map, opts) {
      const id  = opts.id;
      const ctl = L.control({ position: opts.position || 'topright' });

      ctl.onAdd = () => {
        const wrap = L.DomUtil.create('div', 'mn-mapctl');
        wrap.dataset.panel = id;

        const bodyId = `mn-mapctl-body-${id}-${MapChrome.uid()}`;

        const btn = L.DomUtil.create('button', 'mn-mapctl-btn', wrap);
        btn.type = 'button';
        btn.title = opts.title;
        btn.setAttribute('aria-label', opts.title);
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
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);

        if (typeof opts.onMount === 'function') opts.onMount(content);
        apply(wrap);
        return wrap;
      };

      ctl.addTo(map);
      return ctl;
    },
  };
})();
