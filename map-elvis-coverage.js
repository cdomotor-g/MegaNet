// MegaNet — map-elvis-coverage.js
//
//   ElvisCoverage   Which digital elevation model Australia actually has under
//                   a place, drawn over the Stations map as the coverage
//                   footprints ELVIS publishes (#197).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; across to app.js for rerenderMapLegend.
// Both only from inside this module's own functions, so its position among the
// modules is free, the same way map-contours.js left it.
//
// ── What this answers, and why it is not an elevation source ────────────────
//
// Every terrain answer in this app — the profile card's clearance, ITM's path
// loss, the fade margin painted on a link, the peaks, the polar plot — is read
// off ~30 m terrarium tiles in terrain.js. That is one resolution everywhere,
// and the app has so far had no way to say so. It is a real gap: over most of
// settled Queensland the *nation* holds 1 m LiDAR, and over the rest it holds
// the same 30 m SRTM the tiles carry. A verdict of "marginal" means something
// different in those two places, and until now the map looked identical.
//
// So this layer draws the metadata rather than the terrain: ELVIS's own DEM
// coverage tiles, colour-keyed by the best resolution held at each place.
// Turning it on is how an operator sees that a path they are about to trust
// crosses ground the profile only knows to 30 m.
//
// It deliberately does NOT feed the physics. Nothing here is sampled, and
// terrain.js is untouched — the one wrong answer this app can give is a flat
// profile that reads as a clear path, and a context layer is not worth going
// near that. What ELVIS can and cannot do for the numbers was measured
// separately; elvis.js carries that.
//
// ── Why the tiles, not the API ─────────────────────────────────────────────
//
// ELVIS's coverage layer is a plain XYZ PNG cache on public S3: no key, no
// CORS preflight, no query, and it rides the same scheme Leaflet already
// fetches base maps on. It costs one tile request per view tile and nothing
// between views, which is the whole reason a "where is the good data" layer
// can be free while a "what is the height here" call is not.
//
// Two measured limits are written into the constants below rather than
// assumed, because both bite silently:
//
//   • The cache stops at z11. z12 and beyond answer 403, not 404 — an S3
//     bucket that denies listing says "forbidden" for an object that was
//     never written. maxNativeZoom keeps Leaflet upscaling the z11 tile past
//     that instead of asking for tiles that cannot exist.
//   • Tiles outside the cached footprint 403 the same way. errorTileUrl turns
//     those into a transparent pixel, so an ocean tile is blank rather than a
//     broken image.
const ElvisCoverage = (function () {
  // Geoscience Australia / ICSM, via the Elvis front end's own layer config.
  const TILE_URL = 'https://s3-ap-southeast-2.amazonaws.com/fsdf-elevation-tile-cache/DEM/{z}/{x}/{y}.png';
  const ATTRIBUTION = 'DEM coverage: Elvis — Geoscience Australia / ICSM and contributing states';
  // Measured against the live cache, not read off a capabilities document:
  // z11 is the last zoom that returns a tile.
  const MAX_NATIVE_Z = 11;
  // A 1×1 transparent PNG. Every tile outside the cached footprint 403s, and
  // without this Leaflet leaves the browser's broken-image glyph on the map.
  const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // map-survey.js documents the shared z-index budget: elevation shading 245,
  // contours 335, polar 332, rivers 340, survey 345, leader lines 350. This is
  // basemap context in the same sense the elevation ramp is, and it answers a
  // question *about* that ramp's data, so it sits directly on top of it and
  // well under everything that has to win a click.
  const PANE   = 'mnElvisCov';
  const PANE_Z = 246;

  // ELVIS's own legend, colours included, so the key on our map and the key on
  // theirs cannot drift. "Restricted" is data that exists but is not open —
  // worth drawing, because "no open DEM here" and "no DEM here" are different
  // answers to a siting question.
  const BANDS = [
    ['#00284f', '&lt; 1 m'],
    ['#004385', '1 m'],
    ['#0071e2', '2 m'],
    ['#59abff', '5 m'],
    ['#a8d5ff', '10 m'],
    ['#ebf6ff', '1 second (~30 m)'],
    ['#ffffce', 'Restricted'],
  ];

  let map = null;
  let overlay = null;

  function opacity() {
    const n = Number(state.mapElvisCovOpacity);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
  }

  function clearOverlay() {
    if (overlay && map) map.removeLayer(overlay);
    overlay = null;
  }

  function sync() {
    if (!map) return;
    if (!state.mapElvisCov) { clearOverlay(); return; }
    if (!overlay) {
      if (typeof L === 'undefined') return;
      if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
      overlay = L.tileLayer(TILE_URL, {
        pane: PANE,
        opacity: opacity(),
        maxNativeZoom: MAX_NATIVE_Z,
        errorTileUrl: BLANK,
        attribution: ATTRIBUTION,
        crossOrigin: 'anonymous',
      }).addTo(map);
      return;
    }
    overlay.setOpacity(opacity());
  }

  function repaintLegend() {
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      sync();
    },

    detach() {
      clearOverlay();
      map = null;
    },

    sync,

    // Does the legend claim a coverage key right now? Same gate as MapContours.
    active() { return !!overlay; },

    // Off by default and not persisted, for map-survey.js's stated reason: a
    // context layer that costs network requests stays off until asked for, so
    // "no extra requests fire with the layer off" stays true of a fresh load
    // without reasoning about a remembered on-state.
    setEnabled(on) {
      state.mapElvisCov = !!on;
      sync();
      repaintLegend();
    },

    setOpacity(v) {
      const n = Math.max(0.1, Math.min(1, Number(v) || 0));
      state.mapElvisCovOpacity = n;
      try { localStorage.setItem('mn-elvis-cov-op', String(n)); } catch (_) {}
      if (overlay) overlay.setOpacity(n);
    },

    opacity,

    noteHtml() {
      if (!state.mapElvisCov) {
        return 'Off. Draws which DEM resolution Australia holds under each place — '
             + 'the ground this app profiles is ~30 m everywhere, and this says where better exists.';
      }
      return `Painted at <strong>${Math.round(opacity() * 100)}%</strong>. `
           + 'Darker is finer. Detail fades in past zoom 11 — the coverage cache stops there. '
           + 'This is a map of the data, not a source of heights: profiles still read ~30 m terrain.';
    },

    // The key, shared by the Map display panel and the legend. Borrowed whole
    // from MapElevation.rampHtml() — `.elev-ramp` already butts its bands into
    // one strip so a scale reads as a scale, and this is a scale for the same
    // reason that one is. No new CSS, and the two keys cannot drift apart.
    rampHtml() {
      return `<ul class="elev-ramp">${BANDS.map(([c, label]) =>
        `<li><i style="--dot:${c}"></i><span>${label}</span></li>`).join('')}</ul>`;
    },

    // Read by the test, so the legend colours and the live layer cannot drift.
    _bands() { return BANDS.map(b => b.slice()); },
    _url() { return TILE_URL; },
    _maxNativeZoom() { return MAX_NATIVE_Z; },
  };
})();
if (typeof window !== 'undefined') window.ElvisCoverage = ElvisCoverage;
