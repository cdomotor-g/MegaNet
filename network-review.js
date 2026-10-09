// MegaNet — network-review.js
//
//   NetworkReview   the Network Review tab, administrators only: the fade
//                   margin from every field station to every repeater or base
//                   that could carry it — and to a site nobody has built on yet
//                   — set beside the margin the attenuator found on site; how
//                   Flood-Net's figures and Radio Mobile's relate, and how far
//                   to trust each; the design principles a network is reviewed
//                   against; and the register's own faults that skew a review.
//
// After core.js, terrain.js, land-cover.js, path-profile.js, datastore.js and
// auth.js; before init.js. Nothing here runs at load: renderMain() calls
// render() and init(), and auth.js calls authChanged() on every sign-in and
// sign-out. Reaches back to core.js for state, esc, escAttr, fmtKm,
// acmaHaversineKm, dlText and FN_MODEL_DEFAULTS; across to app.js for
// passRelationIndex, repeaterList and switchTab; to terrain.js (Terrain),
// land-cover.js (LandCover), path-profile.js (pathAnalyse, pathPropOf,
// rmSystemOf, stationAntenna, wattsToDbm, PATH_DEFAULT_MHZ), datastore.js
// (dbSelect) and auth.js (Auth).
//
// ── What a review asks, and why this tab asks it the way it does ────────────
// A network review is one matrix: every field station against every site that
// could hear it, and the margin on each path. Radio Mobile draws that matrix
// for a network somebody has built in it; this draws it for any set of
// repeaters and bases in the register, plus sites that are only a pin — so
// "move the repeater from this hill to that one" is two columns side by side.
// The margins are the field-calibrated model's (FN_MODEL_DEFAULTS, core.js),
// computed exactly as the link budget card and the fade-margin map compute
// them: the same pathAnalyse over the same 256-sample profile, each end's radio
// as filed, the worse of the two directions. So a cell here, the card and the
// map's colour for one link are one figure.
//
// Beside each station's best path goes what the attenuator found on its last
// visits — the PATH MARGIN table of the inspection sheets, through the public
// inspection_chart_* views (0023) — and the matrix says how far the model and
// the field agree for this network. That is the calibration, re-run on demand
// for whatever is in front of the reviewer; the figures it was set from are in
// EVIDENCE below.
//
// ── Administrators only ──────────────────────────────────────────────────────
// Signed out, or signed in without being an administrator, the tab says what it
// is for and nothing more. Everything it reads is readable without signing in
// — stations, terrain, the measured margins — so this is not the security of
// any datum; it is who the tab is for.

