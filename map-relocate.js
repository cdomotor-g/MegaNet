// MegaNet — map-relocate.js
//
//   MapRelocate   the station relocation finder: pick a station that has to
//                 move, say how far it may go, and it colours every patch of
//                 ground inside that circle by how good a home it would be —
//                 the fade margin to the repeaters that hear the station now
//                 first, then open sky for the rain gauge, clear ground under
//                 the hut, and how far it is from where the station stands —
//                 and pins the three to five best, kept off every building it
//                 can find and out of the water.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm,
// bearingDeg, cssVar, slug, dlText, stationLatLonText, copyLatLonPillHtml and
// mapViewPills; across to terrain.js for Terrain.profile, land-cover.js for
// LandCover.sample and LandCover.canopyAt, path-profile.js for pathAnalyse,
// pathGround, pathPropOf, rmSystemOf, stationAntenna, stationIsMast, wattsToDbm
// and the PATH_DEFAULT_* constants, link-budget.js for lbFmtDbd, map-draw.js
// for MapDraw, map-controls.js for MapChrome.panel, and app.js for
// findRepeaterMatches, rerenderMapLegend and mapNote. All of it from inside its
// own functions, so this file's position among the modules is free.
//
// ── The question this answers ────────────────────────────────────────────────
// The repeater site finder (map-sites.js) asks where a new mast should go to
// serve a set of stations. This is the other way round and much closer in: a
// station that has to move — the bank washed out, the landholder wants the
// paddock back, the trees have grown over it — and the repeaters that hear it
// today must go on hearing it. Somewhere within a few hundred metres is
// almost always the answer, and the difference between two spots a hundred
// metres apart can be ten decibels: the far side of a rise, out from under a
// stand of gums. Nobody profiles a hundred spots by hand. This does.
//
// ── How ──────────────────────────────────────────────────────────────────────
// Two passes, for map-sites.js's reason: "is it any good" is cheap and "how
// many decibels" is not, and the two are never mixed in one ranking.
//
//   1. SCREEN. A square lattice of places across the circle — about thirty
//      across, never closer than 15 m — and from every one of them a path to
//      every repeater ticked, sampled every 30 m (fine enough that the tiles
//      come at their best ~30 m, so two places 30 m apart stand on different
//      ground) and run through pathAnalyse: the profile card's own geometry
//      and Longley–Rice, over bare ground. This is what colours the map.
//
//   2. REFINE. The best few, spaced apart, and where the station stands now,
//      are priced again the link budget card's way — pathGround's 256
//      samples on whatever ground the card is set to, the land cover on them
//      under the land-cover model — so the figure quoted for a result is the
//      figure the card will give when the path is opened in it.
//
// Beside the radio, three things about the ground itself, each read once for
// the whole circle:
//
//   Trees    Esri's Global Canopy Height 2020 (ETH Zürich, 10 m, ±5 m) on a
//            10 m lattice — LandCover.canopyAt, the tiles the profile card
//            already reads, and no request per point.
//   Roofs    the State's buildings where there is a State to ask: the
//            outlines Queensland generates from its LiDAR's building class
//            (roof heights and all, by project area, not statewide), the
//            topographic building outlines and points — every shed, house and
//            homestead digitised off the imagery — and OpenStreetMap's
//            buildings through Overpass, in Queensland and outside it. A
//            building none of them has mapped is one this cannot see, which
//            is why every result says to look at the imagery.
//   Cover    the Sentinel-2 land-cover class under each place (LandCover.
//            sample): water is somewhere a hut cannot go, and "built area" is
//            a yard or a town however the buildings were mapped.
//
// ── The score ────────────────────────────────────────────────────────────────
// Four figures, each nought to one, weighted by four sliders the operator
// owns and every one printed beside the result — map-sites.js's contract:
//
//   Fade margin    station to repeater, to the worst-served repeater ticked,
//                  from 6 dB under the map's "ok" (nought) to 10 dB over its
//                  "good" (one). The primary goal, and the heaviest default.
//   Open sky       the rain gauge's exposure as the WMO siting classification
//                  for precipitation grades it (CIMO Guide, WMO-No. 8): the
//                  steepest obstacle seen from the gauge rim within 60 m —
//                  four times a 15 m tree — class 1 at 14° or under (obstacles
//                  four times their height away), 2 at 26.6° (twice), 3 at
//                  45°, 4 at 63.4°, 5 nearer or under the canopy. Trees from
//                  the canopy map, roofs from the buildings; level ground.
//   Clear ground   the share of the ground within 20 m with no tree or roof on
//                  it — what the hut, the mast and a radio under the canopy
//                  would stand in. Under the field model the trees round the
//                  antenna are in the allowance, the same for every place, so
//                  this is the criterion that tells a clearing from a forest.
//   Close by       one where the station is now, nought at the circle's edge.
//
// A place every repeater ticked hears at the map's "ok" or better always
// ranks above one that some repeater does not, whatever the weights: the
// margin is the requirement, the rest is preference. Two things are not
// scored but ruled out — within the clearance of a building (on a roof, or in
// somebody's yard), and in water — and they are hatched on the map rather
// than left blank, so "nothing here" is never mistaken for "not looked at".
//
// Changing a weight re-ranks and costs nothing; changing the building
// clearance or the gauge rim re-reads the ground already in hand; anything
// that changes what would be computed — the station, its repeaters, the
// circle, the mast — takes the answer with it (map-polar.js's rule).
//
// ── What it is not ───────────────────────────────────────────────────────────
// ~30 m terrain, omnidirectional antennas, a canopy map of 2020 and the
// buildings somebody has mapped: a short list to walk on site, not a survey.
// Not drawn in the 3-D view — its colours are a 2-D overlay only.
const MapRelocate = (function () {
  // The wash over the ground, just above the polar plot's (332) and under the
  // contours (335): context, painted over the base map and under everything
  // drawn to be read. The lines — the circle, the buildings, the chosen
  // place's paths — over the site finder's (342) and under the survey marks
  // (345). The numbered pins over the station labels (650) and the site
  // finder's pins (660), under the popups (700), for map-sites.js's reason: a
  // pin under the network's canvas can be seen and never pressed.
  const WASH_PANE = 'mnRelocWash',  WASH_Z = 333;
  const LINE_PANE = 'mnRelocLines', LINE_Z = 343;
  const PANE      = 'mnReloc',      PANE_Z = 662;

  const MIN_R = 50, MAX_R = 2000;     // metres the station may move
  const ACROSS        = 32;           // places across the circle's diameter …
  const MIN_STEP      = 15;           // … never closer than this, in metres
  const SCREEN_STEP_M = 30;           // sample spacing on a screened path
  const MIN_SAMPLES   = 64;
  const MAX_SAMPLES   = 1024;         // Terrain.profile's own ceiling
  const FINE_SAMPLES  = 256;          // the card's figure, PathProfile's own
  const SPARE         = 3;            // finalists refined past the number asked
  const CONCURRENCY   = 4;            // refined paths in flight, MapFade's figure
  const CHUNK_MS      = 20;           // screening between breaths for the page
  const LAT_M         = 10;           // the canopy lattice — the map's own 10 m
  const OBST_R        = 60;           // obstacles looked for out to this
  const COVER_R       = 20;           // "clear ground" is this far round
  const TREE_MIN_M    = 2;            // canopy under this is grass and scrub
  const POINT_R       = 6;            // a building known only as a point
  const HOMESTEAD_R   = 10;           // … and a homestead
  const ROOF_H        = 5;            // a roof whose height nobody recorded
  const NEAR_BLD_M    = 100;          // the nearest building, said out to this
  const NEAR_HUB_KM   = 60;           // other repeaters and bases offered …
  const NEAR_HUB_N    = 6;            // … this many, nearest first
  const HIT_CAP       = 8;            // stations offered by the search box
  const FETCH_MS      = 20000;
  const BLD_PAGE      = 2000;         // buildings per request, under the
  const BLD_PAGES     = 3;            // service's 4,000, and this many pages
  const MIN_COUNT = 3, MAX_COUNT = 5;
  const STORE         = 'mn-relocate-v1';

  const QLD_BOX = { west: 137.9, south: -29.3, east: 153.7, north: -9.0 };
  const QLD_BUILDINGS = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Structure/BuildingsAndSettlements/MapServer';
  const QLD_LAYERS = [
    { id: 11, kind: 'poly',  label: 'Queensland building outlines generated from LiDAR',
      fields: 'bsm_max,dtm_centre', where: "status='Current'" },
    { id: 20, kind: 'poly',  label: 'Queensland topographic building outlines',
      fields: 'function,maximum_roof_height,eave_height', where: '1=1' },
    { id: 10, kind: 'point', label: 'Queensland topographic building points',
      fields: 'function', where: '1=1' },
    { id: 0,  kind: 'home',  label: 'Queensland homesteads', fields: 'objectid', where: '1=1' },
  ];
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

  // The WMO's five classes for a precipitation gauge, by the elevation angle
  // of the steepest obstacle: tan 14° is a quarter, tan 26.6° a half, tan
  // 63.4° two — four times, twice, once and half the obstacle's height away.
  const WMO = [
    { cls: 1, max: 14.0, words: 'obstacles four times their height away or further' },
    { cls: 2, max: 26.6, words: 'obstacles twice their height away or further' },
    { cls: 3, max: 45.0, words: 'obstacles their own height away or further' },
    { cls: 4, max: 63.4, words: 'obstacles half their height away or further' },
    { cls: 5, max: 90.1, words: 'obstacles nearer than half their height, or under the canopy' },
  ];

  const WEIGHTS = [
    ['wFade',  'Fade margin',  'decibels to spare to the repeaters ticked, the worst of them'],
    ['wSky',   'Open sky',     'the rain gauge clear of trees and roofs — its WMO siting class'],
    ['wClear', 'Clear ground', 'no tree or roof within 20 m of the hut and the mast'],
    ['wNear',  'Close by',     'not far from where the station stands now'],
  ];

  // The wash's colours, each for the job it does. Suitability is a magnitude:
  // one hue, light to dark, five steps. Fade margin is the fade map's own
  // three bands, as tokens, so a place reads in the colours its paths do.
  // Change from where it is now has a sign: two hues and a grey for "no
  // different". Ruled out is a state, and carries a texture as well as grey.
  const SEQ = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
  const DIV = [
    { lo: -Infinity, hi: -6, c: '#b3262f' }, { lo: -6, hi: -3, c: '#e34948' }, { lo: -3, hi: -1, c: '#ee9690' },
    { lo: -1, hi: 1, c: '#f0efec' },
    { lo: 1, hi: 3, c: '#86b6ef' }, { lo: 3, hi: 6, c: '#3987e5' }, { lo: 6, hi: Infinity, c: '#1c5cab' },
  ];
  const BAND = {
    good: ['--map-fade-good', '#00e676'], ok: ['--map-fade-ok', '#ffab00'],
    bad:  ['--map-fade-bad', '#e53935'],  none: ['--muted', '#888888'],
  };
  const OUT_FILL = '#52514e', OUT_LINE = '#c3c2b7';
  const PAINTS = {
    score:  'Suitability — everything weighed',
    margin: 'Fade margin to the worst repeater',
    change: 'Change in fade margin from where it is now',
  };

  const cfg = load();

  let map = null, body = null;
  let layer = null, lineLayer = null, wash = null, tip = null, tipFrame = 0, tipAt = null;
  let stationId = null;
  let ticks = new Set();    // the hubs the margin is asked of
  let hitQ = '';
  let job = null;           // { cancelled } while a pass is in flight
  let found = null;         // the screened lattice, the ground, everything refined
  let results = [];         // [{ rank, c, s }]
  let selected = null;      // the place whose paths are drawn — a cell, or found.now
  let rerankDue = false;
  let status = { kind: 'idle', text: '' };

  // ── Settings ────────────────────────────────────────────────────────────────

  function defaults() {
    return {
      radiusM: 500, count: 5, agl: null, clearM: 10, rimM: 1,
      wFade: 5, wSky: 2, wClear: 2, wNear: 1,
      paint: 'score', opacity: 0.6,
    };
  }

  function load() {
    const d = defaults();
    try { return Object.assign(d, JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (_) { return d; }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); }
    catch (_) { /* private browsing, a full quota — it still holds this session */ }
  }

  function count() {
    const n = Math.round(cfg.count);
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n > 0 ? n : MAX_COUNT));
  }

  function radiusM() {
    const r = +cfg.radiusM;
    return Math.max(MIN_R, Math.min(MAX_R, isFinite(r) && r > 0 ? r : 500));
  }

  function stepFor(r) { return Math.max(MIN_STEP, Math.round(2 * r / ACROSS)); }

  function clearM() { const v = +cfg.clearM; return isFinite(v) && v >= 0 ? Math.min(100, v) : 10; }
  function rimM()   { const v = +cfg.rimM;   return isFinite(v) && v >= 0 ? Math.min(20, v) : 1; }

  function goodDb() { return state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15; }
  function okDb()   { return isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6; }

  // ── The station and its radios ──────────────────────────────────────────────

  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => s.id === id) || null; }
  function station() { return stationId != null ? stationById(stationId) : null; }

  // The link budget card's rule, inherited: a term nobody supplied blanks the
  // figure rather than being read as nought.
  function complete(sys) {
    return !!sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null
        && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  }

  // The radio most of the network runs, for a station with none of its own on
  // file — map-sites.js's fieldDefault, and for its reason.
  function fieldDefault() {
    const list = ((state.data && state.data.rm_systems) || []).filter(complete);
    if (!list.length) return null;
    const n = new Map();
    for (const s of stations()) {
      const sys = rmSystemOf(s);
      if (complete(sys)) n.set(sys.id, (n.get(sys.id) || 0) + 1);
    }
    return list.reduce((best, r) => ((n.get(r.id) || 0) > (n.get(best.id) || 0) ? r : best), list[0]);
  }

  function radioOf(sys, agl) {
    return { sysName: sys.name, txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
             loss: sys.line_loss_db, thr: sys.rx_threshold_dbm, agl };
  }

  // The station's radio as filed, on its own antenna height.
  function hereRadio(st) {
    const own = rmSystemOf(st);
    const sys = complete(own) ? own : fieldDefault();
    if (!sys) return null;
    return { ...radioOf(sys, stationAntenna(st, sys).agl), assumed: !complete(own) };
  }

  // A repeater or base at the far end: its own radio and its own mast
  // (stationAntenna raises it to the propagation settings' mast height), the
  // frequency it listens on, and whether pathGround may stand it on its top.
  function hubOf(s) {
    const sys = rmSystemOf(s);
    if (!complete(sys)) return null;
    return {
      id: s.id, s, name: s.name, lat: s.lat, lon: s.lon,
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      rad: radioOf(sys, stationAntenna(s, sys).agl), mast: stationIsMast(s),
      f: s.repeater && s.repeater.rx_mhz > 0 ? s.repeater.rx_mhz : PATH_DEFAULT_MHZ,
    };
  }

  // The repeaters that carry the station today — the pass-range relation the
  // map draws its links from — and after them the nearest few other repeaters
  // and bases, offered unticked: a station that moves may be better heard by
  // a hub that does not carry it yet.
  function hubChoices(st) {
    if (!st) return [];
    let listen = [];
    try { listen = findRepeaterMatches(st) || []; } catch (_) { listen = []; }
    listen = listen.filter(r => r && r.id !== st.id && r.lat != null && r.lon != null);
    const seen = new Set(listen.map(r => r.id));
    const near = stations()
      .filter(s => s.id !== st.id && !seen.has(s.id) && s.lat != null && s.lon != null
                && Array.isArray(s.roles) && (s.roles.includes('repeater') || s.roles.includes('base')))
      .map(s => ({ s, km: acmaHaversineKm(st.lat, st.lon, s.lat, s.lon) }))
      .filter(x => x.km <= NEAR_HUB_KM)
      .sort((a, b) => a.km - b.km)
      .slice(0, NEAR_HUB_N);
    return listen.map(s => ({ s, listening: true, km: acmaHaversineKm(st.lat, st.lon, s.lat, s.lon) }))
      .concat(near.map(x => ({ s: x.s, listening: false, km: x.km })));
  }

  function freqText(h) { return `${h.f.toFixed(3)} MHz`; }

  function oneWay(loss, from, to) {
    const tx = wattsToDbm(from.txW);
    if (tx == null || loss == null) return null;
    return tx + from.gain - from.loss - loss + to.gain - to.loss - to.thr;
  }

  // One way, the station to the hub — the way its readings go, and MapFade's
  // reading of a link, so a figure here is the figure the map paints it. Nothing
  // transmits back down to a station, so there is no other way to price.
  function marginOf(an, here, hub) {
    return oneWay(an.pathLoss_db, here, hub.rad);
  }

  // ── The lattice ─────────────────────────────────────────────────────────────

  // Metres in a degree, here. Over a circle of a few kilometres a flat grid in
  // these is good to a few centimetres, and it keeps a place's coordinates and
  // its east/north offsets the same thing.
  function metresPerDeg(lat) {
    const p = lat * Math.PI / 180;
    return { lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
             lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) };
  }

  function cellsFor(st, r, step) {
    const k = metresPerDeg(st.lat);
    const n = Math.ceil(r / step);
    const out = [];
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        const x = i * step, y = j * step, d = Math.hypot(x, y);
        if (d > r + 1e-6) continue;
        out.push({
          id: `${i},${j}`, i, j, x, y, dM: d,
          lat: st.lat + y / k.lat, lon: st.lon + x / k.lon,
          now: i === 0 && j === 0, grid: [], fine: [],
        });
      }
    }
    return out;
  }

  function boxAround(st, rM) {
    const k = metresPerDeg(st.lat);
    return { south: st.lat - rM / k.lat, north: st.lat + rM / k.lat,
             west: st.lon - rM / k.lon, east: st.lon + rM / k.lon };
  }

  // ── The screen ──────────────────────────────────────────────────────────────

  async function screenPair(c, hub, here) {
    const dKm = acmaHaversineKm(c.lat, c.lon, hub.lat, hub.lon);
    const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(dKm * 1000 / SCREEN_STEP_M) + 1));
    const prof = await Terrain.profile([[c.lat, c.lon], [hub.lat, hub.lon]], n);
    if (!prof || !prof.ok) return { dKm, failed: true, src: 'grid' };
    // Too little ground to answer from — map-sites.js's quarter.
    if (prof.missing > n / 4) return { dKm, failed: true, src: 'grid' };
    if (c.ground == null && prof.terrain_m[0] != null) c.ground = prof.terrain_m[0];
    const an = pathAnalyse(prof, { elevA: null, elevB: hub.elev, aglA: here.agl, aglB: hub.rad.agl, freqMhz: hub.f });
    if (!an.ok) return { dKm, failed: true, src: 'grid' };
    return { dKm, verdict: an.verdict, margin: marginOf(an, here, hub),
             partial: !!prof.partial, src: 'grid' };
  }

  // Every place to every hub, a breath for the page every CHUNK_MS. The tiles
  // under one hub's paths are fetched by its first and shared by every other,
  // so after a moment's network this is arithmetic.
  async function screen(mine, cells, hubs, hereNow, hereNew) {
    const total = cells.length * hubs.length;
    let done = 0, until = performance.now() + CHUNK_MS;
    for (let k = 0; k < hubs.length; k++) {
      for (const c of cells) {
        if (mine.cancelled) return false;
        let fig;
        try { fig = await screenPair(c, hubs[k], c.now ? hereNow : hereNew); }
        catch (_) { fig = { failed: true, src: 'grid' }; }
        c.grid[k] = fig;
        done++;
        if (performance.now() > until) {
          setStatus('running', `Screening ${cells.length} places against ${hubs.length} repeater${
            hubs.length === 1 ? '' : 's'} — ${Math.round(done / total * 100)}%`);
          await new Promise(r => setTimeout(r, 0));
          until = performance.now() + CHUNK_MS;
        }
      }
    }
    return true;
  }

  // ── The ground round it: trees, roofs, cover ────────────────────────────────

  async function getJson(url, init) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    try {
      const r = await fetch(url, { ...(init || {}), signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function inQld(box) {
    return box.east > QLD_BOX.west && box.west < QLD_BOX.east
        && box.north > QLD_BOX.south && box.south < QLD_BOX.north;
  }

  function lowerWhat(v, fallback) {
    const s = String(v == null ? '' : v).trim().replace(/_/g, ' ').toLowerCase();
    return !s || s === 'yes' ? fallback : s;
  }

  function heightOr(v, d) { const n = Number(v); return isFinite(n) && n > 0.5 && n < 80 ? n : d; }

  // One of the State's four layers over the box, a page at a time. A feature
  // with no geometry is dropped; a layer that answers an error is a source
  // that could not be read, never a source with nothing in it.
  async function qldLayer(L, box) {
    const out = [];
    let capped = false;
    for (let page = 0; page < BLD_PAGES; page++) {
      const q = new URLSearchParams({
        where: L.where, geometry: `${box.west},${box.south},${box.east},${box.north}`,
        geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: L.fields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '7',
        orderByFields: 'objectid', resultOffset: String(page * BLD_PAGE), resultRecordCount: String(BLD_PAGE),
        f: 'json',
      });
      const j = await getJson(`${QLD_BUILDINGS}/${L.id}/query?${q}`);
      if (j && j.error) throw new Error(j.error.message || 'the service refused the query');
      for (const f of (j && j.features) || []) {
        const a = f.attributes || {}, g = f.geometry || {};
        if (L.kind === 'poly' && Array.isArray(g.rings) && g.rings.length) {
          const h = L.id === 11
            ? heightOr(Number(a.bsm_max) - Number(a.dtm_centre), ROOF_H)
            : heightOr(a.maximum_roof_height, heightOr(Number(a.eave_height) + 1, ROOF_H));
          out.push({ kind: 'poly', rings: g.rings.map(r => r.map(p => [p[1], p[0]])), h,
                     what: L.id === 11 ? 'building' : lowerWhat(a.function, 'building'), src: 'qld' });
        } else if (L.kind !== 'poly' && isFinite(g.x) && isFinite(g.y)) {
          const home = L.kind === 'home';
          out.push({ kind: 'point', lat: g.y, lon: g.x, r: home ? HOMESTEAD_R : POINT_R, h: ROOF_H,
                     what: home ? 'homestead' : lowerWhat(a.function, 'building'), src: 'qld' });
        }
      }
      if (!(j && j.exceededTransferLimit)) break;
      if (page === BLD_PAGES - 1) capped = true;
    }
    return { list: out, capped };
  }

  async function osmBuildings(box) {
    const b = `${box.south},${box.west},${box.north},${box.east}`;
    const ql = `[out:json][timeout:25];(way["building"](${b});node["building"](${b}););out geom tags;`;
    let last = null;
    for (const url of OVERPASS) {
      try {
        const j = await getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                       body: 'data=' + encodeURIComponent(ql) });
        const out = [];
        for (const e of (j && j.elements) || []) {
          const t = e.tags || {};
          const lv = Number(t['building:levels']);
          const h = heightOr(String(t.height || '').replace(/[^\d.]/g, ''), isFinite(lv) && lv > 0 ? lv * 3 + 1 : ROOF_H);
          const what = lowerWhat(t.building, 'building');
          if (e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 2) {
            out.push({ kind: 'poly', rings: [e.geometry.map(p => [p.lat, p.lon])], h, what, src: 'osm' });
          } else if (e.type === 'node' && isFinite(e.lat) && isFinite(e.lon)) {
            out.push({ kind: 'point', lat: e.lat, lon: e.lon, r: POINT_R, h, what, src: 'osm' });
          }
        }
        return { list: out, capped: false };
      } catch (e) { last = e; }
    }
    throw last || new Error('no Overpass endpoint answered');
  }

  // Every source asked at once, each answering for itself: one that fails is
  // said to have failed, and the others' buildings still count.
  async function buildingsAround(box) {
    const asks = [];
    if (inQld(box)) for (const L of QLD_LAYERS) asks.push({ label: L.label, p: qldLayer(L, box) });
    asks.push({ label: 'OpenStreetMap buildings', p: osmBuildings(box) });
    const got = await Promise.all(asks.map(a => a.p.then(r => ({ label: a.label, ok: true, list: r.list, capped: r.capped }),
                                                          e => ({ label: a.label, ok: false, list: [], error: reasonOf(e) }))));
    return { sources: got.map(g => ({ label: g.label, ok: g.ok, n: g.list.length, capped: !!g.capped, error: g.error || null })),
             list: got.flatMap(g => g.list), qld: inQld(box) };
  }

  function reasonOf(e) {
    const m = (e && e.message) || String(e || '');
    return /abort/i.test(m) ? 'it did not answer in time' : m || 'unreachable';
  }

  // The canopy lattice: LAT_M apart, out to the circle plus OBST_R, centred on
  // the station so a place's offsets index it directly.
  function latticeFor(st, r) {
    const H = Math.ceil((r + OBST_R) / LAT_M), N = 2 * H + 1;
    const k = metresPerDeg(st.lat);
    const lat = new Array(N * N), lon = new Array(N * N);
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        lat[v * N + u] = st.lat + (v - H) * LAT_M / k.lat;
        lon[v * N + u] = st.lon + (u - H) * LAT_M / k.lon;
      }
    }
    return { H, N, lat, lon, top: new Float32Array(N * N), kind: new Uint8Array(N * N), canopyOk: false };
  }

  async function siteData(st, r, cells) {
    const lat = latticeFor(st, r);
    const box = boxAround(st, r + OBST_R);
    const [canopy, cover, bld] = await Promise.all([
      LandCover.canopyAt(lat.lat, lat.lon).catch(() => null),
      LandCover.sample(cells.map(c => c.lat), cells.map(c => c.lon)).catch(e => ({ ok: false, error: reasonOf(e) })),
      buildingsAround(box).catch(e => ({ sources: [], list: [], error: reasonOf(e) })),
    ]);
    if (Array.isArray(canopy)) {
      lat.canopyOk = canopy.some(v => v != null);
      canopy.forEach((h, n) => { if (h != null && h >= TREE_MIN_M) { lat.top[n] = h; lat.kind[n] = 1; } });
    }
    lat.lat = lat.lon = null;            // coordinates done with; the lattice is offsets from here on
    const k = metresPerDeg(st.lat);
    const local = (la, lo) => [(lo - st.lon) * k.lon, (la - st.lat) * k.lat];
    for (const b of bld.list) {
      if (b.kind === 'poly') {
        b.xy = b.rings.map(ring => ring.map(p => local(p[0], p[1])));
        const xs = b.xy[0].map(p => p[0]), ys = b.xy[0].map(p => p[1]);
        b.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        b.cx = (b.bbox[0] + b.bbox[2]) / 2; b.cy = (b.bbox[1] + b.bbox[3]) / 2;
      } else {
        [b.cx, b.cy] = local(b.lat, b.lon);
        b.bbox = [b.cx - b.r, b.cy - b.r, b.cx + b.r, b.cy + b.r];
      }
    }
    rasterise(lat, bld.list);
    return { lattice: lat, cover, buildings: bld, index: bucketIndex(bld.list) };
  }

  function inRings(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a], [xb, yb] = ring[b];
        if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside;
      }
    }
    return inside;
  }

  function segDist(x, y, xa, ya, xb, yb) {
    const dx = xb - xa, dy = yb - ya, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - xa) * dx + (y - ya) * dy) / L2)) : 0;
    return Math.hypot(x - xa - t * dx, y - ya - t * dy);
  }

  // How far a place is from a building's walls — nought inside it.
  function distTo(b, x, y) {
    if (b.kind === 'point') return Math.max(0, Math.hypot(x - b.cx, y - b.cy) - b.r);
    if (inRings(b.xy, x, y)) return 0;
    let d = Infinity;
    for (const ring of b.xy) {
      for (let a = 0, z = ring.length - 1; a < ring.length; z = a++) {
        d = Math.min(d, segDist(x, y, ring[z][0], ring[z][1], ring[a][0], ring[a][1]));
      }
    }
    return d;
  }

  // Every building onto the lattice, with its roof height: the lattice points
  // inside it, and — a shed smaller than the lattice holds none — at least the
  // one nearest its middle, so no mapped building is too small to cast a
  // shadow on the gauge.
  function rasterise(L, list) {
    const at = (x, y) => [Math.round(x / LAT_M) + L.H, Math.round(y / LAT_M) + L.H];
    const mark = (u, v, h) => {
      if (u < 0 || v < 0 || u >= L.N || v >= L.N) return;
      const n = v * L.N + u;
      if (h > L.top[n]) L.top[n] = h;
      L.kind[n] = 2;
    };
    for (const b of list) {
      const [u0, v0] = at(b.bbox[0], b.bbox[1]), [u1, v1] = at(b.bbox[2], b.bbox[3]);
      let any = false;
      for (let v = Math.max(0, v0); v <= Math.min(L.N - 1, v1); v++) {
        for (let u = Math.max(0, u0); u <= Math.min(L.N - 1, u1); u++) {
          const x = (u - L.H) * LAT_M, y = (v - L.H) * LAT_M;
          if (b.kind === 'point' ? Math.hypot(x - b.cx, y - b.cy) <= b.r : inRings(b.xy, x, y)) { mark(u, v, b.h); any = true; }
        }
      }
      if (!any) { const [u, v] = at(b.cx, b.cy); mark(u, v, b.h); }
    }
  }

  // Buildings by 50 m square, so the nearest to a place is a look at the
  // squares round it rather than at every building in the circle.
  const BUCKET = 50;
  function bucketIndex(list) {
    const idx = new Map();
    list.forEach((b, n) => {
      for (let y = Math.floor(b.bbox[1] / BUCKET); y <= Math.floor(b.bbox[3] / BUCKET); y++) {
        for (let x = Math.floor(b.bbox[0] / BUCKET); x <= Math.floor(b.bbox[2] / BUCKET); x++) {
          const k = `${x},${y}`;
          if (!idx.has(k)) idx.set(k, []);
          idx.get(k).push(n);
        }
      }
    });
    return idx;
  }

  function nearestBuilding(site, x, y) {
    const list = site.buildings.list;
    const reach = Math.ceil(NEAR_BLD_M / BUCKET);
    const bx = Math.floor(x / BUCKET), by = Math.floor(y / BUCKET);
    const seen = new Set();
    let best = null;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (const n of site.index.get(`${bx + dx},${by + dy}`) || []) {
          if (seen.has(n)) continue;
          seen.add(n);
          const d = distTo(list[n], x, y);
          if (d <= NEAR_BLD_M && (!best || d < best.dM)) best = { dM: d, what: list[n].what, src: list[n].src };
        }
      }
    }
    return best;
  }

  function wmoOf(angle) { return WMO.find(w => angle <= w.max) || WMO[WMO.length - 1]; }

  // The gauge's view from one place: the steepest tree or roof within OBST_R
  // above its rim, and how much of the ground within COVER_R stands up.
  function exposureAt(L, x, y, rim) {
    const u0 = Math.round(x / LAT_M) + L.H, v0 = Math.round(y / LAT_M) + L.H;
    const reach = Math.ceil(OBST_R / LAT_M);
    let angle = 0, obst = null, under = false, covered = 0, total = 0;
    for (let v = v0 - reach; v <= v0 + reach; v++) {
      if (v < 0 || v >= L.N) continue;
      for (let u = u0 - reach; u <= u0 + reach; u++) {
        if (u < 0 || u >= L.N) continue;
        const d = Math.hypot((u - L.H) * LAT_M - x, (v - L.H) * LAT_M - y);
        if (d > OBST_R) continue;
        const n = v * L.N + u, h = L.top[n];
        if (d <= COVER_R) { total++; if (h >= TREE_MIN_M) covered++; }
        if (!(h > rim)) continue;
        // The place's own 10 m square: a tree there is a gauge under it.
        if (d < LAT_M * 0.75 && h >= TREE_MIN_M) {
          under = true;
          if (!obst || obst.d > d) obst = { kind: L.kind[n] === 2 ? 'roof' : 'tree', h, d };
          continue;
        }
        const a = Math.atan((h - rim) / Math.max(d, LAT_M / 2)) * 180 / Math.PI;
        if (a > angle) { angle = a; if (!under) obst = { kind: L.kind[n] === 2 ? 'roof' : 'tree', h, d }; }
      }
    }
    if (under) angle = 90;
    return { angle, obst, under, coverFrac: total ? covered / total : 0 };
  }

  // What the ground says about every place, from what was read once. Re-run,
  // with nothing fetched, when the clearance or the rim moves.
  function applySite() {
    if (!found || !found.site) return;
    const site = found.site, rim = rimM(), clear = clearM();
    const coverOk = site.cover && site.cover.ok;
    for (let n = 0; n < found.cells.length; n++) {
      const c = found.cells[n];
      const ex = exposureAt(site.lattice, c.x, c.y, rim);
      c.angle = ex.angle; c.obst = ex.obst; c.under = ex.under; c.coverFrac = ex.coverFrac;
      c.wmo = wmoOf(ex.angle).cls;
      c.bld = nearestBuilding(site, c.x, c.y);
      c.cls = coverOk ? site.cover.cls[n] : null;
      c.excluded = c.now ? null
                 : c.bld && c.bld.dM < clear ? 'building'
                 : c.cls === 1 ? 'water' : null;
    }
  }

  // ── The score ───────────────────────────────────────────────────────────────

  function weights() {
    const w = x => Math.max(0, Math.min(5, +cfg[x] || 0));
    return { f: w('wFade'), s: w('wSky'), c: w('wClear'), n: w('wNear') };
  }

  function figOf(c, k, fine) {
    if (fine && c.fine[k]) return c.fine[k];
    return c.grid[k] || null;
  }

  function scoreOf(c, fine) {
    const n = found.hubs.length, O = okDb(), G = goodDb();
    let worst = null, wk = null, ok = 0, failed = 0, src = { card: 0, bare: 0, grid: 0 };
    for (let k = 0; k < n; k++) {
      const fig = figOf(c, k, fine);
      if (!fig || fig.failed || fig.margin == null) { failed++; continue; }
      src[fig.src] = (src[fig.src] || 0) + 1;
      if (fig.margin >= O) ok++;
      if (worst == null || fig.margin < worst) { worst = fig.margin; wk = k; }
    }
    const lo = O - 6, hi = G + 10;
    const parts = {
      F: worst == null || failed ? 0 : Math.max(0, Math.min(1, (worst - lo) / (hi - lo))),
      S: found.site.lattice.canopyOk ? (5 - c.wmo) / 4 : null,
      C: found.site.lattice.canopyOk ? (c.cls === 7 ? 0 : 1 - c.coverFrac) : null,
      N: Math.max(0, 1 - c.dM / found.rM),
    };
    const w = weights();
    let num = 0, den = 0;
    for (const [p, wt] of [['F', w.f], ['S', w.s], ['C', w.c], ['N', w.n]]) {
      if (parts[p] == null) continue;
      num += wt * parts[p]; den += wt;
    }
    return { ...parts, score: den > 0 ? 100 * num / den : 0, worst: failed ? null : worst, wk,
             ok, failed, allOk: !failed && ok === n, src };
  }

  const byRank = (a, b) => (b.s.allOk - a.s.allOk) || (b.s.score - a.s.score) || (a.c.dM - b.c.dM);

  function spacingM() { return Math.max(2 * found.step, found.rM / 4); }

  // The finalists come off the screened figures alone — the whole lattice on
  // one footing — spaced as they are picked, so the few refined are a few
  // places worth walking to rather than five squares of one paddock.
  function finalists() {
    const want = count() + SPARE, sep = spacingM();
    const out = [];
    const pool = found.cells.filter(c => !c.now && !c.excluded && c.grid.some(f => f && !f.failed));
    for (const x of pool.map(c => ({ c, s: scoreOf(c, false) })).sort(byRank)) {
      if (out.length >= want) break;
      if (out.every(y => Math.hypot(x.c.x - y.x, x.c.y - y.y) >= sep)) out.push(x.c);
    }
    return out;
  }

  // ── Running it ──────────────────────────────────────────────────────────────

  function readiness() {
    if (!state.data) return { ok: false, why: 'No stations are loaded.' };
    const st = station();
    if (!st) return { ok: false, why: 'Pick the station that has to move — find it by name or number, or use the one on the station card.' };
    if (st.lat == null || st.lon == null) return { ok: false, why: `${st.name} has no position on file to move from.` };
    const here = hereRadio(st);
    if (!here) return { ok: false, why: 'No radio system on file carries all four of transmit power, antenna gain, line loss and receiver threshold — there is no margin to compute.' };
    const hubs = hubChoices(st).filter(h => ticks.has(h.s.id)).map(h => hubOf(h.s)).filter(Boolean);
    if (!hubs.length) {
      return { ok: false, why: hubChoices(st).some(h => h.listening)
        ? 'Tick at least one repeater with a complete radio on file.'
        : `No repeater on file carries ${st.name}'s addresses — tick one of the repeaters or bases near it.` };
    }
    return { ok: true, st, here, hubs };
  }

  async function lanes(list, n, fn, mine) {
    let i = 0;
    const lane = async () => { while (i < list.length && !mine.cancelled) await fn(list[i++]); };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, lane));
  }

  async function run() {
    const r = readiness();
    if (!r.ok) { setStatus('blocked', r.why); return false; }
    if (job) job.cancelled = true;
    found = null; results = []; selected = null; rerankDue = false;
    const mine = job = { cancelled: false };
    const { st, here, hubs } = r;
    const rM = radiusM(), step = stepFor(rM);
    const cells = cellsFor(st, rM, step);
    const hereNew = cfg.agl > 0 ? { ...here, agl: +cfg.agl } : here;
    draw();
    render();
    rerenderMapLegend();
    setStatus('running', 'Fetching the terrain under the paths…');
    // The ground round the station is three services that wait on nothing the
    // radio does, so they are asked first and answer while the screen runs.
    const siteP = siteData(st, rM, cells).catch(e => ({ failed: reasonOf(e) }));
    try {
      const ok = await screen(mine, cells, hubs, here, hereNew);
      if (!ok || mine.cancelled) return false;
      setStatus('running', 'Reading the trees, the buildings and the land cover round it…');
      const site = await siteP;
      if (mine.cancelled) return false;
      if (site.failed) { job = null; setStatus('blocked', site.failed); return false; }
      const nowCell = cells.find(c => c.now);
      found = { st, here, hereNew, hubs, cells, step, rM, site, now: nowCell, finals: [],
                byId: new Map(cells.map(c => [c.id, c])) };
      applySite();
      return await refine(mine);
    } catch (e) {
      if (mine.cancelled) return false;
      job = null;
      setStatus('blocked', reasonOf(e));
      return false;
    }
  }

  // The card's own figure for one place and one hub: pathGround's ground at
  // the card's sample count, the land cover on it under the land-cover model.
  // A profile with holes, or cover that cannot be had where the model needs
  // it, is refused (MapFade's rule) and the screened figure stands. Where it
  // is now goes in on its surveyed height, so its figure is the card's for the
  // link the station has today.
  async function finePair(c, hub) {
    const here = c.now ? found.here : found.hereNew;
    const dKm = acmaHaversineKm(c.lat, c.lon, hub.lat, hub.lon);
    const got = await pathGround(
      { lat: c.lat, lon: c.lon, elev: c.now && found.st.elevation_ahd != null ? found.st.elevation_ahd : null, agl: here.agl, mast: false },
      { lat: hub.lat, lon: hub.lon, elev: hub.elev, agl: hub.rad.agl, mast: hub.mast },
      { samples: FINE_SAMPLES, freqMhz: hub.f });
    if (!got || !got.ok || got.prof.partial) return null;
    const coverModel = pathPropOf().model === 'cover';
    const res = coverModel ? await LandCover.sample(got.prof.lat, got.prof.lon) : null;
    if (coverModel && !(res && res.ok)) return null;
    const an = pathAnalyse(got.prof, {
      elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: here.agl, aglB: hub.rad.agl, freqMhz: hub.f,
      cover: res ? res.cls : null, canopy: res && res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return null;
    return { dKm, verdict: an.verdict, margin: marginOf(an, here, hub), src: 'card' };
  }

  async function refine(mine) {
    const finals = finalists();
    const todo = [];
    for (const c of [found.now].concat(finals)) {
      for (let k = 0; k < found.hubs.length; k++) if (c.fine[k] === undefined) todo.push([c, k]);
    }
    let done = 0;
    const tell = () => setStatus('running', `Checking where it is now and the ${finals.length} best the link budget card's way — ${done} of ${todo.length} paths`);
    tell();
    await lanes(todo, CONCURRENCY, async ([c, k]) => {
      let fig = null;
      try { fig = await finePair(c, found.hubs[k]); } catch (_) { fig = null; }
      if (mine.cancelled) return;
      c.fine[k] = fig;                    // null: tried, and the screened figure stands
      done++;
      tell();
    }, mine);
    if (mine.cancelled) return false;
    found.finals = finals;
    rank();
    job = null;
    setStatus('done', '');
    // A weight, the clearance or the rim that moved while this pass was running
    // picked no finalists of its own; now that the lattice is free, it does.
    if (rerankDue) { rerankDue = false; applySite(); rerank(); }
    return true;
  }

  function rank() {
    const keep = selected;
    results = found.finals.map(c => ({ c, s: scoreOf(c, true) })).sort(byRank)
      .slice(0, count()).map((x, i) => ({ rank: i + 1, c: x.c, s: x.s }));
    found.nowScore = scoreOf(found.now, true);
    selected = keep && (keep === found.now || results.some(x => x.c === keep)) ? keep
             : results.length ? results[0].c : null;
    draw();
    render();
    rerenderMapLegend();
  }

  function invalidate() {
    if (job) job.cancelled = true;
    job = null;
    found = null; results = []; selected = null;
    rerankDue = false;
    status = { kind: 'idle', text: '' };
    hideTip();
  }

  function rerank() {
    if (!found || job) return;
    const mine = job = { cancelled: false };
    refine(mine);
  }

  // ── Words ───────────────────────────────────────────────────────────────────

  function dbText(v) { return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function whereFrom(c) {
    if (c.now) return 'where it is now';
    const brg = bearingDeg(found.st.lat, found.st.lon, c.lat, c.lon);
    return `${Math.round(c.dM)} m ${COMPASS[Math.round(((brg % 360) + 360) % 360 / 45) % 8]} of where it is`;
  }

  function bandOf(fig) {
    if (!fig || fig.failed || fig.margin == null) return 'none';
    return fig.margin >= goodDb() ? 'good' : fig.margin >= okDb() ? 'ok' : 'bad';
  }
  function bandColour(b) { return cssVar(BAND[b][0], BAND[b][1]); }

  function a(w) { return /^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`; }

  function skyText(c) {
    if (!found.site.lattice.canopyOk) return '<span class="txt-warn">Open sky not judged — the tree heights could not be read.</span>';
    const o = c.obst;
    const what = !o ? '' : o.kind === 'roof' ? `a roof ${Math.round(o.h)} m high` : `a tree ${Math.round(o.h)} m tall`;
    if (c.under) return `<span class="txt-bad">WMO class 5 — under the canopy${o && o.kind === 'roof' ? ' (on a mapped roof)' : ''}.</span>`;
    if (!o) return `<span class="txt-ok">WMO class 1 — nothing above the gauge rim within ${OBST_R} m.</span>`;
    const cls = c.wmo <= 2 ? 'txt-ok' : c.wmo === 3 ? 'txt-warn' : 'txt-bad';
    return `<span class="${cls}">WMO class ${c.wmo}</span> — ${what} ${Math.round(o.d)} m away, ${c.angle.toFixed(0)}° above the rim.`;
  }

  const CLASS_WORDS = { 1: 'water', 2: 'trees', 4: 'flooded vegetation', 5: 'crops', 7: 'built-up',
                        8: 'bare ground', 9: 'snow', 10: 'cloud', 11: 'rangeland' };

  function groundText(c) {
    const bits = [];
    if (found.site.lattice.canopyOk) bits.push(`Trees or roofs on ${Math.round(c.coverFrac * 100)}% of the ground within ${COVER_R} m`);
    if (c.cls != null) bits.push(`land cover ${CLASS_WORDS[c.cls] || 'unclassified'}`);
    const b = c.bld;
    bits.push(b ? `nearest building ${a(b.what)} ${b.dM < 0.5 ? 'here' : `${Math.round(b.dM)} m away`}`
                : `no building mapped within ${NEAR_BLD_M} m`);
    return bits.join(' · ');
  }

  function excludedText(why) {
    return why === 'building' ? `on or within ${clearM()} m of a mapped building`
         : why === 'water' ? 'in water, by the land cover' : '';
  }

  function summaryHtml(c, s) {
    const n = found.hubs.length;
    const nowW = found.nowScore ? found.nowScore.worst : null;
    const delta = !c.now && s.worst != null && nowW != null ? s.worst - nowW : null;
    return `
      <span>Fade margin worst <strong>${dbText(s.worst)}</strong>${s.wk != null ? ` (${esc(found.hubs[s.wk].name)})` : ''}${
        delta != null ? ` · <span class="${delta >= 0 ? 'txt-ok' : 'txt-warn'}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)} dB on now</span>` : ''}</span>
      <span>${s.allOk ? `Every repeater at ${okDb()} dB or better`
        : `<span class="txt-bad">${n - s.ok} of ${n} below ${okDb()} dB${s.failed ? ` or not computed` : ''}</span>`}</span>`;
  }

  function sourceText(s) {
    const n = found.hubs.length;
    const bits = [];
    if (s.src.card) bits.push(`${s.src.card === n ? (n === 1 ? 'The path' : `All ${n} paths`) : `${s.src.card} of ${n} paths`} priced the link budget card's way`);
    if (s.src.grid) bits.push(`<span class="txt-warn">${s.src.grid} screened only — the card's figure would not compute</span>`);
    if (s.failed) bits.push(`<span class="txt-warn">${s.failed} could not be computed</span>`);
    return bits.join(' · ');
  }

  function partsText(s) {
    const p = v => (v == null ? '—' : Math.round(v * 100));
    return `Fade margin ${p(s.F)} · open sky ${p(s.S)} · clear ground ${p(s.C)} · close by ${p(s.N)} — out of 100 each, before the weights`;
  }

  // ── Painting the ground ─────────────────────────────────────────────────────

  function scoreSpan() {
    const v = found.cells.filter(c => !c.excluded).map(c => scoreOf(c, false).score);
    if (!v.length) return { lo: 0, hi: 100 };
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 10) { const m = (hi + lo) / 2; lo = Math.max(0, m - 5); hi = Math.min(100, lo + 10); lo = hi - 10; }
    return { lo, hi };
  }

  // A place to the colour it is painted, or null to leave it unpainted.
  function colourFn() {
    const mode = PAINTS[cfg.paint] ? cfg.paint : 'score';
    if (mode === 'margin') {
      const col = { good: bandColour('good'), ok: bandColour('ok'), bad: bandColour('bad') };
      return c => { const s = scoreOf(c, false); return s.worst == null ? null : col[s.worst >= goodDb() ? 'good' : s.worst >= okDb() ? 'ok' : 'bad']; };
    }
    if (mode === 'change') {
      const base = scoreOf(found.now, false).worst;
      return c => {
        const w = scoreOf(c, false).worst;
        if (w == null || base == null) return null;
        const d = w - base;
        return (DIV.find(x => d >= x.lo && d < x.hi) || DIV[DIV.length - 1]).c;
      };
    }
    const sp = scoreSpan();
    return c => {
      const s = scoreOf(c, false).score;
      const t = (s - sp.lo) / (sp.hi - sp.lo);
      return SEQ[Math.max(0, Math.min(SEQ.length - 1, Math.floor(Math.min(0.9999, Math.max(0, t)) * SEQ.length)))];
    };
  }

  function clearWash() { if (wash) { wash.remove(); wash = null; } }

  function paintWash() {
    clearWash();
    if (!map || !found) return;
    const k = metresPerDeg(found.st.lat);
    const half = found.rM + found.step / 2;
    const box = boxAround(found.st, half);
    const across = 2 * Math.ceil(found.rM / found.step) + 1;
    const px = Math.max(4, Math.floor(900 / across));
    const W = across * px;
    const cv = document.createElement('canvas');
    cv.width = cv.height = W;
    const cx = cv.getContext('2d');
    const colour = colourFn();
    const toX = lon => (lon - box.west) / (box.east - box.west) * W;
    const toY = lat => (box.north - lat) / (box.north - box.south) * W;
    const dLon = found.step / k.lon / 2, dLat = found.step / k.lat / 2;
    for (const c of found.cells) {
      const x0 = toX(c.lon - dLon), x1 = toX(c.lon + dLon), y0 = toY(c.lat + dLat), y1 = toY(c.lat - dLat);
      if (c.excluded) {
        cx.fillStyle = OUT_FILL;
        cx.fillRect(x0, y0, x1 - x0 + 0.5, y1 - y0 + 0.5);
        // The texture: a hatch at 45°, so ruled out reads without the grey.
        cx.save();
        cx.beginPath(); cx.rect(x0, y0, x1 - x0, y1 - y0); cx.clip();
        cx.strokeStyle = OUT_LINE; cx.lineWidth = Math.max(1, px / 6);
        cx.beginPath();
        for (let t = -px; t < 2 * px; t += Math.max(3, px / 2.5)) { cx.moveTo(x0 + t, y1); cx.lineTo(x0 + t + px, y0); }
        cx.stroke();
        cx.restore();
        continue;
      }
      const fill = colour(c);
      if (!fill) continue;
      cx.fillStyle = fill;
      cx.fillRect(x0, y0, x1 - x0 + 0.5, y1 - y0 + 0.5);
    }
    wash = L.imageOverlay(cv.toDataURL('image/png'), [[box.south, box.west], [box.north, box.east]],
                          { pane: WASH_PANE, opacity: opacity(), interactive: false }).addTo(map);
  }

  function opacity() { const v = +cfg.opacity; return isFinite(v) ? Math.max(0.1, Math.min(1, v)) : 0.6; }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    if (layer) { layer.remove(); layer = null; }
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }
    clearWash();
  }

  function pinIcon(r) {
    return L.divIcon({
      className: 'mn-site-icon',
      html: `<span class="mn-site${selected === r.c ? ' is-on' : ''}">`
          + `<b class="mn-site-h">${Math.round(r.s.score)}</b>`
          + `<i class="mn-site-mark" aria-hidden="true">${r.rank}</i></span>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function draw() {
    let hadFocus = null;
    if (layer && document.activeElement) {
      layer.eachLayer(l => { if (l.getElement && l.getElement() === document.activeElement) hadFocus = l.mnRelocRank; });
    }
    clearLayers();
    const st = found ? found.st : station();
    if (!map || !st || st.lat == null || st.lon == null) return;
    lineLayer = L.layerGroup([], { pane: LINE_PANE }).addTo(map);
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    const accent = cssVar('--accent', '#0b5cab');
    L.circle([st.lat, st.lon], {
      pane: LINE_PANE, radius: found ? found.rM : radiusM(), color: accent, weight: 1.5, opacity: 0.9,
      dashArray: '6 6', fill: false, interactive: false,
    }).addTo(lineLayer);
    L.circleMarker([st.lat, st.lon], {
      pane: LINE_PANE, radius: 9, color: accent, weight: 2.5, opacity: 0.95, fill: false, interactive: false,
    }).addTo(lineLayer);
    if (!found) return;
    paintWash();
    // The buildings it found, so "kept off the shed" can be checked by eye
    // against the imagery under them — white with a dark hairline, because
    // they are read against a base map, which is not themed.
    for (const b of found.site.buildings.list) {
      if (Math.hypot(b.cx, b.cy) > found.rM + OBST_R) continue;
      const style = { pane: LINE_PANE, color: '#ffffff', weight: 1.5, opacity: 0.95, fillColor: '#000000',
                      fillOpacity: 0.25, interactive: false };
      if (b.kind === 'poly') L.polygon(b.rings, style).addTo(lineLayer);
      else L.circle([b.lat, b.lon], { ...style, radius: b.r }).addTo(lineLayer);
    }
    const sel = selected;
    if (sel) {
      found.hubs.forEach((h, k) => {
        const fig = figOf(sel, k, true);
        if (!fig || fig.failed) return;
        L.polyline([[sel.lat, sel.lon], [h.lat, h.lon]], {
          pane: LINE_PANE, color: bandColour(bandOf(fig)), weight: 3, opacity: 0.9,
          dashArray: fig.verdict === 'obstructed' ? '7 6' : null, interactive: false,
        }).addTo(lineLayer);
      });
    }
    for (const r of results) {
      const pin = L.marker([r.c.lat, r.c.lon], {
        icon: pinIcon(r), pane: PANE, riseOnHover: true,
        title: `New site #${r.rank} — ${whereFrom(r.c)}, score ${Math.round(r.s.score)}`,
      }).bindPopup(() => popupHtml(r), { maxWidth: 320 })
        .on('click', () => select(r.rank, { keepPopup: true }));
      pin.mnRelocRank = r.rank;
      pin.addTo(layer);
      if (hadFocus === r.rank && pin.getElement()) pin.getElement().focus({ preventScroll: true });
    }
  }

  function popupHtml(r) {
    const c = r.c;
    const pt = { lat: c.lat, lon: c.lon, name: `New site ${r.rank}` };
    return `
      <div class="mn-site-pop">
        <h4>#${r.rank} new site · score ${Math.round(r.s.score)}</h4>
        <p class="small">${esc(stationLatLonText(c))} — ${esc(whereFrom(c))}<br>
          ${summaryHtml(c, r.s)}<br>${skyText(c)}<br>${esc(groundText(c))}</p>
        <div class="pill-row pill-list">
          ${copyLatLonPillHtml(pt)}
          ${mapViewPills(pt).join('\n          ')}
        </div>
      </div>`;
  }

  // ── The hover ───────────────────────────────────────────────────────────────
  // Every painted square answers what it is when pointed at — the figure the
  // colour stands for and the three things beside it — so the wash can be
  // read rather than only looked at.

  function cellAt(ll) {
    if (!found) return null;
    const k = metresPerDeg(found.st.lat);
    const x = (ll.lng - found.st.lon) * k.lon, y = (ll.lat - found.st.lat) * k.lat;
    if (Math.hypot(x, y) > found.rM + found.step / 2) return null;
    return found.byId.get(`${Math.round(x / found.step)},${Math.round(y / found.step)}`) || null;
  }

  function tipHtml(c) {
    const s = scoreOf(c, false);
    const r = results.find(x => x.c === c);
    const sky = !found.site.lattice.canopyOk ? '' : c.under ? 'under the canopy' : `WMO class ${c.wmo}`;
    return `<strong>${r ? `#${r.rank} · ` : ''}${esc(whereFrom(c))}</strong><br>${
      c.excluded ? `Ruled out — ${esc(excludedText(c.excluded))}<br>` : `Score ${Math.round(s.score)}<br>`}Worst ${
      dbText(s.worst)}${s.wk != null ? ` (${esc(found.hubs[s.wk].name)})` : ''}${sky ? ` · ${sky}` : ''}<br>${esc(groundText(c))}`;
  }

  function onMove(e) {
    tipAt = e.latlng;
    if (tipFrame) return;
    tipFrame = requestAnimationFrame(() => {
      tipFrame = 0;
      const c = tipAt && cellAt(tipAt);
      if (!c || !map) { hideTip(); return; }
      if (tip && tip.mnCell === c.id) return;
      hideTip();
      tip = L.tooltip({ direction: 'top', offset: [0, -8], className: 'reloc-tip', opacity: 0.95 })
        .setLatLng([c.lat, c.lon]).setContent(tipHtml(c));
      tip.mnCell = c.id;
      map.openTooltip(tip);
    });
  }

  function hideTip() {
    if (tip && map) map.closeTooltip(tip);
    tip = null;
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  function setStatus(kind, text) {
    status = { kind, text: text || '' };
    const el = document.getElementById('reloc-status');
    if (el) el.innerHTML = statusHtml();
    const btn = document.getElementById('reloc-run');
    if (btn) btn.disabled = kind === 'running' || !readiness().ok;
    const cancel = document.getElementById('reloc-cancel');
    if (cancel) cancel.hidden = kind !== 'running';
  }

  function sourcesText() {
    const b = found.site.buildings;
    const parts = (b.sources || []).map(s => (s.ok
      ? `${s.label} ${s.n}${s.capped ? ' (more than it would hand over — a floor)' : ''}`
      : `<span class="txt-warn">${esc(s.label)} could not be read — ${esc(s.error || 'no answer')}</span>`));
    const cov = found.site.cover;
    return `Buildings: ${parts.join(' · ') || 'none asked'}${b.qld ? '' : ' — outside Queensland only OpenStreetMap is asked'}.
      Trees: ${found.site.lattice.canopyOk ? 'the 2020 canopy height map, 10 m'
        : '<span class="txt-warn">the canopy height map could not be read — open sky and clear ground are left out of the score</span>'}.
      Land cover: ${cov && cov.ok ? `Sentinel-2 ${esc(String(cov.year))}` : '<span class="txt-warn">could not be read — water is not ruled out</span>'}.`;
  }

  function statusHtml() {
    switch (status.kind) {
      case 'running': return `<span class="sites-run">${esc(status.text)}</span>`;
      case 'blocked': return `<span class="txt-warn">${esc(status.text)}</span>`;
      case 'done': {
        if (!found) return '';
        const out = found.cells.filter(c => c.excluded);
        const nb = out.filter(c => c.excluded === 'building').length, nw = out.filter(c => c.excluded === 'water').length;
        // The station has to move, so where it is now is not a candidate —
        // but if every place offered is heard worse than it is today, that is
        // the first thing to know before anybody walks to one.
        const nowW = found.nowScore ? found.nowScore.worst : null;
        const bestW = Math.max(-Infinity, ...results.map(r => (r.s.worst == null ? -Infinity : r.s.worst)));
        const worse = nowW != null && isFinite(bestW) && bestW < nowW - 0.05;
        return `Screened ${found.cells.length} places ${found.step} m apart within ${found.rM} m of ${esc(found.st.name)},
          to ${found.hubs.length} repeater${found.hubs.length === 1 ? '' : 's'}, over terrain sampled every ~${SCREEN_STEP_M} m;
          where it is now and the best ${found.finals.length} checked the link budget card's way.
          ${out.length ? `${out.length} ruled out — ${[nb ? `${nb} on or beside a building` : '', nw ? `${nw} in water` : ''].filter(Boolean).join(', ')}.` : ''}
          ${worse ? ` <strong>Every place suggested is heard less well than where it stands now</strong> — the best by
            ${(nowW - bestW).toFixed(1)} dB.` : ''}
          Station radio ${esc(found.here.sysName)}${found.here.assumed ? ' (assumed — none of its own on file)' : ''},
          ${found.hereNew.agl} m AGL at a new site.<br>${sourcesText()}`;
      }
      default: {
        const r = readiness();
        return r.ok ? '' : `<span class="txt-muted">${esc(r.why)}</span>`;
      }
    }
  }

  function num(id, label, value, step, unit, min, max, placeholder) {
    return `
      <label class="draw-field">
        <span>${esc(label)}</span>
        <input type="number" id="reloc-${id}" value="${value == null ? '' : value}" step="${step}"${
          min == null ? '' : ` min="${min}"`}${max == null ? '' : ` max="${max}"`}${
          placeholder ? ` placeholder="${escAttr(placeholder)}"` : ''}
               onchange="MapRelocate.set('${id}', this.value)">
        ${unit ? `<b class="lb-flag">${esc(unit)}</b>` : ''}
      </label>`;
  }

  function hits() {
    const q = hitQ.trim().toLowerCase();
    if (!q) return [];
    return stations().filter(s => s.lat != null && s.lon != null
        && ((s.name || '').toLowerCase().includes(q) || String(s.station_number || '').toLowerCase().includes(q)))
      .slice(0, HIT_CAP);
  }

  function hitsHtml() {
    const list = hits();
    if (!hitQ.trim()) return '';
    return list.map(s => `
      <button type="button" class="polar-hit${s.id === stationId ? ' is-here' : ''}"
              onclick="MapRelocate.pickStation('${escAttr(s.id)}')">
        <span>${esc(s.name)}</span>
        <span class="small txt-muted">${esc(s.station_number || '')}</span>
      </button>`).join('') || '<p class="small txt-muted">No station by that name.</p>';
  }

  function hubsHtml(st) {
    const list = hubChoices(st);
    if (!list.length) return '<p class="small txt-muted">No repeater carries it, and none is within 60 km.</p>';
    return `<ul class="reloc-hubs" aria-label="Repeaters the new site has to reach">${list.map((h, n) => {
      const ok = !!hubOf(h.s);
      const k = found ? found.hubs.findIndex(x => x.id === h.s.id) : -1;
      const now = k >= 0 ? figOf(found.now, k, true) : null;
      const first = n === 0 || list[n - 1].listening !== h.listening;
      return `${first ? `<li class="reloc-hubs-head small txt-muted">${h.listening ? 'Carrying it now' : 'Nearby, not carrying it'}</li>` : ''}
        <li>
          <label class="filter-check">
            <input type="checkbox" ${ticks.has(h.s.id) ? 'checked' : ''} ${ok ? '' : 'disabled'}
                   onchange="MapRelocate.toggleHub('${escAttr(h.s.id)}', this.checked)">
            <span>${esc(h.s.name)} <span class="small txt-muted">${h.km.toFixed(1)} km${
              ok ? '' : ' · no complete radio on file'}${now ? ` · now <span class="sites-band sites-band-${bandOf(now)}">${dbText(now.margin)}</span>` : ''}</span></span>
          </label>
        </li>`;
    }).join('')}</ul>`;
  }

  function keyHtml() {
    if (!found) return '';
    const mode = PAINTS[cfg.paint] ? cfg.paint : 'score';
    let rows;
    if (mode === 'margin') {
      rows = [[bandColour('good'), `${goodDb()} dB or better`], [bandColour('ok'), `${okDb()} to ${goodDb()} dB`],
              [bandColour('bad'), `under ${okDb()} dB`]];
    } else if (mode === 'change') {
      rows = DIV.map(d => [d.c, !isFinite(d.lo) ? `${d.hi} dB or worse` : !isFinite(d.hi) ? `+${d.lo} dB or better`
                                 : d.lo === -1 ? 'within a decibel' : `${d.lo > 0 ? '+' : ''}${d.lo} to ${d.hi > 0 ? '+' : ''}${d.hi} dB`]).reverse();
    } else {
      const sp = scoreSpan();
      rows = SEQ.map((c, i) => [c, `${Math.round(sp.lo + (sp.hi - sp.lo) * i / SEQ.length)}–${
        Math.round(sp.lo + (sp.hi - sp.lo) * (i + 1) / SEQ.length)}`]).reverse();
    }
    rows.push([OUT_FILL, 'ruled out — on or beside a building, or in water', true]);
    return `<ul class="reloc-key">${rows.map(([c, t, hatch]) => `
      <li><i class="${hatch ? 'reloc-hatch' : ''}" style="--dot:${escAttr(c)}"></i><span>${esc(t)}</span></li>`).join('')}</ul>`;
  }

  function resultHtml(r) {
    const on = selected === r.c;
    return `
      <li class="sites-result${on ? ' is-on' : ''}">
        <button type="button" class="sites-result-main" onclick="MapRelocate.select(${r.rank})"
                aria-pressed="${on ? 'true' : 'false'}"
                title="Show this place's paths on the map, and its figure for every repeater">
          <span class="sites-rank" aria-hidden="true">${r.rank}</span>
          <span class="sites-result-text">
            <strong>${esc(whereFrom(r.c))}</strong> · score ${Math.round(r.s.score)}
            <span class="small txt-muted">${esc(stationLatLonText(r.c))}${r.c.ground != null ? ` · ground ~${Math.round(r.c.ground)} m` : ''}</span>
            <span class="small sites-result-sum">${summaryHtml(r.c, r.s)}</span>
            <span class="small">${skyText(r.c)}</span>
            <span class="small">${esc(groundText(r.c))}</span>
            <span class="small txt-muted">${partsText(r.s)}</span>
            <span class="small">${sourceText(r.s)}</span>
          </span>
        </button>
        ${on ? detailHtml(r.c, r.rank) : ''}
      </li>`;
  }

  // Where it is now, as the reference everything else is read against.
  function nowHtml() {
    if (!found || !found.nowScore) return '';
    const c = found.now, s = found.nowScore, on = selected === c;
    return `
      <div class="sites-result reloc-now${on ? ' is-on' : ''}">
        <button type="button" class="sites-result-main" onclick="MapRelocate.select(0)" aria-pressed="${on ? 'true' : 'false'}"
                title="Show the paths from where it is now">
          <span class="sites-rank reloc-now-mark" aria-hidden="true">◎</span>
          <span class="sites-result-text">
            <strong>Where it is now</strong> <span class="small txt-muted">— the figures every place is read against</span>
            <span class="small sites-result-sum">${summaryHtml(c, s)}</span>
            <span class="small">${skyText(c)}</span>
            <span class="small">${esc(groundText(c))}</span>
          </span>
        </button>
        ${on ? detailHtml(c, 0) : ''}
      </div>`;
  }

  function detailHtml(c, rank) {
    const s = scoreOf(c, true);
    return `
      <div class="sites-detail">
        <div class="sites-actions">
          <button type="button" onclick="MapRelocate.flyTo(${rank})">Go to it</button>
          ${s.wk != null ? `<button type="button" onclick="MapRelocate.profile(${rank}, ${s.wk})"
                  title="Open the path to the worst-served repeater in the elevation profile and link budget">Profile the worst path</button>` : ''}
          ${copyLatLonPillHtml({ lat: c.lat, lon: c.lon })}
        </div>
        <div class="table-wrap">
          <table class="sites-table">
            <caption class="sr-only">Every repeater from ${rank ? `new site ${rank}` : 'where it is now'}</caption>
            <thead><tr><th scope="col">Repeater</th><th scope="col">km</th><th scope="col">LOS</th><th scope="col">Margin</th>${
              rank ? '<th scope="col">Now</th>' : ''}<th scope="col"><span class="sr-only">Profile</span></th></tr></thead>
            <tbody>
              ${found.hubs.map((h, k) => {
                const fig = figOf(c, k, true), was = figOf(found.now, k, true);
                return `<tr>
                  <td>${esc(h.name)}</td>
                  <td>${fig && fig.dKm != null ? fig.dKm.toFixed(1) : '—'}</td>
                  <td class="${fig && fig.verdict === 'obstructed' ? 'txt-bad' : fig && fig.verdict === 'marginal' ? 'txt-warn' : ''}">${
                    !fig || fig.failed ? '—' : esc(fig.verdict || '—')}</td>
                  <td><span class="sites-band sites-band-${bandOf(fig)}">${
                    !fig || fig.failed ? '—' : dbText(fig.margin)}</span>${
                    fig && !fig.failed && fig.src !== 'card' ? '<span class="txt-muted" title="Screened only — not the card\'s figure">*</span>' : ''}</td>
                  ${rank ? `<td>${was && !was.failed ? dbText(was.margin) : '—'}</td>` : ''}
                  <td>${fig && !fig.failed ? `<button type="button" class="btn-link" onclick="MapRelocate.profile(${rank}, ${k})"
                        aria-label="Profile the path to ${escAttr(h.name)}">↗</button>` : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function panelHtml() {
    if (!state.data) return '<p class="filter-note">No stations are loaded, so there is no station to move.</p>';
    const st = station();
    const w = weights();
    const here = st ? hereRadio(st) : null;
    const rain = st && (st.sensors || []).some(x => /rain/i.test(String(x.type || '')));
    return `
      <div class="sites-panel reloc-panel">
        <fieldset class="sites-fs">
          <legend>Station to move</legend>
          <div class="sites-row">
            <button type="button" onclick="MapRelocate.useCard()"
                    title="Use the station whose card is open on the map">Use the station on the card</button>
          </div>
          <input type="search" id="reloc-find" class="polar-find" autocomplete="off" spellcheck="false"
                 value="${escAttr(hitQ)}" placeholder="Or find it — name or station #"
                 aria-label="Find the station to move" oninput="MapRelocate.setSearch(this.value)">
          <div class="polar-hits" id="reloc-hits">${hitsHtml()}</div>
          <p class="small polar-picked" id="reloc-picked">${st
            ? `Moving <strong>${esc(st.name)}</strong>${st.station_number ? ` (${esc(st.station_number)})` : ''}${
                rain ? '' : ' · <span class="txt-muted">no rain gauge on file — open sky may matter less</span>'}`
            : 'No station picked yet.'}</p>
        </fieldset>

        ${st ? `<fieldset class="sites-fs">
          <legend>Repeaters it has to reach</legend>
          ${hubsHtml(st)}
        </fieldset>` : ''}

        <fieldset class="sites-fs">
          <legend>Search</legend>
          ${num('radiusM', 'Within', cfg.radiusM, 25, 'm', MIN_R, MAX_R)}
          <label class="filter-field">
            <span>Places to suggest</span>
            <select onchange="MapRelocate.set('count', this.value)">
              ${[3, 4, 5].map(n => `<option value="${n}" ${count() === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </label>
          ${num('agl', 'Antenna at the new site', cfg.agl, 0.5, 'm AGL', 0, 60, here ? String(here.agl) : String(PATH_DEFAULT_AGL))}
          ${num('clearM', 'Keep clear of buildings by', cfg.clearM, 1, 'm', 0, 100)}
          ${num('rimM', 'Rain gauge rim above ground', cfg.rimM, 0.1, 'm', 0, 20)}
        </fieldset>

        <fieldset class="sites-fs">
          <legend>What matters</legend>
          ${WEIGHTS.map(([k, label, hint]) => `
            <label class="filter-range">
              <span>${esc(label)} <strong>${w[k.slice(1, 2).toLowerCase()]}</strong></span>
              <input type="range" min="0" max="5" step="1" value="${cfg[k]}"
                     aria-label="${escAttr(label)} weight" title="${escAttr(hint)}"
                     onchange="MapRelocate.set('${k}', this.value)">
            </label>`).join('')}
          <p class="small txt-muted">A place every repeater ticked hears at ${okDb()} dB or better always ranks
            above one some repeater does not. A weight is a re-rank, not a re-run.</p>
        </fieldset>

        <fieldset class="sites-fs">
          <legend>On the map</legend>
          <label class="filter-field">
            <span>Colour the ground by</span>
            <select id="reloc-paint" onchange="MapRelocate.set('paint', this.value)">
              ${Object.entries(PAINTS).map(([k, t]) => `<option value="${k}" ${cfg.paint === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>
          <label class="filter-range">
            <span>Opacity <strong id="reloc-op-out" aria-hidden="true">${Math.round(opacity() * 100)} %</strong></span>
            <input type="range" id="reloc-op" min="10" max="100" step="5" value="${Math.round(opacity() * 100)}"
                   aria-label="Opacity of the coloured ground" oninput="MapRelocate.setOpacity(this.value)">
          </label>
          <div id="reloc-key">${keyHtml()}</div>
          <p class="small txt-muted">Point at the coloured ground for what each square scored. The white outlines are
            the buildings it found; check them against the imagery — a shed nobody mapped is one it cannot see.</p>
        </fieldset>

        <div class="sites-actions">
          <button type="button" id="reloc-run" class="primary" onclick="MapRelocate.run()"
                  ${readiness().ok && status.kind !== 'running' ? '' : 'disabled'}>Find new sites</button>
          <button type="button" id="reloc-cancel" onclick="MapRelocate.cancel()" ${status.kind === 'running' ? '' : 'hidden'}>Cancel</button>
          <button type="button" onclick="MapRelocate.clear()" ${st || found ? '' : 'disabled'}>Clear</button>
          <button type="button" onclick="MapRelocate.save()" ${results.length ? '' : 'disabled'}
                  title="Every place screened, with every figure, as rows">Save CSV</button>
        </div>
        <p class="filter-note" id="reloc-status">${statusHtml()}</p>
        ${nowHtml()}
        ${results.length ? `<ol class="sites-results">${results.map(resultHtml).join('')}</ol>` : ''}
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Indicative. ~30 m terrain, omnidirectional antennas, a canopy map of 2020 (±5 m) '
    + 'and only the buildings the State and OpenStreetMap have mapped — a short list to walk on site, '
    + 'not a survey. Look at the imagery, and open a path in the elevation profile card, before anything is moved.';

  function render() { if (body) body.innerHTML = panelHtml(); }

  function legendHtml() {
    if (!found) return '';
    return `
      <span class="legend-item">
        <span class="legend-site" aria-hidden="true">1</span>
        <span class="small">Station relocation — the ground within ${found.rM} m of ${esc(found.st.name)} (dashed),
          coloured by ${esc(PAINTS[cfg.paint] || PAINTS.score).toLowerCase()}; hatched grey is ruled out, white
          outlines are the buildings found, and the numbered pins are the ${results.length} best. The picked place's
          paths are coloured by fade margin: green ${goodDb()} dB or better, yellow ${okDb()}, red below.</span>
      </span>`;
  }

  function placeOf(rank) {
    if (!found) return null;
    if (+rank === 0) return found.now;
    const r = results.find(x => x.rank === +rank);
    return r ? r.c : null;
  }

  // The station that has to move. Its repeaters start ticked — the ones
  // carrying it now, with a radio on file — and the map goes to the circle.
  function pickStation(id) {
    const st = stationById(id);
    if (!st) return;
    invalidate();
    stationId = st.id;
    ticks = new Set(hubChoices(st).filter(h => h.listening && hubOf(h.s)).map(h => h.s.id));
    hitQ = '';
    draw();
    render();
    rerenderMapLegend();
    if (map && st.lat != null && st.lon != null) {
      const b = boxAround(st, radiusM() * 1.15);
      map.fitBounds([[b.south, b.west], [b.north, b.east]], { maxZoom: 17 });
    }
  }

  function select(rank, opts) {
    const c = placeOf(rank);
    if (!c) return;
    selected = c;
    draw();
    render();
    if (opts && opts.keepPopup && layer) layer.eachLayer(l => { if (l.mnRelocRank === +rank) l.openPopup(); });
  }

  // ── The CSV ─────────────────────────────────────────────────────────────────
  // Every place screened, not only the few pinned: a picture is read, a table
  // is checked (map-polar.js's reason for its own).

  function csvText() {
    if (!found || !results.length) return '';
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const w = weights();
    const rank = new Map(results.map(r => [r.c, r.rank]));
    const rows = [
      '# Flood-Net station relocation finder',
      `# station,${q(found.st.name)},${q(found.st.station_number || '')},${found.st.lat},${found.st.lon},within ${found.rM} m,every ${found.step} m`,
      `# radio,${q(found.here.sysName)},${found.here.agl} m AGL now,${found.hereNew.agl} m AGL at a new site`,
      `# weights,fade margin ${w.f},open sky ${w.s},clear ground ${w.c},close by ${w.n}`,
      `# rules,clear of buildings by ${clearM()} m,gauge rim ${rimM()} m,ok ${okDb()} dB,good ${goodDb()} dB`,
      `# repeaters,${found.hubs.map(h => q(`${h.name} (${freqText(h)})`)).join(',')}`,
      ['rank', 'lat', 'lon', 'east_m', 'north_m', 'distance_m', 'now', 'ruled_out', 'score', 'all_ok',
       'worst_margin_db', 'worst_repeater', ...found.hubs.map((h, k) => `margin_${k + 1}_db`),
       'figure', 'wmo_class', 'obstacle_deg', 'obstacle', 'cover_pct_20m', 'land_cover', 'nearest_building_m', 'nearest_building'].join(','),
    ];
    for (const c of found.cells) {
      const fine = c.now || rank.has(c);
      const s = scoreOf(c, fine);
      rows.push([
        rank.get(c) || '', c.lat.toFixed(6), c.lon.toFixed(6), c.x, c.y, Math.round(c.dM), c.now ? 'yes' : '',
        c.excluded || '', s.score.toFixed(1), s.allOk ? 'yes' : 'no', f1(s.worst), q(s.wk != null ? found.hubs[s.wk].name : ''),
        ...found.hubs.map((h, k) => { const fig = figOf(c, k, fine); return fig && !fig.failed ? f1(fig.margin) : ''; }),
        fine ? 'card' : 'screened', found.site.lattice.canopyOk ? c.wmo : '', found.site.lattice.canopyOk ? c.angle.toFixed(1) : '',
        c.obst ? `${c.obst.kind} ${Math.round(c.obst.h)} m at ${Math.round(c.obst.d)} m` : '',
        found.site.lattice.canopyOk ? Math.round(c.coverFrac * 100) : '', c.cls != null ? q(CLASS_WORDS[c.cls] || '') : '',
        c.bld ? Math.round(c.bld.dM) : '', c.bld ? q(c.bld.what) : '',
      ].join(','));
    }
    return rows.join('\n') + '\n';
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    attach(m) {
      map = m;
      if (!m.getPane(WASH_PANE)) { const p = m.createPane(WASH_PANE); p.style.zIndex = WASH_Z; p.style.pointerEvents = 'none'; }
      if (!m.getPane(LINE_PANE)) { const p = m.createPane(LINE_PANE); p.style.zIndex = LINE_Z; p.style.pointerEvents = 'none'; }
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      // Beside the repeater site finder: that one finds where a mast should
      // go to serve a set of stations, this where one station should go to be
      // heard by its repeaters.
      MapChrome.panel(m, {
        id: 'relocate', icon: '🚚', dockIcon: Glyphs.rail('relocate'), title: 'Relocate station',
        btnLabel: 'Relocate station — a new home for a station that has to move',
        group: 'tools', order: 26,
        html: () => panelHtml(),
        onMount(el) { body = el; },
      });
      m.on('mousemove', onMove);
      m.on('mouseout', hideTip);
      draw();
    },

    detach() {
      if (job) {
        job.cancelled = true;
        job = null;
        if (!results.length) found = null;
        status = { kind: found ? 'done' : 'idle', text: '' };
      }
      if (map) { map.off('mousemove', onMove); map.off('mouseout', hideTip); }
      if (tipFrame) { cancelAnimationFrame(tipFrame); tipFrame = 0; }
      hideTip();
      clearLayers();
      body = null;
      map = null;
    },

    active() { return !!found && results.length > 0; },
    legendHtml,
    run,

    cancel() {
      if (job) job.cancelled = true;
      job = null;
      if (!results.length) found = null;
      setStatus(found ? 'done' : 'idle', '');
      render();
    },

    // Reset's half (#191) and the panel's Clear: the station, the answer, all of it.
    clear() {
      invalidate();
      stationId = null;
      ticks = new Set();
      hitQ = '';
      draw();
      render();
      rerenderMapLegend();
    },

    pickStation,

    useCard() {
      const id = state.stnCard && state.stnCard.id;
      if (!id) { if (map) mapNote('Open a station\'s card on the map first — then press this.', 5000); return; }
      pickStation(id);
    },

    setSearch(v) {
      hitQ = String(v || '');
      const el = document.getElementById('reloc-hits');
      if (el) el.innerHTML = hitsHtml();
    },

    toggleHub(id, on) {
      if (on) ticks.add(id); else ticks.delete(id);
      invalidate();
      draw();
      render();
      rerenderMapLegend();
    },

    select,

    flyTo(rank) {
      const c = placeOf(rank);
      if (!c || !map) return;
      map.panTo([c.lat, c.lon]);
      mapNote(`${+rank ? `New site #${rank}` : 'Where it is now'} — ${stationLatLonText(c)}`, 6000);
    },

    // One path into the elevation profile and the link budget, the way the
    // site finder hands its over: a two-point line in Draw & measure, reused
    // if it is already there — the station's own id at its end when it is the
    // path from where it is now, so the card stands it on its surveyed height.
    profile(rank, k) {
      const c = placeOf(rank), h = found && found.hubs[+k];
      if (!c || !h) return;
      const pa = [c.lat, c.lon], pb = [h.lat, h.lon];
      if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
      state.path.open = true;
      const existing = MapDraw.findLine(pa, pb);
      if (existing) MapDraw.focus(existing.id);
      else MapDraw.addLine([pa, pb], [c.now ? found.st.id : null, h.id]);
      const el = document.getElementById('path-profile-panel');
      if (el) {
        if (typeof dockReveal === 'function') dockReveal(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      const where = typeof stationsCardsWhere === 'function' ? stationsCardsWhere() : 'with the station cards';
      mapNote(`Profiling ${+rank ? `new site #${rank}` : 'where it is now'} → ${h.name} — the card is ${where}.`, 5000);
    },

    save() {
      const text = csvText();
      if (!text) return;
      dlText(`floodnet-relocate-${slug(found.st.name)}-${found.rM}m.csv`, text);
    },

    csvText,

    setOpacity(value) {
      const v = Number(value);
      if (!isFinite(v)) return;
      cfg.opacity = Math.max(0.1, Math.min(1, v / 100));
      save();
      const out = document.getElementById('reloc-op-out');
      if (out) out.textContent = `${Math.round(opacity() * 100)} %`;
      if (wash) wash.setOpacity(opacity());
    },

    // One setter for every other control on the panel. An empty box means
    // "follow the default", not nought.
    set(key, value) {
      const asNum = v => { const s = String(v).trim(); return s === '' ? null : (isFinite(+s) ? +s : null); };
      const RERANK = ['count', 'wFade', 'wSky', 'wClear', 'wNear'];
      const RESITE = ['clearM', 'rimM'];
      switch (key) {
        case 'count':   cfg.count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(+value) || MAX_COUNT)); break;
        case 'radiusM': { const v = asNum(value); cfg.radiusM = v == null ? 500 : Math.max(MIN_R, Math.min(MAX_R, v)); break; }
        case 'agl':     { const v = asNum(value); cfg.agl = v != null && v > 0 ? v : null; break; }
        case 'clearM':  { const v = asNum(value); cfg.clearM = v == null ? 10 : Math.max(0, Math.min(100, v)); break; }
        case 'rimM':    { const v = asNum(value); cfg.rimM = v == null ? 1 : Math.max(0, Math.min(20, v)); break; }
        case 'paint':   if (!PAINTS[value]) return; cfg.paint = value; break;
        default:
          if (!/^w(Fade|Sky|Clear|Near)$/.test(key)) return;
          cfg[key] = Math.max(0, Math.min(5, Math.round(+value) || 0));
      }
      save();
      if (key === 'paint') {
        paintWash();
        const el = document.getElementById('reloc-key');
        if (el) el.innerHTML = keyHtml();
        rerenderMapLegend();
        return;
      }
      if (RESITE.includes(key) && found) {
        if (job) { rerankDue = true; render(); return; }
        applySite();
        // The few refined may no longer be the few worth refining: a place
        // the new clearance rules out goes, and the ones it lets in compete.
        rerank();
        return;
      }
      if (RERANK.includes(key)) {
        if (found && !job) rerank();
        else { if (job) rerankDue = true; render(); }
        return;
      }
      invalidate();
      draw();
      render();
      rerenderMapLegend();
    },

    // For the checks, and for anybody at the console.
    station() { const st = station(); return st ? { id: st.id, name: st.name } : null; },
    hubs() { return found ? found.hubs.map(h => ({ id: h.id, name: h.name, f: h.f, agl: h.rad.agl })) : [...ticks]; },
    status() { return { ...status }; },
    cells() {
      if (!found) return [];
      return found.cells.map(c => {
        const s = scoreOf(c, false);
        return { id: c.id, x: c.x, y: c.y, lat: c.lat, lon: c.lon, dM: c.dM, now: c.now, excluded: c.excluded,
                 wmo: c.wmo, angle: c.angle, under: c.under, coverFrac: c.coverFrac, cls: c.cls,
                 bld: c.bld ? { ...c.bld } : null, score: s.score, worst: s.worst, allOk: s.allOk,
                 grid: c.grid.map(f => ({ ...(f || {}) })) };
      });
    },
    results() {
      return results.map(r => ({
        rank: r.rank, id: r.c.id, lat: r.c.lat, lon: r.c.lon, dM: r.c.dM, score: r.s.score, worst: r.s.worst,
        allOk: r.s.allOk, F: r.s.F, S: r.s.S, C: r.s.C, N: r.s.N, wmo: r.c.wmo, excluded: r.c.excluded,
        bld: r.c.bld ? { ...r.c.bld } : null,
        fine: r.c.fine.map(f => (f ? { ...f } : null)), grid: r.c.grid.map(f => ({ ...(f || {}) })),
      }));
    },
    now() {
      if (!found || !found.nowScore) return null;
      return { score: found.nowScore.score, worst: found.nowScore.worst, allOk: found.nowScore.allOk,
               fine: found.now.fine.map(f => (f ? { ...f } : null)), grid: found.now.grid.map(f => ({ ...(f || {}) })) };
    },
    buildings() {
      return found ? { sources: found.site.buildings.sources.map(s => ({ ...s })), n: found.site.buildings.list.length } : null;
    },
    step() { return found ? found.step : stepFor(radiusM()); },
    selectedRank() { return !selected || !found ? null : selected === found.now ? 0 : (results.find(r => r.c === selected) || {}).rank || null; },
    drawn() { return { wash: !!wash, lines: lineLayer, pins: layer }; },
  };
})();
if (typeof window !== 'undefined') window.MapRelocate = MapRelocate;
