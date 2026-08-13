// ── River highlighting ───────────────────────────────────────────────────────
// Half this network is named after the river it sits on, so typing "burdekin"
// into the filter box lights up the Burdekin as well as the stations on it.
// Rivers are context, never matches: they draw beneath the pins, they never move
// the map, and they have no say in what the filter selects. Turn the switch off
// and the Stations tab behaves exactly as it did before this existed.
//
// The geometry comes from OpenStreetMap over Overpass — national, live, named,
// and in real coordinates. The bundled `assets/geo/Qld Major Streams_reduced.svg`
// is deliberately *not* used: inverting `BASIN_GEOREF` (maps-data.js) puts its
// features 100–150 km from the actual watercourse, consistently west and south.
// That is accurate enough for its own job — point-in-polygon against 65 basins
// the size of small countries — and useless for drawing a line over a
// topographic basemap, where 100 km off is worse than drawing nothing. No affine
// fixes it either: the source is a projected map. See issue #84.
//
// Overpass is a free public service, so every request has to earn itself: a
// name-ish term only (a bare number in that box is an ALERT address, not a
// river), debounced past the marker rebuild, bounded by the current view, capped,
// and cached by term and rounded bbox so a small pan or a retyped word costs
// nothing. Failure is silent and non-blocking — no network, no rivers, and the
// station filter behaves exactly as it does with the switch off.
const MapRivers = (function () {
  // Both of these serve `Access-Control-Allow-Origin: *`. The list is a list
  // because CORS from the deployed origin is the one thing that can sink this
  // (see #66, and the README on BoM/ACMA), and a second endpoint costs a line.
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const PANE        = 'mnRivers';
  const MIN_TERM    = 3;      // two letters matches half the watercourses in Queensland
  const DEBOUNCE_MS = 450;    // longer than the 160 ms marker rebuild: this one costs a request
  const TIMEOUT_MS  = 20000;
  const MAX_WAYS    = 250;    // ways drawn per query — a long river is many ways
  const BBOX_STEP   = 0.25;   // deg; the bbox is rounded out to this for the cache key,
                              // so nudging the map re-uses the answer it already has
  const BBOX_MAX    = 12;     // deg; a continent-wide view is not a fair thing to ask for
  const CACHE_MAX   = 40;     // (term, bbox) answers kept — a session's worth of searching
  const FAIL_TTL    = 60000;  // how long a failure is remembered before another attempt

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  const cache = new Map();    // 'terms|s,w,n,e' → { ways: [{name, coords}], capped, total }
  let note = { kind: 'idle', drawn: 0, total: 0, capped: false };

  // What in the box is worth asking Overpass about. `parseSearchTerms` has
  // already split and lower-cased them; a term with no letter in it is an ALERT
  // address or a station number, and the app already treats it that way.
  function riverTerms() {
    if (!state.mapRivers) return [];
    return prepareSearch(state.filters.search).terms
      .filter(t => t.length >= MIN_TERM && /[a-z]/.test(t));
  }

  // Rounded *outward*, so the box asked for always contains the box on screen.
  function roundedBbox(b) {
    const down = v => Math.floor(v / BBOX_STEP) * BBOX_STEP;
    const up   = v => Math.ceil(v / BBOX_STEP) * BBOX_STEP;
    return {
      s: Math.max(-90,  down(b.getSouth())), w: Math.max(-180, down(b.getWest())),
      n: Math.min(90,   up(b.getNorth())),   e: Math.min(180,  up(b.getEast())),
    };
  }

  function reEscape(t) { return t.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&'); }

  // `out geom;` returns the coordinates inline, so this is one request with no
  // recursion behind it.
  function overpassQl(terms, b) {
    const re = terms.map(reEscape).join('|');
    const box = [b.s, b.w, b.n, b.e].map(v => v.toFixed(4)).join(',');
    return `[out:json][timeout:25];\n` +
           `way["waterway"~"^(river|stream)$"]["name"~"${re}",i](${box});\n` +
           `out geom;`;
  }

  async function ask(ql) {
    let last = null;
    for (const url of ENDPOINTS) {
      const ctl = new AbortController();
      const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method:  'POST',
          signal:  ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    'data=' + encodeURIComponent(ql),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        last = err;                     // try the mirror before giving up
      } finally {
        clearTimeout(t);
      }
    }
    throw last || new Error('no Overpass endpoint answered');
  }

  function waysFrom(json) {
    const out = [];
    for (const el of (json && json.elements) || []) {
      const coords = [];
      for (const p of el.geometry || []) {
        if (p && p.lat != null && p.lon != null) coords.push([p.lat, p.lon]);
      }
      if (coords.length < 2) continue;
      out.push({ name: (el.tags && el.tags.name) || 'Unnamed watercourse', coords });
    }
    return out;
  }

  // Insertion order is the whole of the LRU: re-inserting on read moves an entry
  // to the young end, and the oldest key is the first one out.
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

  // The legend only claims a river line while one is on the map, so it is
  // re-rendered whenever the layer appears or goes — the same deal the ACMA
  // colours have with it.
  function clearLayer() {
    if (!layer) return;
    layer.remove();
    layer = null;
    rerenderMapLegend();
  }

  function draw(ways) {
    clearLayer();
    if (!map || !ways.length) return;
    const colour = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-river').trim() || '#1565c0';
    // An explicit SVG renderer rather than the map's shared canvas. A canvas in
    // this pane would cover the whole map and swallow pointer events that reach
    // it today (the map's own click, MapDraw); an SVG path only takes the pointer
    // on its own stroke, which is exactly what a hover label wants. A few hundred
    // thin paths is nothing beside the pins.
    const renderer = L.svg({ pane: PANE });
    layer = L.layerGroup().addTo(map);
    // Same two-pass trick as the pass-range links: every white casing first, then
    // every coloured core, so one river's casing can't paint over another's line
    // where they meet. A 2.5 px blue line vanishes into satellite imagery and
    // into the blue the topo tiles already draw water in; the casing is what
    // carries it on every basemap.
    for (const pass of ['casing', 'core']) {
      const casing = pass === 'casing';
      for (const w of ways) {
        const line = L.polyline(w.coords, {
          renderer, pane: PANE,
          color:       casing ? '#ffffff' : colour,
          weight:      casing ? 5 : 2.5,
          opacity:     casing ? 0.45 : 0.9,
          interactive: !casing,
        }).addTo(layer);
        if (!casing) line.bindTooltip(w.name, { sticky: true, className: 'mn-river-label' });
      }
    }
    rerenderMapLegend();
  }

  function setNote(kind, entry) {
    note = {
      kind,
      drawn:  entry ? entry.ways.length : 0,
      total:  entry ? entry.total : 0,
      capped: !!(entry && entry.capped),
    };
    const el = document.getElementById('map-river-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':     return 'Rivers are hidden.';
      case 'wide':    return 'Zoom in to look up rivers — this view is too wide to ask for.';
      case 'loading': return 'Looking up rivers…';
      case 'fail':    return 'Rivers unavailable — OpenStreetMap could not be reached.';
      case 'ok':
        if (!note.drawn) return 'No named watercourse in view matches the filter.';
        return `<strong>${note.drawn}</strong> river segment${note.drawn === 1 ? '' : 's'} drawn` +
               (note.capped ? ` · ${note.total - note.drawn} more in view not drawn` : '') + '.';
      default:        return 'Type a name in the filter box to light up matching rivers.';
    }
  }

  function run() {
    if (!map) return;
    const terms = riverTerms();
    if (!terms.length) { clearLayer(); setNote(state.mapRivers ? 'idle' : 'off'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('wide'); return; }

    const key = terms.join('+') + '|' + [b.s, b.w, b.n, b.e].map(v => v.toFixed(2)).join(',');
    const hit = cacheGet(key);
    if (hit) { draw(hit.ways); setNote('ok', hit); return; }
    if (Date.now() - failedAt < FAIL_TTL) { clearLayer(); setNote('fail'); return; }

    // Only the newest query may draw: typing "bur" then "burdekin" leaves two
    // requests in flight, and the slower one is the wrong answer.
    const mine = ++seq;
    setNote('loading');
    ask(overpassQl(terms, b)).then(json => {
      if (mine !== seq || !map) return;
      const all    = waysFrom(json);
      const capped = all.length > MAX_WAYS;
      const entry  = { ways: capped ? all.slice(0, MAX_WAYS) : all, capped, total: all.length };
      cachePut(key, entry);
      draw(entry.ways);
      setNote('ok', entry);
    }).catch(() => {
      if (mine !== seq || !map) return;
      failedAt = Date.now();            // don't hammer a service that just said no
      clearLayer();
      setNote('fail');
    });
  }

  // Held off until the typing pauses: a search rebuilds every marker already, and
  // this one also spends a request.
  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    // Wire a freshly built map. The pane sits under the leader lines (350), the
    // pass-range links (overlayPane, 400) and the pins (markerPane, 600), so a
    // river never draws over the network it is context for.
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = 340;
      // Rivers are bounded by the view, so a pan or a zoom is a new question.
      // Usually a cached one: the bbox is rounded before it becomes a key.
      m.on('moveend', sync);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clearLayer();
      map = null;
      seq++;                            // a request in flight has nothing to draw on
    },

    // The filter box changed, or the switch did.
    sync,

    // Theme switch. The colour is read at draw time, so this re-draws what is
    // already there — off the cache, with no request.
    repaint() { if (layer) run(); },

    // Are there rivers on the map right now? The legend asks before claiming a
    // river line, the way it does for the ACMA colours.
    active() { return !!layer; },

    noteHtml,

    setEnabled(on) {
      state.mapRivers = on;
      try { localStorage.setItem('mn-rivers', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearTimeout(timer); clearLayer(); setNote('off'); return; }
      setNote(riverTerms().length ? 'loading' : 'idle');   // don't leave "hidden" up for the debounce
      sync();
    },
  };
})();

