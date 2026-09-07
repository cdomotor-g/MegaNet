// MegaNet — map-catchments.js
//
//   MapCatchments   The 77 Queensland drainage basins, drawn under the station
//                   pins and lit up by whatever is typed into the Stations
//                   filter box — so "fitzroy" finds the basin as well as the
//                   stations in it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and `esc`/`escAttr`, and across to app.js
// for prepareSearchStack and rerenderMapLegend. Every one of those is called
// from inside a MapCatchments function, so this file's position among the
// modules is free, the same way #120 left it for MapSurvey.
//
// ── Why this file exists, and why it is not the basin SVG ────────────────────
// The app has had basin geometry since the beginning: `assets/geo/
// QldBasin_2009Nov_reduced.svg`, drawn in whatever projection the 2009 export
// used and pinned to the world by the least-squares affine fit in
// `BASIN_GEOREF` (maps-data.js). That fit is good to a mean of about 34 km,
// which is why the README calls it good enough to *suggest* a catchment for the
// Radio Path Maps search and too coarse to store, and why #84 says drawing it
// over a topographic basemap puts the boundary 100–150 km from the river —
// consistently west and south, and no affine fixes it, because the source is a
// projected map and not a set of coordinates.
//
// `data/qld-basins.geojson` is the same 2009 basin set from the Bureau's own
// KMZ, in WGS84, where each vertex is a real place. Nothing is projected, fitted
// or guessed. That is the whole difference, and it is the difference between a
// layer that can be drawn over tiles and one that cannot. `tools/
// build_geo_layers.py` builds it; the source KMZ is not in the repo (13 MB of
// somebody else's export) and the tool takes --kmz-dir when a newer one turns
// up.
//
// The SVG stays exactly where it is. The Radio Path Maps tab reads it through
// BASIN_GEOREF to rank map suggestions, that ranking is tolerant of 34 km, and
// swapping it is #84's job, not this file's.
//
// ── Search, and why the layer is drawn even when nothing matches ─────────────
// MapRivers draws nothing at all until a term matches: a river is fetched from
// Overpass per query, so "no term" and "no request" are the same state. Basins
// are 760 KB sitting in the repo, already parsed, and there are 77 of them —
// the whole set is one draw. So the switch and the filter box do different jobs
// here: the switch says whether basins are on the map, and the filter box says
// which of them to *emphasise*. Turn it on and the network's basins are outlined
// faintly; type "fitzroy" and the Fitzroy fills, takes a label, and gets a
// button in the note. That is the rivers behaviour with the part that only
// existed to save a request taken out.
//
// ── Pointer conventions (#150) ───────────────────────────────────────────────
// Nothing in this pane takes the pointer, and that is inherited, not chosen:
// the Stations map runs one shared canvas for ~3,100 pins and the links, it
// lives in the overlay pane above this one, and a DOM event that hits none of
// its layers bubbles UP to the map rather than sideways into a sibling SVG. A
// polygon the size of the Burdekin must never take a click a pin was drawn to
// answer, so the pane is pointer-events:none like MapWind's, and the keyboard
// and touch path to a basin is the row of real <button>s in the note.
const MapCatchments = (function () {
  const DATA_URL = 'data/qld-basins.geojson';
  const ATTRIBUTION = 'Drainage basins © Commonwealth of Australia (Bureau of Meteorology)';

  // Its own pane in the shared z budget map-survey.js documents: wind regions
  // sit at 330 "because the broadest context on the map goes lowest", and a
  // drainage basin is the same kind of fact about the same amount of country.
  // Below wind, above nothing — hubs (320) are the only thing under this,
  // because an administrative boundary is context for the physical one rather
  // than the other way round.
  const PANE   = 'mnCatchments';
  const PANE_Z = 325;

  const MIN_TERM  = 3;    // "mar" already matches Mary, Maroochy and Murray;
                          // and a basin number is three digits, "011" to "928"
  const LABEL_CAP = 14;   // labels drawn for matched basins — more is a word search
  const NOTE_BTN_CAP = 20;

  // Colour by drainage division rather than by basin: 77 distinguishable fills
  // is not a thing, and the division is the fact a person reads off a basin map
  // anyway — which way the water goes. Five of them cover Queensland.
  //
  // Literal hexes rather than tokens, for MapWind's reason: Leaflet path
  // options cannot take var(), and at these opacities over map tiles neither
  // theme needs its own set.
  const DIVISION_COLOR = {
    'North East Coast': '#2f8fd0',   // to the Coral Sea
    'Gulf':             '#37a89a',   // to the Gulf of Carpentaria
    'Murray Darling':   '#c2833a',   // south-west, to the Murray
    'Lake Eyre':        '#b5603f',   // inland, to the lake
    'Bulloo':           '#8a6bb0',   // inland, to nowhere — its own division
  };
  const DEFAULT_COLOR = '#7a8899';

  let map = null;
  // The map is built with preferCanvas and a shared canvas renderer (app.js
  // initMap), so a path added without one of its own lands in that canvas and
  // not in this pane — invisible to the pane's pointer-events:none, and not a
  // DOM node any of this can label or a test can see. MapRivers hit the same
  // thing and answered it the same way: an SVG renderer bound to this pane.
  // 77 basins and 8 hubs is not the 3,100 pins the canvas exists for.
  let renderer = null;
  let layer = null;         // the faint all-basins outline
  let hot = null;           // the emphasised, matched basins
  let labels = null;
  let data = null;
  let loading = null;
  let failed = false;
  let note = { kind: 'init', matched: [] };
  let seq = 0;

  // ── Data ──────────────────────────────────────────────────────────────────
  // Fetched once, when the Stations map first opens with the switch on or a
  // station card first asks — never at page load. 760 KB of Queensland is not
  // part of opening the app.
  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(j => { data = j; failed = false; return j; })
      .catch(e => { failed = true; loading = null; throw e; });
    return loading;
  }

  function basins() { return (data && data.features) || []; }

  function colorFor(f) {
    return DIVISION_COLOR[f.properties.division] || DEFAULT_COLOR;
  }

  // ── Which basins the filter box is pointing at ────────────────────────────
  // `prepareSearchStack` has already split and lower-cased the terms. A term
  // with no letter in it is an ALERT address or a station number and the app
  // already treats it that way, so it is not a basin name either. Only entries
  // pointed at the station *name* are read, for MapRivers' reason: an entry the
  // operator has said is a list of station numbers has no business naming a
  // catchment.
  function terms() {
    if (!state.mapCatchments) return [];
    const out = new Set();
    try {
      for (const e of prepareSearchStack()) {
        if (!e.active || !e.fields.name) continue;
        for (const t of e.prep.terms) {
          // MapRivers takes name-ish terms only, because a bare number in that
          // box is an ALERT address and not a river. A basin is different: the
          // Bureau's own schedules are headed "130 Fitzroy", and the number is
          // how half the network refers to a catchment. So digits are kept, and
          // the safety is in the match rather than the filter — a number has to
          // equal a basin number exactly, so the worst an ALERT address that
          // happens to collide can do is outline one basin. This layer is
          // context; it has no say in what the filter selects.
          if (t.length >= MIN_TERM && (/[a-z]/.test(t) || /^\d+$/.test(t))) out.add(t);
        }
      }
    } catch (_) { /* the stack is app.js's; a tab without it just has no terms */ }
    return [...out];
  }

  // A basin matches on its name or on its basin number — "130" and "fitzroy"
  // are the same question asked two ways. The number is matched whole and
  // numerically: "13" is not basin 130, and "011" and "11" are both the Bulloo,
  // because the Bureau writes basin numbers zero-padded to three and nobody
  // else does.
  function matches(f, ts) {
    const name = (f.properties.name || '').toLowerCase();
    const no   = String(f.properties.basin_no || '');
    const num  = no === '' ? null : Number(no);
    return ts.some(t =>
      (/^\d+$/.test(t) ? (num !== null && num === Number(t)) : false) || name.includes(t));
  }

  function matched() {
    const ts = terms();
    if (!ts.length) return [];
    return basins().filter(f => matches(f, ts));
  }

  // ── Geometry helpers ──────────────────────────────────────────────────────
  function ringsOf(geom) {
    if (!geom) return [];
    return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  }

  // Shoelace centroid of the largest ring. A basin is a blob, so this lands
  // inside it; the pathological cases (a C-shaped catchment whose centroid is
  // in the sea) are not in this dataset, and a label a few km off is a label in
  // the right basin.
  function labelPoint(f) {
    let best = null, bestArea = -1;
    for (const rings of ringsOf(f.geometry)) {
      const r = rings[0];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, n = r.length - 1; i < n; i++) {
        const [x0, y0] = r[i], [x1, y1] = r[i + 1];
        const cross = x0 * y1 - x1 * y0;
        a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
      }
      a /= 2;
      const area = Math.abs(a);
      if (area > bestArea && a !== 0) {
        bestArea = area;
        best = [cy / (6 * a), cx / (6 * a)];   // [lat, lon]
      }
    }
    return best;
  }

  function boundsOf(f) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const rings of ringsOf(f.geometry)) {
      for (const [lon, lat] of rings[0]) {
        if (lat < s) s = lat; if (lat > n) n = lat;
        if (lon < w) w = lon; if (lon > e) e = lon;
      }
    }
    return L.latLngBounds([s, w], [n, e]);
  }

  // ── Point in basin ────────────────────────────────────────────────────────
  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // The basin a point is in, or null. Holes are subtractive; the dataset has
  // none today, and a reader that ignored them would be wrong the day it does.
  function catchmentAt(lat, lon) {
    for (const f of basins()) {
      for (const rings of ringsOf(f.geometry)) {
        if (!inRing(lat, lon, rings[0])) continue;
        let holed = false;
        for (let i = 1; i < rings.length; i++) {
          if (inRing(lat, lon, rings[i])) { holed = true; break; }
        }
        if (!holed) {
          const p = f.properties;
          return { id: p.id, name: p.name, basin_no: p.basin_no,
                   division: p.division, area_sqkm: p.area_sqkm, border: p.border || null };
        }
      }
    }
    return null;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function clearLayer() {
    for (const l of [layer, hot, labels]) if (l && map) map.removeLayer(l);
    layer = hot = labels = null;
  }

  function render() {
    if (!map || !state.mapCatchments || !data) return;
    clearLayer();

    const hits = matched();
    const hotIds = new Set(hits.map(f => f.properties.id));

    // Every basin, faintly. This is the "there are basins, and here they are"
    // pass; it is deliberately quiet enough to read a basemap through.
    layer = L.geoJSON(data, {
      pane: PANE,
      renderer,
      interactive: false,
      attribution: ATTRIBUTION,
      style: f => {
        const c = colorFor(f);
        return hotIds.has(f.properties.id)
          ? { color: c, weight: 0, opacity: 0, fillOpacity: 0 }   // the hot pass draws it
          : { color: c, weight: 1, opacity: 0.45, fillColor: c, fillOpacity: 0.06 };
      },
    }).addTo(map);

    // The matched ones, loudly, on top.
    if (hits.length) {
      hot = L.geoJSON({ type: 'FeatureCollection', features: hits }, {
        pane: PANE,
        renderer,
        interactive: false,
        style: f => {
          const c = colorFor(f);
          return { color: c, weight: 2.5, opacity: 0.95, fillColor: c, fillOpacity: 0.22 };
        },
      }).addTo(map);

      labels = L.layerGroup([], { pane: PANE }).addTo(map);
      for (const f of hits.slice(0, LABEL_CAP)) {
        const at = labelPoint(f);
        if (!at) continue;
        L.marker(at, {
          pane: PANE,
          interactive: false,
          icon: L.divIcon({
            className: 'mn-catchment-label',
            html: `<span>${esc(f.properties.name)}</span>`,
            iconSize: null,
          }),
        }).addTo(labels);
      }
    }

    setNote(hits);
  }

  function run() {
    if (!map || !state.mapCatchments) return;
    const mine = ++seq;
    setNote(null, 'loading');
    ensureData().then(() => {
      if (mine !== seq || !map || !state.mapCatchments) return;
      render();
      rerenderMapLegend();
    }).catch(() => {
      if (mine !== seq || !map) return;
      clearLayer();
      setNote(null, 'fail');
      rerenderMapLegend();
    });
  }

  // ── The note under the switch ─────────────────────────────────────────────
  function setNote(hits, kind) {
    note = {
      kind: kind || (state.mapCatchments ? 'on' : 'off'),
      total: basins().length,
      matched: (hits || []).map(f => ({ id: f.properties.id, name: f.properties.name,
                                        no: f.properties.basin_no })),
    };
    const el = document.getElementById('map-catchment-note');
    if (el) el.innerHTML = noteHtml();
  }

  const PROVENANCE = 'Bureau of Meteorology drainage basins (QldBasin, Nov 2009), in WGS84 — '
                   + 'not the affine-fitted basin SVG the Radio Path Maps search uses (#84).';

  function noteHtml() {
    // The panel is built before attach() runs, so the first call happens with
    // nothing having set a state yet. That is not a third state — it is
    // whatever the switch says, and the switch is in `state`.
    const kind = note.kind === 'init'
      ? (typeof state !== 'undefined' && state.mapCatchments ? 'on' : 'off')
      : note.kind;
    switch (kind) {
      case 'off':     return 'River catchments are hidden.';
      case 'loading': return 'Loading catchments…';
      case 'fail':    return 'Catchments unavailable — data/qld-basins.geojson could not be read. '
                           + 'Untick and re-tick to try again.';
      case 'on': {
        const n = note.matched.length;
        if (!n) {
          return `<strong>${note.total}</strong> Queensland drainage basins outlined. `
               + 'Type a basin name or number in the filter box to light one up. ' + PROVENANCE;
        }
        const listed = note.matched.slice(0, NOTE_BTN_CAP);
        const more   = n - listed.length;
        return `<strong>${n}</strong> basin${n === 1 ? '' : 's'} match the filter`
          + (n > LABEL_CAP ? ` · naming the first ${LABEL_CAP}` : '') + '.'
          + '<span class="mn-river-note-btns">'
          + listed.map(m =>
              `<button type="button" class="mn-river-note-btn" data-catchment="${escAttr(m.id)}"`
              + ` onclick="MapCatchments.zoomTo(this.dataset.catchment)"`
              + ` title="Zoom the map to basin ${escAttr(m.no)}">${esc(m.name)}`
              + ` <span class="muted">${esc(m.no)}</span></button>`).join('')
          + (more > 0 ? ` <span class="muted">+${more} more — narrow the filter</span>` : '')
          + '</span>';
      }
      default: return 'The Queensland drainage basins, drawn under the pins. ' + PROVENANCE;
    }
  }

  return {
    // The legend's key: one row per drainage division, with the colour drawn on
    // the map and how many basins are in it. The legend renders these; nothing
    // about how they are drawn lives there.
    divisions() {
      const count = {};
      for (const f of basins()) {
        const d = f.properties.division || '—';
        count[d] = (count[d] || 0) + 1;
      }
      return Object.keys(DIVISION_COLOR)
        .filter(d => count[d])
        .map(d => ({ division: d, color: DIVISION_COLOR[d], basins: count[d] }));
    },

    provenance() { return PROVENANCE; },

    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
      }
      renderer = L.svg({ pane: PANE });
      if (state.mapCatchments) run();
    },

    detach() {
      clearLayer();
      renderer = null;
      map = null;
      seq++;
    },

    // Does the map display note claim the key right now?
    active() { return !!layer; },

    noteHtml,
    catchmentAt,

    // A filter change re-emphasises without re-fetching — the data is already
    // here, so unlike MapRivers.sync() this costs a redraw and nothing else.
    sync() {
      if (!map || !state.mapCatchments) return;
      if (!data) { run(); return; }
      render();
      rerenderMapLegend();
    },

    // The note's buttons. The keyboard and touch path to a basin, since the
    // pane cannot take a pointer — see the header.
    zoomTo(id) {
      const f = basins().find(b => b.properties.id === id);
      if (f && map) map.fitBounds(boundsOf(f), { padding: [24, 24] });
    },

    // Off by default and remembered. MapContours' terms rather than MapWind's:
    // this is a layer nobody needs until they are thinking about catchments,
    // and it costs 760 KB the first time it is asked for. An operator who turns
    // it on means it, so the answer survives a reload.
    setEnabled(on) {
      state.mapCatchments = on;
      try { localStorage.setItem('mn-catchments', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearLayer(); setNote(null, 'off'); seq++; return; }
      run();
    },

    ATTRIBUTION,
  };
})();
if (typeof window !== 'undefined') window.MapCatchments = MapCatchments;
