// MegaNet — map-feeds.js
//
//   MapFeeds   Open-data layers from government map services, drawn over the
//              Stations map from one list (FEEDS) instead of a file each:
//              power lines and pipelines (Geoscience Australia), Energex and
//              Ergon's overhead lines and underground cables, past flood
//              outlines and dam-failure flood areas, water seen from
//              satellites since 1986, the State's river gauges, cultural
//              heritage groups, protected areas, biosecurity zones and the
//              weed survey (EPIC #291). And the same services asked about one
//              place: the "Open data here" section on the station card and on
//              the What is here card.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr and termHtml; across to
// app.js for rerenderMapLegend. All from inside its own functions, so this
// file's position among the modules is free.
//
// ── Why one list ────────────────────────────────────────────────────────────
// Every layer here is somebody else's map service drawing its own picture:
// an ArcGIS MapServer's `export`, or a WMS `GetMap`. What differs between them
// is data — an address, the sublayers to show, a scale, who to credit — so a
// new one is an entry in FEEDS and its words, not a module. The two kinds that
// are not a picture are handled here too: Energex and Ergon publish only
// feature services (no `export`), so their lines are asked for as vectors, one
// request per company per view, and drawn on this layer's own canvas.
//
// MapContours' pattern for the pictures: one L.imageOverlay per feed, over a
// padded box, so a pan inside it costs nothing; preloaded, so a pan swaps a
// finished image in; a failure stops asking for FAIL_TTL and says so.
//
// ── What the layers are not ─────────────────────────────────────────────────
// None of this is for finding a cable or a pipe before digging. Every source
// says so, and so does every note here: Before You Dig Australia (1100) is.
//
// ── Where they sit ──────────────────────────────────────────────────────────
// Areas (floods, parks, zones, weeds, water) at 327, between the catchments
// (325) and the wind regions (330); lines and points at 333, between the polar
// plot (332) and the contours (335); the power network's canvas at 337,
// between the lots (336) and the road parcels (338). Nothing takes the
// pointer: the What is here card answers "what is this?" for a point.
const MapFeeds = (function () {
  const GA_ELEC  = 'https://services.ga.gov.au/gis/rest/services/Electricity_Infrastructure/MapServer';
  const GA_PIPES = 'https://services.ga.gov.au/gis/rest/services/Oil_Gas_Pipelines/MapServer';
  const QLD      = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services';
  const FLOOD    = `${QLD}/InlandWaters/FloodLines/MapServer`;
  const GAUGES   = `${QLD}/InlandWaters/GroundAndSurfaceWaterMonitoring/MapServer`;
  const HERITAGE = `${QLD}/Boundaries/CulturalHeritageBoundaries/MapServer`;
  const PARKS    = `${QLD}/Environment/ParksTerrestrialProtectedAreas/MapServer`;
  const BIO      = `${QLD}/Farming/Biosecurity/MapServer`;
  const CAPAD    = 'https://gis.environment.gov.au/gispubmap/rest/services/ogc_services/CAPAD/MapServer';
  const DEA      = 'https://ows.dea.ga.gov.au/';
  const ENERGEX  = 'https://services.arcgis.com/bfVzktoY0OhzQCDj/ArcGIS/rest/services/Network_Energex/FeatureServer';
  const ERGON    = 'https://services.arcgis.com/33eHbTVqo7gtiCE8/ArcGIS/rest/services/Network_Extract/FeatureServer';
  const ALA      = 'https://api.ala.org.au/occurrences/occurrences/search';
  const TIDES    = 'https://apps.des.qld.gov.au/data-sets/storm-tides/tide-7dayopdata.csv';
  const BCC_PIPES  = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/Stormwater_Pipe_Existing/FeatureServer';
  const BCC_DRAINS = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/Stormwater_Surface_Drain_Existing/FeatureServer';
  const UW         = 'https://services2.arcgis.com/tQg86iShPXJPWQWw/ArcGIS/rest/services';
  const MW         = 'https://services5.arcgis.com/ZSYwjtv8RKVhkXIL/arcgis/rest/services';
  const DGA_WMS    = 'https://data.gov.au/geoserver/wms';
  // The weed records asked of the Atlas: Queensland's own weed records
  // (QWeeds, dr18218) and any record of a Weed of National Significance
  // (the WoNS list, dr823) from anyone — iNaturalist, councils, herbaria.
  const ALA_WEEDS = 'data_resource_uid:"dr18218" OR species_list_uid:"dr823"';

  const WEED_GROUP = 200;      // the survey's "Weed distribution" group in BIO
  const STORE_KEY  = 'mn-map-feeds';
  const WEED_KEY   = 'mn-map-feeds-weed';
  const NOT_FOR_DIGGING = 'A guide only — never for finding a cable or pipe before digging. Ring Before You Dig Australia (1100).';

  const GROUPS = [
    { id: 'utilities', title: 'Power and pipelines' },
    { id: 'flood',     title: 'Floods and water' },
    { id: 'land',      title: 'Land and access' },
    { id: 'bio',       title: 'Biosecurity and weeds' },
    { id: 'pipes',     title: 'Water, sewer and drainage pipes' },
  ];

  // ── The list ────────────────────────────────────────────────────────────
  // kind    'arcgis' (MapServer export), 'wms' (GetMap) or 'network' (the
  //         Energex and Ergon feature services, drawn here).
  // layers  the sublayers drawn; the weed survey's is the chosen species.
  // pane    'areas' or 'lines' — see the header.
  // minZoom below it nothing is asked; the note says to zoom in.
  // meaning the words on hover and in the words fold — what it shows here.
  const FEEDS = [
    { id: 'ga-power', group: 'utilities', kind: 'arcgis', url: GA_ELEC, layers: [2, 0, 1], pane: 'lines',
      minZoom: 5, opacity: 0.9,
      label: 'High-voltage power lines and substations (Australia)',
      meaning: 'The national transmission network: the big power lines between power stations and towns, with substations and major power stations. Not the local poles and wires in a street — those are Energex and Ergon’s, below.',
      source: { by: 'Geoscience Australia', licence: 'CC BY 4.0', page: 'https://ecat.ga.gov.au/geonetwork/srv/eng/catalog.search#/metadata/3844c10c-ecfd-44a9-94f5-29222bb6d36d' } },
    { id: 'ga-pipes', group: 'utilities', kind: 'arcgis', url: GA_PIPES, layers: [1, 0], pane: 'lines',
      minZoom: 5, opacity: 0.9,
      label: 'Gas and oil pipelines (Australia)',
      meaning: 'High-pressure gas and oil pipelines across Australia, as the pipeline companies report them. Corridors rather than surveyed lines in Western Australia and the Northern Territory.',
      source: { by: 'Geoscience Australia (data from Petrosys GPinfo)', licence: 'CC BY 4.0', page: 'https://www.data.gov.au/data/dataset/oil-and-gas-pipelines-database' } },
    { id: 'qld-network', group: 'utilities', kind: 'network', pane: 'net', minZoom: 11,
      label: 'Power network, overhead and underground (Qld)',
      meaning: 'Energex (south-east Queensland) and Ergon (the rest of Queensland) power lines: sub-transmission from zoom 11, high voltage from zoom 14, the low-voltage street network from zoom 16. A solid line is overhead; a dashed line is an underground cable. Energex says its records have gaps.',
      source: { by: 'Energex and Ergon Energy (Energy Queensland)', licence: 'published by the companies as a guide only', page: 'https://www.data.qld.gov.au/dataset/ergon-energy-electrical-distribution-network-series' } },

    { id: 'qld-flood-history', group: 'flood', kind: 'arcgis', url: FLOOD, layers: [12, 13, 14, 15, 16, 17, 18, 19, 20],
      pane: 'areas', minZoom: 7, opacity: 0.55,
      label: 'Past flood outlines (Qld)',
      meaning: 'How far some real floods reached: Brisbane and Bremer 1974; Bundaberg 2010 and 2013; Queensland towns January and April 2011; south-west towns 2012; the Fitzroy and the Logan–Albert 2017; western Queensland 2019. Mapped from aerial photos and council records — only those floods, only where they were mapped.',
      source: { by: 'State of Queensland', licence: 'CC BY 4.0', page: 'https://www.qld.gov.au/emergency/dealing-disasters/disaster-types/flood/for-councils-and-flood-practitioners/flood-data-and-resources/floodcheck-queensland-application' } },
    { id: 'qld-dam-flood', group: 'flood', kind: 'arcgis', url: FLOOD, layers: [53, 52, 51], pane: 'areas',
      minZoom: 7, opacity: 0.45,
      label: 'Dam-failure flood areas (Qld)',
      meaning: 'Modelled flooding below the dams the State lists because a failure would put people at risk: a “sunny day” failure (the dam fails with no flood coming), the largest possible flood without a failure, and the largest possible flood with one. Worst cases, not forecasts.',
      source: { by: 'State of Queensland', licence: 'CC BY 4.0', page: 'https://www.data.qld.gov.au/dataset/probable-maximum-flood-extent-referable-dams-queensland-series' } },
    { id: 'dea-water', group: 'flood', kind: 'wms', url: DEA, wmsLayer: 'ga_ls_wo_fq_myear_3', pane: 'areas',
      minZoom: 6, opacity: 0.7,
      label: 'Water seen from satellites since 1986 (Australia)',
      meaning: 'How often Landsat satellites have seen water on each 30 m patch of ground since 1986, from rarely (pale) to nearly always (deep blue). Ground that is wet now and then is ground that floods, even where no flood study has been done.',
      source: { by: 'Geoscience Australia — Digital Earth Australia', licence: 'CC BY 4.0', page: 'https://knowledge.dea.ga.gov.au/data/product/dea-water-observations-statistics-landsat/' } },
    { id: 'qld-gauges', group: 'flood', kind: 'arcgis', url: GAUGES, layers: [13, 14], pane: 'lines',
      minZoom: 6, opacity: 1,
      label: 'State river gauges (Qld)',
      meaning: 'The Queensland Government’s own stream gauging stations, open and closed — other people’s river gauges, beside ours. Their readings are on the State’s Water Monitoring Information Portal.',
      source: { by: 'State of Queensland', licence: 'CC BY 4.0', page: 'https://water-monitoring.information.qld.gov.au/' } },

    { id: 'qld-heritage', group: 'land', kind: 'arcgis', url: HERITAGE, layers: [5, 1], pane: 'areas',
      minZoom: 5, opacity: 0.5,
      label: 'Cultural heritage groups (Qld)',
      meaning: 'The Aboriginal and Torres Strait Islander parties and bodies for each area under the State’s cultural heritage laws — the people to talk to before work that disturbs ground. The What is here card names them for a point.',
      source: { by: 'State of Queensland (Aboriginal and Torres Strait Islander Partnerships)', licence: 'CC BY 4.0', page: 'https://www.dsdsatsip.qld.gov.au/our-work/aboriginal-torres-strait-islander-cultural-heritage' } },
    { id: 'qld-parks', group: 'land', kind: 'arcgis', url: PARKS, layers: [10, 15, 25], pane: 'areas',
      minZoom: 5, opacity: 0.5,
      label: 'National parks and State forests (Qld)',
      meaning: 'Queensland’s protected areas and State forests, and its world heritage areas. Working in one usually needs a permit from the Parks and Wildlife Service.',
      source: { by: 'State of Queensland', licence: 'CC BY 4.0', page: 'https://www.data.qld.gov.au/dataset/protected-areas-of-queensland-series' } },
    { id: 'capad', group: 'land', kind: 'arcgis', url: CAPAD, layers: [0, 1], pane: 'areas',
      minZoom: 4, opacity: 0.45,
      label: 'Protected areas (Australia)',
      meaning: 'Every protected area in Australia — national parks, reserves, Indigenous Protected Areas and private conservation land — from the national list (CAPAD), as at 30 June 2024. For outside Queensland, or for land the State list leaves out.',
      source: { by: 'Australian Government (DCCEEW)', licence: 'CC BY 4.0', page: 'https://www.dcceew.gov.au/environment/land/nrs/science/capad' } },

    // Only the zones that mark out a place: the banana, sugar cane, grape and
    // papaya zones and the cattle tick area each cover most of the State, and
    // drawn they tint everything. The card still names every zone a place is in.
    { id: 'qld-biosecurity', group: 'bio', kind: 'arcgis', url: BIO, layers: [65, 75, 80, 35, 95],
      pane: 'areas', minZoom: 5, opacity: 0.45,
      label: 'Fire ant, electric ant and cattle tick zones (Qld)',
      meaning: 'The State’s fire ant and electric ant biosecurity zones, the Asian honey bee area and the cattle tick line. Inside a fire ant zone, soil, mulch, gravel and hay may not be moved off a site without meeting the rules. The station card names every zone a site is in, the banana, sugar cane, grape and papaya ones too.',
      source: { by: 'State of Queensland (Department of Primary Industries)', licence: 'CC BY 4.0', page: 'https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/biosecurity/plants/invasive/fire-ants' } },
    { id: 'qld-fences', group: 'bio', kind: 'arcgis', url: BIO, layers: [21, 23, 24, 25], pane: 'lines',
      minZoom: 4, opacity: 0.9,
      label: 'Wild dog and rabbit fences (Qld)',
      meaning: 'The State’s barrier fences: the wild dog barrier fence, its check fences and the rabbit fence. A gate in one is to be closed behind you.',
      source: { by: 'State of Queensland (Department of Primary Industries)', licence: 'CC BY 4.0', page: 'https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/biosecurity/animals/invasive/barrier-fences' } },
    { id: 'qld-weeds', group: 'bio', kind: 'arcgis', url: BIO, layers: [], weed: true, pane: 'areas',
      minZoom: 4, opacity: 0.55,
      label: 'Weed survey, one weed at a time (Qld)',
      meaning: 'Where one invasive plant was found in the State’s 2022–23 survey, in squares about 17 km across — so it says the weed is somewhere in that square, not at a site. Pick the weed below. The What is here card lists every surveyed weed in a point’s square.',
      source: { by: 'State of Queensland (Department of Primary Industries)', licence: 'CC BY 4.0', page: 'https://daf.qld.gov.au/business-priorities/biosecurity/invasive-plants-animals/pest-mapping/distribution-maps' } },
    { id: 'ala-weeds', group: 'bio', kind: 'ala', pane: 'lines', minZoom: 12,
      label: 'Weed sightings, exact (Australia)',
      meaning: 'Each place a weed was recorded: Queensland’s own weed records, and anyone’s record of a Weed of National Significance (iNaturalist, councils, herbaria), from the Atlas of Living Australia. A dot is one record, darker when recent. Shown from zoom 12; the station card lists those within 2 km.',
      source: { by: 'Atlas of Living Australia (records from Biosecurity Queensland, iNaturalist and others)', licence: 'each record’s own, mostly CC BY', page: 'https://www.ala.org.au/biosecurity/' } },
    // ── Pipes (#294). Each `part` is one hosted feature layer, asked for the
    // view (one request a part) and drawn here in its colour; `box` is where
    // the owner has any, so a view or a card elsewhere asks nothing.
    // Left out on their licences: Barwon Water (CC BY-NC-ND) and the Water
    // Corporation, WA (personal or internal use only, no passing on, no AI).
    { id: 'bcc-stormwater', group: 'pipes', kind: 'pipes', pane: 'net', minZoom: 15,
      box: { w: 152.66, e: 153.22, s: -27.67, n: -27.02 },
      parts: [
        { url: `${BCC_PIPES}/0`,  colour: '#00838f', weight: 2.2, words: 'Stormwater pipe' },
        { url: `${BCC_DRAINS}/0`, colour: '#00838f', weight: 2.2, dash: '5 4', words: 'Open drain or channel' },
      ],
      label: 'Stormwater pipes and drains (Brisbane)',
      meaning: 'Brisbane City Council’s stormwater network as built: the pipes that carry rain off streets and roofs to the creeks, and the open drains and channels. Where a flood backs up a pipe, the street floods before the river does. Not every pipe in it is the council’s. From zoom 15.',
      source: { by: 'Brisbane City Council', licence: 'CC BY 4.0', page: 'https://www.data.qld.gov.au/dataset/stormwater-pipe-existing' } },
    { id: 'unitywater', group: 'pipes', kind: 'pipes', pane: 'net', minZoom: 15,
      box: { w: 152.6, e: 153.2, s: -27.45, n: -26.1 },
      parts: [
        { url: `${UW}/UWPublicAccessWaterInfrastructureLayers/FeatureServer/10`, colour: '#1565c0', weight: 2, words: 'Water main' },
        { url: `${UW}/UWPublicAccessSewerInfrastructureLayers/FeatureServer/11`, colour: '#795548', weight: 2, words: 'Sewer main (gravity)' },
        { url: `${UW}/UWPublicAccessSewerInfrastructureLayers/FeatureServer/12`, colour: '#795548', weight: 2, dash: '5 4', words: 'Sewer main (pressure)' },
        { url: `${UW}/UWPublicAccessRecycledWaterInfrastructureLayers/FeatureServer/9`, colour: '#7b1fa2', weight: 2, words: 'Recycled water main' },
      ],
      label: 'Water, sewer and recycled water mains (Unitywater)',
      meaning: 'Unitywater’s mains across the Moreton Bay, Sunshine Coast and Noosa council areas: drinking water, sewer (flowing by gravity, or pumped under pressure) and recycled water. A guide only — Unitywater publishes it as public-access information without stating a licence. From zoom 15.',
      source: { by: 'Unitywater', licence: 'published as public-access information; no licence stated', page: 'https://datahub.moretonbay.qld.gov.au/maps/moretonbay::unitywater-public-access-sewer-infrastructure' } },
    { id: 'melbourne-water', group: 'pipes', kind: 'pipes', pane: 'net', minZoom: 11,
      box: { w: 144.3, e: 146.3, s: -38.5, n: -37.2 },
      parts: [
        { url: `${MW}/Water_Supply_Main_Pipelines/FeatureServer/0`, colour: '#1565c0', weight: 3, words: 'Water supply main' },
        { url: `${MW}/Sewerage_Network_Mains/FeatureServer/0`, colour: '#795548', weight: 3, words: 'Sewerage main' },
      ],
      label: 'Water and sewerage trunk mains (Melbourne Water)',
      meaning: 'Melbourne Water’s big pipes: the water supply mains that carry water from the reservoirs to the city’s retailers, and the sewerage mains that carry sewage to the treatment plants. Not the street pipes. From zoom 11.',
      source: { by: 'Melbourne Water', licence: 'CC BY 4.0', page: 'https://data-melbournewater.opendata.arcgis.com/' } },
    { id: 'vic-drainage', group: 'pipes', kind: 'wms', url: DGA_WMS, pane: 'lines', minZoom: 13, opacity: 0.95,
      box: { w: 143.4, e: 145.4, s: -38.6, n: -36.8 },
      wmsLayer: 'ballarat-drainage-pipes:ckan_0f31544d_dc70_4b83_b4fb_2d72e97d82f5,surf-coast-shire-drainage-pipes:ckan_bf1baf60_4e07_4445_a33c_0cc69ec747ab,drainagepipes:ckan_8864509d_f46c_4c91_a4d7_85e1f71359d1',
      label: 'Council drainage pipes (Ballarat, Surf Coast, Mitchell — Vic)',
      meaning: 'The stormwater drainage pipes three Victorian councils publish: the City of Ballarat, Surf Coast Shire and Mitchell Shire. Other councils have not published theirs. From zoom 13.',
      source: { by: 'City of Ballarat, Surf Coast Shire and Mitchell Shire, through data.gov.au', licence: 'CC BY 3.0 AU', page: 'https://data.gov.au/data/dataset/ballarat-drainage-pipes' } },
    { id: 'qld-tides', group: 'flood', kind: 'tide', pane: 'pins', minZoom: 5,
      label: 'Storm tide gauges, latest reading (Qld)',
      meaning: 'The State’s storm tide gauges along the coast, each with its latest reading: the sea level measured, the tide predicted for that time, and the difference — the surge a storm or flood is adding. Heights are above each gauge’s own tide datum (usually the lowest tide), not AHD. In calm weather a gauge may only report once a day. Hover a pin for its figures.',
      source: { by: 'State of Queensland (Department of the Environment, Tourism, Science and Innovation)', licence: 'CC BY 4.0', page: 'https://www.data.qld.gov.au/dataset/coastal-data-system-near-real-time-storm-tide-data' } },
  ];
  const byId = Object.fromEntries(FEEDS.map(f => [f.id, f]));

  const PANES = {
    areas: { name: 'mnFeedAreas', z: 327 },
    lines: { name: 'mnFeedLines', z: 333 },
    net:   { name: 'mnFeedNet',   z: 337 },
    // The tide pins take the pointer, for their figures on hover: over the
    // survey marks (345) and the bridges (346), under the peaks (348).
    pins:  { name: 'mnFeedPins',  z: 347, pointer: true },
  };

  // The power network's lines, drawn here. Voltage class by colour, overhead
  // solid and underground dashed — the one difference the layer exists for.
  const NET_SERVICES = [
    { name: 'Energex', url: ENERGEX,
      layers: { sub: [4, 5, 6, 7, 8, 9], hv: [10, 11], lv: [12, 13] }, cable: new Set([5, 7, 9, 11, 13]) },
    { name: 'Ergon', url: ERGON,
      layers: { sub: [1, 2], hv: [4, 5], lv: [6, 7] }, cable: new Set([2, 5, 7]) },
  ];
  const NET_CLASS = {
    sub: { zoom: 11, colour: '#7b2cbf', weight: 3,   words: 'Sub-transmission (33–132 kV)' },
    hv:  { zoom: 14, colour: '#d9480f', weight: 2.2, words: 'High voltage (11–22 kV)' },
    lv:  { zoom: 16, colour: '#e0a800', weight: 1.6, words: 'Low voltage (street supply)' },
  };

  const PAD         = 0.3;
  const MAX_PX      = 2048;
  const DEBOUNCE_MS = 250;
  const TIMEOUT_MS  = 25000;
  const FAIL_TTL    = 60000;

  // ── What is on ──────────────────────────────────────────────────────────
  // Off by default and remembered, as the property boundaries are: an operator
  // who turns the fire ant zones on wants them there tomorrow.
  function load(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private window */ } }

  const on = new Set((load(STORE_KEY, []) || []).filter(id => byId[id]));
  let weedId = Number(load(WEED_KEY, 0)) || 0;   // the chosen species' sublayer; 0 until the list is read
  let weeds = null, weedsAsking = null;          // [{ id, name }] from the service

  let map = null, timer = null;
  const drawn = {};                              // feed id → { overlay, box, seq, failedAt, note, url }

  // ── The 3-D view (map-3d.js, #296) ──────────────────────────────────────
  // It drapes the pictures from tiles() and draws the lines, dots and pins
  // from shapes() — what this file already drew in 2-D, never asked again.
  // Told when either changes; a no-op while 3-D is shut.
  let shapesTimer = null;
  function tell3D(what) {
    if (typeof Map3D === 'undefined') return;
    if (what === 'drapes' && Map3D.cadastreChanged) { Map3D.cadastreChanged(); return; }
    if (!Map3D.feedsChanged) return;
    clearTimeout(shapesTimer);
    shapesTimer = setTimeout(() => Map3D.feedsChanged(), 50);
  }

  function slot(id) { return drawn[id] || (drawn[id] = { overlay: null, box: null, seq: 0, failedAt: 0, note: 'off' }); }

  // ── Asking ──────────────────────────────────────────────────────────────

  async function askJson(url, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...(init || {}), signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'map service error');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // The survey's weeds, by name, once a page load. The service lists 120-odd
  // species as sublayers of one group; the list here is whatever it says now.
  function weedList() {
    if (weeds) return Promise.resolve(weeds);
    if (weedsAsking) return weedsAsking;
    weedsAsking = askJson(`${BIO}?f=json`).then(json => {
      weeds = ((json && json.layers) || [])
        .filter(l => l.parentLayerId === WEED_GROUP && !l.subLayerIds)
        .map(l => ({ id: l.id, name: String(l.name || '').trim() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!weeds.some(w => w.id === weedId)) {
        const lantana = weeds.find(w => /^lantana/i.test(w.name));
        weedId = (lantana || weeds[0] || { id: 0 }).id;
      }
      return weeds;
    }).catch(() => { weedsAsking = null; return []; });
    return weedsAsking;
  }

  function layersOf(f) { return f.weed ? (weedId ? [weedId] : []) : (f.layers || []); }
  const drawKey = f => (f.kind === 'wms' ? f.wmsLayer : layersOf(f).join(','));

  // ── Drawing the pictures ────────────────────────────────────────────────

  function projectBox(bounds) {
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    return { sw, ne };
  }

  function imageUrl(f, bounds, w, h) {
    const { sw, ne } = projectBox(bounds);
    if (f.kind === 'wms') {
      const p = new URLSearchParams({
        service: 'WMS', version: '1.3.0', request: 'GetMap', layers: f.wmsLayer, styles: '',
        crs: 'EPSG:3857', bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
        width: String(w), height: String(h), format: 'image/png', transparent: 'true',
      });
      return `${f.url}?${p}`;
    }
    const p = new URLSearchParams({
      f: 'image', format: 'png32', transparent: 'true', dpi: '96',
      bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`, bboxSR: '3857', imageSR: '3857',
      size: `${w},${h}`, layers: `show:${layersOf(f).join(',')}`,
    });
    return `${f.url}/export?${p}`;
  }

  function clear(id) {
    const d = drawn[id];
    if (!d) return;
    if (d.overlay) {
      d.overlay.remove();
      if (map && map.attributionControl && byId[id].kind !== 'wms') map.attributionControl.removeAttribution(byId[id].source.by);
    }
    d.overlay = null;
    d.box = null;
    d.seq++;
    if (['ala', 'tide', 'pipes'].includes(byId[id].kind)) tell3D('shapes');
  }

  function setNote(id, kind) {
    slot(id).note = kind;
    const el = document.getElementById(`mn-feed-note-${id}`);
    if (el) el.innerHTML = noteHtml(id);
  }

  // DEA's WMS hands over at most 512 px a picture, so it is drawn as
  // Leaflet's own WMS tiles (256 px) rather than one padded image.
  function runTiles(f) {
    const d = slot(f.id);
    if (map.getZoom() < f.minZoom) { clear(f.id); setNote(f.id, 'zoom'); return; }
    if (f.box && !boxMeets(f, map.getBounds())) { clear(f.id); setNote(f.id, 'away'); return; }
    if (d.overlay) { if (d.note !== 'fail') setNote(f.id, 'ok'); return; }
    let bad = 0, good = 0;
    d.overlay = L.tileLayer.wms(f.url, {
      layers: f.wmsLayer, styles: '', format: 'image/png', transparent: true, version: '1.3.0',
      pane: PANES[f.pane].name, opacity: f.opacity, crossOrigin: 'anonymous', interactive: false,
      attribution: f.source.by,
    });
    d.overlay.on('tileload', () => { good++; if (d.note !== 'ok') { setNote(f.id, 'ok'); rerenderMapLegend(); } });
    d.overlay.on('tileerror', () => { bad++; if (!good && bad >= 4) setNote(f.id, 'fail'); });
    d.overlay.addTo(map);
    d.url = f.url;
    setNote(f.id, 'loading');
  }

  function runPicture(f) {
    if (f.kind === 'wms') { runTiles(f); return; }
    const d = slot(f.id);
    if (map.getZoom() < f.minZoom) { clear(f.id); setNote(f.id, 'zoom'); return; }
    if (f.weed && !weedId) {
      setNote(f.id, 'loading');
      weedList().then(() => { if (on.has(f.id)) sync(); });
      return;
    }
    const want = drawKey(f);
    if (d.overlay && d.box && d.box.zoom === map.getZoom() && d.box.layers === want
        && d.box.bounds.contains(map.getBounds())) { setNote(f.id, 'ok'); return; }
    if (Date.now() - d.failedAt < FAIL_TTL) { clear(f.id); setNote(f.id, 'fail'); return; }

    const mine = ++d.seq;
    const bounds = map.getBounds().pad(PAD);
    const px = map.getSize();
    let w = Math.round(px.x * (1 + 2 * PAD)), h = Math.round(px.y * (1 + 2 * PAD));
    const over = Math.max(w, h) / MAX_PX;
    if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }
    const url = imageUrl(f, bounds, w, h);
    setNote(f.id, 'loading');

    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => { img.src = ''; }, TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(t);
      if (mine !== d.seq || !map || !on.has(f.id)) return;
      if (d.overlay) d.overlay.remove();
      else if (map.attributionControl) map.attributionControl.addAttribution(f.source.by);
      d.overlay = L.imageOverlay(url, bounds, { pane: PANES[f.pane].name, opacity: f.opacity, interactive: false }).addTo(map);
      d.box = { bounds, zoom: map.getZoom(), layers: want };
      d.url = url;
      setNote(f.id, 'ok');
      rerenderMapLegend();
    };
    img.onerror = () => {
      clearTimeout(t);
      if (mine !== d.seq || !map) return;
      d.failedAt = Date.now();
      clear(f.id);
      setNote(f.id, 'fail');
      rerenderMapLegend();
    };
    img.src = url;
  }

  // ── Drawing the power network ───────────────────────────────────────────

  let netLayer = null, netRenderer = null;

  function netClassesAt(z) { return Object.keys(NET_CLASS).filter(k => z >= NET_CLASS[k].zoom); }

  function netClassOf(svc, layerId) {
    for (const k of Object.keys(svc.layers)) if (svc.layers[k].includes(layerId)) return k;
    return null;
  }

  function netQuery(svc, ids, bounds, extra) {
    const defs = {};
    for (const id of ids) defs[id] = '1=1';
    const p = new URLSearchParams({
      layerDefs: JSON.stringify(defs), inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      returnGeometry: 'true', f: 'json', ...(extra || {}),
    });
    if (bounds) {
      p.set('geometry', `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`);
      p.set('geometryType', 'esriGeometryEnvelope');
    }
    return askJson(`${svc.url}/query?${p}`);
  }

  function runNetwork(f) {
    const d = slot(f.id);
    const z = map.getZoom();
    if (z < f.minZoom) { clearNet(); setNote(f.id, 'zoom'); return; }
    const classes = netClassesAt(z);
    const want = classes.join(',');
    if (netLayer && d.box && d.box.zoom === z && d.box.layers === want && d.box.bounds.contains(map.getBounds())) {
      setNote(f.id, d.cut ? 'cut' : 'ok');
      return;
    }
    if (Date.now() - d.failedAt < FAIL_TTL) { clearNet(); setNote(f.id, 'fail'); return; }
    const mine = ++d.seq;
    const bounds = map.getBounds().pad(PAD);
    // Thin the lines to about a pixel: a street's cable needs no centimetres.
    const degPerPx = (bounds.getEast() - bounds.getWest()) / (map.getSize().x * (1 + 2 * PAD));
    setNote(f.id, 'loading');
    const asks = NET_SERVICES.map(svc => {
      const ids = classes.flatMap(k => svc.layers[k]);
      return netQuery(svc, ids, bounds, {
        outFields: 'OBJECTID', geometryPrecision: '6', maxAllowableOffset: String(degPerPx),
      }).then(json => ({ svc, json }), () => ({ svc, json: null }));
    });
    Promise.all(asks).then(results => {
      if (mine !== d.seq || !map || !on.has(f.id)) return;
      if (results.every(r => !r.json)) { d.failedAt = Date.now(); clearNet(); setNote(f.id, 'fail'); rerenderMapLegend(); return; }
      if (!netRenderer) netRenderer = L.canvas({ pane: PANES.net.name });
      const group = L.layerGroup();
      let cut = false;
      for (const { svc, json } of results) {
        if (!json) continue;
        for (const lyr of json.layers || []) {
          if (lyr.exceededTransferLimit) cut = true;
          const k = netClassOf(svc, lyr.id);
          if (!k) continue;
          const c = NET_CLASS[k];
          const under = svc.cable.has(lyr.id);
          for (const ft of lyr.features || []) {
            const paths = (ft.geometry && ft.geometry.paths) || [];
            if (!paths.length) continue;
            L.polyline(paths.map(p => p.map(([x, y]) => [y, x])), {
              renderer: netRenderer, interactive: false, color: c.colour, weight: c.weight,
              opacity: 0.95, dashArray: under ? '6 5' : null, lineCap: 'butt',
            }).addTo(group);
          }
        }
      }
      clearNet(true);
      netLayer = group.addTo(map);
      tell3D('shapes');
      if (map.attributionControl) map.attributionControl.addAttribution(f.source.by);
      d.box = { bounds, zoom: z, layers: want };
      d.cut = cut;
      setNote(f.id, cut ? 'cut' : 'ok');
      rerenderMapLegend();
    });
  }

  function clearNet(keepSeq) {
    if (netLayer) {
      netLayer.remove();
      if (map && map.attributionControl) map.attributionControl.removeAttribution(byId['qld-network'].source.by);
    }
    netLayer = null;
    tell3D('shapes');
    const d = drawn['qld-network'];
    if (d) { d.box = null; if (!keepSeq) d.seq++; }
  }

  // ── Drawing points we are handed ────────────────────────────────────────
  // The Atlas's weed records (a dot each) and the storm tide gauges (a pin
  // each, its latest reading on hover). Both live in d.overlay as a layer
  // group, so clear(), active() and the key treat them as the pictures.

  let alaRenderer = null;
  // The Atlas refuses a page of more than 100 records (503), so a view or a
  // card asks for up to ALA_PAGES pages of ALA_PAGE, the rest in parallel once
  // the first has said how many there are.
  const ALA_PAGE = 100, ALA_PAGES = 3, ALA_MAX = ALA_PAGE * ALA_PAGES;

  function alaPages(extra) {
    const page = i => askJson(alaParams({ ...extra, pageSize: String(ALA_PAGE), startIndex: String(i * ALA_PAGE) }));
    return page(0).then(first => {
      const total = (first && first.totalRecords) || 0;
      const more = Math.min(ALA_PAGES, Math.ceil(total / ALA_PAGE)) - 1;
      if (more <= 0) return first;
      return Promise.all(Array.from({ length: more }, (_, i) => page(i + 1).catch(() => null))).then(rest => ({
        totalRecords: total,
        occurrences: [first, ...rest].flatMap(j => (j && j.occurrences) || []),
      }));
    });
  }

  function alaParams(extra) {
    const p = new URLSearchParams({ q: '*:*', fq: ALA_WEEDS, facet: 'false',
      fl: 'scientificName,vernacularName,year,decimalLatitude,decimalLongitude', ...(extra || {}) });
    return `${ALA}?${p}`;
  }

  function runAla(f) {
    const d = slot(f.id);
    if (map.getZoom() < f.minZoom) { clear(f.id); setNote(f.id, 'zoom'); return; }
    if (d.overlay && d.box && d.box.zoom <= map.getZoom() && d.box.bounds.contains(map.getBounds())) {
      setNote(f.id, d.cut ? 'cut' : 'ok');
      return;
    }
    if (Date.now() - d.failedAt < FAIL_TTL) { clear(f.id); setNote(f.id, 'fail'); return; }
    const mine = ++d.seq;
    const b = map.getBounds().pad(PAD);
    const ring = [[b.getWest(), b.getSouth()], [b.getEast(), b.getSouth()], [b.getEast(), b.getNorth()],
                  [b.getWest(), b.getNorth()], [b.getWest(), b.getSouth()]].map(([x, y]) => `${x.toFixed(5)} ${y.toFixed(5)}`).join(',');
    setNote(f.id, 'loading');
    alaPages({ wkt: `POLYGON((${ring}))` }).then(json => {
      if (mine !== d.seq || !map || !on.has(f.id)) return;
      if (!alaRenderer) alaRenderer = L.canvas({ pane: PANES.lines.name });
      const group = L.layerGroup();
      const now = new Date().getFullYear();
      for (const o of (json && json.occurrences) || []) {
        if (o.decimalLatitude == null || o.decimalLongitude == null) continue;
        const age = o.year ? now - o.year : 99;
        L.circleMarker([o.decimalLatitude, o.decimalLongitude], {
          renderer: alaRenderer, interactive: false, radius: 4, weight: 1, color: '#fff',
          fillColor: '#6a1b9a', fillOpacity: age <= 5 ? 0.95 : age <= 20 ? 0.6 : 0.3,
        }).addTo(group);
      }
      const had = !!d.overlay;
      if (d.overlay) d.overlay.remove();
      d.overlay = group.addTo(map);
      if (!had && map.attributionControl) map.attributionControl.addAttribution(f.source.by);
      d.box = { bounds: b, zoom: map.getZoom(), layers: 'ala' };
      d.cut = ((json && json.totalRecords) || 0) > ALA_MAX;
      tell3D('shapes');
      d.count = ((json && json.occurrences) || []).length;
      d.url = ALA;
      setNote(f.id, d.cut ? 'cut' : 'ok');
      rerenderMapLegend();
    }).catch(() => {
      if (mine !== d.seq || !map) return;
      d.failedAt = Date.now();
      clear(f.id);
      setNote(f.id, 'fail');
    });
  }

  // The storm tide file is seven days of ten-minute readings from every gauge
  // (about 5 MB), so it is read once a visit — again after TIDE_TTL — and
  // only while the layer is on. -99 is the file's "no reading".
  const TIDE_TTL = 30 * 60000;
  let tides = null, tidesAt = 0, tidesAsking = null;

  function prettySite(slug) {
    return String(slug || '').replace(/nx$/, '').replace(/^./, c => c.toUpperCase());
  }

  function parseTides(text) {
    const sites = new Map();
    for (const line of text.split(/\r?\n/)) {
      const c = line.split(',');
      if (c.length < 8 || !/^\d+$/.test(c[1])) continue;
      const level = Number(c[3]), pred = Number(c[4]), resid = Number(c[5]);
      const lat = Number(c[6]), lon = Number(c[7]);
      let g = sites.get(c[0]);
      if (!g) { g = { site: c[0], name: prettySite(c[0]), lat, lon, last: null }; sites.set(c[0], g); }
      if (level > -90 && isFinite(level)) g.last = { at: c[2], level, pred: pred > -90 ? pred : null, resid: resid > -90 ? resid : null };
    }
    return [...sites.values()].filter(g => isFinite(g.lat) && isFinite(g.lon));
  }

  function tideList() {
    if (tides && Date.now() - tidesAt < TIDE_TTL) return Promise.resolve(tides);
    if (tidesAsking) return tidesAsking;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS * 2);
    tidesAsking = fetch(TIDES, { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(text => { tides = parseTides(text); tidesAt = Date.now(); return tides; })
      .finally(() => { clearTimeout(t); tidesAsking = null; });
    return tidesAsking;
  }

  const m2 = v => (v == null ? '—' : `${v.toFixed(2)} m`);
  const signed = v => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} m`);

  function tideWords(g) {
    if (!g.last) return `${g.name} storm tide gauge — no reading in the last seven days`;
    return `${g.name} storm tide gauge — ${m2(g.last.level)} at ${g.last.at.replace('T', ' ')} (AEST); `
      + `tide predicted ${m2(g.last.pred)}, so the surge is ${signed(g.last.resid)}. Above the gauge’s tide datum, not AHD.`;
  }

  function runTides(f) {
    const d = slot(f.id);
    if (map.getZoom() < f.minZoom) { clear(f.id); setNote(f.id, 'zoom'); return; }
    if (d.overlay && Date.now() - tidesAt < TIDE_TTL) { setNote(f.id, 'ok'); return; }
    if (Date.now() - d.failedAt < FAIL_TTL) { clear(f.id); setNote(f.id, 'fail'); return; }
    const mine = ++d.seq;
    setNote(f.id, 'loading');
    tideList().then(list => {
      if (mine !== d.seq || !map || !on.has(f.id)) return;
      const group = L.layerGroup();
      for (const g of list) {
        const words = tideWords(g);
        const surge = g.last && g.last.resid != null ? g.last.resid : null;
        const cls = surge == null ? 'none' : surge >= 0.3 ? 'high' : surge <= -0.3 ? 'low' : 'calm';
        L.marker([g.lat, g.lon], {
          pane: PANES.pins.name, keyboard: false, title: words, alt: words,
          icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9],
            html: `<span class="mn-tide-pin mn-tide-${cls}" role="img" aria-label="${escAttr(words)}">🌊</span>` }),
        }).addTo(group);
      }
      const had = !!d.overlay;
      if (d.overlay) d.overlay.remove();
      d.overlay = group.addTo(map);
      if (!had && map.attributionControl) map.attributionControl.addAttribution(f.source.by);
      d.count = list.length;
      d.latest = list.map(g => (g.last ? g.last.at : '')).sort().pop() || '';
      tell3D('shapes');
      d.url = TIDES;
      setNote(f.id, 'ok');
      rerenderMapLegend();
    }).catch(() => {
      if (mine !== d.seq || !map) return;
      d.failedAt = Date.now();
      clear(f.id);
      setNote(f.id, 'fail');
    });
  }

  // Pipes: hosted feature layers, one request a part for the padded view,
  // drawn on this layer's canvas in each part's colour (dashed where the part
  // says). Nothing is asked outside the owner's `box`.
  let pipeRenderer = null;
  const PIPE_MAX = 2000;

  function inBox(f, lat, lon) {
    const b = f.box;
    return !b || (lon >= b.w && lon <= b.e && lat >= b.s && lat <= b.n);
  }
  function boxMeets(f, bounds) {
    const b = f.box;
    return !b || !(bounds.getEast() < b.w || bounds.getWest() > b.e || bounds.getNorth() < b.s || bounds.getSouth() > b.n);
  }

  function partQuery(part, extra) {
    const p = new URLSearchParams({ where: '1=1', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID', f: 'json', ...(extra || {}) });
    return askJson(`${part.url}/query?${p}`);
  }

  function runPipes(f) {
    const d = slot(f.id);
    if (map.getZoom() < f.minZoom) { clear(f.id); setNote(f.id, 'zoom'); return; }
    const view = map.getBounds();
    if (!boxMeets(f, view)) { clear(f.id); setNote(f.id, 'away'); return; }
    if (d.overlay && d.box && d.box.zoom === map.getZoom() && d.box.bounds.contains(view)) { setNote(f.id, d.cut ? 'cut' : 'ok'); return; }
    if (Date.now() - d.failedAt < FAIL_TTL) { clear(f.id); setNote(f.id, 'fail'); return; }
    const mine = ++d.seq;
    const b = view.pad(PAD);
    const degPerPx = (b.getEast() - b.getWest()) / (map.getSize().x * (1 + 2 * PAD));
    setNote(f.id, 'loading');
    Promise.all(f.parts.map(part => partQuery(part, {
      geometry: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`, geometryType: 'esriGeometryEnvelope',
      returnGeometry: 'true', geometryPrecision: '6', maxAllowableOffset: String(degPerPx), resultRecordCount: String(PIPE_MAX),
    }).then(json => ({ part, json }), () => ({ part, json: null })))).then(results => {
      if (mine !== d.seq || !map || !on.has(f.id)) return;
      if (results.every(r => !r.json)) { d.failedAt = Date.now(); clear(f.id); setNote(f.id, 'fail'); rerenderMapLegend(); return; }
      if (!pipeRenderer) pipeRenderer = L.canvas({ pane: PANES.net.name });
      const group = L.layerGroup();
      let cut = false, n = 0;
      const missed = results.filter(r => !r.json).map(r => r.part.words.toLowerCase());
      for (const { part, json } of results) {
        if (!json) continue;
        if (json.exceededTransferLimit) cut = true;
        for (const ft of json.features || []) {
          const paths = (ft.geometry && ft.geometry.paths) || [];
          if (!paths.length) continue;
          n++;
          L.polyline(paths.map(pth => pth.map(([x, y]) => [y, x])), {
            renderer: pipeRenderer, interactive: false, color: part.colour, weight: part.weight,
            opacity: 0.95, dashArray: part.dash || null, lineCap: 'butt',
          }).addTo(group);
        }
      }
      const had = !!d.overlay;
      if (d.overlay) d.overlay.remove();
      d.overlay = group.addTo(map);
      if (!had && map.attributionControl) map.attributionControl.addAttribution(f.source.by);
      d.box = { bounds: b, zoom: map.getZoom(), layers: 'pipes' };
      d.cut = cut;
      d.count = n;
      d.missed = missed;
      d.url = f.parts[0].url;
      // A part that did not answer is asked again on the next move.
      if (missed.length) d.box = null;
      tell3D('shapes');
      setNote(f.id, cut ? 'cut' : 'ok');
      rerenderMapLegend();
    });
  }

  // ── Running ─────────────────────────────────────────────────────────────

  function run() {
    if (!map) return;
    for (const f of FEEDS) {
      if (!on.has(f.id)) {
        if (f.kind === 'network') clearNet(); else clear(f.id);
        slot(f.id).note = 'off';
        continue;
      }
      // One feed's fault is not the others': a throw here would leave every
      // feed after it on "Drawing…".
      try {
        if (f.kind === 'network') runNetwork(f);
        else if (f.kind === 'ala') runAla(f);
        else if (f.kind === 'tide') runTides(f);
        else if (f.kind === 'pipes') runPipes(f);
        else runPicture(f);
      } catch (_) {
        slot(f.id).failedAt = Date.now();
        setNote(f.id, 'fail');
      }
    }
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  // ── Notes, controls and the words ───────────────────────────────────────

  function noteHtml(id) {
    const f = byId[id];
    const d = drawn[id];
    const kind = on.has(id) ? (d ? d.note : 'loading') : 'off';
    switch (kind) {
      case 'zoom':    return `Zoom in to draw it (from zoom ${f.minZoom}).`;
      case 'loading': return 'Drawing…';
      case 'away':    return `Nothing here — ${esc(f.source.by)} publishes it only for its own area.`;
      case 'fail':    return `Could not be drawn — ${esc(f.source.by)}’s map service did not answer. It is asked again in a minute.`;
      case 'cut':     return 'Drawn, but the view held more than the service hands over at once — zoom in to see them all.';
      case 'ok':
        if (f.kind === 'ala') return `Drawn: ${d.count} record${d.count === 1 ? '' : 's'} in view.`;
        if (f.kind === 'pipes') return `Drawn: ${d.count} pipe${d.count === 1 ? '' : 's'} in view.${d.missed && d.missed.length ? ` <span class="txt-warn">Could not be read: ${esc(d.missed.join(', '))}.</span>` : ''}`;
        if (f.kind === 'tide') return `Drawn: ${d.count} gauges, the latest reading ${esc((d.latest || '').replace('T', ' '))} (AEST).`;
        return f.kind === 'network' ? `Drawn: ${netClassesAt(map ? map.getZoom() : 0).map(k => NET_CLASS[k].words.toLowerCase()).join(', ')}.` : 'Drawn.';
      default:        return '';
    }
  }

  function weedSelectHtml() {
    if (!weeds) {
      return `<label class="filter-field mn-feed-sub"><span>Weed</span>
        <select disabled aria-label="Weed to show"><option>${weedsAsking ? 'Reading the list…' : 'Turn the survey on to choose'}</option></select></label>`;
    }
    return `<label class="filter-field mn-feed-sub"><span>Weed</span>
      <select onchange="MapFeeds.setWeed(this.value)" aria-label="Weed to show">
        ${weeds.map(w => `<option value="${w.id}" ${w.id === weedId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select></label>`;
  }

  function rowHtml(f) {
    return `<label class="filter-check" title="${escAttr(f.meaning)}">
        <input type="checkbox" ${on.has(f.id) ? 'checked' : ''} data-feed="${escAttr(f.id)}"
               onchange="MapFeeds.setEnabled('${f.id}', this.checked)">
        ${esc(f.label)}
      </label>
      ${f.weed ? `<div id="mn-feed-weed">${weedSelectHtml()}</div>` : ''}
      <p class="filter-note" id="mn-feed-note-${escAttr(f.id)}">${on.has(f.id) ? noteHtml(f.id) : ''}</p>`;
  }

  function wordsHtml() {
    return `<details class="rd-fold mn-feed-words"><summary>What the words on this list mean</summary>
      <dl class="mn-feed-dl">${FEEDS.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.meaning)}
        <span class="mn-pop-note">${esc(f.source.by)} · ${esc(f.source.licence)} ·
        <a href="${escAttr(f.source.page)}" target="_blank" rel="noopener" aria-label="${escAttr(`About ${f.label} — in a new tab`)}">about it<span aria-hidden="true"> ↗</span></a></span></dd>`).join('')}
        <dt>Open data here</dt><dd>${esc(SECTION_MEANING)}</dd>
      </dl></details>`;
  }

  let foldOpen = false;
  function controlsHtml() {
    const count = on.size;
    return `<details class="rd-fold mn-feeds" data-tour="map-feeds" ${foldOpen || count ? 'open' : ''}
        ontoggle="MapFeeds._fold(this.open)">
      <summary>More map layers — power, pipes, floods, land${count ? ` <span class="mn-pop-note">(${count} on)</span>` : ''}</summary>
      <p class="filter-note">Open data from government map services. ${esc(NOT_FOR_DIGGING)}</p>
      ${GROUPS.map(g => `<fieldset class="mn-feed-group"><legend>${esc(g.title)}</legend>
        ${FEEDS.filter(f => f.group === g.id).map(rowHtml).join('')}</fieldset>`).join('')}
      ${wordsHtml()}
    </details>`;
  }

  // ── The key ─────────────────────────────────────────────────────────────
  // The services' own legend swatches, so the key is the picture's colours;
  // the network's are this file's.
  const legends = {};      // service url → Promise<{ layerId → { name, items:[{label, src}] } }>

  function legendOf(url) {
    if (legends[url]) return legends[url];
    legends[url] = askJson(`${url}/legend?f=json`).then(json => {
      const out = {};
      for (const l of (json && json.layers) || []) {
        out[l.layerId] = {
          name: l.layerName,
          items: (l.legend || []).map(x => ({ label: x.label || '', src: `data:${x.contentType || 'image/png'};base64,${x.imageData}` })),
        };
      }
      return out;
    }).catch(() => ({}));
    legends[url].then(() => rerenderMapLegend());
    return legends[url];
  }

  const legendDone = {};   // service url → resolved legend, for the synchronous render
  function legendNow(url) {
    if (legendDone[url]) return legendDone[url];
    legendOf(url).then(v => { legendDone[url] = v; });
    return null;
  }

  function legendHtml() {
    const parts = [];
    for (const f of FEEDS) {
      const d = drawn[f.id];
      if (!on.has(f.id)) continue;
      const shown = f.kind === 'network' ? !!netLayer : !!(d && d.overlay);
      if (!shown) continue;
      let body = '';
      if (f.kind === 'network') {
        const z = map ? map.getZoom() : 0;
        body = netClassesAt(z).map(k => `
          <span class="legend-item"><span class="legend-line mn-feed-net" style="--dot:${NET_CLASS[k].colour}"></span>
            <span class="small">${esc(NET_CLASS[k].words)}</span></span>`).join('') + `
          <span class="legend-item"><span class="legend-line mn-feed-net mn-feed-net-ug" style="--dot:#555"></span>
            <span class="small">Dashed: underground cable</span></span>`;
      } else if (f.kind === 'pipes') {
        body = f.parts.map(pt => `<span class="legend-item"><span class="legend-line mn-feed-net${pt.dash ? ' mn-feed-net-ug' : ''}" style="--dot:${pt.colour}"></span>
          <span class="small">${esc(pt.words)}</span></span>`).join('');
      } else if (f.kind === 'ala') {
        body = `<span class="legend-item"><span class="legend-dot mn-feed-ala" aria-hidden="true"></span>
          <span class="small">One weed record — darker when from the last five years</span></span>`;
      } else if (f.kind === 'tide') {
        body = `<span class="legend-item"><span class="mn-tide-pin mn-tide-high" aria-hidden="true">🌊</span>
          <span class="small">Surge 0.3 m or more above the predicted tide</span></span>
          <span class="legend-item"><span class="mn-tide-pin mn-tide-calm" aria-hidden="true">🌊</span>
          <span class="small">Within 0.3 m of the prediction</span></span>`;
      } else if (f.kind === 'wms') {
        body = `<span class="legend-item"><span class="mn-feed-ramp" aria-hidden="true"></span>
          <span class="small">Seen wet: rarely → nearly always</span></span>`;
      } else {
        const lg = legendNow(f.url);
        if (lg) {
          body = layersOf(f).map(id => lg[id]).filter(Boolean).flatMap(l => l.items.slice(0, 4).map(it => `
            <span class="legend-item"><img class="mn-feed-swatch" src="${escAttr(it.src)}" alt="">
              <span class="small">${esc(it.label ? `${l.name}: ${it.label}` : l.name)}</span></span>`)).slice(0, 12).join('');
        }
      }
      parts.push(`<span class="legend-item"><span class="small"><strong>${termHtml(f.label, f.meaning)}</strong>
        <span class="txt-muted">— ${esc(f.source.by)}${f.weed && weeds ? ` · ${esc((weeds.find(w => w.id === weedId) || {}).name || '')}` : ''}</span></span></span>${body}`);
    }
    if (!parts.length) return '';
    return parts.join('') + `<span class="legend-item"><span class="small txt-muted">${esc(NOT_FOR_DIGGING)}</span></span>`;
  }

  // ── Open data here: the same services asked about one place ─────────────
  // A section on the station card and on the What is here card. The fire ant
  // and other zones are asked as soon as the card opens (one request, kept for
  // the session per place); the rest only when the section is opened, so a
  // card opened in passing costs one request, not ten.

  const SECTION_MEANING = 'On a station card and the What is here card: what these open-data maps say about that one place — '
    + 'its biosecurity zones straight away, and when opened, past floods, dam-failure areas, nearby power lines and pipelines, '
    + 'underground cables and published water, sewer and stormwater pipes within 30 m, cultural heritage groups, protected areas, the weeds surveyed in its square and the weed records within 2 km.';

  const KEY_DP = 5, CACHE_MAX = 100;
  const NEAR_M = 200, CABLE_M = 30;
  const answers = new Map();        // place key → { zones, more, busy:{} }
  const asked = new Map();          // element id → place

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return null;
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;
  }

  function entry(k) {
    let a = answers.get(k);
    if (a) return a;
    a = { busy: {} };
    answers.set(k, a);
    if (answers.size > CACHE_MAX) answers.delete(answers.keys().next().value);
    return a;
  }

  // ArcGIS identify at a point, `radiusM` round it: a box that size drawn as a
  // 100 px image, and a tolerance of half of it in pixels.
  function identify(url, layers, lat, lon, radiusM) {
    const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    const p = new URLSearchParams({
      f: 'json', geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326',
      layers: `all:${layers.join(',')}`, tolerance: radiusM > 1 ? '50' : '1',
      mapExtent: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`, imageDisplay: '100,100,96',
      returnGeometry: 'false',
    });
    return askJson(`${url}/identify?${p}`).then(j => (j && j.results) || []);
  }

  const attr = (r, ...names) => {
    for (const n of names) { const v = r.attributes && r.attributes[n]; if (v != null && v !== '' && v !== 'Null') return String(v); }
    return '';
  };
  const uniq = xs => [...new Set(xs.filter(Boolean))];

  const SIGHT_KM = 2;
  const PIPE_M = 30;
  const QUESTIONS = {
    zones: (lat, lon) => identify(BIO, [65, 75, 80, 100, 35, 40, 45, 50, 55, 60], lat, lon, 1)
      .then(rs => ({ ok: true, zones: uniq(rs.map(r => attr(r, 'Biosecurity zone', 'Feature') || r.value).map(v =>
        (/^(infested|free)$/i.test(v) ? `Cattle tick ${v.toLowerCase()} area` : v.trim()))) })),
    floods: (lat, lon) => identify(FLOOD, [12, 13, 14, 15, 16, 17, 18, 19, 20, 51, 52, 53], lat, lon, 1)
      .then(rs => ({ ok: true,
        past: uniq(rs.filter(r => r.layerId < 50).map(r => r.layerName.replace(/ Floodline /, ' — '))),
        dams: uniq(rs.filter(r => r.layerId >= 50).map(r => `${attr(r, 'Dam name') || r.value} — ${
          r.layerId === 51 ? 'sunny day failure' : r.layerId === 52 ? 'largest flood, no failure' : 'largest flood with a failure'}`)) })),
    power: (lat, lon) => Promise.all([
      identify(GA_ELEC, [2, 0], lat, lon, NEAR_M),
      identify(GA_PIPES, [0, 1], lat, lon, NEAR_M),
    ]).then(([el, pp]) => ({ ok: true,
      lines: uniq(el.map(r => {
        const kv = attr(r, 'CAPACITY_KV', 'capacity_kv');
        const name = attr(r, 'FEATURE_NAME', 'NAME', 'name') || r.value;
        return `${r.layerId === 0 ? 'Substation' : 'Power line'}${name ? ` — ${name}` : ''}${kv ? ` (${kv} kV)` : ''}`;
      })),
      pipes: uniq(pp.map(r => `${r.layerId === 1 ? 'Gas' : 'Oil'} pipeline — ${attr(r, 'NAME', 'name', 'PIPELINE_NAME') || r.value}`)) })),
    cables: (lat, lon) => Promise.all(NET_SERVICES.map(svc => netQuery(svc,
      [...svc.layers.sub, ...svc.layers.hv, ...svc.layers.lv], null, {
        geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', distance: String(CABLE_M),
        units: 'esriSRUnit_Meter', returnGeometry: 'false', outFields: '*',
      }).then(json => ({ svc, json }), () => ({ svc, json: null }))))
      .then(rs => {
        if (rs.every(r => !r.json)) return { ok: false, why: 'Energex and Ergon’s services did not answer' };
        const found = [];
        for (const { svc, json } of rs) {
          for (const l of (json && json.layers) || []) {
            const k = netClassOf(svc, l.id);
            if (!k || !(l.features || []).length) continue;
            found.push(`${svc.name}: ${NET_CLASS[k].words.toLowerCase()}, ${svc.cable.has(l.id) ? 'underground' : 'overhead'} (${l.features.length})`);
          }
        }
        return { ok: true, found };
      }),
    land: (lat, lon) => Promise.all([
      identify(HERITAGE, [1, 5], lat, lon, 1),
      identify(PARKS, [10, 15, 25], lat, lon, 1),
      identify(CAPAD, [0], lat, lon, 1).catch(() => []),
    ]).then(([ch, pk, cp]) => ({ ok: true,
      heritage: uniq(ch.map(r => `${attr(r, 'Name', 'NAME') || r.value} — ${r.layerId === 5 ? 'cultural heritage body' : 'cultural heritage party'}`)),
      parks: uniq([...pk, ...cp].map(r => attr(r, 'Estate name', 'ESTATENAME', 'NAME', 'Name') || r.value)) })),
    weeds: (lat, lon) => identify(BIO, [WEED_GROUP], lat, lon, 1)
      .then(rs => ({ ok: true, weeds: uniq(rs.map(r => {
        const name = attr(r, 'Common name') || r.layerName;
        const dec = attr(r, 'State declaration');
        return dec && !/not declared/i.test(dec) ? `${name} (${dec.toLowerCase()})` : name;
      })).sort() })),
    // Pipes within PIPE_M, a line a kind, from each feed whose box holds the
    // place — so a station outside every owner's area asks nothing.
    pipes: (lat, lon) => {
      const parts = FEEDS.filter(f => f.kind === 'pipes' && inBox(f, lat, lon))
        .flatMap(f => f.parts.map(part => ({ f, part })));
      if (!parts.length) return Promise.resolve({ ok: true, found: [], none: true });
      return Promise.all(parts.map(({ f, part }) => partQuery(part, {
        geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', distance: String(PIPE_M), units: 'esriSRUnit_Meter',
        returnCountOnly: 'true',
      }).then(j => ({ f, part, n: (j && j.count) || 0 }), () => ({ f, part, n: null })))).then(rs => {
        if (rs.every(r => r.n == null)) return { ok: false, why: 'the pipe services did not answer' };
        return { ok: true, found: rs.filter(r => r.n).map(r => `${r.part.words} — ${r.n} within ${PIPE_M} m (${r.f.source.by})`) };
      });
    },
    // The Atlas's weed records within SIGHT_KM, one line a weed: how many, the
    // nearest and the latest year — the exact half of the survey's squares.
    sightings: (lat, lon) => alaPages({
      lat: String(lat), lon: String(lon), radius: String(SIGHT_KM),
    }).then(json => {
      const by = new Map();
      for (const o of (json && json.occurrences) || []) {
        const name = o.vernacularName || o.scientificName;
        if (!name || o.decimalLatitude == null) continue;
        const m = L.latLng(lat, lon).distanceTo([o.decimalLatitude, o.decimalLongitude]);
        const g = by.get(name) || { name, n: 0, near: Infinity, year: 0 };
        g.n++; g.near = Math.min(g.near, m); g.year = Math.max(g.year, o.year || 0);
        by.set(name, g);
      }
      const list = [...by.values()].sort((a, b) => a.near - b.near);
      return { ok: true, total: (json && json.totalRecords) || 0, list: list.map(g =>
        `${g.name} — ${g.n} record${g.n === 1 ? '' : 's'}, nearest ${g.near < 1000 ? `${Math.round(g.near / 10) * 10} m` : `${(g.near / 1000).toFixed(1)} km`}${g.year ? `, latest ${g.year}` : ''}`) };
    }),
  };
  const FIRST = ['zones'];
  const MORE = ['floods', 'power', 'cables', 'pipes', 'land', 'weeds', 'sightings'];

  const settled = r => !!r && (r.ok || Date.now() - r.at < FAIL_TTL);

  function runQs(k, names) {
    const a = entry(k);
    const [lat, lon] = k.split(',').map(Number);
    for (const n of names) {
      if (a.busy[n] || settled(a[n])) continue;
      a.busy[n] = true;
      Promise.resolve().then(() => QUESTIONS[n](lat, lon))
        .then(r => (r && r.ok ? r : { ok: false, why: (r && r.why) || 'no answer' }), () => ({ ok: false, why: 'no answer' }))
        .then(r => {
          a[n] = r.ok ? r : { ...r, at: Date.now() };
          a.busy[n] = false;
          notify(k);
        });
    }
  }

  function notify(k) {
    for (const [elId, s] of asked) {
      const el = document.getElementById(elId);
      if (!el) { asked.delete(elId); continue; }
      if (el.dataset.mnFeeds !== k) continue;
      const open = !!el.querySelector('details[open]');
      el.innerHTML = html(s, open);
    }
  }

  const failed = r => !!(r && r.ok === false);

  function row(label, meaning, value) {
    return `<div class="acma-row"><span>${termHtml(label, meaning)}</span><span>${value}</span></div>`;
  }

  function list(xs, none) {
    return xs && xs.length ? xs.map(esc).join('<br>') : `<span class="txt-muted">${esc(none)}</span>`;
  }

  function answer(a, n, fn, none) {
    const r = a && a[n];
    if (failed(r)) return '<span class="txt-warn">could not be read</span>';
    if (!r) return '<span class="mn-pop-note">asking…</span>';
    return fn(r) || `<span class="txt-muted">${esc(none)}</span>`;
  }

  const TERMS = {
    zones: 'The State’s biosecurity zones this place is in. In a fire ant zone, soil, mulch, gravel and hay may not leave a site without meeting the rules.',
    floods: 'Past floods whose mapped outline covers this place. Only the floods the State has mapped — not every flood there has been.',
    dams: 'Modelled flooding below a dam the State lists because its failure would put people at risk. A worst case, not a forecast.',
    lines: `Geoscience Australia’s high-voltage lines and substations within about ${NEAR_M} m.`,
    pipes: `Gas and oil pipelines within about ${NEAR_M} m.`,
    cables: `Energex or Ergon lines within ${CABLE_M} m, and whether each is overhead or an underground cable. A guide only: ring Before You Dig Australia (1100) before digging.`,
    pipes: `Stormwater pipes and drains, and water, sewer and recycled water mains, within ${PIPE_M} m — only where the council or water utility publishes them (Brisbane, Unitywater’s area, Melbourne Water). A guide only: ring Before You Dig Australia (1100) before digging.`,
    heritage: 'The Aboriginal or Torres Strait Islander party or body for this area under the cultural heritage laws — who to talk to before ground is disturbed.',
    parks: 'A national park, State forest or other protected area this place is in. Working in one usually needs a permit.',
    sightings: `Weeds actually recorded within ${SIGHT_KM} km, nearest first, from the Atlas of Living Australia: Queensland’s own weed records and anyone’s record of a Weed of National Significance. A record says a weed was seen there that year, not that it is still there.`,
    weeds: 'Invasive plants the State’s 2022–23 survey found in this place’s square (about 17 km across) — somewhere in the square, not necessarily here. Restricted and prohibited ones are marked.',
  };

  function zonesShort(a) {
    const z = a && a.zones;
    if (!z || !z.ok) return '';
    const fire = z.zones.filter(v => /fire ant/i.test(v));
    return fire.length ? `<span class="term-chip mn-feed-chip" title="${escAttr(TERMS.zones)}">🐜 ${esc(fire[0])}</span>` : '';
  }

  function html(s, open) {
    const k = key(s);
    if (!k) return '';
    const a = answers.get(k);
    const body = `
      ${row('Biosecurity zones', TERMS.zones, answer(a, 'zones', r => list(r.zones, 'none'), 'none'))}
      ${row('Past floods', TERMS.floods, answer(a, 'floods', r => list(r.past, 'none mapped here'), ''))}
      ${row('Dam-failure areas', TERMS.dams, answer(a, 'floods', r => list(r.dams, 'none'), ''))}
      ${row('High-voltage lines', TERMS.lines, answer(a, 'power', r => list(r.lines, `none within ${NEAR_M} m`), ''))}
      ${row('Pipelines', TERMS.pipes, answer(a, 'power', r => list(r.pipes, `none within ${NEAR_M} m`), ''))}
      ${row('Power network', TERMS.cables, answer(a, 'cables', r => list(r.found, `none within ${CABLE_M} m`), ''))}
      ${row('Pipes', TERMS.pipes, answer(a, 'pipes', r => (r.none ? `<span class="txt-muted">none published for this area</span>` : list(r.found, `none within ${PIPE_M} m`)), ''))}
      ${row('Cultural heritage', TERMS.heritage, answer(a, 'land', r => list(r.heritage, 'none listed'), ''))}
      ${row('Protected area', TERMS.parks, answer(a, 'land', r => list(r.parks, 'not in one'), ''))}
      ${row('Weed sightings nearby', TERMS.sightings, answer(a, 'sightings', r => list(r.list.slice(0, 10), `none recorded within ${SIGHT_KM} km`) + (r.list.length > 10 ? `<br><span class="mn-pop-note">and ${r.list.length - 10} more</span>` : ''), ''))}
      ${row('Weeds in its square', TERMS.weeds, answer(a, 'weeds', r => (r.weeds.length ? `${r.weeds.length}: ${esc(r.weeds.join(', '))}` : ''), 'none surveyed'))}
      <p class="mn-pop-note">${esc(NOT_FOR_DIGGING)} What the words mean: hover them, or see <em>More map layers</em> in Map display.</p>`;
    return `<details class="mn-feed-sect" ${open ? 'open' : ''} ontoggle="MapFeeds._sect(this)">
      <summary title="${escAttr(SECTION_MEANING)}">Open data here ${zonesShort(a)}</summary>${open ? body : ''}</details>`;
  }

  // The card places <div id=elId data-mn-feeds=key(s)>html(s)</div> and calls this.
  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    asked.set(elId, s);
    runQs(k, FIRST);
  }

  function sectionToggled(det) {
    const host = det.parentElement;
    if (!host || !host.dataset.mnFeeds) return;
    const s = asked.get(host.id);
    if (!s) return;
    if (det.open) {
      runQs(host.dataset.mnFeeds, MORE);
      host.innerHTML = html(s, true);
    }
  }

  // ── The face it shows the rest of the app ───────────────────────────────

  return {
    FEEDS,
    attach(m) {
      map = m;
      for (const p of Object.values(PANES)) {
        if (!m.getPane(p.name)) {
          const el = m.createPane(p.name);
          el.style.zIndex = p.z;
          if (!p.pointer) el.style.pointerEvents = 'none';
        }
      }
      m.on('moveend', sync);
      if (on.has('qld-weeds')) weedList().then(() => refreshWeedSelect());
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      for (const f of FEEDS) clear(f.id);
      clearNet();
      netRenderer = null;
      map = null;
    },

    sync,
    controlsHtml,
    legendHtml,
    noteHtml,

    active() { return FEEDS.some(f => on.has(f.id) && (f.kind === 'network' ? !!netLayer : !!(drawn[f.id] && drawn[f.id].overlay))); },
    enabled(id) { return on.has(id); },

    setEnabled(id, yes) {
      if (!byId[id]) return;
      if (yes) on.add(id); else on.delete(id);
      save(STORE_KEY, [...on]);
      if (id === 'qld-weeds' && yes) weedList().then(() => { refreshWeedSelect(); sync(); });
      if (!yes) {
        if (byId[id].kind === 'network') clearNet(); else clear(id);
        setNote(id, 'off');
        rerenderMapLegend();
      } else {
        setNote(id, 'loading');
      }
      sync();
      tell3D('drapes');
      if (!yes) tell3D('shapes');
    },

    // Views (map-views.js): what is on, as a list, and set to exactly a list.
    enabledList() { return FEEDS.filter(f => on.has(f.id)).map(f => f.id); },
    setOnly(ids) {
      const want = new Set((ids || []).filter(id => byId[id]));
      for (const f of FEEDS) if (on.has(f.id) !== want.has(f.id)) this.setEnabled(f.id, want.has(f.id));
      const box = document.querySelectorAll('.mn-feeds input[data-feed]');
      for (const b of box) b.checked = want.has(b.dataset.feed);
    },
    label(id) { return byId[id] ? byId[id].label : id; },

    // The pictures the 3-D view drapes, ground up: areas, then lines.
    drapes() {
      return FEEDS.filter(f => f.kind === 'arcgis' || f.kind === 'wms')
        .map(f => ({ id: f.id, label: f.label, by: f.source.by, band: f.pane === 'areas' ? 'areas' : 'lines' }));
    },

    // One drape's tile template: MapLibre fills {bbox-epsg-3857} itself, so
    // the bbox goes on the end unencoded (map-lots.js's reason).
    tiles(id) {
      const f = byId[id];
      if (!f || !(f.kind === 'arcgis' || f.kind === 'wms')) return Promise.reject(new Error('not a picture feed'));
      const ready = f.weed ? weedList() : Promise.resolve();
      return ready.then(() => {
        if (f.kind === 'wms') {
          const p = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap', layers: f.wmsLayer, styles: '',
            crs: 'EPSG:3857', width: '256', height: '256', format: 'image/png', transparent: 'true' });
          return { url: `${f.url}?${p}&bbox={bbox-epsg-3857}`, size: 256, minzoom: f.minZoom, maxzoom: 19,
                   opacity: f.opacity, attribution: f.source.by };
        }
        const p = new URLSearchParams({ f: 'image', format: 'png32', transparent: 'true', dpi: '96',
          bboxSR: '3857', imageSR: '3857', size: '512,512', layers: `show:${layersOf(f).join(',')}` });
        return { url: `${f.url}/export?${p}&bbox={bbox-epsg-3857}`, size: 512, minzoom: f.minZoom, maxzoom: 19,
                 opacity: f.opacity, attribution: f.source.by };
      });
    },

    // What 2-D drew that is not a picture, as GeoJSON: the power network's
    // lines (colour, width, underground) and the weed records' and tide
    // gauges' points (kind, colour, words).
    shapes() {
      const lines = [], points = [];
      if (netLayer) {
        netLayer.eachLayer(l => {
          const o = l.options || {};
          const parts = l.getLatLngs();
          const rings = Array.isArray(parts[0]) ? parts : [parts];
          for (const r of rings) {
            if (r.length < 2) continue;
            lines.push({ type: 'Feature', properties: { colour: o.color, width: o.weight, ug: !!o.dashArray },
              geometry: { type: 'LineString', coordinates: r.map(p => [p.lng, p.lat]) } });
          }
        });
      }
      for (const f of FEEDS.filter(x => x.kind === 'pipes')) {
        const d = drawn[f.id];
        if (!on.has(f.id) || !d || !d.overlay) continue;
        d.overlay.eachLayer(l => {
          const o = l.options || {};
          const parts = l.getLatLngs();
          for (const r of (Array.isArray(parts[0]) ? parts : [parts])) {
            if (r.length < 2) continue;
            lines.push({ type: 'Feature', properties: { colour: o.color, width: o.weight, ug: !!o.dashArray },
              geometry: { type: 'LineString', coordinates: r.map(pt => [pt.lng, pt.lat]) } });
          }
        });
      }
      for (const id of ['ala-weeds', 'qld-tides']) {
        const d = drawn[id];
        if (!on.has(id) || !d || !d.overlay) continue;
        d.overlay.eachLayer(l => {
          const ll = l.getLatLng();
          const o = l.options || {};
          const cls = id === 'qld-tides' ? (/mn-tide-(high|low|calm|none)/.exec((o.icon && o.icon.options.html) || '') || [])[1] : null;
          points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] },
            properties: id === 'ala-weeds'
              ? { kind: 'weed', colour: '#6a1b9a', opacity: o.fillOpacity == null ? 0.8 : o.fillOpacity, words: '' }
              : { kind: 'tide', colour: cls === 'high' ? '#c62828' : cls === 'none' ? '#888888' : '#1565c0', opacity: 1, words: o.title || '' } });
        });
      }
      return { lines: { type: 'FeatureCollection', features: lines }, points: { type: 'FeatureCollection', features: points } };
    },

    setWeed(v) {
      const id = Number(v);
      if (!weeds || !weeds.some(w => w.id === id)) return;
      weedId = id;
      save(WEED_KEY, id);
      clear('qld-weeds');
      sync();
      tell3D('drapes');
    },

    weeds() { return weeds ? weeds.slice() : null; },

    // Card section.
    key, html, ask,
    _sect: sectionToggled,
    _fold(open) { foldOpen = open; },
    _state() {
      return { on: [...on], weedId, drawn: Object.fromEntries(Object.entries(drawn).map(([k, d]) => [k, { note: d.note, url: d.url || null, shown: !!d.overlay }])), net: !!netLayer };
    },
  };

  function refreshWeedSelect() {
    const el = document.getElementById('mn-feed-weed');
    if (el) el.innerHTML = weedSelectHtml();
  }
})();
