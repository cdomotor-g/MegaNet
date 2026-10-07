// MegaNet — map-twin.js
//
//   MapTwin   the Digital Twin inside the Stations map: at close zoom, with a
//             station under the view, the map offers the twin — a card on the
//             map saying what imagery covers the station, and a button — and
//             when it is pressed the map's rectangle hands over to it: the
//             site's ground to 1 m, the imagery, the station as built, the
//             figure, and the radio paths as the map has coloured them. ← Map,
//             Escape or a wheel out gives the map back.
//
// After core.js, digital-twin.js and map-3d.js, before init.js — index.html
// holds the order and the reasons. Reaches back to core.js for `state`,
// esc, escAttr, announce and acmaHaversineKm; across to digital-twin.js for
// the scene (DigitalTwin.stageHtml, mountAt, stop, prefetch, patchSize), to
// app.js for the Leaflet map it is attached to, and to station-trail.js for
// the pill that stands at the top of its stage. Every one of those is a
// runtime call from inside this file's own functions, so its position among
// the modules is free. Nothing executes at load (`npm run toplevel`).
//
// ── What this is, next to ⛰️ 3-D ─────────────────────────────────────────
//
// The Stations map has two three-dimensional views now, and they are one
// mode at two scales rather than two modes. ⛰️ (map-3d.js) is the network on
// its terrain: tens of kilometres, every pin and every link, the line-of-sight
// sheets over the hops, a map camera that tilts and turns. This is the site:
// a few hundred metres, the State's LiDAR where it exists, a pole you can
// stand beside. Neither replaces the other, because neither can answer the
// other's question — a map camera cannot be put at eye height and a site
// twin cannot show a 60 km hop — so the hand-over is by *zoom*, which is the
// one thing that already says which question is being asked — and then by a
// press, because a zoom is a question and not yet a request:
//
//   * At zoom 17 and closer (about a kilometre across on a laptop's map) with
//     a station under the view, a card comes up on the map, whichever view
//     was showing — the 2-D map or the 3-D one (the 3-D camera follows the
//     2-D map's zoom, map-3d.js, so both arrive here the same way). It names
//     the station and what the twin would show that the map does not: the
//     aerial photography that covers the station, at the resolution and the
//     date the State's own catalogue gives for that point — "10 cm, May
//     2021" — or, outside Queensland's program, that the imagery is Esri's.
//     "🧊 Open the digital twin" hands the rectangle over; × puts the card
//     away for that station until the map is next zoomed out past 17.
//   * The twin used to take the map over at 17 on its own. It did not ask,
//     and a map that turns into something else at a zoom level is a map
//     that cannot be used at that zoom level — a pin could not be clicked at
//     17 without a WebGL scene arriving over it. Now the map stays a map at
//     every zoom, and the twin is one press away wherever it has something
//     to add.
//   * ← Map and Escape give the map back as it was, at the zoom it was at,
//     with the card on it again (it is the way back in). Wheeling out past
//     the twin's widest orbit gives it back one zoom level out, which is
//     where that gesture was heading.
//
// Asking the catalogue is one small request per station, made when the card
// comes up and remembered for the session (DigitalTwin.imageryAt); the card
// is up at once with the station's name and says "checking the imagery…"
// until it answers, and a catalogue that does not answer leaves the card
// saying what the twin is without claiming a resolution.
//
// "A station under the view" is, in order: the station on the card (the map's
// memory of what you were looking at), the selected station, or the nearest
// station to the map's centre — each only if it is within half a patch of the
// centre, so a twin is never built for a pin off the edge of the screen.
//
// ── What it costs, and when ───────────────────────────────────────────────
//
// The offer is on by default and is a switch in 🗺️ Map display. Nothing is
// fetched until a station qualifies. From zoom 14 with a station under the
// view the twin's ground and imagery are fetched ahead (DigitalTwin.prefetch)
// into the same bounded caches a build reads, so the hand-over, when it is
// asked for, is a build from memory rather than a wait — which is what makes
// it read as a transition and not a stall. The renderer itself (three.js)
// arrives on the first hand-over of the session and never for a session that
// does not ask for one.
//
// ── The seams ──────────────────────────────────────────────────────────────
//
// The overlay is a child of the Leaflet container, above the 3-D canvas and
// below the control corners (styles.css, #map-twin — the same window map-3d.js
// works in, one step up). Leaflet's own handlers are held off while it is up,
// for map-3d.js's reason: a drag on the twin must not also drag the map
// under it. The station card stays above both. The twin's own scene, controls
// and teardown are digital-twin.js's; this file only decides *when*, and
// gives it a host.
const MapTwin = (function () {
  // The offer's zoom. z17 is ~1.1 m/px at Queensland's latitudes, so a
  // 1,000 px map shows about a kilometre — the 400 m default patch and its
  // surroundings, which is the moment a pin has become a place.
  const ZOOM = 17;
  // From here in, a station under the view has its patch fetched ahead.
  const PREFETCH_ZOOM = 14;
  const LF_HANDLERS = ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'];

  let map = null;
  let host = null;
  let up = false;
  let stationId = null;
  let lfHeld = [];
  let prefetched = null;
  let offerEl = null;            // the card on the map, while it exists
  let offerId = null;            // the station it is offering
  const dismissed = new Set();   // stations put away with ×, until the map is next zoomed out past ZOOM
  const told = new Set();        // stations the live region has already announced an offer for

  function enabled() { return typeof state === 'undefined' || state.mapTwinAuto !== false; }

  function stationById(id) {
    return (state.data && state.data.stations || []).find(s => s.id === id) || null;
  }

  // `isFinite(null)` is true, and seven stations in stations.json have no
  // position: null is not the Gulf of Guinea.
  function located(s) { return !!s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon); }

  // Half the patch, in metres: how far from the map's centre a station may be
  // and still be the one this view is about.
  function reach() {
    const size = typeof DigitalTwin !== 'undefined' && DigitalTwin.patchSize ? DigitalTwin.patchSize() : 400;
    return size / 2;
  }

  function metresFromCentre(s) {
    const c = map.getCenter();
    return acmaHaversineKm(c.lat, c.lng, s.lat, s.lon) * 1000;
  }

  // The station under the view, if there is one.
  function candidate() {
    if (!map || !state.data) return null;
    const R = reach();
    const within = s => located(s) && metresFromCentre(s) <= R;
    const onCard = state.stnCard && state.stnCard.id ? stationById(state.stnCard.id) : null;
    if (within(onCard)) return onCard;
    const selected = state.selectedId ? stationById(state.selectedId) : null;
    if (within(selected)) return selected;
    let best = null, bestM = R;
    for (const s of state.data.stations) {
      if (!located(s)) continue;
      const m = metresFromCentre(s);
      if (m <= bestM) { bestM = m; best = s; }
    }
    return best;
  }

  // Called on every move and zoom of the map, and whenever the card or the
  // selection changes: the one place that decides what the map shows at this
  // zoom — nothing, the offer, or (once it has been asked for) the twin.
  function sync() {
    if (!map || typeof DigitalTwin === 'undefined') return;
    const z = map.getZoom();
    // The switch in Map display is the offer's: a twin opened by name (the
    // card's pill, the side panel's pane) stays up with it off.
    const cand = candidate();
    const st = enabled() ? cand : null;
    // Zoomed out past the offer: every × is forgotten, so the next time in
    // the card comes up again.
    if (z < ZOOM) dismissed.clear();
    // The twin is up because it was asked for, and it follows the map: a far
    // station's name pressed under the stage moves the map to that station
    // at this zoom, and the twin goes with it (DigitalTwin.followPath). The
    // map moved out from under it — zoomed out, or off every station — takes
    // it down, and what is left is the map, offering again if it still can.
    if (up) {
      if (cand && z >= ZOOM) { if (stationId !== cand.id) enter(cand); return; }
      leave(false);
    }
    if (st && z >= ZOOM && !dismissed.has(st.id)) showOffer(st);
    else hideOffer();
    if (st && z >= PREFETCH_ZOOM && prefetched !== st.id) {
      prefetched = st.id;
      DigitalTwin.prefetch(st.id);
    }
  }

  // ── The offer ─────────────────────────────────────────────────────────────
  // A card at the top of the map, under the note line (.map-note, which says
  // passing things there and must not be covered), between the two control
  // corners — above the 3-D canvas, since the offer is made in both views.
  // It is a region with a name rather than a dialog: it asks nothing and
  // takes no focus, it is simply there to be pressed or put away.
  function makeOffer() {
    const el = map && map.getContainer();
    if (!el) return null;
    if (offerEl && offerEl.parentNode === el) return offerEl;
    offerEl = document.createElement('div');
    offerEl.id = 'map-twin-offer';
    offerEl.className = 'map-twin-offer';
    offerEl.setAttribute('role', 'region');
    offerEl.setAttribute('aria-label', 'Digital twin available');
    offerEl.hidden = true;
    if (typeof L !== 'undefined' && L.DomEvent) {
      L.DomEvent.disableClickPropagation(offerEl);
      L.DomEvent.disableScrollPropagation(offerEl);
    }
    el.appendChild(offerEl);
    return offerEl;
  }

  // What the twin would show that the map does not, in words, from what the
  // State's imagery catalogue says covers the station. `im` is
  // DigitalTwin.imageryAt()'s answer: undefined while it is being asked,
  // null when it could not be, { outside } beyond Queensland's program, or
  // the finest tier over the point.
  function resText(m) { return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(m < 10 ? 1 : 0)} m`; }
  function offerWords(st, im) {
    const name = `<strong>${esc(st.name)}</strong>`;
    if (im === undefined) return { title: 'Digital twin available', line: `Checking the aerial imagery over ${name}…` };
    if (im === null) return { title: 'Digital twin available',
      line: `${name}'s ground in 3-D, with the aerial imagery draped over it and the station as built.` };
    if (im.outside) return { title: 'Digital twin available',
      line: `${name}'s ground in 3-D under Esri World Imagery — outside Queensland's aerial program, so no finer photography is known here.` };
    const when = im.when ? `, ${esc(im.when)}` : '';
    const what = im.satellite ? 'Satellite imagery' : 'Aerial photography';
    const sharp = im.res_m <= 0.5;
    return {
      title: sharp ? 'High-resolution imagery here' : 'Digital twin available',
      line: `${what} at <strong>${esc(resText(im.res_m))}</strong> (${esc(im.label)}${when}) covers ${name}. `
          + (sharp ? 'See it close up, on the ground in 3-D, with the station as built — and put the pin exactly where the station stands.'
                   : `It is the finest the State holds here; the twin drapes it over the ground in 3-D, with the station as built.`),
    };
  }
  function offerHtml(st, im) {
    const w = offerWords(st, im);
    return `
      <div class="map-twin-offer-body">
        <p class="map-twin-offer-title"><span aria-hidden="true">🛰️</span> ${esc(w.title)}</p>
        <p class="small map-twin-offer-line">${w.line}</p>
      </div>
      <div class="map-twin-offer-actions">
        <button type="button" class="primary map-twin-offer-open" onclick="MapTwin.open()"
                title="Hand the map over to ${escAttr(st.name)}'s digital twin — ← Map, Escape or a wheel out comes back"
                ><span aria-hidden="true">🧊</span> Open the digital twin</button>
        <button type="button" class="map-twin-offer-x" onclick="MapTwin.dismiss()"
                title="Not now — put this away until the map is next zoomed out"
                aria-label="Not now: put the digital twin offer away"><span aria-hidden="true">×</span></button>
      </div>`;
  }

  function showOffer(st) {
    const el = makeOffer();
    if (!el) return;
    if (offerId !== st.id) {
      offerId = st.id;
      el.innerHTML = offerHtml(st, undefined);
      const ask = typeof DigitalTwin.imageryAt === 'function' ? DigitalTwin.imageryAt(st.lat, st.lon) : Promise.resolve(null);
      ask.catch(() => null).then(im => {
        if (offerId !== st.id || !offerEl) return;
        offerEl.innerHTML = offerHtml(st, im);
        // Said once per station a session, when the words are final: the
        // offer is the result of the zoom the operator just made.
        if (!told.has(st.id) && !offerEl.hidden) {
          told.add(st.id);
          const w = offerWords(st, im);
          announce(`${w.title}: ${st.name}. The Open the digital twin button is at the top of the map.`);
        }
      });
    }
    el.hidden = false;
  }

  function hideOffer() {
    if (offerEl) offerEl.hidden = true;
    offerId = null;
  }

  function makeHost() {
    const el = map && map.getContainer();
    if (!el) return null;
    let h = el.querySelector('#map-twin');
    if (!h) {
      h = document.createElement('div');
      h.id = 'map-twin';
      // Leaflet's own way of keeping a control's clicks and wheel off the map
      // under it — the same calls its controls make.
      if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.disableClickPropagation(h);
        L.DomEvent.disableScrollPropagation(h);
      }
      el.appendChild(h);
    }
    return h;
  }

  function holdLeaflet() {
    lfHeld = LF_HANDLERS.filter(k => map[k] && map[k].enabled());
    for (const k of lfHeld) map[k].disable();
  }

  function releaseLeaflet() {
    if (map && map.getPane && map.getPane('mapPane')) {
      for (const k of lfHeld) { try { map[k].enable(); } catch (_) {} }
    }
    lfHeld = [];
  }

  function overlayHtml(st) {
    // The head is inset from the right edge only: ↺ (the map's own reset)
    // stands above this overlay top-right on purpose, and the zoom buttons
    // top-left stand down while the twin is up (the stylesheet hides them:
    // there is no map to zoom, and ← Map is the way out), which gives a
    // phone's bar the room its third button needs.
    // One row, whatever the width: the words on the buttons go below `sm`
    // the way the banner's do (.hdr-label), the title truncates, and the
    // status, the paths, the company and the credit line are each one line
    // with the whole text as their tooltip (the
    // field photos' line among them: one line, its spots as buttons). The
    // notes are folded under a one-line count that opens over the stage
    // rather than in front of it: a map on a phone is 340 px tall, and three
    // notes of four lines each once left the stage no height at all.
    return `
      <div class="map-twin-head">
        <div class="map-twin-bar">
          <button type="button" class="map-twin-back" onclick="MapTwin.leave()"
                  title="Back to the map, one zoom level out">← Map</button>
          <span class="map-twin-title" title="${escAttr(st.name)}${st.station_number ? ` · ${escAttr(st.station_number)}` : ''}${st.proposed ? ' · proposed, not yet established' : ''}"><strong>${esc(st.name)}</strong>${
            typeof proposedTagHtml === 'function' ? proposedTagHtml(st, { short: true }) : ''}
            <span class="small map-twin-label">digital twin${st.station_number ? ` · ${esc(st.station_number)}` : ''}</span></span>
          <span class="button-group map-twin-actions">
            <button type="button" id="twin-walk" aria-pressed="false" onclick="DigitalTwin.toggleWalk()"
                    title="Point of view: stand on the ground at eye height, walk with the keys, climb the ladder"><span aria-hidden="true">👁</span><span class="map-twin-label"> POV</span><span class="sr-only">Point of view</span></button>
            <button type="button" id="twin-point" aria-pressed="false" onclick="DigitalTwin.togglePoint()"
                    title="Point where you are looking, for whoever is here with you — Space held in the POV does the same"><span aria-hidden="true">☝</span><span class="map-twin-label"> Point</span><span class="sr-only">Point</span></button>
            <button type="button" onclick="DigitalTwin.resetView()" title="Back to the opening view of the pole"><span aria-hidden="true">↺</span><span class="map-twin-label"> View</span><span class="sr-only">Reset the view</span></button>
            <button type="button" id="twin-movepin-btn" aria-pressed="false" onclick="DigitalTwin.toggleMovePin()"
                    title="Move this station's pin to where the station stands on the imagery, and save the position"><span aria-hidden="true">📍</span><span class="map-twin-label"> Move pin</span><span class="sr-only">Move this station's pin</span></button>
            <button type="button" id="twin-orient-btn" aria-pressed="false" onclick="DigitalTwin.toggleOrient()"
                    title="Turn the station to the way it faces on the ground — the side its door or ladder is on — and save the bearing"><span aria-hidden="true">🔄</span><span class="map-twin-label"> Orientation</span><span class="sr-only">Turn this station to the way it faces</span></button>
            <button type="button" class="map-twin-wide" onclick="MapTwin.openPane()"
                    title="The twin's settings, the ground truth and the .glb for Blender — the 🧊 pane of the side panel"><span aria-hidden="true">⚙</span><span class="map-twin-label"> Settings</span><span class="sr-only">The twin's settings, in the side panel</span></button>
            ${DigitalTwin.infoToggleHtml()}
          </span>
        </div>
        <div class="twin-info map-twin-info" id="twin-info">
          <p class="twin-status map-twin-status" id="twin-status" role="status">Building…</p>
          <p class="small twin-paths map-twin-paths" id="twin-paths" hidden></p>
          <p class="small twin-photos map-twin-photos" id="twin-photos" hidden></p>
          <p class="small twin-flood map-twin-flood" id="twin-flood" hidden></p>
          <p class="small twin-peers map-twin-peers" id="twin-peers" hidden></p>
          <p class="small twin-site map-twin-site" id="twin-site" hidden></p>
          <details class="map-twin-notes" id="twin-notes-fold" hidden>
            <summary class="map-twin-notes-sum"><span aria-hidden="true">⚠</span> <span id="twin-notes-count">0 notes</span></summary>
            <ul class="twin-notes" id="twin-notes"></ul>
          </details>
        </div>
      </div>
      ${DigitalTwin.stageHtml()}
      <p class="small map-twin-attrib" id="twin-attrib"></p>`;
  }

  function enter(st) {
    host = makeHost();
    if (!host) return;
    hideOffer();
    const wasUp = up;
    if (wasUp) DigitalTwin.stop();
    host.innerHTML = overlayHtml(st);
    host.classList.add('is-on');
    if (!wasUp) holdLeaflet();
    up = true;
    stationId = st.id;
    // `why` is the twin's own way out: 'wheel' for a wheel past the widest
    // orbit, 'escape' for the key.
    DigitalTwin.mountAt(st.id, { leave: why => leave(why === 'wheel') });
    // The side panel's 🧭 and tilt buttons are this camera's now (map-3d.js
    // syncCamera) — shown, even over a flat map, and reading the twin.
    if (typeof Map3D !== 'undefined') Map3D.cameraChanged();
    // A twin opened is a station looked at, and the trail's pill moves to the
    // top of this stage, beside the flood scale (station-trail.js).
    if (typeof StationTrail !== 'undefined') StationTrail.visit(st.id);
    // The result of what the operator did — asked for the twin — said once,
    // with the way back (core.js's live-region rules).
    announce(`Digital twin of ${st.name}. Press Escape, or ← Map, for the map.`);
  }

  // Down, and the map back. `zoomOut` is the one way out that is a zoom — a
  // wheel past the twin's widest orbit — which the map answers by stepping
  // one level out, so the view that gesture was heading for is the one it
  // gets. ← Map and Escape leave the map exactly as it was: the twin was a
  // press away, not a zoom level, and the offer is back on the map for the
  // next one. A leave the map itself caused (it was zoomed out, or moved off
  // the station) changes nothing about the map.
  function leave(zoomOut, { offer = true } = {}) {
    if (!up) return;
    up = false;
    stationId = null;
    DigitalTwin.stop();
    if (host) { host.classList.remove('is-on'); host.innerHTML = ''; }
    releaseLeaflet();
    // …and the camera buttons the map's again: put away over a flat map.
    if (typeof Map3D !== 'undefined') Map3D.cameraChanged();
    // …and back beside the zoom buttons, which are back on the map.
    if (typeof StationTrail !== 'undefined') StationTrail.sync();
    // A snap, not a slide: the twin has just covered the map, so there is no
    // picture to animate from, and a zoom animation left in flight would
    // overrule the next view the operator asks for when it ends.
    if (zoomOut && map && map.getPane && map.getPane('mapPane')) {
      map.setZoom(map.getZoom() - 1, { animate: false });
    }
    // The map is back as it was, and the card with it — the setZoom above
    // has already asked, through zoomend, for anything else. Not for a map
    // that is itself going (detach).
    if (!zoomOut && offer) sync();
  }

  return {
    attach(m) {
      map = m;
      map.on('zoomend', sync);
      map.on('moveend', sync);
      sync();
    },

    // Leaving the tab, or a rebuild of the map: the twin and the offer go
    // with the container they drew into.
    detach() {
      if (map) { map.off('zoomend', sync); map.off('moveend', sync); }
      leave(false, { offer: false });
      map = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      if (offerEl && offerEl.parentNode) offerEl.parentNode.removeChild(offerEl);
      offerEl = null;
      offerId = null;
      prefetched = null;
    },

    sync,
    // ← Map on the overlay: the map back as it was.
    leave() { leave(false); },
    // The offer's two buttons.
    open() {
      if (!map || up) return;
      const st = candidate();
      if (st) enter(st);
    },
    dismiss() {
      if (offerId) dismissed.add(offerId);
      hideOffer();
      announce('Put away. Zoom out and back in to be offered the twin again.');
    },
    // ⚙ on the overlay's bar: the side panel open on the 🧊 pane — what the
    // Digital Twin tab's left column was — beside the twin it sets.
    openPane() { if (typeof setDockTab === 'function') setDockTab('twin'); },
    // A station's twin, asked for by name rather than by zoom (the station
    // card's pill, the pane's finder, a field photo — DigitalTwin.openStation,
    // which has already made this the Stations tab): the card on the
    // station, the map at it at the offer's zoom, and the hand-over.
    openStation(id) {
      const st = stationById(id);
      if (!map || !located(st)) return false;
      // A card already up for another station moves to this one — it is the
      // twin's first choice of station (candidate), and one left on a
      // neighbour within the patch would take the twin there. No card is
      // opened otherwise: over a twin it covers the ground being looked at.
      if (typeof showStationCard === 'function' && state.stnCard && state.stnCard.id && state.stnCard.id !== st.id) showStationCard(st.id);
      const was = up ? stationId : null;
      if (map.getPane && map.getPane('mapPane')) {
        map.setView([st.lat, st.lon], Math.max(map.getZoom(), ZOOM), { animate: false });
      }
      // The move's end may already have handed over (sync, with the twin up
      // on another station), and that build stands. Otherwise it is done here
      // — and a station asked for by name that was already up is built again,
      // as picking it on the Digital Twin tab did: the operator asked.
      if (!up || stationId !== st.id || was === st.id) enter(st);
      return true;
    },

    // The switch in 🗺️ Map display. Remembered: it is how an operator reads
    // the map, not something they are doing right now.
    setEnabled(on) {
      state.mapTwinAuto = !!on;
      try { localStorage.setItem('mn-map-twin', on ? 'on' : 'off'); } catch (_) {}
      sync();
      const note = document.getElementById('map-twin-note');
      if (note) note.innerHTML = noteHtml();
    },

    noteHtml,
    active() { return up; },
    station() { return stationId; },
    zoom: ZOOM,
    prefetchZoom: PREFETCH_ZOOM,
    // For the check: what the rule would pick right now.
    _candidate: candidate,
  };

  function noteHtml() {
    if (!enabled()) return 'Off. Nothing is offered at close zoom; a station\'s twin still opens from 🧊 Digital twin on its card, or from the 🧊 pane of the side panel.';
    return `From zoom ${ZOOM} in, with a station under the view — the one on the card, the selected one, or the `
         + 'nearest to the centre — a card at the top of the map offers that station\'s digital twin and says what '
         + 'aerial imagery covers it, at what resolution and when it was flown. Press 🧊 Open the digital twin and the '
         + 'map hands over: its ground to 1 m where the State holds LiDAR, the imagery, the station as built and the '
         + 'radio paths as this map colours them. Press ← Map or Escape to come back, or wheel out past the edge. '
         + 'In ⛰️ 3-D the same zoom makes the same offer.';
  }
})();
if (typeof window !== 'undefined') window.MapTwin = MapTwin;
