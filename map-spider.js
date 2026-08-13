// MegaNet — map-spider.js
//
//   MapSpider   fans a stack of overlapping map pins out on leader lines, so
//               the ones underneath can be seen and clicked.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches across to app.js for mapNote, from inside its own functions. The IIFE
// body declares five tunables and four nulls and calls nothing, so this file's
// position among the modules is free.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── Overlapping pins: fan-out ("spiderfy") ───────────────────────────────────
// Co-sited stations and ACMA sites carrying a dozen licensed devices land on the
// same few pixels, and whatever is underneath is unreachable. Hovering a stack
// (mouse) or tapping it (touch) fans its members out around the stack centre on
// leader lines so each one can be seen and clicked; they snap back when the
// pointer leaves, the map zooms, or the markers are rebuilt.
//
// Works on any marker with getLatLng/setLatLng, so MegaNet station circles and
// ACMA transmitter squares fan out together.
const MapSpider = (function () {
  const NEAR_PX   = 20;  // pins within this screen distance form one stack
  const MAX_FAN   = 16;  // a fan bigger than this stops being readable
  const HOVER_MAX = 10;  // bigger stacks need a deliberate click, so that panning
                         // across a zoomed-out map doesn't fan pins constantly
  const LEAVE_PX  = 70;  // pointer this far outside the fan closes it
  const HOVER_MS  = 70;  // settle time, so sweeping across a stack doesn't fan it

  const buckets = { stations: [], acma: [] };
  let map = null;
  let open = null;       // { members, centre, radius, legs }
  let cache = null;      // { list, pts } projected at the current zoom
  let hoverTimer = null;

  function canHover() {
    return !L.Browser.mobile && window.matchMedia('(hover: hover)').matches;
  }

  function pins() { return buckets.stations.concat(buckets.acma); }

  // Where a pin belongs — its own position unless it is currently fanned out.
  function home(m) { return m._mnHome || m.getLatLng(); }

  function invalidate() { cache = null; }

  function points() {
    if (cache) return cache;
    const zoom = map.getZoom();
    const list = pins();
    cache = { list, pts: list.map(m => map.project(home(m), zoom)) };
    return cache;
  }

  // Every pin sitting within NEAR_PX of the given one, nearest first.
  function stackFor(marker) {
    const { list, pts } = points();
    const i = list.indexOf(marker);
    if (i < 0) return [];
    const c = pts[i];
    return list
      .map((m, j) => ({ m, d: Math.hypot(pts[j].x - c.x, pts[j].y - c.y) }))
      .filter(x => x.d <= NEAR_PX)
      .sort((a, b) => a.d - b.d)
      .map(x => x.m);
  }

  // Pixel offsets for n fanned pins: concentric rings at ~26 px spacing, so a
  // pair sits tight and a 30-device ACMA site still reads.
  function fanOffsets(n) {
    const out = [];
    let placed = 0, ring = 0;
    while (placed < n) {
      const r   = 30 + ring * 26;
      const cap = Math.max(3, Math.floor((2 * Math.PI * r) / 26));
      const k   = Math.min(cap, n - placed);
      for (let i = 0; i < k; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / k + (ring % 2 ? Math.PI / k : 0);
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r });
      }
      placed += k;
      ring++;
    }
    return out;
  }

  function isOpen(marker) { return !!open && open.members.indexOf(marker) >= 0; }

  function spiderfy(marker) {
    if (!map) return false;
    const stack = stackFor(marker);
    if (stack.length < 2) { unspiderfy(); return false; }
    // Co-located ACMA devices share exact coordinates and never separate by
    // zooming, so an oversized stack still fans — it just says what it left out.
    const members = stack.slice(0, MAX_FAN);
    if (open && open.members.length === members.length &&
        members.every(m => open.members.indexOf(m) >= 0)) return true;
    unspiderfy();
    if (stack.length > MAX_FAN) {
      mapNote(`${members.length} of ${stack.length} pins fanned out — zoom in for the rest`, 4000);
    }

    const zoom = map.getZoom();
    const { list, pts } = points();
    let sx = 0, sy = 0;
    members.forEach(m => { const p = pts[list.indexOf(m)]; sx += p.x; sy += p.y; });
    const centre = map.unproject(L.point(sx / members.length, sy / members.length), zoom);
    const cLp    = map.latLngToLayerPoint(centre);
    const offs   = fanOffsets(members.length);
    const legs   = L.layerGroup().addTo(map);
    let radius   = 0;

    members.forEach((m, i) => {
      const o    = offs[i];
      const from = home(m);
      const to   = map.layerPointToLatLng(cLp.add(L.point(o.x, o.y)));
      radius = Math.max(radius, o.r);
      m._mnHome = from;
      // White casing under a dark line: legible over topo, imagery and dark mode.
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#fff',     weight: 4,   opacity: .9,  interactive: false }).addTo(legs);
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#4a5560', weight: 1.5, opacity: .95, interactive: false }).addTo(legs);
      m.setLatLng(to);
      if (m.setZIndexOffset) m.setZIndexOffset(1000);
      if (m.bringToFront)    m.bringToFront();
    });
    L.circleMarker(centre, {
      pane: 'mnSpiderLegs', radius: 2.5, color: '#4a5560', weight: 1,
      fillColor: '#fff', fillOpacity: 1, interactive: false,
    }).addTo(legs);

    open = { members, centre, radius, legs };
    map.on('mousemove', onMapMove);
    return true;
  }

  function unspiderfy() {
    clearTimeout(hoverTimer);
    if (!open) return;
    open.members.forEach(m => {
      if (m._mnHome) { m.setLatLng(m._mnHome); delete m._mnHome; }
      if (m.setZIndexOffset) m.setZIndexOffset(0);
    });
    open.legs.remove();
    if (map) map.off('mousemove', onMapMove);
    open = null;
  }

  function onMapMove(e) {
    if (!open) return;
    // A popup open on one of the fanned pins is the user reading it — hold.
    if (open.members.some(m => m.isPopupOpen && m.isPopupOpen())) return;
    if (e.layerPoint.distanceTo(map.latLngToLayerPoint(open.centre)) > open.radius + LEAVE_PX) {
      unspiderfy();
    }
  }

  function onPinOver(e) {
    if (!map || isOpen(e.target)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      // Hover only opens small stacks; a zoomed-out map where everything
      // overlaps would otherwise fan pins under every pass of the mouse.
      if (stackFor(e.target).length <= HOVER_MAX) spiderfy(e.target);
    }, HOVER_MS);
  }

  function onPinClick(e) {
    if (!map || isOpen(e.target)) return;   // already fanned → let the popup open
    // A modifier-click is the map selection talking, not "show me this stack".
    const oe = e.originalEvent;
    if (oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) return;
    // First tap on a stack fans it instead of opening whichever pin was on top.
    if (spiderfy(e.target)) e.target.closePopup();
  }

  return {
    // Wire a freshly built map. Leader lines get their own pane below the
    // overlay pane so they never draw over the pins they point at.
    attach(m) {
      map = m;
      open = null; cache = null;
      buckets.stations = []; buckets.acma = [];
      clearTimeout(hoverTimer);
      if (!m.getPane('mnSpiderLegs')) {
        const pane = m.createPane('mnSpiderLegs');
        pane.style.zIndex = 350;
        pane.style.pointerEvents = 'none';
      }
      m.on('zoomstart', unspiderfy);
      m.on('zoomend viewreset', invalidate);
      m.on('click', unspiderfy);          // pin clicks don't bubble to the map
    },

    // Hand over a rebuilt set of markers for one layer.
    setPins(kind, markers) {
      unspiderfy();
      buckets[kind] = markers || [];
      invalidate();
      (markers || []).forEach(m => {
        if (m._mnSpiderWired) return;
        m._mnSpiderWired = true;
        m.on('click', onPinClick);
        if (canHover()) m.on('mouseover', onPinOver);
      });
    },

    // Send every fanned pin home — call before markers are removed or replaced.
    reset() { unspiderfy(); invalidate(); },

    detach() { unspiderfy(); map = null; buckets.stations = []; buckets.acma = []; },
  };
})();

