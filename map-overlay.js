// MegaNet — map-overlay.js
//
//   MapOverlay   one canvas over the Stations map, in a pane of its own, that
//                a module draws on in screen pixels: placed when the view
//                settles, carried with the map through a drag, hidden through
//                a zoom's animation, sized to the device's pixels. Frames are
//                drawn when asked for, or every frame while the module says it
//                is animating.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches Leaflet (`L`) only from inside its own functions, and the IIFE body
// only declares, so this file's position among the modules is free
// (`npm run toplevel`). Used by map-flow.js, map-tails.js and map-paths.js;
// each one creates its overlay in its own attach() and destroys it in its own
// detach().
//
// ── Why a helper, when MapArrows and MapLatency each place their own ─────────
// The Views section (map-views.js) brought three more things that draw over
// or under the link lines in screen pixels — the flowing dashes, the tails
// and spotlight, and the repeaters' areas and trunks — and each needed the
// same forty lines MapLatency's pulse canvas already has: a pane with
// pointer-events off, a canvas sized by devicePixelRatio, placed at the
// container's top-left in *layer* pixels so a drag moves it with the map, and
// put away for a zoom. Written once here so the three agree with each other
// and with MapLatency, whose way (layer pixels minus the canvas's own origin)
// is the one that stays right while a frame is drawn mid-drag. MapArrows'
// container-pixel way only works for a canvas drawn once per settled view.
//
// ── Where an overlay sits ────────────────────────────────────────────────────
// The links and the pins share one canvas in Leaflet's overlay pane (400). An
// overlay under it (z 395–399) is covered by the pins, which is what tails,
// areas and flowing dashes want: a pin is never drawn over. One over it
// (401–404) draws over the pins as well. Every pane made here takes no
// pointer, so nothing on an overlay is a click target and the pins and lines
// under it keep theirs.
//
// Exposes: create.
const MapOverlay = (function () {
  // A handle on one overlay: create(map, opts) → handle.
  //   opts.pane       pane name, unique per overlay ('mnFlow', 'mnTails', …)
  //   opts.z          the pane's z-index
  //   opts.className  the canvas's class (for tests and styles.css)
  //   opts.draw(ctx, h, t)  paint one frame; ctx is already cleared and
  //                         scaled to CSS pixels; h is the handle; t the time
  //                         in ms (performance.now())
  //   opts.animating()      optional: true while the module wants a frame
  //                         every animation frame; asked again each frame
  //   opts.wanted()         optional: false while the module has nothing to
  //                         show (its mode not chosen) — the canvas is then
  //                         kept at one pixel, so an overlay nobody uses costs
  //                         no memory (a full-screen canvas on a phone is
  //                         ten-odd MB); asked at every placing and painting
  // The handle:
  //   at(lat, lng)        → [x, y] on the canvas, in CSS pixels
  //   fromContainer(x, y) → [x, y] on the canvas for a container point (a
  //                         pointer event's), right even mid-drag
  //   size()              → { x, y } the map's size in CSS pixels
  //   onScreen(x, y, pad) → whether a canvas point is in view, padded
  //   schedule()          → draw once at the next animation frame
  //   kick()              → start the loop if animating() says so
  //   placed()            → whether the canvas is placed and visible
  //   destroy()           → take it all off the map
  function create(map, opts) {
    const o = Object.assign({ pane: 'mnOverlay', z: 399, className: 'mn-overlay-canvas' }, opts || {});
    let canvas = null, ctx = null, origin = null, raf = null, hidden = false, gone = false;

    if (!map.getPane(o.pane)) {
      const pane = map.createPane(o.pane);
      pane.style.zIndex = o.z;
      pane.style.pointerEvents = 'none';
    }
    canvas = L.DomUtil.create('canvas', o.className, map.getPane(o.pane));
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.pointerEvents = 'none';
    ctx = canvas.getContext('2d');

    function size() { return map.getSize(); }
    const wanted = () => typeof o.wanted !== 'function' || !!o.wanted();
    // Full size while wanted, one pixel while not.
    function fit() {
      const s = size();
      const dpr = window.devicePixelRatio || 1;
      const on = wanted();
      const w = on ? Math.max(1, Math.round(s.x * dpr)) : 1, h = on ? Math.max(1, Math.round(s.y * dpr)) : 1;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        canvas.style.width = `${on ? s.x : 1}px`; canvas.style.height = `${on ? s.y : 1}px`;
      }
      return on;
    }
    function place() {
      if (gone || !canvas) return;
      const s = size();
      fit();
      origin = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, origin);
      hidden = false;
      canvas.style.visibility = '';
      // A settled view fires moveend, zoomend and often viewreset together:
      // clear now, so nothing from the old view shows at the new place, and
      // paint once at the next frame rather than once per event.
      const dpr2 = window.devicePixelRatio || 1;
      ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
      ctx.clearRect(0, 0, s.x, s.y);
      schedule();
    }
    function hide() {
      hidden = true;
      if (canvas) canvas.style.visibility = 'hidden';
    }
    function paint(t) {
      if (gone || !ctx) return;
      const s = size();
      const dpr = window.devicePixelRatio || 1;
      const on = fit();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, s.x, s.y);
      ctx.globalAlpha = 1;
      if (hidden || !origin || !on) return;
      try { o.draw(ctx, handle, t); } catch (e) {
        // One bad frame must not take the map with it; say so once.
        if (!paint.warned) { paint.warned = true; console.error('MapOverlay draw failed', o.pane, e); }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    }
    function wantsFrames() {
      if (gone || hidden) return false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      return typeof o.animating === 'function' && !!o.animating();
    }
    function frame(t) {
      raf = null;
      paint(t);
      if (wantsFrames()) raf = requestAnimationFrame(frame);
    }
    function schedule() {
      if (gone || raf) return;
      raf = requestAnimationFrame(frame);
    }
    function kick() { if (wantsFrames()) schedule(); }
    function onVisible() { if (document.visibilityState !== 'hidden') kick(); }

    const handle = {
      canvas,
      at(lat, lng) {
        if (!origin) return [NaN, NaN];
        const q = map.latLngToLayerPoint([lat, lng]);
        return [q.x - origin.x, q.y - origin.y];
      },
      fromContainer(x, y) {
        if (!origin) return [x, y];
        const q = map.containerPointToLayerPoint([x, y]);
        return [q.x - origin.x, q.y - origin.y];
      },
      size,
      onScreen(x, y, pad = 0) {
        const s = size();
        return x >= -pad && y >= -pad && x <= s.x + pad && y <= s.y + pad;
      },
      schedule,
      kick,
      placed: () => !!origin && !hidden && !gone,
      destroy() {
        gone = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        map.off('moveend zoomend resize viewreset', place);
        map.off('zoomstart', hide);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        canvas = null; ctx = null; origin = null;
      },
    };

    map.on('moveend zoomend resize viewreset', place);
    map.on('zoomstart', hide);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    place();
    return handle;
  }

  return { create };
})();
if (typeof window !== 'undefined') window.MapOverlay = MapOverlay;
