// MegaNet — map-draw.js
//
//   MapDraw       sketching and measuring over the Stations map: coverage
//                 circles, proposed paths, boxes and notes — drawn by clicking
//                 or typed in as coordinates and real-world dimensions.
//   DRAW_TOOLS    the tool palette.
//   DRAW_COLOURS  the swatches.
//   fmtArea       the area formatter the shape labels use.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, bearingDeg, destPoint,
// fmtKm, kmPerDegLon, KM_PER_DEG_LAT and acmaHaversineKm — four of which this
// module hosted for the rest of the app until M1 (#132) moved them, which is
// why it can now leave without taking them with it. Across to app.js for
// mapNote and addToMapSelection, and sideways to path-profile.js for
// PathProfile, which reaches back here for MapDraw. Mutual, and free: the IIFE
// body only defines.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── Draw & measure ───────────────────────────────────────────────────────────
// Sketching over the network map: a coverage circle round a repeater, a
// proposed path, a box round the part of a catchment that went quiet, and a
// note saying what the picture is about. Every shape can be drawn by clicking
// on the map *or* typed in as coordinates and real-world dimensions, and
// either way it reduces to the same few numbers — which the pane then shows,
// and lets you edit. So a circle dropped roughly by hand becomes exactly
// 25.0 km by typing over its radius.
//
// Shapes carry their own measurements (length, radius, area) on the map, which
// is the "measure" half: drop a two-point line between two sites and it says
// how far apart they are and on what bearing.
//
// Nothing is saved. The shapes live as long as the page does — a tab switch
// rebuilds them from state.draw.shapes, a reload clears them — and the export
// is the operating system's screen-clipping tool.
//
// Where the panel is drawn changed at #164 and nothing else did. It was a panel
// in the Stations sidebar; it is a MapChrome flyout on the map itself now
// (map-controls.js), opened from the ✏️ icon in the map's top-right corner and
// pinnable open — which is the shape this tool always wanted, since every one
// of its controls is about something you are doing on the map a few hundred
// pixels away. panelHtml() still renders into #map-draw-panel and
// rerenderPanel() still finds it there; the only edit to this file was dropping
// the heading, because the flyout carries the title now.
//
// ── Keyboard parity, and where it stops (#136) ───────────────────────────────
// Stated rather than left to be discovered, because the honest answer is not
// "yes" and EPIC #107's Definition of Done asks for the boundary to be named.
//
// Fully keyboard-operable: every shape that exists. The panel lists them, and
// each row is a real button — select and centre, "Select inside", delete —
// alongside the colour swatches, the tool buttons and the edit form, where a
// shape's numbers (centre, radius, length, bearing, the note's text) are typed
// and take effect on change. That is the whole of the *editing* surface.
//
// And this is the point that matters: a shape can be **created** without a
// mouse too, because every tool accepts its geometry as numbers — the "type it
// in" path is not an accessibility afterthought bolted onto a drawing tool, it
// is the same door the tool was built with, for the operator who has a grid
// reference rather than a pixel.
//
// What is *not* keyboard-operable is dragging the pointer over the map to
// place a shape by eye: arming a tool and clicking latitude/longitude out of
// the map is a pointer gesture, and there is no keyboard equivalent of "about
// here". Adding one — a crosshair the arrow keys walk, in a projection whose
// step size changes with the zoom — is a feature, not a fix, and it is not in
// this issue. The typed path is the equivalent that exists today, and it is
// reachable from the same panel.

const DRAW_TOOLS = {
  pin:    { icon: '📍', label: 'Pin',       hint: 'Click the map to drop a pin. Keeps going until you pick another tool.' },
  line:   { icon: '╱',  label: 'Line',      hint: 'Click each corner; double-click (or Finish) to end. Shows length and bearing.' },
  circle: { icon: '◯',  label: 'Circle',    hint: 'Click the centre, then click again at the radius.' },
  rect:   { icon: '▭',  label: 'Rectangle', hint: 'Click one corner, then the opposite one.' },
  text:   { icon: 'T',  label: 'Text',      hint: 'Click where the note goes, then type it.' },
};

