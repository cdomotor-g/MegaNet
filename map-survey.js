// MegaNet — map-survey.js
//
//   MapSurvey   permanent survey marks (PSM), CORS sites and other geodetic
//               control points from the Queensland spatial data platform,
//               drawn over the Stations map for field crews doing a
//               height/levelling check near a site (#120, part of #119).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; across to app.js for rerenderMapLegend
// and esc. Both are only called from inside MapSurvey's own functions, so
// this file's position among the modules is free, the same way #133 left it
// for MapRivers.
//
// The shape below mirrors MapRivers deliberately (#119's own integration
// notes ask for it): bbox rounding, an LRU cache keyed by view, a debounced
// re-fetch on moveend, silent non-blocking failure, and a status note with
// the same five-state vocabulary. Two differences, both because the trigger
// is different: rivers fire off the filter box, survey marks fire off the
// toggle and the current view, so there is no search-term gate here — a
// minimum zoom stands in for it — and there is no repaint() hook, because a
// divIcon marker is styled from styles.css (var(--map-survey)) rather than
// drawn into an SVG with a colour baked in at fetch time, so a theme switch
// repaints it for free.
const MapSurvey = (function () {
  // The full survey-control service. Several sublayers (CORS, survey control
  // marks split by datum, AHD heights split by how they were derived,
  // cadastral connection, destroyed marks) — resolved by name at runtime
  // below, never by a guessed numeric id.
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/SurveyControl/MapServer';
  // The simpler flat point layer the issue names as a fallback starting
  // point. Used when the service above can't be reached or its sublayer
  // names don't match anything recognisable — a real, issue-cited id rather
  // than a guessed sublayer number, which is why it's the fallback and not a
  // hardcoded entry in MARK_NAME/CORS_NAME below.
  const FALLBACK_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/FoundationData/FeatureServer/8';
  const ATTRIBUTION  = '© State of Queensland (Department of Resources)';

  const PANE        = 'mnSurvey';
  // Sits between the river pane (340) and the leader lines (350) in the
  // z-index budget MapRivers documents — points drawn over context lines,
  // under anything that has to win a click. #121 (contours) is sequenced
  // after this issue specifically so it can read this line rather than
  // picking a z-index blind; a basemap-context layer like contours belongs
  // *under* the river pane (e.g. 335), not between it and this one.
  const PANE_Z       = 345;
  // Below this, survey marks are a scatter across a region with no use to a
  // field crew (there are thousands in Queensland) — the same "not a
  // meaningful scatter yet" judgement call MapRivers' BBOX_MAX makes for
  // rivers, made on zoom instead because marks aren't filtered by a term.
  const MIN_ZOOM     = 12;
  const DEBOUNCE_MS  = 200;    // moveend settles on its own; this is just a safety margin
  const TIMEOUT_MS   = 20000;
  const BBOX_STEP    = 0.05;   // deg (~5 km) — tighter than rivers' 0.25, points are denser
  const BBOX_MAX     = 3;      // deg — a belt-and-braces backstop behind MIN_ZOOM
  const PER_LAYER_CAP = 200;   // resultRecordCount asked of each sublayer query
  const MAX_MARKS    = 400;    // rendered per view, across every sublayer combined
  const CACHE_MAX    = 30;
  const FAIL_TTL     = 60000;

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  let resolved = null, resolving = null;   // sublayer resolution — see resolveLayers()
  const cache = new Map();   // 's,w,n,e' → { points, capped, total }
  let note = { kind: 'off', drawn: 0, total: 0, capped: false };

  // Best-effort field matching. The environment this was built in can't reach
  // spatial-gis.information.qld.gov.au (see #119's "shared open risk"), so the
  // exact attribute names on each sublayer were never confirmed — these are
  // patterns broad enough to catch the field-naming conventions Queensland's
  // other open-data services use, not names lifted from a live response.
  // Flagged for the live-browser spot-check #119 asks for.
  const REGISTER_KEYS = [/^reg(ister)?[_ ]?no/i, /^mark[_ ]?no/i, /^psm[_ ]?no/i, /station[_ ]?name/i, /^name$/i, /^label$/i];
  const AHD_KEYS       = [/ahd/i];

  function pickField(attrs, patterns) {
    if (!attrs) return null;
    for (const re of patterns) {
      const k = Object.keys(attrs).find(k => re.test(k));
      if (k && attrs[k] != null && attrs[k] !== '') return String(attrs[k]);
    }
    return null;
  }

  function pickNumericField(attrs, patterns) {
    if (!attrs) return null;
    for (const re of patterns) {
      const k = Object.keys(attrs).find(k => re.test(k) && typeof attrs[k] === 'number');
      if (k) return attrs[k];
    }
    return null;
  }

  // Rounded outward, same trick as MapRivers, so a small pan re-uses the
  // answer it already has rather than re-querying for a near-identical box.
  function roundedBbox(b) {
    const down = v => Math.floor(v / BBOX_STEP) * BBOX_STEP;
    const up   = v => Math.ceil(v / BBOX_STEP) * BBOX_STEP;
    return {
      s: Math.max(-90,  down(b.getSouth())), w: Math.max(-180, down(b.getWest())),
      n: Math.min(90,   up(b.getNorth())),   e: Math.min(180,  up(b.getEast())),
    };
  }

  async function askJson(url) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // ArcGIS Server returns its own errors as HTTP 200 with an `error` body.
      if (json && json.error) throw new Error(json.error.message || 'ArcGIS error');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // Which sublayers to ask, resolved once per page load and cached — the same
  // "probe by name, don't guess an id" shape SoRT's resolveContourLayers()
  // uses for its own contour sublayers (cited by #120). Destroyed marks and
  // the cadastral-connection sublayer are deliberately never queried: #120
  // asks that destroyed marks be excluded or visibly distinguished, and
  // "excluded" is the decision made here (scope item 5); cadastral
  // connections aren't a field-crew benchmark concern and are a stated
  // non-goal on #119.
  function resolveLayers() {
    if (resolved) return Promise.resolve(resolved);
    if (resolving) return resolving;
    resolving = askJson(SERVICE_URL + '/layers?f=json')
      .then(json => {
        const layers = (json && json.layers) || [];
        const mark = [], cors = [];
        for (const l of layers) {
          const name = l.name || '';
          if (/destroyed/i.test(name) || /cadastral/i.test(name)) continue;
          if (/cors/i.test(name)) cors.push(l.id);
          else if (/(gda|control mark|survey control)/i.test(name)) mark.push(l.id);
        }
        if (!mark.length && !cors.length) throw new Error('no recognisable sublayer names');
        resolved = { mode: 'probed', mark, cors };
        return resolved;
      })
      .catch(() => {
        resolved = { mode: 'fallback' };
        return resolved;
      });
    return resolving;
  }

  function queryUrl(base, id, b) {
    const params = new URLSearchParams({
      f: 'json', where: '1=1',
      geometry:     `${b.w},${b.s},${b.e},${b.n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*', returnGeometry: 'true',
      resultRecordCount: String(PER_LAYER_CAP),
    });
    return `${id == null ? base : `${base}/${id}`}/query?${params}`;
  }

  // Esri JSON straight to the {lat, lon, …} shape draw() wants — building an
  // actual GeoJSON object here would only be decomposed right back out for
  // L.marker, so that intermediate step is skipped.
  function pointsFromEsriJson(json, category) {
    const out = [];
    for (const f of (json && json.features) || []) {
      const g = f.geometry;
      if (!g || g.x == null || g.y == null) continue;
      out.push({
        lat: g.y, lon: g.x, category,
        register: pickField(f.attributes, REGISTER_KEYS),
        ahd:      pickNumericField(f.attributes, AHD_KEYS),
      });
    }
    return out;
  }

  function queriesFor(layers, b) {
    if (layers.mode === 'fallback') {
      return [{ url: queryUrl(FALLBACK_URL, null, b), category: 'mark' }];
    }
    return [
      ...layers.mark.map(id => ({ url: queryUrl(SERVICE_URL, id, b), category: 'mark' })),
      ...layers.cors.map(id => ({ url: queryUrl(SERVICE_URL, id, b), category: 'cors' })),
    ];
  }

  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function cachePut(key, v) {
    cache.set(key, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // Attribution is added only while marks are actually on the map, not merely
  // while the toggle is — the same "claim it while you're using it" reading
  // the legend entry already applies via active().
  function clearLayer() {
    if (!layer) return;
    layer.remove();
    layer = null;
    if (map && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  function draw(points) {
    clearLayer();
    if (!map || !points.length) return;
    layer = L.layerGroup().addTo(map);
    if (map.attributionControl) map.attributionControl.addAttribution(ATTRIBUTION);
    for (const p of points) {
      const isCors = p.category === 'cors';
      const icon = L.divIcon({
        className: 'mn-survey-div',
        html: `<div class="mn-survey-pin ${isCors ? 'mn-survey-cors' : 'mn-survey-mark'}"></div>`,
        iconSize:   isCors ? [14, 13] : [10, 9],
        iconAnchor: isCors ? [7, 10]  : [5, 7],
      });
      const label = p.register || (isCors ? 'CORS site' : 'Survey mark');
      const m = L.marker([p.lat, p.lon], { pane: PANE, icon }).addTo(layer);
      m.bindTooltip(esc(label), { direction: 'top', offset: [0, -10] });
      m.bindPopup(`
        <strong>${esc(label)}</strong><br>
        <span class="mn-pop-line">${isCors ? 'CORS site' : 'Survey control mark'}</span><br>
        <span class="mn-pop-line">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>
        ${p.ahd != null ? `<br><span class="mn-pop-line">${p.ahd} m AHD</span>` : ''}
      `, { maxWidth: 260 });
    }
    rerenderMapLegend();
  }

  function setNote(kind, entry) {
    note = {
      kind,
      drawn:  entry ? entry.points.length : 0,
      total:  entry ? entry.total : 0,
      capped: !!(entry && entry.capped),
    };
    const el = document.getElementById('map-survey-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':     return 'Survey marks are hidden.';
      case 'zoom':    return 'Zoom in to look up survey marks — this view is too wide to ask for.';
      case 'loading': return 'Looking up survey marks…';
      case 'fail':    return 'Survey marks unavailable — the Queensland spatial data service could not be reached.';
      case 'ok':
        if (!note.drawn) return 'No survey marks in view.';
        return `<strong>${note.drawn}</strong> mark${note.drawn === 1 ? '' : 's'} in view` +
               (note.capped ? ` · more in view not drawn` : '') + '.';
      default:        return '';
    }
  }

  function run() {
    if (!state.mapSurvey) { clearLayer(); setNote('off'); return; }
    if (!map) return;
    if (map.getZoom() < MIN_ZOOM) { clearLayer(); setNote('zoom'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('zoom'); return; }

    const key = [b.s, b.w, b.n, b.e].map(v => v.toFixed(2)).join(',');
    const hit = cacheGet(key);
    if (hit) { draw(hit.points); setNote('ok', hit); return; }
    if (Date.now() - failedAt < FAIL_TTL) { clearLayer(); setNote('fail'); return; }

    const mine = ++seq;
    setNote('loading');
    resolveLayers().then(layers => {
      if (mine !== seq || !map) return;
      const queries = queriesFor(layers, b);
      return Promise.all(queries.map(q =>
        askJson(q.url).then(json => pointsFromEsriJson(json, q.category)).catch(() => null)
      )).then(results => {
        if (mine !== seq || !map) return;
        // One bad sublayer doesn't sink the rest; every sublayer failing does.
        if (results.every(r => r === null)) throw new Error('every sublayer query failed');
        const all = results.filter(Boolean).flat();
        const capped = all.length > MAX_MARKS;
        const entry = { points: capped ? all.slice(0, MAX_MARKS) : all, capped, total: all.length };
        cachePut(key, entry);
        draw(entry.points);
        setNote('ok', entry);
      });
    }).catch(() => {
      if (mine !== seq || !map) return;
      failedAt = Date.now();
      clearLayer();
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
      clearLayer();
      map = null;
      seq++;
    },

    sync,

    // Does the legend claim a survey-mark key right now? Same gate MapRivers
    // uses for its own legend entry.
    active() { return !!layer; },

    noteHtml,

    // Not persisted to localStorage, unlike MapRivers. This is a specialist
    // layer (a field crew checking a benchmark near a site) rather than
    // something most sessions want on; off-by-default-every-visit is one
    // click to undo and keeps "no extra requests fire with the layer off"
    // true of a fresh page load without having to reason about a remembered
    // on-state.
    setEnabled(on) {
      state.mapSurvey = on;
      if (!on) { clearTimeout(timer); clearLayer(); setNote('off'); return; }
      setNote(map && map.getZoom() >= MIN_ZOOM ? 'loading' : 'zoom');
      sync();
    },
  };
})();
