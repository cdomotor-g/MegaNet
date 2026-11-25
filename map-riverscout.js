// MegaNet — map-riverscout.js
//
//   MapRiverScout   the riverside site finder: click a place on the Stations
//                   map and it says how good a home a station would have
//                   there — how well the repeaters and base stations near it
//                   would hear it, how cleanly the stations already standing
//                   round it are heard in practice, and how close it is to a
//                   river — and, on a button, does the same for every spot
//                   along that river a few kilometres either way and draws the
//                   answer as a strip: the river's own quality, spot by spot.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm,
// bearingDeg, cssVar, slug, dlText, announce, termHtml, stationLatLonText and
// mapViewPills; across to path-profile.js for pathGround, pathAnalyse,
// pathPropOf, rmSystemOf, stationAntenna, stationIsMast, wattsToDbm and the
// PATH_DEFAULT_* constants, land-cover.js for LandCover.sample,
// map-river-lines.js for MapRiverLines (the rivers, and their stations),
// map-controls.js for MapChrome.panel, auth.js for Auth, datastore.js for
// dbSelect, and app.js for stationAlertIds, rerenderMapLegend. All of it from
// inside its own functions, so this file's position among the modules is free.
//
// ── The question this answers ────────────────────────────────────────────────
// Asked for in these words: "Station relocation tool to consider riverine
// locations with good errts." Read as: a station that has to move, or a new
// one, is wanted *on a river* — that is what a flood warning station is for —
// and the place on the river has to hear, and be heard, well. The relocation
// finder (map-relocate.js) asks the near question: where within a few hundred
// metres of a station that stands today. The best repeater finder
// (map-bestrep.js) asks which mast should carry a station. Neither looks at the
// river, and neither looks at what the receivers have actually heard. This
// does both, a river at a time.
//
// ── The score ────────────────────────────────────────────────────────────────
// Three figures, each nought to one, weighted and printed beside every answer:
//
//   Heard         the fade margin to the best repeater or base within reach,
//                 the link budget card's own arithmetic (pathGround and
//                 pathAnalyse, the radio most of the network runs, one way):
//                 nought at 6 dB under the map's "ok", one at 10 dB over its
//                 "good". Weight .55.
//   Neighbours    how cleanly the stations already standing within NEAR_KM are
//                 heard, from the reception rollup (reception_daily, the last
//                 DAYS days): good frames out of every frame heard, nought at
//                 70%, one at 100%, nearer stations and stations on the same
//                 river counting for more. Receptions are for editors, so
//                 anybody else sees this figure as not available and the other
//                 two share its weight. Weight .25.
//   Riverside     how close the place is to a river line: one within 150 m,
//                 nought at 1.5 km. The lines are the 1:250,000 Geofabric's, so
//                 a hundred metres either way is the map's own error. Weight .20.
//
// A place no repeater or base hears at the map's "ok" is held under half marks
// whatever else it has: the margin is the requirement, the rest is preference.
//
// ── Along the river ──────────────────────────────────────────────────────────
// The river's lines, joined end to end from the click, are walked SPAN_KM each
// way and a place taken every STEP_M. Each is scored as above — the river part
// is one by construction — and the whole run is the strip: a cell a place, as
// tall as its score, coloured by band, in the order along the river. The same
// places are dotted on the map, and the best five numbered.
//
// ── What it is not ───────────────────────────────────────────────────────────
// ~30 m terrain and omnidirectional antennas; a river line good to a hundred
// metres; nothing about whether the bank floods, the ground holds a footing or
// the landholder agrees. A short list to walk on site, not a survey.
const MapRiverScout = (function () {
  const PANE = 'mnScout', PANE_Z = 666;
  const STORE = 'mn-riverscout-v1';
  const DAYS = 14;                 // the reception rollup read: this many UTC days
  const MIN_FRAMES = 30;           // fewer frames than this and a station's record is not a record
  const NEAR_KM = 15;              // stations this close speak for a place
  const MAX_PAGES = 60;            // a rollup page is 1,000 rows
  const PAGE = 1000;
  const MAX_RX = 4;                // repeaters and bases priced for one place, nearest first
  const SAMPLES_ONE = 256;         // the card's figure for one place
  const SAMPLES_SWEEP = 96;        // a place on the strip
  const CONCURRENCY = 3;
  const RIVER_FULL_M = 150, RIVER_NONE_M = 1500;
  const SNAP_M = 1500;             // a click this close to a river line is on that river
  const JOIN_M = 150;              // lines this close end to end are one river
  const WEIGHTS = { heard: 0.55, nbr: 0.25, river: 0.20 };
  const SPANS = [5, 10, 20];       // km each way
  const STEPS = [250, 500, 1000];  // metres
  const MAX_PLACES = 81;
  const PINNED = 5;
  const BAND = {
    good: ['--map-fade-good', '#00e676'], ok: ['--map-fade-ok', '#ffab00'],
    bad:  ['--map-fade-bad', '#e53935'],  none: ['--muted', '#888888'],
  };

  const cfg = load();
  let map = null, body = null, layer = null;
  let armed = false;
  let site = null;           // { lat, lon } the click
  let here = null;           // the one-place answer
  let sweep = null;          // { river, places[], span, step, ends } the strip
  let selected = null;       // the place the card shows: 'site' or an index into sweep.places
  let job = null;            // { cancelled } while a pass runs
  let status = { kind: 'idle', text: '' };
  let record = { phase: 'idle', byStation: new Map(), rows: 0, capped: false, note: '' };

  // ── Settings ────────────────────────────────────────────────────────────────

  function load() {
    const d = { span: 10, step: 500 };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (_) { return d; }
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (_) { /* private browsing */ } }

  const goodDb = () => (state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15);
  const okDb = () => (isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6);
  const linkKm = () => (state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100);
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const stations = () => (state.data && state.data.stations) || [];
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();

  // ── The words ───────────────────────────────────────────────────────────────
  // One list, read by the headings, the chips and the fold that says them
  // without a hover (docs/design-system.md, "Words that mean something here").

  function words() {
    const G = goodDb(), O = okDb();
    return {
      score: 'The three figures below, weighted and added, out of 100. 70 or more is a good home, 50 to 70 a fair one, under 50 a poor one — '
        + `and a place no repeater or base hears at ${O} dB or better never scores 50.`,
      heard: 'How well a repeater or base station near the place would hear a station there: the fade margin — how many decibels the '
        + 'signal arrives above what the receiver needs, one way — to the best one within reach, worked out the link budget card\'s way over ~30 m terrain.',
      margin: `Fade margin: decibels to spare. ${G} dB or more is good, ${O} to ${G} is enough for most days, under ${O} is likely to drop readings in a storm.`,
      nbr: `How cleanly the stations already standing within ${NEAR_KM} km of the place are heard in practice: the share of the frames the receivers heard `
        + `from them over the last ${DAYS} days that were good, from the reception rollup. 100% scores one, 70% or less scores nought. Nearer stations, and `
        + 'stations on the same river, count for more. Receptions are for editors; for anybody else this figure is not available.',
      river: 'How close the place is to a river line on the Geofabric map: one within 150 m, nought at 1.5 km. The lines are drawn from a 1:250,000 map, '
        + 'so a hundred metres either way is the map\'s own error. It says nothing about whether the bank floods.',
      strip: 'The river, one cell for each place along it, in the order you would walk it. A cell is as tall as the place\'s score and coloured by '
        + 'its band; the vertical line marks the place you clicked. Press a cell to see why.',
      clean: 'Good frames out of every frame heard from a station — frames that decoded and passed their checks, against all those the receivers heard, '
        + 'including the ones that did not decode.',
      line: 'Line of sight to that receiver: clear, partly clear (the ground or trees reach into the first Fresnel zone, which costs some signal the margin already counts) or obstructed.',
      weights: 'Heard 55%, neighbours 25%, riverside 20%. Without the neighbours\' record — signed out, or none within reach — heard counts 73% and riverside 27%.',
    };
  }

  const GLOSSARY = [
    ['score', 'Score'], ['heard', 'Heard'], ['margin', 'Fade margin'], ['nbr', 'Neighbours'],
    ['river', 'Riverside'], ['strip', 'Strip along the river'], ['clean', 'Clean'], ['line', 'Line of sight'], ['weights', 'Weights'],
  ];

  function term(k, text) { return termHtml(text || (GLOSSARY.find(g => g[0] === k) || [k, k])[1], words()[k]); }

  function glossaryHtml() {
    const w = words();
    return `<details class="bestrep-words"><summary>What the words on this panel mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(w[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── The radio ───────────────────────────────────────────────────────────────
  // map-bestrep.js's rules, which this inherits: a term nobody supplied blanks
  // the figure rather than being read as nought.

  const complete = sys => !!sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null
    && sys.line_loss_db != null && sys.rx_threshold_dbm != null;

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
    return { sysId: sys.id, sysName: sys.name, txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
             loss: sys.line_loss_db, thr: sys.rx_threshold_dbm, agl };
  }

  function newStationRadio() {
    const sys = fieldDefault();
    return sys ? radioOf(sys, stationAntenna({ roles: ['field'] }, sys).agl) : null;
  }

  function hubOf(s) {
    const sys = rmSystemOf(s);
    return {
      id: s.id, s, name: s.name, number: s.station_number || '', lat: s.lat, lon: s.lon,
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      rad: complete(sys) ? radioOf(sys, stationAntenna(s, sys).agl) : null, mast: stationIsMast(s),
      f: s.repeater && s.repeater.rx_mhz > 0 ? s.repeater.rx_mhz : PATH_DEFAULT_MHZ,
      isBase: s.roles.includes('base'), isRep: s.roles.includes('repeater') && !!s.repeater,
    };
  }

  const isHub = s => !!s && Array.isArray(s.roles) && s.lat != null && s.lon != null
    && ((s.roles.includes('repeater') && !!s.repeater) || s.roles.includes('base'));

  // The nearest repeaters and bases within reach of a place, nearest first.
  function receiversFor(lat, lon) {
    return stations().filter(isHub)
      .map(s => ({ s, km: acmaHaversineKm(lat, lon, s.lat, s.lon) }))
      .filter(x => x.km <= linkKm())
      .sort((a, b) => a.km - b.km)
      .slice(0, MAX_RX)
      .map(x => ({ ...hubOf(x.s), km: x.km }));
  }

  function oneWay(loss, from, to) {
    const tx = wattsToDbm(from.txW);
    if (tx == null || loss == null) return null;
    return tx + from.gain - from.loss - loss + to.gain - to.loss - to.thr;
  }

  async function hop(p, rad, hub, samples) {
    if (!hub.rad) return { hub, km: hub.km, failed: 'no complete radio on file for it' };
    const got = await pathGround(
      { lat: p.lat, lon: p.lon, elev: null, agl: rad.agl, mast: false },
      { lat: hub.lat, lon: hub.lon, elev: hub.elev, agl: hub.rad.agl, mast: hub.mast },
      { samples, freqMhz: hub.f });
    if (!got || !got.ok) return { hub, km: hub.km, failed: 'the terrain could not be read' };
    if (got.prof.partial) return { hub, km: hub.km, failed: 'the terrain had gaps along it' };
    const coverModel = pathPropOf().model === 'cover';
    const res = coverModel ? await LandCover.sample(got.prof.lat, got.prof.lon) : null;
    if (coverModel && !(res && res.ok)) return { hub, km: hub.km, failed: 'the land cover could not be read' };
    const an = pathAnalyse(got.prof, {
      elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: rad.agl, aglB: hub.rad.agl, freqMhz: hub.f,
      cover: res ? res.cls : null, canopy: res && res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return { hub, km: hub.km, failed: 'the model refused the path' };
    return { hub, km: hub.km, verdict: an.verdict, margin: oneWay(an.pathLoss_db, rad, hub.rad) };
  }

  // ── What the receivers actually heard ───────────────────────────────────────
  // reception_daily, bounded to the last DAYS UTC days on its own `bucket`
  // column and ordered as signal-routes.js's read is — rollups, never the raw
  // receptions (CLAUDE.md, "Querying the live database by hand"). Summed per
  // transmitting station here, so a station heard at three receivers is one
  // record.

  const dayOf = t => new Date(t).toISOString().slice(0, 10);

  async function loadRecord() {
    if (record.phase === 'loading' || record.phase === 'ready') return;
    if (typeof dbSelect !== 'function' || !signedIn()) {
      record = { phase: 'denied', byStation: new Map(), rows: 0, capped: false, note: 'Receptions are for editors — sign in as one to include how cleanly the neighbouring stations are heard.' };
      rerender();
      return;
    }
    record = { phase: 'loading', byStation: new Map(), rows: 0, capped: false, note: '' };
    rerender();
    const from = dayOf(Date.now() - (DAYS - 1) * 86400000);
    const path = `reception_daily?select=bucket,point_id,station,protocol,n,n_ok&protocol=in.(alert,alert2)&station=not.is.null&bucket=gte.${from}`
      + '&order=bucket.asc,ingest_token_id.asc,point_id.asc,station.asc.nullsfirst,path.asc.nullsfirst,survey.asc.nullsfirst';
    const tot = new Map();   // 'alert:123' | 'alert2:45' → { n, ok }
    try {
      let rows = 0, capped = false;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) { capped = true; break; }
        const got = await dbSelect(`${path}&limit=${PAGE}&offset=${page * PAGE}`);
        for (const r of got) {
          const k = `${r.protocol}:${r.station}`;
          const t = tot.get(k) || { n: 0, ok: 0 };
          t.n += r.n || 0; t.ok += r.n_ok || 0;
          tot.set(k, t);
        }
        rows += got.length;
        if (got.length < PAGE) break;
      }
      record = { phase: 'ready', byStation: byRegisterStation(tot), rows, capped, note: '' };
    } catch (err) {
      record = { phase: 'denied', byStation: new Map(), rows: 0, capped: false,
        note: err && (err.status === 401 || err.status === 403)
          ? 'Receptions are for editors — sign in as one to include how cleanly the neighbouring stations are heard.'
          : `The reception record could not be read — ${(err && err.message) || err}.` };
    }
    rerender();
  }

  // A transmitter's frames are the ALERT address of one of the station's
  // sensors, or its ALERT2 station id; either is the register's station.
  function byRegisterStation(tot) {
    const out = new Map();
    const add = (s, t) => {
      if (!t || t.n < 1) return;
      const cur = out.get(s.id) || { st: s, n: 0, ok: 0 };
      cur.n += t.n; cur.ok += t.ok;
      out.set(s.id, cur);
    };
    for (const s of stations()) {
      if (s.lat == null || s.lon == null) continue;
      let ids = [];
      try { ids = stationAlertIds(s); } catch (_) { ids = []; }
      for (const a of ids) add(s, tot.get(`alert:${a}`));
      if (s.alert2_station_id != null) add(s, tot.get(`alert2:${Number(s.alert2_station_id)}`));
    }
    for (const v of out.values()) v.share = v.n ? v.ok / v.n : null;
    return new Map([...out].filter(([, v]) => v.n >= MIN_FRAMES));
  }

  // The stations within NEAR_KM of a place that have a record, and their
  // distance-weighted clean share (stations on the place's own river count double).
  function neighboursOf(lat, lon, riverId) {
    if (record.phase !== 'ready') return null;
    const near = [];
    for (const v of record.byStation.values()) {
      const km = acmaHaversineKm(lat, lon, v.st.lat, v.st.lon);
      if (km > NEAR_KM) continue;
      let w = 1 / (1 + km / 3);
      let sameRiver = false;
      if (riverId != null && typeof MapRiverLines !== 'undefined') {
        try { const r = MapRiverLines.riverOf(v.st); sameRiver = !!r && r.id === riverId; } catch (_) { /* rivers not loaded */ }
      }
      if (sameRiver) w *= 2;
      near.push({ st: v.st, km, share: v.share, n: v.n, w, sameRiver });
    }
    if (!near.length) return { count: 0, share: null, near: [] };
    const sw = near.reduce((a, x) => a + x.w, 0);
    const share = near.reduce((a, x) => a + x.w * x.share, 0) / sw;
    near.sort((a, b) => b.w - a.w);
    return { count: near.length, share, near };
  }

  // ── Scoring ─────────────────────────────────────────────────────────────────

  const heardFig = best => (best == null ? null : clamp01((best - (okDb() - 6)) / ((goodDb() + 10) - (okDb() - 6))));
  const nbrFig = nb => (nb && nb.share != null ? clamp01((nb.share - 0.7) / 0.3) : null);
  const riverFig = m => (m == null ? 0 : clamp01(1 - (m - RIVER_FULL_M) / (RIVER_NONE_M - RIVER_FULL_M)));

  function bandOfDb(v) { return v == null || !isFinite(v) ? 'none' : v >= goodDb() ? 'good' : v >= okDb() ? 'ok' : 'bad'; }
  function bandOfScore(sc) { return sc == null ? 'none' : sc >= 70 ? 'good' : sc >= 50 ? 'ok' : 'bad'; }
  function bandColour(b) { return cssVar(BAND[b][0], BAND[b][1]); }

  // One place, from its three figures. A part nobody can supply leaves the
  // others to share its weight; no receiver priced at all is no score.
  function combine(heard, nbr, riv, best) {
    if (heard == null) return { score: null, parts: { heard, nbr, riv }, used: {} };
    const parts = [['heard', heard], ['nbr', nbr], ['river', riv]].filter(([, v]) => v != null);
    const wsum = parts.reduce((a, [k]) => a + WEIGHTS[k], 0);
    const used = {};
    let total = 0;
    for (const [k, v] of parts) { used[k] = WEIGHTS[k] / wsum; total += v * used[k]; }
    let score = Math.round(total * 100);
    const capped = best != null && best < okDb() && score > 49;
    if (capped) score = 49;
    return { score, capped, parts: { heard, nbr, riv }, used };
  }

  async function scorePlace(p, samples, riverHit, seq) {
    const rad = newStationRadio();
    if (!rad) return { ...p, failed: 'No radio system on file carries all four of transmit power, antenna gain, line loss and receiver threshold — there is no margin to compute.', score: null, hops: [] };
    const rx = receiversFor(p.lat, p.lon);
    const hops = [];
    for (const h of rx) {
      if (seq !== undefined && job && job.seq !== seq) break;
      hops.push(await hop(p, rad, h, samples));
    }
    const margins = hops.filter(h => h.margin != null).map(h => h.margin);
    const best = margins.length ? Math.max(...margins) : null;
    const nb = neighboursOf(p.lat, p.lon, riverHit ? riverHit.id : null);
    const riv = riverFig(riverHit ? riverHit.m : null);
    const c = combine(heardFig(best), nbrFig(nb), riv, best);
    return { ...p, rad, hops, best, nOk: margins.filter(m => m >= okDb()).length, nb, river: riverHit,
             riverM: riverHit ? riverHit.m : null, ...c };
  }

  // ── Along the river ─────────────────────────────────────────────────────────
  // The river's lines, in metres from the click, joined end to end where two
  // meet within JOIN_M, and walked each way from where the click lands on them.

  function stretchAround(lat, lon, riverId, spanM, stepM) {
    const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    const lines = (MapRiverLines.courseOf(riverId) || []).map(r => r.map(([a, b]) => [(b - lon) * kx, (a - lat) * ky])).filter(l => l.length > 1);
    if (!lines.length) return null;
    // where the origin lands on a line: line, segment, spot
    let at = null;
    lines.forEach((l, li) => {
      for (let i = 1; i < l.length; i++) {
        const [ax, ay] = l[i - 1], [bx, by] = l[i];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
        if (!at || d < at.d) at = { li, i, d, x: px, y: py };
      }
    });
    if (!at) return null;
    const used = new Set([at.li]);
    // From a start, the chain of vertices outward, line after line, to spanM.
    const walk = (first, dirFwd) => {
      const chain = [[at.x, at.y]];
      let len = 0, cur = at.li, rest = dirFwd ? lines[cur].slice(at.i) : lines[cur].slice(0, at.i).reverse();
      for (;;) {
        for (const v of rest) {
          const last = chain[chain.length - 1];
          len += Math.hypot(v[0] - last[0], v[1] - last[1]);
          chain.push(v);
          if (len >= spanM) return chain;
        }
        const end = chain[chain.length - 1];
        let next = null;
        lines.forEach((l, li) => {
          if (used.has(li)) return;
          const dS = Math.hypot(l[0][0] - end[0], l[0][1] - end[1]);
          const dE = Math.hypot(l[l.length - 1][0] - end[0], l[l.length - 1][1] - end[1]);
          const d = Math.min(dS, dE);
          if (d <= JOIN_M && (!next || d < next.d)) next = { li, d, rev: dE < dS };
        });
        if (!next) return chain;
        used.add(next.li);
        cur = next.li;
        rest = next.rev ? lines[cur].slice().reverse() : lines[cur].slice();
      }
    };
    const fwd = walk(0, true), back = walk(0, false);
    const along = chain => {
      const out = [];
      let target = stepM, run = 0;
      for (let i = 1; i < chain.length; i++) {
        const [ax, ay] = chain[i - 1], [bx, by] = chain[i];
        const seg = Math.hypot(bx - ax, by - ay);
        while (seg > 0 && run + seg >= target && target <= spanM) {
          const t = (target - run) / seg;
          out.push([ax + t * (bx - ax), ay + t * (by - ay), target]);
          target += stepM;
        }
        run += seg;
      }
      return out;
    };
    const toLL = ([x, y]) => ({ lat: lat + y / ky, lon: lon + x / kx });
    const places = [
      ...along(back).reverse().map(([x, y, d]) => ({ off: -d, ...toLL([x, y]) })),
      { off: 0, ...toLL([at.x, at.y]) },
      ...along(fwd).map(([x, y, d]) => ({ off: d, ...toLL([x, y]) })),
    ];
    return { places, snapM: at.d, endBack: toLL(back[back.length - 1]), endFwd: toLL(fwd[fwd.length - 1]) };
  }

  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = brg => COMPASS[Math.round(((brg % 360) + 360) % 360 / 45) % 8];

  async function lanes(list, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length && job && !job.cancelled) { const k = i++; await fn(list[k], k); }
    }));
  }

  function setStatus(kind, text) { status = { kind, text }; const el = document.getElementById('riverscout-status'); if (el) el.innerHTML = statusHtml(); }

  async function scoreHere() {
    if (!site) return;
    const mine = job = { cancelled: false, seq: (job ? job.seq : 0) + 1 };
    here = null; sweep = null; selected = 'site';
    setStatus('running', 'Finding the river and pricing the paths…');
    draw(); render();
    loadRecord();
    let hit = null;
    if (typeof MapRiverLines !== 'undefined') hit = await MapRiverLines.nearestTo(site.lat, site.lon, SNAP_M);
    if (mine.cancelled) return;
    const got = await scorePlace({ lat: site.lat, lon: site.lon }, SAMPLES_ONE, hit, mine.seq);
    if (mine.cancelled) return;
    // The record may have arrived while the paths were priced.
    if (record.phase === 'ready' && got.nb == null) {
      const nb = neighboursOf(got.lat, got.lon, hit ? hit.id : null);
      Object.assign(got, { nb }, combine(heardFig(got.best), nbrFig(nb), riverFig(hit ? hit.m : null), got.best));
    }
    here = got;
    job = null;
    setStatus('done', '');
    announce(got.score == null ? 'Could not score that place.' : `That place scores ${got.score} out of 100.`);
    draw(); render(); rerenderMapLegend();
  }

  async function sweepRiver() {
    if (!site || !here || !here.river) return;
    const mine = job = { cancelled: false, seq: (job ? job.seq : 0) + 1 };
    const river = here.river;
    setStatus('running', 'Walking the river…');
    // The river's own lines, round the place, before they are asked for.
    if (typeof MapRiverLines !== 'undefined') {
      const d = cfg.span / 100;
      await Promise.all([[d, 0], [-d, 0], [0, d], [0, -d]].map(([a, b]) => MapRiverLines.near(river.lat + a, river.lon + b).catch(() => null)));
    }
    if (mine.cancelled) return;
    const st = stretchAround(river.lat, river.lon, river.id, cfg.span * 1000, cfg.step);
    if (!st) { job = null; setStatus('idle', 'The river\'s line could not be read here.'); render(); return; }
    let places = st.places;
    if (places.length > MAX_PLACES) {
      const keep = Math.ceil(places.length / MAX_PLACES);
      places = places.filter((_, i) => i % keep === 0 || places[i].off === 0);
    }
    const out = places.map(p => ({ ...p, score: undefined, pending: true }));
    sweep = { river, places: out, span: cfg.span, step: cfg.step, done: 0,
              ends: { back: compass(bearingDeg(river.lat, river.lon, st.endBack.lat, st.endBack.lon)),
                      fwd: compass(bearingDeg(river.lat, river.lon, st.endFwd.lat, st.endFwd.lon)) } };
    selected = 'site';
    draw(); render();
    await lanes(out, CONCURRENCY, async (p, i) => {
      const got = await scorePlace({ lat: p.lat, lon: p.lon, off: p.off }, SAMPLES_SWEEP, { id: river.id, title: river.title, m: 0 }, mine.seq);
      if (mine.cancelled) return;
      out[i] = { ...got, off: p.off };
      sweep.done++;
      setStatus('running', `${sweep.done} of ${out.length} places priced…`);
      if (sweep.done % 4 === 0) { draw(); render(); }
    });
    if (mine.cancelled) return;
    job = null;
    rank();
    setStatus('done', '');
    announce(`${sweep.places.filter(p => p.score != null).length} places along ${river.title} scored.`);
    draw(); render(); rerenderMapLegend();
  }

  function rank() {
    if (!sweep) return;
    const ok = sweep.places.map((p, i) => ({ p, i })).filter(x => x.p.score != null)
      .sort((a, b) => b.p.score - a.p.score || Math.abs(a.p.off) - Math.abs(b.p.off));
    sweep.order = ok.map(x => x.i);
    sweep.places.forEach(p => { p.rank = 0; });
    ok.slice(0, PINNED).forEach((x, n) => { sweep.places[x.i].rank = n + 1; });
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() { if (layer) { layer.remove(); layer = null; } }

  function current() {
    if (selected === 'site') return here;
    return sweep && typeof selected === 'number' ? sweep.places[selected] : here;
  }

  function draw() {
    clearLayers();
    if (!map || !site) return;
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    const accent = cssVar('--accent', '#0b5cab');
    if (sweep) {
      sweep.places.forEach((p, i) => {
        if (p.pending && p.score === undefined) {
          L.circleMarker([p.lat, p.lon], { pane: PANE, radius: 3, color: bandColour('none'), weight: 1, fillOpacity: .4 }).addTo(layer);
          return;
        }
        const col = bandColour(bandOfScore(p.score));
        const dot = L.circleMarker([p.lat, p.lon], { pane: PANE, radius: p.rank ? 0.1 : 5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: .95 }).addTo(layer);
        dot.on('click', () => pickPlace(i));
        if (p.rank) {
          L.marker([p.lat, p.lon], { pane: PANE, icon: pinIcon(p, selected === i), keyboard: false }).addTo(layer).on('click', () => pickPlace(i));
        }
      });
    }
    const cur = current();
    if (cur && cur.hops) {
      for (const h of cur.hops) {
        if (h.margin == null) continue;
        L.polyline([[cur.lat, cur.lon], [h.hub.lat, h.hub.lon]], {
          pane: PANE, color: bandColour(bandOfDb(h.margin)), weight: 3, opacity: .85,
          dashArray: h.verdict === 'obstructed' ? '6 6' : null,
        }).addTo(layer);
      }
    }
    L.circleMarker([site.lat, site.lon], { pane: PANE, radius: 8, color: accent, weight: 3, fillColor: '#fff', fillOpacity: .9 })
      .bindTooltip('The place you clicked').addTo(layer);
  }

  function pinIcon(p, on) {
    return L.divIcon({
      className: 'mn-site-icon',
      html: `<span class="mn-site${on ? ' is-on' : ''}"><b class="mn-site-h">${p.score}</b><i class="mn-site-mark" aria-hidden="true">${p.rank}</i></span>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function legendHtml() {
    if (!site) return '';
    return `<span class="legend-item"><span class="legend-site" aria-hidden="true">1</span>
      <span class="small">Riverside site finder — the ring is the place clicked; dots along the river are places scored for how well a station there would be heard
      (green 70 or more, yellow 50 to 70, red under 50, grey not priced); the numbered pins are the best five. Lines run to the repeaters and
      bases that would hear it, coloured by fade margin.</span></span>`;
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  const dbText = v => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);
  const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const VERDICT = { clear: 'clear', marginal: 'partly clear', obstructed: 'obstructed' };

  function statusHtml() {
    if (status.kind === 'running') return esc(status.text);
    if (status.text) return esc(status.text);
    if (!site) return 'Pick a place on the map, as close to a river as you would put a station.';
    if (!here) return '';
    if (here.failed) return esc(here.failed);
    if (here.score == null) return 'No repeater or base within reach could be priced from there — see the paths below.';
    const rv = here.river ? `${esc(here.river.title)}, ${Math.round(here.river.m)} m away` : 'no mapped river within 1.5 km';
    return `Scored ${here.score} out of 100. Nearest river: ${rv}.`;
  }

  function recordHtml() {
    if (record.phase === 'loading') return 'Reading how cleanly the receivers have heard the stations round about…';
    if (record.phase === 'denied') return esc(record.note);
    if (record.phase === 'ready') {
      return `Record read: ${record.byStation.size} stations with ${MIN_FRAMES}+ frames in the last ${DAYS} days`
        + `${record.capped ? ' (the busiest part — the read was capped)' : ''}.`;
    }
    return 'The neighbours\' record is read when a place is first scored.';
  }

  function figRow(label, key, fig, detail) {
    return `<tr><th scope="row">${term(key, label)}</th><td>${fig == null ? '—' : Math.round(fig * 100)}</td><td>${detail}</td></tr>`;
  }

  function cardHtml() {
    const c = current();
    if (!c) return '';
    if (c.failed) return `<p class="filter-note">${esc(c.failed)}</p>`;
    const rows = [
      figRow('Heard', 'heard', c.parts && c.parts.heard,
        c.best == null ? 'no repeater or base could be priced' : `best fade margin ${dbText(c.best)}; ${c.nOk} of ${c.hops.length} reach ${okDb()} dB`),
      figRow('Neighbours', 'nbr', c.parts && c.parts.nbr,
        !c.nb ? esc(record.phase === 'denied' ? 'not available — receptions are for editors' : 'not read yet')
          : c.nb.count ? `${c.nb.count} stations within ${NEAR_KM} km, ${pct(c.nb.share)} of their frames clean`
          : `no station with a record within ${NEAR_KM} km`),
      figRow('Riverside', 'river', c.parts && c.parts.riv,
        c.river ? `${esc(c.river.title || '')} ${Math.round(c.river.m)} m away`.trim() : 'no mapped river within 1.5 km'),
    ].join('');
    const hops = (c.hops || []).map(h => `<tr><td>${esc(h.hub.name)}${h.hub.number ? ` <span class="txt-muted">${esc(h.hub.number)}</span>` : ''}</td>
      <td>${fmtKm(h.km)}</td><td>${h.margin == null ? esc(h.failed || '—') : `<span class="rscout-chip rscout-${bandOfDb(h.margin)}">${esc(dbText(h.margin))}</span>`}</td>
      <td>${h.verdict ? esc(VERDICT[h.verdict] || h.verdict) : ''}</td></tr>`).join('');
    const near = c.nb && c.nb.near.length ? `<details><summary>The ${Math.min(5, c.nb.near.length)} neighbours that count most</summary>
      <ul class="small">${c.nb.near.slice(0, 5).map(x => `<li>${esc(x.st.name)} — ${fmtKm(x.km)}, ${pct(x.share)} ${term('clean', 'clean')} of ${x.n.toLocaleString('en-AU')} frames${x.sameRiver ? ', same river' : ''}</li>`).join('')}</ul></details>` : '';
    const used = c.used || {};
    return `<div class="rscout-card" id="riverscout-card">
      <p class="rscout-head"><b class="rscout-score rscout-${bandOfScore(c.score)}" title="${escAttr(words().score)}">${c.score == null ? '—' : c.score}</b>
        <span>${term('score', 'Score')} — ${stationLatLonText(c)}${c.off ? `, ${c.off > 0 ? '+' : ''}${(c.off / 1000).toFixed(2)} km along the river` : ''}${c.capped ? '; held under 50 because no receiver reaches the map\'s ok' : ''}</span></p>
      <table class="rscout-table"><thead><tr><th>Figure</th><th>Out of 100</th><th>Because</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small txt-muted">${term('weights', 'Weights')} used here: ${Object.keys(used).map(k => `${{ heard: 'heard', nbr: 'neighbours', river: 'riverside' }[k]} ${Math.round(used[k] * 100)}%`).join(', ') || '—'}.</p>
      ${hops ? `<table class="rscout-table"><thead><tr><th>Would hear it</th><th>Apart</th><th>${term('margin', 'Fade margin')}</th><th>${term('line', 'Line of sight')}</th></tr></thead><tbody>${hops}</tbody></table>` : ''}
      ${near}</div>`;
  }

  function stripHtml() {
    if (!sweep) return '';
    const s = sweep;
    const cells = s.places.map((p, i) => {
      const v = p.score == null ? (p.pending && p.score === undefined ? 0 : 6) : p.score;
      const label = p.score == null ? (p.pending && p.score === undefined ? 'not priced yet' : 'no score')
        : `${p.score} — ${p.off === 0 ? 'the place you clicked' : `${Math.abs(p.off / 1000).toFixed(2)} km ${p.off < 0 ? s.ends.back : s.ends.fwd}`}`;
      return `<button type="button" class="rscout-cell rscout-bg-${p.pending && p.score === undefined ? 'none' : bandOfScore(p.score)}${i === selected ? ' is-on' : ''}${p.off === 0 ? ' is-site' : ''}"
        style="height:${Math.max(4, v)}%" title="${escAttr(label)}" aria-label="${escAttr(label)}" onclick="MapRiverScout.pickPlace(${i})"></button>`;
    }).join('');
    const ranked = (s.order || []).slice(0, PINNED).map(i => s.places[i]);
    return `<div class="rscout-strip-wrap"><p class="small"><b>${term('strip', esc(s.river.title))}</b> — ${s.places.length} places, ${(s.step / 1000).toFixed(2).replace(/0$/, '')} km apart, ${s.span} km either way.</p>
      <div class="rscout-strip" id="riverscout-strip" role="group" aria-label="Score of each place along the river">${cells}</div>
      <p class="rscout-ends small txt-muted"><span>◀ ${esc(s.ends.back)}</span><span>${esc(s.ends.fwd)} ▶</span></p>
      <p class="small rscout-key"><span class="rscout-sw rscout-bg-good"></span> 70+ good <span class="rscout-sw rscout-bg-ok"></span> 50–70 fair <span class="rscout-sw rscout-bg-bad"></span> under 50 poor <span class="rscout-sw rscout-bg-none"></span> not priced</p>
      ${ranked.length ? `<ol class="rscout-best">${ranked.map(p => `<li><button type="button" class="link-btn" onclick="MapRiverScout.pickPlace(${s.places.indexOf(p)})">#${p.rank} — score ${p.score}, ${p.off === 0 ? 'where you clicked' : `${Math.abs(p.off / 1000).toFixed(2)} km ${p.off < 0 ? esc(s.ends.back) : esc(s.ends.fwd)}`}, best margin ${esc(dbText(p.best))}</button></li>`).join('')}</ol>` : ''}
    </div>`;
  }

  function panelHtml() {
    if (!state.data) return '<p class="filter-note">No stations are loaded, so there is nothing to score a place against.</p>';
    const canSweep = !!(here && here.river && here.score != null) && !(job && !job.cancelled);
    return `<div class="sites-panel bestrep-panel rscout-panel">
      <fieldset class="sites-fs"><legend>The place</legend>
        <div class="sites-row">
          <button type="button" id="riverscout-arm" class="${armed ? 'is-on' : ''}" aria-pressed="${armed ? 'true' : 'false'}"
                  onclick="MapRiverScout.arm()" title="Click the map where a station might stand — as near a river as you would put it">📍 ${armed ? 'Click the map…' : 'Pick on the map'}</button>
          <button type="button" onclick="MapRiverScout.clear()" ${site ? '' : 'disabled'}>Clear</button>
        </div>
        <p class="small txt-muted">${site ? `Place: ${esc(stationLatLonText(site))}.` : 'Nothing picked yet.'}</p>
      </fieldset>
      <fieldset class="sites-fs"><legend>Along the river</legend>
        <label class="draw-field"><span>Walk</span>
          <select id="riverscout-span" onchange="MapRiverScout.set('span', this.value)">${SPANS.map(k => `<option value="${k}" ${cfg.span === k ? 'selected' : ''}>${k} km each way</option>`).join('')}</select></label>
        <label class="draw-field"><span>A place every</span>
          <select id="riverscout-step" onchange="MapRiverScout.set('step', this.value)">${STEPS.map(k => `<option value="${k}" ${cfg.step === k ? 'selected' : ''}>${k >= 1000 ? `${k / 1000} km` : `${k} m`}</option>`).join('')}</select></label>
        <div class="sites-actions">
          <button type="button" id="riverscout-sweep" class="primary" onclick="MapRiverScout.sweepRiver()" ${canSweep ? '' : 'disabled'}>Score this river</button>
          <button type="button" id="riverscout-cancel" onclick="MapRiverScout.cancel()" ${job && !job.cancelled ? '' : 'hidden'}>Cancel</button>
          <button type="button" onclick="MapRiverScout.save()" ${here ? '' : 'disabled'} title="Every place scored, with every figure, as rows">Save CSV</button>
        </div>
      </fieldset>
      <p class="filter-note" id="riverscout-status" aria-live="polite">${statusHtml()}</p>
      <p class="small txt-muted" id="riverscout-record">${recordHtml()}</p>
      ${stripHtml()}
      ${cardHtml()}
      ${glossaryHtml()}
      <p class="filter-note">${esc(CAVEAT)}</p>
    </div>`;
  }

  const CAVEAT = 'Indicative. ~30 m terrain and omnidirectional antennas, the fade margin layer\'s model, and a river line good to about a hundred '
    + 'metres. Nothing here says the bank is above the floods, the ground will hold a footing, or the landholder agrees. Look at the site '
    + 'before a station is moved there.';

  function render() {
    if (!body) return;
    const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
    body.innerHTML = panelHtml();
    if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
  }
  const rerender = render;

  // ── Picking ─────────────────────────────────────────────────────────────────

  function othersArmed() {
    return (state.draw && state.draw.tool)
      || (state.link && state.link.picking)
      || (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed())
      || (typeof Places !== 'undefined' && Places.dropping && Places.dropping())
      || (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed());
  }

  function syncArm() {
    if (typeof MapMode !== 'undefined') MapMode.sync();
    if (map) map.getContainer().classList.toggle('mn-riverscout-picking', armed);
    const b = document.getElementById('riverscout-arm');
    if (b) { b.setAttribute('aria-pressed', String(armed)); b.classList.toggle('is-on', armed); b.textContent = `📍 ${armed ? 'Click the map…' : 'Pick on the map'}`; }
  }

  function onMapClick(e) {
    if (!armed || !e || !e.latlng) return;
    if (othersArmed()) { armed = false; syncArm(); return; }
    armed = false;
    syncArm();
    pickPoint(e.latlng.lat, e.latlng.lng);
  }

  function pickPoint(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return;
    if (job) job.cancelled = true;
    job = null;
    site = { lat: +(+lat).toFixed(6), lon: +(+lon).toFixed(6) };
    scoreHere();
  }

  function pickPlace(i) {
    if (!sweep || !sweep.places[i]) return;
    selected = i;
    draw(); render();
    const p = sweep.places[i];
    if (map && p) map.panTo([p.lat, p.lon]);
  }

  // ── Saving ──────────────────────────────────────────────────────────────────

  function csvText() {
    if (!here) return '';
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const rows = [
      '# Flood-Net riverside site finder',
      `# place,${site.lat},${site.lon}`,
      `# river,${q(here.river ? here.river.title : '')}`,
      `# weights,heard ${WEIGHTS.heard},neighbours ${WEIGHTS.nbr},riverside ${WEIGHTS.river}; ok ${okDb()} dB, good ${goodDb()} dB; record ${record.phase === 'ready' ? `last ${DAYS} days` : 'not read'}`,
      ['along_river_m', 'lat', 'lon', 'score', 'heard_0_100', 'neighbours_0_100', 'riverside_0_100', 'best_margin_db', 'receivers_reaching_ok',
       'neighbour_stations', 'neighbour_clean_share', 'river_m'].join(','),
    ];
    const list = sweep ? sweep.places.filter(p => p.score !== undefined) : [{ ...here, off: 0 }];
    for (const p of list) {
      const n = v => (v == null ? '' : Math.round(v * 100));
      rows.push([p.off || 0, p.lat, p.lon, p.score == null ? '' : p.score, n(p.parts && p.parts.heard), n(p.parts && p.parts.nbr), n(p.parts && p.parts.riv),
        f1(p.best), p.nOk == null ? '' : p.nOk, p.nb ? p.nb.count : '', p.nb && p.nb.share != null ? p.nb.share.toFixed(3) : '', p.riverM == null ? '' : Math.round(p.riverM)].map(q).join(','));
    }
    return rows.join('\n');
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  function reset() {
    if (job) job.cancelled = true;
    job = null; site = null; here = null; sweep = null; selected = null;
    status = { kind: 'idle', text: '' };
    if (armed) { armed = false; syncArm(); }
    clearLayers(); render(); rerenderMapLegend();
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      MapChrome.panel(m, {
        id: 'riverscout', icon: '🌊', dockIcon: Glyphs.rail('riverscout'), title: 'Riverside sites',
        btnLabel: 'Riverside sites — which places along a river would hear a station well',
        group: 'tools', order: 29.5,
        html: () => panelHtml(),
        onMount(el) { body = el; },
        live: () => !!site || armed || !!job,
        clear: () => reset(),
      });
      m.on('click', onMapClick);
      draw();
    },

    detach() {
      if (job) { job.cancelled = true; job = null; }
      if (map) { map.off('click', onMapClick); map.getContainer().classList.remove('mn-riverscout-picking'); }
      armed = false;
      clearLayers();
      body = null;
      map = null;
    },

    active() { return !!site; },
    live() { return !!site || armed || !!job; },
    legendHtml,
    clear: reset,

    arm(on) {
      armed = on == null ? !armed : !!on;
      if (armed) {
        if (state.draw && state.draw.tool && typeof MapDraw !== 'undefined') MapDraw.setTool('');
        if (typeof LinkBudget !== 'undefined' && LinkBudget.setPicking) LinkBudget.setPicking(false);
        if (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()) MapMovePin.cancel();
        if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) MapHere.arm(false);
        if (typeof Places !== 'undefined' && Places.dropping && Places.dropping()) Places.arm(false);
        if (typeof MapBestRepeater !== 'undefined' && MapBestRepeater.armed && MapBestRepeater.armed()) MapBestRepeater.arm(false);
      }
      syncArm();
      if (armed) announce('Pick on the map is armed. Click the map where a station might stand.');
    },
    armed() { return armed; },

    pickPoint,
    pickPlace,
    sweepRiver,
    cancel() { if (job) job.cancelled = true; job = null; setStatus('idle', 'Cancelled.'); render(); },

    set(key, value) {
      if (key === 'span' && SPANS.includes(+value)) cfg.span = +value;
      else if (key === 'step' && STEPS.includes(+value)) cfg.step = +value;
      else return;
      save();
    },

    save() {
      const text = csvText();
      if (text) dlText(`floodnet-riverside-sites-${slug(here && here.river ? here.river.title : 'place')}.csv`, text);
    },

    csvText,
    here() { return here; },
    sweep() { return sweep; },
    selected() { return selected; },
    status() { return status; },
    record() { return { phase: record.phase, stations: record.byStation.size, note: record.note }; },
    words,
    // The harness has no signed-in account to read receptions with, so a check
    // hands the record in by transmitter and it takes the real path from there.
    seedRecord(tot) { record = { phase: 'ready', byStation: byRegisterStation(new Map(Object.entries(tot))), rows: 0, capped: false, note: '' }; rerender(); },
    stretchAround,
    combine,
    heardFig, nbrFig, riverFig,
    WEIGHTS,
  };
})();
if (typeof window !== 'undefined') window.MapRiverScout = MapRiverScout;
