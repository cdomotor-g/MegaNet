// MegaNet — map-rivers.js
//
//   MapRivers   OpenStreetMap watercourses drawn under the station pins, lit up
//               by whatever is typed into the Stations filter box.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and `esc`, and across to app.js for
// rerenderMapLegend and prepareSearch. Every one of those is called from inside
// a MapRivers function; the IIFE body only sets tunables and an empty cache, so
// nothing here resolves at load and this file's position among the modules is
// free.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129. What it does, and why
// Overpass rather than the bundled basin SVG, is in the banner below.
//
// ── Pointer conventions in the mnRivers pane (#150 — #120/#121 copy this) ────
// NOTHING in this pane takes the pointer, and that is a discovered fact, not
// a choice: the Stations map runs one shared canvas for ~3,100 pins and the
// links (preferCanvas — app.js initMap), it lives in the overlay pane ABOVE
// this one, its pointer-events are auto across the whole map, and a DOM event
// that hits none of the canvas's own layers bubbles UP the pane stack to the
// map — never sideways into a sibling SVG. The sticky hover tooltip this file
// bound to the 2.5 px core from M2 to #150 was therefore unreachable whenever
// that canvas was present, which on this tab is always; #150 found this by
// driving the real page. So interaction is delegated instead: the map's own
// click and mousemove are hit-tested here against the drawn geometry, in
// layer space, within HIT_WEIGHT/2 px of a stroke — a finger-sized target
// without fattening the visible line. Draw clicks and link-budget picks win
// (the same precedence everything else on the map gives them), and a click
// that hits a pin never gets here at all — the pin's handler stops
// propagation before the map's click fires. An overlay copying the MapRivers
// pattern copies this delegation or stays non-interactive; binding pointer
// handlers to paths in a pane under the shared canvas binds them to nothing.

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
  const HIT_WEIGHT  = 12;     // px; the transparent pass that takes the pointer (#150)
  const LABEL_CAP   = 12;     // named-river labels per view — more than this is a word search
  const LABEL_MIN_PX = 80;    // a river showing less than this on screen can't carry a name
  const NOTE_BTN_CAP = 20;    // river buttons listed in the note before "+N more"
  const UNNAMED     = 'Unnamed watercourse';

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  let rivers = [];            // the drawn geometry grouped by name — the unit #150 works on
  let drawnKey = null;        // which cache entry is on screen, so a pan is not a redraw
  let popup = null;           // the open callout, if any — ours to close on clear
  const labelTips = new Map();// river name → its permanent L.tooltip, re-anchored in place
  const cache = new Map();    // 'terms|s,w,n,e' → { ways: [{name, coords}], capped, total }
  let note = { kind: 'idle', drawn: 0, total: 0, capped: false, rivers: [], labelCapped: false };

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
    if (popup) { popup.remove(); popup = null; }
    for (const tip of labelTips.values()) tip.remove();
    labelTips.clear();
    clearHover();
    projected = null;
    rivers = [];
    drawnKey = null;
    if (!layer) return;
    layer.remove();
    layer = null;
    rerenderMapLegend();
  }

  // Overpass returns a river as many ways (MAX_WAYS exists because a long
  // river is many ways), so a label per way would be 250 labels for one
  // river. The unit everything below works on is the NAMED RIVER (#150 A1);
  // an unnamed group gets no label and no callout — it stays as it was.
  function groupRivers(ways) {
    const byName = new Map();
    for (const w of ways) {
      if (!byName.has(w.name)) byName.set(w.name, { name: w.name, named: w.name !== UNNAMED, ways: [] });
      byName.get(w.name).ways.push(w);
    }
    return [...byName.values()];
  }

  // Where a river's name goes: the middle vertex of its longest in-view run,
  // measured in screen pixels so "long enough to carry a name" means what the
  // eye means by it. Null when nothing usable is in view.
  function labelSpot(river) {
    if (!map) return null;
    const bounds = map.getBounds();
    let best = null;
    for (const w of river.ways) {
      const pts = w.coords.filter(c => bounds.contains(c));
      if (pts.length < 2) continue;
      let px = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        const a = map.latLngToContainerPoint(pts[i - 1]);
        const b = map.latLngToContainerPoint(pts[i]);
        px += Math.hypot(a.x - b.x, a.y - b.y);
        cum.push(px);
      }
      if (!best || px > best.px) {
        let mi = 0;
        while (mi < cum.length - 1 && cum[mi] < px / 2) mi++;
        best = { px, at: pts[mi] };
      }
    }
    return best;
  }

  // One permanent label per named river in view (#150 A2), the pattern
  // applyMapLabels() set for pins: a cap, a skip for a river whose on-screen
  // extent is too short to carry a name, and bind/unbind IN PLACE on every
  // pan — never a layer rebuild, which here would also mean a trip through
  // the Overpass cache. When the cap bites, the longest runs win: for pins
  // nearest-to-centre is the honest pick, but a river IS its extent.
  function applyLabels() {
    const spots = [];
    for (const r of rivers) {
      if (!r.named) continue;
      const s = labelSpot(r);
      if (s && s.px >= LABEL_MIN_PX) spots.push({ name: r.name, at: s.at, px: s.px });
    }
    const capped = spots.length > LABEL_CAP;
    const picked = capped
      ? spots.slice().sort((a, b) => b.px - a.px).slice(0, LABEL_CAP)
      : spots;
    const want = new Map(picked.map(s => [s.name, s]));
    for (const [name, tip] of labelTips) {
      if (!want.has(name)) { tip.remove(); labelTips.delete(name); }
    }
    for (const [name, s] of want) {
      const tip = labelTips.get(name);
      if (tip) { tip.setLatLng(s.at); continue; }
      labelTips.set(name, L.tooltip({
        permanent: true, direction: 'center', interactive: false,
        className: 'mn-river-label mn-river-label-fixed',
      }).setContent(esc(name)).setLatLng(s.at).addTo(map));
    }
    return { labelled: want.size, labelCapped: capped };
  }

  // The callout a click (or a note button — A4) opens. Part A ships the name
  // and the segment count; Part B decides what else belongs here.
  function calloutHtml(river) {
    const n = river.ways.length;
    return `<strong>${esc(river.name)}</strong><br>` +
           `${n} segment${n === 1 ? '' : 's'} drawn in this view`;
  }

  function openCalloutAt(river, at) {
    if (!map || !river) return;
    const spot = at || (labelSpot(river) || {}).at || river.ways[0].coords[0];
    if (popup) popup.remove();
    popup = L.popup({ className: 'mn-river-popup' })
      .setLatLng(spot).setContent(calloutHtml(river)).openOn(map);
  }

  // ── Map-level hit testing (#150 A3) ────────────────────────────────────────
  // See the header: no path in this pane can take the pointer, so the map's
  // own events are hit-tested against the geometry. Layer points are stable
  // across pans and change only on zoom, so the projection is rebuilt on draw
  // and on zoomend, and each way carries its own bounding box so a mousemove
  // rejects almost everything before touching a segment.

  let projected = null;    // [{ river, pts, bbox }] in layer space
  let hoverTip  = null;    // the one reusable hover name
  let hoverName = null;
  let cursorSet = false;
  let moveRaf   = null;

  function reproject() {
    projected = null;
    if (!map || !rivers.length) return;
    projected = [];
    for (const r of rivers) {
      for (const w of r.ways) {
        const pts = w.coords.map((c) => map.latLngToLayerPoint(c));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        projected.push({ river: r, pts, bbox: { minX, minY, maxX, maxY } });
      }
    }
  }

  function segDist2(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
    return x * x + y * y;
  }

  function riverAtPoint(layerPt) {
    if (!projected) return null;
    const R = HIT_WEIGHT / 2;
    let best = null, bestD = R * R;
    for (const w of projected) {
      const b = w.bbox;
      if (layerPt.x < b.minX - R || layerPt.x > b.maxX + R
          || layerPt.y < b.minY - R || layerPt.y > b.maxY + R) continue;
      for (let i = 1; i < w.pts.length; i++) {
        const d = segDist2(layerPt, w.pts[i - 1], w.pts[i]);
        if (d <= bestD) { bestD = d; best = w.river; }
      }
    }
    return best;
  }

  function clearHover() {
    hoverName = null;
    if (hoverTip) { hoverTip.remove(); hoverTip = null; }
    if (cursorSet && map) { map.getContainer().style.cursor = ''; cursorSet = false; }
  }

  function onMapClick(e) {
    if (!layer) return;
    if (state.draw.tool) return;                    // an armed draw tool owns the click
    if (state.link && state.link.picking) return;   // so does a link-budget pick
    const r = riverAtPoint(e.layerPoint);
    if (r && r.named) openCalloutAt(r, e.latlng);
  }

  function onMapMove(e) {
    if (!layer || moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!map || !layer) return;
      const r = state.draw.tool ? null : riverAtPoint(e.layerPoint);
      if (!r) { clearHover(); return; }
      map.getContainer().style.cursor = 'pointer';
      cursorSet = true;
      if (!hoverTip) {
        hoverTip = L.tooltip({ className: 'mn-river-label', direction: 'top',
                               offset: [0, -8], interactive: false })
          .setContent(esc(r.name)).setLatLng(e.latlng).addTo(map);
      } else {
        hoverTip.setLatLng(e.latlng);
        if (hoverName !== r.name) hoverTip.setContent(esc(r.name));
      }
      hoverName = r.name;
    });
  }

  function draw(entry, key) {
    clearLayer();
    drawnKey = key || null;
    if (!map || !entry.ways.length) return;
    rivers = groupRivers(entry.ways);
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
    // carries it on every basemap. Neither pass is interactive — the pointer
    // never reaches this pane (see the header); the hover name and the click
    // callout ride the map-level hit test instead.
    for (const pass of ['casing', 'core']) {
      const casing = pass === 'casing';
      for (const r of rivers) {
        for (const w of r.ways) {
          L.polyline(w.coords, {
            renderer, pane: PANE,
            color:       casing ? '#ffffff' : colour,
            weight:      casing ? 5 : 2.5,
            opacity:     casing ? 0.45 : 0.9,
            interactive: false,
          }).addTo(layer);
        }
      }
    }
    reproject();
    rerenderMapLegend();
  }

  function setNote(kind, entry, labelStats) {
    note = {
      kind,
      drawn:  entry ? entry.ways.length : 0,
      total:  entry ? entry.total : 0,
      capped: !!(entry && entry.capped),
      // Named rivers drawn, sorted — each becomes a real control in the note
      // (#150 A4). This is the keyboard and touch path to the callout: one
      // <button> per river, in the DOM, in tab order, announced, and costing
      // no map-interaction work at all.
      rivers: kind === 'ok' ? rivers.filter(r => r.named).map(r => r.name).sort() : [],
      labelCapped: !!(labelStats && labelStats.labelCapped),
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
      case 'ok': {
        if (!note.drawn) return 'No named watercourse in view matches the filter.';
        const n = note.rivers.length;
        const head =
          `<strong>${n}</strong> named river${n === 1 ? '' : 's'} · ` +
          `<strong>${note.drawn}</strong> segment${note.drawn === 1 ? '' : 's'} drawn` +
          (note.capped ? ` · ${note.total - note.drawn} more in view not drawn` : '') +
          (note.labelCapped ? ` · naming the ${LABEL_CAP} longest` : '') + '.';
        if (!n) return head;
        const listed = note.rivers.slice(0, NOTE_BTN_CAP);
        const more   = note.rivers.length - listed.length;
        return head + '<span class="mn-river-note-btns">' +
          listed.map(name =>
            `<button type="button" class="mn-river-note-btn" data-river="${escAttr(name)}"` +
            ` onclick="MapRivers.openCallout(this.dataset.river)">${esc(name)}</button>`).join('') +
          (more > 0 ? ` <span class="muted">+${more} more — zoom in or narrow the filter</span>` : '') +
          '</span>';
      }
      default:        return 'Type a name in the filter box to light up matching rivers.';
    }
  }

  function cacheKey(terms, b) {
    return terms.join('+') + '|' + [b.s, b.w, b.n, b.e].map(v => v.toFixed(2)).join(',');
  }

  function run() {
    if (!map) return;
    const terms = riverTerms();
    if (!terms.length) { clearLayer(); setNote(state.mapRivers ? 'idle' : 'off'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('wide'); return; }

    const key = cacheKey(terms, b);
    const hit = cacheGet(key);
    if (hit) {
      // A pan inside the same rounded bbox is not a redraw (#150 A2): the
      // geometry on screen is already this entry, so only the labels move —
      // re-anchored in place onto whatever runs are in view now.
      if (key === drawnKey && layer) { setNote('ok', hit, applyLabels()); return; }
      draw(hit, key);
      setNote('ok', hit, applyLabels());
      return;
    }
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
      draw(entry, key);
      setNote('ok', entry, applyLabels());
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
      // The delegated interaction (#150) — see the header for why the paths
      // themselves cannot take these. Layer points survive a pan and change
      // on zoom, so zoomend is the one reprojection trigger.
      m.on('click', onMapClick);
      m.on('mousemove', onMapMove);
      m.on('zoomend', reproject);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      if (map) {
        map.off('moveend', sync);
        map.off('click', onMapClick);
        map.off('mousemove', onMapMove);
        map.off('zoomend', reproject);
      }
      clearLayer();
      map = null;
      seq++;                            // a request in flight has nothing to draw on
    },

    // The filter box changed, or the switch did.
    sync,

    // Theme switch. The colour is read at draw time, so this re-draws what is
    // already there — off the cache, with no request. drawnKey is dropped
    // first: run()'s pan-is-not-a-redraw shortcut would otherwise skip the
    // rebuild that re-reads the colour.
    repaint() { if (layer) { drawnKey = null; run(); } },

    // Are there rivers on the map right now? The legend asks before claiming a
    // river line, the way it does for the ACMA colours.
    active() { return !!layer; },

    // Open the callout for a drawn river by name — the note's buttons call
    // this (#150 A4), so a keyboard or a finger reaches exactly what a mouse
    // click on the line reaches.
    openCallout(name) {
      openCalloutAt(rivers.find(r => r.named && r.name === name) || null);
    },

    // Hand geometry straight to the cache under the key run() is about to
    // compute, and run. The harness needs this because Overpass is external
    // and the test network blocks it (#150's testing note): a check that can
    // never fetch has to seed, and seeding through the cache means the test
    // exercises run()'s real cache-hit path — grouping, passes, labels, note.
    // Returns false when there is no map or no usable filter term.
    seed(ways) {
      if (!map) return false;
      const terms = riverTerms();
      if (!terms.length) return false;
      const b = roundedBbox(map.getBounds());
      cachePut(cacheKey(terms, b), { ways, capped: false, total: ways.length });
      run();
      return true;
    },

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