function fmtArea(km2) {
  if (!isFinite(km2)) return '—';
  if (km2 < 10)   return `${km2.toFixed(2)} km²`;
  if (km2 < 1000) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

// Six presets that stay legible on street, topo and satellite tiles alike, plus
// a native picker behind them for anything else.
const DRAW_COLOURS = [
  ['#e91e63', 'Pink'],  ['#ff6d00', 'Orange'], ['#ffd600', 'Yellow'],
  ['#00c853', 'Green'], ['#00b0ff', 'Blue'],   ['#aa00ff', 'Purple'],
];

const MapDraw = (function () {
  let map = null, group = null, ghost = null;
  let pending = null;      // shape being clicked out: { kind, pts: [[lat,lon], …], sids: […] }
  let keyHandler = null;
  let snapHint = null;     // ring round the station the next click would land on
  let snapCache = null;    // station pins projected once per zoom (see snapPoints)

  // How close to a station pin a click has to be to land on it. Screen pixels,
  // not kilometres: a km threshold would snap wildly at the national view and
  // never at street level.
  const SNAP_PX = 15;

  const D = () => state.draw;

  // ── colour ──
  // The theme's own drawing colour: the fallback for shapes drawn before a
  // colour was ever picked, and what "no choice" means in the picker.
  function themeColour() {
    return getComputedStyle(document.documentElement).getPropertyValue('--draw').trim() || '#c2185b';
  }

  // Only a hex literal is ever let through: these values go into inline style
  // attributes on the divIcon markers.
  function safeColour(c) {
    const v = String(c || '').trim();
    return /^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i.test(v) ? v : '';
  }

  // What new shapes get.
  function colour() { return safeColour(D().colour) || themeColour(); }

  // What an existing shape is drawn in — its own colour, or the theme's.
  function colourOf(sh) { return safeColour(sh.colour) || themeColour(); }

  function setColour(c) {
    const v = safeColour(c);
    D().colour = v;
    try { localStorage.setItem('mn-draw-colour', v); } catch (_) {}
    // With a shape picked, the control is colouring that shape — the natural
    // reading, and it saves needing a separate "edit colour" affordance.
    const sh = D().shapes.find(s => s.id === D().selectedId);
    if (sh) { sh.colour = v; render(); }
    rerenderPanel();
  }

  // ── geometry → numbers ──
  // Rectangles are held as a centre plus real-world width and height, not as a
  // pair of corners: "8 km across" is the thing being asked for, and it is what
  // survives being typed over.
  function rectBounds(sh) {
    const dLat = (sh.heightKm / 2) / KM_PER_DEG_LAT;
    const dLon = (sh.widthKm  / 2) / kmPerDegLon(sh.lat);
    return [[sh.lat - dLat, sh.lon - dLon], [sh.lat + dLat, sh.lon + dLon]];
  }

  function rectFromCorners(a, b) {
    const lat = (a[0] + b[0]) / 2, lon = (a[1] + b[1]) / 2;
    return {
      kind: 'rect', lat, lon,
      widthKm:  Math.abs(a[1] - b[1]) * kmPerDegLon(lat),
      heightKm: Math.abs(a[0] - b[0]) * KM_PER_DEG_LAT,
    };
  }

  function lineKm(pts) {
    let km = 0;
    for (let i = 1; i < pts.length; i++) {
      km += acmaHaversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return km;
  }

  // The one-line measurement a shape carries, on the map and in the list.
  function measure(sh) {
    switch (sh.kind) {
      // A pin dropped on a site is that site — the name beats the coordinates
      // both in the list and on the map.
      case 'pin':  return snapLabel(sh) || `${sh.lat.toFixed(4)}, ${sh.lon.toFixed(4)}`;
      case 'text': return sh.text;
      case 'circle': {
        const a = Math.PI * sh.radiusKm ** 2;
        return `r ${fmtKm(sh.radiusKm)} · ${fmtArea(a)}`;
      }
      case 'rect':
        return `${fmtKm(sh.widthKm)} × ${fmtKm(sh.heightKm)} · ${fmtArea(sh.widthKm * sh.heightKm)}`;
      case 'line': {
        const km = lineKm(sh.pts);
        if (sh.pts.length === 2) {
          const b = bearingDeg(sh.pts[0][0], sh.pts[0][1], sh.pts[1][0], sh.pts[1][1]);
          return `${fmtKm(km)} @ ${String(Math.round(b)).padStart(3, '0')}°`;
        }
        return `${fmtKm(km)} over ${sh.pts.length - 1} legs`;
      }
      default: return '';
    }
  }

  // ── snap to stations ──
  // Station pins projected at the current zoom. Comparing projected pixels is
  // the same comparison as container pixels, and doing it from a cache keeps
  // ~3,174 projections off every mousemove.
  function snapPoints() {
    const zoom = map.getZoom();
    if (snapCache && snapCache.zoom === zoom && snapCache.list === state.mapMarkers) return snapCache;
    snapCache = {
      zoom,
      list: state.mapMarkers,
      // A fanned-out pin's own latlng is where it was flung to, not where the
      // station is; mnStation is the real position.
      pts:  state.mapMarkers.map(m => map.project([m.mnStation.lat, m.mnStation.lon], zoom)),
    };
    return snapCache;
  }

  // The station pin a click at this position would land on, or null.
  function snapTarget(latlng) {
    if (!D().snap || !map || !state.mapMarkers.length) return null;
    const { list, pts } = snapPoints();
    const c = map.project(latlng, map.getZoom());
    let best = null, bestD = SNAP_PX;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - c.x, pts[i].y - c.y);
      if (d <= bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  // Without this the operator cannot tell whether a click snapped or not.
  function showSnapHint(marker) {
    if (snapHint && snapHint._mnFor === marker) return;
    clearSnapHint();
    if (!marker || !map) return;
    const s = marker.mnStation;
    snapHint = L.circleMarker([s.lat, s.lon], {
      radius: (marker.mnBaseStyle ? marker.mnBaseStyle.radius : 6) + 5,
      color: colour(), weight: 2, dashArray: '4,3', fill: false, interactive: false,
    }).addTo(map);
    snapHint._mnFor = marker;
    snapHint.bindTooltip(esc(s.name), {
      permanent: true, direction: 'top', className: 'mn-draw-label', offset: [0, -6],
    }).openTooltip();
  }

  function clearSnapHint() {
    if (snapHint) { snapHint.remove(); snapHint = null; }
  }

  // Resolve a map click to the point the shape should actually use, and to the
  // station it came from when it snapped.
  function resolve(latlng) {
    const t = snapTarget(latlng);
    return t
      ? { ll: [t.mnStation.lat, t.mnStation.lon], sid: t.mnStationId }
      : { ll: [latlng.lat, latlng.lng], sid: null };
  }

  function stationName(id) {
    if (!id || !state.data) return '';
    const s = state.data.stations.find(x => x.id === id);
    return s ? s.name : '';
  }

  // What a shape's snapped ends are called. "Mt Stuart → Durikai" is the thing
  // a drawn path means; two lat/lon pairs are not. Points are held in the same
  // order the shape defines them, so a line's ends are the first and the last.
  function snapLabel(sh) {
    const t = sh.snappedTo;
    if (!t || !t.length) return '';
    if (sh.kind !== 'line') return stationName(t[0]);
    const a = stationName(t[0]), b = stationName(t[t.length - 1]);
    if (a && b) return `${a} → ${b}`;
    return a ? `from ${a}` : b ? `to ${b}` : '';
  }

  // The shape's line in the draw list: its measurement, led by the sites it was
  // snapped to. A pin's measurement is already its name when it has one.
  function rowText(sh) {
    const nm = snapLabel(sh);
    return (!nm || sh.kind === 'pin') ? measure(sh) : `${nm} · ${measure(sh)}`;
  }

  function centreOf(sh) {
    if (sh.kind === 'line') {
      const lat = sh.pts.reduce((a, p) => a + p[0], 0) / sh.pts.length;
      const lon = sh.pts.reduce((a, p) => a + p[1], 0) / sh.pts.length;
      return [lat, lon];
    }
    return [sh.lat, sh.lon];
  }

  // ── layers ──

  function layerFor(sh) {
    const c   = colourOf(sh);
    const sel = sh.id === D().selectedId;
    const path = { color: c, weight: sel ? 4 : 2.5, opacity: 1, fillColor: c, fillOpacity: .12 };
    switch (sh.kind) {
      // The divIcon shapes are styled in CSS off --draw, so a per-shape colour
      // has to be written onto the element itself. safeColour has already
      // established that `c` is a hex literal.
      case 'pin':
        return L.marker([sh.lat, sh.lon], {
          icon: L.divIcon({ className: `mn-draw-pin${sel ? ' sel' : ''}`,
                            html: `<i style="background:${c};outline-color:${c}"></i>`,
                            iconSize: [16, 16], iconAnchor: [8, 16] }),
        });
      case 'text':
        return L.marker([sh.lat, sh.lon], {
          icon: L.divIcon({ className: `mn-draw-textbox${sel ? ' sel' : ''}`,
                            html: `<span style="border-color:${c}">${esc(sh.text)}</span>`,
                            iconSize: null }),
        });
      case 'line':   return L.polyline(sh.pts, { ...path, fill: false });
      case 'circle': return L.circle([sh.lat, sh.lon], { ...path, radius: sh.radiusKm * 1000 });
      case 'rect':   return L.rectangle(rectBounds(sh), path);
      default:       return null;
    }
  }

  function draw(sh) {
    const layer = layerFor(sh);
    if (!layer) return;
    sh._layer = layer;
    layer.addTo(group);
    // Text annotations already read as their own label; everything else gets
    // its measurement written next to it.
    if (D().showLabels && sh.kind !== 'text') {
      const anchor = sh.kind === 'pin' ? 'top' : 'center';
      layer.bindTooltip(measure(sh), {
        permanent: true, direction: anchor, className: 'mn-draw-label',
        offset: sh.kind === 'pin' ? [0, -18] : [0, 0],
      });
      // A permanent tooltip on a layer already added to the map is open right
      // away, so its element exists to be given the shape's own colour.
      const tt = layer.getTooltip();
      const el = tt && tt.getElement();
      if (el) el.style.borderColor = colourOf(sh);
    }
    layer.on('click', e => {
      if (D().tool) return;                 // a tool is armed: the click is a draw click
      L.DomEvent.stop(e);
      select(sh.id);
    });
  }

  function render() {
    if (!group) return;
    group.clearLayers();
    D().shapes.forEach(draw);
  }

  function clearGhost() { if (ghost) { ghost.remove(); ghost = null; } }

  // Dashed preview of the shape being clicked out, following the cursor.
  function showGhost(to) {
    clearGhost();
    if (!pending || !map) return;
    const c = colour(), a = pending.pts[0];
    const opts = { color: c, weight: 2, dashArray: '5,5', fill: false, interactive: false };
    if (pending.kind === 'line') {
      const pts = to ? pending.pts.concat([to]) : pending.pts;
      if (pts.length < 2) return;
      ghost = L.polyline(pts, opts);
    } else if (to && pending.kind === 'circle') {
      ghost = L.circle(a, { ...opts, radius: acmaHaversineKm(a[0], a[1], to[0], to[1]) * 1000 });
    } else if (to && pending.kind === 'rect') {
      ghost = L.rectangle([a, to], opts);
    }
    if (ghost) ghost.addTo(map);
  }

  // ── shape list ──

  function add(shape) {
    shape.id = `d${++D().seq}`;
    // Stamped at birth: changing the picker later moves what comes next, not
    // what is already on the map.
    shape.colour = safeColour(D().colour);
    D().shapes.push(shape);
    D().selectedId = shape.id;
    render();
    rerenderPanel();
    return shape;
  }

  function select(id) {
    D().selectedId = D().selectedId === id ? null : id;
    render();
    rerenderPanel();
    const sh = D().shapes.find(s => s.id === D().selectedId);
    if (sh && map) map.panTo(centreOf(sh));
  }

  function remove(id) {
    D().shapes = D().shapes.filter(s => s.id !== id);
    if (D().selectedId === id) D().selectedId = null;
    render();
    rerenderPanel();
  }

  function clearAll() {
    if (D().shapes.length > 1 &&
        !confirm(`Remove all ${D().shapes.length} drawings?`)) return;
    D().shapes = [];
    D().selectedId = null;
    cancelPending();
    render();
    rerenderPanel();
  }

  // ── click-to-draw ──

  function cancelPending() {
    pending = null;
    clearGhost();
    clearSnapHint();
    updateFinishButton();
  }

  function finishLine() {
    if (pending && pending.kind === 'line' && pending.pts.length >= 2) {
      add({ kind: 'line', pts: pending.pts, snappedTo: pending.sids.slice() });
    }
    cancelPending();
  }

  function onClick(e) {
    const tool = D().tool;
    if (!tool || !map) return;
    const { ll, sid } = resolve(e.latlng);
    if (tool === 'pin') { add({ kind: 'pin', lat: ll[0], lon: ll[1], snappedTo: [sid] }); return; }
    if (tool === 'text') {
      const t = prompt('Annotation text');
      if (t && t.trim()) add({ kind: 'text', lat: ll[0], lon: ll[1], text: t.trim(), snappedTo: [sid] });
      return;
    }
    if (!pending || pending.kind !== tool) {
      pending = { kind: tool, pts: [ll], sids: [sid] };
      updateFinishButton();
      showGhost(null);
      return;
    }
    if (tool === 'line') {
      pending.pts.push(ll); pending.sids.push(sid);
      showGhost(null); updateFinishButton(); return;
    }
    const a = pending.pts[0], aSid = pending.sids[0];
    if (tool === 'circle') {
      const r = acmaHaversineKm(a[0], a[1], ll[0], ll[1]);
      if (r > 0) add({ kind: 'circle', lat: a[0], lon: a[1], radiusKm: r, snappedTo: [aSid, sid] });
    } else if (tool === 'rect') {
      const rect = rectFromCorners(a, ll);
      if (rect.widthKm > 0 && rect.heightKm > 0) add({ ...rect, snappedTo: [aSid, sid] });
    }
    cancelPending();
  }

  function onMove(e) {
    if (!map) return;
    // The ghost follows the point the click would actually use, so the preview
    // and the result are the same thing.
    const t = D().tool ? snapTarget(e.latlng) : null;
    showSnapHint(t);
    if (pending) showGhost(t ? [t.mnStation.lat, t.mnStation.lon] : [e.latlng.lat, e.latlng.lng]);
  }

  function onDblClick(e) {
    if (D().tool === 'line' && pending) { L.DomEvent.stop(e); finishLine(); }
  }

  function onKey(e) {
    // This listener only exists while a tool is armed, so Escape here always
    // acts — and preventDefault says so, which keeps the fullscreen map's own
    // Escape from also firing: cancelling a half-drawn line must not throw
    // the operator out of full screen mid-measurement.
    if (e.key === 'Escape') { e.preventDefault(); if (pending) cancelPending(); else setTool(''); }
    else if (e.key === 'Enter' && pending && pending.kind === 'line') finishLine();
  }

  function setTool(tool) {
    const D_ = D();
    cancelPending();
    snapCache = null;                 // the pins may have been rebuilt since
    D_.tool = D_.tool === tool ? '' : tool;
    if (map) {
      // While a tool is armed, clicks have to reach the map: station pins and
      // ACMA squares would otherwise swallow the one near the site you are
      // trying to draw around.
      map.getContainer().classList.toggle('mn-drawing', !!D_.tool);
      if (D_.tool === 'line') map.doubleClickZoom.disable();
      else                    map.doubleClickZoom.enable();
    }
    if (D_.tool && !keyHandler) {
      keyHandler = onKey;
      document.addEventListener('keydown', keyHandler);
    } else if (!D_.tool && keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    mapNote(D_.tool ? DRAW_TOOLS[D_.tool].hint : '', 0);
    rerenderPanel();
  }

  // ── typed-in shapes ──

  function num(id) {
    const el = document.getElementById(id);
    if (!el || el.value.trim() === '') return null;
    const v = Number(el.value);
    return isFinite(v) ? v : null;
  }

  function centreLatLon() {
    return map ? [map.getCenter().lat, map.getCenter().lng] : [0, 0];
  }

  // Fill the lat/lon boxes of whichever form is on screen with the middle of
  // the current view — the usual starting point for "about here, 20 km across".
  function useMapCentre(prefix) {
    const [lat, lon] = centreLatLon();
    const a = document.getElementById(`${prefix}-lat`);
    const b = document.getElementById(`${prefix}-lon`);
    if (a) a.value = lat.toFixed(5);
    if (b) b.value = lon.toFixed(5);
  }

  // Build a shape from the "place by numbers" form for the armed tool. Returns
  // null (with a note over the map) when the numbers don't describe anything.
  function shapeFromForm(kind) {
    const lat = num('dr-lat'), lon = num('dr-lon');
    if (lat == null || lon == null) { mapNote('Enter a latitude and longitude first', 3500); return null; }
    if (kind === 'pin')  return { kind: 'pin', lat, lon };
    if (kind === 'text') {
      const el = document.getElementById('dr-text');
      const t  = el ? el.value.trim() : '';
      if (!t) { mapNote('Enter the text of the annotation', 3500); return null; }
      return { kind: 'text', lat, lon, text: t };
    }
    if (kind === 'circle') {
      const r = num('dr-radius');
      if (!r || r <= 0) { mapNote('Enter a radius in km', 3500); return null; }
      return { kind: 'circle', lat, lon, radiusKm: r };
    }
    if (kind === 'rect') {
      const w = num('dr-width'), h = num('dr-height');
      if (!w || !h || w <= 0 || h <= 0) { mapNote('Enter a width and height in km', 3500); return null; }
      return { kind: 'rect', lat, lon, widthKm: w, heightKm: h };
    }
    // A line's far end can be given either way round: a second coordinate, or
    // a bearing and a distance from the first.
    const lat2 = num('dr-lat2'), lon2 = num('dr-lon2');
    if (lat2 != null && lon2 != null) return { kind: 'line', pts: [[lat, lon], [lat2, lon2]] };
    const brg = num('dr-bearing'), dist = num('dr-dist');
    if (dist != null && dist > 0) {
      return { kind: 'line', pts: [[lat, lon], destPoint(lat, lon, brg || 0, dist)] };
    }
    mapNote('Give the far end as a lat/lon, or as a bearing and distance', 4000);
    return null;
  }

  function addFromForm() {
    const kind  = D().tool || 'pin';
    const shape = shapeFromForm(kind);
    if (!shape) return;
    add(shape);
    if (map) map.panTo(centreOf(shape));
  }

  // Typing over a drawn shape's numbers — the other half of "draw it roughly,
  // then make it exact".
  function applyEdit(id) {
    const sh = D().shapes.find(s => s.id === id);
    if (!sh) return;
    const v = k => {
      const el = document.getElementById(`de-${k}`);
      if (!el) return null;
      if (k === 'text') return el.value.trim();
      const n = Number(el.value);
      return el.value.trim() === '' || !isFinite(n) ? null : n;
    };
    if (sh.kind === 'line') {
      const a = [v('lat'), v('lon')], b = [v('lat2'), v('lon2')];
      if (a.some(x => x == null) || b.some(x => x == null)) { mapNote('Both ends need a lat and lon', 3500); return; }
      sh.pts = [a, b];
    } else {
      const lat = v('lat'), lon = v('lon');
      if (lat == null || lon == null) { mapNote('Enter a latitude and longitude', 3500); return; }
      sh.lat = lat; sh.lon = lon;
      if (sh.kind === 'circle') sh.radiusKm = Math.max(v('radius') || 0, 0.001);
      if (sh.kind === 'rect')   { sh.widthKm = Math.max(v('width') || 0, 0.001);
                                  sh.heightKm = Math.max(v('height') || 0, 0.001); }
      if (sh.kind === 'text')   sh.text = v('text') || sh.text;
    }
    // Numbers typed over a snapped point are the operator overruling the snap:
    // whatever station it used to sit on, it does not any more. Cleared only
    // once the edit has actually been taken — a rejected one changes nothing.
    sh.snappedTo = null;
    render();
    rerenderPanel();
  }

  function toggleLabels(on) {
    D().showLabels = on;
    render();
  }

  // Sometimes the pin is the correct location and the station is not, so this
  // has to be switchable rather than always on.
  function toggleSnap(on) {
    D().snap = on;
    if (!on) clearSnapHint();
    rerenderPanel();
  }

  // ── shape → station selection ──
  // The candidates are the markers actually on the map, so "the stations inside
  // this shape" means the ones the operator can see inside it: with "hide
  // stations that don't match" on, the hidden ones are not in the box.
  function stationsInside(sh) {
    const out = [];
    if (sh.kind === 'circle') {
      for (const m of state.mapMarkers) {
        const s = m.mnStation;
        if (s && acmaHaversineKm(sh.lat, sh.lon, s.lat, s.lon) <= sh.radiusKm) out.push(s.id);
      }
    } else if (sh.kind === 'rect') {
      const [[latMin, lonMin], [latMax, lonMax]] = rectBounds(sh);
      for (const m of state.mapMarkers) {
        const s = m.mnStation;
        if (s && s.lat >= latMin && s.lat <= latMax && s.lon >= lonMin && s.lon <= lonMax) out.push(s.id);
      }
    }
    return out;
  }

  // Additive, so two boxes combine; shift replaces instead, for starting again
  // without going via Clear.
  function selectInside(id, ev) {
    const sh = D().shapes.find(s => s.id === id);
    if (!sh) return;
    const ids = stationsInside(sh);
    if (!ids.length) { mapNote('No stations inside that shape', 3000); return; }
    if (ev && ev.shiftKey) state.mapSelection.clear();
    const added = addToMapSelection(ids);
    const total = state.mapSelection.size;
    mapNote(added
      ? `${added} station${added === 1 ? '' : 's'} added — ${total} selected`
      : `Already in the selection — ${total} selected`, 3500);
  }

  function updateFinishButton() {
    const btn = document.getElementById('draw-finish');
    if (btn) btn.hidden = !(pending && pending.kind === 'line' && pending.pts.length >= 2);
  }

  // ── the pane ──

  function field(id, label, value, step, placeholder) {
    return `
      <label class="draw-field">
        <span>${esc(label)}</span>
        <input type="number" id="${id}" step="${step}" value="${value ?? ''}"
               placeholder="${placeholder || ''}" inputmode="decimal">
      </label>`;
  }

  function newFormHtml(kind) {
    const rows = [field('dr-lat', kind === 'line' ? 'From lat' : 'Latitude', '', 'any'),
                  field('dr-lon', kind === 'line' ? 'From lon' : 'Longitude', '', 'any')];
    if (kind === 'circle') rows.push(field('dr-radius', 'Radius (km)', '', '0.1'));
    if (kind === 'rect')   rows.push(field('dr-width', 'Width (km)', '', '0.1'),
                                     field('dr-height', 'Height (km)', '', '0.1'));
    if (kind === 'line')   rows.push(field('dr-lat2', 'To lat', '', 'any'),
                                     field('dr-lon2', 'To lon', '', 'any'),
                                     field('dr-bearing', 'or bearing (°)', '', '1'),
                                     field('dr-dist', 'and distance (km)', '', '0.1'));
    return `
      <div class="draw-form">${rows.join('')}</div>
      ${kind === 'text' ? `
        <label class="draw-field draw-field-wide">
          <span>Text</span>
          <input type="text" id="dr-text" placeholder="e.g. flood watch area">
        </label>` : ''}
      <div class="draw-actions">
        <button onclick="MapDraw.useMapCentre('dr')">Map centre</button>
        <button class="primary" onclick="MapDraw.addFromForm()">Add ${esc(DRAW_TOOLS[kind].label.toLowerCase())}</button>
      </div>`;
  }

  function editFormHtml(sh) {
    const rows = [];
    if (sh.kind === 'line') {
      rows.push(field('de-lat', 'From lat', sh.pts[0][0].toFixed(5), 'any'),
                field('de-lon', 'From lon', sh.pts[0][1].toFixed(5), 'any'),
                field('de-lat2', 'To lat', sh.pts[1][0].toFixed(5), 'any'),
                field('de-lon2', 'To lon', sh.pts[1][1].toFixed(5), 'any'));
    } else {
      rows.push(field('de-lat', 'Latitude',  sh.lat.toFixed(5), 'any'),
                field('de-lon', 'Longitude', sh.lon.toFixed(5), 'any'));
      if (sh.kind === 'circle') rows.push(field('de-radius', 'Radius (km)', +sh.radiusKm.toFixed(3), '0.1'));
      if (sh.kind === 'rect')   rows.push(field('de-width', 'Width (km)',  +sh.widthKm.toFixed(3), '0.1'),
                                          field('de-height', 'Height (km)', +sh.heightKm.toFixed(3), '0.1'));
    }
    return `
      <div class="draw-edit">
        <div class="draw-form">${rows.join('')}</div>
        ${sh.kind === 'text' ? `
          <label class="draw-field draw-field-wide">
            <span>Text</span>
            <input type="text" id="de-text" value="${esc(sh.text)}">
          </label>` : ''}
        <div class="draw-actions">
          <button onclick="MapDraw.applyEdit('${escAttr(sh.id)}')">Apply</button>
        </div>
      </div>`;
  }

  function listHtml() {
    const D_ = D();
    if (!D_.shapes.length) return '<p class="filter-note">Nothing drawn yet.</p>';
    return `<div class="draw-list">${D_.shapes.map(sh => {
      const sel = sh.id === D_.selectedId;
      // A hand-drawn multi-leg line has no small set of numbers to type over,
      // so it lists its length and leaves it there; everything else opens its
      // measurements for editing when picked.
      const editable = sel && (sh.kind !== 'line' || sh.pts.length === 2);
      // Circles and rectangles have an inside, so they can hand it to the map
      // selection. Reusing the drawn shape rather than a separate "selection
      // tool" means a selection box can be typed to exact dimensions like
      // everything else in this panel.
      const canPick = sh.kind === 'circle' || sh.kind === 'rect';
      return `
        <div class="draw-row${sel ? ' sel' : ''}">
          <button class="draw-row-main" onclick="MapDraw.select('${escAttr(sh.id)}')"
                  title="Select and centre on it">
            <span class="draw-row-icon" style="--ink:${colourOf(sh)}">${DRAW_TOOLS[sh.kind].icon}</span>
            <span class="draw-row-text">${esc(rowText(sh))}</span>
          </button>
          ${canPick ? `
            <button class="draw-pick"
                    title="Select the stations inside this shape into the list below the map (shift-click to replace the current selection)"
                    onclick="MapDraw.selectInside('${escAttr(sh.id)}',event)">Select inside</button>` : ''}
          <button class="draw-del" title="Delete"
                  onclick="MapDraw.remove('${escAttr(sh.id)}')">✕</button>
        </div>
        ${editable ? editFormHtml(sh) : ''}`;
    }).join('')}</div>`;
  }

  function colourHtml() {
    const cur = colour();
    const picked = safeColour(D().colour).toLowerCase();
    return `
      <div class="draw-colour">
        <span class="draw-colour-label">Colour</span>
        <div class="draw-swatches">
          ${DRAW_COLOURS.map(([c, name]) => `
            <button class="draw-swatch${picked === c ? ' on' : ''}" style="--sw:${c}"
                    title="${esc(name)}" aria-label="${esc(name)}"
                    onclick="MapDraw.setColour('${c}')"></button>`).join('')}
          <input type="color" class="draw-colour-input" value="${escAttr(cur)}"
                 title="Any other colour" aria-label="Pick any colour"
                 onchange="MapDraw.setColour(this.value)">
        </div>
      </div>`;
  }

  function panelHtml() {
    const D_ = D();
    return `
      <!-- No heading of its own since #164: this panel is drawn inside a
           MapChrome flyout on the map, and that flyout already carries the
           title. Two would be one too many, and the second would be the one
           a screen reader read out. -->
      <div class="draw-head">
        <button class="filter-reset" onclick="MapDraw.clearAll()"
                ${D_.shapes.length ? '' : 'disabled'}>Clear all</button>
      </div>
      <div class="draw-tools">
        ${Object.entries(DRAW_TOOLS).map(([k, t]) => `
          <button class="draw-tool${D_.tool === k ? ' on' : ''}" title="${esc(t.hint)}"
                  onclick="MapDraw.setTool('${k}')">
            <span class="draw-tool-icon">${t.icon}</span>${esc(t.label)}
          </button>`).join('')}
      </div>
      <p class="filter-hint">${D_.tool
        ? esc(DRAW_TOOLS[D_.tool].hint) + ' Esc stops.'
        : 'Pick a tool, then draw on the map or type the numbers in. Nothing is saved — clip the screen to keep it.'}</p>
      <button id="draw-finish" hidden onclick="MapDraw.finishLine()">Finish line</button>
      ${colourHtml()}
      ${D_.tool ? `
        <details class="draw-numeric" open>
          <summary class="small">Place by numbers</summary>
          ${newFormHtml(D_.tool)}
        </details>` : ''}
      <label class="filter-check">
        <input type="checkbox" ${D_.snap ? 'checked' : ''}
               onchange="MapDraw.toggleSnap(this.checked)">
        Snap to stations
      </label>
      <p class="filter-hint">${D_.snap
        ? 'Clicks within about 15 px of a station pin land on that station, and the shape is named after it.'
        : 'Points land exactly where you click.'}</p>
      <label class="filter-check">
        <input type="checkbox" ${D_.showLabels ? 'checked' : ''}
               onchange="MapDraw.toggleLabels(this.checked)">
        Show measurements on the map
      </label>
      ${listHtml()}`;
  }

  function rerenderPanel() {
    const el = document.getElementById('map-draw-panel');
    if (el) { el.innerHTML = panelHtml(); updateFinishButton(); }
    // The elevation profile hangs off whichever line is current, and this is the
    // one place that changes: a shape added, selected, edited or deleted. A line
    // being dragged out never gets here, which is the debounce — PathProfile
    // compares the geometry itself and only fetches when it actually moved.
    PathProfile.sync();
  }

  return {
    attach(m) {
      map   = m;
      group = L.layerGroup().addTo(m);
      pending = null; ghost = null; snapHint = null; snapCache = null;
      m.on('click', onClick);
      m.on('mousemove', onMove);
      m.on('dblclick', onDblClick);
      // A tool left armed from a previous visit to the tab stays armed, so the
      // new map has to be put back into drawing mode — including the hint,
      // which went with the old map's note strip.
      if (D().tool) {
        m.getContainer().classList.add('mn-drawing');
        if (D().tool === 'line') m.doubleClickZoom.disable();
        if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler); }
        mapNote(DRAW_TOOLS[D().tool].hint, 0);
      }
      render();
    },

    // The map is going away (tab switch, re-render). The shapes themselves are
    // plain numbers in state and are redrawn on the next attach.
    detach() {
      if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
      clearGhost();
      clearSnapHint();
      pending = null; snapCache = null;
      map = null; group = null;
    },

    panelHtml, rerenderPanel, render, setTool, select, remove, clearAll,
    finishLine, addFromForm, applyEdit, useMapCentre, toggleLabels, measure,
    setColour, toggleSnap, selectInside, lineKm,

    // Where a map click actually lands, snapping included — so the link budget
    // picks endpoints by the same rule the draw tools do rather than growing a
    // second, subtly different one.
    resolveClick(latlng) { return resolve(latlng); },

    // Drop a two-point line in programmatically (the link budget asking for a
    // profile of its own path). Same shape, same list, same everything.
    addLine(pts, sids) {
      return add({ kind: 'line', pts: pts.map(p => p.slice()), snappedTo: (sids || []).slice() });
    },

    // The two-point line already drawn between these exact ends, either way
    // round. Its caller is the link budget: pressing "Profile this path" twice
    // has to land back on the same line rather than stack a second one on top
    // of the first, invisibly, at the same coordinates.
    findLine(a, b) {
      const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
      return D().shapes.find(s => s.kind === 'line' && s.pts.length === 2 &&
        ((same(s.pts[0], a) && same(s.pts[1], b)) ||
         (same(s.pts[0], b) && same(s.pts[1], a)))) || null;
    },

    // Make a shape the selected one. select() is the click behaviour and
    // toggles, which would *de*select a shape that is already current — not
    // what a caller asking for this shape specifically wants.
    focus(id) {
      if (!D().shapes.some(s => s.id === id)) return;
      D().selectedId = id;
      render();
      rerenderPanel();
    },
  };
})();

