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
//
// ── Easements and land tenure (Views, 2026-11-07) ───────────────────────────
// Two more switches on the same export, for Property services: easements as a
// dashed line, and land tenure as a tint. Both ride the one request the lot
// lines already make — more entries in `dynamicLayers`, never a second image —
// and the layer draws while any of the three is on.
//
//   * Easements. Sublayer 4 holds them already (cover_typ 'Easement', checked
//     live: the same 2,363 features over Toowoomba as sublayer 9 "Easement
//     Parcels Only"), so until now they were drawn as the same solid white line
//     as a lot and could not be told from one. With the switch on, the lot
//     entries take `cover_typ <> 'Easement'` and the easements come in as their
//     own entry: a white dash over a solid dark casing. Solid, not dashed as
//     well: the server scales a dash with the line's width, so a dashed casing
//     twice as wide never lines up with the dash on it (tried, and it reads as
//     noise). Strata and volumetric lots stay as they were — switching
//     easements on should not take other lines away.
//   * Tenure. Sublayer 13 "Tenure" (the same parcels again, with `tenure`), a
//     unique-value fill per class at FILL_ALPHA, no outline, drawn last in the
//     list so it is under every line. Freehold is not filled. Most land is
//     freehold, so a freehold tint is a wash over the whole map; and it is
//     almost every polygon in a town, which is what the server spends its time
//     on: the same 1600 × 1120 export over Brisbane at 1:240,000 took 33 s with
//     freehold filled and under 3 s without. "Clear" in the key means freehold.
//     Tenure has its own, wider scale gate (TENURE_MAX_SCALE): a national park
//     or a State forest is a regional shape, and without the freehold polygons
//     a regional view is cheap.
//
// The flags are part of what an image is cached against (drawnBox.key is the
// whole `dynamicLayers` string), so a switch, or a theme whose tokens give the
// tint other colours, fetches afresh. With easements and tenure off the string
// — and so the export URL, 2-D and 3-D — is byte for byte what it always was.
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

  // ── Easements and tenure (see the header) ──────────────────────────────────
  const LS_EASEMENTS = 'mn-easements';
  const LS_TENURE    = 'mn-land-tenure';
  const TENURE_FALLBACK_ID = 13;
  const TENURE_RE          = /^tenure$/i;
  // Everything but easements, for the lot lines while easements have their own.
  const NOT_EASEMENT_WHERE = "cover_typ <> 'Easement'";
  const EASEMENT_WHERE     = "cover_typ = 'Easement'";
  // A tint is a regional shape; without the freehold polygons a 1:300,000 view
  // over Brisbane exports in under 3 s. The service's own limit for the
  // sublayer is 1:500,000.
  const TENURE_MAX_SCALE = 300000;
  // About 35 % — the base map stays readable under it, and a national park
  // still reads as one at a glance over satellite imagery.
  const FILL_ALPHA = 89;
  // The classes the tint draws, each a token in styles.css (with the literal
  // the export falls back to) and the TENURE values it covers, as the service
  // spells them. Forest reserve, State forest and timber reserve are one
  // colour, as the service's own symbology has them. Freehold is not here —
  // see the header — and neither are the minor tenures (Main Road, Railway,
  // Water Resource, Mines Tenure, …), which stay clear with freehold.
  const TENURE = [
    { key: 'park',    token: '--map-tenure-park',    fallback: '#2e8b3e',
      values: ['National Park'],
      label: 'National park' },
    { key: 'forest',  token: '--map-tenure-forest',  fallback: '#1b7f79',
      values: ['State Forest', 'Forest Reserve', 'Timber Reserve'],
      label: 'State forest, forest or timber reserve' },
    { key: 'reserve', token: '--map-tenure-reserve', fallback: '#a3c93a',
      values: ['Reserve'],
      label: 'Reserve — kept for a public purpose: a park, a cemetery, a water supply' },
    { key: 'lease',   token: '--map-tenure-lease',   fallback: '#e8892b',
      values: ['Lands Lease'],
      label: 'Lands lease — State land leased out, often for grazing' },
    { key: 'state',   token: '--map-tenure-state',   fallback: '#d6539b',
      values: ['State Land'],
      label: 'State land nobody holds yet (unallocated)' },
  ];
  const TENURE_WHERE = `cover_typ = 'Base' AND tenure IN (${
    TENURE.flatMap(c => c.values).map(v => `'${v}'`).join(',')})`;
  const EASEMENT_TOKEN = '--map-easement', EASEMENT_FALLBACK = '#ffffff';

  // The meanings, once, for the rows' titles here and for Views' word list
  // (map-views.js) to take rather than say again.
  const WORDS = {
    'Easement': 'A strip of a lot that someone other than its owner has a right to use — a council drain, a power line, a neighbour’s driveway. The land stays the owner’s. Drawn as a dashed white line under the property lines; a station card’s land details name the easements at that site.',
    'Land tenure': 'How the land is held: freehold (owned privately), leased from the State, or kept by the State as a national park, State forest, reserve or unallocated State land. Freehold is left clear; each other kind is a pale colour of its own, under the property lines (Queensland only).',
  };

  // What a request draws when nobody says otherwise: the lot lines alone, the
  // shape every caller had before easements and tenure.
  const LOTS_ONLY = Object.freeze({ lots: true, easements: false, tenure: false });

  let map = null, overlay = null, timer = null, seq = 0, failedAt = 0;
  let layerId = null, tenureId = null, resolving = null;
  // { bounds, zoom, key, want } the overlay covers: `key` the dynamicLayers
  // string it was drawn from, `want` which of lots / easements / tenure are in it.
  let drawnBox = null;
  // Null until the first run(), for MapSurvey's reason: the panel renders
  // before attach() has run, and with the switch on by default a seeded 'off'
  // would put "Property boundaries are hidden" under a ticked box.
  let note = null;

  function viewScale() {
    const z   = map.getZoom();
    const lat = map.getCenter().lat * Math.PI / 180;
    return 559082264.028 / Math.pow(2, z) * Math.cos(lat);
  }

  // The parcels sublayer's id, and — from the same answer — the tenure
  // sublayer's (tenureId), each by name with its fallback.
  function resolveLayer() {
    if (layerId != null) return Promise.resolve(layerId);
    if (resolving) return resolving;
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    resolving = fetch(SERVICE_URL + '?f=json', { signal: ctl.signal })
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        const list = (json && json.layers) || [];
        const hit = list
          .find(l => LAYER_RE.test(String(l.name || '')) && !/deprecated/i.test(String(l.name || '')));
        const ten = list.find(l => TENURE_RE.test(String(l.name || '').trim()));
        layerId  = hit ? hit.id : FALLBACK_ID;
        tenureId = ten ? ten.id : TENURE_FALLBACK_ID;
        return layerId;
      })
      .catch(() => { layerId = FALLBACK_ID; tenureId = TENURE_FALLBACK_ID; return layerId; })
      .finally(() => clearTimeout(t));
    return resolving;
  }

  // A token's colour as the [r, g, b] an esri symbol takes. Reads '#rgb',
  // '#rrggbb' and 'rgb(…)'/'rgba(…)'; anything else is the fallback literal.
  function rgbOf(token, fallback) {
    const raw = typeof cssVar === 'function' ? cssVar(token, fallback) : fallback;
    const parse = s => {
      const v = String(s || '').trim();
      let m = /^#([0-9a-f]{3})$/i.exec(v);
      if (m) return [...m[1]].map(h => parseInt(h + h, 16));
      m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v);
      if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
      m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
      if (m) return [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Number(n))));
      return null;
    };
    return parse(raw) || parse(fallback) || [255, 255, 255];
  }

  // The tint: one fill per TENURE value, no outline, nothing for a value not
  // listed (the definition expression leaves those out of the request anyway).
  function tenureRenderer() {
    const none = { type: 'esriSLS', style: 'esriSLSNull', color: [0, 0, 0, 0], width: 0 };
    return {
      type: 'uniqueValue', field1: 'tenure', defaultSymbol: null,
      uniqueValueInfos: TENURE.flatMap(c => {
        const symbol = { type: 'esriSFS', style: 'esriSFSSolid',
                         color: [...rgbOf(c.token, c.fallback), FILL_ALPHA], outline: none };
        return c.values.map(value => ({ value, symbol }));
      }),
    };
  }

  // The same sublayer twice: a dark casing, then the white line over it (and
  // the labels on that one). Ids are the request's own, not the service's.
  //
  // `want` says which of the three to draw (LOTS_ONLY when not given, which is
  // the request every caller made before easements and tenure and is the same
  // string to the byte). The first entry in the list is drawn on top, so the
  // order is: lot lines, then the easements' dash and its casing under them —
  // where an easement runs along a boundary the boundary stays solid, and the
  // dash shows the easement's inside edge, the way a survey plan draws it —
  // and the tenure tint at the bottom, under every line.
  function dynamicLayers(id, labelScale = LABEL_SCALE, labelWhere = null, want = LOTS_ONLY) {
    const outline = (color, width, style = 'esriSLSSolid') => ({
      type: 'simple',
      symbol: { type: 'esriSFS', style: 'esriSFSNull',
                outline: { type: 'esriSLS', style, color, width } },
    });
    // Spread between `source` and `drawingInfo`, so with easements off the
    // lot entries' keys — and the JSON — are exactly what they were.
    const lotWhere = want.easements ? { definitionExpression: NOT_EASEMENT_WHERE } : {};
    const list = [];
    if (want.lots) list.push(...lotEntries(id, labelScale, labelWhere, lotWhere, outline));
    if (want.easements) {
      list.push(
        { id: 3, source: { type: 'mapLayer', mapLayerId: id },
          definitionExpression: EASEMENT_WHERE,
          drawingInfo: { renderer: outline([...rgbOf(EASEMENT_TOKEN, EASEMENT_FALLBACK), 235], 1.3, 'esriSLSDash'),
                         showLabels: false } },
        { id: 2, source: { type: 'mapLayer', mapLayerId: id },
          definitionExpression: EASEMENT_WHERE,
          drawingInfo: { renderer: outline([20, 20, 20, 130], 2.6), showLabels: false } });
    }
    if (want.tenure) {
      list.push(
        { id: 4, source: { type: 'mapLayer', mapLayerId: tenureId != null ? tenureId : TENURE_FALLBACK_ID },
          definitionExpression: TENURE_WHERE,
          drawingInfo: { renderer: tenureRenderer(), showLabels: false } });
    }
    return JSON.stringify(list);
  }

  // The lot lines' two entries — unchanged from before easements, bar the
  // definition expression `lotWhere` adds while easements are drawn apart.
  function lotEntries(id, labelScale, labelWhere, lotWhere, outline) {
    return [
      { id: 1, source: { type: 'mapLayer', mapLayerId: id }, ...lotWhere,
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
      { id: 0, source: { type: 'mapLayer', mapLayerId: id }, ...lotWhere,
        drawingInfo: { renderer: outline([20, 20, 20, 150], 2.4), showLabels: false } },
    ];
  }

  // The export's parameters, for the 2-D image and the 3-D tiles alike.
  // png32, not MapContours' png8: the casing is translucent, and png8's
  // one-bit alpha would turn it into a solid black band.
  function exportParams(id, w, h, labelScale, labelWhere, want = LOTS_ONLY) {
    return new URLSearchParams({
      f: 'image', format: 'png32', transparent: 'true', dpi: '96',
      bboxSR: '3857', imageSR: '3857',
      size: `${w},${h}`,
      dynamicLayers: dynamicLayers(id, labelScale, labelWhere, want),
    });
  }

  // ── Which of the three are on, and which this view draws ──────────────────
  const anyOn = () => !!(state.mapLots || state.mapEasements || state.mapTenure);
  // The switches, scale aside — what the 3-D tiles draw (they gate by zoom).
  const switched = () => ({ lots: !!state.mapLots, easements: !!state.mapEasements, tenure: !!state.mapTenure });
  // …and what the 2-D image at this scale draws: lots and easements below
  // MAX_SCALE, the tint below its own TENURE_MAX_SCALE.
  function wanted(scale) {
    return {
      lots:      !!state.mapLots      && scale <= MAX_SCALE,
      easements: !!state.mapEasements && scale <= MAX_SCALE,
      tenure:    !!state.mapTenure    && scale <= TENURE_MAX_SCALE,
    };
  }
  const drawsAny = w => w.lots || w.easements || w.tenure;

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
    const ten = document.getElementById('map-tenure-note');
    if (ten) ten.innerHTML = tenureNoteHtml();
  }

  // `note` is the one image's state — off, zoom, loading, fail, ok — and each
  // row reads its own answer out of it: the lot lines can be "zoom in" while
  // the tint, with its wider gate, is drawn.
  function lotsKind() {
    // Before the first run() the answer is whatever run() is about to reach:
    // "zoom in" with the switch on, because the map opens on the whole network.
    if (!note) return state.mapLots ? 'zoom' : 'off';
    if (!state.mapLots) return 'off';
    // Something else is drawn at this scale; the lot lines are not.
    if (map && viewScale() > MAX_SCALE) return 'zoom';
    return note.kind;
  }

  function noteHtml() {
    switch (lotsKind()) {
      case 'off':     return 'Property boundaries are hidden.';
      case 'zoom':    return 'Zoom in to draw property boundaries — they are drawn below about 1:40,000.';
      case 'loading': return 'Drawing property boundaries…';
      case 'fail':    return 'Property boundaries unavailable — the Queensland spatial data service could not be reached.';
      case 'ok': {
        const dash = drawnBox && drawnBox.want.easements ? ' Easements are the dashed lines.' : '';
        return (map && viewScale() <= LABEL_SCALE
          ? 'Property boundaries drawn, labelled with lot/plan (Queensland cadastre — Queensland only).'
          : 'Property boundaries drawn (Queensland cadastre — Queensland only). Zoom in further for lot/plan labels.')
          + dash;
      }
      default:        return '';
    }
  }

  function tenureKind() {
    if (!state.mapTenure) return 'off';
    if (!note || note.kind === 'off') return 'zoom';
    if (map && viewScale() > TENURE_MAX_SCALE) return 'zoom';
    return note.kind;
  }

  function tenureNoteHtml() {
    switch (tenureKind()) {
      case 'off':     return 'Land tenure is hidden.';
      case 'zoom':    return `Zoom in to tint land tenure — it is drawn below about 1:${
        TENURE_MAX_SCALE.toLocaleString('en-AU')}.`;
      case 'loading': return 'Tinting land tenure…';
      case 'fail':    return 'Land tenure unavailable — the Queensland spatial data service could not be reached.';
      case 'ok':      return 'Land tenure tinted: national parks, State forests, reserves, leases and unallocated '
                           + 'State land. Freehold is left clear (Queensland cadastre — Queensland only).';
      default:        return '';
    }
  }

  function run() {
    if (!anyOn()) { clearOverlay(); setNote('off'); return; }
    if (!map) return;
    const want = wanted(viewScale());
    if (!drawsAny(want)) { clearOverlay(); setNote('zoom'); return; }

    // The overlay is reused only for the same request: the same box, the same
    // zoom and the same dynamicLayers — the switches and the tint's colours.
    // An overlay means the ids are resolved, so the string can be built here.
    if (overlay && drawnBox && drawnBox.zoom === map.getZoom()
        && drawnBox.bounds.contains(map.getBounds())
        && drawnBox.key === dynamicLayers(layerId, LABEL_SCALE, null, want)) { setNote('ok'); return; }

    if (Date.now() - failedAt < FAIL_TTL) { clearOverlay(); setNote('fail'); return; }

    // The picture on the map holds a layer this scale no longer draws — zoomed
    // out past the lot lines with land tenure still on: off it comes now,
    // rather than shrinking on the map with its lot lines and lot numbers for
    // the seconds the tenure-only picture takes.
    if (overlay && drawnBox && drawnBox.want) {
      const was = drawnBox.want;
      if ((was.lots && !want.lots) || (was.easements && !want.easements) || (was.tenure && !want.tenure)) clearOverlay();
    }

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

      const params = exportParams(id, w, h, undefined, undefined, want);
      const key = params.get('dynamicLayers');
      params.set('bbox', `${sw.x},${sw.y},${ne.x},${ne.y}`);
      const url = `${SERVICE_URL}/export?${params}`;

      const img = new Image();
      const t = setTimeout(() => { img.src = ''; }, TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(t);
        if (mine !== seq || !map || !anyOn()) return;
        const had = !!overlay;
        if (overlay) overlay.remove();
        overlay = L.imageOverlay(url, bounds, { pane: PANE, opacity: OPACITY }).addTo(map);
        drawnBox = { bounds, zoom: map.getZoom(), key, want };
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

  // After any of the three switches. An image already on its way was asked
  // with the old switches, so it is dropped (seq); one on the map that holds
  // something now switched off goes at once rather than when its replacement
  // lands, so unticking a box is seen to do something; one that only lacks
  // what was switched on stays until the new one replaces it.
  function switchChanged() {
    seq++;
    // The 3-D view draws them too, off the same switches — a no-op unless it
    // is open, as MapElevation's call is.
    if (typeof Map3D !== 'undefined' && Map3D.cadastreChanged) Map3D.cadastreChanged();
    if (!anyOn()) { clearTimeout(timer); clearOverlay(); setNote('off'); return; }
    if (overlay && drawnBox) {
      const was = drawnBox.want, now = switched();
      if ((was.lots && !now.lots) || (was.easements && !now.easements) || (was.tenure && !now.tenure)) {
        clearOverlay();
      }
    }
    setNote(map && drawsAny(wanted(viewScale())) ? 'loading' : 'zoom');
    sync();
  }

  // The legend's entries for the easements and the tint, while the image on
  // the map holds them. The lot line's own entry is app.js's (MapLots.active()).
  // A swatch's colour is the token itself, so a theme change repaints it.
  function legendHtml() {
    if (!overlay || !drawnBox) return '';
    const term = (t, m) => (typeof termHtml === 'function' ? termHtml(t, m) : esc(t));
    const out = [];
    if (drawnBox.want.easements) {
      out.push(`
    <span class="legend-item">
      <span class="legend-line legend-line-easement"></span>
      <span class="small">${term('Easement', WORDS['Easement'])}, dashed — a strip of a lot
        someone else has a right to use (Qld cadastre)</span>
    </span>`);
    }
    if (drawnBox.want.tenure) {
      out.push(`
    <span class="legend-item">
      <span class="small">${term('Land tenure', WORDS['Land tenure'])} — who holds the land:</span>
    </span>`);
      for (const c of TENURE) {
        out.push(`
    <span class="legend-item">
      <span class="legend-sq legend-sq-tenure" style="--dot:var(${c.token}, ${c.fallback})"></span>
      <span class="small">${esc(c.label)}</span>
    </span>`);
      }
      out.push(`
    <span class="legend-item">
      <span class="legend-sq legend-sq-tenure is-clear"></span>
      <span class="small">Clear — freehold (privately owned), and roads, rail and water</span>
    </span>`);
    }
    return out.join('');
  }

  // The two rows Map display puts right after Property boundaries and its
  // note: easements as a sub-row of it (they are lots, drawn differently), and
  // tenure as a row of its own, with its own note, since it draws without the
  // lot lines and at a wider scale.
  function subRowsHtml() {
    const tenureScale = TENURE_MAX_SCALE.toLocaleString('en-AU');
    return `
    <label class="filter-check filter-sub"
           title="${escAttr(`${WORDS['Easement']} Drawn as a white dashed line, apart from the solid lot boundaries, below about 1:40,000.`)}">
      <input type="checkbox" ${state.mapEasements ? 'checked' : ''}
             onchange="MapLots.setEasements(this.checked);rerenderMapLegend()">
      Easements, dashed
    </label>
    <label class="filter-check"
           title="${escAttr(`${WORDS['Land tenure']} Each is a tint of its own; freehold is left clear. Drawn below about 1:${tenureScale}, with or without the lot boundaries.`)}">
      <input type="checkbox" ${state.mapTenure ? 'checked' : ''}
             onchange="MapLots.setTenure(this.checked);rerenderMapLegend()">
      Land tenure (Qld)
    </label>
    <p class="filter-note" id="map-tenure-note">${tenureNoteHtml()}</p>`;
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

    // What the picture draws at this scale — the lots, the easements, the
    // tint — for the property tip under the pointer (map-property-tip.js).
    drawnNow() { return map ? wanted(viewScale()) : null; },

    // Does the legend claim a property-boundary key right now? The lot lines
    // only: an image holding just the tint or the easements is not one.
    active() { return !!overlay && !!drawnBox && !!drawnBox.want.lots; },

    // The same lines as tiles, for the 3-D view (see the header). The bbox
    // goes on the end unencoded: MapLibre fills `{bbox-epsg-3857}` in itself,
    // and URLSearchParams would escape the braces out of it.
    //
    // The switches as they are, scale aside: the tiles' own zoom floor is the
    // gate here, and the tint comes in at it with the lines rather than at its
    // wider 2-D scale — a tilted camera sees to the horizon, and a horizon of
    // tinted regional tiles is many seconds of export each.
    tiles() {
      return resolveLayer().then(id => ({
        url: `${SERVICE_URL}/export?${exportParams(id, TILE_PX, TILE_PX, TILE_LABEL_SCALE, TILE_LABEL_WHERE, switched())}&bbox={bbox-epsg-3857}`,
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
      switchChanged();
    },

    // Easements as a dashed line of their own (see the header). Off by default
    // and remembered, on the road owners' terms: a way of reading the lots
    // somebody chooses. Drawn at the lot lines' scale, with or without them.
    setEasements(on) {
      state.mapEasements = !!on;
      try { localStorage.setItem(LS_EASEMENTS, on ? 'on' : 'off'); } catch (_) {}
      switchChanged();
    },

    // Land tenure as a tint (see the header). Off by default and remembered;
    // drawn below TENURE_MAX_SCALE, with or without the lot lines.
    setTenure(on) {
      state.mapTenure = !!on;
      try { localStorage.setItem(LS_TENURE, on ? 'on' : 'off'); } catch (_) {}
      switchChanged();
    },

    tenureNoteHtml,
    subRowsHtml,
    legendHtml,
    WORDS,

    // For checks: what the image on the map was drawn with, and the request
    // string any set of switches makes — so "easements and tenure off is the
    // export it always was" can be asserted rather than trusted.
    _state() {
      return {
        want: drawnBox ? { ...drawnBox.want } : null,
        layers: drawnBox ? drawnBox.key : null,
        layerId, tenureId,
        note: note ? note.kind : null,
        maxScale: MAX_SCALE, tenureMaxScale: TENURE_MAX_SCALE,
      };
    },
    _layers(want = LOTS_ONLY, labelScale = LABEL_SCALE, labelWhere = null) {
      return dynamicLayers(layerId != null ? layerId : FALLBACK_ID, labelScale, labelWhere,
                           { ...LOTS_ONLY, ...want });
    },
  };
})();
if (typeof window !== 'undefined') window.MapLots = MapLots;
