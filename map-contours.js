// MegaNet — map-contours.js
//
//   MapContours   1 m / 5 m / 10 m LiDAR elevation contour lines from the
//                 Queensland spatial data platform, drawn over the Stations
//                 map for terrain and flood context around a station
//                 (#121, part of #119).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; across to app.js for rerenderMapLegend.
// Both are only called from inside MapContours' own functions, so this file's
// position among the modules is free, the same way #120 left it for MapSurvey.
//
// This is a different data source and a different question from the Terrain
// elevation-profile tool: Terrain samples ~30 m SRTM along one drawn line to
// answer "does this path have line of sight?"; this draws surveyed LiDAR
// contour lines on the map itself, for a station's immediate surrounds.
//
// ── Server-rendered image, not vector — the issue's own recommendation ──────
//
// SoRT built this feature first (cdomotor-g/SoRT, SITE_MAP_CONFIG →
// loadContourLayer()) against the Esri JS API, and its notes are the reason
// this file starts with the server-rendered path: "full-resolution 1 m LiDAR
// polylines are slower than a server render" — its FeatureLayer path hands
// over to a png8 MapImageLayer for exactly the case this layer exists for.
// Here that is the MapServer's `export` operation drawn as an L.imageOverlay:
// one bounded PNG per view instead of thousands of polyline vertices fighting
// an already pin-heavy canvas map. The costs are accepted knowingly — no
// per-line hover label, and the line symbology is the server's rather than
// SoRT's warmed orange. Vector-with-labels is a later layer-on if wanted.
//
// The overlay fetches a padded box (PAD) around the view and skips the
// re-fetch entirely while a pan stays inside it at the same zoom — the same
// job MapRivers' rounded bbox does for its query cache, done in image space.
const MapContours = (function () {
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Elevation/Contours/MapServer';
  const ATTRIBUTION = '© State of Queensland (Department of Resources)';

  // Sublayer ids per interval, as SoRT's README records them confirmed against
  // the live service (1 m = 30, 5 m = 20, 10 m = 10). Fallbacks only: the live
  // ids are still probed by name at runtime below, because SoRT's probe
  // already had to be adjusted once for how the service actually spells
  // "N metre Contours (LiDAR)". This environment cannot reach the host to
  // re-confirm (#119's shared open risk), so both the probe and these
  // constants are flagged for the live-browser spot-check #119 asks for.
  const FALLBACK_IDS = { '1': 30, '5': 20, '10': 10 };
  const INTERVALS    = ['1', '5', '10'];

  // Its own pane, under the river pane (340) and the survey pane (345) —
  // map-survey.js documents the shared z-index budget and reserves this slot:
  // contours are basemap-like context the same way rivers are, not a point
  // marker competing for the click. The pane also keeps the image off the
  // map's shared canvas renderer (preferCanvas: true in initMap).
  const PANE   = 'mnContours';
  const PANE_Z = 335;

  // Hidden above this scale, matching SoRT's dynamicMinScale (~1:20,000,
  // which its diagnostics found is about where the service stops drawing).
  // A scale threshold rather than a fixed zoom because metres-per-pixel
  // shrink with latitude — a zoom gate tuned at Brisbane misfires at Weipa.
  const MAX_SCALE   = 20000;
  const PAD         = 0.3;     // fraction of the view fetched beyond each edge
  const MAX_PX      = 2048;    // per export dimension — the service's usual cap
  const OPACITY     = 0.8;     // SoRT ships 0.7 for its png8 fallback; a touch
                               // stronger here, there is no cadastre under it
  const DEBOUNCE_MS = 200;
  const TIMEOUT_MS  = 20000;
  const FAIL_TTL    = 60000;

  let map = null, overlay = null, timer = null, seq = 0, failedAt = 0;
  let ids = null, resolving = null;      // probed sublayer ids, once per load
  let drawnBox = null;                   // { bounds, zoom, interval } the overlay covers
  let note = { kind: 'off', interval: '5', shown: null };

  // 1:n scale of the current view at its centre latitude — the standard Web
  // Mercator figure (256 px tiles, 96 dpi): 559,082,264 / 2^z at the equator,
  // shrunk by cos(lat).
  function viewScale() {
    const z   = map.getZoom();
    const lat = map.getCenter().lat * Math.PI / 180;
    return 559082264.028 / Math.pow(2, z) * Math.cos(lat);
  }

  async function askJson(url) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'ArcGIS error');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // Probe the sublayer ids by name, once per page load — SoRT's
  // resolveContourLayers(), ported. "1 m", "1m", "1 metre", "1 metres" all
  // denote the same interval, and the service spells its layers "N metre
  // Contours (LiDAR)", which a plain \bN\s*m\b probe misses. Longest interval
  // first so "10" wins over "1". A failed probe falls back to the confirmed
  // constants rather than to nothing.
  function intervalFromName(name) {
    const m = name.match(/(?:^|[^0-9])(10|5|1)\s*(?:m\b|met(?:re|er)s?\b)/);
    return m ? m[1] : null;
  }

  function resolveIds() {
    if (ids) return Promise.resolve(ids);
    if (resolving) return resolving;
    resolving = askJson(SERVICE_URL + '?f=json')
      .then(json => {
        const found = { ...FALLBACK_IDS };
        for (const l of (json && json.layers) || []) {
          const name = String(l.name || '').toLowerCase();
          if (!/lidar/.test(name) && !/contour/.test(name)) continue;
          const k = intervalFromName(name);
          if (k) found[k] = l.id;
        }
        ids = found;
        return ids;
      })
      .catch(() => {
        ids = { ...FALLBACK_IDS };
        return ids;
      });
    return resolving;
  }

  // The requested interval's sublayer, or the nearest available one — SoRT's
  // own fallback order, so the default never renders a blank layer while the
  // note says which interval is actually drawn.
  function pickInterval(resolvedIds) {
    for (const k of [state.mapContourInterval, '5', '1', '10']) {
      if (resolvedIds[k] != null) return k;
    }
    return null;
  }

  function clearOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    drawnBox = null;
    if (map && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  function setNote(kind, extra) {
    note = { kind, interval: state.mapContourInterval, shown: extra && extra.shown };
    const el = document.getElementById('map-contour-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':     return 'Contours are hidden.';
      case 'zoom':    return 'Zoom in to draw contours — they exist below about 1:20,000, and this view is wider than that.';
      case 'loading': return 'Drawing contours… they are the slow part.';
      case 'fail':    return 'Contours unavailable — the Queensland spatial data service could not be reached.';
      case 'ok':
        return note.shown && note.shown !== note.interval
          ? `<strong>${note.shown} m</strong> contours drawn — the ${note.interval} m sublayer did not resolve, this is the nearest available.`
          : `<strong>${note.interval} m</strong> contours drawn.`;
      default:        return '';
    }
  }

  function run() {
    if (!state.mapContours) { clearOverlay(); setNote('off'); return; }
    if (!map) return;
    if (viewScale() > MAX_SCALE) { clearOverlay(); setNote('zoom'); return; }

    // Still inside the padded image at the same zoom and interval? Then the
    // overlay already covers this view — no request.
    if (overlay && drawnBox
        && drawnBox.zoom === map.getZoom()
        && drawnBox.interval === state.mapContourInterval
        && drawnBox.bounds.contains(map.getBounds())) { setNote('ok', { shown: drawnBox.shown }); return; }

    if (Date.now() - failedAt < FAIL_TTL) { clearOverlay(); setNote('fail'); return; }

    const mine = ++seq;
    setNote('loading');
    resolveIds().then(resolvedIds => {
      if (mine !== seq || !map) return;
      const shown = pickInterval(resolvedIds);
      if (shown == null) throw new Error('no contour sublayer resolved');

      const bounds = map.getBounds().pad(PAD);
      const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
      const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
      const px = map.getSize();
      let w = Math.round(px.x * (1 + 2 * PAD)), h = Math.round(px.y * (1 + 2 * PAD));
      const over = Math.max(w, h) / MAX_PX;
      if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }

      // png8 + dpi 96, as SoRT ships its fallback — the lean export.
      const params = new URLSearchParams({
        f: 'image', format: 'png8', transparent: 'true', dpi: '96',
        bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
        bboxSR: '3857', imageSR: '3857',
        size: `${w},${h}`,
        layers: `show:${resolvedIds[shown]}`,
      });
      const url = `${SERVICE_URL}/export?${params}`;

      // Preload, so a pan swaps a finished image in rather than blanking the
      // layer while the next one arrives — and so a failure is an onerror
      // here, not a broken overlay on the map.
      const img = new Image();
      const t = setTimeout(() => { img.src = ''; }, TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(t);
        if (mine !== seq || !map || !state.mapContours) return;
        const had = !!overlay;
        if (overlay) overlay.remove();
        overlay = L.imageOverlay(url, bounds, { pane: PANE, opacity: OPACITY }).addTo(map);
        drawnBox = { bounds, zoom: map.getZoom(), interval: state.mapContourInterval, shown };
        if (!had && map.attributionControl) map.attributionControl.addAttribution(ATTRIBUTION);
        setNote('ok', { shown });
        rerenderMapLegend();
      };
      img.onerror = () => {
        clearTimeout(t);
        if (mine !== seq || !map) return;
        failedAt = Date.now();
        clearOverlay();
        setNote('fail');
      };
      img.src = url;
    }).catch(() => {
      if (mine !== seq || !map) return;
      failedAt = Date.now();
      clearOverlay();
      setNote('fail');
    });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', sync);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clearOverlay();
      map = null;
      seq++;
    },

    sync,

    // Does the legend claim a contour key right now? Same gate as MapSurvey.
    active() { return !!overlay; },

    noteHtml,

    // Off by default, not persisted — the same reasoning map-survey.js records:
    // a context layer that costs network requests stays off until asked for,
    // and "no extra requests fire with the layer off" stays true of a fresh
    // page load without reasoning about a remembered on-state.
    setEnabled(on) {
      state.mapContours = on;
      if (!on) { clearTimeout(timer); clearOverlay(); setNote('off'); return; }
      setNote(map && viewScale() <= MAX_SCALE ? 'loading' : 'zoom');
      sync();
    },

    // 1 ↔ 5 ↔ 10 swaps re-fetch (drawnBox carries the interval, so run() sees
    // the mismatch); the old image stays up until its replacement has loaded,
    // which is what "swaps cleanly with no leftover lines" means for a
    // single-image layer — there is never more than one overlay to leak.
    setInterval(v) {
      if (!INTERVALS.includes(v)) return;
      state.mapContourInterval = v;
      if (state.mapContours) sync();
    },
  };
})();
