// MegaNet — map-leader.js
//
//   MapLeader   the gilded line that joins the station card to the pin it is
//               about: out of the card's top edge, onto a ring round the pin.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`. Reached from app.js — initMap and
// stopStationsMap, refreshMapLayers, repaintStnCard and closeStnCard, the pin
// click, focusStationOnMap, focusRepeaterOnMap and stnCardFromPopup — all of it
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── Why a leader, and not the callout ────────────────────────────────────────
//
// A pin click on a desktop used to open two things at once: the station card in
// the map's corner, and a Leaflet callout on the pin — name, roles, number,
// height and an "Actions (N)" button. Everything the callout said, the card
// said too, a hand's width away, and the actions were the card's own pills
// again. The one thing the callout did that the card could not was point: the
// card sits in a corner, and nothing on it said *which* of the pins it was
// about. A leader is that one thing and nothing else, so the callout went and
// this is what replaced it.
//
// A phone keeps its callout. There the card is a sheet that opens only on
// "Details & actions", so the callout is not a duplicate of anything — it is the
// light first answer to a tap — and the sheet gets the leader once it is open.
//
// ── The shape ────────────────────────────────────────────────────────────────
//
// It leaves the card from its top outline, square to it: straight up out of the
// top edge under a pin that is above the card, and round one of the top corners
// towards a pin that is beside it. A pin below the card's top — the usual case,
// with the card most of the map's height — is reached from the top corner and
// never out of the card's side, which is the one rule that keeps the line from
// running under the card it belongs to (anchor() says how). It ends on a ring
// round the pin rather than on the pin itself, so the pin's own colour, its
// role, is never painted over.
//
// Gold, cased in near-black, with a pale line down the middle and a warm glow:
// cased because it has to hold up over satellite imagery, topo shading and the
// dark base alike, and gold because nothing else on the map is metallic. The
// filter matches' amber ring and the photo pins are flat yellow; this is a
// ramp from pale to deep and back, and heavier than any of them.
//
// ── Where it lives ───────────────────────────────────────────────────────────
//
// One svg in a pane of its own, over the pins and the station-name labels and
// under Leaflet's callouts, so the other callouts on this map — a survey mark,
// a river — open over the line rather than under it. The pane is inside the
// map pane, which is a stacking context of its own below the card, so the
// line's end tucks under the card's edge whatever this z-index says: that is
// what makes it look like it comes out of the card.
//
// Leaflet moves the map pane while the map is dragged; the svg is put back over
// the map's own rectangle on every redraw, so everything is drawn in the map
// container's pixels, where the card is measured too.
//
// ── Keeping up ───────────────────────────────────────────────────────────────
//
// Redrawn on every `move` (a drag, a pan animation, a pinch), on `resize`, when
// the card changes size (the SLS and the exposure sections fill in after it
// opens, and the card grows upward from the bottom corner), and when the pin
// itself moves — MapSpider fans a stack out by moving its markers.
//
// Leaflet's animated zoom is the one change that fires nothing until it is
// over: the pins are scaled by a CSS transition for a quarter of a second. So
// on `zoomanim` the pin's end is walked from where it was to where it will be
// on the transition's own curve (leafletEase), frame by frame, and the line
// arrives with the pin rather than jumping after it.
const MapLeader = (function () {
  const PANE   = 'mnLeader';
  // Over the overlay pane (400, the canvas the pins and links are drawn on),
  // the arrows (405) and the station-name labels (tooltip pane, 650); under
  // the callouts (popup pane, 700).
  const PANE_Z = 660;
  const SVGNS  = 'http://www.w3.org/2000/svg';

  const CARD_R    = 8;     // .acma-card's border-radius — the corner a leader rounds
  const RING_GAP  = 6;     // px from the pin's edge out to the ring
  const MIN_LINE  = 6;     // px; a shorter line is not drawn, and the ring stands alone
  const CLEAR_PAD = 30;    // px of map reveal() leaves between a pin and the card
  const DRAW_MS   = 480;   // the draw-in, when the card moves to a new station
  const ZOOM_MS   = 250;   // leaflet.css: .leaflet-zoom-anim .leaflet-zoom-animated
  const PING_MS   = 2400;  // two pulses and a rest (styles.css, @keyframes mn-leader-ping)

  let map = null, svg = null, parts = null, ro = null;
  let tracked = null;      // the marker whose own `move` the leader follows
  let drawnId = null;      // the station the leader is on screen for
  let zoomRaf = null;      // the walk through Leaflet's zoom animation
  let at = null;           // latlng → container point, while that walk runs
  let pings = [];

  function el(name, attrs, parent) {
    const n = document.createElementNS(SVGNS, name);
    for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Tenths of a pixel: enough for a line that moves smoothly, and a `d` that
  // is not seventeen digits long.
  const f = n => Math.round(n * 10) / 10;

  function still() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  }

  // The 3-D view and the digital twin draw the pins somewhere the map pane
  // does not, over the top of it: no leader shows there (styles.css hides it),
  // and so no view is moved for one — in 3-D the camera follows the map's
  // centre, and a centre nudged clear of a card would be a camera off its
  // station.
  function elsewhere() {
    return (typeof Map3D !== 'undefined' && !!Map3D.active && Map3D.active())
        || (typeof MapTwin !== 'undefined' && !!MapTwin.active && MapTwin.active());
  }

  // Three strokes laid one over another — the dark case, the gold, the pale
  // shine — each with the line and the ring in it, so where the two meet the
  // gold runs on into the ring with no seam of casing across it. The line's
  // gold is a gradient along it, re-aimed on every draw (userSpaceOnUse); the
  // ring has one of its own.
  function build(pane) {
    svg = el('svg', { class: 'mn-leader', 'aria-hidden': 'true', focusable: 'false' }, pane);
    const defs = el('defs', {}, svg);
    // Pale where it leaves the card, deepening along the run and brightening
    // again into the pin.
    const grad = el('linearGradient', { id: 'mn-leader-gilt', gradientUnits: 'userSpaceOnUse' }, defs);
    for (const [offset, tone] of [['0', 'hi'], ['.3', 'mid'], ['.72', 'lo'], ['1', 'mid']]) {
      el('stop', { offset, class: `mn-leader-stop-${tone}` }, grad);
    }
    // The ring's own: lit from the top left, the way a gold rim catches the
    // light, whichever side of it the line arrives on.
    const rim = el('linearGradient', { id: 'mn-leader-rim', x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
    for (const [offset, tone] of [['0', 'hi'], ['.4', 'mid'], ['.78', 'lo'], ['1', 'mid']]) {
      el('stop', { offset, class: `mn-leader-stop-${tone}` }, rim);
    }
    parts = { grad, lines: [], rings: [] };
    for (const layer of ['case', 'gilt', 'shine']) {
      const g = el('g', { class: `mn-leader-${layer}` }, svg);
      // pathLength="1" is what lets the draw-in be written once, in fractions
      // of the line, whatever the line's length on screen.
      parts.lines.push(el('path', { class: 'mn-leader-line', pathLength: '1' }, g));
      parts.rings.push(el('circle', { class: 'mn-leader-ring' }, g));
    }
    parts.pings = el('g', { class: 'mn-leader-pings' }, svg);
  }

  // The card, in the map container's pixels, or null when there is nothing to
  // hang a leader from: no card, a closed one, one not laid out.
  function cardBox() {
    const card = document.getElementById('stn-card');
    if (!map || !card || card.hidden) return null;
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const m = map.getContainer().getBoundingClientRect();
    return { left: r.left - m.left, top: r.top - m.top, right: r.right - m.left, bottom: r.bottom - m.top };
  }

  // The station the card is on, and its pin: the marker's own position — a
  // fanned-out stack moves it — or the station's coordinates when the filters
  // have taken its pin off the map. The card stays on a hidden station, and the
  // leader goes on saying where it is.
  function target() {
    const id = state.stnCard && state.stnCard.id;
    if (!id || !map) return null;
    let m = tracked && tracked.mnStationId === id && tracked._map ? tracked : null;
    if (!m) m = state.mapMarkers.find(x => x.mnStationId === id) || null;
    if (m) return { id, marker: m, latlng: m.getLatLng(), r: m.getRadius ? m.getRadius() : 5 };
    const s = state.data && state.data.stations.find(x => x.id === id);
    if (!s || s.lat == null || s.lon == null || !isFinite(s.lat) || !isFinite(s.lon)) return null;
    return { id, marker: null, latlng: L.latLng(s.lat, s.lon), r: 5 };
  }

  function follow(marker) {
    if (marker === tracked) return;
    if (tracked) tracked.off('move', render);
    tracked = marker || null;
    if (tracked) tracked.on('move', render);
  }

  // Where the leader leaves the card: the point on its top outline — the
  // straight edge or either rounded corner — that faces the pin. To a pin over
  // the straight edge it goes straight up. To a pin beside the card it leaves
  // round the corner towards the pin, and a pin below the corner is clamped to
  // the end of it, level with the corner, which is what keeps the line off the
  // card's side.
  function anchor(box, p) {
    const xl = box.left + CARD_R, xr = box.right - CARD_R, cy = box.top + CARD_R;
    if (p.x >= xl && p.x <= xr) return { x: p.x, y: box.top };
    const right = p.x > xr;
    const cx = right ? xr : xl;
    let a = Math.atan2(p.y - cy, p.x - cx);
    // The top-right quarter runs from -90° (up) to 0° (right); the top-left
    // from -90° round to 180° (left).
    if (right) a = Math.max(-Math.PI / 2, Math.min(0, a));
    else       a = a > 0 ? Math.PI : Math.min(-Math.PI / 2, a);
    return { x: cx + CARD_R * Math.cos(a), y: cy + CARD_R * Math.sin(a) };
  }

  // Under the card, or within `pad` of it: there is no leader to a pin the
  // card is covering, only reveal() to bring it out.
  function covered(box, p, pad = 0) {
    return p.x > box.left - pad && p.x < box.right + pad
        && p.y > box.top - pad && p.y < box.bottom + pad;
  }

  // How far a pin at `p` has to move on screen to be clear of the card: right
  // of it while there is map there, or above it — the phone's sheet, which is
  // the map's whole width. The shorter of the two; null when it is clear, or
  // when neither fits.
  function clearance(box, p, pinR) {
    const pad = pinR + RING_GAP + 4;
    if (!covered(box, p, pad)) return null;
    const size = map.getSize();
    const opts = [];
    if (box.right + CLEAR_PAD < size.x - CLEAR_PAD) opts.push({ x: box.right + CLEAR_PAD - p.x, y: 0 });
    if (box.top - CLEAR_PAD > CLEAR_PAD)            opts.push({ x: 0, y: box.top - CLEAR_PAD - p.y });
    if (!opts.length) return null;
    return opts.reduce((a, b) => (Math.hypot(a.x, a.y) <= Math.hypot(b.x, b.y) ? a : b));
  }

  function place(box, p, pinR) {
    const a = anchor(box, p);
    const R = pinR + RING_GAP;
    const dx = p.x - a.x, dy = p.y - a.y;
    const len = Math.hypot(dx, dy);
    const d = len - R > MIN_LINE
      ? `M${f(a.x)} ${f(a.y)}L${f(p.x - dx / len * R)} ${f(p.y - dy / len * R)}`
      : '';
    for (const l of parts.lines) l.setAttribute('d', d);
    for (const c of parts.rings) {
      c.setAttribute('cx', f(p.x));
      c.setAttribute('cy', f(p.y));
      c.setAttribute('r', f(R));
    }
    const g = parts.grad;
    g.setAttribute('x1', f(a.x)); g.setAttribute('y1', f(a.y));
    g.setAttribute('x2', f(p.x)); g.setAttribute('y2', f(p.y));
  }

  // The line grows out of the card to the pin, and the ring lands as it
  // arrives. Only when the card has moved to a station the leader was not
  // already on — never for a repaint of the same one, a pan or a zoom.
  function drawIn() {
    if (still()) return;
    for (const l of parts.lines) {
      if (typeof l.animate !== 'function') return;
      l.animate([
        { strokeDasharray: '1 1', strokeDashoffset: 1 },
        { strokeDasharray: '1 1', strokeDashoffset: 0 },
      ], { duration: DRAW_MS, easing: 'cubic-bezier(.3, .7, .2, 1)' });
    }
    for (const c of parts.rings) {
      c.animate([
        { opacity: 0, transform: 'scale(2.2)' },
        { opacity: 0, transform: 'scale(2.2)', offset: 0.45 },
        { opacity: 1, transform: 'scale(1)' },
      ], { duration: DRAW_MS + 160, easing: 'cubic-bezier(.2, .8, .3, 1)' });
    }
  }

  // Leaflet's zoom curve, cubic-bezier(0, 0, .25, 1), as a function of time:
  // x(s) = .75s² + .25s³ is solved for s by bisection, and y(s) = 3s² − 2s³
  // is where the pins are.
  function leafletEase(k) {
    let lo = 0, hi = 1, s = k;
    for (let i = 0; i < 24; i++) {
      s = (lo + hi) / 2;
      if (s * s * (0.75 + 0.25 * s) < k) lo = s; else hi = s;
    }
    return s * s * (3 - 2 * s);
  }

  function render() {
    if (!map || !svg) return;
    const t = target();
    follow(t && t.marker);
    // The card's crown goes gold whenever it is on a station the map can
    // point at — paint only, never its size: this runs inside the card's own
    // ResizeObserver.
    const card = document.getElementById('stn-card');
    if (card) card.classList.toggle('mn-leader-card', !!t && !card.hidden);
    const toPoint = at || (ll => map.latLngToContainerPoint(ll));
    let on = false;
    const box = t ? cardBox() : null;
    if (t && box) {
      const p = toPoint(t.latlng);
      if (!covered(box, p)) { place(box, p, t.r); on = true; }
    }
    if (!t) drawnId = null;
    const fresh = on && t.id !== drawnId;
    if (on) drawnId = t.id;
    for (const q of pings) {
      const p = toPoint(q.marker.getLatLng());
      for (const c of q.g.children) {
        c.setAttribute('cx', f(p.x));
        c.setAttribute('cy', f(p.y));
        c.setAttribute('r', f(q.r));
      }
    }
    const any = on || pings.length > 0;
    svg.style.display = any ? '' : 'none';
    svg.classList.toggle('is-on', on);
    if (!any) return;
    // The size only when it has changed — this runs on every frame of a drag.
    const size = map.getSize();
    if (svg.getAttribute('width') !== String(size.x)) svg.setAttribute('width', size.x);
    if (svg.getAttribute('height') !== String(size.y)) svg.setAttribute('height', size.y);
    L.DomUtil.setPosition(svg, map.containerPointToLayerPoint([0, 0]));
    if (fresh) drawIn();
  }

  function stopZoom() {
    if (zoomRaf) cancelAnimationFrame(zoomRaf);
    zoomRaf = null;
    at = null;
  }

  // `zoomanim` fires before Leaflet moves its own view to the new zoom, so the
  // map still answers with where everything is now; where it is going is the
  // same arithmetic at the target zoom and centre.
  function onZoomAnim(e) {
    if (!map || !svg || svg.style.display === 'none') return;
    stopZoom();
    const half = map.getSize().divideBy(2);
    const z0 = map.getZoom(), c0 = map.getCenter();
    const pos = (ll, z, c) => map.project(ll, z).subtract(map.project(c, z)).add(half);
    const t0 = performance.now();
    const frame = now => {
      const k = Math.min(1, (now - t0) / ZOOM_MS);
      const u = leafletEase(k);
      at = ll => {
        const a = pos(ll, z0, c0), b = pos(ll, e.zoom, e.center);
        return L.point(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
      };
      render();
      if (k < 1) zoomRaf = requestAnimationFrame(frame);
      else { zoomRaf = null; at = null; }
    };
    zoomRaf = requestAnimationFrame(frame);
  }

  function onZoomEnd() { stopZoom(); render(); }

  function dropPing(q) {
    clearTimeout(q.timer);
    if (q.g.parentNode) q.g.parentNode.removeChild(q.g);
    pings = pings.filter(x => x !== q);
  }

  return {
    attach(m) {
      this.detach();
      map = m;
      if (!map) return;
      if (!map.getPane(PANE)) {
        const pane = map.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';    // a leader is never a click target
      }
      build(map.getPane(PANE));
      map.on('move viewreset resize', render);
      map.on('zoomanim', onZoomAnim);
      map.on('zoomend', onZoomEnd);
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => render());
        const card = document.getElementById('stn-card');
        if (card) ro.observe(card);
        ro.observe(map.getContainer());
      }
      render();
    },

    detach() {
      if (map) {
        map.off('move viewreset resize', render);
        map.off('zoomanim', onZoomAnim);
        map.off('zoomend', onZoomEnd);
      }
      stopZoom();
      if (ro) { ro.disconnect(); ro = null; }
      follow(null);
      for (const q of pings.slice()) dropPing(q);
      if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
      map = null; svg = null; parts = null; drawnId = null;
    },

    // Redraw for whatever the card and the pins are now. Called by everything
    // that changes either: the card's paint and close, and the rebuild of the
    // markers under a filter change.
    sync() { render(); },

    // Is the leader on screen, and between what? Nothing in the app draws from
    // this; it is here so the geometry can be asserted (test/stn-card.mjs),
    // because a line whose only witness is a picture is a line that can drift a
    // long way before anybody notices it has.
    geometry() {
      if (!map || !svg || !svg.classList.contains('is-on')) return null;
      const d = parts.lines[0].getAttribute('d') || '';
      const n = d.match(/-?[\d.]+/g) || [];
      const c = parts.rings[0];
      return {
        id: drawnId,
        from: n.length >= 4 ? { x: +n[0], y: +n[1] } : null,
        to:   n.length >= 4 ? { x: +n[2], y: +n[3] } : null,
        ring: { x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r') },
      };
    },

    // Pan the map, if it has to, so the card is not covering the pin it is
    // about — the one place a leader has nowhere to go. A card opened over a
    // pin near its corner, or a phone's sheet over the pin that was tapped.
    reveal() {
      if (!map || elsewhere()) return;
      const t = target();
      const box = t && cardBox();
      if (!box) return;
      const d = clearance(box, map.latLngToContainerPoint(t.latlng), t.r);
      if (d) map.panBy([-d.x, -d.y]);
    },

    // The centre for a view that puts `latlng` in the middle of the map at
    // `zoom` — moved just far enough that the card is not over it, when it
    // would be. For focusStationOnMap, which sets the view before the leader
    // could ask for a pan.
    centreFor(latlng, zoom) {
      if (!map || elsewhere()) return latlng;
      const t = target();
      const box = t && cardBox();
      if (!box) return latlng;
      const d = clearance(box, map.getSize().divideBy(2), t.r);
      if (!d) return latlng;
      return map.unproject(map.project(latlng, zoom).subtract([d.x, d.y]), zoom);
    },

    // A gold ring that closes in on a pin twice and goes: "this one", for the
    // moves that put the map on a station without putting the card on it — a
    // row in Repeaters listening.
    ping(marker) {
      if (!map || !svg || !marker) return;
      const g = el('g', { class: 'mn-leader-ping' }, parts.pings);
      el('circle', { class: 'mn-leader-case' }, g);
      el('circle', { class: 'mn-leader-gilt' }, g);
      const q = { marker, g, r: (marker.getRadius ? marker.getRadius() : 5) + RING_GAP };
      q.timer = setTimeout(() => { dropPing(q); render(); }, PING_MS);
      pings.push(q);
      render();
    },
  };
})();
if (typeof window !== 'undefined') window.MapLeader = MapLeader;
