// MegaNet — map-councils.js
//
//   MapCouncils   The council areas (local government areas, LGAs) of the
//                 whole country, drawn under the pins as boundary lines, with
//                 each council's name at a zoom where it fits — and, when
//                 asked, every council shaded its own tint so the areas read at
//                 a glance. On the Stations map from its Layers panel, and on
//                 the 🔁 Repeaters map from the panel over it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and `esc`, and to app.js for
// rerenderMapLegend and rerenderMapDisplayControls, all from inside its own
// functions, so this file's position among the modules is free.
//
// ── What these are ───────────────────────────────────────────────────────────
// The Australian Bureau of Statistics' Local Government Areas, ASGS Edition 4
// (2026): 547 councils, every state and territory, because the network runs
// well past Queensland. `tools/build_lga_layer.mjs` cuts the ABS's own
// generalised copy (66 MB) to `data/lga-boundaries.geojson` (about 1 MB, a
// third of that on the wire) keeping shared borders shared, with more detail
// in Queensland and New South Wales, a tint index no neighbour shares and a
// label point inside each shape. The ABS says of its own LGAs that they are a
// Mesh Block approximation of the gazetted boundaries rather than the legal
// line, and the note says so: within a few hundred metres of a boundary this
// layer is a guide, not the answer — the What is here card's land section
// (site-land.js) asks the Queensland cadastre for the council at a point.
//
// ── One drawing per map ──────────────────────────────────────────────────────
// Unlike the hubs and basins this was written for more than one map from the
// start: view(map, opts) draws on any Leaflet map and hands back the handle
// that restyles or removes it, and the Stations map's switch is one caller of
// it among others. The data is fetched once, whoever asks first.
//
// ── Pointer conventions (#150) ───────────────────────────────────────────────
// Nothing in this pane takes the pointer, for the reason MapCatchments and
// MapHubs give: the station canvas and the repeaters' links are above it, and
// a polygon the size of a shire must never take a click a pin was drawn to
// answer. The names are labels, not tooltips, for the same reason.
const MapCouncils = (function () {
  const DATA_URL = 'data/lga-boundaries.geojson';
  const ATTRIBUTION = 'Council areas © Australian Bureau of Statistics (ASGS Edition 4), CC BY 4.0';

  // Between the hubs (320) and the basins (325) in the shared z budget
  // map-survey.js documents: an administrative boundary like the hubs, but a
  // finer one, so it draws over them; under the basins, which are the physical
  // fact the administrative ones are context for.
  const PANE   = 'mnCouncils';
  const PANE_Z = 322;

  // One ink for every boundary — a council boundary is read as a line, which
  // side of it a site is on — in a violet none of the other boundary layers
  // or the roads use. The tints are only there to tell neighbours apart, so
  // they are soft and say nothing; the build tool picked an index for each
  // council that none of its neighbours has. Literal hexes rather than tokens,
  // for MapWind's reason: Leaflet path options cannot take var().
  const LINE = '#6a3d9a';
  const TINTS = ['#e3a857', '#6fb3d9', '#9ccf7a', '#d98aa8', '#b49ad9', '#d9c56f'];
  const DEFAULT_TINT = '#a7b0ba';

  // Names by size and zoom: a council is named once the view is close enough
  // for its name to sit inside it. 80,000 km² at zoom 5, a quarter of that
  // each zoom in — the big western shires from the state view, a city council
  // from about zoom 10, every one from 12.
  const LABEL_AREA_Z5 = 80000;
  const LABEL_CAP = 80;

  const SHADE_DEFAULT = 0.22;

  let data = null, loading = null;

  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(j => { data = j; return j; })
      .catch(e => { loading = null; throw e; });
    return loading;
  }

  function councils() { return (data && data.features) || []; }

  const tintOf = f => TINTS[f.properties.c] || DEFAULT_TINT;
  const clampOpacity = v => Math.max(0.05, Math.min(0.8, Number(v) || SHADE_DEFAULT));

  // ── A drawing on one map ───────────────────────────────────────────────────
  // opts: { shade: bool, opacity: 0.05–0.8 }. The caller has ensured the data;
  // a view made before it arrives draws when it does.
  function view(map, opts = {}) {
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE);
      pane.style.zIndex = PANE_Z;
      pane.style.pointerEvents = 'none';
    }
    // An SVG renderer of its own, for the reason map-catchments.js gives: the
    // Stations map's shared canvas would swallow these polygons out of this pane.
    const renderer = L.svg({ pane: PANE });
    const o = { shade: !!opts.shade, opacity: clampOpacity(opts.opacity) };
    let layer = null, labels = null, gone = false;

    const style = f => ({
      color: LINE, weight: 1.3, opacity: 0.8,
      fill: o.shade, fillColor: tintOf(f), fillOpacity: o.shade ? o.opacity : 0,
    });

    function paintLabels() {
      if (!labels || gone) return;
      labels.clearLayers();
      const z = map.getZoom();
      const minArea = LABEL_AREA_Z5 / Math.pow(4, z - 5);
      const box = map.getBounds().pad(0.05);
      const hits = councils()
        .filter(f => f.properties.lp && f.properties.area_sqkm >= minArea && box.contains(f.properties.lp))
        .sort((a, b) => b.properties.area_sqkm - a.properties.area_sqkm)
        .slice(0, LABEL_CAP);
      for (const f of hits) {
        L.marker(f.properties.lp, {
          pane: PANE, interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'mn-council-label', html: `<span>${esc(f.properties.name)}</span>`, iconSize: null }),
        }).addTo(labels);
      }
    }

    function draw() {
      if (gone || !data) return;
      layer = L.geoJSON(data, { pane: PANE, renderer, interactive: false, attribution: ATTRIBUTION, style }).addTo(map);
      labels = L.layerGroup([], { pane: PANE }).addTo(map);
      paintLabels();
      map.on('moveend', paintLabels);
    }

    if (data) draw();
    else ensureData().then(draw, () => { /* the caller's note says so */ });

    return {
      setShade(on) { o.shade = !!on; if (layer) layer.setStyle(style); },
      setOpacity(v) { o.opacity = clampOpacity(v); if (layer) layer.setStyle(style); },
      drawn() { return !!layer; },
      remove() {
        gone = true;
        map.off('moveend', paintLabels);
        for (const l of [layer, labels]) if (l) { try { map.removeLayer(l); } catch (_) { /* map gone */ } }
        layer = labels = null;
      },
    };
  }

  // ── The Stations map's switch ──────────────────────────────────────────────
  let map = null, main = null, note = 'init', seq = 0;

  const PROVENANCE = 'Australian Bureau of Statistics, ASGS Edition 4 (2026) — its approximation of the '
                   + 'gazetted boundaries, close to but not the legal line.';

  function setNote(kind) {
    note = kind;
    const el = document.getElementById('map-council-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    const kind = note === 'init' ? (typeof state !== 'undefined' && state.mapCouncils ? 'on' : 'off') : note;
    switch (kind) {
      case 'off':     return 'Council areas are hidden.';
      case 'loading': return 'Loading council boundaries…';
      case 'fail':    return 'Council boundaries unavailable — data/lga-boundaries.geojson could not be read. '
                           + 'Untick and re-tick to try again.';
      default:        return (councils().length ? `<strong>${councils().length}</strong> council areas` : 'Council areas')
                           + ', named as you zoom in. ' + PROVENANCE;
    }
  }

  function clear() { if (main) main.remove(); main = null; }

  function run() {
    if (!map || !state.mapCouncils) return;
    const mine = ++seq;
    setNote('loading');
    ensureData().then(() => {
      if (mine !== seq || !map || !state.mapCouncils) return;
      clear();
      main = view(map, { shade: state.mapCouncilShade, opacity: state.mapCouncilOpacity });
      setNote('on');
      rerenderMapLegend();
    }).catch(() => {
      if (mine !== seq || !map) return;
      clear();
      setNote('fail');
      rerenderMapLegend();
    });
  }

  function store(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  return {
    ATTRIBUTION,
    LINE,
    PROVENANCE,
    SHADE_DEFAULT,
    ready() { return ensureData(); },
    view,
    // The legend's tints, in index order — what the shading draws.
    tints() { return TINTS.slice(); },
    count() { return councils().length; },

    attach(m) { map = m; if (state.mapCouncils) run(); },
    detach() { clear(); map = null; seq++; },
    active() { return !!main; },
    noteHtml,

    // Off by default and remembered, on the hubs' terms: a megabyte nobody
    // needs until they are asking whose area a site is in.
    setEnabled(on) {
      state.mapCouncils = !!on;
      store('mn-councils', on ? 'on' : 'off');
      if (!on) { clear(); setNote('off'); seq++; }
      else run();
      rerenderMapDisplayControls();
      rerenderMapLegend();
    },
    setShade(on) {
      state.mapCouncilShade = !!on;
      store('mn-council-shade', on ? 'on' : 'off');
      if (main) main.setShade(on);
      rerenderMapDisplayControls();
      rerenderMapLegend();
    },
    // In place, like the elevation slider: a style, not a redraw.
    setOpacity(v) {
      state.mapCouncilOpacity = clampOpacity(v);
      store('mn-council-opacity', String(state.mapCouncilOpacity));
      if (main) main.setOpacity(state.mapCouncilOpacity);
    },
  };
})();
if (typeof window !== 'undefined') window.MapCouncils = MapCouncils;
