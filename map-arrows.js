// MegaNet — map-arrows.js
//
//   MapArrows   draws direction arrowheads along every link line on the
//               Stations map, in the colour that line is already painted.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; reached from app.js (initMap,
// stopStationsMap, refreshMapLayers, applyMapFocusStyles, setMapLinkOpacity)
// and from map-los.js and map-fade.js, which schedule a redraw when they
// repaint a line. All of it from inside its own functions, so this file's
// position among the modules is free.
//
// ── Why a canvas of its own, and not more polylines ──────────────────────────
//
// The obvious way to put arrowheads on a Leaflet line is to add more Leaflet
// lines — a little two-segment chevron every so often along each link. On this
// map that is the wrong shape twice over. There are ~3,100 links and the marks
// have to be evenly spaced *on screen*, so the count is a function of the zoom:
// a few thousand extra layer objects at one zoom, tens of thousands at the
// next, rebuilt on every wheel click. And a chevron in geographic coordinates
// is a chevron that grows with the zoom, so at the national view the marks are
// dots and at street level each one is a kilometre across.
//
// So the arrows are drawn straight onto one canvas of their own, in screen
// pixels: constant size at every zoom, spaced by pixels rather than by degrees,
// no layer objects at all, and one clear-and-redraw when the view settles. The
// canvas rides in its own pane just above Leaflet's overlay pane — the links
// and the pins are both on the shared canvas renderer down there, so this is
// the first z-index that is over the lines; the marks start half a spacing in
// from each end, which is what keeps them off the pins they run to.
//
// ── The arrows say which way the traffic goes ────────────────────────────────
//
// Not decoration: a pass-range link is a field station reporting *in* to the
// repeater whose window covers its address, so the arrows point at the
// repeater, and a fan of them converging on one hilltop is the picture of what
// that repeater carries. A repeater-to-base backbone path points at the base,
// for the same reason — that is the direction the traffic leaves the network.
//
// A repeater-to-repeater path is the one hop that genuinely runs both ways, and
// it is drawn as such: one arrowhead near each end, pointing outward, and none
// along the middle. That is the ordinary notation for a two-way link, and it is
// deliberately not a row of one-way arrows — a picture that says traffic flows
// one way down a path that carries it both ways is worse than a picture that
// says nothing.
//
// ── The colour is the line's, read at draw time ──────────────────────────────
//
// An arrowhead takes the colour and opacity of the line it sits on, read off
// the Leaflet layer when the canvas is drawn rather than recorded when the line
// was built. That is what keeps it right through everything else that repaints
// a line: the frequency and fade-margin colourings, an obstructed path going
// crimson, a blast turning a fan red, and the focus dim taking everything not
// on the focused repeater down to a fifth of its opacity. Each of those calls
// schedule(); none of them has to know anything about arrows.
const MapArrows = (function () {
  const PANE   = 'mnArrows';
  // Just above Leaflet's own overlay pane (400), where the shared canvas
  // renderer draws the links and the pins, and below the shadow (500), marker
  // (600) and tooltip (650) panes — so the arrows are over the lines and under
  // the station name labels. The 320–350 band the other overlays share
  // (map-survey.js documents it) is *under* the links and is the wrong place
  // for a mark that has to be read against one.
  const PANE_Z = 405;

  const SPACING  = 46;    // px between arrowheads along a line
  const HEAD     = 5.5;   // px, half the length of a chevron
  const SPREAD   = 0.9;   // chevron half-width, as a fraction of HEAD
  const MIN_PX   = 26;    // shorter than this on screen and the line gets none
  const CORE_W   = 1.7;   // the chevron stroke
  const CASE_W   = 3.4;   // and the white casing under it, as every link has
  const MAX_PER_LINE = 40;
  // A ceiling on the whole frame. Nothing in this network reaches it — the
  // worst view is a few thousand marks — but a canvas loop with no bound is a
  // canvas loop that will one day meet a station list nobody has seen yet.
  const MAX_MARKS = 8000;

  let map = null, canvas = null, ctx = null, raf = null;
  // The lat/lng that was under the canvas's top-left corner when it was last
  // placed. The zoom animation needs it: the canvas has to be transformed to
  // where that corner is *going*, or the arrows sit still for a quarter of a
  // second while everything under them slides.
  let origin = null;

  function ensurePane(m) {
    if (!m.getPane(PANE)) {
      const pane = m.createPane(PANE);
      pane.style.zIndex = PANE_Z;
      pane.style.pointerEvents = 'none';   // an arrow is never a click target
    }
    return m.getPane(PANE);
  }

  // Size and place the canvas over the current view. Leaflet moves every pane
  // together while the map is dragged, so this only has to run when the view
  // settles: the pixel origin can have moved by then, which is what the
  // setPosition puts right.
  function reset() {
    if (!map || !canvas) return;
    const size = map.getSize();
    const dpr  = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(size.x * dpr));
    const h = Math.max(1, Math.round(size.y * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      canvas.style.width  = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    origin = map.containerPointToLatLng([0, 0]);
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    draw();
  }

  // Ride the zoom animation, the way every Leaflet renderer does: translate the
  // canvas to where its top-left corner will be at the new zoom and scale it by
  // the zoom ratio, then let the CSS transition on .leaflet-zoom-animated carry
  // it. The arrows are briefly the wrong size — they are pixels, and this is a
  // scale — and reset() redraws them at the right one the moment the animation
  // ends. Freezing them in place instead is the visibly worse of the two.
  function animateZoom(e) {
    if (!canvas || !origin || !map) return;
    const scale = map.getZoomScale(e.zoom, map.getZoom());
    const pos = map._latLngToNewLayerPoint(origin, e.zoom, e.center);
    L.DomUtil.setTransform(canvas, pos, scale);
  }

  // One chevron at (x, y), pointing along the unit vector (ux, uy). An open V
  // rather than a filled triangle: at this size a stroke reads as an arrow at
  // any opacity, while a fill turns into a blob the moment the line under it is
  // dimmed.
  function chevron(x, y, ux, uy) {
    const nx = -uy * HEAD * SPREAD, ny = ux * HEAD * SPREAD;
    const tx = x + ux * HEAD, ty = y + uy * HEAD;
    const bx = x - ux * HEAD, by = y - uy * HEAD;
    ctx.beginPath();
    ctx.moveTo(bx + nx, by + ny);
    ctx.lineTo(tx, ty);
    ctx.lineTo(bx - nx, by - ny);
  }

  function stroke(colour, opacity) {
    ctx.globalAlpha = Math.min(1, opacity * 0.85);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = CASE_W;
    ctx.stroke();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = colour;
    ctx.lineWidth = CORE_W;
    ctx.stroke();
  }

  function draw() {
    if (!map || !ctx) return;
    const size = map.getSize();
    const dpr  = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!state.mapArrows || !state.mapLines || !state.mapLines.length) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pad = 32;
    let marks = 0;
    for (const l of state.mapLines) {
      const dir = l.mnArrowDir;
      if (!dir) continue;                    // casings, and the backbone's dash overlay
      const opacity = l.options && l.options.opacity;
      if (!(opacity > 0.06)) continue;       // dimmed past the point of being read
      const ll = l.getLatLngs && l.getLatLngs();
      if (!ll || ll.length < 2) continue;
      const p = map.latLngToContainerPoint(ll[0]);
      const q = map.latLngToContainerPoint(ll[1]);
      // Reject what is wholly off one edge before any arithmetic is spent on
      // it. Zoomed into one site, this is nearly every line on the map.
      if ((p.x < -pad && q.x < -pad) || (p.x > size.x + pad && q.x > size.x + pad) ||
          (p.y < -pad && q.y < -pad) || (p.y > size.y + pad && q.y > size.y + pad)) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len < MIN_PX) continue;
      const ux = dx / len, uy = dy / len;
      const colour = (l.options && l.options.color) || '#000000';

      if (dir === 'both') {
        // Two-way: one head near each end, pointing outward, and nothing along
        // the middle. See the note at the top of this file.
        chevron(p.x + ux * len * 0.14, p.y + uy * len * 0.14, -ux, -uy);
        stroke(colour, opacity);
        chevron(p.x + ux * len * 0.86, p.y + uy * len * 0.86, ux, uy);
        stroke(colour, opacity);
        marks += 2;
      } else {
        const n = Math.max(1, Math.min(MAX_PER_LINE, Math.floor(len / SPACING)));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;            // half a spacing in from either end
          chevron(p.x + dx * t, p.y + dy * t, ux, uy);
          stroke(colour, opacity);
        }
        marks += n;
      }
      if (marks >= MAX_MARKS) break;
    }
    ctx.globalAlpha = 1;
  }

  return {
    attach(m) {
      if (map === m) { reset(); return; }
      this.detach();
      map = m;
      if (!map) return;
      const pane = ensurePane(map);
      canvas = L.DomUtil.create('canvas', 'mn-arrow-canvas leaflet-zoom-animated', pane);
      ctx = canvas.getContext('2d');
      map.on('moveend zoomend resize viewreset', reset);
      map.on('zoomanim', animateZoom);
      reset();
    },

    detach() {
      if (map) {
        map.off('moveend zoomend resize viewreset', reset);
        map.off('zoomanim', animateZoom);
      }
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      map = null; canvas = null; ctx = null; origin = null;
    },

    // Redraw once, on the next frame. Everything that repaints a link calls
    // this — the rebuild, the focus dim, the opacity slider, MapLos and MapFade
    // as their answers arrive — and a sweep that repaints three thousand lines
    // one at a time therefore costs one redraw, not three thousand.
    schedule() {
      if (raf || !map) return;
      raf = requestAnimationFrame(() => { raf = null; draw(); });
    },

    active() { return !!state.mapArrows; },

    // The switch in the Map display block. Nothing is rebuilt: the arrows are
    // painted from the lines that are already on the map.
    setEnabled(on) {
      state.mapArrows = !!on;
      try { localStorage.setItem('mn-map-arrows', on ? 'on' : 'off'); } catch (_) {}
      this.schedule();
      rerenderMapLegend();
    },
  };
})();
if (typeof window !== 'undefined') window.MapArrows = MapArrows;
