// MegaNet — map-hubs.js
//
//   MapHubs   The Bureau's eight maintenance hub boundaries, drawn under
//             everything else on the Stations map, and "whose hub is this
//             station in?" answered on its callout — so the question behind
//             every "who is going out to it?" can start from the map.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and `esc`; only from inside its own
// functions, so this file's position among the modules is free.
//
// ── What these are ───────────────────────────────────────────────────────────
// Adelaide, Brisbane, Cairns, Darwin, Hobart, Melbourne, Perth and Sydney. They
// are the Bureau's own division of the country for field maintenance, and they
// are an *administrative* boundary, not a physical one — which is exactly why
// they are worth drawing under the catchments rather than over them: a basin is
// a fact about water, a hub is a fact about who drives to it, and when the two
// disagree the disagreement is the interesting part. Two hubs cover the network
// this app is about: Cairns takes the north, Brisbane the rest, and the line
// between them is not where anybody guesses it is.
//
// Source is `Hub_Boundaries_May_2018v2_Si2.kmz`, built to
// `data/bom-hubs.geojson` by `tools/build_geo_layers.py`. May 2018 and there is
// no newer one to hand; the note says so, because a boundary that has moved
// since is a boundary this layer is quietly wrong about.
//
// ── The coastline, and why 5,267 islands are not drawn ───────────────────────
// The source is a coastline-derived polygon set: 5,931 rings for eight hubs,
// and all but a few hundred of them are islets off Tasmania and Cape York of
// well under a square kilometre. The drawn copy keeps rings of 1 km² and up —
// 480 km² dropped in total, which is 0.006% of the country and none of it
// visible at any zoom this layer is read at.
//
// Station *assignment* is a different question and gets the untouched geometry,
// in the build tool, where it also gets a 25 km snap: every hub boundary stops
// at the water's edge, so the gauges at Hawthorne and Jindalee — on the Brisbane
// River, fifteen kilometres inland, unambiguously Brisbane's to maintain — are
// inside no hub at all. Eighteen stations are in that position and the furthest
// is 1.34 km out. Responsibility does not stop at the shoreline.
//
// ── Pointer conventions (#150) ───────────────────────────────────────────────
// Nothing in this pane takes the pointer, for the reason MapCatchments and
// MapWind give: the shared station canvas is above it, and a polygon the size
// of Queensland must never take a click a pin was drawn to answer.
const MapHubs = (function () {
  const DATA_URL = 'data/bom-hubs.geojson';
  const ATTRIBUTION = 'Maintenance hubs © Commonwealth of Australia (Bureau of Meteorology) 2018';

  // The lowest pane on the map. Wind regions sit at 330 "because the broadest
  // context on the map goes lowest" and catchments at 325 for the same reason;
  // an administrative boundary is context for the physical one, so it goes
  // under it.
  const PANE   = 'mnHubs';
  const PANE_Z = 320;

  // Eight hubs, eight hues, evenly spaced round the wheel so that neighbours on
  // the map are never neighbours in hue. Literal hexes rather than tokens, for
  // MapWind's reason: Leaflet path options cannot take var().
  const HUB_COLOR = {
    adelaide:  '#d4703a',
    brisbane:  '#3a86c8',
    cairns:    '#38a06b',
    darwin:    '#b8863a',
    hobart:    '#7d6bb5',
    melbourne: '#c05a7a',
    perth:     '#4aa3a3',
    sydney:    '#8a8f3f',
  };
  const DEFAULT_COLOR = '#7a8899';

  let map = null;
  // An SVG renderer of its own, for the reason map-catchments.js gives: the
  // map's shared canvas would swallow these polygons out of this pane.
  let renderer = null;
  let layer = null;
  let labels = null;
  let data = null;
  let loading = null;
  let note = { kind: 'init' };
  let seq = 0;

  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(j => { data = j; return j; })
      .catch(e => { loading = null; throw e; });
    return loading;
  }

  function features() { return (data && data.features) || []; }

  function colorFor(f) { return HUB_COLOR[f.properties.id] || DEFAULT_COLOR; }

  function ringsOf(geom) {
    if (!geom) return [];
    return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  }

  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // The hub a point is in, or null. Callers that need an answer for a station
  // in the water want the build tool's snapped assignment, not this — this one
  // answers the geometric question honestly and says nothing when the honest
  // answer is nothing.
  function hubAt(lat, lon) {
    for (const f of features()) {
      for (const rings of ringsOf(f.geometry)) {
        if (!inRing(lat, lon, rings[0])) continue;
        let holed = false;
        for (let i = 1; i < rings.length; i++) {
          if (inRing(lat, lon, rings[i])) { holed = true; break; }
        }
        if (!holed) return { id: f.properties.id, name: f.properties.name };
      }
    }
    return null;
  }

  // The biggest ring of each hub carries its label — a hub's name belongs on
  // its mainland, not on whichever island happened to sort first.
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
      if (Math.abs(a) > bestArea && a !== 0) {
        bestArea = Math.abs(a);
        best = [cy / (6 * a), cx / (6 * a)];
      }
    }
    return best;
  }

  function clearLayer() {
    for (const l of [layer, labels]) if (l && map) map.removeLayer(l);
    layer = labels = null;
  }

  function render() {
    if (!map || !state.mapHubs || !data) return;
    clearLayer();

    layer = L.geoJSON(data, {
      pane: PANE,
      renderer,
      interactive: false,
      attribution: ATTRIBUTION,
      style: f => {
        const c = colorFor(f);
        // Heavier on the line than the catchments and lighter on the fill: a
        // hub boundary is read as a *line* — which side of it a station is on —
        // where a basin is read as an area.
        return { color: c, weight: 2, opacity: 0.7, fillColor: c, fillOpacity: 0.05 };
      },
    }).addTo(map);

    labels = L.layerGroup([], { pane: PANE }).addTo(map);
    for (const f of features()) {
      const at = labelPoint(f);
      if (!at) continue;
      L.marker(at, {
        pane: PANE,
        interactive: false,
        icon: L.divIcon({
          className: 'mn-hub-label',
          html: `<span>${esc(f.properties.name)}</span>`,
          iconSize: null,
        }),
      }).addTo(labels);
    }

    setNote('on');
  }

  function run() {
    if (!map || !state.mapHubs) return;
    const mine = ++seq;
    setNote('loading');
    ensureData().then(() => {
      if (mine !== seq || !map || !state.mapHubs) return;
      render();
      rerenderMapLegend();
    }).catch(() => {
      if (mine !== seq || !map) return;
      clearLayer();
      setNote('fail');
      rerenderMapLegend();
    });
  }

  const PROVENANCE = 'Bureau of Meteorology hub boundaries as at May 2018 — the most recent '
                   + 'set to hand. A boundary that has moved since is one this layer is wrong about.';

  function setNote(kind) {
    note = { kind, count: features().length };
    const el = document.getElementById('map-hub-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    // See map-catchments.js: the panel is built before attach() runs, and the
    // opening state is whatever the switch says.
    const kind = note.kind === 'init'
      ? (typeof state !== 'undefined' && state.mapHubs ? 'on' : 'off')
      : note.kind;
    switch (kind) {
      case 'off':     return 'Maintenance hubs are hidden.';
      case 'loading': return 'Loading hub boundaries…';
      case 'fail':    return 'Hub boundaries unavailable — data/bom-hubs.geojson could not be '
                           + 'read. Untick and re-tick to try again.';
      case 'on':      return `<strong>${note.count}</strong> maintenance hubs. `
                           + 'Which hub a station falls in is on its callout. ' + PROVENANCE;
      default:        return 'Who maintains what: the Bureau’s eight field maintenance hubs. '
                           + PROVENANCE;
    }
  }

  return {
    // The legend's key: one row per hub, with the colour drawn on the map.
    hubs() {
      return features().map(f => ({ id: f.properties.id, name: f.properties.name,
                                color: colorFor(f), area_sqkm: f.properties.area_sqkm }));
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
      if (state.mapHubs) run();
    },

    detach() {
      clearLayer();
      renderer = null;
      map = null;
      seq++;
    },

    active() { return !!layer; },

    noteHtml,
    hubAt,

    // Off by default and remembered, on MapCatchments' terms.
    setEnabled(on) {
      state.mapHubs = on;
      try { localStorage.setItem('mn-hubs', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearLayer(); setNote('off'); seq++; return; }
      run();
    },

    ATTRIBUTION,
  };
})();
if (typeof window !== 'undefined') window.MapHubs = MapHubs;
