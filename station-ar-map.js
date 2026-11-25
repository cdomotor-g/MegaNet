// MegaNet — station-ar-map.js
//
//   StationArMap  🔭 Look Around's map from above: half of the finder's screen,
//                 north up, the ground under the camera's picture — you in the
//                 middle, every station the finder gathered as a dot in its
//                 type's colour, and a wedge fanned out from you the way the
//                 camera faces, as wide as the camera's field of view.
//
// After core.js and map-controls.js, before init.js — index.html holds the
// order and the reasons. Reaches back to core.js for removeMap, registerLiveMap
// and registerTabTeardown, and to map-controls.js for makeBaseLayers and
// makeBaseLabels (read only — it never touches the Stations map's own layers).
// All of it from inside its own functions; the IIFE body only defines, and
// nothing executes at load (`npm run toplevel`). station-ar.js is the one
// caller: it owns the heading, the position and the station list, and says them
// here; this file keeps none of its own, so the wedge cannot disagree with the
// pins over the picture.
//
// ── Why ──────────────────────────────────────────────────────────────────────
// The finder gave the whole screen to the camera and a thumbnail circle to
// "where is everything" — and the camera is the part of the screen that is
// mostly sky. The map takes half: the station the pins name is the dot inside
// the wedge, and the one behind you, which no pin can show, is on it too.
//
// ── What it will not do ──────────────────────────────────────────────────────
// It is optional. If Leaflet is not there, or the map cannot be made, open()
// says false and the finder carries on with the thumbnail circle it always had;
// the camera, the pins and the sheet never depend on it. It fetches map tiles
// (the base the person last chose on the Stations map) and nothing else — your
// position is drawn here and goes nowhere.
const StationArMap = (function () {
  const RAD = Math.PI / 180;
  const EARTH_M = 6371008.8;

  // The dots' colours where the page's own tokens cannot be read (the finder's
  // dark theme, the same values as styles.css).
  const FALLBACK = { field: '#57d657', repeater: '#6bb6ff', base: '#ff8a63' };
  const WEDGE = '#4da3ff';

  let map = null, host = null, markers = null, youDot = null, wedge = null;
  let renderer = null, byId = new Map(), colours = null;
  let follow = true;          // the map stays on you until a finger or mouse moves it
  let fitKey = null;          // the distance the map was last fitted to
  let wedgeKey = '';          // what the wedge was last drawn for
  let pickedId = null, here = null, maxKm = 0, onPick = null;
  let nudging = false;        // a move this file made, not the person

  // The base the person chose on the Stations map: the first one switched on in
  // the mix map-controls.js remembers, in its saved order. A street map when
  // there is nothing saved, which is the one that reads from above at any zoom.
  function baseName() {
    const names = Object.keys(makeBaseLayers());
    try {
      const saved = JSON.parse(localStorage.getItem('mn-base-maps') || 'null');
      if (typeof saved === 'string' && names.includes(saved)) return saved;
      if (saved && typeof saved === 'object') {
        const order = (Array.isArray(saved._order) ? saved._order : []).filter(n => names.includes(n));
        for (const n of [...order, ...names.filter(n => !order.includes(n))]) {
          if (saved[n] && saved[n].on) return n;
        }
      }
    } catch (_) { /* private mode or a hand-edited value — the default */ }
    return names.includes('OpenStreetMap') ? 'OpenStreetMap' : names[0];
  }

  function tokenColours(el) {
    const out = { ...FALLBACK };
    try {
      const cs = getComputedStyle(el);
      for (const r of Object.keys(out)) {
        const v = cs.getPropertyValue(`--role-${r}`).trim();
        if (v) out[r] = v;
      }
    } catch (_) { /* the fallbacks */ }
    return out;
  }

  // Where a bearing and a distance from a point lead, on the sphere.
  function destination(lat, lon, bearing, metres) {
    const d = metres / EARTH_M, b = bearing * RAD, p1 = lat * RAD, l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
  }

  // The wedge's outline: you, then an arc across the field of view at `metres`.
  // Steps of about five degrees, so a wide view is still round.
  function wedgePoints(lat, lon, heading, fov, metres) {
    const n = Math.max(4, Math.ceil(fov / 5));
    const pts = [[lat, lon]];
    for (let i = 0; i <= n; i++) pts.push(destination(lat, lon, heading - fov / 2 + fov * i / n, metres));
    return pts;
  }

  function dotStyle(role, picked) {
    const c = (colours && colours[role]) || FALLBACK.field;
    return picked
      ? { radius: 8, weight: 3, color: '#ffffff', fillColor: c, fillOpacity: 1 }
      : { radius: 5, weight: 1.5, color: '#0f1720', fillColor: c, fillOpacity: 0.95 };
  }

  // Build the map in `el`. `pick(id)` is what pressing a dot does — the same as
  // pressing that station's pin. True when there is a map, false when there is
  // none and the caller should do without.
  function open(el, pick) {
    close();
    if (!el || typeof L === 'undefined' || typeof makeBaseLayers !== 'function') return false;
    try {
      host = el;
      onPick = pick;
      colours = tokenColours(el);
      map = L.map(el, {
        preferCanvas: true, zoomControl: true, attributionControl: true,
        keyboard: false, doubleClickZoom: true, zoomSnap: 0.25,
        zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
      });
      map.attributionControl.setPrefix(false);
      map.zoomControl.setPosition('topright');
      map.setView([-27.5, 153], 5, { animate: false });
      map.createPane('mnBaseLabels').style.zIndex = 250;
      map.createPane('mnArWedge').style.zIndex = 420;
      map.createPane('mnArDots').style.zIndex = 450;
      map.createPane('mnArYou').style.zIndex = 480;
      const name = baseName();
      makeBaseLayers()[name].addTo(map);
      (typeof makeBaseLabels === 'function' ? makeBaseLabels()[name] || [] : []).forEach(l => l.addTo(map));
      renderer = L.canvas({ pane: 'mnArDots', tolerance: 8 });
      markers = L.layerGroup().addTo(map);
      wedge = L.polygon([], {
        pane: 'mnArWedge', interactive: false, stroke: true, color: WEDGE, weight: 1.5, opacity: 0.9,
        fillColor: WEDGE, fillOpacity: 0.3,
      }).addTo(map);
      youDot = L.circleMarker([0, 0], {
        pane: 'mnArYou', interactive: false, radius: 7, weight: 3, color: '#ffffff', fillColor: '#2563eb', fillOpacity: 1,
      });
      map.on('dragstart', () => { if (!nudging) follow = false; });
      follow = true; fitKey = null; wedgeKey = ''; pickedId = null; here = null; maxKm = 0;
      registerLiveMap('Look Around map', () => map);
      registerTabTeardown('Look Around map', close);
      return true;
    } catch (_) {
      close();
      return false;
    }
  }

  function close() {
    if (map) map = removeMap(map);
    map = host = markers = youDot = wedge = renderer = onPick = null;
    byId = new Map();
    here = null;
  }

  // The stations gathered, as dots: every member of every direction, so the
  // station behind the nearest one is on the map though it has no pin of its own.
  function setStations(clusters, picked) {
    if (!map || !markers) return;
    markers.clearLayers();
    byId = new Map();
    pickedId = picked == null ? null : picked;
    for (const c of clusters || []) {
      for (const m of c.members) {
        const s = m.s;
        const on = s.id === pickedId;
        const dot = L.circleMarker([s.lat, s.lon], { renderer, ...dotStyle(m.role, on) });
        dot.mnRole = m.role;
        dot.bindTooltip(s.name || 'Unnamed station', { direction: 'top', offset: [0, -6] });
        dot.on('click', () => { if (onPick) onPick(s.id); });
        dot.addTo(markers);
        byId.set(s.id, dot);
      }
    }
    const picked1 = byId.get(pickedId);
    if (picked1) picked1.bringToFront();
  }

  // The one the finder has open, ringed — without rebuilding every dot.
  function setPicked(id) {
    if (!map) return;
    const was = byId.get(pickedId);
    if (was) was.setStyle(dotStyle(was.mnRole, false));
    pickedId = id == null ? null : id;
    const now = byId.get(pickedId);
    if (now) { now.setStyle(dotStyle(now.mnRole, true)); now.bringToFront(); }
  }

  function nudge(fn) {
    nudging = true;
    try { fn(); } finally { nudging = false; }
  }

  // Where you are, and how far the finder looks. The map is fitted to the
  // distance the first time and whenever the distance changes, and follows you
  // after that until it is moved by hand (recentre() brings it back).
  function setHere(pos, km) {
    if (!map) return;
    here = pos && isFinite(pos.lat) && isFinite(pos.lon) ? { lat: pos.lat, lon: pos.lon } : null;
    maxKm = km || maxKm;
    if (!here) { if (youDot && map.hasLayer(youDot)) youDot.remove(); return; }
    const ll = [here.lat, here.lon];
    if (!map.hasLayer(youDot)) youDot.addTo(map);
    youDot.setLatLng(ll);
    nudge(() => {
      if (fitKey !== maxKm) {
        fitKey = maxKm;
        follow = true;
        map.fitBounds(L.latLng(ll).toBounds(maxKm * 2000), { animate: false, padding: [6, 6] });
      } else if (follow) {
        map.panTo(ll, { animate: false });
      }
    });
    wedgeKey = '';
  }

  // The wedge: the way the camera faces (degrees true, or null while there is
  // no compass to say) and the camera's horizontal field of view. Called every
  // frame the finder draws, so it redraws only when the figures moved.
  function setView(heading, fov) {
    if (!map || !wedge) return;
    if (!here || heading == null || !(fov > 0) || !(maxKm > 0)) {
      if (wedgeKey !== 'none') { wedge.setLatLngs([]); wedgeKey = 'none'; }
      return;
    }
    const key = `${(Math.round(heading * 5) / 5)}|${Math.round(fov * 10) / 10}|${maxKm}`;
    if (key === wedgeKey) return;
    wedgeKey = key;
    wedge.setLatLngs(wedgePoints(here.lat, here.lon, heading, fov, maxKm * 1000));
  }

  function recentre() {
    if (!map || !here) return;
    follow = true;
    fitKey = null;
    setHere(here, maxKm);
  }

  // The pane changed size (a turn of the phone, a resize): Leaflet caches it.
  function resize() {
    if (map) nudge(() => map.invalidateSize({ animate: false }));
  }

  return {
    open,
    close,
    setStations,
    setPicked,
    setHere,
    setView,
    recentre,
    resize,

    // The arithmetic, for the checks (test/ar.mjs).
    wedgePoints,
    destination,

    // Read by the checks: what the map holds.
    debug() {
      return {
        open: !!map, follow, dots: byId.size, picked: pickedId, here, maxKm,
        wedge: wedge && wedge.getLatLngs()[0] ? wedge.getLatLngs()[0].map(p => [p.lat, p.lng]) : [],
        zoom: map ? map.getZoom() : null,
      };
    },
  };
})();
if (typeof window !== 'undefined') window.StationArMap = StationArMap;
