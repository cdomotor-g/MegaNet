// MegaNet — map-road-owners.js
//
//   MapRoadOwners   who manages each road and bridge in Queensland — Transport
//                   and Main Roads, the council, the Parks and Wildlife
//                   Service, a private landholder — drawn over the Stations
//                   map from the State's own road data: every road coloured by
//                   who manages it, and every bridge a pin that says whose it
//                   is and who to call about it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, KM_PER_DEG_LAT, kmPerDegLon and
// stationMapLinkUrls; across to app.js for rerenderMapLegend, and to
// map-here.js, map-move-pin.js and link-budget.js only to ask whether one of
// them owns the click. All from inside its own functions, so this file's
// position among the modules is free. site-roads.js reads its owner classes
// and asks its contact lookup, for the same answers about one point.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Asked for in these words: "we should include road and bridge owners … the
// road owners marked on the map". A gauge on a bridge, a mast in a road
// reserve, the track a crew drives in on: each is somebody's road, and whose
// decides who gives permission to work there, who closes it in a flood and who
// to ring when it is damaged. Road parcels (map-roads.js) say where the road
// reserve is and name the council area; they cannot say whether the road in it
// is the council's or the State's, which is the question.
//
// ── The sources ─────────────────────────────────────────────────────────────
// One host, spatial-gis.information.qld.gov.au — keyless, CORS, the platform
// the cadastre layers already read. Two services under Transportation:
//
//   RoadsAndTracks/MapServer        Queensland Roads and Tracks (QRT), CC BY 4.0
//     "Roads and tracks"            every road segment in the State, with the
//                                   two fields this layer is drawn from:
//                                   scr_indicator (T for a road declared
//                                   State-controlled) and road_owner, whose
//                                   codes the QRT data dictionary (November
//                                   2025) defines — OWNER_CODE below.
//     "Bridges"                     road bridges and overpasses as lines, about
//                                   5,500: a cartographic set, council bridges
//                                   among them, with no owner on them.
//   StateRoadInformation/MapServer  Transport and Main Roads, CC BY 3.0 AU
//     "State controlled bridge"     TMR's register of the bridges it manages:
//                                   one point per carriageway per structure,
//                                   with the structure's number, name, type
//                                   and the road section on it or under it.
//
// And for who to call, QLDTraffic's road lookup (contacts()): the service
// behind https://qldtraffic.qld.gov.au/lookup.html, which takes a point and
// answers with the council, the TMR district and TMR's state traffic centre,
// each with a phone number and an email address. It is not in the QLDTraffic
// API specification — it is what the State's own traffic site asks, keyless
// and CORS-open — so it is asked once for a point somebody chose, cached, and
// its failure takes nothing else with it: the Elvis bargain map-here.js
// records.
//
// ── What "owner" means here ─────────────────────────────────────────────────
// The land under a public road is the State's (Land Act 1994); what differs is
// who manages and controls the road — Transport and Main Roads for a road
// declared State-controlled under the Transport Infrastructure Act 1994, the
// council for nearly every other. The data dictionary calls that the owner, and
// so does this layer. Six classes, each drawn one way:
//
//   tmr      State-controlled (scr_indicator T, or road_owner TMR). The one
//            answer the data gives for every segment, so it is drawn heaviest,
//            in maroon over a white casing.
//   council  road_owner LG — recorded as the council's.
//   unknown  road_owner Unknown and not State-controlled: 342,520 of the
//            563,463 segments in October 2026. Most are council roads and some
//            are private, and the State has not recorded which, so the layer
//            does not guess. It draws them as their own class and says what
//            QLDTraffic's road lookup says of the same roads: the council's, or
//            private.
//   park     QPWS and Forestry — national parks and State forests.
//   private  Private — "the owner of the land parcel in which the road passes
//            through". Dashed, the cartographic convention for a road not open
//            to everybody.
//   other    STATE, WA, PA, UP, Other — another State authority, a water or
//            port authority, a utility provider, another body.
//
// ── Roads: one image per view. Bridges: pins ─────────────────────────────────
// The roads are MapLots' problem rather than MapRoads': a city's screenful is
// 6,000 to 14,000 segments (measured over Toowoomba and Brisbane at zoom 14),
// far past what a vector layer on this map could hold. So they are the
// MapServer's own export, one padded L.imageOverlay per view, restyled per
// request with dynamicLayers — an Arcade renderer keyed on the owner, with a
// State-controlled road's key forced to TMR, and the white casing as the same
// sublayer again underneath. Footpaths, bikeways, ferries and proposed roads
// are left out. Wider than ALL_SCALE only the State-controlled network is drawn
// — the one class that still reads at a regional scale, and the one a flood
// cuts that the Bureau's warnings name — and wider than STATE_SCALE nothing is.
//
// Bridges are sparse, tens to a few hundred a view, and they are what somebody
// wants to point at, so they are pins with a hover label and a callout, from
// BRIDGE_MIN_ZOOM in. TMR's register is the authority for TMR's bridges. A QRT
// bridge within MERGE_M of a registered structure is the same bridge and is
// dropped; measured over Toowoomba, Brisbane and Rockhampton, the two sets
// agree to within 30 m where both have a bridge, and each holds bridges the
// other does not. A QRT bridge left over is therefore not one TMR manages: it
// is managed with the road it carries, which is normally the council's.
//
// ── Pointer conventions ─────────────────────────────────────────────────────
// MapSurvey's, for MapSurvey's reason: the shared pins-and-links canvas sits
// above both panes and owns every DOM event, so nothing here is interactive and
// the bridge pins are hit-tested from the map's own mousemove and click. The
// roads take no pointer at all — they are an image, and a road is a target the
// length of the map. "Who manages this road?" at a point is What is here
// (map-here.js), whose card carries site-roads.js's section.
const MapRoadOwners = (function () {
  const HOST      = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Transportation';
  const ROADS_URL = `${HOST}/RoadsAndTracks/MapServer`;
  const STATE_URL = `${HOST}/StateRoadInformation/MapServer`;
  const LOOKUP_URL = 'https://r8s97t2t19.execute-api.ap-southeast-2.amazonaws.com/prod/lookuproad';

  // Each sublayer is resolved by name, once per page load, with the id the
  // live service publishes it under today as the fallback — MapRoads' probe.
  const SUB = {
    roads: { url: ROADS_URL, re: /^roads and tracks$/i,        fallback: 10 },
    qrtBr: { url: ROADS_URL, re: /^bridges$/i,                 fallback: 22 },
    tmrBr: { url: STATE_URL, re: /^state controlled bridge$/i, fallback: 3 },
  };

  const ATTRIBUTION = '© State of Queensland (Department of Natural Resources and Mines, Manufacturing '
                    + 'and Regional and Rural Development; Transport and Main Roads)';

  // ── The owners ────────────────────────────────────────────────────────────
  // road_owner, as the QRT data dictionary defines each code, and the class it
  // is drawn in. Forestry is not in the dictionary but is in the data (36
  // segments, maintained by Forestry as well), and goes with the parks.
  const OWNER_CODE = {
    TMR:      { cls: 'tmr',     who: 'the Department of Transport and Main Roads' },
    LG:       { cls: 'council', who: 'the council' },
    QPWS:     { cls: 'park',    who: 'the Queensland Parks and Wildlife Service' },
    Forestry: { cls: 'park',    who: 'State forestry' },
    Private:  { cls: 'private', who: 'the owner of the land it crosses' },
    STATE:    { cls: 'other',   who: 'another State authority' },
    WA:       { cls: 'other',   who: 'a water authority' },
    PA:       { cls: 'other',   who: 'a port authority' },
    UP:       { cls: 'other',   who: 'a utility provider' },
    Other:    { cls: 'other',   who: 'another body' },
    Unknown:  { cls: 'unknown', who: 'not recorded' },
  };

  // How each class is drawn and named. Literal hexes, for map-wind.js's reason
  // — they reach the export's renderer and a pin's inline SVG, neither of which
  // takes a var() — and so the key, the image and the pins are one table.
  // Widths are the export's points (1 pt is 1⅓ px at 96 dpi).
  //
  // The maroon is the one colour that has to carry: the State-controlled
  // network over every base map. It sits apart from the two reds already on
  // this map — the line-of-sight verdict's pink-crimson and a base station's
  // orange-red pin — by being darker than both, and the white casing under it
  // is what holds it over the shadowed half of the imagery. The rest stay out
  // of blue, which on this map is water (the rivers) and radio (a repeater, a
  // channel's link): slate for the council's, a lighter, thinner slate for the
  // unrecorded, green for the parks, brown and dashed for private, teal for
  // the other public bodies.
  const CLASSES = {
    tmr:     { color: '#8e1537', pt: 2.4,
               label: 'State-controlled — Transport and Main Roads',
               key:   'Road — State-controlled (Transport and Main Roads)' },
    council: { color: '#37474f', pt: 1.3,
               label: 'the council’s, as the State records it',
               key:   'Road — the council’s, as recorded' },
    unknown: { color: '#607d8b', pt: 0.9, alpha: 0.8,
               label: 'not State-controlled; the council’s or private — the State has not recorded which',
               key:   'Road — not State-controlled, owner not recorded (the council’s or private)' },
    park:    { color: '#2e7d32', pt: 1.3,
               label: 'national park or State forest — Queensland Parks and Wildlife Service',
               key:   'Road — national park or State forest' },
    private: { color: '#8d6e63', pt: 1.1, dash: true,
               label: 'private — the owner of the land it crosses',
               key:   'Road — private' },
    other:   { color: '#00838f', pt: 1.1,
               label: 'another public body',
               key:   'Road — port, water or utility authority, or another public body' },
  };
  const CLASS_ORDER = ['tmr', 'council', 'unknown', 'park', 'private', 'other'];
  const CASING_PT   = 4.2;

  function classOf(scr, owner) {
    if (String(scr || '').toUpperCase() === 'T' || owner === 'TMR') return 'tmr';
    return (OWNER_CODE[owner] || OWNER_CODE.Unknown).cls;
  }

  // What is drawn. A footpath, a bikeway and a ferry route are in QRT but are
  // not roads anybody drives a trailer down, and a proposed road is not there.
  const ROAD_WHERE = "class NOT IN ('Walkway','Bikeway','Ferry') AND op_status_ind <> 'Proposed'";
  const SCR_WHERE  = "(scr_indicator = 'T' OR road_owner = 'TMR')";
  // The renderer's key: the owner code, with a State-controlled road's forced
  // to TMR — the one place scr_indicator and road_owner are read together. In
  // the October 2026 data every T segment already says TMR, but the
  // declaration is what makes a road the State's, so it wins if they part.
  const OWNER_EXPR = "IIf($feature.scr_indicator == 'T', 'TMR', $feature.road_owner)";

  // ── Scales ────────────────────────────────────────────────────────────────
  // Scale gates rather than zoom gates, for MapContours' reason: metres per
  // pixel shrink with latitude. ALL_SCALE is where a town's streets stop
  // being a smear (zoom 12 in the south-east); STATE_SCALE is about zoom 8.
  const ALL_SCALE   = 150000;
  const STATE_SCALE = 3000000;
  const PAD         = 0.3;
  const MAX_PX      = 2048;
  const DEBOUNCE_MS = 200;
  const TIMEOUT_MS  = 20000;
  const FAIL_TTL    = 60000;

  // Bridges: MapRoads' zoom and bbox rounding, MapSurvey's hit radius.
  const BRIDGE_MIN_ZOOM = 13;
  const BBOX_STEP   = 0.02;    // deg (~2 km) — a small pan re-uses the answer it has
  const BBOX_MAX    = 0.6;     // deg — a backstop behind BRIDGE_MIN_ZOOM
  const MAX_BRIDGES = 800;     // drawn per view
  const CACHE_MAX   = 20;
  const MERGE_M     = 30;      // a QRT bridge this close to a registered structure is that structure
  const HIT_PX      = 9;
  const PIN_W = 18, PIN_H = 12;

  const PANE    = 'mnRoadOwners';   // the roads' image
  const PANE_Z  = 339;              // over the road parcels (338), under the rivers (340)
  const BPANE   = 'mnBridges';      // the bridge pins
  const BPANE_Z = 346;              // points over context lines, as the survey marks (345)

  let map = null, timer = null;
  const ids = {}, resolving = {};

  // The roads' image.
  let overlay = null, drawnBox = null, roadSeq = 0, roadFailedAt = 0;
  // { kind: 'off'|'zoom'|'loading'|'ok'|'fail', tier: 'all'|'state'|null }.
  // Null until the first run, for MapSurvey's reason: the panel can render
  // before attach() has run.
  let roads = null;

  // The bridges.
  let bridgeLayer = null, bridgeSeq = 0, bridgeFailedAt = 0, drawnKey = null;
  let drawn = [], projected = null, hoverTip = null, moveRaf = null, cursorSet = false;
  let popup = null, popupBridge = null;
  // { kind: 'zoom'|'loading'|'ok'|'fail', entry }
  let bridges = { kind: 'zoom', entry: null };
  const cache = new Map();          // 's,w,n,e' → { list, capped }

  // ── Asking ────────────────────────────────────────────────────────────────

  const str = v => (v == null ? '' : String(v).trim());
  const UNREADABLE = 'answered with something this could not read';

  async function askJson(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`answered HTTP ${res.status}`);
      const json = await res.json();
      if (json && !Array.isArray(json) && json.error) {
        throw new Error(`answered with an error${json.error.message ? ` (${json.error.message})` : ''}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // site-land.js's words for a failure, so the two sections say it alike.
  function reason(e) {
    if (e && e.name === 'AbortError') return `no answer in ${TIMEOUT_MS / 1000} s`;
    if (e instanceof TypeError) return 'unreachable — offline, or the network blocks the host';
    const m = String((e && e.message) || '');
    return m ? m.slice(0, 160) : 'no usable answer';
  }

  function resolve(name) {
    if (ids[name] != null) return Promise.resolve(ids[name]);
    if (resolving[name]) return resolving[name];
    const sub = SUB[name];
    resolving[name] = askJson(sub.url + '?f=json')
      .then(json => {
        const hit = ((json && json.layers) || [])
          .find(l => sub.re.test(str(l.name)) && !/deprecated/i.test(str(l.name)));
        ids[name] = hit ? hit.id : sub.fallback;
        return ids[name];
      })
      .catch(() => { ids[name] = sub.fallback; return ids[name]; });
    return resolving[name];
  }

  function viewScale() {
    const z   = map.getZoom();
    const lat = map.getCenter().lat * Math.PI / 180;
    return 559082264.028 / Math.pow(2, z) * Math.cos(lat);
  }

  function tierNow() {
    if (!map) return null;
    const s = viewScale();
    return s <= ALL_SCALE ? 'all' : s <= STATE_SCALE ? 'state' : null;
  }

  // ── The roads' image ──────────────────────────────────────────────────────

  function rgba(hex, alpha = 1) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255)];
  }

  function lineSymbol(c) {
    return { type: 'esriSLS', style: c.dash ? 'esriSLSDash' : 'esriSLSSolid',
             color: rgba(c.color, c.alpha || 1), width: c.pt };
  }

  function renderer() {
    return {
      type: 'uniqueValue',
      valueExpression: OWNER_EXPR,
      defaultSymbol: lineSymbol(CLASSES.unknown),
      uniqueValueInfos: Object.keys(OWNER_CODE).map(code =>
        ({ value: code, label: code, symbol: lineSymbol(CLASSES[OWNER_CODE[code].cls]) })),
    };
  }

  // The same sublayer twice. First in the list is drawn on top — the order
  // map-lots.js's casing relies on — so the coloured roads come first and the
  // white casing under the State-controlled ones second.
  function dynamicLayers(id, tier) {
    const all = tier === 'all';
    return JSON.stringify([
      { id: 1, source: { type: 'mapLayer', mapLayerId: id },
        definitionExpression: all ? ROAD_WHERE : `${ROAD_WHERE} AND ${SCR_WHERE}`,
        drawingInfo: { renderer: renderer(), showLabels: false } },
      { id: 0, source: { type: 'mapLayer', mapLayerId: id },
        definitionExpression: `${ROAD_WHERE} AND ${SCR_WHERE}`,
        drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSLS', style: 'esriSLSSolid',
                                                            color: [255, 255, 255, 230], width: CASING_PT } },
                       showLabels: false } },
    ]);
  }

  // png32 for map-lots.js's reason: the unrecorded roads and the casing are
  // translucent, which png8's one-bit alpha would make solid.
  function exportParams(id, w, h, tier) {
    return new URLSearchParams({
      f: 'image', format: 'png32', transparent: 'true', dpi: '96',
      bboxSR: '3857', imageSR: '3857', size: `${w},${h}`,
      dynamicLayers: dynamicLayers(id, tier),
    });
  }

  function clearRoads() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    drawnBox = null;
    syncAttribution();
    rerenderMapLegend();
  }

  function runRoads() {
    if (!state.mapRoadOwners) { clearRoads(); roads = { kind: 'off', tier: null }; return; }
    if (!map) return;
    const tier = tierNow();
    if (!tier) { clearRoads(); roads = { kind: 'zoom', tier: null }; return; }
    if (overlay && drawnBox && drawnBox.zoom === map.getZoom() && drawnBox.tier === tier
        && drawnBox.bounds.contains(map.getBounds())) {
      roads = { kind: 'ok', tier };
      return;
    }
    if (Date.now() - roadFailedAt < FAIL_TTL) { clearRoads(); roads = { kind: 'fail', tier }; return; }

    const mine = ++roadSeq;
    roads = { kind: 'loading', tier };
    resolve('roads').then(id => {
      if (mine !== roadSeq || !map) return;
      const bounds = map.getBounds().pad(PAD);
      const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
      const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
      const px = map.getSize();
      let w = Math.round(px.x * (1 + 2 * PAD)), h = Math.round(px.y * (1 + 2 * PAD));
      const over = Math.max(w, h) / MAX_PX;
      if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }

      const params = exportParams(id, w, h, tier);
      params.set('bbox', `${sw.x},${sw.y},${ne.x},${ne.y}`);
      const url = `${ROADS_URL}/export?${params}`;
      const zoom = map.getZoom();

      const img = new Image();
      const t = setTimeout(() => { img.src = ''; }, TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(t);
        if (mine !== roadSeq || !map || !state.mapRoadOwners) return;
        if (overlay) overlay.remove();
        overlay = L.imageOverlay(url, bounds, { pane: PANE, opacity: 1 }).addTo(map);
        drawnBox = { bounds, zoom, tier };
        roads = { kind: 'ok', tier };
        syncAttribution();
        setNote();
        rerenderMapLegend();
      };
      img.onerror = () => {
        clearTimeout(t);
        if (mine !== roadSeq || !map) return;
        roadFailedAt = Date.now();
        clearRoads();
        roads = { kind: 'fail', tier };
        setNote();
      };
      img.src = url;
    });
  }

  // ── The bridges ───────────────────────────────────────────────────────────

  function roundedBbox(b) {
    const down = v => Math.floor(v / BBOX_STEP) * BBOX_STEP;
    const up   = v => Math.ceil(v / BBOX_STEP) * BBOX_STEP;
    return {
      s: Math.max(-90,  down(b.getSouth())), w: Math.max(-180, down(b.getWest())),
      n: Math.min(90,   up(b.getNorth())),   e: Math.min(180,  up(b.getEast())),
    };
  }

  const BRIDGE_FIELDS = {
    tmrBr: 'name,struc_id,struc_type,cons_type,cons_mtrl,rsect_name,road_code',
    qrtBr: 'name,feature_type,operational_status,additional_names',
  };
  const BRIDGE_WHERE = {
    tmrBr: '1=1',
    qrtBr: "operational_status NOT IN ('Dismantled','Proposed')",
  };

  function bridgeQueryUrl(name, id, b) {
    const params = new URLSearchParams({
      where: BRIDGE_WHERE[name],
      geometry: `${b.w},${b.s},${b.e},${b.n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: BRIDGE_FIELDS[name],
      returnGeometry: 'true',
      geometryPrecision: '6',
      resultRecordCount: '2000',
      f: 'geojson',
    });
    return `${SUB[name].url}/${id}/query?${params}`;
  }

  // Metres between two points, on a plane tangent at the first — over the few
  // tens of metres MERGE_M asks about, well inside the data's own accuracy.
  function metres(a, b) {
    const kx = kmPerDegLon(a[0]) * 1000, ky = KM_PER_DEG_LAT * 1000;
    return Math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * ky);
  }

  function metresToLine(p, line) {
    const kx = kmPerDegLon(p[0]) * 1000, ky = KM_PER_DEG_LAT * 1000;
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][1] - p[1]) * kx, ay = (line[i - 1][0] - p[0]) * ky;
      const bx = (line[i][1] - p[1]) * kx,     by = (line[i][0] - p[0]) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return line.length === 1 ? metres(p, line[0]) : best;
  }

  // Halfway along a bridge's line, by length: where its pin goes.
  function midpoint(lines) {
    const all = lines.reduce((a, l) => a.concat(l), []);
    let total = 0;
    for (let i = 1; i < all.length; i++) total += metres(all[i - 1], all[i]);
    let run = 0;
    for (let i = 1; i < all.length; i++) {
      const d = metres(all[i - 1], all[i]);
      if (run + d >= total / 2 && d > 0) {
        const t = (total / 2 - run) / d;
        return [all[i - 1][0] + t * (all[i][0] - all[i - 1][0]), all[i - 1][1] + t * (all[i][1] - all[i - 1][1])];
      }
      run += d;
    }
    return all[0];
  }

  function linesOf(g) {
    if (!g) return [];
    const paths = g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : [];
    return paths
      .map(p => p.map(([lon, lat]) => [lat, lon]).filter(([lat, lon]) => isFinite(lat) && isFinite(lon)))
      .filter(p => p.length);
  }

  // One pin per structure from the register — its carriageway points averaged
  // — then whatever of QRT's bridges is not one of them.
  //
  // road_code says which way a road section meets the structure: ON, it is
  // carried by it; OVER, the structure passes over it (an interchange bridge
  // has both: the ramps on it, the highway's carriageways under it).
  function bridgesFrom(tmrJson, qrtJson) {
    const structs = new Map();
    for (const f of (tmrJson && tmrJson.features) || []) {
      const g = f && f.geometry;
      if (!g || g.type !== 'Point') continue;
      const [lon, lat] = g.coordinates || [];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const p = f.properties || {};
      const id = p.struc_id != null ? String(p.struc_id) : `@${lat},${lon}`;
      let s = structs.get(id);
      if (!s) {
        s = { kind: 'tmr', id, struc: p.struc_id != null ? String(p.struc_id) : '', name: str(p.name),
              type: str(p.struc_type), cons: str(p.cons_type), mtrl: str(p.cons_mtrl),
              roads: new Map(), pts: [] };
        structs.set(id, s);
      }
      s.pts.push([lat, lon]);
      const road = str(p.rsect_name);
      if (road) {
        const how = s.roads.get(road) || new Set();
        how.add(str(p.road_code).toUpperCase() === 'OVER' ? 'over' : 'on');
        s.roads.set(road, how);
      }
    }
    const tmr = [...structs.values()].map(s => {
      const lat = s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length;
      const lon = s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length;
      const roads = [...s.roads].map(([name, how]) => ({ name, on: how.has('on'), over: how.has('over') }));
      return { ...s, lat, lon, roads };
    });

    const other = [];
    let n = 0;
    // About 60 m of latitude: a box round each QRT line that a registered
    // point has to be inside before the distance to the line is worth working
    // out — most pairs in a view are kilometres apart.
    const NEAR = 0.0006;
    for (const f of (qrtJson && qrtJson.features) || []) {
      const lines = linesOf(f && f.geometry);
      if (!lines.length) continue;
      const p = f.properties || {};
      const name = str(p.name) || str(p.additional_names);
      let s = 90, nn = -90, w = 180, e = -180;
      for (const l of lines) for (const [la, lo] of l) {
        if (la < s) s = la; if (la > nn) nn = la; if (lo < w) w = lo; if (lo > e) e = lo;
      }
      const pad = NEAR / Math.max(0.2, Math.cos(s * Math.PI / 180));
      const same = tmr.find(t => t.pts.some(pt =>
        pt[0] >= s - NEAR && pt[0] <= nn + NEAR && pt[1] >= w - pad && pt[1] <= e + pad
        && lines.some(l => metresToLine(pt, l) <= MERGE_M)));
      if (same) {
        if (!same.name && name) same.name = name;
        continue;
      }
      const [lat, lon] = midpoint(lines);
      other.push({ kind: 'other', id: `q${n++}`, name, type: str(p.feature_type) || 'Road bridge',
                   status: str(p.operational_status), lat, lon, lines });
    }
    return tmr.concat(other);
  }

  // How far a point is from a bridge: from the nearest of a registered
  // structure's carriageway points, or from anywhere along a QRT bridge's line
  // — a gauge at one end of a long bridge is on it, not half its length away.
  function metresToBridge(p, b) {
    if (b.lines) return Math.min(...b.lines.map(l => metresToLine(p, l)));
    if (b.pts && b.pts.length) return Math.min(...b.pts.map(q => metres(p, q)));
    return metres(p, [b.lat, b.lon]);
  }

  // Did the service stop short of everything the box holds? f=geojson says so
  // in its properties; f=json at the top level.
  const exceeded = j => !!(j && (j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit)));

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

  function pinSvg(cls, w = PIN_W, h = PIN_H) {
    const fill = CLASSES[cls === 'tmr' ? 'tmr' : 'council'].color;
    return `<svg class="mn-bridge-pin" viewBox="0 0 18 12" width="${w}" height="${h}" aria-hidden="true" focusable="false">`
      + `<rect x="0.9" y="0.9" width="16.2" height="10.2" rx="2.4" fill="${fill}" stroke="#fff" stroke-width="1.5"/>`
      + '<path d="M4 9.2 Q9 2.4 14 9.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'
      + '<path d="M2.6 9.2 H15.4" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'
      + '</svg>';
  }

  function clearHover() {
    if (hoverTip) { hoverTip.remove(); hoverTip = null; }
    if (cursorSet && map) { map.getContainer().style.cursor = ''; cursorSet = false; }
  }

  function clearBridges() {
    clearHover();
    if (popup) { popup.remove(); popup = null; popupBridge = null; }
    drawn = [];
    projected = null;
    drawnKey = null;
    if (!bridgeLayer) return;
    bridgeLayer.remove();
    bridgeLayer = null;
    syncAttribution();
    rerenderMapLegend();
  }

  function drawBridges(list, key) {
    if (!map) return;
    const had = !!bridgeLayer;
    if (bridgeLayer) bridgeLayer.remove();
    bridgeLayer = L.layerGroup([], { pane: BPANE }).addTo(map);
    for (const b of list) {
      const icon = L.divIcon({
        className: 'mn-bridge-div',
        html: pinSvg(b.kind),
        iconSize: [PIN_W, PIN_H],
        iconAnchor: [PIN_W / 2, PIN_H / 2],
      });
      // Non-interactive with nothing bound, as the header says: the map-level
      // hit test below is the only way a pointer reaches a bridge.
      L.marker([b.lat, b.lon], { pane: BPANE, icon, interactive: false, keyboard: false }).addTo(bridgeLayer);
    }
    drawn = list;
    drawnKey = key;
    reproject();
    if (!had) syncAttribution();
    rerenderMapLegend();
  }

  function runBridges() {
    if (!state.mapRoadOwners || !map) { clearBridges(); bridges = { kind: 'zoom', entry: null }; return; }
    if (map.getZoom() < BRIDGE_MIN_ZOOM) { clearBridges(); bridges = { kind: 'zoom', entry: null }; return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) {
      clearBridges(); bridges = { kind: 'zoom', entry: null }; return;
    }
    const key = [b.s, b.w, b.n, b.e].map(v => v.toFixed(3)).join(',');
    const hit = cacheGet(key);
    if (hit) {
      if (key !== drawnKey || !bridgeLayer) drawBridges(hit.list, key);
      bridges = { kind: 'ok', entry: hit };
      return;
    }
    if (Date.now() - bridgeFailedAt < FAIL_TTL) {
      clearBridges(); bridges = { kind: 'fail', entry: null }; return;
    }
    const mine = ++bridgeSeq;
    bridges = { kind: 'loading', entry: null };
    // Both or neither: without the register a QRT bridge cannot be told from
    // one of TMR's, and the pin would say "not State-controlled" of a bridge
    // that is.
    Promise.all([resolve('tmrBr'), resolve('qrtBr')])
      .then(([tid, qid]) => {
        if (mine !== bridgeSeq || !map) return null;
        return Promise.all([askJson(bridgeQueryUrl('tmrBr', tid, b)), askJson(bridgeQueryUrl('qrtBr', qid, b))]);
      })
      .then(got => {
        if (!got || mine !== bridgeSeq || !map) return;
        const all = bridgesFrom(got[0], got[1]);
        const capped = all.length > MAX_BRIDGES || exceeded(got[0]) || exceeded(got[1]);
        const entry = { list: capped ? all.slice(0, MAX_BRIDGES) : all, capped };
        cachePut(key, entry);
        drawBridges(entry.list, key);
        bridges = { kind: 'ok', entry };
        setNote();
      })
      .catch(() => {
        if (mine !== bridgeSeq || !map) return;
        bridgeFailedAt = Date.now();
        clearBridges();
        bridges = { kind: 'fail', entry: null };
        setNote();
      });
  }

  // ── Delegated hover and callout — MapSurvey's, on these pins ──────────────

  function reproject() {
    projected = null;
    if (!map || !drawn.length) return;
    projected = drawn.map(b => ({ b, pt: map.latLngToLayerPoint([b.lat, b.lon]) }));
  }

  function bridgeAtPoint(layerPt) {
    if (!projected) return null;
    let best = null, bestD = HIT_PX * HIT_PX;
    for (const m of projected) {
      const dx = m.pt.x - layerPt.x, dy = m.pt.y - layerPt.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = m.b; }
    }
    return best;
  }

  // Something else owns the pointer: a draw tool, a link-budget pick, What is
  // here armed, a pin being moved — the precedence every layer here gives them.
  function pointerTaken() {
    return !!((state.draw && state.draw.tool) || (state.link && state.link.picking)
      || (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed())
      || (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()));
  }

  // "Warrego Highway", "over the Toowoomba Connection Road", "on and over the
  // Warrego Highway" — how a registered structure meets the roads it names.
  function roadWords(b) {
    return (b.roads || []).map(r => (r.on && r.over ? `on and over ${r.name}`
      : r.over ? `over ${r.name}` : r.name)).join('; ');
  }

  function bridgeTitle(b) {
    if (b.name) return b.name;
    return b.kind === 'tmr' ? `Structure ${b.struc}` : b.type;
  }

  function bridgeLabel(b) {
    if (b.kind === 'tmr') {
      const roadsAt = roadWords(b);
      return `${bridgeTitle(b)} — Transport and Main Roads${roadsAt ? ` · ${roadsAt}` : ''}`;
    }
    return `${bridgeTitle(b)} — not State-controlled: normally the council’s`;
  }

  function onMapMove(e) {
    if (!bridgeLayer || moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!map || !bridgeLayer) return;
      const b = pointerTaken() ? null : bridgeAtPoint(e.layerPoint);
      if (!b) { clearHover(); return; }
      map.getContainer().style.cursor = 'pointer';
      cursorSet = true;
      if (!hoverTip) {
        hoverTip = L.tooltip({ className: 'mn-bridge-label', direction: 'top', offset: [0, -8], interactive: false })
          .setContent(esc(bridgeLabel(b))).setLatLng([b.lat, b.lon]).addTo(map);
      } else {
        hoverTip.setLatLng([b.lat, b.lon]).setContent(esc(bridgeLabel(b)));
      }
    });
  }

  function onMapClick(e) {
    if (!bridgeLayer || pointerTaken()) return;
    const b = bridgeAtPoint(e.layerPoint);
    if (b) openCallout(b);
  }

  // ── Who to call: QLDTraffic's road lookup ─────────────────────────────────
  // One request per point, kept for the session per ~10 m; a failure is kept
  // for FAIL_TTL so a dead service costs one slow request a minute, not one per
  // card. Resolves — never rejects — to { ok: true, local, district, state,
  // special } or { ok: false, why }.

  const contactCache = new Map();
  const CONTACT_CACHE_MAX = 64;
  // The road operators QLDTraffic names ahead of the council or the district —
  // its own order (lookup-view.js), because on those roads they are who runs it.
  const SPECIAL = new Set(['busway', 'transurban', 'private_owned']);

  function contactOf(c) {
    const web = str(c.website);
    const email = str(c.email);
    return {
      type: str(c.contact_type).toLowerCase(),
      name: str(c.display_name) || str(c.name),
      phone: /^[0-9 ()+-]{3,24}$/.test(str(c.phone_number)) ? str(c.phone_number) : '',
      email: /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email) ? email : '',
      // A value off a third-party service, so only an https address becomes a
      // link: anything else is not one.
      web: /^https:\/\/[^\s"'<>]+$/i.test(web) ? web : '',
    };
  }

  function digestContacts(list) {
    if (!Array.isArray(list)) throw new Error(UNREADABLE);
    const out = { ok: true, local: null, district: null, state: null, special: null };
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const v = contactOf(c);
      if (!v.name) continue;
      const slot = v.type === 'local' ? 'local' : v.type === 'district' ? 'district'
        : v.type === 'state' ? 'state' : SPECIAL.has(v.type) ? 'special' : null;
      if (slot && !out[slot]) out[slot] = v;
    }
    return out;
  }

  // `again` is Try again: a failure kept for FAIL_TTL is asked again at once.
  function contacts(lat, lon, again) {
    const k = `${(+lat).toFixed(4)},${(+lon).toFixed(4)}`;
    const had = contactCache.get(k);
    if (had && (!had.failedAt || (!again && Date.now() - had.failedAt < FAIL_TTL))) return had.p;
    const entry = { p: null, failedAt: 0 };
    entry.p = askJson(`${LOOKUP_URL}?lat=${(+lat).toFixed(6)}&lng=${(+lon).toFixed(6)}`)
      .then(digestContacts)
      .catch(e => { entry.failedAt = Date.now(); return { ok: false, why: reason(e) }; });
    contactCache.set(k, entry);
    while (contactCache.size > CONTACT_CACHE_MAX) contactCache.delete(contactCache.keys().next().value);
    return entry.p;
  }

  // Which of the lookup's contacts answers for a road of this class: the
  // operator QLDTraffic names first where it names one, then the TMR district
  // for a State-controlled road (or TMR's state centre where no district is
  // named), the council for a council road or an unrecorded one. A park, a
  // private road or another body's is not in QLDTraffic's directory: null.
  function pickContact(cls, c) {
    if (!c || !c.ok) return null;
    if (c.special) return c.special;
    if (cls === 'tmr') return c.district || c.state;
    if (cls === 'council' || cls === 'unknown') return c.local;
    return null;
  }

  function contactHtml(v) {
    if (!v) return '';
    const bits = [esc(v.name)];
    if (v.phone) bits.push(`<a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}">${esc(v.phone)}</a>`);
    if (v.email) bits.push(`<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>`);
    if (v.web) {
      bits.push(`<a href="${esc(v.web)}" target="_blank" rel="noopener"
        aria-label="${esc(`${v.name} — website, in a new tab`)}">website<span aria-hidden="true"> ↗</span></a>`);
    }
    return bits.join(' · ');
  }

  // ── The callout ───────────────────────────────────────────────────────────

  function calloutHtml(b, c) {
    const line = (html, cls) => `<span class="mn-pop-line${cls ? ' ' + cls : ''}">${html}</span><br>`;
    const out = [`<strong>${esc(bridgeTitle(b))}</strong><br>`];
    if (b.kind === 'tmr') {
      out.push(line(esc('State-controlled bridge — managed by Transport and Main Roads')));
      for (const r of b.roads) {
        out.push(line(esc(r.on && r.over ? `On and over ${r.name}` : r.over ? `Over ${r.name}` : `Carries ${r.name}`)));
      }
      const build = [b.cons, b.mtrl].filter(Boolean).join(', ');
      out.push(line(esc(`Structure ${b.struc || 'number not recorded'}${build ? ` · ${build}` : ''}`), 'txt-muted'));
    } else {
      // The kind of bridge, unless the title already is it (an unnamed one).
      const status = b.status && b.status !== 'Operational' ? ` (${b.status.toLowerCase()})` : '';
      if (b.name || status) out.push(line(esc(`${b.type}${status}`)));
      out.push(line(esc('Not on Transport and Main Roads’ register of State-controlled bridges, so managed with '
        + 'the road it carries — normally by the council.'), 'txt-muted'));
    }
    out.push(line(`${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}`));
    const cls = b.kind === 'tmr' ? 'tmr' : 'council';
    if (c === 'loading') {
      out.push(line('Looking up who to call…', 'txt-muted'));
    } else if (!c || !c.ok) {
      out.push(line(esc('Who to call is unavailable — QLDTraffic’s road lookup did not answer.'), 'txt-muted'));
    } else {
      // Introduced as what it is: on a road somebody else runs — the Second
      // Range Crossing's Ventia, a Transurban toll road, a busway — the lookup
      // names that operator, and it is not TMR's own district.
      const v = pickContact(cls, c);
      const who = !v ? '' : SPECIAL.has(v.type) ? 'The road’s operator:'
        : v.type === 'local' ? 'The council here:' : 'TMR here:';
      if (v) out.push(line(`<span class="txt-muted">${esc(who)}</span> ${contactHtml(v)}`));
    }
    const links = typeof stationMapLinkUrls === 'function'
      ? stationMapLinkUrls({ lat: b.lat, lon: b.lon, name: bridgeTitle(b) }) : null;
    if (links) {
      out.push(`<div class="mn-popup-actions pill-row"><a class="pill" href="${esc(links.google)}" target="_blank"
        rel="noopener" title="Opens the nearest Google Street View panorama; a bridge with no coverage opens the map at this location instead"
        >Google Street View ↗</a></div>`);
    }
    return out.join('\n');
  }

  function openCallout(b) {
    if (popup) { popup.remove(); popup = null; }
    popupBridge = b;
    let c = 'loading';
    // Content as a function, MapSurvey's reason: when the lookup lands,
    // Leaflet's own update() calls it again and re-lays the callout out.
    popup = L.popup({ maxWidth: 320, minWidth: 240, className: 'mn-bridge-popup' })
      .setLatLng([b.lat, b.lon])
      .setContent(() => calloutHtml(b, c))
      .openOn(map);
    contacts(b.lat, b.lon).then(r => {
      if (popupBridge !== b || !popup || !popup.isOpen()) return;
      c = r;
      popup.update();
    });
  }

  // ── At a point ────────────────────────────────────────────────────────────
  // The questions site-roads.js asks for a station or a picked point: the
  // nearest road within a radius and who manages it, and the nearest bridge
  // and whose it is. The layer's own sources, asked over a box a few hundred
  // metres across instead of over the view, and independent of the switch:
  // nothing is drawn or cached against the layer, and a failure here is not
  // the layer's failure — MapRoads.near()'s terms. Each resolves, never
  // rejects, to { ok: true, …, radiusM } or { ok: false, why }.

  function boxAround(lat, lon, r) {
    const dLat = r / 1000 / KM_PER_DEG_LAT, dLon = r / 1000 / kmPerDegLon(lat);
    return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
  }

  const ROAD_FIELDS = 'road_name_full,class,road_owner,road_maintainer,scr_indicator,ste_route_no,nat_route_no,'
                    + 'lga_name_left,lga_name_right,locality_left,locality_right,user_access';

  function roadOf(p, distM) {
    const owner = str(p.road_owner) || 'Unknown';
    const scr = str(p.scr_indicator).toUpperCase();
    return {
      name: str(p.road_name_full), cls: classOf(scr, owner), owner, scr,
      maint: str(p.road_maintainer), roadClass: str(p.class),
      routes: [str(p.nat_route_no), str(p.ste_route_no)].filter(Boolean),
      lga: str(p.lga_name_left) || str(p.lga_name_right),
      locality: str(p.locality_left) || str(p.locality_right),
      access: str(p.user_access), distM,
    };
  }

  async function roadNear(lat, lon, radiusM) {
    const r = Math.max(20, Math.min(1000, +radiusM || 150));
    const b = boxAround(lat, lon, r);
    try {
      const id = await resolve('roads');
      const params = new URLSearchParams({
        where: ROAD_WHERE,
        geometry: `${b.w},${b.s},${b.e},${b.n}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326', outSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: ROAD_FIELDS,
        returnGeometry: 'true',
        geometryPrecision: '6',
        resultRecordCount: '400',
        f: 'geojson',
      });
      const json = await askJson(`${ROADS_URL}/${id}/query?${params}`);
      if (!json || !Array.isArray(json.features)) throw new Error(UNREADABLE);
      let best = null;
      for (const f of json.features) {
        const lines = linesOf(f && f.geometry);
        if (!lines.length) continue;
        const d = Math.min(...lines.map(l => metresToLine([lat, lon], l)));
        if (d <= r && (!best || d < best.d)) best = { p: f.properties || {}, d };
      }
      return { ok: true, road: best ? roadOf(best.p, best.d) : null, radiusM: r };
    } catch (e) {
      return { ok: false, why: reason(e) };
    }
  }

  async function bridgeNear(lat, lon, radiusM) {
    const r = Math.max(20, Math.min(1000, +radiusM || 150));
    const b = boxAround(lat, lon, r);
    try {
      const [tid, qid] = await Promise.all([resolve('tmrBr'), resolve('qrtBr')]);
      const [t, q] = await Promise.all([askJson(bridgeQueryUrl('tmrBr', tid, b)),
                                        askJson(bridgeQueryUrl('qrtBr', qid, b))]);
      if (!t || !Array.isArray(t.features) || !q || !Array.isArray(q.features)) throw new Error(UNREADABLE);
      let best = null;
      for (const br of bridgesFrom(t, q)) {
        const d = metresToBridge([lat, lon], br);
        if (d <= r && (!best || d < best.d)) best = { br, d };
      }
      return { ok: true, bridge: best ? { ...best.br, distM: best.d } : null, radiusM: r };
    } catch (e) {
      return { ok: false, why: reason(e) };
    }
  }

  // ── Notes, the legend and the attribution ─────────────────────────────────

  function inViewCount(list) {
    const out = { all: 0, tmr: 0 };
    if (!map) return out;
    const v = map.getBounds();
    for (const b of list) {
      if (!v.contains([b.lat, b.lon])) continue;
      out.all++;
      if (b.kind === 'tmr') out.tmr++;
    }
    return out;
  }

  function bridgeNote() {
    switch (bridges.kind) {
      case 'zoom':    return ' Zoom in further for the bridges.';
      case 'loading': return ' Looking up the bridges…';
      case 'fail':    return ' Bridges unavailable — the Queensland spatial data service could not be reached.';
      case 'ok': {
        const c = inViewCount(bridges.entry ? bridges.entry.list : []);
        if (!c.all) return ' No bridges in view.';
        return ` <strong>${c.all}</strong> bridge${c.all === 1 ? '' : 's'} in view, <strong>${c.tmr}</strong> of them`
          + ' State-controlled' + (bridges.entry && bridges.entry.capped ? ' · more in view not drawn' : '')
          + '. Hover one for whose it is; click it for who to call.';
      }
      default: return '';
    }
  }

  function noteHtml() {
    if (!state.mapRoadOwners) return 'Road and bridge owners are hidden.';
    const r = roads || { kind: 'zoom', tier: null };
    switch (r.kind) {
      case 'zoom':
        return 'Zoom in to see who manages each road — the State-controlled roads from about 1:3,000,000, every '
             + 'road from about 1:150,000, and the bridges closer in. Queensland only.';
      case 'fail':
        return 'Road owners unavailable — the Queensland spatial data service could not be reached.';
      case 'loading':
        return 'Drawing who manages each road…';
      case 'ok':
        if (r.tier === 'state') {
          return 'State-controlled roads drawn — Transport and Main Roads. Zoom in past about 1:150,000 for every '
               + 'road’s owner and the bridges. Queensland only.';
        }
        return 'Every road coloured by who manages it.' + bridgeNote()
             + ' <em>What is here</em> on a road says whose it is and who to call. Queensland only.';
      default:
        return '';
    }
  }

  function setNote() {
    const el = document.getElementById('map-road-owners-note');
    if (el) el.innerHTML = noteHtml();
  }

  // Claimed while anything is drawn — MapSurvey's reading of an attribution.
  let attributed = false;
  function syncAttribution() {
    const want = !!(map && (overlay || bridgeLayer));
    if (!map || !map.attributionControl || want === attributed) return;
    if (want) map.attributionControl.addAttribution(ATTRIBUTION);
    else map.attributionControl.removeAttribution(ATTRIBUTION);
    attributed = want;
  }

  // The key, from CLASSES, so it cannot drift from what the image and the pins
  // were drawn with. Only what is on the map: the State's roads alone at a
  // regional scale; the pins once they are drawn.
  function legendHtml() {
    const items = [];
    if (overlay && drawnBox) {
      for (const k of drawnBox.tier === 'all' ? CLASS_ORDER : ['tmr']) {
        const c = CLASSES[k];
        items.push(`
    <span class="legend-item">
      <span class="legend-line legend-line-owner${c.dash ? ' is-dashed' : ''}${k === 'tmr' ? ' is-cased' : ''}"
            style="--road:${c.color}"></span>
      <span class="small">${esc(c.key)}</span>
    </span>`);
      }
    }
    if (bridgeLayer && drawn.length) {
      items.push(`
    <span class="legend-item">
      <span class="legend-bridge">${pinSvg('tmr', 15, 10)}</span>
      <span class="small">Bridge — State-controlled (Transport and Main Roads). Hover for its name; click for who to call</span>
    </span>
    <span class="legend-item">
      <span class="legend-bridge">${pinSvg('other', 15, 10)}</span>
      <span class="small">Bridge — not State-controlled: managed with its road, normally by the council</span>
    </span>`);
    }
    return items.join('');
  }

  function run() {
    runRoads();
    runBridges();
    setNote();
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function onZoom() { reproject(); }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
      }
      if (!m.getPane(BPANE)) {
        const pane = m.createPane(BPANE);
        pane.style.zIndex = BPANE_Z;
        // Belt and braces behind `interactive: false` on every pin — the
        // line map-roads.js's pane carries, for its reason.
        pane.style.pointerEvents = 'none';
      }
      m.on('moveend', sync);
      m.on('zoomend viewreset', onZoom);
      m.on('mousemove', onMapMove);
      m.on('click', onMapClick);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      if (map) {
        map.off('moveend', sync);
        map.off('zoomend viewreset', onZoom);
        map.off('mousemove', onMapMove);
        map.off('click', onMapClick);
      }
      clearRoads();
      clearBridges();
      if (map && attributed && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
      attributed = false;
      map = null;
      roadSeq++;
      bridgeSeq++;
    },

    sync,
    noteHtml,
    legendHtml,

    // Does the legend claim a key for this layer right now?
    active() { return !!(overlay || bridgeLayer); },

    // For site-roads.js: the class a segment is drawn in, the class's words,
    // what an owner code means, the road and the bridge at a point, how a
    // bridge names itself, and who to call.
    classOf,
    classInfo(cls) { return CLASSES[cls] || CLASSES.unknown; },
    ownerWords(code) { return (OWNER_CODE[code] || OWNER_CODE.Unknown).who; },
    roadNear,
    bridgeNear,
    bridgeTitle,
    roadWords,
    contacts,
    pickContact,
    contactHtml,

    // Off by default and remembered, on the catchments' terms rather than the
    // road parcels': it recolours every road on the map, which is a way of
    // reading the map somebody chooses, not one every session should open in —
    // and at a regional scale it draws, so the scale gate does not keep a cold
    // load free the way MapRoads' does. An operator who turns it on means it.
    setEnabled(on) {
      state.mapRoadOwners = !!on;
      try { localStorage.setItem('mn-road-owners', on ? 'on' : 'off'); } catch (_) {}
      if (!on) {
        clearTimeout(timer);
        roadSeq++;
        bridgeSeq++;
        clearRoads();
        clearBridges();
        roads = { kind: 'off', tier: null };
        bridges = { kind: 'zoom', entry: null };
        setNote();
        return;
      }
      roads = { kind: tierNow() ? 'loading' : 'zoom', tier: tierNow() };
      setNote();
      sync();
    },
  };
})();
if (typeof window !== 'undefined') window.MapRoadOwners = MapRoadOwners;
