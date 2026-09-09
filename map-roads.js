// MegaNet — map-roads.js
//
//   MapRoads   road parcels — the surveyed road reserve itself, not a road
//              centreline — from the Queensland digital cadastre, drawn under
//              the station pins so an operator can see whether a site sits in
//              a road reserve and which road it is (#176).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and `esc`; across to app.js for
// rerenderMapLegend. Both only from inside MapRoads' own functions, so this
// file's position among the modules is free, the same way #120 left it for
// MapSurvey.
//
// ── Why the parcel and not the road ──────────────────────────────────────────
// Every basemap in the picker already draws roads. What none of them draws is
// the *parcel*: the strip of land the road is dedicated over, with its own
// boundary, its own local authority and — usually — its own name. That is the
// layer the questions actually land on. Is this mast standing in the road
// reserve or on the neighbour's freehold? Whose road is the access track? Can
// the trailer get to the site without crossing private land? A centreline
// answers none of them; a parcel boundary answers all three at a glance.
//
// The source is the DCDB's own "Cadastral parcels" layer, filtered to the two
// `parcel_typ` values that make up a road reserve (see below) — the same rows
// QSpatial's SmartMap draws as road, updated nightly. Vector rather than a server-rendered image (which
// is what MapContours settled on): road parcels are sparse compared with
// contour lines, a viewport's worth is tens of kilobytes, and the whole point
// is to be able to point at one and be told its name.
//
// ── Pointer conventions ─────────────────────────────────────────────────────
// Nothing in this pane takes the pointer, for the reason map-rivers.js records
// as a discovered fact and map-survey.js repeats: the Stations map runs one
// shared canvas for its pins and links, that canvas is in the overlay pane
// ABOVE this one, and a handler bound to a path down here is bound to nothing.
// So the hover name is delegated — the map's own mousemove is hit-tested
// against the drawn rings.
//
// Clicks are deliberately NOT taken. A road parcel is an enormous target; a
// layer that opened a callout every time somebody clicked inside one would
// swallow the "click the empty map to clear the focus" gesture that the pins,
// the ACMA card and the repeater focus all depend on. The hover label carries
// what a callout would have said.
//
// ── Intersections are road reserve too ──────────────────────────────────────
// This layer first shipped drawing `parcel_typ = 'Road Type Parcel'` and
// nothing else, and every junction on it came out as a hole: four road strips
// closing off short of each other around an unpainted square, which reads as
// "the road reserve stops here" — the one thing about a road reserve that is
// never true at an intersection.
//
// The DCDB does not put the crossing square in either road. It files it under a
// third value in the same column, spelled — truncated at 24 characters, in the
// published field — `'Unlinked parcel or inter'`, for *unlinked parcel or
// intersection*. Those rows carry no lot, no plan, no tenure and no name; they
// are the corner of the cadastre where the road network joins itself.
//
// So the query asks for both, and the two are told apart on the way in. What
// stops the second value from over-claiming is that the name covers two things,
// and only one of them is road: a genuinely unlinked remnant is not a junction
// and must not be painted as one. The test is the cadastre's own topology — an
// intersection shares its corners with the roads that meet at it, vertex for
// vertex, and `geometryPrecision=6` means a shared vertex arrives bit-identical
// in both features. A parcel of this type that shares no vertex with any road
// parcel in the same answer is dropped.
//
// Measured over eight areas before it was written — suburban Toowoomba, the
// Toowoomba and Brisbane CBDs, rural Cambooya, Cairns, Mount Isa, Winton and
// the Gold Coast hinterland, 1,269 of these parcels between them — every single
// one touched a road parcel. So the test is a floor rather than a filter: it
// has never yet refused anything, and it is here so that the layer cannot start
// claiming ground the cadastre does not say is road.
//
// The join is worth more than the fill it earns, because the roads sharing an
// intersection's corners are the roads that meet there. Hovering a junction
// names them — "Chardonnay Street / Miranda Drive intersection" — which is an
// answer the road strips on either side could not give.
const MapRoads = (function () {
  // The Land Parcel Property Framework — the DCDB published as a map service,
  // the same platform the survey marks and contours come from.
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer';
  // Resolved by name at runtime below; this is the id the live service
  // currently publishes it under, kept only as the fallback when the probe
  // cannot reach the service description — never guessed at from nothing.
  const FALLBACK_ID = 4;
  const LAYER_RE    = /cadastral\s+parcels/i;
  // What makes a parcel part of the road reserve. The field is `parcel_typ` and
  // both values are spelled exactly like this in the DCDB — including the
  // second one's truncation, which is the published spelling and not a typo
  // here. Anything else in that column is a lot, an easement or a watercourse.
  const ROAD_TYPE   = 'Road Type Parcel';
  const NODE_TYPE   = 'Unlinked parcel or inter';   // see the header
  const WHERE       = `parcel_typ IN ('${ROAD_TYPE}','${NODE_TYPE}')`;
  const ATTRIBUTION = '© State of Queensland (Department of Natural Resources and Mines, '
                    + 'Manufacturing and Regional and Rural Development)';

  // Between the contour image (335) and the river pane (340) in the shared
  // z budget map-survey.js documents: cadastre draws over terrain lines,
  // under the watercourses, well under anything that has to win a click.
  const PANE   = 'mnRoads';
  const PANE_Z = 338;

  // Below this a road parcel is a hairline in a mesh of hairlines, and the
  // query is a request for a whole shire's cadastre. One zoom tighter than
  // MapSurvey's 12, because parcels are denser than survey marks.
  const MIN_ZOOM     = 13;
  const DEBOUNCE_MS  = 250;
  const TIMEOUT_MS   = 20000;
  const BBOX_STEP    = 0.02;   // deg (~2 km) — a small pan re-uses the answer it has
  const BBOX_MAX     = 0.5;    // deg — a backstop behind MIN_ZOOM
  // Drawn per view; the service's own ceiling is 4,000. Raised with the
  // intersections: across the eight sample areas they run at about 55% of the
  // road-parcel count, so the old 1,500 would have started capping views that
  // used to draw whole.
  const MAX_PARCELS  = 2400;
  const CACHE_MAX    = 20;
  const FAIL_TTL     = 60000;
  // Vertex generalisation asked of the service, in degrees (~10 m). A road
  // reserve is a long thin rectangle with a few kinks; drawing it to the
  // centimetre costs an order of magnitude more geometry and looks identical.
  const OFFSET_DEG   = 0.0001;

  // Literal hexes rather than tokens, for the reason map-wind.js records:
  // Leaflet path options cannot take var(). Yellow because that is what a road
  // is on every printed map anybody has ever navigated from — the layer names
  // itself before the legend does.
  //
  // A deep golden yellow rather than a pure one, and that is a legibility
  // decision rather than a taste one: yellow is the highest-luminance hue on
  // the wheel, so a pure #ffd600 hairline over the light topo base is most of
  // the way to invisible, while the same line over satellite imagery is fine. This sits dark enough to hold on white and bright enough to stay
  // yellow on imagery.
  //
  // Two neighbours it has to be told apart from, and how it is:
  //   · the pass-range links, amber #ff6f00 — a *line* with a white casing,
  //     where a road parcel is a closed ring with a fill, so the shape carries
  //     the difference the ~15° of hue between them would not.
  //   · wind region B1, #fdd835, which covers south-east Queensland — a 20%
  //     fill under everything, against a 95% stroke over it. That one is on by
  //     default, so it tints the ground under this layer for most of the
  //     network; both were rendered together before this colour was settled.
  const LINE_COLOR = '#f9a825';
  const UNNAMED    = 'Unnamed road reserve';
  const UNNAMED_X  = 'Road intersection';

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  let layerId = null, resolving = null;   // sublayer resolution — see resolveLayer()
  let drawnKey = null;                    // which cache entry is on the map
  let drawn = [];                         // what draw() put there — the hit test reads these
  let hoverTip = null, moveRaf = null;
  const cache = new Map();                // 's,w,n,e' → { parcels, capped, total }
  // Null until the first run(), for MapSurvey's reason: the panel can render
  // before attach() has run, and the note has to be able to say what the layer
  // is about to do rather than what it did last time.
  let note = null;

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
      if (json && json.error) throw new Error(json.error.message || 'ArcGIS error');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // Probe the sublayer id by name, once per page load — MapContours' pattern.
  // A failed probe falls back to the id the service currently publishes rather
  // than to nothing, so a service description that is briefly unreachable does
  // not take the layer down with it.
  function resolveLayer() {
    if (layerId != null) return Promise.resolve(layerId);
    if (resolving) return resolving;
    resolving = askJson(SERVICE_URL + '?f=json')
      .then(json => {
        const hit = ((json && json.layers) || [])
          .find(l => LAYER_RE.test(String(l.name || '')) && !/deprecated/i.test(String(l.name || '')));
        layerId = hit ? hit.id : FALLBACK_ID;
        return layerId;
      })
      .catch(() => { layerId = FALLBACK_ID; return layerId; });
    return resolving;
  }

  function queryUrl(id, b) {
    const params = new URLSearchParams({
      where: WHERE,
      geometry: `${b.w},${b.s},${b.e},${b.n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'feat_name,locality,shire_name,lotplan,parcel_typ',
      returnGeometry: 'true',
      geometryPrecision: '6',
      maxAllowableOffset: String(OFFSET_DEG),
      resultRecordCount: String(MAX_PARCELS + 1),   // one over, so "more" is knowable
      f: 'geojson',
    });
    return `${SERVICE_URL}/${id}/query?${params}`;
  }

  // GeoJSON features to the shape draw() and the hit test both want: the rings
  // in [lat, lon] order Leaflet takes, a bounding box so a mousemove can reject
  // most parcels without walking their vertices, and the three strings the
  // hover label is built from. Plus, for joinNodes(), which parcel_typ this row
  // came back under and the vertices it can be joined on.
  //
  // The vertex key is the coordinate pair as the service printed it. Nothing is
  // re-rounded here: `geometryPrecision=6` already fixed both features' shared
  // corner at six decimal places, and rounding again on the way in would only
  // move a matched pair apart.
  function vertKey(lat, lon) { return lat + ',' + lon; }

  function parcelsFrom(json) {
    const out = [];
    for (const f of (json && json.features) || []) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
                  : g.type === 'MultiPolygon' ? g.coordinates : [];
      const rings = [], verts = [];
      let s = 90, n = -90, w = 180, e = -180;
      for (const poly of polys) {
        for (const ring of poly) {
          const pts = [];
          for (const [lon, lat] of ring) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            pts.push([lat, lon]);
            verts.push(vertKey(lat, lon));
            if (lat < s) s = lat; if (lat > n) n = lat;
            if (lon < w) w = lon; if (lon > e) e = lon;
          }
          if (pts.length >= 3) rings.push(pts);
        }
      }
      if (!rings.length) continue;
      const p = f.properties || {};
      out.push({
        rings, box: { s, w, n, e }, verts,
        isNode:   String(p.parcel_typ || '').trim() === NODE_TYPE,
        joins:    [],
        name:    String(p.feat_name || '').trim(),
        locality: String(p.locality || '').trim(),
        shire:    String(p.shire_name || '').trim(),
        lotplan:  String(p.lotplan || '').trim(),
      });
    }
    return out;
  }

  // Attach every intersection to the roads that meet at it, and drop the ones
  // that meet none — the whole of the guard the header describes.
  //
  // One pass over the road parcels' vertices builds the index; one pass over
  // the intersections reads it. Both are linear in the vertices already in
  // hand, which for a viewport is a few tens of thousands of string keys and is
  // gone again by the time this returns: `verts` is dropped from every parcel
  // on the way out, because the cache holds twenty of these answers and the hit
  // test never needs them.
  function joinNodes(parcels) {
    const meeting = new Map();          // vertex key → Set of road names there
    for (const p of parcels) {
      if (p.isNode) continue;
      for (const k of p.verts) {
        let names = meeting.get(k);
        if (!names) meeting.set(k, names = new Set());
        // An unnamed road is still a road: it joins, it just cannot say what it
        // is called, so it goes in as the empty string and is filtered out of
        // the label rather than out of the test.
        names.add(p.name);
      }
    }
    const out = [];
    for (const p of parcels) {
      if (!p.isNode) { delete p.verts; out.push(p); continue; }
      const names = new Set();
      let joined = false;
      for (const k of p.verts) {
        const at = meeting.get(k);
        if (!at) continue;
        joined = true;
        for (const nm of at) if (nm) names.add(nm);
      }
      delete p.verts;
      if (!joined) continue;            // an unlinked remnant, not a junction
      p.joins = [...names].sort();
      out.push(p);
    }
    return out;
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

  function clearHover() {
    if (hoverTip) { hoverTip.remove(); hoverTip = null; }
  }

  // Attribution rides on the layer, not on the switch — "claim it while you
  // are actually drawing it", the reading MapSurvey's clearLayer() records.
  function clearLayer() {
    clearHover();
    drawnKey = null;
    drawn = [];
    if (!layer) return;
    layer.remove();
    layer = null;
    if (map && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  function draw(parcels, key) {
    if (!map) return;
    const had = !!layer;
    if (layer) layer.remove();
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    for (const p of parcels) {
      L.polygon(p.rings, {
        pane: PANE,
        interactive: false,          // see the pointer note in the header
        // Heavier and more opaque than a mid-toned line would need to be, for
        // the reason LINE_COLOR records: a light hue on a light base reads
        // fainter at the same numbers, so the numbers move to keep the
        // apparent presence the same.
        color: LINE_COLOR,
        weight: 1.2,
        opacity: 0.95,
        fillColor: LINE_COLOR,
        fillOpacity: 0.14,
      }).addTo(layer);
    }
    drawn = parcels;
    drawnKey = key;
    if (!had && map.attributionControl) map.attributionControl.addAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  // ── Delegated hover ──────────────────────────────────────────────────────
  // Ray-cast point-in-polygon, even-odd across a parcel's rings so a hole
  // counts itself out — map-wind.js's inRing, on much smaller polygons. The
  // bounding-box test in front of it is what keeps a mousemove cheap: at a
  // typical view most of the parcels are rejected on four comparisons.

  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function parcelAt(lat, lon) {
    for (const p of drawn) {
      const b = p.box;
      if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      let hits = 0;
      for (const ring of p.rings) if (inRing(lat, lon, ring)) hits++;
      if (hits % 2 === 1) return p;
    }
    return null;
  }

  // What the floating label says. The road's name is the answer to the
  // question; the locality and the local authority are what turn it into an
  // address, and they are the difference between "Gap Creek Road" and "which
  // Gap Creek Road".
  //
  // An intersection carries no name of its own in the cadastre, so it borrows
  // the names of the roads joined to its corners — which is the name a person
  // would give it anyway.
  function parcelLabel(p) {
    const where = [p.locality, p.shire].filter(Boolean).join(' · ');
    const what = p.isNode
      ? (p.joins.length ? `${p.joins.join(' / ')} intersection` : UNNAMED_X)
      : (p.name || UNNAMED);
    return what + (where ? ` — ${where}` : '');
  }

  function onMapMove(e) {
    if (!layer || moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!map || !layer) return;
      // An armed draw tool or link-budget pick owns the pointer; the same
      // precedence every other overlay on this map gives them.
      const p = state.draw.tool || (state.link && state.link.picking)
        ? null : parcelAt(e.latlng.lat, e.latlng.lng);
      if (!p) { clearHover(); return; }
      // Sticky to the cursor, like the river label: a road reserve has no
      // sensible single anchor point, and one drawn at its centroid would sit
      // a kilometre from the pointer.
      if (!hoverTip) {
        hoverTip = L.tooltip({ className: 'mn-road-label', direction: 'top',
                               offset: [0, -6], interactive: false })
          .setContent(esc(parcelLabel(p))).setLatLng(e.latlng).addTo(map);
      } else {
        hoverTip.setLatLng(e.latlng).setContent(esc(parcelLabel(p)));
      }
    });
  }

  // Only what the viewport actually shows counts as "in view" — the fetch's
  // bbox is rounded outward past the screen edges, and counting everything
  // fetched would let the note claim parcels that are off screen. MapSurvey's
  // inViewCount, on boxes instead of points.
  // Counted apart rather than added together, because they answer different
  // questions: the roads are what the layer is for, and the intersections are
  // the thing that used to be missing from it — a note that folded them into
  // one figure could not say the junctions were being drawn at all.
  function inViewCount(parcels) {
    const out = { roads: 0, nodes: 0 };
    if (!map) return out;
    const b = map.getBounds();
    const s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
    for (const p of parcels) {
      const x = p.box;
      if (x.n < s || x.s > n || x.e < w || x.w > e) continue;
      if (p.isNode) out.nodes++; else out.roads++;
    }
    return out;
  }

  function setNote(kind, entry) {
    const c = entry ? inViewCount(entry.parcels) : { roads: 0, nodes: 0 };
    note = {
      kind,
      roads:  c.roads,
      nodes:  c.nodes,
      capped: !!(entry && entry.capped),
    };
    const el = document.getElementById('map-roads-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    const n = note || { kind: state.mapRoads ? 'zoom' : 'off' };
    switch (n.kind) {
      case 'off':     return 'Road parcels are hidden.';
      case 'zoom':    return 'Zoom in to draw road parcels — this view is too wide to ask the cadastre for.';
      case 'loading': return 'Looking up road parcels…';
      case 'fail':    return 'Road parcels unavailable — the Queensland spatial data service could not be reached.';
      case 'ok': {
        const roads = n.roads || 0, nodes = n.nodes || 0;
        if (!roads && !nodes) return 'No road parcels in view. Queensland only — the cadastre this reads stops at the border.';
        return `<strong>${roads}</strong> road parcel${roads === 1 ? '' : 's'}` +
               (nodes ? ` and <strong>${nodes}</strong> intersection${nodes === 1 ? '' : 's'}` : '') +
               ' in view' +
               (n.capped ? ' · more in view not drawn' : '') +
               '. Hover one for its name, locality and local authority.';
      }
      default:        return '';
    }
  }

  function run() {
    if (!state.mapRoads) { clearLayer(); setNote('off'); return; }
    if (!map) return;
    if (map.getZoom() < MIN_ZOOM) { clearLayer(); setNote('zoom'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('zoom'); return; }

    const key = [b.s, b.w, b.n, b.e].map(v => v.toFixed(3)).join(',');
    const hit = cacheGet(key);
    if (hit) {
      // A pan inside the same rounded bbox is not a redraw — MapRivers' A2
      // shortcut, which MapSurvey copies. Only the in-view count moves.
      if (key !== drawnKey || !layer) draw(hit.parcels, key);
      setNote('ok', hit);
      return;
    }
    if (Date.now() - failedAt < FAIL_TTL) { clearLayer(); setNote('fail'); return; }

    const mine = ++seq;
    setNote('loading');
    resolveLayer().then(id => {
      if (mine !== seq || !map) return null;
      return askJson(queryUrl(id, b));
    }).then(json => {
      if (mine !== seq || !map || !json) return;
      const all = joinNodes(parcelsFrom(json));
      const capped = all.length > MAX_PARCELS;
      const entry = { parcels: capped ? all.slice(0, MAX_PARCELS) : all, capped, total: all.length };
      cachePut(key, entry);
      draw(entry.parcels, key);
      setNote('ok', entry);
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
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        // Belt and braces behind `interactive: false` on every polygon, and
        // the same line map-wind.js's pane carries: a parcel the size of a
        // highway must never take a pointer event a pin was drawn to answer.
        pane.style.pointerEvents = 'none';
      }
      m.on('moveend', sync);
      m.on('mousemove', onMapMove);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      if (map) {
        map.off('moveend', sync);
        map.off('mousemove', onMapMove);
      }
      clearLayer();
      map = null;
      seq++;
    },

    sync,

    // Does the legend claim a road-parcel key right now? The same gate
    // MapRivers, MapSurvey and MapContours all use for their own entries.
    active() { return !!layer; },

    // The legend's swatch colour, so the key and the map cannot drift apart.
    legendColour() { return LINE_COLOR; },

    noteHtml,

    // On by default and remembered, on MapSurvey's terms rather than
    // MapContours'. The rule that reads "a layer that costs a request per view
    // stays off until it is asked for" is about page load, and MIN_ZOOM
    // already answers that half: the Stations map opens fitted to every
    // station in the network, an extent an order of magnitude wider than zoom
    // 13, so the layer's opening state is "zoom in to draw them" and not one
    // request is made until somebody actually goes to a site. Which is the
    // moment the answer is wanted — whose road reserve is this — and having to
    // find a checkbox first is the thing that stops it being asked.
    //
    // An operator who turns it off means it, so like the rivers, the survey
    // marks and the wind regions the answer is kept between visits.
    setEnabled(on) {
      state.mapRoads = on;
      try { localStorage.setItem('mn-roads', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearTimeout(timer); clearLayer(); setNote('off'); return; }
      setNote(map && map.getZoom() >= MIN_ZOOM ? 'loading' : 'zoom');
      sync();
    },
  };
})();
if (typeof window !== 'undefined') window.MapRoads = MapRoads;
