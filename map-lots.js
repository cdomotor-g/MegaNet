// MegaNet — map-lots.js
//
//   MapLots   property / lot boundaries — every parcel in the Queensland
//             digital cadastre (DCDB), the same layer Queensland Globe draws
//             as "Land parcels" — over the Stations map, with each lot's
//             lot/plan written in it once the view is close enough to read.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; across to app.js for rerenderMapLegend.
// Both only from inside MapLots' own functions, so this file's position among
// the modules is free, the same way #120 left it for MapSurvey.
//
// ── Why an image and not vectors, when MapRoads is vectors ───────────────────
// Same service as MapRoads (the Land Parcel Property Framework, which is what
// Queensland Globe's cadastre is served from), different answer, for the
// reason map-roads.js gives for its own choice turned round: road parcels are
// sparse, and every parcel is not. A suburban screenful is thousands of lots,
// each a ring of dozens of vertices, on a map that already runs one shared
// canvas for 3,000 pins and links. So this is MapContours' pattern — the
// MapServer's `export` drawn as one L.imageOverlay per view, over a padded box
// so a pan inside it costs nothing.
//
// The service's own symbology is not used. `dynamicLayers` restyles the
// "Cadastral parcels" sublayer per request: no fill, and a white line over a
// dark casing, drawn as the same sublayer twice. A single colour cannot hold
// over both base maps — white vanishes on the light topo, anything dark
// vanishes on the shadowed half of the satellite imagery — while a cased line
// reads on both, which is the same answer every link on this map already gives
// with its white casing. The lot/plan labels go on with the same halo trick,
// and only below LABEL_SCALE: at a wider view they are a solid mat of text.
//
// ── Pointer ─────────────────────────────────────────────────────────────────
// Nothing here takes the pointer: it is an image, in a pane under the shared
// pins-and-links canvas, and a lot is a target the size of the map. The label
// carries what a callout would have said.
//
// ── The 3-D view ────────────────────────────────────────────────────────────
// The same export, as tiles: `tiles()` hands map-3d.js a template with
// MapLibre's `{bbox-epsg-3857}` in it, built by the same exportParams() and
// the same dynamicLayers() as the 2-D image, so a lot line is one style in both
// modes. Tiles rather than this file's one padded image because a tilted camera
// sees to the horizon, far past the box the 2-D map under it covers.
const MapLots = (function () {
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer';
  // Resolved by name at runtime — MapRoads' probe, for the same sublayer.
  const FALLBACK_ID = 4;
  const LAYER_RE    = /cadastral\s+parcels/i;
  const ATTRIBUTION = '© State of Queensland (Department of Natural Resources and Mines, '
                    + 'Manufacturing and Regional and Rural Development)';

  // Between the contour image (335) and the road parcels (338) in the shared
  // z budget map-survey.js documents: a boundary line over the terrain lines,
  // under the road reserve that is a more specific statement about the same
  // ground.
  const PANE   = 'mnLots';
  const PANE_Z = 336;

  // Scale gates rather than zoom gates, for MapContours' reason (metres per
  // pixel shrink with latitude). Wider than 1:40,000 a rural view is still
  // readable but a town is a grey smear; labels need about 1:5,000 before
  // "12RP3264" fits inside the lot it names.
  const MAX_SCALE   = 40000;
  const LABEL_SCALE = 5000;
  const PAD         = 0.3;
  const MAX_PX      = 2048;
  // The 3-D view's tiles (tiles()): 512 px, MapLibre's own tile size. A 512 px
  // tile at zoom z is drawn at 295,829,355 / 2^z, so z13 (1:36,000) is the
  // first zoom inside MAX_SCALE. Past z19 a tile is drawing the same lines
  // larger.
  //
  // The labels come in a zoom later than in 2-D — z17, 1:2,250 — and only on
  // the ground's own lots of a house block or more, because a tilted camera
  // sees several times the ground a flat one does and draped text is squashed
  // by the tilt. Over Toowoomba's centre at 60° the 2-D labelling was a mat of
  // numbers to the horizon, most of them easements, building plans and strata
  // lots stacked on the same few blocks. The export applies both itself, per
  // tile; the lines are every parcel, as in 2-D.
  const TILE_PX          = 512;
  const TILE_MINZOOM     = 13;
  const TILE_MAXZOOM     = 19;
  const TILE_LABEL_SCALE = 2500;
  const TILE_LABEL_WHERE = "cover_typ = 'Base' AND lot_area >= 400";
  const OPACITY     = 0.9;
  const DEBOUNCE_MS = 200;
  const TIMEOUT_MS  = 20000;
  const FAIL_TTL    = 60000;

  let map = null, overlay = null, timer = null, seq = 0, failedAt = 0;
  let layerId = null, resolving = null;
  let drawnBox = null;               // { bounds, zoom } the overlay covers
  // Null until the first run(), for MapSurvey's reason: the panel renders
  // before attach() has run, and with the switch on by default a seeded 'off'
  // would put "Property boundaries are hidden" under a ticked box.
  let note = null;

  function viewScale() {
    const z   = map.getZoom();
    const lat = map.getCenter().lat * Math.PI / 180;
    return 559082264.028 / Math.pow(2, z) * Math.cos(lat);
  }

  function resolveLayer() {
    if (layerId != null) return Promise.resolve(layerId);
    if (resolving) return resolving;
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    resolving = fetch(SERVICE_URL + '?f=json', { signal: ctl.signal })
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        const hit = ((json && json.layers) || [])
          .find(l => LAYER_RE.test(String(l.name || '')) && !/deprecated/i.test(String(l.name || '')));
        layerId = hit ? hit.id : FALLBACK_ID;
        return layerId;
      })
      .catch(() => { layerId = FALLBACK_ID; return layerId; })
      .finally(() => clearTimeout(t));
    return resolving;
  }

  // The same sublayer twice: a dark casing, then the white line over it (and
  // the labels on that one). Ids are the request's own, not the service's.
  function dynamicLayers(id, labelScale = LABEL_SCALE, labelWhere = null) {
    const outline = (color, width) => ({
      type: 'simple',
      symbol: { type: 'esriSFS', style: 'esriSFSNull',
                outline: { type: 'esriSLS', style: 'esriSLSSolid', color, width } },
    });
    return JSON.stringify([
      { id: 1, source: { type: 'mapLayer', mapLayerId: id },
        drawingInfo: {
          renderer: outline([255, 255, 255, 235], 0.9),
          showLabels: true,
          labelingInfo: [{
            labelExpressionInfo: { expression: '$feature.lotplan' },
            labelPlacement: 'esriServerPolygonPlacementAlwaysHorizontal',
            minScale: labelScale,
            ...(labelWhere ? { where: labelWhere } : {}),
            symbol: { type: 'esriTS', color: [255, 255, 255, 255],
                      haloColor: [20, 20, 20, 220], haloSize: 1.5,
                      font: { family: 'Arial', size: 9 } },
          }],
        } },
      { id: 0, source: { type: 'mapLayer', mapLayerId: id },
        drawingInfo: { renderer: outline([20, 20, 20, 150], 2.4), showLabels: false } },
    ]);
  }

  // The export's parameters, for the 2-D image and the 3-D tiles alike.
  // png32, not MapContours' png8: the casing is translucent, and png8's
  // one-bit alpha would turn it into a solid black band.
  function exportParams(id, w, h, labelScale, labelWhere) {
    return new URLSearchParams({
      f: 'image', format: 'png32', transparent: 'true', dpi: '96',
      bboxSR: '3857', imageSR: '3857',
      size: `${w},${h}`,
      dynamicLayers: dynamicLayers(id, labelScale, labelWhere),
    });
  }

  function clearOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    drawnBox = null;
    if (map && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  function setNote(kind) {
    note = { kind };
    const el = document.getElementById('map-lots-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    // Before the first run() the answer is whatever run() is about to reach:
    // "zoom in" with the switch on, because the map opens on the whole network.
    const n = note || { kind: state.mapLots ? 'zoom' : 'off' };
    switch (n.kind) {
      case 'off':     return 'Property boundaries are hidden.';
      case 'zoom':    return 'Zoom in to draw property boundaries — they are drawn below about 1:40,000.';
      case 'loading': return 'Drawing property boundaries…';
      case 'fail':    return 'Property boundaries unavailable — the Queensland spatial data service could not be reached.';
      case 'ok':
        return map && viewScale() <= LABEL_SCALE
          ? 'Property boundaries drawn, labelled with lot/plan (Queensland cadastre — Queensland only).'
          : 'Property boundaries drawn (Queensland cadastre — Queensland only). Zoom in further for lot/plan labels.';
      default:        return '';
    }
  }

  function run() {
    if (!state.mapLots) { clearOverlay(); setNote('off'); return; }
    if (!map) return;
    if (viewScale() > MAX_SCALE) { clearOverlay(); setNote('zoom'); return; }

    if (overlay && drawnBox && drawnBox.zoom === map.getZoom()
        && drawnBox.bounds.contains(map.getBounds())) { setNote('ok'); return; }

    if (Date.now() - failedAt < FAIL_TTL) { clearOverlay(); setNote('fail'); return; }

    const mine = ++seq;
    setNote('loading');
    resolveLayer().then(id => {
      if (mine !== seq || !map) return;
      const bounds = map.getBounds().pad(PAD);
      const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
      const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
      const px = map.getSize();
      let w = Math.round(px.x * (1 + 2 * PAD)), h = Math.round(px.y * (1 + 2 * PAD));
      const over = Math.max(w, h) / MAX_PX;
      if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }

      const params = exportParams(id, w, h);
      params.set('bbox', `${sw.x},${sw.y},${ne.x},${ne.y}`);
      const url = `${SERVICE_URL}/export?${params}`;

      const img = new Image();
      const t = setTimeout(() => { img.src = ''; }, TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(t);
        if (mine !== seq || !map || !state.mapLots) return;
        const had = !!overlay;
        if (overlay) overlay.remove();
        overlay = L.imageOverlay(url, bounds, { pane: PANE, opacity: OPACITY }).addTo(map);
        drawnBox = { bounds, zoom: map.getZoom() };
        if (!had && map.attributionControl) map.attributionControl.addAttribution(ATTRIBUTION);
        setNote('ok');
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

    // Does the legend claim a property-boundary key right now?
    active() { return !!overlay; },

    // The same lines as tiles, for the 3-D view (see the header). The bbox
    // goes on the end unencoded: MapLibre fills `{bbox-epsg-3857}` in itself,
    // and URLSearchParams would escape the braces out of it.
    tiles() {
      return resolveLayer().then(id => ({
        url: `${SERVICE_URL}/export?${exportParams(id, TILE_PX, TILE_PX, TILE_LABEL_SCALE, TILE_LABEL_WHERE)}&bbox={bbox-epsg-3857}`,
        size: TILE_PX, minzoom: TILE_MINZOOM, maxzoom: TILE_MAXZOOM,
        opacity: OPACITY, attribution: ATTRIBUTION,
      }));
    },

    noteHtml,

    // On by default and remembered, on MapRoads' terms: the scale gate keeps a
    // cold load to no request at all — the map opens on the whole network —
    // and an operator who switches the lines off means it. core.js says why
    // the key is not the 'mn-lots' this layer shipped with.
    setEnabled(on) {
      state.mapLots = on;
      try { localStorage.setItem('mn-property-boundaries', on ? 'on' : 'off'); } catch (_) {}
      // The 3-D view draws them too, off the same switch — a no-op unless it
      // is open, as MapElevation's call is.
      if (typeof Map3D !== 'undefined' && Map3D.cadastreChanged) Map3D.cadastreChanged();
      if (!on) { clearTimeout(timer); clearOverlay(); setNote('off'); return; }
      setNote(map && viewScale() <= MAX_SCALE ? 'loading' : 'zoom');
      sync();
    },
  };
})();
if (typeof window !== 'undefined') window.MapLots = MapLots;
