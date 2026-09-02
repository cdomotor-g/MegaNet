// MegaNet — map-move-pin.js
//
//   MapMovePin   move a station's pin on the Stations map to where the station
//                actually is: arm it, drag the pin (or click the ground under
//                it), read the new coordinates back, save.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, cssVar, announce,
// acmaHaversineKm and fmtKm; across to app.js for the Stations map itself,
// mapNote and selectStation; to auth.js for Auth.open() from the callout's
// pill; to station-editor.js for editorSave and the #ef-lat / #ef-lon boxes it
// writes into; to map-draw.js and link-budget.js, to take the map's other
// interactive modes off before it takes the clicks; and to datastore.js for
// dbCanWrite, editorWritesGoToDatabase and setEditorStatus.
//
// The IIFE body declares nothing but nulls, so this file's position among the
// modules is free — checked rather than asserted (`npm run toplevel`). It
// builds no Leaflet map of its own and starts no timer, so it registers no live
// map; app.js attaches and detaches it with the Stations map.
//
// ── Why a mode and not a drag ────────────────────────────────────────────────
//
// Because a station is 3,174 pins on a canvas and a map you pan by dragging.
// Making pins draggable outright means every pan that starts a pixel inside a
// pin moves a station instead, silently, and the operator finds out weeks later
// when a gauge is 40 m into a river. So this is armed for one station at a
// time, it says on the map which station is armed and where it has been moved
// to, and it will not write anything until Save is pressed.
//
// ── Why a second marker rather than a draggable circleMarker ─────────────────
//
// L.circleMarker has no drag handler — Leaflet's dragging lives on L.Marker,
// which the Stations map deliberately does not use (3,174 DOM nodes is the
// thing `preferCanvas` exists to avoid). So the armed station gets one real
// L.Marker on top of its own circle for as long as the mode is on, and it
// carries a divIcon rather than Leaflet's default image icon for the reason
// MapLocate gives: the default resolves its PNGs against the CSS's own URL, and
// this app is expected to work off a laptop with no network.
//
// The station's ordinary pin stays where it is while the mode is on. That is
// the "was here" mark — with a dashed line to the new position and the distance
// between them on the panel, because "did I mean to move it 40 km" is the
// question this mode has to be able to answer before Save is pressed.
const MapMovePin = (function () {
  let map = null;                 // the Stations map, while one exists
  let stationId = null;           // the armed station, or null
  let marker = null, ghost = null, leader = null, panel = null;
  let at = null;                  // [lat, lon] the pin has been dragged to
  let from = null;                // [lat, lon] it started at, or null for a new site

  // Six decimal places is about 0.1 m at these latitudes — past what a handheld
  // GPS claims and well past what a pin dragged on a screen means. It is here so
  // that a saved coordinate is a number a person can read back, rather than the
  // seventeen digits a double prints.
  const DP = 6;
  const round = n => Number(n.toFixed(DP));

  function station() {
    if (!stationId || !state.data) return null;
    return state.data.stations.find(s => s.id === stationId) || null;
  }

  function icon() {
    return L.divIcon({
      className: 'mn-movepin-icon',
      html: '<div class="mn-movepin"><i class="mn-movepin-ring"></i><i class="mn-movepin-dot"></i></div>',
      iconSize: [34, 34], iconAnchor: [17, 17],
    });
  }

  // How far the pin has been dragged, as the panel says it. Null when the
  // station had no coordinates to start with — a first fix has no "moved by".
  function movedKm() {
    if (!from || !at) return null;
    return acmaHaversineKm(from[0], from[1], at[0], at[1]);
  }

  // ── The panel on the map ───────────────────────────────────────────────────
  // Bottom left, where nothing else on this map lives: the base-map picker and
  // the three MapChrome panels are top right, the zoom and locate controls top
  // left. It is a Leaflet control rather than a card under the map because it
  // has to be readable while the map is being dragged, and because the map is
  // the thing being operated.

  function panelHtml() {
    const s    = station();
    const km   = movedKm();
    const name = (s && s.name) || 'this station';
    return `
      <div class="mn-movepin-head">
        <strong>Moving the pin</strong>
        <span class="mn-movepin-name">${esc(name)}</span>
      </div>
      <p class="mn-movepin-hint">Drag the pin, or click the map where the station should be.</p>
      <dl class="mn-movepin-read">
        <dt>Latitude</dt><dd>${at ? at[0].toFixed(DP) : '—'}</dd>
        <dt>Longitude</dt><dd>${at ? at[1].toFixed(DP) : '—'}</dd>
        <dt>Moved</dt><dd>${km == null ? 'new position' : fmtKm(km)}</dd>
      </dl>
      <div class="mn-movepin-actions pill-row">
        <button type="button" class="pill is-on" onclick="MapMovePin.save()">Save position</button>
        <button type="button" class="pill" onclick="MapMovePin.cancel()">Cancel</button>
      </div>`;
  }

  // Repaint the readout without rebuilding the control — it is redrawn on every
  // mousemove of a drag, and replacing the container would drop the drag.
  function repaintPanel() {
    const el = panel && panel.getContainer();
    if (el) el.innerHTML = panelHtml();
  }

  function addPanel() {
    panel = L.control({ position: 'bottomleft' });
    panel.onAdd = () => {
      const div = L.DomUtil.create('div', 'mn-movepin-panel');
      div.setAttribute('role', 'group');
      div.setAttribute('aria-label', 'Move this station’s pin');
      div.innerHTML = panelHtml();
      // A click on Save must not also be a click on the map, which would move
      // the pin under the cursor to the panel's own corner.
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    panel.addTo(map);
  }

  // ── The two affordances that arm it ────────────────────────────────────────
  // One in the station editor card next to the coordinate boxes, one on the map
  // callout. Same mode, reached from wherever the station is already in hand.

  function label(id) {
    return stationId === id ? 'Moving on the map…' : 'Move pin on map';
  }

  // The editor card's button. Rendered by editorForm(). Not disabled when there
  // is no map to move a pin on — the card only exists on the Stations tab, and
  // if it is ever reached without one, start() says so on the map note rather
  // than the button greying itself out with no explanation.
  function editorButtonHtml(s) {
    if (!s || !s.id) return '';        // a "+ New" draft has no pin to move yet
    const on = stationId === s.id;
    return `<button type="button" class="pill${on ? ' is-on' : ''}" id="ef-movepin"
        aria-pressed="${on}"
        onclick="MapMovePin.${on ? 'cancel' : 'start'}('${escAttr(s.id)}')"
        title="${on ? 'Stop moving the pin and leave the coordinates as they were'
                    : 'Drag this station’s pin on the map above to where it should be'}"
        >📍 ${label(s.id)}</button>`;
  }

  // The map callout's pill. Only offered where a save could actually land: the
  // callout is the one place this can be reached without the editor card being
  // open, so it says why when it is not on offer rather than appearing dead.
  function popupLinkHtml(s) {
    if (!s || !s.id) return '';
    const on = stationId === s.id;
    if (!dbCanWrite() && !on) {
      return `<button type="button" class="pill" onclick="Auth.open()"
          title="Moving a pin writes the station’s coordinates, which needs a signed-in session"
          >📍 Sign in to move this pin</button>`;
    }
    return `<button type="button" class="pill${on ? ' is-on' : ''}"
        onclick="MapMovePin.${on ? 'cancel' : 'start'}('${escAttr(s.id)}')"
        >📍 ${label(s.id)}</button>`;
  }

  // Both affordances, wherever they currently are. The editor button is
  // repainted in place rather than by re-rendering the card, which would throw
  // away whatever else is half-typed into the form; the callout is closed,
  // because a popup that stays open over the pin is the thing being dragged.
  function repaintButtons() {
    const s  = station() || (state.data && state.data.stations.find(x => x.id === state.editorId));
    const el = document.getElementById('ef-movepin');
    if (el && s) el.outerHTML = editorButtonHtml(s);
    if (map) map.closePopup();
    // The station card draws this pill too (#175), and unlike the callout it
    // is not rebuilt on its next open — so it is repainted here, on every
    // change of the mode, or its pill would go on offering to start a move
    // that has already started. Guarded because this module also serves a
    // page that has no card.
    if (typeof repaintStnCard === 'function') repaintStnCard();
  }

  // ── The mode ───────────────────────────────────────────────────────────────

  function moveTo(lat, lon, { silent = false } = {}) {
    at = [round(lat), round(lon)];
    if (marker) marker.setLatLng(at);
    if (leader) leader.setLatLngs([from || at, at]);
    repaintPanel();
    if (!silent) {
      const km = movedKm();
      mapNote(`Pin at ${at[0].toFixed(DP)}, ${at[1].toFixed(DP)}`
            + `${km == null ? '' : ` — ${fmtKm(km)} from where it was`}`, 4000);
    }
  }

  function onMapClick(e) {
    // A draw tool owns its own clicks, and it also puts `pointer-events: none`
    // on every marker layer — so one armed after this mode started would make
    // the pin undraggable *and* eat the click meant to move it. Arming disarms
    // it (start(), below); this is the belt to that pair of braces.
    if (!stationId || state.draw.tool) return;
    moveTo(e.latlng.lat, e.latlng.lng);
  }

  function onKey(e) {
    if (e.key === 'Escape' && stationId) { e.preventDefault(); cancel(); }
  }

  function teardown() {
    if (map) {
      map.off('click', onMapClick);
      if (panel) map.removeControl(panel);
    }
    document.removeEventListener('keydown', onKey, true);
    if (marker) marker.remove();
    if (ghost)  ghost.remove();
    if (leader) leader.remove();
    marker = ghost = leader = panel = null;
    stationId = at = from = null;
  }

  function start(id) {
    const s = state.data && state.data.stations.find(x => x.id === id);
    if (!s) return;
    if (!map) {                          // not on the Stations tab, or no map yet
      mapNote('The pin is moved on the Stations map — open that tab first.', 6000);
      return;
    }
    // Arming the station that is already armed is nothing to do. Without this
    // a second start() for the same id overwrote the marker, ghost, leader and
    // panel references, and the first set stayed on the map with nothing left
    // holding them — a repaint that is late (#175's card was) or a double
    // press was enough to reach it.
    if (stationId === id) return;
    if (stationId && stationId !== id) teardown();   // one station at a time

    // The Stations map has no exclusive-mode registry — link-budget.js's
    // `if (!S().picking || state.draw.tool) return` is the whole precedent —
    // so this says out loud which other modes it is taking the map from. A
    // draw tool has to go because `.mn-drawing` sets `pointer-events: none` on
    // the marker pane, which makes a draggable marker undraggable; the link
    // budget's picker has to go because it answers the same click.
    if (state.draw && state.draw.tool) MapDraw.setTool('');
    LinkBudget.setPicking(false);

    // The coordinates are edited in the card, so the card has to be on this
    // station: Save writes into its boxes, and an operator who cannot see the
    // numbers change has been given no way to check them.
    if (state.selectedId !== id) selectStation(id);

    stationId = id;
    from = (s.lat != null && s.lon != null) ? [s.lat, s.lon] : null;
    // A station with no coordinates starts in the middle of what is on screen —
    // there is nowhere else honest to put it, and the whole point of the move is
    // that it is about to be told where it goes.
    const c = map.getCenter();
    at = from ? [round(from[0]), round(from[1])] : [round(c.lat), round(c.lng)];

    if (from) {
      // Where it was. Dashed and hollow, so it reads as a mark rather than as a
      // second station, and under the draggable pin rather than over it.
      ghost = L.circleMarker(from, {
        radius: 9, color: cssVar('--muted', '#6b7a89'), weight: 2, dashArray: '3,3',
        fill: false, interactive: false,
      }).addTo(map);
      leader = L.polyline([from, at], {
        color: cssVar('--accent', '#0b5cab'), weight: 2, dashArray: '5,5', interactive: false,
      }).addTo(map);
    }

    marker = L.marker(at, { icon: icon(), draggable: true, autoPan: true, zIndexOffset: 3000 })
      .addTo(map);
    marker.on('drag',    e => moveTo(e.latlng.lat, e.latlng.lng, { silent: true }));
    marker.on('dragend', e => moveTo(e.target.getLatLng().lat, e.target.getLatLng().lng));

    map.on('click', onMapClick);
    document.addEventListener('keydown', onKey, true);
    addPanel();
    map.panInside(at, { padding: [60, 60] });

    // The mode takes the map, and the station card gives way to it the way
    // the callout does (#175): on a phone the card is a sheet across the
    // bottom of the map, over the panel this just added, and on a desktop it
    // is a rectangle a dragged pin can land under. A pin click brings it back
    // with the pill reading "cancel", which repaintButtons keeps true.
    if (typeof closeStnCard === 'function') closeStnCard(false);
    repaintButtons();
    announce(`Moving the pin for ${s.name || id}. Drag it, or click the map. Escape cancels.`);
    mapNote('Drag the pin, or click the map where the station should be. Escape cancels.', 8000);
  }

  function cancel() {
    if (!stationId) return;
    const s = station();
    teardown();
    repaintButtons();
    mapNote('Pin left where it was.', 3000);
    announce(`Move cancelled. ${(s && s.name) || 'The station'} is where it was.`);
  }

  // Save writes the new position into the form and then presses the card's own
  // Save, rather than writing to the database itself. One write path, one place
  // the stale-write stamp is handled, one status line saying what happened — and
  // an operator who was halfway through editing something else in the same card
  // gets the save they would have got from the button they can see.
  function save() {
    if (!stationId || !at) return;
    const id  = stationId;
    const s   = station();
    const lat = at[0], lon = at[1];
    const km  = movedKm();

    teardown();
    repaintButtons();

    const where = `${lat.toFixed(DP)}, ${lon.toFixed(DP)}`;
    announce(`Pin moved${km == null ? '' : ` ${fmtKm(km)}`} to ${where}.`);

    // The two boxes on the form are what editorSave() reads, so they are what
    // this writes — and the draft with them, because editorReadForm() starts
    // from the draft and a key it does not read would otherwise carry the old
    // value into the request.
    //
    // Nothing here re-renders the card. renderStationEditorCard() draws an
    // existing station from the *live record*, not from the draft, so a
    // re-render between here and the save would put the old coordinates back in
    // the boxes and save those instead — which is the whole move, undone,
    // silently.
    const latEl = document.getElementById('ef-lat');
    const lonEl = document.getElementById('ef-lon');
    if (state.editorId === id) state.editorDraft = { ...state.editorDraft, lat, lon };
    if (latEl) latEl.value = lat;
    if (lonEl) lonEl.value = lon;

    // No boxes means no form on screen, and editorReadForm() reads lat/lon from
    // the DOM unconditionally: saving now would write null over both. Say so
    // and stop — the station is where it was, which is recoverable, and a
    // station with no coordinates is not.
    if (!latEl || !lonEl) {
      mapNote(`The station editor is not open, so ${where} has not been saved.`, 8000);
      return;
    }

    if (!dbCanWrite() || !editorWritesGoToDatabase()) {
      // Nothing is thrown away: the numbers are in the boxes, and the card's own
      // Save says the rest. This is the same refusal editorSave() would give,
      // said before the round trip rather than after it.
      setEditorStatus({
        kind: 'error',
        text: `The pin is at ${where} in the form above, and nothing has been saved:`
            + ` ${dbCanWrite() ? 'the station list on screen did not come from the datastore.'
                               : 'saving coordinates needs a signed-in session.'}`,
      });
      return;
    }

    // editorSave() reads the form, so the boxes above are the input to this. It
    // refreshes the map layers itself on success, which is what actually moves
    // the station's own pin from where it was to where this one was dragged.
    editorSave();
  }

  return {
    attach(m) { map = m; },

    // The map is being torn down (tab switch or re-render). An armed move dies
    // with it rather than leaving a marker pointing at a map that is gone; the
    // coordinates the operator had dragged to are not saved, because they never
    // pressed Save.
    detach() { teardown(); map = null; },

    start, cancel, save,
    editorButtonHtml, popupLinkHtml, repaintButtons,

    // Which station is armed, or null. Read by the editor card so its button
    // renders in the right state after the card is rebuilt for another reason.
    armed() { return stationId; },
  };
})();
