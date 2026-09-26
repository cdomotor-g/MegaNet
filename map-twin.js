// MegaNet — map-twin.js
//
//   MapTwin   the Digital Twin inside the Stations map: at close zoom, with a
//             station under the view, the map's rectangle hands over to the
//             twin — the site's ground to 1 m, the imagery, the 2 m pole, the
//             figure, and the radio paths as the map has coloured them — and
//             takes it back when the operator zooms out.
//
// After core.js, digital-twin.js and map-3d.js, before init.js — index.html
// holds the order and the reasons. Reaches back to core.js for `state`,
// esc, escAttr, announce and acmaHaversineKm; across to digital-twin.js for
// the scene (DigitalTwin.stageHtml, mountAt, stop, prefetch, patchSize), and
// to app.js for the Leaflet map it is attached to. Every one of those is a
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
// one thing that already says which question is being asked:
//
//   * At zoom 17 and closer (about a kilometre across on a laptop's map) with
//     a station under the view, the twin takes the map's rectangle, whichever
//     view was showing — the 2-D map or the 3-D one. The 3-D camera follows
//     the 2-D map's zoom (map-3d.js), so both paths arrive here the same way.
//   * Wheeling out past the twin's widest orbit, pressing Escape, or the ←
//     button on the overlay hands back: the map is set one zoom level out,
//     which is where the operator was heading, and the twin goes.
//
// "A station under the view" is, in order: the station on the card (the map's
// memory of what you were looking at), the selected station, or the nearest
// station to the map's centre — each only if it is within half a patch of the
// centre, so a twin is never built for a pin off the edge of the screen.
//
// ── What it costs, and when ───────────────────────────────────────────────
//
// The hand-over is on by default and is a switch in 🗺️ Map display. Nothing
// is fetched until a station qualifies. From zoom 14 with a station under the
// view the twin's ground and imagery are fetched ahead (DigitalTwin.prefetch)
// into the same bounded caches the tab uses, so the hand-over at 17 is a
// build from memory rather than a wait — which is what makes it read as a
// transition and not a stall. The renderer itself (three.js) arrives on the
// first hand-over of the session and never for a session that stays wide.
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
  // The hand-over zoom. z17 is ~1.1 m/px at Queensland's latitudes, so a
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

  function enabled() { return typeof state === 'undefined' || state.mapTwinAuto !== false; }

  function stationById(id) {
    return (state.data && state.data.stations || []).find(s => s.id === id) || null;
  }

  function located(s) { return !!s && isFinite(s.lat) && isFinite(s.lon); }

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
  // selection changes: the one place that decides whether the twin is up.
  function sync() {
    if (!map || typeof DigitalTwin === 'undefined') return;
    const z = map.getZoom();
    const st = enabled() ? candidate() : null;
    if (st && z >= ZOOM) {
      if (!up || stationId !== st.id) enter(st);
      return;
    }
    if (up) { leave(false); return; }
    if (st && z >= PREFETCH_ZOOM && prefetched !== st.id) {
      prefetched = st.id;
      DigitalTwin.prefetch(st.id);
    }
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
    // The head is inset from both edges: the map's corner controls — the zoom
    // buttons top-left, ↺ top-right — stand above this overlay on purpose
    // (the same window the 3-D canvas works in), and a bar under them would
    // put its first and last buttons behind them.
    // One row, whatever the width: the words on the buttons go below `sm`
    // the way the banner's do (.hdr-label), the title truncates, and the
    // status and the credit line are each one line with the whole text as
    // their tooltip — the tab has them in full. A map on a phone is 340 px
    // tall, and a head that wrapped to five rows left the stage no height at
    // all and its own text spilling over the credit line.
    return `
      <div class="map-twin-head">
        <div class="map-twin-bar">
          <button type="button" class="map-twin-back" onclick="MapTwin.leave()"
                  title="Back to the map, one zoom level out">← Map</button>
          <span class="map-twin-title" title="${escAttr(st.name)}${st.station_number ? ` · ${escAttr(st.station_number)}` : ''}"><strong>${esc(st.name)}</strong>
            <span class="small map-twin-label">digital twin${st.station_number ? ` · ${esc(st.station_number)}` : ''}</span></span>
          <span class="button-group map-twin-actions">
            <button type="button" id="twin-walk" aria-pressed="false" onclick="DigitalTwin.toggleWalk()"
                    title="Stand on the ground at eye height and walk with the keys"><span aria-hidden="true">🚶</span><span class="map-twin-label"> Walk</span><span class="sr-only">Walk</span></button>
            <button type="button" onclick="DigitalTwin.resetView()" title="Back to the opening view of the pole"><span aria-hidden="true">↺</span><span class="map-twin-label"> View</span><span class="sr-only">Reset the view</span></button>
            <button type="button" onclick="MapTwin.openTab()"
                    title="The Digital Twin tab: the settings, the ground truth, the .glb for Blender"><span aria-hidden="true">🧊</span><span class="map-twin-label"> Open the tab →</span><span class="sr-only">Open the Digital Twin tab</span></button>
          </span>
        </div>
        <p class="twin-status map-twin-status" id="twin-status" role="status">Building…</p>
        <p class="small twin-paths map-twin-paths" id="twin-paths" hidden></p>
        <ul class="twin-notes" id="twin-notes" hidden></ul>
      </div>
      ${DigitalTwin.stageHtml()}
      <p class="small map-twin-attrib" id="twin-attrib"></p>`;
  }

  function enter(st) {
    host = makeHost();
    if (!host) return;
    const wasUp = up;
    if (wasUp) DigitalTwin.stop();
    host.innerHTML = overlayHtml(st);
    host.classList.add('is-on');
    if (!wasUp) holdLeaflet();
    up = true;
    stationId = st.id;
    DigitalTwin.mountAt(st.id, { leave: () => leave(true) });
    // The result of what the operator did — zoomed in on a place — said
    // once, with the way back (core.js's live-region rules).
    announce(`Digital twin of ${st.name}. Zoom out, or press Escape, for the map.`);
  }

  // Down, and the map back. `zoomOut` is the operator's own gesture — a wheel
  // past the edge, Escape, the ← button — which the map answers by stepping
  // one level out, so the view they were heading for is the one they get.
  // A leave the map itself caused (it was zoomed out, or moved off the
  // station) changes nothing about the map.
  function leave(zoomOut) {
    if (!up) return;
    up = false;
    stationId = null;
    DigitalTwin.stop();
    if (host) { host.classList.remove('is-on'); host.innerHTML = ''; }
    releaseLeaflet();
    // A snap, not a slide: the twin has just covered the map, so there is no
    // picture to animate from, and a zoom animation left in flight would
    // overrule the next view the operator asks for when it ends.
    if (zoomOut && map && map.getPane && map.getPane('mapPane')) {
      map.setZoom(Math.min(map.getZoom(), ZOOM - 1), { animate: false });
    }
  }

  return {
    attach(m) {
      map = m;
      map.on('zoomend', sync);
      map.on('moveend', sync);
      sync();
    },

    // Leaving the tab, or a rebuild of the map: the twin goes with the
    // container it drew into.
    detach() {
      if (map) { map.off('zoomend', sync); map.off('moveend', sync); }
      leave(false);
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      map = null;
      prefetched = null;
    },

    sync,
    leave() { leave(true); },
    openTab() { if (stationId && typeof DigitalTwin !== 'undefined') DigitalTwin.openStation(stationId); },

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
    if (!enabled()) return 'Off. The map stays a map at every zoom; the Digital Twin tab is still there on the left.';
    return `From zoom ${ZOOM} in, with a station under the view — the one on the card, the selected one, or the `
         + 'nearest to the centre — the map hands over to that station\'s digital twin: its ground to 1 m where the '
         + 'State holds LiDAR, the aerial imagery, a 2 m pole and the radio paths as this map colours them. '
         + 'Wheel out past the edge, press Escape or press ← Map to come back. In ⛰️ 3-D the same zoom hands over the same way.';
  }
})();
if (typeof window !== 'undefined') window.MapTwin = MapTwin;
