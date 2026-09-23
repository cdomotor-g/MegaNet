// MegaNet — map-sites.js
//
//   MapSites   the repeater site finder: say which stations a new repeater has
//              to serve — the map selection, a circle drawn round them, or a
//              pasted list of numbers, names and addresses — and it finds the
//              three to five places nearby that would serve them best, ranked
//              on the height of the ground, line of sight, fade margin and,
//              where the Queensland cadastre can say, road reserve.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, destPoint,
// bearingDeg, acmaHaversineKm, cssVar, slug, dlText, stationLatLonText,
// copyLatLonPillHtml and mapViewPills; across to terrain.js for Terrain.grid
// and Terrain.profile, land-cover.js for LandCover.sample, path-profile.js for
// pathAnalyse, rmSystemOf, wattsToDbm and the PATH_DEFAULT_* constants,
// map-roads.js for MapRoads.near, map-draw.js for MapDraw, places.js for
// Places.parse, map-controls.js for MapChrome.panel, and app.js for
// parseSearchTerms, parseIdRange, prepareSearch, stationMatchesSearch,
// stationAlertIds, rerenderMapLegend and mapNote. All of it from inside its
// own functions, so this file's position among the modules is free.
//
// ── The question this answers ────────────────────────────────────────────────
// Highest ground in view (map-peaks.js) answers "what is high around here",
// and Polar radio coverage (map-polar.js) answers "who could work a mast
// here". Siting a repeater is the question in between, asked the other way
// round: *these* sites have to be heard — where does the mast go? Until now
// that meant pinning the peaks, then profiling each one to each site by hand,
// which for five hills and a dozen gauges is sixty profiles nobody draws.
// This draws them.
//
// ── How it is made fast enough to be usable ──────────────────────────────────
// Two passes, for the reason MapLos and MapFade are two layers: the question
// "is it any good" is cheap and the question "how many decibels" is not.
//
//   1. SCREEN. One elevation grid over the whole search area (Terrain.grid,
//      MapPolar's bargain), and a pool of candidates read out of it: the
//      highest local summits, thinned so no two are the same hill (MapPeaks'
//      rule), plus the highest summit in each of a five-by-five set of blocks
//      — without those the pool is forty points on the one range along the
//      edge of the area, and a lower hill in the middle of the sites, which is
//      very often the answer, is never asked about. Every candidate is then
//      profiled to every site *out of the grid* and run through pathAnalyse:
//      the same geometry and the same Longley–Rice the profile card runs, over
//      bare ground and ninety-six samples. Arithmetic only, no network.
//
//   2. REFINE. The best few of those — the number asked for plus three spare —
//      are profiled again the link budget card's way: 256 samples off the
//      tiles, the land cover stood on them, P.2108 at a mast under the trees
//      (MapFade.computeOne's sequence). The finalists are ranked among
//      themselves on *those* figures, so the margin quoted for a result is the
//      figure the card will show when the path is opened in it.
//
// The two passes are never mixed in one ranking. A refined figure has the
// trees in it and a screened one does not, so ranking the finalists' refined
// margins against the rest of the pool's screened ones would push every
// finalist down for having been looked at properly — and the next pass would
// pick a fresh set of finalists, refine them, push them down in turn, and the
// ranking would never settle.
//
// ── The score ────────────────────────────────────────────────────────────────
// Four figures, each nought to one, weighted by four sliders the operator
// owns, and every one of them printed beside the result so the ranking can be
// argued with rather than taken on trust:
//
//   Elevation      the candidate's ground height across the pool's range.
//   Line of sight  per site, 1 for clear, ½ for marginal, 0 for obstructed —
//                  PATH_VERDICT's three words — averaged.
//   Fade margin    per site, the worse of the two directions (a repeater that
//                  hears a gauge and cannot be heard by it is not serving it)
//                  as a fraction of the map's own "good" band, averaged. A
//                  path with no figure counts nought, never as a pass.
//   Road reserve   1 on a road parcel, falling to nought 250 m away. Asked of
//                  the cadastre for the finalists only, and only while its
//                  slider is above nought — it is the one criterion that costs
//                  a request per site, and outside Queensland there is no
//                  answer to be had. A mast in the road reserve is the rare
//                  happy case (no landholder, no lease, a road to it), which is
//                  why it is a bonus and not a filter.
//
// Changing a weight re-ranks and costs nothing: every figure is kept, and a
// weight is a multiplication — MapFade's separation between a margin and the
// band it lands in, and MapPolar's between a level and its colour. Anything
// that changes what would be *computed* — the sites, the radio, the search
// area — takes the answer with it, because a list of results still on the
// panel under a question it does not answer is the one way this tool can
// mislead.
//
// ── What it is not ───────────────────────────────────────────────────────────
// ~30 m terrain, omnidirectional antennas, the land cover's representative
// heights and no buildings: an indicative short list, not a site survey. The
// panel says so under every run, and every result carries a button that opens
// its worst path in the elevation profile card, which is the authority for any
// path anybody is about to build.
const MapSites = (function () {
  // Points over the peaks (348) and under the leader lines (350); lines over
  // the watercourses (340) and under the survey marks (345) — the z-index
  // budget map-survey.js documents. The lines take no pointer: the Stations
  // map's shared canvas sits above them in the overlay pane, and the per-site
  // table in the panel carries every figure a hover would have.
  const PANE      = 'mnSites',      PANE_Z = 349;
  const LINE_PANE = 'mnSitesLines', LINE_Z = 342;

  const MAX_TARGETS    = 40;    // sites served. Screening is candidates × sites
                                // and refining is finalists × sites, each one a
                                // terrain profile and a land-cover request
  const GRID_N         = 320;   // elevation grid across the search area
  const WINDOW         = 2;     // a summit is no lower than every cell ±2 of it
  const POOL_TOP       = 24;    // the highest summits kept, thinned
  const POOL_BLOCKS    = 5;     // …plus the highest in each of 5×5 blocks
  const EXISTING_CAP   = 24;    // existing station sites scored, highest first
  const SCREEN_SAMPLES = 96;    // per screened path, out of the grid
  const FINE_SAMPLES   = 256;   // per refined path — PathProfile's own figure
  const SPARE          = 3;     // finalists refined beyond the number asked for
  const CONCURRENCY    = 4;     // refined profiles in flight, MapFade's figure
  const ROAD_RADIUS_M  = 250;   // how far off a road parcel still earns a bonus
  const CHUNK_MS       = 20;    // screening arithmetic per slice
  const MIN_AREA_KM    = 2;     // the smallest search radius there is
  const COLO_KM        = 0.05;  // a candidate this close to a site is on it
  const MIN_COUNT = 3, MAX_COUNT = 5;
  const STORE          = 'mn-sites-v1';

  const WEIGHTS = [
    ['wElev', 'Elevation',     'the height of the ground under the mast'],
    ['wLos',  'Line of sight', 'how many paths clear the 60% Fresnel zone'],
    ['wFade', 'Fade margin',   'decibels to spare on each path, the worse direction'],
    ['wRoad', 'Road reserve',  'on or beside a Queensland road parcel — 0 skips the lookup'],
  ];

  const cfg = load();

  let map = null, body = null;
  let layer = null, lineLayer = null;
  let targets = [];        // [{ key, kind, sid, name, number, lat, lon, elev }]
  let pasteText = '';
  let pasteNote = null;    // what the last paste did, for the line under the box
  let awaitCircle = null;  // Set of shape ids that existed when Draw was pressed
  let job = null;          // { cancelled } while a pass is in flight
  let found = null;        // the screened pool and everything refined since
  let results = [];        // [{ rank, c, s }] — the ranked answer on the map
  let selected = null;     // the candidate whose links are drawn
  let rerankDue = false;   // a weight moved while a pass was in flight
  let status = { kind: 'idle', text: '' };

  // ── Settings ────────────────────────────────────────────────────────────────

  function defaults() {
    return {
      count: 5, marginKm: 5, spacingKm: null, existing: false,
      sysId: null, agl: null, freqMhz: null,
      wElev: 2, wLos: 3, wFade: 4, wRoad: 1,
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

  // ── The radios ──────────────────────────────────────────────────────────────
  // The link budget card's rule, inherited: a term nobody supplied blanks the
  // figure rather than being read as nought. So only a system carrying all four
  // of the terms a margin needs can stand at either end.

  function complete(sys) {
    return !!sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null
        && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  }

  function systems() {
    return ((state.data && state.data.rm_systems) || []).filter(complete);
  }

  function repeaterSystem() {
    const list = systems();
    return list.find(r => r.id === cfg.sysId) || list[0] || null;
  }

  // The radio a site with none of its own on file is taken to have: the one
  // most of the network runs. A proposed site pasted in as a coordinate has no
  // station behind it at all, and this is what a new field station would be.
  function fieldDefault() {
    const list = systems();
    if (!list.length) return null;
    const n = new Map();
    for (const s of (state.data && state.data.stations) || []) {
      const sys = rmSystemOf(s);
      if (complete(sys)) n.set(sys.id, (n.get(sys.id) || 0) + 1);
    }
    return list.reduce((best, r) => ((n.get(r.id) || 0) > (n.get(best.id) || 0) ? r : best), list[0]);
  }

  function radioOf(sys, agl) {
    return {
      sysName: sys.name, txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
      loss: sys.line_loss_db, thr: sys.rx_threshold_dbm,
      agl: agl != null ? agl : (sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL),
    };
  }

  function repeaterRadio() {
    const sys = repeaterSystem();
    return sys ? radioOf(sys, cfg.agl) : null;
  }

  function targetRadio(t) {
    const own = t.sid ? rmSystemOf(stationById(t.sid)) : null;
    const sys = complete(own) ? own : fieldDefault();
    return sys ? { ...radioOf(sys, null), assumed: !complete(own) } : null;
  }

  function freqMhz() { return cfg.freqMhz > 0 ? cfg.freqMhz : PATH_DEFAULT_MHZ; }

  function oneWay(loss, from, to) {
    const tx = wattsToDbm(from.txW);
    if (tx == null || loss == null) return null;
    return tx + from.gain - from.loss - loss + to.gain - to.loss - to.thr;
  }

  // Both directions and the worse of the two — MapFade's reading of a link as
  // a conversation, and more so here: a repeater is both ends of one.
  function marginOf(an, rep, fld) {
    const down = oneWay(an.pathLoss_db, rep, fld), up = oneWay(an.pathLoss_db, fld, rep);
    if (down == null || up == null) return null;
    return { m: Math.min(down, up), down, up };
  }

  // ── The sites to serve ──────────────────────────────────────────────────────

  function stationById(id) {
    return ((state.data && state.data.stations) || []).find(s => s.id === id) || null;
  }

  function targetOfStation(s) {
    return { key: 'st:' + s.id, kind: 'station', sid: s.id, name: s.name,
             number: s.station_number || '', lat: s.lat, lon: s.lon,
             elev: s.elevation_ahd != null ? s.elevation_ahd : null };
  }

  function targetOfPoint(p) {
    return { key: `pt:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`, kind: 'point', sid: null,
             name: `Proposed site ${p.text}`, number: '', lat: p.lat, lon: p.lon, elev: null };
  }

  // Add what was asked for, once each. Returns what happened so the caller can
  // say it: a paste of forty numbers where six were already in and three have
  // no coordinates on file has to tell the operator all three facts.
  function addTargets(list) {
    const have = new Set(targets.map(t => t.key));
    const out = { added: 0, dup: 0, noPos: 0, capped: 0 };
    for (const t of list) {
      if (t.lat == null || t.lon == null || !isFinite(t.lat) || !isFinite(t.lon)) { out.noPos++; continue; }
      if (have.has(t.key)) { out.dup++; continue; }
      if (targets.length >= MAX_TARGETS) { out.capped++; continue; }
      targets.push(t);
      have.add(t.key);
      out.added++;
    }
    if (out.added) invalidate();
    return out;
  }

  function addedText(r, what) {
    const bits = [`${r.added} ${what} added — ${targets.length} to serve`];
    if (r.dup)    bits.push(`${r.dup} already in`);
    if (r.noPos)  bits.push(`${r.noPos} with no position on file`);
    if (r.capped) bits.push(`${r.capped} over the ${MAX_TARGETS}-site limit left out`);
    return bits.join(' · ');
  }

  // One pasted term, the way an operator means it. The Stations filter box's
  // own parser splits the text (so a spreadsheet column, a CSV row and a log
  // excerpt all work as pasted, and `4021-4025` is an address window), and then
  // an *exact* answer is preferred to a substring one: "491" is a station
  // number, the start of several addresses and a run inside several names, and
  // a list pasted in to say "these sites" must not quietly enrol the others.
  // Only when nothing matches exactly is the filter's own looser match asked,
  // and then only a single answer is taken — several is a question back.
  function resolvePaste(text) {
    const stations = ((state.data && state.data.stations) || []);
    const byNum = new Map(), byName = new Map(), byAlert = new Map();
    const push = (m, k, s) => { if (!m.has(k)) m.set(k, []); m.get(k).push(s); };
    for (const s of stations) {
      if (s.station_number) push(byNum, String(s.station_number).toLowerCase(), s);
      push(byName, String(s.name || '').toLowerCase(), s);
      for (const id of stationAlertIds(s)) push(byAlert, String(id), s);
    }
    const hits = [], points = [], missing = [], ambiguous = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // A coordinate on a line of its own is a proposed site — somewhere a
      // gauge is going that has no station behind it yet. Asked before the
      // split, because the split would cut "-27.5, 152.5" in two at its comma.
      const ll = Places.parse(line);
      if (ll) { points.push(ll); continue; }
      for (const term of parseSearchTerms(line)) {
        const range = parseIdRange(term);
        if (range) {
          const got = stations.filter(s => stationAlertIds(s).some(id => id >= range[0] && id <= range[1]));
          if (got.length) hits.push(...got); else missing.push(`${range[0]}-${range[1]}`);
          continue;
        }
        const exact = byNum.get(term) || byName.get(term) || (/^\d+$/.test(term) && byAlert.get(term));
        if (exact && exact.length) { hits.push(...exact); continue; }
        const prep = { ...prepareSearch(term) };
        const loose = stations.filter(s => stationMatchesSearch(s, prep));
        if (loose.length === 1) hits.push(loose[0]);
        else if (!loose.length) missing.push(term);
        else ambiguous.push({ term, n: loose.length });
      }
    }
    return { hits, points, missing, ambiguous };
  }

  // ── The search area ─────────────────────────────────────────────────────────
  // A circle round the sites — their middle, out to the furthest of them — and
  // `marginKm` beyond it, because the best hill for a ring of gauges is often
  // just outside the ring. The plain mean of the coordinates is the middle:
  // over a few tens of kilometres the difference from a geodesic centroid is
  // metres, and the margin swallows it.
  function areaOf(ts) {
    if (!ts.length) return null;
    const lat = ts.reduce((a, t) => a + t.lat, 0) / ts.length;
    const lon = ts.reduce((a, t) => a + t.lon, 0) / ts.length;
    let r = 0;
    for (const t of ts) r = Math.max(r, acmaHaversineKm(lat, lon, t.lat, t.lon));
    return { lat, lon, rKm: Math.max(MIN_AREA_KM, r + Math.max(0, +cfg.marginKm || 0)) };
  }

  function boxOf(a) {
    const n = destPoint(a.lat, a.lon, 0, a.rKm), s = destPoint(a.lat, a.lon, 180, a.rKm);
    const e = destPoint(a.lat, a.lon, 90, a.rKm), w = destPoint(a.lat, a.lon, 270, a.rKm);
    return { north: n[0], south: s[0], east: e[1], west: w[1] };
  }

  // Ground height anywhere in the box, bilinear over the grid, NaN where a tile
  // never arrived — terrain.js's loud-failure rule: a hole read as sea level
  // is a path claiming clearance over ground nobody has seen.
  function sampleGrid(g, box, lat, lon) {
    const fx = (lon - box.west) / (box.east - box.west) * (g.nx - 1);
    const fy = (box.north - lat) / (box.north - box.south) * (g.ny - 1);
    if (!(fx >= 0) || !(fy >= 0) || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
    const x0 = Math.min(g.nx - 2, Math.floor(fx)), y0 = Math.min(g.ny - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0, e = g.elev;
    const a = e[y0 * g.nx + x0],       b = e[y0 * g.nx + x0 + 1];
    const c = e[(y0 + 1) * g.nx + x0], d = e[(y0 + 1) * g.nx + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  // ── The candidates ──────────────────────────────────────────────────────────

  function summits(g, box, area) {
    const { nx, ny, elev } = g;
    const out = [];
    for (let j = WINDOW; j < ny - WINDOW; j++) {
      for (let i = WINDOW; i < nx - WINDOW; i++) {
        const v = elev[j * nx + i];
        if (isNaN(v)) continue;
        let best = true;
        for (let dj = -WINDOW; dj <= WINDOW && best; dj++) {
          for (let di = -WINDOW; di <= WINDOW; di++) {
            if (!di && !dj) continue;
            const u = elev[(j + dj) * nx + (i + di)];
            // Strictly greater, so a flat top is not disqualified by its own
            // plateau — MapPeaks' reasoning; the thinning makes it one.
            if (!isNaN(u) && u > v) { best = false; break; }
          }
        }
        if (!best) continue;
        const lat = box.north + (box.south - box.north) * j / (ny - 1);
        const lon = box.west  + (box.east  - box.west)  * i / (nx - 1);
        if (acmaHaversineKm(area.lat, area.lon, lat, lon) > area.rKm) continue;
        out.push({ lat, lon, ground: v, i, j });
      }
    }
    return out.sort((a, b) => b.ground - a.ground);
  }

  function poolFrom(g, box, area) {
    const tops = summits(g, box, area);
    const sep = Math.max(3 * g.resolution_m / 1000, area.rKm * 2 * 0.025);
    const picked = [];
    const far = p => picked.every(q => acmaHaversineKm(p.lat, p.lon, q.lat, q.lon) >= sep);
    for (const p of tops) {
      if (picked.length >= POOL_TOP) break;
      if (far(p)) picked.push(p);
    }
    // The highest summit in each block — `tops` is sorted, so the first one a
    // block sees is its highest.
    const block = new Map();
    for (const p of tops) {
      const k = Math.min(POOL_BLOCKS - 1, Math.floor(p.i / g.nx * POOL_BLOCKS)) * POOL_BLOCKS
              + Math.min(POOL_BLOCKS - 1, Math.floor(p.j / g.ny * POOL_BLOCKS));
      if (!block.has(k)) block.set(k, p);
    }
    for (const p of block.values()) if (far(p)) picked.push(p);
    const pool = picked.map((p, n) => ({
      id: 'g' + n, src: 'ground', sid: null, name: null,
      lat: p.lat, lon: p.lon, ground: p.ground, grid: [], fine: [], road: undefined,
    }));

    // Somewhere that already has a mast, a power supply, a track and a
    // landholder who says yes is worth a great deal more than a bare hill a few
    // metres higher, and no terrain model can know that. So the existing sites
    // in the area can be scored beside the summits, on their surveyed heights.
    if (cfg.existing && state.data) {
      const here = (state.data.stations || [])
        .filter(s => s.lat != null && s.lon != null
                  && acmaHaversineKm(area.lat, area.lon, s.lat, s.lon) <= area.rKm)
        .map(s => ({ s, ground: s.elevation_ahd != null ? s.elevation_ahd : sampleGrid(g, box, s.lat, s.lon) }))
        .filter(x => isFinite(x.ground))
        .sort((a, b) => b.ground - a.ground)
        .slice(0, EXISTING_CAP);
      here.forEach((x, n) => pool.push({
        id: 's' + n, src: 'station', sid: x.s.id, name: x.s.name, elevAhd: x.s.elevation_ahd,
        lat: x.s.lat, lon: x.s.lon, ground: x.ground, grid: [], fine: [], road: undefined,
      }));
    }
    return pool;
  }

  // ── The two passes ──────────────────────────────────────────────────────────

  function screenPair(g, box, c, t, rep, fld, f) {
    const dKm = acmaHaversineKm(c.lat, c.lon, t.lat, t.lon);
    if (dKm < COLO_KM) return { dKm, colo: true, verdict: 'clear', margin: null, src: 'grid' };
    const brg = bearingDeg(c.lat, c.lon, t.lat, t.lon);
    const n = SCREEN_SAMPLES;
    const distance_m = new Array(n), terrain_m = new Array(n);
    let holes = 0;
    for (let i = 0; i < n; i++) {
      const km = dKm * i / (n - 1);
      const p = i === 0 ? [c.lat, c.lon] : i === n - 1 ? [t.lat, t.lon] : destPoint(c.lat, c.lon, brg, km);
      const h = sampleGrid(g, box, p[0], p[1]);
      distance_m[i] = km * 1000;
      if (isNaN(h)) { terrain_m[i] = null; holes++; } else terrain_m[i] = h;
    }
    // Too little ground to answer from. A path mostly over missing tiles is not
    // a path this can say anything about, in either direction.
    if (holes > n / 4) return { dKm, failed: true, src: 'grid' };
    const an = pathAnalyse({ distance_m, terrain_m, partial: holes > 0 }, {
      elevA: c.src === 'station' && c.elevAhd != null ? c.elevAhd : c.ground,
      elevB: t.elev, aglA: rep.agl, aglB: fld.agl, freqMhz: f,
    });
    if (!an.ok) return { dKm, failed: true, src: 'grid' };
    const m = marginOf(an, rep, fld);
    return { dKm, verdict: an.verdict, ratio: an.worst.ratio, partial: holes > 0,
             margin: m ? m.m : null, down: m ? m.down : null, up: m ? m.up : null, src: 'grid' };
  }

  // The profile card's own figure for one path: its sample count, its tiles,
  // the land cover stood on them. A profile with holes in it is refused — a
  // margin over bridged gaps is a guess dressed as a figure (MapFade's rule at
  // its strictest) — and the screened figure stands. Cover that cannot be had
  // leaves a bare-ground figure, *said to be one*: a kinder number than the
  // card will give, and the result's line in the panel counts how many of
  // those it is standing on.
  async function finePair(c, t, rep, fld, f) {
    const dKm = acmaHaversineKm(c.lat, c.lon, t.lat, t.lon);
    if (dKm < COLO_KM) return { dKm, colo: true, verdict: 'clear', margin: null, src: 'cover' };
    const prof = await Terrain.profile([[c.lat, c.lon], [t.lat, t.lon]], FINE_SAMPLES);
    if (!prof || !prof.ok || prof.partial) return null;
    const res = await LandCover.sample(prof.lat, prof.lon);
    const cover = !!(res && res.ok);
    const an = pathAnalyse(prof, {
      elevA: c.src === 'station' && c.elevAhd != null ? c.elevAhd : null,
      elevB: t.elev, aglA: rep.agl, aglB: fld.agl, freqMhz: f,
      cover: cover ? res.cls : null, canopy: cover && res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return null;
    const m = marginOf(an, rep, fld);
    return { dKm, verdict: an.verdict, ratio: an.worst.ratio,
             margin: m ? m.m : null, down: m ? m.down : null, up: m ? m.up : null,
             src: cover ? 'cover' : 'bare' };
  }

  // The best figure in hand for one candidate and one site.
  function figOf(c, k, fine) {
    if (fine && c.fine[k]) return c.fine[k];
    return c.grid[k] || null;
  }

  // ── The score ───────────────────────────────────────────────────────────────

  function weights() {
    const w = x => Math.max(0, Math.min(5, +cfg[x] || 0));
    const out = { e: w('wElev'), l: w('wLos'), f: w('wFade'), r: w('wRoad') };
    out.sum = out.e + out.l + out.f + out.r;
    return out;
  }

  function goodDb() { return state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15; }
  function okDb()   { return isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6; }

  function roadScore(r) {
    if (!r || !r.ok || r.distM == null) return 0;
    if (r.inside) return 1;
    return Math.max(0, 1 - r.distM / ROAD_RADIUS_M);
  }

  function scoreOf(c, fine) {
    const n = found.targets.length;
    const G = goodDb(), O = okDb();
    let L = 0, F = 0;
    const s = { clear: 0, marginal: 0, obstructed: 0, failed: 0, served: 0,
                margins: [], cover: 0, bare: 0, grid: 0, colo: 0 };
    for (let k = 0; k < n; k++) {
      const fig = figOf(c, k, fine);
      if (!fig || fig.failed) { s.failed++; continue; }
      s[fig.src]++;
      if (fig.colo) { L += 1; F += 1; s.clear++; s.served++; s.colo++; continue; }
      s[fig.verdict]++;
      L += fig.verdict === 'clear' ? 1 : fig.verdict === 'marginal' ? 0.5 : 0;
      if (fig.margin != null) {
        F += Math.max(0, Math.min(1, fig.margin / G));
        s.margins.push(fig.margin);
        if (fig.margin >= O) s.served++;
      }
    }
    const span = found.hMax - found.hMin;
    s.E = span > 0 ? (c.ground - found.hMin) / span : 1;
    s.L = n ? L / n : 0;
    s.F = n ? F / n : 0;
    // The road is known for the finalists only, so outside the final ranking it
    // is nought for everybody — which moves nobody.
    s.R = fine ? roadScore(c.road) : 0;
    const w = weights();
    s.score = w.sum > 0 ? 100 * (w.e * s.E + w.l * s.L + w.f * s.F + w.r * s.R) / w.sum : 0;
    const sorted = s.margins.slice().sort((a, b) => a - b);
    s.min = sorted.length ? sorted[0] : null;
    s.median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    return s;
  }

  function spacingKm() {
    if (cfg.spacingKm > 0) return +cfg.spacingKm;
    return Math.max(0.5, found.area.rKm * 2 * 0.06, 3 * found.res / 1000);
  }

  const byScore = (a, b) => b.s.score - a.s.score || b.c.ground - a.c.ground;

  // The finalists come off the screened figures alone — apples to apples, the
  // whole pool on one footing — and are spaced as they are picked, so the few
  // refined are the few worth refining rather than five points on one ridge.
  function finalists() {
    const want = count() + SPARE, sep = spacingKm();
    const out = [];
    for (const x of found.pool.map(c => ({ c, s: scoreOf(c, false) })).sort(byScore)) {
      if (out.length >= want) break;
      if (out.every(y => acmaHaversineKm(x.c.lat, x.c.lon, y.lat, y.lon) >= sep)) out.push(x.c);
    }
    return out;
  }

  // ── Running it ──────────────────────────────────────────────────────────────

  function readiness() {
    if (!state.data) return { ok: false, why: 'No stations are loaded.' };
    if (!targets.length) {
      return { ok: false, why: 'Add the sites the repeater has to serve — the map selection, a circle drawn round them, or a pasted list.' };
    }
    const rep = repeaterRadio();
    if (!rep) {
      return { ok: false, why: 'No radio system on file carries all four of transmit power, antenna gain, line loss and receiver threshold — there is no margin to compute.' };
    }
    return { ok: true, rep };
  }

  // A few of these at a time, in order, until the list runs out or the job is
  // cancelled — the terrain cache and the land-cover cache are small LRUs, and
  // four paths out of one candidate share most of their tiles.
  async function lanes(list, n, fn, mine) {
    let i = 0;
    const lane = async () => {
      while (i < list.length && !mine.cancelled) await fn(list[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, lane));
  }

  function run() {
    const r = readiness();
    if (!r.ok) { setStatus('blocked', r.why); return Promise.resolve(false); }
    if (job) job.cancelled = true;
    found = null; results = []; selected = null;
    const mine = job = { cancelled: false };
    const area = areaOf(targets), box = boxOf(area);
    const ts = targets.slice();
    const rep = r.rep, f = freqMhz();
    const flds = ts.map(targetRadio);
    draw();
    render();
    rerenderMapLegend();
    setStatus('running', 'Fetching the terrain under the search area…');

    return Terrain.grid(box, GRID_N, GRID_N).then(g => {
      if (mine.cancelled) return false;
      if (!g.ok) { job = null; setStatus('blocked', g.error); return false; }
      const pool = poolFrom(g, box, area);
      if (!pool.length) {
        job = null;
        setStatus('blocked', 'Nothing in the search area stands out as high ground — widen the search.');
        return false;
      }
      return new Promise(resolve => {
        const total = pool.length * ts.length;
        let ci = 0, k = 0, done = 0;
        const step = () => {
          if (mine.cancelled) { resolve(false); return; }
          const until = performance.now() + CHUNK_MS;
          while (ci < pool.length && performance.now() < until) {
            pool[ci].grid[k] = screenPair(g, box, pool[ci], ts[k], rep, flds[k], f);
            done++;
            if (++k >= ts.length) { k = 0; ci++; }
          }
          if (ci < pool.length) {
            setStatus('running', `Screening ${pool.length} candidates against ${ts.length} site${
              ts.length === 1 ? '' : 's'} — ${Math.round(done / total * 100)}%`);
            setTimeout(step, 0);
            return;
          }
          const hs = pool.map(c => c.ground);
          found = { area, box, pool, targets: ts, rep, flds, f,
                    res: g.resolution_m, tiles: g.tiles, missing: g.missing,
                    hMin: Math.min(...hs), hMax: Math.max(...hs), finals: [] };
          resolve(refine(mine));
        };
        setTimeout(step, 0);
      });
    }).catch(e => {
      if (mine.cancelled) return false;
      job = null;
      setStatus('blocked', (e && e.message) || 'the terrain grid could not be built');
      return false;
    });
  }

  // Pick the finalists, refine whatever of them has not been refined already,
  // ask the cadastre about the ones it has not been asked about, and rank.
  // Re-entered by a weight change with the pool still in hand, so a re-rank
  // costs the new finalists' paths and nothing else.
  async function refine(mine) {
    const finals = finalists();
    const { targets: ts, rep, flds, f } = found;
    const todo = [];
    for (const c of finals) for (let k = 0; k < ts.length; k++) if (c.fine[k] === undefined) todo.push([c, k]);
    let done = 0;
    const tell = () => setStatus('running', `Checking the ${finals.length} finalists the link budget card's
      way — 256 samples, the land cover on them — ${done} of ${todo.length} paths`);
    tell();
    await lanes(todo, CONCURRENCY, async ([c, k]) => {
      let fig = null;
      try { fig = await finePair(c, ts[k], rep, flds[k], f); } catch (_) { fig = null; }
      if (mine.cancelled) return;
      c.fine[k] = fig;                    // null: tried, and the screened figure stands
      done++;
      tell();
    }, mine);
    if (mine.cancelled) return false;

    if (weights().r > 0) {
      const ask = finals.filter(c => c.road === undefined);
      if (ask.length) setStatus('running', `Asking the Queensland cadastre about road reserve at ${ask.length} site${ask.length === 1 ? '' : 's'}…`);
      await lanes(ask, 2, async c => {
        let r;
        try { r = await MapRoads.near(c.lat, c.lon, ROAD_RADIUS_M); }
        catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        if (!mine.cancelled) c.road = r;
      }, mine);
      if (mine.cancelled) return false;
    }

    found.finals = finals;
    rank();
    job = null;
    setStatus('done', '');
    // A weight that moved while this pass was running picked no finalists of
    // its own; now that the pool is free, it does.
    if (rerankDue) { rerankDue = false; rerank(); }
    return true;
  }

  function rank() {
    const keep = selected;
    results = found.finals.map(c => ({ c, s: scoreOf(c, true) })).sort(byScore)
      .slice(0, count()).map((x, i) => ({ rank: i + 1, c: x.c, s: x.s }));
    selected = results.some(x => x.c.id === (keep && keep.id)) ? keep
             : results.length ? results[0].c : null;
    draw();
    render();
    rerenderMapLegend();
  }

  // Something that changes what would be computed. The answer goes with it —
  // MapPolar's rule, and for its reason.
  function invalidate() {
    if (job) job.cancelled = true;
    job = null;
    found = null; results = []; selected = null;
    rerankDue = false;
    status = { kind: 'idle', text: '' };
  }

  function rerank() {
    if (!found || job) return;
    const mine = job = { cancelled: false };
    refine(mine);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    if (layer) { layer.remove(); layer = null; }
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }
  }

  function bandOf(fig) {
    if (fig.colo) return 'good';
    if (fig.margin == null) return fig.verdict === 'obstructed' ? 'bad' : 'none';
    return fig.margin >= goodDb() ? 'good' : fig.margin >= okDb() ? 'ok' : 'bad';
  }

  const BAND = {
    good: ['--map-fade-good', '#00e676'], ok: ['--map-fade-ok', '#ffab00'],
    bad:  ['--map-fade-bad', '#e53935'],  none: ['--muted', '#888888'],
  };
  function bandColour(b) { return cssVar(BAND[b][0], BAND[b][1]); }

  function icon(r) {
    return L.divIcon({
      className: 'mn-site-icon',
      html: `<span class="mn-site${selected && selected.id === r.c.id ? ' is-on' : ''}">`
          + `<b class="mn-site-h">${Math.round(r.c.ground)} m</b>`
          + `<i class="mn-site-mark" aria-hidden="true">${r.rank}</i></span>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function draw() {
    clearLayers();
    // Nothing to serve and nothing found is nothing on the map — not two empty
    // layer groups in panes of their own.
    if (!map || (!targets.length && !results.length)) return;
    lineLayer = L.layerGroup([], { pane: LINE_PANE }).addTo(map);
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    const accent = cssVar('--accent', '#0b5cab');
    const area = found ? found.area : areaOf(targets);
    if (area) {
      L.circle([area.lat, area.lon], {
        pane: LINE_PANE, radius: area.rKm * 1000, color: accent, weight: 1.5, opacity: 0.8,
        dashArray: '6 6', fill: true, fillOpacity: 0.04, interactive: false,
      }).addTo(lineLayer);
    }
    for (const t of targets) {
      L.circleMarker([t.lat, t.lon], {
        pane: LINE_PANE, radius: 9, color: accent, weight: 2.5, opacity: 0.95,
        fill: false, interactive: false,
      }).addTo(lineLayer);
    }
    const sel = results.find(r => selected && r.c.id === selected.id);
    if (sel) {
      found.targets.forEach((t, k) => {
        const fig = figOf(sel.c, k, true);
        if (!fig || fig.failed || fig.colo) return;
        L.polyline([[sel.c.lat, sel.c.lon], [t.lat, t.lon]], {
          pane: LINE_PANE, color: bandColour(bandOf(fig)), weight: 3, opacity: 0.9,
          dashArray: fig.verdict === 'obstructed' ? '7 6' : null, interactive: false,
        }).addTo(lineLayer);
      });
    }
    for (const r of results) {
      L.marker([r.c.lat, r.c.lon], {
        icon: icon(r), pane: PANE, riseOnHover: true,
        title: `Repeater site #${r.rank} — ${Math.round(r.c.ground)} m, score ${Math.round(r.s.score)}`,
      }).bindPopup(() => popupHtml(r), { maxWidth: 320 })
        .on('click', () => select(r.rank, { keepPopup: true }))
        .addTo(layer);
    }
  }

  // ── Words ───────────────────────────────────────────────────────────────────

  const VERDICT = { clear: 'clear', marginal: 'marginal', obstructed: 'obstructed' };

  function dbText(v) { return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; }

  function whereText(c) {
    return c.src === 'station' ? `the existing site ${c.name}` : 'open ground';
  }

  function roadHtml(c) {
    if (weights().r <= 0) return '<span class="txt-muted">Road reserve not asked — its weight is nought.</span>';
    const r = c.road;
    if (r === undefined) return '<span class="txt-muted">Road reserve not checked yet.</span>';
    if (!r || !r.ok) {
      return `<span class="txt-warn">Road reserve could not be checked — ${esc((r && r.error) || 'the cadastre did not answer')}.</span>`;
    }
    if (r.inside) return `<span class="txt-ok">On road reserve — ${esc(r.label)}.</span>`;
    if (r.distM != null) {
      return `Road reserve ${Math.round(r.distM)} m away — ${esc(r.label)}${
        r.distM > ROAD_RADIUS_M ? ' <span class="txt-muted">(too far to count)</span>' : ''}.`;
    }
    return `<span class="txt-muted">No road parcel within ${ROAD_RADIUS_M} m${
      r.count === 0 ? ' — or this is outside Queensland, where the cadastre stops' : ''}.</span>`;
  }

  function sourceText(s) {
    const bits = [];
    if (s.cover) bits.push(`${s.cover} with the land cover on`);
    if (s.bare)  bits.push(`<span class="txt-warn">${s.bare} over bare ground — cover unreachable, so kinder than the card</span>`);
    if (s.grid)  bits.push(`<span class="txt-warn">${s.grid} screened only — the tiles for the full profile would not load</span>`);
    if (s.failed) bits.push(`<span class="txt-warn">${s.failed} could not be computed</span>`);
    return bits.join(' · ');
  }

  function summaryHtml(r) {
    const s = r.s, n = found.targets.length;
    return `
      <span>LOS <strong>${s.clear}</strong> clear${s.marginal ? `, ${s.marginal} marginal` : ''}${
        s.obstructed ? `, <span class="txt-bad">${s.obstructed} obstructed</span>` : ''} of ${n}</span>
      <span>Fade margin worst <strong>${dbText(s.min)}</strong>, median ${dbText(s.median)} ·
        ${s.served} of ${n} at ${okDb()} dB or better</span>`;
  }

  function popupHtml(r) {
    const c = r.c;
    const pt = { lat: c.lat, lon: c.lon, name: `Repeater site ${r.rank}` };
    return `
      <div class="mn-site-pop">
        <h4>#${r.rank} repeater site · ${Math.round(c.ground)} m · score ${Math.round(r.s.score)}</h4>
        <p class="small">${esc(stationLatLonText(c))} — ${esc(whereText(c))}<br>
          ${summaryHtml(r)}<br>${roadHtml(c)}</p>
        <div class="pill-row">
          ${copyLatLonPillHtml(pt)}
          ${mapViewPills(pt).join('\n          ')}
        </div>
      </div>`;
  }

  function legendHtml() {
    if (!results.length) return '';
    return `
      <span class="legend-item">
        <span class="legend-site" aria-hidden="true">1</span>
        <span class="small">Repeater site candidates — ${results.length} ranked, best first, for
          ${found.targets.length} site${found.targets.length === 1 ? '' : 's'} (ringed) inside the dashed
          search area. The chosen one's paths are coloured by fade margin: green ${goodDb()} dB or better,
          yellow ${okDb()}, red below, dashed where the ground cuts the line.</span>
      </span>`;
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  function setStatus(kind, text) {
    status = { kind, text: text || '' };
    const el = document.getElementById('sites-status');
    if (el) el.innerHTML = statusHtml();
    const btn = document.getElementById('sites-run');
    if (btn) btn.disabled = kind === 'running' || !readiness().ok;
    const cancel = document.getElementById('sites-cancel');
    if (cancel) cancel.hidden = kind !== 'running';
  }

  function statusHtml() {
    switch (status.kind) {
      case 'running': return `<span class="sites-run">${esc(status.text)}</span>`;
      case 'blocked': return `<span class="txt-warn">${esc(status.text)}</span>`;
      case 'done': {
        if (!found) return '';
        const ex = found.pool.filter(c => c.src === 'station').length;
        return `Searched ${fmtKm(found.area.rKm)} round the middle of ${found.targets.length} site${
          found.targets.length === 1 ? '' : 's'}: ${found.pool.length - ex} summit${
          found.pool.length - ex === 1 ? '' : 's'}${ex ? ` and ${ex} existing site${ex === 1 ? '' : 's'}` : ''}
          screened over terrain sampled every ~${found.res} m${found.missing
            ? `, <span class="txt-warn">${found.missing} of ${found.tiles} tiles missing</span>` : ''};
          the best ${found.finals.length} checked the link budget card's way, kept at least
          ${fmtKm(spacingKm())} apart. Repeater radio ${esc(found.rep.sysName)} at ${found.rep.agl} m AGL,
          ${found.f.toFixed(3)} MHz.${found.flds.some(x => x && x.assumed)
            ? ` <span class="txt-muted">Sites with no complete radio on file are taken to carry ${
                esc(found.flds.find(x => x && x.assumed).sysName)}.</span>` : ''}`;
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
        <input type="number" id="sites-${id}" value="${value == null ? '' : value}" step="${step}"${
          min == null ? '' : ` min="${min}"`}${max == null ? '' : ` max="${max}"`}${
          placeholder ? ` placeholder="${escAttr(placeholder)}"` : ''}
               onchange="MapSites.set('${id}', this.value)">
        ${unit ? `<b class="lb-flag">${esc(unit)}</b>` : ''}
      </label>`;
  }

  // The drawn shapes that have an inside, each offering its stations. The
  // same "Select inside" answer Draw & measure gives — the stations the map is
  // showing inside it, so a filter that hides a site hides it here too.
  function shapesHtml() {
    let shapes = [];
    try { shapes = MapDraw.exportShapes().filter(s => s.kind === 'circle' || s.kind === 'rect'); }
    catch (_) { shapes = []; }
    const armed = !!awaitCircle;
    return `
      <div class="sites-row">
        <button type="button" id="sites-circle" class="${armed ? 'is-armed' : ''}"
                onclick="MapSites.drawCircle()"
                title="Click the middle of the area on the map, then click again at its edge — the stations inside it become the sites to serve"
                >◯ ${armed ? 'Drawing — click the map' : 'Draw a circle'}</button>
        <button type="button" onclick="MapSites.useSelection()"
                ${state.mapSelection && state.mapSelection.size ? '' : 'disabled'}
                title="Add the stations picked on the map (shift-click, box-select or Select inside)"
                >Add the map selection (${state.mapSelection ? state.mapSelection.size : 0})</button>
      </div>
      ${shapes.length ? `<div class="sites-shapes">${shapes.map(sh => `
        <button type="button" class="btn-link sites-shape" onclick="MapSites.addShape('${escAttr(sh.id)}')"
                title="Add the stations inside this drawn shape">
          Add the ${sh.stationIds.length} inside ${sh.kind === 'circle' ? '◯' : '▭'} ${esc(sh.label || sh.measure || '')}
        </button>`).join('')}</div>` : ''}`;
  }

  function pasteNoteHtml() {
    const p = pasteNote;
    if (!p) return '';
    const bits = [esc(p.text)];
    if (p.missing.length) bits.push(`<span class="txt-warn">not found: ${p.missing.map(esc).join(', ')}</span>`);
    if (p.ambiguous.length) {
      bits.push(`<span class="txt-warn">${p.ambiguous.map(a => `“${esc(a.term)}” matches ${a.n}`).join(', ')}
        — give the station number or the full name</span>`);
    }
    return bits.join(' · ');
  }

  function targetsHtml() {
    if (!targets.length) return '<p class="small txt-muted">No sites yet.</p>';
    return `
      <ul class="sites-targets" aria-label="Sites the repeater has to serve">
        ${targets.map(t => `
          <li>
            <span class="sites-t-name">${esc(t.name)}</span>
            <span class="small txt-muted">${esc(t.number || (t.kind === 'point' ? 'no station yet' : ''))}</span>
            <button type="button" class="sites-t-x" aria-label="Remove ${escAttr(t.name)}"
                    title="Remove ${escAttr(t.name)}" onclick="MapSites.removeTarget('${escAttr(t.key)}')">✕</button>
          </li>`).join('')}
      </ul>`;
  }

  function resultsHtml() {
    if (!results.length) return '';
    return `
      <ol class="sites-results">
        ${results.map(r => {
          const on = selected && selected.id === r.c.id;
          return `
          <li class="sites-result${on ? ' is-on' : ''}">
            <button type="button" class="sites-result-main" onclick="MapSites.select(${r.rank})"
                    aria-pressed="${on ? 'true' : 'false'}"
                    title="Show this site's paths on the map, and its figure for every site">
              <span class="sites-rank" aria-hidden="true">${r.rank}</span>
              <span class="sites-result-text">
                <strong>${Math.round(r.c.ground)} m</strong> · score ${Math.round(r.s.score)}
                <span class="small txt-muted">${esc(stationLatLonText(r.c))} — ${esc(whereText(r.c))}</span>
                <span class="small sites-result-sum">${summaryHtml(r)}</span>
                <span class="small">${roadHtml(r.c)}</span>
                <span class="small txt-muted">Elevation ${Math.round(r.s.E * 100)} · line of sight ${
                  Math.round(r.s.L * 100)} · fade margin ${Math.round(r.s.F * 100)} · road ${Math.round(r.s.R * 100)}
                  — out of 100 each, before the weights</span>
                <span class="small">${sourceText(r.s)}</span>
              </span>
            </button>
            ${on ? detailHtml(r) : ''}
          </li>`;
        }).join('')}
      </ol>`;
  }

  // Every site against the chosen candidate. A table, because "which of the
  // twelve is the one that fails" is a question read down a column.
  function detailHtml(r) {
    const worst = worstIndex(r.c);
    return `
      <div class="sites-detail">
        <div class="sites-actions">
          <button type="button" onclick="MapSites.flyTo(${r.rank})">Go to it</button>
          ${worst != null ? `<button type="button" onclick="MapSites.profile(${r.rank}, ${worst})"
                  title="Open the path to the worst-served site in the elevation profile and link budget">Profile the worst path</button>` : ''}
          ${copyLatLonPillHtml({ lat: r.c.lat, lon: r.c.lon })}
        </div>
        <div class="table-wrap">
          <table class="sites-table">
            <caption class="sr-only">Every site against repeater site ${r.rank}</caption>
            <thead><tr><th scope="col">Site</th><th scope="col">km</th><th scope="col">LOS</th><th scope="col">Margin</th><th scope="col"><span class="sr-only">Profile</span></th></tr></thead>
            <tbody>
              ${found.targets.map((t, k) => {
                const fig = figOf(r.c, k, true);
                const band = fig && !fig.failed ? bandOf(fig) : 'none';
                return `<tr>
                  <td>${esc(t.name)}</td>
                  <td>${fig ? fig.dKm.toFixed(1) : '—'}</td>
                  <td class="${fig && fig.verdict === 'obstructed' ? 'txt-bad' : fig && fig.verdict === 'marginal' ? 'txt-warn' : ''}">${
                    !fig || fig.failed ? '—' : fig.colo ? 'on it' : VERDICT[fig.verdict]}</td>
                  <td><span class="sites-band sites-band-${band}">${
                    !fig || fig.failed ? '—' : fig.colo ? 'on it' : dbText(fig.margin)}</span>${
                    fig && fig.src !== 'cover' && !fig.colo && !fig.failed ? '<span class="txt-muted" title="Not the land-cover figure">*</span>' : ''}</td>
                  <td>${fig && !fig.colo ? `<button type="button" class="btn-link" onclick="MapSites.profile(${r.rank}, ${k})"
                        aria-label="Profile the path to ${escAttr(t.name)}">↗</button>` : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function worstIndex(c) {
    let worst = null, wv = Infinity;
    found.targets.forEach((t, k) => {
      const fig = figOf(c, k, true);
      if (!fig || fig.failed || fig.colo) return;
      const v = fig.margin != null ? fig.margin : fig.verdict === 'obstructed' ? -1e9 : 1e9;
      if (v < wv) { wv = v; worst = k; }
    });
    return worst;
  }

  function panelHtml() {
    if (!state.data) {
      return '<p class="filter-note">No stations are loaded, so there are no sites to serve.</p>';
    }
    const sys = systems();
    const rep = repeaterSystem();
    const w = weights();
    return `
      <div class="sites-panel">
        <fieldset class="sites-fs">
          <legend>Sites to serve (${targets.length})</legend>
          <div id="sites-shapes">${shapesHtml()}</div>
          <label class="sites-paste">
            <span class="small">Or paste a list — station numbers, names, ALERT addresses or
              <code>4021-4025</code> windows, and a <code>lat, lon</code> on its own line for a site with no
              station yet. Put the base or the next repeater in too, if the new one has to reach it.</span>
            <textarea id="sites-paste" rows="3" spellcheck="false" autocomplete="off"
                      placeholder="541155&#10;Amiens Knob AL&#10;6128, 6129&#10;-27.51, 152.47"
                      oninput="MapSites.setPaste(this.value)">${esc(pasteText)}</textarea>
          </label>
          <div class="sites-row">
            <button type="button" onclick="MapSites.addPaste()">Add the list</button>
            <button type="button" onclick="MapSites.clearTargets()" ${targets.length ? '' : 'disabled'}>Clear sites</button>
          </div>
          <p class="small" id="sites-paste-note" aria-live="polite">${pasteNoteHtml()}</p>
          ${targetsHtml()}
        </fieldset>

        <fieldset class="sites-fs">
          <legend>Search</legend>
          <label class="filter-field">
            <span>Sites to find</span>
            <select onchange="MapSites.set('count', this.value)">
              ${[3, 4, 5].map(n => `<option value="${n}" ${count() === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </label>
          ${num('marginKm', 'Beyond the furthest site', cfg.marginKm, 1, 'km', 0, 100)}
          ${num('spacingKm', 'Keep results apart by', cfg.spacingKm, 0.5, 'km', 0, 50, 'auto')}
          <label class="filter-check">
            <input type="checkbox" ${cfg.existing ? 'checked' : ''}
                   onchange="MapSites.set('existing', this.checked)">
            Also score existing station sites in the area
          </label>
        </fieldset>

        <fieldset class="sites-fs">
          <legend>Repeater radio</legend>
          ${sys.length ? `
            <label class="filter-field">
              <span>Radio system</span>
              <select onchange="MapSites.set('sysId', this.value)">
                ${sys.map(x => `<option value="${x.id}" ${rep && rep.id === x.id ? 'selected' : ''}>${
                  esc(x.name)} — ${x.tx_power_w} W, ${x.antenna_gain_dbi} dBi, ${x.rx_threshold_dbm} dBm</option>`).join('')}
              </select>
            </label>
            ${num('agl', 'Mast height', cfg.agl, 0.5, 'm AGL', 0, 200, rep && rep.antenna_height_m != null ? String(rep.antenna_height_m) : String(PATH_DEFAULT_AGL))}
            ${num('freqMhz', 'Frequency', cfg.freqMhz, 0.001, 'MHz', 20, 20000, String(PATH_DEFAULT_MHZ))}`
            : '<p class="small txt-warn">No radio system on file carries all four of the figures a margin needs.</p>'}
        </fieldset>

        <fieldset class="sites-fs">
          <legend>What matters</legend>
          ${WEIGHTS.map(([k, label, hint]) => `
            <label class="filter-range">
              <span>${esc(label)} <strong>${w[k.slice(1, 2).toLowerCase()]}</strong></span>
              <input type="range" min="0" max="5" step="1" value="${cfg[k]}"
                     aria-label="${escAttr(label)} weight" title="${escAttr(hint)}"
                     onchange="MapSites.set('${k}', this.value)">
            </label>`).join('')}
          <p class="small txt-muted">A weight is a re-rank, not a re-run — move them after a search
            and the list reorders at once.</p>
        </fieldset>

        <div class="sites-actions">
          <button type="button" id="sites-run" class="primary" onclick="MapSites.run()"
                  ${readiness().ok && status.kind !== 'running' ? '' : 'disabled'}>Find sites</button>
          <button type="button" id="sites-cancel" onclick="MapSites.cancel()" ${status.kind === 'running' ? '' : 'hidden'}>Cancel</button>
          <button type="button" onclick="MapSites.clear()" ${results.length || targets.length ? '' : 'disabled'}>Clear</button>
          <button type="button" onclick="MapSites.save()" ${results.length ? '' : 'disabled'}
                  title="Every result against every site, as rows">Save CSV</button>
        </div>
        <p class="filter-note" id="sites-status">${statusHtml()}</p>
        ${resultsHtml()}
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Indicative. ~30 m terrain and its heights above the geoid, omnidirectional '
    + 'antennas, the land cover\'s representative heights and no buildings — a short list to '
    + 'take to a map and a landholder, not a site survey. Open a path in the elevation profile '
    + 'card before anything is built on it.';

  function render() {
    if (body) body.innerHTML = panelHtml();
  }

  function addShape(id) {
    let sh = null;
    try { sh = MapDraw.exportShapes().find(s => s.id === id); } catch (_) { sh = null; }
    if (!sh) return;
    const list = sh.stationIds.map(stationById).filter(Boolean).map(targetOfStation);
    if (!list.length) {
      pasteNote = { text: 'No stations on the map inside that shape.', missing: [], ambiguous: [] };
      render();
      return;
    }
    const r = addTargets(list);
    pasteNote = { text: addedText(r, 'station' + (r.added === 1 ? '' : 's') + ' from the drawn shape'),
                  missing: [], ambiguous: [] };
    if (map) mapNote(pasteNote.text, 4000);
    draw();
    render();
    rerenderMapLegend();
  }

  // ── The CSV ─────────────────────────────────────────────────────────────────

  function csvText() {
    if (!found || !results.length) return '';
    const q = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const w = weights();
    const rows = [
      '# MegaNet repeater site finder',
      `# search,${found.area.lat.toFixed(6)},${found.area.lon.toFixed(6)},${found.area.rKm.toFixed(2)} km`,
      `# repeater,${q(found.rep.sysName)},${found.rep.agl} m AGL,${found.f.toFixed(3)} MHz`,
      `# weights,elevation ${w.e},line of sight ${w.l},fade margin ${w.f},road reserve ${w.r}`,
      `# terrain,~${found.res} m grid screening; finalists at ${FINE_SAMPLES} samples with land cover`,
      'rank,site_lat,site_lon,ground_m,score,where,road_reserve,target,target_number,target_lat,target_lon,distance_km,los,margin_db,margin_down_db,margin_up_db,figure',
    ];
    for (const r of results) {
      const road = !r.c.road ? '' : !r.c.road.ok ? 'unchecked'
                 : r.c.road.inside ? `on: ${r.c.road.label}`
                 : r.c.road.distM != null ? `${Math.round(r.c.road.distM)} m: ${r.c.road.label}` : 'none';
      found.targets.forEach((t, k) => {
        const fig = figOf(r.c, k, true) || {};
        rows.push([
          r.rank, r.c.lat.toFixed(6), r.c.lon.toFixed(6), Math.round(r.c.ground), r.s.score.toFixed(1),
          q(whereText(r.c)), q(road), q(t.name), q(t.number), t.lat.toFixed(6), t.lon.toFixed(6),
          fig.dKm != null ? fig.dKm.toFixed(2) : '', fig.failed ? '' : fig.colo ? 'co-located' : fig.verdict || '',
          f1(fig.margin), f1(fig.down), f1(fig.up), fig.failed ? 'failed' : fig.src || '',
        ].join(','));
      });
    }
    return rows.join('\n') + '\n';
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      if (!m.getPane(LINE_PANE)) {
        const p = m.createPane(LINE_PANE);
        p.style.zIndex = LINE_Z;
        p.style.pointerEvents = 'none';
      }
      // In among the tools you point at the map: the polar plot sweeps from a
      // station, this finds where the station should have been.
      MapChrome.panel(m, {
        id: 'sites', icon: '🗼', title: 'Repeater site finder',
        group: 'tools', order: 25,
        html: () => panelHtml(),
        onMount(el) { body = el; },
      });
      // The sites and the answer are coordinates and figures, not a picture
      // pinned to a zoom, so they survive the map being rebuilt round them.
      draw();
    },

    detach() {
      // A pass in flight is for a map that is going away; its answer would
      // land on nothing. The sites and a finished answer are kept.
      if (job) {
        job.cancelled = true;
        job = null;
        if (!results.length) found = null;
        status = { kind: 'idle', text: '' };
      }
      awaitCircle = null;
      clearLayers();
      body = null;
      map = null;
    },

    active() { return results.length > 0; },

    legendHtml,

    run,

    cancel() {
      if (job) job.cancelled = true;
      job = null;
      if (!results.length) found = null;
      setStatus('idle', '');
      render();
    },

    // Reset's half (#191) and the panel's Clear: the sites, the answer, all of it.
    clear() {
      invalidate();
      targets = [];
      pasteNote = null;
      awaitCircle = null;
      draw();
      render();
      rerenderMapLegend();
    },

    clearTargets() {
      invalidate();
      targets = [];
      pasteNote = null;
      draw();
      render();
      rerenderMapLegend();
    },

    removeTarget(key) {
      const n = targets.length;
      targets = targets.filter(t => t.key !== key);
      if (targets.length !== n) invalidate();
      draw();
      render();
      rerenderMapLegend();
    },

    useSelection() {
      const ids = state.mapSelection ? [...state.mapSelection] : [];
      const list = ids.map(stationById).filter(Boolean).map(targetOfStation);
      const r = addTargets(list);
      pasteNote = { text: addedText(r, 'selected station' + (r.added === 1 ? '' : 's')), missing: [], ambiguous: [] };
      draw();
      render();
      rerenderMapLegend();
    },

    addShape,

    // Arm Draw & measure's own circle tool rather than growing a second one:
    // the circle stays on the map, in its list, editable to an exact radius
    // and exportable to Google Earth, and "the stations inside it" means what
    // Select inside already means there.
    drawCircle() {
      if (awaitCircle) {
        awaitCircle = null;
        if (state.draw.tool === 'circle') MapDraw.setTool('');
        render();
        return;
      }
      awaitCircle = new Set(state.draw.shapes.map(s => s.id));
      if (state.draw.tool !== 'circle') MapDraw.setTool('circle');
      if (map) mapNote('Click the middle of the area, then click again at its edge — the stations inside become the sites to serve. Esc stops.', 0);
      render();
    },

    // MapDraw.rerenderPanel's hook — the one place a shape is added, edited or
    // removed. Cheap on purpose: it is called for every one of those.
    drawingChanged() {
      if (awaitCircle) {
        if (state.draw.tool !== 'circle') {
          // Esc, another tool, a reset: the operator stopped drawing.
          awaitCircle = null;
        } else {
          const fresh = state.draw.shapes.find(s => s.kind === 'circle' && !awaitCircle.has(s.id));
          if (fresh) {
            awaitCircle = null;
            MapDraw.setTool('');
            addShape(fresh.id);
            return;
          }
        }
      }
      const el = document.getElementById('sites-shapes');
      if (el) el.innerHTML = shapesHtml();
    },

    setPaste(v) { pasteText = String(v || ''); },

    addPaste() {
      const el = document.getElementById('sites-paste');
      if (el) pasteText = el.value;
      if (!pasteText.trim()) return;
      const got = resolvePaste(pasteText);
      const list = got.hits.map(targetOfStation).concat(got.points.map(targetOfPoint));
      const r = addTargets(list);
      pasteNote = { text: addedText(r, 'site' + (r.added === 1 ? '' : 's')),
                    missing: got.missing, ambiguous: got.ambiguous };
      // What was understood is cleared out of the box; what was not stays, so
      // it can be corrected where it was typed.
      pasteText = got.missing.concat(got.ambiguous.map(a => a.term)).join('\n');
      draw();
      render();
      rerenderMapLegend();
    },

    select(rank, opts) {
      const r = results.find(x => x.rank === +rank);
      if (!r) return;
      selected = r.c;
      draw();
      render();
      if (opts && opts.keepPopup && layer) {
        layer.eachLayer(l => {
          const ll = l.getLatLng && l.getLatLng();
          if (ll && Math.abs(ll.lat - r.c.lat) < 1e-9 && Math.abs(ll.lng - r.c.lon) < 1e-9) l.openPopup();
        });
      }
    },

    flyTo(rank) {
      const r = results.find(x => x.rank === +rank);
      if (!r || !map) return;
      map.panTo([r.c.lat, r.c.lon]);
      mapNote(`Repeater site #${r.rank} — ${Math.round(r.c.ground)} m at ${stationLatLonText(r.c)}`, 6000);
    },

    // One path into the elevation profile and the link budget, the way the
    // backbone card and the budget card hand theirs over: a two-point line in
    // Draw & measure, reused if it is already there.
    profile(rank, k) {
      const r = results.find(x => x.rank === +rank);
      const t = found && found.targets[+k];
      if (!r || !t) return;
      const pa = [r.c.lat, r.c.lon], pb = [t.lat, t.lon];
      const existing = MapDraw.findLine(pa, pb);
      if (existing) MapDraw.focus(existing.id);
      else MapDraw.addLine([pa, pb], [r.c.sid || null, t.sid || null]);
      mapNote(`Profiling site #${r.rank} → ${t.name} — the card is under the map.`, 5000);
    },

    save() {
      const text = csvText();
      if (!text) return;
      dlText(`repeater-sites-${slug(found.targets[0].name)}-${found.targets.length}.csv`, text);
    },

    csvText,

    // One setter for every control on the panel, MapPolar's shape. An empty
    // box means "follow the default", not nought.
    set(key, value) {
      const asNum = v => { const s = String(v).trim(); return s === '' ? null : (isFinite(+s) ? +s : null); };
      const RERANK = ['count', 'spacingKm', 'wElev', 'wLos', 'wFade', 'wRoad'];
      switch (key) {
        case 'existing': cfg.existing = !!value; break;
        case 'sysId':    cfg.sysId = +value; break;
        case 'count':    cfg.count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(+value) || MAX_COUNT)); break;
        case 'marginKm': cfg.marginKm = Math.max(0, asNum(value) == null ? 5 : asNum(value)); break;
        case 'spacingKm': case 'agl': case 'freqMhz': {
          const v = asNum(value);
          cfg[key] = v != null && v > 0 ? v : null;
          break;
        }
        default:
          if (!/^w(Elev|Los|Fade|Road)$/.test(key)) return;
          cfg[key] = Math.max(0, Math.min(5, Math.round(+value) || 0));
      }
      save();
      if (RERANK.includes(key)) {
        if (found && !job) rerank();
        else { if (job) rerankDue = true; render(); }
      } else {
        invalidate();
        draw();
        render();
        rerenderMapLegend();
      }
    },

    // For the checks, and for anybody at the console.
    targets() { return targets.map(t => ({ ...t })); },
    results() {
      return results.map(r => ({
        rank: r.rank, lat: r.c.lat, lon: r.c.lon, ground: r.c.ground, src: r.c.src, name: r.c.name,
        score: r.s.score, E: r.s.E, L: r.s.L, F: r.s.F, R: r.s.R,
        clear: r.s.clear, marginal: r.s.marginal, obstructed: r.s.obstructed, failed: r.s.failed,
        served: r.s.served, min: r.s.min, median: r.s.median,
        cover: r.s.cover, bare: r.s.bare, grid: r.s.grid,
        road: r.c.road === undefined ? undefined : r.c.road && { ...r.c.road },
        figs: found.targets.map((t, k) => ({ ...(figOf(r.c, k, true) || {}) })),
      }));
    },
    pool() { return found ? found.pool.map(c => ({ id: c.id, lat: c.lat, lon: c.lon, ground: c.ground, src: c.src })) : []; },
    area() { const a = found ? found.area : areaOf(targets); return a ? { ...a } : null; },
    status() { return { ...status }; },
    selectedRank() { const r = results.find(x => selected && x.c.id === selected.id); return r ? r.rank : null; },
  };
})();
if (typeof window !== 'undefined') window.MapSites = MapSites;