const NetworkReview = (function () {
  // ── tunables ──
  const SAMPLES = 256;          // the card's and the map's own figure — see map-fade.js
  const CONCURRENCY = 4;        // profiles in flight; Terrain dedups tiles beneath
  const MAX_STATIONS = 400;     // field stations in one matrix
  const MAX_PAIRS = 2400;       // station × hub cells in one matrix
  const LONG_LINK_KM = 150;     // a pass-range "link" longer than this is an address collision
  const MEASURE_SINCE = '2010-01-01';
  const MEASURE_VISITS = 3;     // the latest visits a station's measured margin is the median of
  const ATTEN_MAX = 30;         // most field attenuators stop here: a reading at it means "at least"
  const ATTEN_STEP = 3;         // most step in 3 dB: a reading r means the link carried r and not r + 3 …
  const FINE_STEP = 1;          // … and a reading off that grid came from a 1 dB attenuator
  const PAGE = 1000;            // the datastore answers at most this many rows to one read

  // ── what the calibration was set from ──
  // Aggregates only. Every path behind them is in the register and every
  // measurement in the inspection history, so the history check
  // (network-history.js) re-derives the network's for whatever is on file;
  // these are the figures the defaults were chosen on. Each reading is taken as
  // the step it is (see loadMeasured). `order` is the share of pairs of
  // stations the attenuator can tell apart that a model puts the right way round.
  const EVIDENCE = {
    // Every station tested since 2010 that the register can price, against its
    // best path at the allowance in force — the fit is over paths up to `km`.
    network: { stations: 681, fitted: 473, km: 35, fit: 12.2, lo: 11.0, hi: 13.5, mean: 0.2, typical: 8.0, w6: 51, order: 65,
               hubs: 37, hubsOff: 15, hubsOffDb: 10 },
    distance: [
      { band: 'under 10 km', n: 101, mean: 4.9, asks: 20.0, model: 38.2, field: 27.0 },
      { band: '10–20 km', n: 191, mean: 0.0, asks: 12.0, model: 28.8, field: 24.0 },
      { band: '20–35 km', n: 181, mean: -2.3, asks: 9.1, model: 22.6, field: 22.0 },
      { band: '35–50 km', n: 102, mean: -11.0, asks: -0.7, model: 11.7, field: 24.0 },
      { band: 'over 50 km', n: 106, mean: -21.1, asks: -8.0, model: 3.5, field: 22.8 },
    ],
    // The same stations' paths over five grounds (each at its own fitted
    // allowance): the tiles as priced today, the tiles every 5 m, LiDAR at the
    // ends and the obstacles, the same with repeaters and bases stood on their
    // tops, and today's tiles with LiDAR crests at the obstacles only.
    lidar: [
      { ground: '~30 m tiles, 256 points — the default', typical: 10.6, w6: 46, order: 62 },
      { ground: '~30 m tiles, a point every 5 m', typical: 12.4, w6: 44, order: 61 },
      { ground: '5 m LiDAR at the ends and the obstacles', typical: 12.8, w6: 42, order: 58 },
      { ground: '… with repeaters and bases stood on their tops — the LiDAR setting', typical: 12.5, w6: 42, order: 61 },
      { ground: '~30 m tiles with LiDAR crest heights at the obstacles', typical: 10.7, w6: 45, order: 62 },
    ],
    // One region, against Radio Mobile: the stations round Mt Stuart whose path
    // margin was measured in 2018–20, at the network's allowance.
    measured: { stations: 54, years: '2018–20', fit: 16.3, lo: 13.3, hi: 19.5, exact: 18.9 },
    accuracy: [
      { model: 'Flood-Net, land-cover model — the default until this calibration', bias: -41.0, mae: 41.9, rmse: 45.7, w6: 6, w10: 9, order: 30 },
      { model: 'Radio Mobile, as configured for the same paths', bias: 2.3, mae: 4.0, rmse: 7.2, w6: 77, w10: 87, order: 76 },
      { model: 'Flood-Net, field-calibrated — the default now', bias: 2.4, mae: 5.2, rmse: 8.8, w6: 70, w10: 74, order: 63 },
    ],
    rm: { paths: 134, median: -0.1, p10: -5.4, p90: 11.9, rankBefore: 0.08, rankAfter: 0.86, bandsBefore: 10, bandsAfter: 89, settings: 12,
          misses: { of: 53, both: 12, fnOnly: 3, rmOnly: 0 } },
    steps: [
      { what: 'Land cover stood on the profile as solid edges — trees and roofs a VHF signal largely passes through',
        mean: 19.9, p10: 4.3, p90: 42.0 },
      { what: 'ITU-R P.2108 terminal clutter at both masts — the same trees charged a second time',
        mean: 16.0, p10: 8.9, p90: 24.6 },
      { what: 'An end surveyed below the terrain model\'s surface — the antenna started in a pit the tiles dug',
        mean: 13.6, p10: 0, p90: 42.9 },
      { what: 'Repeaters and bases on the field station\'s 4 m antenna rather than a mast',
        mean: 5.0, p10: 0, p90: 27.5 },
      { what: 'The field allowance, fitted to the attenuator network-wide', mean: -12.0, p10: -12.0, p90: -12.0 },
    ],
  };

  // ── state ──
  let hubs = [];                // [{ kind:'station', id } | { kind:'site', key, name, lat, lon, agl }]
  let radiusKm = 0;             // plus every field station within this of a hub
  let site = { name: '', lat: '', lon: '', agl: '' };   // the proposed-site form, mirrored
  let matrix = null;            // the last computed run — see compute()
  let job = null;               // { gen, done, total } while computing
  let gen = 0;
  let note = null;              // { cls, text } — the last thing worth saying
  let measured = null;          // Map station id → { m, hi, n, at, censored } | null
  let measuredState = 'idle';   // idle | loading | ready | failed
  let measuredError = '';
  let siteSeq = 0;
  let rmIn = '';                // the converter's box

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  const G = () => (state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15);
  const O = () => (state.mapFadeOkDb > 0 ? state.mapFadeOkDb : 6);
  function bandOf(m) { return m == null ? null : m >= G() ? 'good' : m >= O() ? 'ok' : 'bad'; }
  const BAND_CLS = { good: 'ok', ok: 'warn', bad: 'bad' };
  const fmtDb = m => (m == null || !isFinite(m) ? '—' : `${m > 0 ? '+' : ''}${m.toFixed(1)}`);

  // ── the hubs ──

  function stationById(id) {
    return state.data ? state.data.stations.find(s => s.id === id) || null : null;
  }

  // Every repeater and base in the register, for the picker: a repeater
  // carries field stations through its pass ranges; a base hears whatever
  // reaches it, which is what the radius is for.
  function hubCandidates() {
    if (!state.data) return [];
    return state.data.stations
      .filter(s => !s.deleted_at && s.lat != null && s.lon != null && stationIsMast(s))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function hubName(h) {
    if (h.kind === 'site') return h.name;
    const st = stationById(h.id);
    return st ? st.name : h.id;
  }

  function hubPos(h) {
    if (h.kind === 'site') return { lat: h.lat, lon: h.lon };
    const st = stationById(h.id);
    return st ? { lat: st.lat, lon: st.lon } : null;
  }

  // The radio at one end of a path, as MapFade's endSys reads it: the station's
  // system, its antenna on a mast if it is a repeater or base, its surveyed
  // height. A proposed site has no system: it gets the field station's radio
  // — the one most of the network is — on the mast typed in, and says so.
  function radioOfStation(st) {
    const sys = rmSystemOf(st);
    return {
      lat: st.lat, lon: st.lon,
      elev: st.elevation_ahd != null ? st.elevation_ahd : null,
      agl: stationAntenna(st, sys).agl,
      mast: stationIsMast(st),
      txW: sys && sys.tx_power_w != null ? Number(sys.tx_power_w) : null,
      gain: sys && sys.antenna_gain_dbi != null ? Number(sys.antenna_gain_dbi) : null,
      loss: sys && sys.line_loss_db != null ? Number(sys.line_loss_db) : null,
      thr: sys && sys.rx_threshold_dbm != null ? Number(sys.rx_threshold_dbm) : null,
    };
  }
  function siteSystem() {
    const list = (state.data && state.data.rm_systems) || [];
    return list.find(r => r.tx_power_w != null && r.antenna_gain_dbi != null && r.rx_threshold_dbm != null) || null;
  }
  function radioOfHub(h) {
    if (h.kind === 'station') {
      const st = stationById(h.id);
      return st ? radioOfStation(st) : null;
    }
    const sys = siteSystem();
    if (!sys) return null;
    return {
      lat: h.lat, lon: h.lon, elev: null, agl: h.agl,
      txW: Number(sys.tx_power_w), gain: Number(sys.antenna_gain_dbi),
      loss: sys.line_loss_db != null ? Number(sys.line_loss_db) : 0, thr: Number(sys.rx_threshold_dbm),
    };
  }

  // The frequency a path is run at: the hub's receive channel, MapFade's rule;
  // a proposed site borrows the first station hub's, else the network band.
  function freqOfHub(h) {
    const of = st => (st && st.repeater && st.repeater.rx_mhz > 0 ? Number(st.repeater.rx_mhz) : null);
    if (h.kind === 'station') return of(stationById(h.id)) || PATH_DEFAULT_MHZ;
    for (const o of hubs) if (o.kind === 'station') { const f = of(stationById(o.id)); if (f) return f; }
    return PATH_DEFAULT_MHZ;
  }

  // The field stations the matrix has rows for: whatever the station hubs'
  // pass ranges carry, and every field station within the radius of any hub.
  // A station that is itself one of the hubs is a column, not a row.
  function rowStations() {
    if (!state.data) return [];
    const idx = typeof passRelationIndex === 'function' ? passRelationIndex() : null;
    const hubIds = new Set(hubs.filter(h => h.kind === 'station').map(h => h.id));
    const out = new Map();
    for (const h of hubs) {
      if (h.kind !== 'station' || !idx) continue;
      for (const s of idx.byRepeater.get(h.id) || []) {
        // A pass-range "link" hundreds of kilometres long is an address that
        // happens to fall in the window, not a station this repeater hears.
        const p = hubPos(h);
        if (p && s.lat != null && acmaHaversineKm(p.lat, p.lon, s.lat, s.lon) <= LONG_LINK_KM) out.set(s.id, s);
      }
    }
    if (radiusKm > 0) {
      const pos = hubs.map(hubPos).filter(Boolean);
      for (const s of state.data.stations) {
        if (s.deleted_at || s.lat == null || s.lon == null || !s.roles || !s.roles.includes('field')) continue;
        if (pos.some(p => acmaHaversineKm(p.lat, p.lon, s.lat, s.lon) <= radiusKm)) out.set(s.id, s);
      }
    }
    for (const id of hubIds) out.delete(id);
    return [...out.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // ── one path ──
  // The card's arithmetic: the profile, the cover only if the model in force
  // prices it, pathAnalyse, and each end's radio both ways round.
  async function pathMargin(A, B, fMhz) {
    if ([A.txW, A.gain, A.loss, A.thr, B.txW, B.gain, B.loss, B.thr].some(v => v == null || !isFinite(v))) {
      return { err: 'radio' };
    }
    // The ground as pathGround decides it (path-profile.js): the tiles, or
    // LiDAR at the ends and the obstacles — the card's and the map's ground.
    const got = await pathGround(A, B, { samples: SAMPLES, freqMhz: fMhz });
    if (!got.ok || got.prof.partial) return { err: 'terrain' };
    const prof = got.prof, EA = got.ends.a, EB = got.ends.b;
    let cov = null;
    if (pathPropOf().model === 'cover') {
      cov = await LandCover.sample(prof.lat, prof.lon);
      if (!cov || !cov.ok) return { err: 'cover' };
    }
    const an = pathAnalyse(prof, {
      elevA: EA.elev, elevB: EB.elev, aglA: A.agl, aglB: B.agl, freqMhz: fMhz,
      cover: cov ? cov.cls : null, canopy: cov && cov.canopyOk ? cov.canopy : null,
    });
    if (!an.ok || an.pathLoss_db == null) return { err: 'model' };
    const one = (x, y) => wattsToDbm(x.txW) + x.gain - x.loss - an.pathLoss_db + y.gain - y.loss - y.thr;
    const ab = one(A, B), ba = one(B, A);
    // The lifts are kept per end: the station's is a row's flag, the hub's
    // is the same on every row and is said once, over its column.
    return { m: Math.min(ab, ba), ab, ba, dKm: an.D / 1000, v: an.model === 'field' ? an.verdictBare : an.verdict,
             liftF: an.liftA_m || 0, liftH: an.liftB_m || 0 };
  }

  // ── the run ──

  async function compute() {
    if (!isAdmin() || !state.data) return;
    if (!hubs.length) { note = { cls: 'txt-warn', text: 'Add a repeater, a base or a proposed site first.' }; repaint(); return; }
    const rows = rowStations();
    if (!rows.length) {
      note = { cls: 'txt-warn', text: 'No field station to compute: these hubs carry none in their pass ranges — set a radius to take in the stations round them.' };
      repaint();
      return;
    }
    if (rows.length > MAX_STATIONS || rows.length * hubs.length > MAX_PAIRS) {
      note = { cls: 'txt-warn', text: `${rows.length} stations × ${hubs.length} hubs is more than one matrix should hold (${MAX_STATIONS} stations, ${MAX_PAIRS} paths) — a smaller radius, or fewer hubs.` };
      repaint();
      return;
    }
    const mine = ++gen;
    const P_ = pathPropOf();
    const hubRadios = hubs.map(radioOfHub);
    const freqs = hubs.map(freqOfHub);
    matrix = {
      hubs: hubs.map((h, k) => ({ ...h, name: hubName(h), agl: hubRadios[k] ? hubRadios[k].agl : null, f: freqs[k] })),
      rows: rows.map(st => ({ id: st.id, name: st.name, number: st.station_number || '', figs: hubs.map(() => null) })),
      model: P_.model, allowance: P_.allowance, mastAgl: P_.mastAgl, at: new Date(),
    };
    const jobs = [];
    rows.forEach((st, i) => hubs.forEach((h, k) => jobs.push({ i, k, st })));
    job = { gen: mine, done: 0, total: jobs.length };
    note = null;
    repaint();
    loadMeasured(rows.map(s => s.id));
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && gen === mine) {
        const { i, k, st } = jobs[next++];
        const H = hubRadios[k];
        let fig;
        try {
          fig = H ? await pathMargin(radioOfStation(st), H, freqs[k]) : { err: 'radio' };
        } catch (err) { fig = { err: 'model' }; }
        if (gen !== mine) return;
        matrix.rows[i].figs[k] = fig;
        job.done++;
        if (job.done % 8 === 0 || job.done === job.total) repaintLive();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (gen !== mine) return;
    job = null;
    repaintLive();
  }

  function stop() {
    gen++;
    if (job) note = { cls: 'txt-warn', text: `Stopped at ${job.done} of ${job.total} paths — the rest are blank.` };
    job = null;
    repaint();
  }

  // ── what was measured ──
  // The PATH MARGIN passes of each station's visits since MEASURE_SINCE: the
  // largest load a visit's link still carried is that visit's figure (0014's
  // own rule), and a station's is the median of its latest MEASURE_VISITS.
  // Nought is read as "not tested" — the imported sheets carry it in blank
  // boxes — and anything over 60 dB as a slip of the pen.
  //
  // A figure is a step, not a point. Most attenuators go up in ATTEN_STEP dB,
  // so a visit that carried 24 dB and not 27 says the margin is 24–27, and one
  // at ATTEN_MAX says only "at least 30". A reading off the 3 dB grid — 22, 25,
  // 13 — cannot have come from one of those: about one test in four since 2016
  // was read on a 1 dB attenuator, and its step is FINE_STEP. The median is
  // monotone, so the station's margin lies between the median of the visits'
  // lower ends (`m`) and the median of their upper ends (`hi`) — and a median
  // that leans on an "at least" is one too: 27 and ≥30 is ≥28.5, not 28.5.
  async function loadMeasured(ids) {
    measured = null;
    measuredState = 'loading';
    measuredError = '';
    try {
      const visits = [];
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80).map(encodeURIComponent).join(',');
        visits.push(...await selectAll(`inspection_chart_visit?select=id,station_id,inspected_on`
          + `&station_id=in.(${part})&inspected_on=gte.${MEASURE_SINCE}&order=inspected_on.desc,id.asc`));
      }
      const byVisit = new Map();
      const vIds = visits.map(v => v.id);
      for (let i = 0; i < vIds.length; i += 60) {
        const part = vIds.slice(i, i + 60).join(',');
        const rows = await selectAll(`inspection_chart_fade_margin?select=inspection_id,load_db`
          + `&inspection_id=in.(${part})&phase=eq.this_visit&order=inspection_id.asc,load_db.asc`);
        for (const r of rows) {
          const v = Number(r.load_db);
          if (!(v > 0) || v > 60) continue;
          byVisit.set(r.inspection_id, Math.max(byVisit.get(r.inspection_id) || 0, v));
        }
      }
      const out = new Map();
      for (const v of visits) {
        const m = byVisit.get(v.id);
        if (m == null) continue;
        const e = out.get(v.station_id) || { all: [], at: v.inspected_on };
        if (e.all.length < MEASURE_VISITS) e.all.push(m);
        out.set(v.station_id, e);
      }
      measured = new Map();
      for (const [id, e] of out) {
        measured.set(id, { ...stepOf(e.all), n: e.all.length, at: e.at });
      }
      measuredState = 'ready';
    } catch (err) {
      measuredState = 'failed';
      measuredError = (err && err.message) || String(err);
    }
    repaintLive();
  }

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  // One reading's step: 3 dB on the 3 dB grid, 1 dB off it.
  const stepFor = v => (Math.abs(v / ATTEN_STEP - Math.round(v / ATTEN_STEP)) < 1e-9 ? ATTEN_STEP : FINE_STEP);
  // A station's readings (one per visit) → where its margin lies: { m, hi, censored }.
  function stepOf(readings) {
    const m = median(readings), hi = median(readings.map(v => (v >= ATTEN_MAX ? Infinity : v + stepFor(v))));
    return { m, hi, censored: hi === Infinity };
  }

  // Every row of a read, a page at a time: the datastore answers at most PAGE
  // rows to one request and says nothing about the rest, so a read that might
  // run past it asks again from where the last page ended. `path` must order
  // its rows, or the pages can overlap.
  async function selectAll(path) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await dbSelect(`${path}&limit=${PAGE}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  const fmtStep = x => String(Math.round(x * 10) / 10);
  // "24–27", or "≥30" — what a station's tests say its margin is.
  const measuredText = m => (m.censored ? `≥${fmtStep(m.m)}` : `${fmtStep(m.m)}–${fmtStep(m.hi)}`);

  // ── reading the matrix ──

  function rowSummary(r) {
    const ok = r.figs.filter(f => f && f.m != null);
    const best = ok.length ? Math.max(...ok.map(f => f.m)) : null;
    const good = ok.filter(f => f.m >= G()).length;
    const workable = ok.filter(f => f.m >= O()).length;
    const lift = Math.max(0, ...ok.map(f => f.liftF || 0));
    return { best, good, workable, lift, pending: r.figs.some(f => f == null), failed: r.figs.filter(f => f && f.err).length };
  }

  function flagsOf(r, s) {
    const out = [];
    if (s.pending) return out;
    if (s.best == null) out.push({ cls: 'bad', text: 'no figure' });
    else if (s.best < O()) out.push({ cls: 'bad', text: 'needs a second way out' });
    else if (s.best < G()) out.push({ cls: 'warn', text: 'marginal' });
    if (s.best != null && s.good < 2 && matrix.hubs.length > 1) out.push({ cls: 'warn', text: s.good === 1 ? 'one good path only' : 'no good path' });
    if (s.lift > 5) out.push({ cls: 'warn', text: `surveyed ${s.lift.toFixed(0)} m below the terrain model` });
    return out;
  }

  // Measured against modelled, for the rows that have both. The tests say the
  // margin lies in a step — 24–27, or at least 30 — so a model figure anywhere
  // in it is no error, and one outside it is an error of the distance to it.
  function fieldCheck() {
    if (!matrix || !measured) return null;
    const pairs = [];
    for (const r of matrix.rows) {
      const s = rowSummary(r), m = measured.get(r.id);
      if (s.pending || s.best == null || !m) continue;
      pairs.push(s.best < m.m ? s.best - m.m : s.best > m.hi ? s.best - m.hi : 0);
    }
    if (!pairs.length) return { n: 0 };
    const mean = pairs.reduce((a, b) => a + b, 0) / pairs.length;
    const mae = pairs.reduce((a, b) => a + Math.abs(b), 0) / pairs.length;
    const w6 = pairs.filter(e => Math.abs(e) <= 6).length / pairs.length;
    return { n: pairs.length, mean, mae, w6 };
  }

  function kpis() {
    if (!matrix) return null;
    const k = { n: matrix.rows.length, two: 0, one: 0, marginal: 0, weak: 0, none: 0 };
    for (const r of matrix.rows) {
      const s = rowSummary(r);
      if (s.pending) continue;
      if (s.best == null) k.none++;
      else if (s.good >= 2) k.two++;
      else if (s.good === 1) k.one++;
      else if (s.best >= O()) k.marginal++;
      else k.weak++;
    }
    return k;
  }

  // ── the CSV ──

  function exportCsv() {
    if (!matrix) return;
    const q = v => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ['station', 'station_number'];
    for (const h of matrix.hubs) head.push(`${h.name} margin_db`, `${h.name} km`);
    head.push('best_margin_db', `paths_at_least_${G()}_db`, 'measured_margin_from_db', 'measured_margin_to_db', 'measured_visits', 'flags');
    const lines = [
      `# Flood-Net network review — ${matrix.model === 'cover' ? 'land-cover model' : `field-calibrated model, ${matrix.allowance} dB allowance`}, repeaters and bases on at least a ${matrix.mastAgl} m mast`,
      `# computed ${matrix.at.toISOString()}; each cell the worse of the two directions, as the link budget card and the fade-margin map give it`,
      `# measured: an attenuator steps in ${ATTEN_STEP} dB (1 dB for a reading off that grid), so a station's tests put its margin between from and to; no "to" means at least "from"`,
      head.map(q).join(','),
    ];
    for (const r of matrix.rows) {
      const s = rowSummary(r), m = measured && measured.get(r.id);
      const cells = [r.name, r.number];
      r.figs.forEach(f => { cells.push(f && f.m != null ? f.m.toFixed(1) : '', f && f.dKm != null ? f.dKm.toFixed(2) : ''); });
      cells.push(s.best != null ? s.best.toFixed(1) : '', s.good, m ? fmtStep(m.m) : '', m && !m.censored ? fmtStep(m.hi) : '', m ? m.n : '',
        flagsOf(r, s).map(f => f.text).join('; '));
      lines.push(cells.map(q).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    dlText(`network-review-${stamp}.csv`, lines.join('\n') + '\n');
  }

  // ── the page ──

  function outsideHtml() {
    return `<div class="panel">
      <div class="panel-header"><h2>Network Review</h2></div>
      <p class="small">A radio network reviewed the way a planner reviews one: the fade margin from every field station
        to every repeater, base or proposed site that could carry it, set beside what the attenuator found on site; the
        design principles a network is checked against; and how Flood-Net's figures relate to Radio Mobile's.</p>
      ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? '<p class="small">This needs an administrator.</p>'
        : '<div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'}
    </div>`;
  }

  function hubsHtml() {
    const cands = hubCandidates();
    const chosen = new Set(hubs.filter(h => h.kind === 'station').map(h => h.id));
    const list = hubs.length ? `<ul class="nr-hubs">${hubs.map((h, k) => {
      const st = h.kind === 'station' ? stationById(h.id) : null;
      const sys = st ? rmSystemOf(st) : null;
      const ant = st ? stationAntenna(st, sys) : null;
      const what = h.kind === 'site'
        ? `proposed site, ${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}, the field-station radio on a ${h.agl} m mast`
        : `${st && st.roles.includes('base') ? 'base' : 'repeater'}${st && st.repeater && st.repeater.rx_mhz ? ` · receives ${st.repeater.rx_mhz} MHz` : ''}${
           ant && ant.mast ? ` · on an assumed ${ant.agl} m mast (its radio system says ${ant.sysAgl} m)` : ant ? ` · antenna ${ant.agl} m` : ''}`;
      return `<li><strong>${esc(hubName(h))}</strong> <span class="small txt-muted">${esc(what)}</span>
        <button type="button" class="exp-btn-sm" onclick="NetworkReview.removeHub(${k})" aria-label="Take ${escAttr(hubName(h))} out of the review">Remove</button></li>`;
    }).join('')}</ul>` : '<p class="small">No hubs yet — add the repeaters and bases the network runs through.</p>';
    return `
      <div class="nr-controls">
        <label class="draw-field nr-pick">
          <span>Repeater or base</span>
          <select id="nr-hub-pick">
            <option value="">Choose one of ${cands.length}…</option>
            ${cands.map(s => `<option value="${escAttr(s.id)}" ${chosen.has(s.id) ? 'disabled' : ''}>${esc(s.name)}${
              s.station_number ? ` · ${esc(s.station_number)}` : ''}${s.roles.includes('base') ? ' · base' : ''}</option>`).join('')}
          </select>
        </label>
        <button type="button" onclick="NetworkReview.addHub(document.getElementById('nr-hub-pick').value)">Add to the review</button>
        <label class="draw-field nr-radius">
          <span>And every field station within <em>km</em></span>
          <input type="number" id="nr-radius" min="0" max="150" step="1" value="${radiusKm || ''}" placeholder="0"
                 onchange="NetworkReview.setRadius(this.value)">
        </label>
      </div>
      ${list}
      <details class="nr-site">
        <summary class="small">Add a proposed site — a pin with nothing on it yet</summary>
        <div class="nr-controls">
          <label class="draw-field"><span>Name</span>
            <input type="text" id="nr-site-name" value="${escAttr(site.name)}" placeholder="e.g. the ridge east of town"
                   oninput="NetworkReview.siteField('name', this.value)"></label>
          <label class="draw-field"><span>Latitude</span>
            <input type="number" id="nr-site-lat" step="0.0001" value="${escAttr(site.lat)}" placeholder="-19.2586"
                   oninput="NetworkReview.siteField('lat', this.value)"></label>
          <label class="draw-field"><span>Longitude</span>
            <input type="number" id="nr-site-lon" step="0.0001" value="${escAttr(site.lon)}" placeholder="146.8031"
                   oninput="NetworkReview.siteField('lon', this.value)"></label>
          <label class="draw-field"><span>Mast <em>m</em></span>
            <input type="number" id="nr-site-agl" step="0.5" min="1" max="100" value="${escAttr(site.agl)}" placeholder="${pathPropOf().mastAgl}"
                   oninput="NetworkReview.siteField('agl', this.value)"></label>
          <button type="button" onclick="NetworkReview.addSite()">Add the site</button>
        </div>
        <p class="filter-hint">A proposed site gets the field-station radio — what most of the network is — on the mast
          typed here, its ground from the terrain tiles. Its column reads as any other, so a move from one hill to another
          is two columns side by side.</p>
      </details>`;
  }

  function statusHtml() {
    const bits = [];
    if (job) bits.push(`Computing ${job.done} of ${job.total} paths…`);
    if (note) bits.push(`<span class="${note.cls}">${esc(note.text)}</span>`);
    if (matrix && !job) {
      const failed = matrix.rows.reduce((n, r) => n + r.figs.filter(f => f && f.err).length, 0);
      if (failed) bits.push(`<span class="txt-warn">${failed} path${failed === 1 ? '' : 's'} could not be computed — terrain unreachable, or a radio system missing</span>`);
    }
    if (measuredState === 'loading') bits.push('Reading the measured margins…');
    if (measuredState === 'failed') bits.push(`<span class="txt-warn">The measured margins could not be read (${esc(measuredError)}) — the matrix stands without them.</span>`);
    return bits.join(' · ');
  }

  function kpisHtml() {
    const k = kpis();
    if (!k) return '';
    const tile = (label, v, sub, mod) => `<div class="adm-kpi${mod ? ' adm-kpi--' + mod : ''}"><div class="adm-kpi-label">${esc(label)}</div>`
      + `<div class="adm-kpi-value">${esc(v)}</div><div class="adm-kpi-sub">${esc(sub)}</div></div>`;
    const fc = fieldCheck();
    return `<div class="adm-kpis">${tile('Field stations', k.n, `against ${matrix.hubs.length} hub${matrix.hubs.length === 1 ? '' : 's'}`, '')}`
      + tile('Two good paths', k.two, `${G()} dB or better to two hubs`, k.two ? 'ok' : '')
      + tile('One good path', k.one, 'no second way if that hub is down', k.one ? 'warn' : '')
      + tile('Marginal', k.marginal, `best path ${O()}–${G()} dB`, k.marginal ? 'warn' : '')
      + tile('Needs a second way out', k.weak + k.none, `best path under ${O()} dB`, k.weak + k.none ? 'warn' : '')
      + (fc && fc.n ? tile('Against the attenuator', `${fc.mean >= 0 ? '+' : ''}${fc.mean.toFixed(1)} dB`,
          `mean error over ${fc.n} measured station${fc.n === 1 ? '' : 's'} · ±${fc.mae.toFixed(1)} dB typical`, Math.abs(fc.mean) <= 5 ? 'ok' : 'warn') : '')
      + '</div>';
  }

  function tableHtml() {
    if (!matrix) return '';
    const hubLift = k => Math.max(0, ...matrix.rows.map(r => (r.figs[k] && r.figs[k].liftH) || 0));
    const hubsH = matrix.hubs.map((h, k) => `<th scope="col" class="nr-hub-col">${esc(h.name)}<span class="small txt-muted"> ${
      h.agl != null ? `${h.agl} m` : ''}${h.f ? ` · ${Number(h.f).toFixed(3)} MHz` : ''}${
      hubLift(k) > 5 ? ` · stood ${hubLift(k).toFixed(0)} m above its survey, on the terrain model` : ''}</span></th>`).join('');
    const cell = f => {
      if (f == null) return `<td class="nr-num txt-muted">…</td>`;
      if (f.err) return `<td class="nr-num txt-muted" title="${escAttr({ terrain: 'terrain unreachable', cover: 'land cover unreachable', radio: 'no radio system on file', model: 'the model refused the path' }[f.err] || f.err)}">—</td>`;
      const b = bandOf(f.m);
      return `<td class="nr-num nr-${b}" title="${escAttr(`${fmtKm(f.dKm)} · ${f.v || ''} · ${fmtDb(f.ab)} / ${fmtDb(f.ba)} dB each way`)}">${fmtDb(f.m)}<span class="small txt-muted"> ${f.dKm.toFixed(1)} km</span></td>`;
    };
    const rows = matrix.rows.map(r => {
      const s = rowSummary(r), m = measured ? measured.get(r.id) : null;
      const flags = flagsOf(r, s);
      return `<tr>
        <th scope="row"><button type="button" class="link-btn" onclick="NetworkReview.openStation('${escAttr(r.id)}')">${esc(r.name)}</button>${
          r.number ? `<span class="small txt-muted"> ${esc(r.number)}</span>` : ''}</th>
        ${r.figs.map(cell).join('')}
        <td class="nr-num nr-${bandOf(s.best) || 'none'}"><strong>${fmtDb(s.best)}</strong></td>
        <td class="nr-num">${s.pending ? '…' : s.good}</td>
        <td class="nr-num">${m ? `${measuredText(m)}<span class="small txt-muted"> ${esc(String(m.at).slice(0, 4))}${m.n > 1 ? `, ${m.n} visits` : ''}</span>`
          : measuredState === 'loading' ? '…' : '<span class="txt-muted">—</span>'}</td>
        <td class="small">${flags.map(f => `<span class="txt-${f.cls}">${esc(f.text)}</span>`).join(' · ')}</td>
      </tr>`;
    }).join('');
    return `
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="nr-matrix-h">
        <table class="adm-table nr-matrix">
          <caption class="sr-only">Fade margin from each field station to each hub, its best path, how many paths are good, and the margin measured on site</caption>
          <thead><tr>
            <th scope="col">Field station</th>${hubsH}
            <th scope="col">Best</th><th scope="col">≥${G()} dB</th><th scope="col">Measured</th><th scope="col">Flags</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="filter-hint">Each cell is the fade margin in dB, the worse of the two directions — the link budget card's
        figure for that path, and the fade-margin map's colour. Green is ${G()} dB or better, amber ${O()}–${G()}, red
        below (the map's bands). <em>Measured</em> is the median of the station's last ${MEASURE_VISITS} attenuator tests to
        base since ${MEASURE_SINCE.slice(0, 4)}. Most attenuators step in ${ATTEN_STEP} dB, so a test that carried 24 dB
        and not 27 puts the margin at 24–27 (a reading off that grid, such as 22, came from a 1 dB attenuator: 22–23);
        ≥ marks one that reached the attenuator's ${ATTEN_MAX} dB limit, or a median that leans on one. A measured margin is end to end, through whichever path the station actually takes, so it is set
        against the best cell.</p>`;
  }

  function matrixPanelHtml() {
    const P_ = pathPropOf();
    return `
      <div class="panel">
        <div class="panel-header"><h2 id="nr-matrix-h">Path margins across a network</h2>
          <button type="button" class="exp-btn-sm" onclick="NetworkReview.exportCsv()" ${matrix ? '' : 'disabled'}>⤓ CSV</button></div>
        <p class="small">Pick the repeaters and bases a network runs through — and any site that is only a proposal —
          and every field station they carry gets a row: its margin to each, its best path, how many paths are good, and
          what the attenuator found when it was last tested. Margins are
          ${P_.model === 'cover' ? '<strong>the land-cover model\'s</strong>, as the link budget card is set to now'
            : `the <strong>field-calibrated</strong> model's: Longley–Rice over the terrain, less the ${P_.allowance} dB field allowance`},
          with repeaters and bases on at least a ${P_.mastAgl} m mast — the link budget card's propagation settings change all three.</p>
        ${hubsHtml()}
        <div class="button-group">
          <button type="button" class="primary" onclick="NetworkReview.compute()" ${job ? 'disabled' : ''}>Compute margins</button>
          ${job ? '<button type="button" onclick="NetworkReview.stop()">Stop</button>' : ''}
          <span class="small" id="nr-rows-count">${hubs.length ? `${rowStations().length} field stations would be computed` : ''}</span>
        </div>
        <p class="small" id="nr-status" role="status">${statusHtml()}</p>
        <div id="nr-kpis">${kpisHtml()}</div>
        <div id="nr-table">${tableHtml()}</div>
      </div>`;
  }

  // ── the reconciliation ──

  function reconcileHtml() {
    const E = EVIDENCE, N = E.network, M = E.measured, R = E.rm, RMrow = E.accuracy[1], FNrow = E.accuracy[2];
    const sg = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    const acc = E.accuracy.map(r => `<tr><th scope="row">${esc(r.model)}</th>
      <td class="nr-num">${sg(r.bias)}</td><td class="nr-num">${r.mae.toFixed(1)}</td>
      <td class="nr-num">${r.rmse.toFixed(1)}</td><td class="nr-num">${r.w6} %</td><td class="nr-num">${r.w10} %</td>
      <td class="nr-num">${r.order} %</td></tr>`).join('');
    const dist = E.distance.map(d => `<tr><th scope="row">${esc(d.band)}</th><td class="nr-num">${d.n}</td>
      <td class="nr-num">${d.model.toFixed(1)}</td><td class="nr-num">${d.field.toFixed(1)}</td>
      <td class="nr-num">${sg(d.mean)}</td><td class="nr-num">${d.asks.toFixed(1)}</td></tr>`).join('');
    const grounds = E.lidar.map(g => `<tr><th scope="row">${esc(g.ground)}</th><td class="nr-num">${g.typical.toFixed(1)}</td>
      <td class="nr-num">${g.w6} %</td><td class="nr-num">${g.order} %</td></tr>`).join('');
    const steps = E.steps.map(st => `<tr><th scope="row">${esc(st.what)}</th>
      <td class="nr-num">${sg(st.mean)}</td>
      <td class="nr-num">${st.p10 === st.p90 ? '—' : `${st.p10 > 0 ? '+' : ''}${st.p10.toFixed(1)} to ${st.p90 > 0 ? '+' : ''}${st.p90.toFixed(1)}`}</td></tr>`).join('');
    const rm = Number(rmIn);
    const onSite = rm - RMrow.bias;
    const reads = Math.max(0, Math.floor(onSite / ATTEN_STEP) * ATTEN_STEP);
    const fn = rm - R.median;
    const conv = rmIn !== '' && isFinite(rm) ? `
      <p class="small" id="nr-conv-out" role="status">Radio Mobile's <strong>${rm.toFixed(1)} dB</strong> is about
        <strong>${fn.toFixed(1)} dB</strong> in Flood-Net (between ${(rm - R.p90).toFixed(1)} and
        ${(rm - R.p10).toFixed(1)} for eight paths in ten), and a margin of about <strong>${onSite.toFixed(1)} dB</strong> on
        site${onSite >= ATTEN_MAX ? ` — past most attenuators' ${ATTEN_MAX} dB, which would read “${ATTEN_MAX}+”`
          : onSite > 0 ? `, which an attenuator stepping in ${ATTEN_STEP} dB would read as <strong>${reads}</strong>` : ''}.
        ${rm >= 49 ? 'If that figure is a display\'s ceiling — every strong path reading the same — it is clipped, and means “at least that”.' : ''}</p>`
      : '<p class="small" id="nr-conv-out" role="status"></p>';
    const between = `from ${R.p10 < 0 ? `${(-R.p10).toFixed(1)} dB higher` : `${R.p10.toFixed(1)} dB lower`} to ${R.p90.toFixed(1)} dB lower`;
    return `
      <div class="panel">
        <div class="panel-header"><h2>Flood-Net, Radio Mobile and the field</h2></div>
        <p class="small">Flood-Net and Radio Mobile run the same propagation model — Longley–Rice — over much the same
          terrain, and yet their fade margins for one path could differ by tens of decibels. The differences are in what
          each is told and what each adds on top, and the way to tell which is nearer the truth is the margin the
          attenuator finds on site.</p>

        <h3>Against the field, network-wide</h3>
        <p class="small">Every station whose path margin has been tested since 2010 — ${N.stations} the register can price —
          against its best path. The allowance that fits the ${N.fitted} whose best path is ${N.km} km or less is
          <strong>${N.fit} dB</strong> (${N.lo}–${N.hi} dB at 90 %), and that is the default:
          <strong>${FN_MODEL_DEFAULTS.allowance} dB</strong>. Over those stations the model is out by ±${N.typical} dB typically,
          within ±6 dB for ${N.w6} %, and puts ${N.order} % of the pairs of stations the attenuator can tell apart the right
          way round. The panel above re-runs this on whatever is on file.</p>
        <div class="table-wrap">
          <table class="adm-table nr-acc">
            <caption class="sr-only">Model and measured margins by the length of each station's best path</caption>
            <thead><tr><th scope="col">Best path</th><th scope="col">Stations</th><th scope="col">Model, median dB</th>
              <th scope="col">Measured, median dB</th><th scope="col">Mean error at ${FN_MODEL_DEFAULTS.allowance} dB</th>
              <th scope="col">Allowance it asks for, dB</th></tr></thead>
            <tbody>${dist}</tbody>
          </table>
        </div>
        <p class="filter-hint">The field reads 22–27 dB at every distance; the model falls from 38 to 4. That is the
          network's design, not the model's physics: every station was built to work, and a long link was given a
          directional antenna or a taller mast that the register does not record — so past ${N.km} km the model, which
          knows only the register's omni on a 4 m pole, is pessimistic, and the allowance is fitted short of that. Hub by
          hub the allowance asked for ranges widely: ${N.hubsOff} of the ${N.hubs} hubs with five tested stations or more are
          ${N.hubsOffDb} dB or more from the network's. Each is a register entry short of something — a mast, an antenna, a
          position — and the history check names them.</p>

        <h3>Against Radio Mobile, in one region</h3>
        <p class="small">${M.stations} stations round Mt Stuart whose path margin to base was measured in ${M.years} were
          also modelled in Radio Mobile. Each model against the same tests, Flood-Net at the network's allowance:</p>
        <div class="table-wrap">
          <table class="adm-table nr-acc">
            <caption class="sr-only">Each model's figures against the margin measured on site</caption>
            <thead><tr><th scope="col">Model</th><th scope="col">Mean error</th><th scope="col">Typical error</th>
              <th scope="col">RMS error</th><th scope="col">Within ±6 dB</th><th scope="col">Within ±10 dB</th>
              <th scope="col">Pairs in order</th></tr></thead>
            <tbody>${acc}</tbody>
          </table>
        </div>
        <p class="filter-hint">Errors in dB, model minus measured: positive is a model more hopeful than the attenuator.
          Most attenuators step in ${ATTEN_STEP} dB, so a test puts the margin in a step — one that carried 24 dB and not 27
          says 24–27 — and a model figure anywhere in that step is no error; a reading off the 3 dB grid came from a 1 dB
          attenuator and is a 1 dB step; a reading at the attenuator's ${ATTEN_MAX} dB limit counts as
          “at least ${ATTEN_MAX}”. <em>Pairs in order</em>: of the pairs of stations the attenuator can tell apart, the share
          the model puts the right way round. This region fitted alone asks for ${M.fit} dB (${M.lo}–${M.hi} at 90 %) — read as
          exact figures, ${M.exact} — so at the network's ${FN_MODEL_DEFAULTS.allowance} dB Flood-Net reads
          ${sg(FNrow.bias)} dB here, as Radio Mobile does.</p>

        <h3>Where the difference came from</h3>
        <p class="small">Set path for path against Radio Mobile over ${R.paths} VHF paths of 2 to 70 km, Flood-Net's old
          figures were a median <strong>46 dB</strong> lower and ranked the paths no better than chance (rank correlation
          ${R.rankBefore.toFixed(2)}). Taking the old model to the calibrated one, one step at a time:</p>
        <div class="table-wrap">
          <table class="adm-table nr-steps">
            <caption class="sr-only">What each step from the old model to the calibrated one did to Flood-Net's figure</caption>
            <thead><tr><th scope="col">Step</th><th scope="col">Mean effect, dB</th><th scope="col">Eight paths in ten</th></tr></thead>
            <tbody>${steps}</tbody>
          </table>
        </div>
        <p class="small">The first two are the big ones, and they are one mistake made twice: at VHF a tree canopy is
          largely transparent, and modelling it as a solid edge — then charging the mast for standing among it as well —
          prices every forested or suburban path as though it ran through a hill. The third is the terrain model's: its
          tiles are a surface, and a station surveyed a few metres under that surface (a summit, a town, a tree line) put
          its antenna in a pit of the model's own making. The fourth is the register's: every repeater and base is on the
          field station's radio system, 4 m antenna and all. What remains is the <strong>field allowance</strong> — the
          bare-terrain figure's average shortfall against the attenuator: the masts' own surroundings, feeders and
          connectors, receivers at busy sites. It is measured, not modelled, and the same for every path; one path can stray
          from it by the typical error above.</p>

        <h3>Reading one against the other</h3>
        <p class="small">Calibrated, Flood-Net ranks paths much as Radio Mobile does (rank correlation
          ${R.rankAfter.toFixed(2)}) and puts ${R.bandsAfter} % of them in the same green, amber or red band (${R.bandsBefore} %
          before). At the network's allowance it reads within a median <strong>${Math.abs(R.median).toFixed(1)} dB</strong> of
          Radio Mobile — ${between} for eight paths in ten: Radio Mobile is told its link settings and nothing else, and
          those settings sat about ${R.settings} dB below Flood-Net's defaults, about the allowance. So, in this region and to
          within the typical error:</p>
        <ul class="small">
          <li><strong>Flood-Net ≈ Radio Mobile</strong>;</li>
          <li><strong>margin on site ≈ either, less ${RMrow.bias.toFixed(0)} dB</strong> — and network-wide, margin on site ≈
            Flood-Net, which is how the allowance was fitted;</li>
          <li>and an attenuator stepping in ${ATTEN_STEP} dB reads the step at or below the margin — on average
            ${ATTEN_STEP / 2} dB under it.</li>
        </ul>
        <div class="nr-controls">
          <label class="draw-field"><span>A Radio Mobile fade margin <em>dB</em></span>
            <input type="number" id="nr-conv-in" step="0.5" value="${escAttr(rmIn)}" placeholder="e.g. 24"
                   oninput="NetworkReview.convert(this.value)"></label>
        </div>
        ${conv}
        <p class="filter-hint">Is Flood-Net the better of the two? Not path for path. On these paths Radio Mobile — set up
          one path at a time by whoever designed the network, with each site's own antenna and mast — is a little nearer
          the attenuator (typical error ${RMrow.mae} dB against ${FNrow.mae}) and puts more pairs of stations in the right
          order (${RMrow.order} % against ${FNrow.order} %). Given the same site details, Flood-Net matches it: the gap is the
          register's, not the model's. Of ${R.misses.of} paths both modelled, both miss by more than 6 dB on
          ${R.misses.both}; Flood-Net misses ${R.misses.fnOnly} more, Radio Mobile ${R.misses.rmOnly}. Flood-Net's strengths
          are elsewhere: it computes every link in the register, both ways round, from the register as it stands today,
          with nobody setting a path up; it is calibrated against the whole network's tests; and it says which hubs
          the field disagrees with. Where the two disagree by much on one path, check the register's position and height
          for both ends before trusting either; neither models antenna patterns, interference or the tree that grew last
          year.</p>

        <h3>The ground: LiDAR, where it matters</h3>
        <p class="small">The link budget card's propagation settings can price a path over Geoscience Australia's 5 m LiDAR
          instead of the ~30 m tiles — fetched only round the two ends and wherever the tiles' ground comes within 30 m of
          the line of sight (or the first Fresnel zone, where that is wider), with the tiles between, and a repeater or base
          stood on the highest LiDAR ground within its registered position's rounding. Held against the same stations'
          tests, each ground at its own fitted allowance:</p>
        <div class="table-wrap">
          <table class="adm-table nr-acc">
            <caption class="sr-only">The model over five grounds against the attenuator</caption>
            <thead><tr><th scope="col">Ground</th><th scope="col">Typical error, dB</th><th scope="col">Within ±6 dB</th>
              <th scope="col">Pairs in order</th></tr></thead>
            <tbody>${grounds}</tbody>
          </table>
        </div>
        <p class="filter-hint">Sharper ground did not make sharper figures. At 5 m the model prices the exact spot the
          register puts each antenna — and the register's positions are rounded and its heights surveyed elsewhere, so a
          repeater fifty metres off its summit, or a field station beside a bank, is priced exactly wrongly; and
          Longley–Rice, built on coarse profiles, reads every bank beside a 4 m antenna as a horizon. Standing the masts on
          their tops wins back most of it, and LiDAR at the obstacles alone changes nothing measurable. So the tiles stay the
          default, LiDAR is the setting for studying one site whose position is known, and the register check below asks it
          where each repeater and base really stands.</p>
      </div>`;
  }

  // ── the principles ──
  // General ones, the way any VHF event-reporting network is reviewed. Where
  // the matrix can say how this network stands against one, it does.

  function principlesHtml() {
    const k = kpis();
    const mx = matrix && !job;
    const baseHubs = matrix ? matrix.hubs.filter(h => h.kind === 'station' && (stationById(h.id) || { roles: [] }).roles.includes('base')).length : 0;
    const freqs = matrix ? [...new Set(matrix.hubs.filter(h => h.kind === 'station').map(h => Number(h.f).toFixed(3)))] : [];
    const items = [
      { h: 'Two gateways, one of them hardened',
        p: 'Every network lands its data at two receive sites at least, so that one can be lost in the storm it exists for. One of them carries a second, independent way off site — fibre or a landline with cellular or satellite behind it — and standby power. A partner\'s base station is welcome, but is not one of the two: its power and its link are not yours to vouch for at 3 a.m.',
        s: mx ? `${baseHubs} of the hubs in this matrix ${baseHubs === 1 ? 'is a base' : 'are bases'} in the register.` : '' },
      { h: 'Two paths from every station',
        p: 'A field station reaches a gateway two ways — direct and through a repeater, or through two different repeaters — so a repeater down is not a station lost. Where that cannot be had by radio, a priority station carries a second means of reporting.',
        s: mx && k ? `${k.two} of ${k.n} stations have two paths at ${G()} dB or better; ${k.one} have one.` : '' },
      { h: 'Margins to build on',
        p: `${G()} dB or better is a path to build on. ${O()}–${G()} dB works on a good day: more power, a better antenna or a taller mast before relying on it. Under ${O()} dB the station needs a second way out — satellite or cellular — or a different path.`,
        s: mx && k ? `${k.marginal} marginal, ${k.weak + k.none} under ${O()} dB.` : '' },
      { h: 'Short chains of repeaters',
        p: 'Under ALERT2\'s TDMA every repeat of a message takes a slot of its own, so each hop costs frame time that would otherwise carry reports. Keep chains short — two main repeaters in a chain, about three hops in a dense network and five in a sparse one — and start from a two-minute frame of half-second slots, with slots kept spare for the stations not yet built.',
        s: '' },
      { h: 'One frequency to a network, neighbours apart',
        p: 'A network on one frequency, its neighbours on others, keeps each network\'s traffic its own and makes a move to TDMA straightforward. Where two TDMA networks meet, a slot used by a transmitter within about 50 km of the other network\'s receivers is left empty in that network.',
        s: mx && freqs.length ? `The station hubs here receive on ${freqs.length} frequenc${freqs.length === 1 ? 'y' : 'ies'}: ${freqs.join(', ')} MHz.` : '' },
      { h: 'Networks drawn for radio, not for rivers',
        p: 'A network is drawn round the radio paths, not the catchment: one network can serve several basins, or one basin several networks. Its boundary is clean — no path that wanders into the next network to be heard there.',
        s: '' },
      { h: 'Standard builds, one good repeater',
        p: 'Sites built to a standard — mast, power, antenna, lightning protection, a cavity filter at a repeater — are quicker to fault-find and to return to service. Two repeaters on one mast share its power, its feeder run and its lightning strike, and under TDMA they spend two slots on one site: one repeater built well is the more reliable of the two.',
        s: '' },
      { h: 'Licensed before it transmits',
        p: 'Every transmitting site is licensed for the frequency, power and position it actually uses, and a long backbone hop may need a point-to-point licence of its own. The RF Environment tab holds the register to check against.',
        s: '' },
      { h: 'The right channel for the station',
        p: 'Radio first, where a few stations — four or more — can share the repeaters and gateways; satellite where the distances make radio uneconomic and a longer gap between reports does no harm; cellular only where losing it in a flood would not cost the warning.',
        s: '' },
    ];
    return `
      <div class="panel">
        <div class="panel-header"><h2>Design principles</h2></div>
        <p class="small">What a review checks a network against. General principles for VHF event-reporting networks —
          where the matrix above can say how this network stands against one, it says so under it.</p>
        <ol class="nr-principles">${items.map(i => `<li><h3>${esc(i.h)}</h3><p class="small">${esc(i.p)}</p>${
          i.s ? `<p class="small nr-status-line"><strong>Here:</strong> ${esc(i.s)}</p>` : ''}</li>`).join('')}</ol>
      </div>`;
  }

  // ── the register's own faults ──
  // The ones that skew a review before it starts, found from the station list
  // alone — no terrain, no network.

  function registerChecks() {
    if (!state.data) return null;
    const P_ = pathPropOf();
    const masts = state.data.stations.filter(s => !s.deleted_at && stationIsMast(s));
    const assumed = masts.filter(s => stationAntenna(s, rmSystemOf(s)).mast);
    const long = [];
    const idx = typeof passRelationIndex === 'function' ? passRelationIndex() : null;
    if (idx) {
      for (const r of repeaterList(state.data.stations)) {
        if (r.lat == null || r.lon == null) continue;
        for (const s of idx.byRepeater.get(r.id) || []) {
          if (s.lat == null || s.lon == null) continue;
          const km = acmaHaversineKm(r.lat, r.lon, s.lat, s.lon);
          if (km > LONG_LINK_KM) long.push({ r, s, km });
        }
      }
    }
    long.sort((a, b) => b.km - a.km);
    return { masts: masts.length, assumed, long, mastAgl: P_.mastAgl };
  }

  // ── the hubs against the LiDAR ──
  // Where each repeater and base stands, read off the 5 m LiDAR grid: the ground
  // at its registered position against its survey, and the highest ground
  // within LIDAR_REACH_M. A survey metres off the LiDAR ground, or a top a few
  // metres higher a stone's throw away, is a position or a height in the
  // register that is not where the antenna is — and on a summit, that is worth
  // more to a margin than any amount of terrain detail along the path.
  const LIDAR_REACH_M = 100, LIDAR_FLAG_M = 5;
  let lidarCheck = null;      // { phase, done, total, rows: [...] }

  async function checkHubsLidar() {
    if (!isAdmin() || !state.data || typeof LidarProfile === 'undefined') return;
    if (lidarCheck && lidarCheck.phase === 'running') return;
    const hubsAll = state.data.stations.filter(s => !s.deleted_at && stationIsMast(s) && s.lat != null && s.lon != null);
    lidarCheck = { phase: 'running', done: 0, total: hubsAll.length, rows: [] };
    repaint();
    let next = 0;
    const worker = async () => {
      while (next < hubsAll.length) {
        const st = hubsAll[next++];
        const top = await LidarProfile.highest(st.lat, st.lon, LIDAR_REACH_M);
        const at = top ? top.from_m : null;
        const survey = st.elevation_ahd != null ? Number(st.elevation_ahd) : null;
        lidarCheck.rows.push({ id: st.id, name: st.name, survey, at, top: top ? top.ground : null, away: top ? top.moved_m : null,
          off: survey != null && at != null ? survey - at : null, rise: top && at != null ? top.ground - at : null });
        lidarCheck.done++;
        if (lidarCheck.done % 10 === 0) repaintLidar();
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    lidarCheck.phase = 'done';
    lidarCheck.rows.sort((a, b) => Math.max(Math.abs(b.off || 0), b.rise || 0) - Math.max(Math.abs(a.off || 0), a.rise || 0));
    repaintLidar();
  }

  function lidarCheckHtml() {
    if (typeof LidarProfile === 'undefined') return '';
    const c = lidarCheck;
    const flagged = c ? c.rows.filter(r => (r.off != null && Math.abs(r.off) > LIDAR_FLAG_M) || (r.rise != null && r.rise > LIDAR_FLAG_M)) : [];
    const none = c ? c.rows.filter(r => r.at == null).length : 0;
    const f1 = v => (v == null ? '—' : v.toFixed(1));
    const body = !c ? ''
      : c.phase === 'running' ? `<p class="small" role="status">Reading the LiDAR round ${c.done} of ${c.total} repeaters and bases…</p>`
      : `<p class="small" role="status">${c.total} repeaters and bases: ${flagged.length} worth a second look, ${c.total - flagged.length - none}
          where the register and the LiDAR agree, ${none} where the LiDAR holds nothing.</p>
        ${flagged.length ? `<div class="table-wrap" role="region" tabindex="0" aria-label="Repeaters and bases the LiDAR disagrees with">
          <table class="adm-table nr-acc"><caption class="sr-only">Repeaters and bases whose registered height or position the LiDAR disagrees with</caption>
            <thead><tr><th scope="col">Hub</th><th scope="col">Surveyed, m AHD</th><th scope="col">LiDAR there, m</th>
              <th scope="col">Survey − LiDAR, m</th><th scope="col">Highest within ${LIDAR_REACH_M} m</th><th scope="col">Higher by, m</th></tr></thead>
            <tbody>${flagged.map(r => `<tr><th scope="row"><button type="button" class="link-btn" onclick="NetworkReview.openStation('${escAttr(r.id)}')">${esc(r.name)}</button></th>
              <td class="nr-num">${f1(r.survey)}</td><td class="nr-num">${f1(r.at)}</td><td class="nr-num">${r.off == null ? '—' : `${r.off > 0 ? '+' : ''}${r.off.toFixed(1)}`}</td>
              <td class="nr-num">${f1(r.top)}<span class="small txt-muted"> ${r.away != null ? `${Math.round(r.away)} m away` : ''}</span></td>
              <td class="nr-num">${f1(r.rise)}</td></tr>`).join('')}</tbody>
          </table></div>` : ''}`;
    return `
        <h3>Repeaters and bases against the LiDAR</h3>
        <p class="small">Where Geoscience Australia's 5 m LiDAR grid holds the ground, each repeater's and base's surveyed height
          against the LiDAR ground at its registered position, and the highest ground within ${LIDAR_REACH_M} m. A survey more
          than ${LIDAR_FLAG_M} m off, or a top more than ${LIDAR_FLAG_M} m higher close by, is a register entry that is not where
          the antenna is — and a few metres at a summit move every margin to it.
          <button type="button" class="link-btn" onclick="NetworkReview.checkHubsLidar()" ${c && c.phase === 'running' ? 'disabled' : ''}>Check them</button></p>
        <div id="nr-lidar">${body}</div>`;
  }

  function repaintLidar() {
    const el = typeof document !== 'undefined' && document.getElementById('nr-lidar');
    if (el) {
      const tmp = document.createElement('div');
      tmp.innerHTML = lidarCheckHtml();
      const inner = tmp.querySelector('#nr-lidar');
      el.innerHTML = inner ? inner.innerHTML : '';
    } else repaint();
  }

  function registerHtml() {
    const c = registerChecks();
    if (!c) return '';
    const names = list => list.slice(0, 16).map(s => esc(s.name)).join(', ') + (list.length > 16 ? `, and ${list.length - 16} more` : '');
    return `
      <div class="panel">
        <div class="panel-header"><h2>The register, before a review</h2></div>
        <h3>Antenna heights at repeaters and bases</h3>
        <p class="small">${c.assumed.length} of the register's ${c.masts} repeaters and bases are on a radio system
          whose antenna is lower than a mast, so every margin to them is computed on an assumed
          <strong>${c.mastAgl} m mast</strong> (the link budget card's setting). The real height of each, on a radio system
          of its own, takes the assumption away for that site.${c.assumed.length ? ` <span class="txt-muted">${names(c.assumed)}.</span>` : ''}</p>
        <h3>Pass-range links over ${LONG_LINK_KM} km</h3>
        <p class="small">${c.long.length
          ? `${c.long.length} station${c.long.length === 1 ? ' is' : 's are'} “carried” by a repeater more than ${LONG_LINK_KM} km
             away, because an ALERT address of theirs falls in that repeater's pass range. They are address collisions, not
             radio paths: the map draws them, and a fade-margin sweep prices them at hundreds of decibels short. The longest:`
          : `None — every station a repeater's pass ranges take in is within ${LONG_LINK_KM} km of it.`}</p>
        ${c.long.length ? `<ul class="small">${c.long.slice(0, 8).map(l => `<li>${esc(l.r.name)} ← ${esc(l.s.name)}, ${Math.round(l.km).toLocaleString()} km</li>`).join('')}</ul>` : ''}
        <h3>Surveyed below the terrain model</h3>
        <p class="small">A station surveyed more than a few metres under the terrain tiles round it is lifted onto them
          before its path is priced — otherwise its antenna starts in a pit of the model's making. The matrix flags each
          one it meets (“surveyed … below the terrain model”): worth a second look at the survey, or at the position.</p>
        ${lidarCheckHtml()}
      </div>`;
  }

  function render() {
    const body = !isAdmin() ? outsideHtml()
      : [matrixPanelHtml(), typeof NetworkHistory !== 'undefined' ? NetworkHistory.panelHtml() : '',
         reconcileHtml(), principlesHtml(), registerHtml()].join('');
    return `<div class="page" style="--page-max:1200px"><h2 class="sr-only">Network Review</h2><div class="stack" id="nr-page">${body}</div></div>`;
  }

  function repaint() {
    if (state.activeTab !== 'review') return;
    const el = document.getElementById('main-content');
    if (el) el.innerHTML = render();
  }

  // A run lands a cell at a time: only what moves is rewritten, so the page
  // does not jump and the boxes being typed in are left alone.
  function repaintLive() {
    if (state.activeTab !== 'review') return;
    const set = (id, html) => { const el = document.getElementById(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
    if (!document.getElementById('nr-table')) { repaint(); return; }
    set('nr-status', statusHtml());
    set('nr-kpis', kpisHtml());
    set('nr-table', tableHtml());
    const btns = document.querySelector('#nr-page .button-group');
    if (btns && !job && btns.querySelector('button[onclick="NetworkReview.stop()"]')) repaint();
  }

  return {
    render,
    init() { /* nothing to start: every run is asked for */ },
    authChanged() { repaint(); },
    repaintAll: repaint,
    checkHubsLidar,
    lidarCheck: () => lidarCheck,
    // Shared with network-history.js, so its stations are priced and read
    // exactly as the matrix's are.
    pathMargin,
    radioOfStation,
    stepOf,
    selectAll,
    exportCsv,
    compute,
    stop,
    // For the tests and the export menu: what is on screen.
    matrix: () => matrix,
    measured: () => measured,
    fieldCheck,
    registerChecks,
    addHub(id) {
      if (!id || hubs.some(h => h.kind === 'station' && h.id === id) || !stationById(id)) return;
      hubs.push({ kind: 'station', id });
      note = null;
      repaint();
    },
    removeHub(k) {
      if (k < 0 || k >= hubs.length) return;
      hubs.splice(k, 1);
      repaint();
    },
    setRadius(v) {
      const n = Number(v);
      radiusKm = isFinite(n) && n > 0 ? Math.min(150, n) : 0;
      repaint();
    },
    siteField(k, v) { if (k in site) site[k] = String(v); },
    addSite() {
      const lat = Number(site.lat), lon = Number(site.lon);
      const agl = site.agl === '' ? pathPropOf().mastAgl : Number(site.agl);
      if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || site.lat === '' || site.lon === '') {
        note = { cls: 'txt-warn', text: 'A proposed site needs a latitude and a longitude.' };
        repaint();
        return;
      }
      if (!(agl > 0 && agl <= 100)) {
        note = { cls: 'txt-warn', text: 'A mast between 1 and 100 m.' };
        repaint();
        return;
      }
      siteSeq++;
      hubs.push({ kind: 'site', key: `site-${siteSeq}`, name: site.name.trim() || `Proposed site ${siteSeq}`, lat, lon, agl });
      site = { name: '', lat: '', lon: '', agl: '' };
      note = null;
      repaint();
    },
    convert(v) {
      rmIn = String(v);
      const out = document.getElementById('nr-conv-out');
      if (!out) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = reconcileHtml();
      const fresh = tmp.querySelector('#nr-conv-out');
      if (fresh) out.innerHTML = fresh.innerHTML;
    },
    openStation(id) {
      if (typeof focusStation === 'function') { switchTab('stations'); focusStation(id); }
    },
    // Read by the tests: a hub list made in one call.
    setHubs(list) {
      hubs = (list || []).filter(h => h && (h.kind === 'site' || stationById(h.id)));
      repaint();
    },
  };
})();
if (typeof window !== 'undefined') window.NetworkReview = NetworkReview;
