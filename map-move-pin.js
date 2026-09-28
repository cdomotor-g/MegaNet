// MegaNet — map-move-pin.js
//
//   MapMovePin   move a station's pin to where the station actually is: arm
//                it, drag the pin (or click the ground under it), read the new
//                coordinates back, save — on the Stations map in 2-D, in its
//                ⛰️ 3-D view, and in the Digital Twin, in the map or on its tab.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, cssVar, announce,
// acmaHaversineKm and fmtKm; across to app.js for the Stations map itself,
// mapNote and selectStation; to auth.js for Auth.open() from the callout's
// pill; to station-editor.js for editorSave, stationSavePosition and the
// #ef-lat / #ef-lon boxes it writes into; to map-draw.js, link-budget.js and
// map-here.js, to take the map's other interactive modes off before it takes
// the clicks; to datastore.js for dbCanWrite,
// editorWritesGoToDatabase and setEditorStatus; and to map-3d.js and
// digital-twin.js, which draw the pin in their own scenes from drawn() and
// are told when it changes.
//
// The IIFE body declares nothing but nulls, so this file's position among the
// modules is free — checked rather than asserted (`npm run toplevel`). It
// builds no Leaflet map of its own and starts no timer, so it registers no live
// map; app.js attaches and detaches it with the Stations map.
//
// ── Three places to move a pin, one mode ─────────────────────────────────────
//
// The pin is one thing — a station, where it was, where it is going — and it
// is drawn wherever the station is being looked at. This file owns it, and
// the Leaflet marker below is its 2-D drawing. The two other renderers draw it
// the way they draw everything else of the map's (map-3d.js's header, "the
// seam"): they read drawn(), put the pin in their own scene, and hand what the
// pointer did back through moveTo(). Neither re-derives anything, so the three
// cannot disagree about where the pin is.
//
//   * ⛰️ 3-D: the WebGL canvas covers every Leaflet pane, so the Leaflet
//     marker was there all along and nobody could see it or reach it — the
//     mode armed, the panel came up in its corner, and the pin was under the
//     canvas. Worse, an empty-ground click fell through to Leaflet and moved
//     the pin to the *flat* map's coordinate for that pixel, which on a tilted
//     camera is not the ground the operator pointed at. map-3d.js now draws a
//     draggable pin of its own on the terrain and routes a click on the
//     ground here with the camera's own coordinate.
//   * The Digital Twin, where the imagery is 10–20 cm and the ground is the
//     State's LiDAR: the best place there is to put a pin exactly where a
//     station stands. The twin draws the pin as a post on its ground, drags
//     it across the terrain, and its own panel on the stage reads the same
//     numbers the map's does. In the map's overlay the map's panel stands
//     down for it; on the Digital Twin tab, where there is no map at all,
//     the mode is armed from the twin's own 📍 button.
//
// Saving is the station editor's write path either way. On the Stations tab
// the numbers go into the editor card's boxes and the card's own Save is
// pressed, as before. On the Digital Twin tab there is no form, so the same
// document goes through stationSavePosition() (station-editor.js): the
// database's current copy of the station, read when Save is pressed, its lists
// left out so save_station() leaves them alone, and the two numbers changed.
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
  let onMap = false;              // armed with the Stations map under it (else: the twin's tab alone)
  let saving = false;             // a save from the twin is in flight
  let message = null;             // what the panel says under the numbers: { kind, text } or null

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

  // `twin` is the twin's copy of the panel, on its stage: the words say what
  // is dragged there (a post on the ground, not a pin on a map).
  function panelHtml({ twin = false } = {}) {
    const s    = station();
    const km   = movedKm();
    const name = (s && s.name) || 'this station';
    // Under a metre, the distance moved is said in centimetres: in the twin,
    // on 10 cm imagery, that is the scale the pin is being put right at.
    const moved = km == null ? 'new position' : km < 0.001 ? `${Math.round(km * 100000)} cm` : fmtKm(km);
    const msg = message ? `<p class="small mn-movepin-msg ${message.kind === 'error' ? 'txt-bad' : message.kind === 'ok' ? 'txt-ok' : ''}" role="status">${esc(message.text)}</p>` : '';
    return `
      <div class="mn-movepin-head">
        <strong>Moving the pin</strong>
        <span class="mn-movepin-name">${esc(name)}</span>
      </div>
      <p class="mn-movepin-hint">${twin ? 'Drag the amber post, or click the ground where the station stands.'
                                       : 'Drag the pin, or click the map where the station should be.'}</p>
      <dl class="mn-movepin-read">
        <dt>Latitude</dt><dd>${at ? at[0].toFixed(DP) : '—'}</dd>
        <dt>Longitude</dt><dd>${at ? at[1].toFixed(DP) : '—'}</dd>
        <dt>Moved</dt><dd>${moved}</dd>
      </dl>
      ${msg}
      <div class="mn-movepin-actions pill-row">
        <button type="button" class="pill is-on" onclick="MapMovePin.save()" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save position'}</button>
        <button type="button" class="pill" onclick="MapMovePin.cancel()" ${saving ? 'disabled' : ''}>Cancel</button>
      </div>`;
  }

  // Repaint the readout without rebuilding the control — it is redrawn on every
  // mousemove of a drag, and replacing the container would drop the drag. The
  // twin's copy on its stage, when there is one, is kept to the same numbers.
  function repaintPanel() {
    const el = panel && panel.getContainer();
    if (el) el.innerHTML = panelHtml();
    const tp = document.getElementById('twin-movepin-panel');
    if (tp) {
      const show = !!stationId && typeof DigitalTwin !== 'undefined' && DigitalTwin.showsPin && DigitalTwin.showsPin();
      tp.hidden = !show;
      tp.innerHTML = show ? panelHtml({ twin: true }) : '';
    }
  }

  // The other renderers, told that the pin changed: each reads drawn() and
  // redraws its own copy. Guarded — this module also serves pages that have
  // neither loaded.
  function tell() {
    if (typeof Map3D !== 'undefined' && Map3D.movePinChanged) Map3D.movePinChanged();
    if (typeof DigitalTwin !== 'undefined' && DigitalTwin.movePinChanged) DigitalTwin.movePinChanged();
    repaintPanel();
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
    if (!stationId || !isFinite(lat) || !isFinite(lon)) return;
    at = [round(lat), round(lon)];
    if (message && message.kind !== 'busy') message = null;   // a new position is a new question
    if (marker) marker.setLatLng(at);
    if (leader) leader.setLatLngs([from || at, at]);
    tell();
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
    // In 3-D the camera answers the click with its own coordinate (pick, from
    // map-3d.js) and stops it there; one that still reaches Leaflet from under
    // the canvas carries the flat map's coordinate for that pixel, which on a
    // tilted camera is somewhere else. Belt and braces again.
    if (typeof Map3D !== 'undefined' && Map3D.active && Map3D.active()) return;
    moveTo(e.latlng.lat, e.latlng.lng);
  }

  // Escape is the move's before it is anything else's: in the twin it would
  // otherwise also leave the twin, or the POV, in the same press. Stopped
  // here, in the capture phase at the document, so one press does one thing.
  function onKey(e) {
    if (e.key === 'Escape' && stationId && !saving) { e.preventDefault(); e.stopPropagation(); cancel(); }
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
    onMap = false;
    saving = false;
    message = null;
    tell();
  }

  // Where the pin can be moved from: the Stations map (onMap), or the Digital
  // Twin's tab with this station on it (DigitalTwin.showing), which has no map.
  function twinShowing(id) {
    return typeof DigitalTwin !== 'undefined' && DigitalTwin.showing && DigitalTwin.showing(id);
  }

  function start(id) {
    const s = state.data && state.data.stations.find(x => x.id === id);
    if (!s) return;
    const twinOnly = !map && twinShowing(id);
    if (!map && !twinOnly) {             // not on the Stations tab or the twin, or no map yet
      mapNote('The pin is moved on the Stations map or in the Digital Twin — open one first.', 6000);
      announce('The pin is moved on the Stations map or in the Digital Twin — open one first.');
      return;
    }
    // Arming the station that is already armed is nothing to do. Without this
    // a second start() for the same id overwrote the marker, ghost, leader and
    // panel references, and the first set stayed on the map with nothing left
    // holding them — a repaint that is late (#175's card was) or a double
    // press was enough to reach it.
    if (stationId === id) return;
    if (stationId && stationId !== id) teardown();   // one station at a time

    stationId = id;
    onMap = !!map;
    from = (s.lat != null && s.lon != null) ? [s.lat, s.lon] : null;

    if (!onMap) {
      // The Digital Twin's tab: no map, no editor card. The twin draws the pin
      // and its panel, and Save goes through stationSavePosition(), which
      // reads the station's current copy from the database when it is pressed.
      at = [round(from[0]), round(from[1])];
      document.addEventListener('keydown', onKey, true);
      tell();
      announce(`Moving the pin for ${s.name || id}. Drag the amber post, or click the ground where the station stands. Escape cancels.`);
      return;
    }

    // The Stations map has no exclusive-mode registry — link-budget.js's
    // `if (!S().picking || state.draw.tool) return` is the whole precedent —
    // so this says out loud which other modes it is taking the map from. A
    // draw tool has to go because `.mn-drawing` sets `pointer-events: none` on
    // the marker pane, which makes a draggable marker undraggable; the link
    // budget's picker has to go because it answers the same click; and What
    // is here's pick, because in 3-D it is offered the ground's clicks first.
    if (state.draw && state.draw.tool) MapDraw.setTool('');
    LinkBudget.setPicking(false);
    if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) MapHere.arm(false);

    // The coordinates are edited in the card, so the card has to be on this
    // station: Save writes into its boxes, and an operator who cannot see the
    // numbers change has been given no way to check them.
    if (state.selectedId !== id) selectStation(id);

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
    tell();
    const inTwin = typeof MapTwin !== 'undefined' && MapTwin.active && MapTwin.active();
    announce(`Moving the pin for ${s.name || id}. ${inTwin ? 'Drag the amber post, or click the ground' : 'Drag it, or click the map'}. Escape cancels.`);
    mapNote(inTwin ? 'Drag the amber post, or click the ground where the station stands. Escape cancels.'
                   : 'Drag the pin, or click the map where the station should be. Escape cancels.', 8000);
  }

  function cancel() {
    if (!stationId || saving) return;
    const s = station();
    teardown();
    repaintButtons();
    mapNote('Pin left where it was.', 3000);
    announce(`Move cancelled. ${(s && s.name) || 'The station'} is where it was.`);
  }

  // After a save that moved the station, the twin standing on it is standing
  // on the old spot: its ground is a patch centred on the station.
  function moved(id) {
    if (typeof DigitalTwin !== 'undefined' && DigitalTwin.stationMoved) DigitalTwin.stationMoved(id);
  }

  // Save from the Digital Twin's tab, where there is no form: the panel stays
  // up and says what is happening until the database has answered, because
  // there is no editor card below it to say it instead — and a refusal leaves
  // the pin where it was dragged, to be saved again once signed in.
  async function saveOffForm(id, lat, lon, where, km) {
    if (!dbCanWrite()) {
      message = { kind: 'error', text: `Not saved — moving a station needs a signed-in session. Sign in, then press Save again; the pin stays at ${where}.` };
      repaintPanel();
      return;
    }
    if (!editorWritesGoToDatabase()) {
      message = { kind: 'error', text: 'Not saved — the station list on screen did not come from the datastore, so saving it could overwrite a newer copy. Load from the datastore first.' };
      repaintPanel();
      return;
    }
    saving = true;
    message = { kind: 'busy', text: 'Saving…' };
    repaintPanel();
    try {
      await stationSavePosition(id, lat, lon);
    } catch (err) {
      saving = false;
      message = { kind: 'error', text: typeof editorSaveErrorText === 'function' ? editorSaveErrorText(err) : `Not saved — ${err.message}.` };
      repaintPanel();
      announce(message.text);
      return;
    }
    const s = station();
    saving = false;
    teardown();
    announce(`Saved: ${(s && s.name) || 'the station'} moved${km == null ? '' : ` ${fmtKm(km)}`} to ${where}.`);
    moved(id);
  }

  // Save writes the new position into the form and then presses the card's own
  // Save, rather than writing to the database itself. One write path, one place
  // the stale-write stamp is handled, one status line saying what happened — and
  // an operator who was halfway through editing something else in the same card
  // gets the save they would have got from the button they can see. Off the
  // Stations tab — the Digital Twin's own — it is saveOffForm(), above.
  async function save() {
    if (!stationId || !at || saving) return;
    const id  = stationId;
    const lat = at[0], lon = at[1];
    const km  = movedKm();
    const where = `${lat.toFixed(DP)}, ${lon.toFixed(DP)}`;
    if (!onMap) return saveOffForm(id, lat, lon, where, km);

    teardown();
    repaintButtons();
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
    // the station's own pin from where it was to where this one was dragged —
    // and a twin standing on the old spot is rebuilt on the new one.
    const before = station() || (state.data && state.data.stations.find(x => x.id === id));
    const was = before ? [before.lat, before.lon] : null;
    await editorSave();
    const after = state.data && state.data.stations.find(x => x.id === id);
    if (after && was && (after.lat !== was[0] || after.lon !== was[1])) moved(id);
  }

  return {
    attach(m) { map = m; },

    // The map is being torn down (tab switch or re-render). An armed move dies
    // with it rather than leaving a marker pointing at a map that is gone; the
    // coordinates the operator had dragged to are not saved, because they never
    // pressed Save. A move armed on the twin's own tab has no map to lose, and
    // is left to the twin (DigitalTwin.stop()).
    detach() { if (onMap) teardown(); map = null; },

    start, cancel, save,

    // For map-3d.js and digital-twin.js, which draw the pin in their own
    // scenes: the station, where it was and where it is going — or null.
    drawn() {
      if (!stationId || !at) return null;
      const s = station();
      return { id: stationId, name: (s && s.name) || stationId, at: at.slice(), from: from ? from.slice() : null, onMap, saving };
    },
    // …and what their pointers did: a drag in progress (`silent`), a drag's
    // end, or a click on the ground — each with that renderer's own
    // coordinate for the point.
    moveTo(lat, lon, opts) { moveTo(lat, lon, opts); },
    pick(lat, lon) { moveTo(lat, lon); },
    // Whether the move was armed with the Stations map under it (else on the
    // Digital Twin's tab alone).
    onMap() { return !!stationId && onMap; },
    editorButtonHtml, popupLinkHtml, repaintButtons,

    // Which station is armed, or null. Read by the editor card so its button
    // renders in the right state after the card is rebuilt for another reason.
    armed() { return stationId; },
  };
})();
