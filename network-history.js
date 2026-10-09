// MegaNet — network-history.js
//
//   NetworkHistory   the Network Review tab's check of the fade-margin model
//                    against every attenuator test on file: each station with
//                    a path margin measured since 2010, priced to every
//                    repeater or base that could carry it, and the model held
//                    to the field network-wide and region by region.
//
// After network-review.js, whose pathMargin, radioOfStation, stepOf and
// selectAll it calls — so a station here is priced exactly as a cell of the
// matrix is, and its tests are read by the same rules. Before init.js. Nothing
// runs at load: the Network Review tab draws panelHtml(), and a run is asked
// for. Reaches back to core.js for state, esc, escAttr, fmtKm, dlText,
// acmaHaversineKm and FN_MODEL_DEFAULTS; across to app.js for
// passRelationIndex and stationById, to path-profile.js for pathPropOf and
// PATH_DEFAULT_MHZ, and to link-budget.js for LinkBudget (the session's
// allowance, when a run's fit is taken up).
//
// ── What it answers ──────────────────────────────────────────────────────────
// The field allowance was fitted to the tests of one region. Several hundred
// stations have been tested since, across the whole network, and this runs the
// same fit over all of them on demand:
//
//   • the allowance the whole field asks for, with a bootstrap range;
//   • how far the model is out at the allowance in force, by distance, by hub
//     and by basin;
//   • and the hubs whose stations all read better (or worse) than modelled by
//     more than the scatter allows. That is not noise to average away: it is a
//     hub whose register entry is short of something — a mast taller than the
//     assumed one, an antenna better than an omni, a position off its summit —
//     and the fix is in the register, after which the next run says so.
//
// A station's test is end to end, so its figure is its best path, as the
// matrix's Measured column is read against Best. The candidates are the
// repeaters whose pass ranges carry it (within LONG_LINK_KM, as the matrix
// has it) and any base within BASE_KM; a station no hub reaches is counted
// and left out.
//
// One thing the fit cannot see, and the panel says: the network was built so
// that every station works. A long link that exists was given what it needed
// to — a directional antenna, a taller mast — and the register mostly does not
// say so. So the field reads near-constant margins at every distance while the
// model, which knows only the register's omni on a 4 m pole, falls away with
// distance. The allowance is therefore fitted on the paths the register most
// plausibly describes (FIT_KM and under) and the rest are shown, not fitted.
const NetworkHistory = (function () {
  const SINCE = '2010-01-01';
  const VISITS = 3;            // the latest visits a station's figure is the median of
  const LONG_LINK_KM = 150;    // the matrix's own: a longer pass-range "link" is an address collision
  const BASE_KM = 80;          // a base this near may hear a station direct
  const FIT_KM = 35;           // the allowance is fitted on paths this short
  const CONCURRENCY = 4;
  const MIN_HUB = 5, MIN_BASIN = 10;
  const OUTLIER_DB = 10;       // a hub this far from the network is flagged
  const BOOT = 200;

  let run = null;              // see start()
  let gen = 0;

  const isAdmin = () => typeof Auth !== 'undefined' && Auth.isSignedIn()
    && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');

  // ── the arithmetic ──
  // Distance from a model figure to the step a station's tests put its margin
  // in: nought inside, model minus the nearer edge outside.
  const err = (x, s) => (x < s.m ? x - s.m : x > s.hi ? x - s.hi : 0);

  // The offset c (dB) that makes the model figure x − c fit the steps best, by
  // least squares on the distances above. Convex, so a golden-section search
  // is exact enough and cheap enough to bootstrap.
  function fitOffset(pairs) {
    if (!pairs.length) return null;
    const sse = c => { let t = 0; for (const p of pairs) { const e = err(p.x - c, p.s); t += e * e; } return t; };
    let a = -60, b = 60;
    const g = (Math.sqrt(5) - 1) / 2;
    let c1 = b - g * (b - a), c2 = a + g * (b - a), f1 = sse(c1), f2 = sse(c2);
    for (let i = 0; i < 70; i++) {
      if (f1 <= f2) { b = c2; c2 = c1; f2 = f1; c1 = b - g * (b - a); f1 = sse(c1); }
      else { a = c1; c1 = c2; f1 = f2; c2 = a + g * (b - a); f2 = sse(c2); }
    }
    return (a + b) / 2;
  }

  // Of the pairs of stations whose steps do not overlap — the pairs the
  // attenuator can tell apart — the share the model puts the right way round.
  function inOrder(pairs) {
    let c = 0, d = 0;
    for (const p of pairs) {
      for (const q of pairs) {
        if (!(p.s.hi <= q.s.m)) continue;
        d++;
        c += p.x < q.x ? 1 : p.x === q.x ? 0.5 : 0;
      }
    }
    return d ? c / d : null;
  }

  function stats(pairs, offset) {
    if (!pairs.length) return null;
    const es = pairs.map(p => err(p.x - offset, p.s));
    const n = es.length;
    return {
      n,
      fit: fitOffset(pairs),
      mean: es.reduce((a, b) => a + b, 0) / n,
      typical: es.reduce((a, b) => a + Math.abs(b), 0) / n,
      w6: es.filter(e => Math.abs(e) <= 6).length / n,
      order: inOrder(pairs),
    };
  }

  // A seeded generator, so a bootstrap range does not move between two looks
  // at the same run.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function bootstrap(pairs) {
    if (pairs.length < 10) return null;
    const r = rng(20261009), fits = [];
    for (let k = 0; k < BOOT; k++) {
      const sample = [];
      for (let i = 0; i < pairs.length; i++) sample.push(pairs[Math.floor(r() * pairs.length)]);
      fits.push(fitOffset(sample));
    }
    fits.sort((a, b) => a - b);
    return { lo: fits[Math.floor(0.05 * (BOOT - 1))], hi: fits[Math.ceil(0.95 * (BOOT - 1))] };
  }

  // ── reading the tests ──
  // Every visit since SINCE and every PATH MARGIN pass, a page at a time; a
  // visit's figure is its largest load (0014's rule), nought is "not tested"
  // and over 60 a slip of the pen, as the matrix reads them.
  async function readTests() {
    const visits = await NetworkReview.selectAll(
      `inspection_chart_visit?select=id,station_id,inspected_on&inspected_on=gte.${SINCE}&order=id.asc`);
    const loads = await NetworkReview.selectAll(
      'inspection_chart_fade_margin?select=inspection_id,load_db&phase=eq.this_visit&load_db=gt.0&order=inspection_id.asc,load_db.asc');
    const byVisit = new Map();
    for (const r of loads) {
      const v = Number(r.load_db);
      if (!(v > 0) || v > 60) continue;
      byVisit.set(r.inspection_id, Math.max(byVisit.get(r.inspection_id) || 0, v));
    }
    const byStation = new Map();
    for (const v of visits) {
      const load = byVisit.get(v.id);
      if (load == null) continue;
      if (!byStation.has(v.station_id)) byStation.set(v.station_id, []);
      byStation.get(v.station_id).push({ at: v.inspected_on, load });
    }
    const out = new Map();
    for (const [id, list] of byStation) {
      list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      const latest = list.slice(0, VISITS);
      out.set(id, { ...NetworkReview.stepOf(latest.map(v => v.load)), n: latest.length, at: latest[0].at });
    }
    return { tests: out, visits: visits.length };
  }

  // The hubs that could carry a station: the repeaters whose pass ranges hold
  // one of its addresses, and the bases near enough to hear it direct.
  function candidates(st, bases) {
    const idx = passRelationIndex();
    const out = new Map();
    for (const r of idx.byStation.get(st.id) || []) {
      if (r.lat != null && acmaHaversineKm(r.lat, r.lon, st.lat, st.lon) <= LONG_LINK_KM) out.set(r.id, r);
    }
    for (const b of bases) {
      if (b.id !== st.id && !out.has(b.id) && acmaHaversineKm(b.lat, b.lon, st.lat, st.lon) <= BASE_KM) out.set(b.id, b);
    }
    return [...out.values()];
  }
  const freqOf = h => (h.repeater && h.repeater.rx_mhz > 0 ? Number(h.repeater.rx_mhz) : PATH_DEFAULT_MHZ);

  // ── the run ──
  async function start() {
    if (!isAdmin() || !state.data || (run && run.phase === 'pricing')) return;
    const mine = ++gen;
    const P_ = pathPropOf();
    run = { phase: 'reading', done: 0, total: 0, error: '', at: new Date(), model: P_.model, allowance: P_.allowance,
            ground: P_.ground || '30m', stations: [], unreached: 0, unknown: 0, visits: 0 };
    repaint();
    let tests;
    try {
      const got = await readTests();
      tests = got.tests;
      run.visits = got.visits;
    } catch (e) {
      if (gen !== mine) return;
      run.phase = 'failed';
      run.error = `The tests could not be read: ${(e && e.message) || e}`;
      repaint();
      return;
    }
    if (gen !== mine) return;
    const all = state.data.stations;
    const byId = new Map(all.map(s => [s.id, s]));
    const bases = all.filter(s => s.roles.includes('base') && s.lat != null);
    const jobs = [];
    for (const [id, step] of tests) {
      const st = byId.get(id);
      if (!st || st.lat == null) { run.unknown++; continue; }
      if (st.roles.includes('repeater') || st.roles.includes('base')) continue;
      const hubs = candidates(st, bases);
      if (!hubs.length) { run.unreached++; continue; }
      const row = { id, name: st.name, number: st.station_number || '', basin: st.basin || '', step, figs: [], best: null };
      run.stations.push(row);
      for (const h of hubs) jobs.push({ row, h });
    }
    // Grouped by hub, so the tiles round each hub are fetched once and used by
    // every path out of it before the cache moves on.
    jobs.sort((a, b) => (a.h.id < b.h.id ? -1 : a.h.id > b.h.id ? 1 : 0));
    run.phase = 'pricing';
    run.total = jobs.length;
    repaint();
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && gen === mine) {
        const { row, h } = jobs[next++];
        let fig;
        try {
          const st = byId.get(row.id);
          fig = await NetworkReview.pathMargin(NetworkReview.radioOfStation(st), NetworkReview.radioOfStation(h), freqOf(h));
        } catch (e) { fig = { err: 'model' }; }
        if (gen !== mine) return;
        row.figs.push({ hub: h.id, hubName: h.name, ...fig });
        if (fig.m != null && (!row.best || fig.m > row.best.m)) row.best = { hub: h.id, hubName: h.name, m: fig.m, dKm: fig.dKm };
        run.done++;
        if (run.done % 25 === 0) repaintLive();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (gen !== mine) return;
    run.phase = 'done';
    summarise();
    repaint();
  }

  function stop() {
    if (!run || run.phase !== 'pricing') return;
    gen++;
    run.phase = 'stopped';
    summarise();
    repaint();
  }

  function summarise() {
    const priced = run.stations.filter(r => r.best);
    const pairs = priced.map(r => ({ x: r.best.m, s: r.step, r }));
    const near = pairs.filter(p => p.r.best.dKm <= FIT_KM);
    const fitNear = fitOffset(near);
    const groupBy = (key, min) => {
      const g = new Map();
      for (const p of pairs) {
        const k = key(p.r);
        if (!k) continue;
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(p);
      }
      return [...g.entries()].filter(([, ps]) => ps.length >= min)
        .map(([k, ps]) => ({ key: k, name: key === hubKey ? ps[0].r.best.hubName : k, ...stats(ps, 0) }))
        .sort((a, b) => b.n - a.n);
    };
    const hubKey = r => r.best.hub;
    const bands = [[0, 10], [10, 20], [20, FIT_KM], [FIT_KM, 50], [50, Infinity]].map(([lo, hi]) => {
      const ps = pairs.filter(p => p.r.best.dKm >= lo && p.r.best.dKm < hi);
      return { lo, hi, ...(ps.length ? stats(ps, 0) : { n: 0 }) };
    });
    const hubs = groupBy(hubKey, MIN_HUB);
    for (const h of hubs) h.flag = fitNear != null && h.fit != null && Math.abs(h.fit - fitNear) >= OUTLIER_DB;
    run.summary = {
      all: stats(pairs, 0), near: stats(near, 0), fitNear, range: bootstrap(near),
      bands, hubs, basins: groupBy(r => r.basin, MIN_BASIN),
    };
  }

  // ── the CSV ──
  function exportCsv() {
    if (!run || !run.stations.length) return;
    const q = v => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const lines = [
      `# Flood-Net — the fade-margin model against every attenuator test since ${SINCE.slice(0, 4)}: ${run.model === 'cover' ? 'land-cover model' : `field-calibrated model, ${run.allowance} dB allowance`}, ${run.ground === 'lidar' ? 'LiDAR at the ends and obstacles' : '~30 m terrain'}`,
      `# computed ${run.at.toISOString()}; a station's model figure is its best path; its measured margin lies between from and to (no "to" means at least "from")`,
      ['station', 'station_number', 'basin', 'best_hub', 'best_km', 'model_margin_db', 'measured_from_db', 'measured_to_db', 'visits', 'error_db'].join(','),
    ];
    for (const r of run.stations) {
      const e = r.best ? err(r.best.m, r.step) : null;
      lines.push([r.name, r.number, r.basin, r.best ? r.best.hubName : '', r.best ? f1(r.best.dKm) : '', r.best ? f1(r.best.m) : '',
        f1(r.step.m), r.step.censored ? '' : f1(r.step.hi), r.step.n || '', f1(e)].map(q).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    dlText(`attenuator-history-check-${stamp}.csv`, lines.join('\n') + '\n');
  }

  // Take the run's fit up for this session: the allowance the field asked for,
  // in the link budget card's propagation settings, which every figure follows.
  function useFit() {
    if (!run || !run.summary || run.summary.fitNear == null || run.model === 'cover') return;
    const v = Math.max(0, Math.round((run.allowance + run.summary.fitNear) * 2) / 2);
    if (typeof LinkBudget !== 'undefined') LinkBudget.setProp('allowance', v);
    repaint();
  }

  // ── the panel ──
  const sgn = v => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
  const pct = v => (v == null ? '—' : `${Math.round(v * 100)} %`);

  function statusHtml() {
    if (!run) return '';
    if (run.phase === 'reading') return 'Reading the attenuator tests…';
    if (run.phase === 'failed') return `<span class="txt-bad">${esc(run.error)}</span>`;
    const tail = `${run.stations.length} stations with tests since ${SINCE.slice(0, 4)}`
      + (run.unreached ? `, ${run.unreached} that no hub in the register reaches` : '')
      + (run.unknown ? `, ${run.unknown} not in the register` : '');
    if (run.phase === 'pricing') return `Pricing ${run.done} of ${run.total} paths — ${tail}.`;
    return `${run.phase === 'stopped' ? 'Stopped' : 'Done'}: ${run.done} paths for ${tail}.`;
  }

  function resultsHtml() {
    const S = run && run.summary;
    if (!S || !S.all) return '';
    const field = run.model !== 'cover';
    const asked = S.fitNear == null ? null : run.allowance + S.fitNear;
    const tile = (label, v, sub, mod) => `<div class="adm-kpi${mod ? ' adm-kpi--' + mod : ''}"><div class="adm-kpi-label">${esc(label)}</div>`
      + `<div class="adm-kpi-value">${esc(v)}</div><div class="adm-kpi-sub">${esc(sub)}</div></div>`;
    const tiles = [
      tile('Stations priced', S.all.n, `${S.near.n} with a best path up to ${FIT_KM} km`, ''),
      field && asked != null ? tile('The allowance the field asks for', `${asked.toFixed(1)} dB`,
        S.range ? `${(run.allowance + S.range.lo).toFixed(1)}–${(run.allowance + S.range.hi).toFixed(1)} dB at 90 %, paths up to ${FIT_KM} km` : `paths up to ${FIT_KM} km`, '') : '',
      tile(`Mean error at ${field ? `${run.allowance} dB` : 'this model'}`, `${sgn(S.near.mean)} dB`, `paths up to ${FIT_KM} km · ±${S.near.typical.toFixed(1)} dB typical`,
        Math.abs(S.near.mean) <= 3 ? 'ok' : 'warn'),
      tile('Pairs in order', pct(S.near.order), 'of the pairs of stations the tests can tell apart', ''),
    ].join('');
    const head = cols => `<thead><tr>${cols.map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead>`;
    const statCells = s => `<td class="nr-num">${s.n}</td><td class="nr-num">${sgn(s.mean)}</td><td class="nr-num">${s.typical != null ? s.typical.toFixed(1) : '—'}</td>
      <td class="nr-num">${pct(s.w6)}</td><td class="nr-num">${pct(s.order)}</td><td class="nr-num">${field && s.fit != null ? (run.allowance + s.fit).toFixed(1) : sgn(s.fit)}</td>`;
    const cols = ['Stations', 'Mean error, dB', 'Typical, dB', 'Within ±6 dB', 'Pairs in order', field ? 'Allowance it asks for, dB' : 'Offset it asks for, dB'];
    const bandRows = S.bands.filter(b => b.n).map(b => `<tr><th scope="row">${b.hi === Infinity ? `over ${b.lo} km` : `${b.lo}–${b.hi} km`}</th>${statCells(b)}</tr>`).join('');
    const hubRows = S.hubs.map(h => `<tr><th scope="row">${esc(h.name)}${h.flag
      ? ` <span class="small txt-warn">its stations read ${h.fit > S.fitNear ? 'worse' : 'better'} than modelled by ${Math.abs(h.fit - S.fitNear).toFixed(0)} dB — check its mast, antenna and position</span>` : ''}</th>${statCells(h)}</tr>`).join('');
    const basinRows = S.basins.map(b => `<tr><th scope="row">${esc(b.name)}</th>${statCells(b)}</tr>`).join('');
    const table = (cap, first, rows) => !rows ? '' : `
      <div class="table-wrap" role="region" tabindex="0" aria-label="${escAttr(cap)}">
        <table class="adm-table nr-acc"><caption class="sr-only">${esc(cap)}</caption>${head([first, ...cols])}<tbody>${rows}</tbody></table>
      </div>`;
    return `
      <div class="adm-kpis">${tiles}</div>
      <p class="filter-hint">Errors are model minus measured at ${field ? `the ${run.allowance} dB allowance in force` : 'the land-cover model'}, each
        station's best path against the step its tests put its margin in (the matrix's rule). The fit is over paths up to
        ${FIT_KM} km: longer links read better than the register's omni on a 4 m pole can, because a link that exists was
        built to work — see below.</p>
      <div class="button-group">
        ${field && asked != null ? `<button type="button" onclick="NetworkHistory.useFit()">Use ${(Math.round(Math.max(0, asked) * 2) / 2)} dB for this session</button>` : ''}
        <button type="button" class="exp-btn-sm" onclick="NetworkHistory.exportCsv()">⤓ CSV</button>
      </div>
      <h3>By distance</h3>
      ${table('The model against the tests, by the length of each station\'s best path', 'Best path', bandRows)}
      <p class="small">The measured margins hardly change with distance; the model's fall away. That is the network's design,
        not the model's physics: a long link that works was given a directional antenna or a taller mast, and the register
        mostly does not record it. Each one recorded closes the gap for that station.</p>
      <h3>By hub</h3>
      ${table('The model against the tests, by the hub of each station\'s best path', `Hub (${MIN_HUB} stations or more)`, hubRows)}
      <h3>By basin</h3>
      ${table('The model against the tests, by basin', `Basin (${MIN_BASIN} stations or more)`, basinRows)}`;
  }

  function panelHtml() {
    if (!isAdmin()) return '';
    const P_ = pathPropOf();
    const busy = run && (run.phase === 'reading' || run.phase === 'pricing');
    return `
      <div class="panel">
        <div class="panel-header"><h2 id="nh-h">The model against every attenuator test</h2></div>
        <p class="small">Every station whose path margin has been tested since ${SINCE.slice(0, 4)}, priced to every repeater
          that carries it and every base within ${BASE_KM} km, and its best path held to the median of its last ${VISITS}
          tests — the whole network at once, by distance, by hub and by basin. Margins are the ${P_.model === 'cover'
            ? 'land-cover model\'s' : `field-calibrated model's, at the ${P_.allowance} dB allowance`} on ${P_.ground === 'lidar'
            ? 'LiDAR at the ends and the obstacles' : 'the ~30 m terrain'}, as the link budget card is set. A few thousand paths:
          minutes, not seconds.</p>
        <div class="button-group">
          <button type="button" class="primary" onclick="NetworkHistory.start()" ${busy ? 'disabled' : ''}>Check every station</button>
          ${run && run.phase === 'pricing' ? '<button type="button" onclick="NetworkHistory.stop()">Stop</button>' : ''}
        </div>
        <p class="small" id="nh-status" role="status">${statusHtml()}</p>
        <div id="nh-results">${run && run.summary ? resultsHtml() : ''}</div>
      </div>`;
  }

  function repaint() {
    if (typeof NetworkReview !== 'undefined' && state.activeTab === 'review') NetworkReview.repaintAll();
  }
  function repaintLive() {
    const el = typeof document !== 'undefined' && document.getElementById('nh-status');
    if (el) el.innerHTML = statusHtml();
    else repaint();
  }

  return {
    panelHtml,
    start,
    stop,
    exportCsv,
    useFit,
    // For the tests: the run as it stands, and the arithmetic on its own.
    run: () => run,
    fitOffset,
    inOrder,
  };
})();
