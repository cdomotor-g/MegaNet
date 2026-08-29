// MegaNet — map-wind.js
//
//   MapWind   AS/NZS 1170.2 wind loading regions (A0–A5, B1, B2, C, D) drawn
//             over the Stations map, and "what wind region is this station
//             in?" answered on its callout — so a mast or aerial conversation
//             can start from the map instead of from the Standard's figure.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; only from inside its own functions, so
// this file's position among the modules is free, the same way #120 left it
// for MapSurvey.
//
// The polygons are Geoscience Australia's machine-readable interpretation of
// the 2021 Standard's boundary definitions (eCat 146359), simplified to ~1 km
// and embedded at data/wind-regions-as1170-2021.geojson — no live service to
// be down. Fetched once, on the first enable, never at load: a context layer
// costs nothing until asked for, and 650 KB of continent is not part of
// opening the Stations tab. GA's metadata is blunt that the dataset is its
// *interpretation* and "not suitable for design purposes"; the note under the
// toggle says so, and nothing here should be read as a design determination.
// Licence: CC-BY 4.0 — the attribution rides the layer onto the map's
// attribution control and is restated in the note.
const MapWind = (function () {
  const DATA_URL    = 'data/wind-regions-as1170-2021.geojson';
  const ATTRIBUTION = 'Wind regions © Commonwealth of Australia (Geoscience Australia) 2021 CC-BY 4.0';

  // Its own pane in the shared z budget map-survey.js documents: below
  // contours (335), because the broadest context on the map goes lowest —
  // regions under contour lines under rivers under marks. Pointer events off,
  // like the spider legs' pane: a polygon the size of Queensland must never
  // take a click that a pin or a link line was drawn to answer.
  const PANE   = 'mnWind';
  const PANE_Z = 330;

  // One colour per region family, calm to cyclonic, the severity ramp anyone
  // who has read the Standard's map expects: the A regions are one wind
  // question wherever the subscript falls, B splits because B2 is the
  // knock-on of the cyclonic coast, and D exists only on the Pilbara coast.
  // Literal hexes rather than tokens: Leaflet path options cannot take
  // var(), and at fill-opacity .2 over map tiles neither theme needs its own
  // set — the same reasoning ML_CARRIER_RING records.
  const REGION_COLOR = {
    A:  '#43a047',   // A0–A5 — the temperate interior and south
    B1: '#fdd835',   // intermediate
    B2: '#fb8c00',   // the band behind the cyclonic coast
    C:  '#e53935',   // cyclonic
    D:  '#6a1b9a',   // severe cyclonic — WA's Pilbara coast only
  };

  function colorFor(region) {
    return REGION_COLOR[region] || REGION_COLOR[String(region || '')[0]] || '#607d8b';
  }

  let map = null, layer = null, timer = null, seq = 0;
  let data = null, loading = null;
  let note = { kind: 'off' };

  function setNote(kind) {
    note = { kind };
    const el = document.getElementById('map-wind-note');
    if (el) el.innerHTML = noteHtml();
  }

  // The file is fetched at most once per page life; both success and failure
  // are remembered. Failure is worth remembering rather than retried on a
  // timer because the two ways this fails — file:// (fetch cannot read a
  // sibling file there) and offline — do not fix themselves mid-session, and
  // the checkbox itself is the retry: off and on again asks again.
  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { data = d; loading = null; return d; })
      .catch(err => { loading = null; throw err; });
    return loading;
  }

  function clearLayer() {
    if (layer && map) map.removeLayer(layer);
    layer = null;
  }

  function render() {
    if (!map || !state.mapWind || !data) return;
    clearLayer();
    layer = L.geoJSON(data, {
      pane: PANE,
      interactive: false,
      attribution: ATTRIBUTION,
      style: f => {
        const c = colorFor(f.properties && f.properties.region);
        return { color: c, weight: 1, opacity: 0.5, fillColor: c, fillOpacity: 0.2 };
      },
    }).addTo(map);
    setNote('on');
  }

  function run() {
    const mine = ++seq;
    setNote('loading');
    ensureData().then(() => {
      if (mine !== seq || !map || !state.mapWind) return;
      render();
    }).catch(() => {
      if (mine !== seq) return;
      setNote('fail');
    });
  }

  // Ray-cast point-in-polygon over the loaded features, even-odd across every
  // ring so holes count themselves out. ~10k vertices for the whole continent
  // — microseconds per ask, no index worth building. Answers null until the
  // layer has been turned on once, which is honest: the callout only claims a
  // region when the data that claims it is on hand (and, being ~1 km
  // simplified, the answer near a boundary is as indicative as the layer).
  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function regionAt(lat, lon) {
    if (!data || lat == null || lon == null) return null;
    for (const f of data.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
                  : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        let hits = 0;
        for (const ring of poly) if (inRing(lat, lon, ring)) hits++;
        if (hits % 2 === 1) {
          return { region: f.properties.region, area: f.properties.area };
        }
      }
    }
    return null;
  }

  function noteHtml() {
    const key = Object.entries(REGION_COLOR).map(([r, c]) =>
      `<span class="legend-dot" style="--dot:${c}"></span>&nbsp;${r === 'A' ? 'A0–A5' : r}`).join(' &nbsp;');
    const provenance = 'Geoscience Australia’s reading of AS/NZS 1170.2:2021 (CC-BY 4.0) — '
      + 'indicative only, ~1 km boundaries, not a design determination.';
    switch (note.kind) {
      case 'loading': return 'Fetching the wind regions…';
      case 'fail':    return 'The wind regions file could not be read — offline, or the app is '
                           + 'running from file://. Untick and re-tick to try again.';
      case 'on':      return `${key}<br>${provenance}`;
      default:        return 'Wind loading regions over the whole map, A (temperate) through D '
                           + '(severe cyclonic). ' + provenance;
    }
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
      }
      if (state.mapWind) run();
    },

    detach() {
      clearTimeout(timer);
      clearLayer();
      map = null;
      seq++;
    },

    // Does the map display note claim the key right now?
    active() { return !!layer; },

    noteHtml,

    // What wind region a point sits in, from the loaded data — null until the
    // layer has fetched it. The station callout asks this.
    regionAt,

    // Off by default, not persisted — MapSurvey's reasoning: a layer that
    // costs a network request stays off until asked for, and a fresh page
    // load fires no extra requests without reasoning about a remembered
    // on-state. (One 650 KB file, browser-cached after the first ask.)
    setEnabled(on) {
      state.mapWind = on;
      if (!on) { clearLayer(); setNote('off'); seq++; return; }
      run();
    },
  };
})();
if (typeof window !== 'undefined') window.MapWind = MapWind;
