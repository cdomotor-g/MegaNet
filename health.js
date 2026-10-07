// MegaNet — health.js
//
//   Health   the Station Health tab: what the readings landing in the
//            datastore say about each field station and about the network
//            carrying them, ranked by what needs doing.
//
// After core.js, app.js (switchTab, goToStation, stationAlertIds,
// stationOwner, MAP_HOME), map-controls.js (addBaseLayers), datastore.js
// (dbSelect, dbHostLabel), sensor-values.js and health-analysis.js
// (HealthAnalysis, which does all the reasoning); before health-agent.js,
// which reads what this tab holds, and init.js. Registers its map and its
// teardown (#142). Nothing here runs at load.
//
// ── What this tab is for, and why it is not the Message Log again ────────────
// The Message Log is the arrivals board: every reading, newest first, and the
// detail of any one. This is the maintenance board: the same readings over
// days, read for what they say about the stations — which have gone quiet,
// whose checks are going missing more each day, whose battery is sliding,
// whose rain gauge stayed dry through its neighbours' storm — and about the
// network: which receiver stopped, which repeater a run of silences has in
// common, which quarter-hour the whole network missed at once, and which
// stored readings are corrupted copies rather than data.
//
// Three ways in, for three jobs:
//
//   Needs attention   the findings, worst first, each with its evidence and
//                     what to do about it. The morning's list.
//   A station         its check schedule slot by slot, its battery across its
//                     solar day, its sensors, and the context lens: pick a
//                     missed check or a reading and see what every receiver
//                     and every neighbour was doing at that moment — which is
//                     what turns "it missed a check" into "it missed a check
//                     its neighbours made", or "everybody missed that one".
//   The network       receivers, repeaters, the register — the places one
//                     fault shows up as many.
//
// And a fourth, in health-agent.js: Claude, handed these findings and tools
// over the same readings, asked to investigate and write the briefing.
//
// Readings are public (0006), so this tab needs no sign-in. Seven days of the
// Raspberry Pi feed is about 17,000 readings: seventeen pages, fetched in
// parallel twelve hours at a time, analysed in a few hundred milliseconds.

const Health = (() => {

  const DAY = 86400000, HOUR = 3600000, MIN = 60000;
  const PAGE = 1000;            // PostgREST's max rows per request on this project
  const CHUNK_MS = 12 * HOUR;   // each chunk pages on its own; four at a time
  const PARALLEL = 4;
  const MAX_ROWS = 250000;      // a fortnight of a much bigger network; past it, say so
  const WINDOWS = [
    ['3d',  '3 days',  3],
    ['7d',  '7 days',  7],
    ['14d', '14 days', 14],
  ];
  const SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
               + 'reading_ts,received_at,value_raw,value,unit,protocol,source,path,'
               + 'dup_count,dup_paths,freq_mhz,rssi_dbm,level_dbfs,snr_db';

  const SEV = {
    critical: { label: 'Critical', icon: '⛔', cls: 'txt-bad' },
    warn:     { label: 'Warning',  icon: '⚠',  cls: 'txt-warn' },
    info:     { label: 'Note',     icon: 'ℹ',  cls: 'txt-muted' },
  };
  const CATS = [
    ['all',      'Everything'],
    ['power',    'Power'],
    ['comms',    'Check signals'],
    ['network',  'Network'],
    ['sensor',   'Sensors'],
    ['data',     'Data quality'],
    ['register', 'Register'],
  ];
  const OUTCOME = {
    hit:     { label: 'received',              cls: 'hl-slot--hit' },
    partial: { label: 'received, frames lost', cls: 'hl-slot--partial' },
    miss:    { label: 'missed',                cls: 'hl-slot--miss' },
    net:     { label: 'missed network-wide',   cls: 'hl-slot--net' },
    unknown: { label: 'no receiver listening', cls: 'hl-slot--unknown' },
  };

  function storedWin() {
    try { const k = localStorage.getItem('mn-hl-win'); return WINDOWS.some(w => w[0] === k) ? k : null; } catch (_) { return null; }
  }
  // The owner filter, remembered on this device like the window: whoever
  // looks after one council's stations wants that council's every morning.
  function storedOwners() {
    try {
      const a = JSON.parse(localStorage.getItem('mn-hl-owners') || '[]');
      return new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string' && x) : []);
    } catch (_) { return new Set(); }
  }

  const H = {
    win: storedWin() || '7d',
    rows: null, t0: null, t1: null, at: null,
    loading: false, fetched: 0, error: '', capped: false, seq: 0, demo: false,
    A: null,                 // HealthAnalysis.run() result
    cat: 'all', showInfo: false,
    sel: null,               // the station open below
    // A station asked for from another tab (showStation — the Stations card's
    // health lines, #218), held until the analysis is in hand: { id, part }.
    want: null,
    // …and one asked for that the window holds nothing from: said so in the
    // station panel rather than dropped in silence.
    missing: null,
    lens: null,              // { id, t, kind: 'slot'|'reading', addr }
    map: null, layer: null,
    insp: new Map(),         // station id -> { visits, power } | 'loading' | { error }
    matrixAll: false,
    owners: storedOwners(),  // the owners picked; empty is every owner
    slsAsked: false,         // the SLS file, where most owners come from, sent for…
    slsFailed: false,        // …and did not load
    // The server's own last look (#215, 0059): this file's analysis, run every
    // fifteen minutes with nobody's browser open, its findings about a present
    // condition kept in meganet.health_finding. { at, findings }, { missing }
    // for a database without it, or null before it is asked.
    server: null,
  };

  // ── small helpers ──────────────────────────────────────────────────────────

  const p2 = n => String(n).padStart(2, '0');
  function fmtTs(t) {
    const d = new Date(t);
    return isNaN(d) ? '—' : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  function fmtDay(t) {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtHm(t) { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
  function fmtAgo(t) {
    if (t == null) return '—';
    const ms = Date.now() - t;
    return ms < 90 * 1000 ? 'just now' : `${HealthAnalysis.fmtSpan(ms)} ago`;
  }
  const fmtWhen = t => HealthAnalysis.fmtWhen(t);
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  // A receiver's name without the transport's prefix: "rpi-6dfef7f4" reads,
  // "serial-monitor/rpi-6dfef7f4" wraps three times in a table cell.
  const hostLabel = h => String(h || '').replace(/^serial-monitor\//, '').replace(/^meganet\/v1\/([^/]+)\/logger\/reading\//, '$1 · ');
  const stationById = id => ((state.data && state.data.stations) || []).find(s => s.id === id) || null;

  // ── who owns a station ─────────────────────────────────────────────────────
  // app.js's stationOwner: the owner recorded on the station, else the
  // Bureau's SLS "Station owner" — the same answer the station card's top row
  // gives — split into its parties for the filter ("Bureau/Seqwater" is
  // Seqwater's station too). { name, parties, src } or null: nobody on
  // record, or the SLS file not on hand yet.
  const NO_OWNER = '(none on record)';
  // Whether every owner can be told yet: the SLS file is fetched on first need
  // (sls.js), and until it lands a station with no owner of its own is not
  // known to have none.
  const ownersReady = () => typeof SLS === 'undefined' || SLS.loaded() || H.slsFailed;
  const ownerOf = st => (typeof stationOwner === 'function' ? stationOwner(st) : null);
  function ownerSmallHtml(st, cls) {
    const o = ownerOf(st);
    if (!o) return '';
    return `<span class="hl-owner${cls ? ' ' + cls : ''}" title="${esc(`Owner: ${o.name} — ${o.src}`)}">${esc(o.name)}</span>`;
  }

  // The filter. Empty is everyone. A station matches when any of its parties
  // was picked, or it has no owner on record and that was; a finding matches
  // through its station, or its repeater — itself a station with an owner. A
  // finding about a receiver, an address or the whole network belongs to no
  // owner, and is set aside while the filter is on (the note under the status
  // line says so, and the sections about the network below stay whole).
  const filtering = () => H.owners.size > 0;
  function stationMatches(st) {
    if (!filtering()) return true;
    const o = ownerOf(st);
    if (o) return o.parties.some(p => H.owners.has(p));
    return ownersReady() && H.owners.has(NO_OWNER);
  }
  function findingMatches(f) {
    if (!filtering()) return true;
    const st = f.stationId ? stationById(f.stationId) : f.repeaterId ? stationById(f.repeaterId) : null;
    return !!st && stationMatches(st);
  }
  const ownedFindings = () => (H.A ? (filtering() ? H.A.findings.filter(findingMatches) : H.A.findings) : []);
  const ownedStations = () => (H.A ? [...H.A.stations.values()].filter(S => stationMatches(S.st)) : []);

  function sevHtml(sev) {
    const s = SEV[sev] || SEV.info;
    return `<span class="hl-sev ${s.cls}"><span aria-hidden="true">${s.icon}</span> <span class="hl-sev-word">${esc(s.label)}</span></span>`;
  }

  // ── fetching ───────────────────────────────────────────────────────────────

  function windowMs() { return (WINDOWS.find(w => w[0] === H.win) || WINDOWS[1])[2] * DAY; }

  // Every stored reading in [t0, t1): twelve-hour chunks, each paged in
  // reading-time order on the primary key (addr, reading_ts, value_raw) so an
  // offset means the same thing on every page, four chunks at a time. A short
  // page ends a chunk. Shared with the Reception Map, which asks for fewer
  // columns and ALERT frames only (`select`, `where`); `alive()` turning false
  // stops it (a newer fetch has superseded it), `onPage(n)` hears the total.
  async function fetchReadings(t0, t1, opts) {
    const o = opts || {};
    const select = o.select || SELECT, where = o.where || '', alive = o.alive || (() => true);
    const chunks = [];
    for (let a = t0; a < t1; a += CHUNK_MS) chunks.push([a, Math.min(t1, a + CHUNK_MS)]);
    const out = [];
    let next = 0, capped = false;
    const iso = t => encodeURIComponent(new Date(t).toISOString());
    const worker = async () => {
      while (next < chunks.length) {
        const [a, b] = chunks[next++];
        for (let off = 0; ; off += PAGE) {
          if (!alive() || capped) return;
          const page = await dbSelect(`reading?select=${select}&reading_ts=gte.${iso(a)}&reading_ts=lt.${iso(b)}${where}`
            + `&order=reading_ts.asc,addr.asc,value_raw.asc&limit=${PAGE}&offset=${off}`);
          out.push(...page);
          if (o.onPage) o.onPage(out.length);
          if (out.length >= MAX_ROWS) { capped = true; return; }
          if (page.length < PAGE) break;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return { rows: out, capped };
  }
  async function fetchWindow(t0, t1, seq) {
    const got = await fetchReadings(t0, t1, {
      alive: () => H.seq === seq,
      onPage: n => { H.fetched = n; renderStatus(); },
    });
    if (got.capped) H.capped = true;
    return got.rows;
  }

  // What the server last found, asked for alongside the readings: two small
  // reads, so it is on the screen while the week is still arriving.
  async function loadServer() {
    try {
      const [runs, open] = await Promise.all([
        dbSelect('health_refresh?select=at&source=eq.stations'),
        dbSelect('health_finding?select=kind,subject,station_id,severity,title,first_seen&source=eq.stations&cleared_at=is.null&limit=500'),
      ]);
      H.server = { at: runs[0] ? Date.parse(runs[0].at) : null, findings: open };
    } catch (_) {
      H.server = { missing: true };
    }
    renderStatus();
  }

  async function run() {
    const seq = ++H.seq;
    loadServer();
    const t1 = Date.now(), t0 = t1 - windowMs();
    H.loading = true; H.error = ''; H.fetched = 0; H.capped = false; H.demo = false;
    renderStatus();
    let rows;
    try {
      rows = await fetchWindow(t0, t1, seq);
    } catch (err) {
      if (H.seq !== seq) return;
      H.loading = false;
      H.error = `Could not read the datastore — ${(err && err.message) || err}. `
              + `${dbHostLabel()} may be unreachable or asleep; readings need no sign-in, so this is the connection. `
              + 'Demo week shows what the tab does with a week whose faults are known.';
      renderStatus();
      return;
    }
    if (H.seq !== seq) return;
    adopt(rows, { t0, t1, now: t1 });
  }

  // The seed door — rows in exactly the shape meganet.reading returns them,
  // for the demo week, the tests and working offline. A table the tests can
  // fill is a table the app can fill (the Message Log's adoptRows, likewise).
  function adopt(rows, win) {
    H.seq++;                       // whatever fetch is still in flight is superseded
    H.rows = Array.isArray(rows) ? rows : [];
    H.error = '';
    H.t0 = win && win.t0 != null ? win.t0 : null;
    H.t1 = win && win.t1 != null ? win.t1 : null;
    H.loading = false;
    H.at = Date.now();
    renderStatus('Working it out…');
    // A frame for the status line to paint before the analysis takes the
    // thread for a few hundred milliseconds.
    setTimeout(() => {
      try {
        H.A = HealthAnalysis.run(H.rows, { t0: H.t0, t1: H.t1, now: win && win.now != null ? win.now : Date.now() });
      } catch (err) {
        H.A = null;
        H.error = 'The analysis failed: ' + ((err && err.message) || err) + '. The readings are fine — this is a bug, and the bug report button will carry it.';
        if (typeof recordError === 'function') recordError({ kind: 'health', message: H.error, where: '', stack: (err && err.stack) || '' });
      }
      if (H.sel && (!H.A || !H.A.stations.has(H.sel))) { H.sel = null; H.lens = null; }
      // One that was not heard in the last window is looked for again in this
      // one — a longer window, pressed from the panel that said so.
      if (H.missing && !H.want) H.want = { id: H.missing, part: null };
      // A station another tab asked for lands now that there is an analysis
      // to find it in: picked before the page is drawn, so it is drawn once.
      const landing = takeWant();
      rerender();
      if (landing) { focusPart(landing.part); syncRoute(); }
      if (H.A && !H.demo) announce(`Station health worked out from ${H.rows.length.toLocaleString()} readings: ${H.A.counts.attention} need attention.`);
      if (typeof HealthAgent !== 'undefined' && HealthAgent.dataChanged) HealthAgent.dataChanged();
    }, 30);
  }

  function demo() {
    const w = HealthAnalysis.demoWorld();
    H.seq++;                       // a fetch still in flight must not land over it
    H.demo = true;
    H.sel = null; H.lens = null; H.want = null; H.missing = null;
    adopt(w.rows, { t0: w.t0, t1: w.t1, now: w.now });
  }

  // ── rendering: the page ────────────────────────────────────────────────────

  function render() {
    return `
    <div class="page hl-page" style="--page-max:1400px">
      <section class="panel" aria-labelledby="hl-h">
        <div class="panel-header">
          <h2 id="hl-h">Station Health</h2>
          <div class="button-group hl-tools">
            <span class="hl-seg" role="group" aria-label="How far back">
              ${WINDOWS.map(([k, label]) => `
              <button class="hl-chip${H.win === k ? ' hl-chip--on' : ''}" aria-pressed="${H.win === k}"
                      onclick="Health.setWin('${k}')">${esc(label)}</button>`).join('')}
            </span>
            <span id="hl-ownpick-wrap">${ownerPickHtml()}</span>
            <button onclick="Health.refresh()" title="Fetch the window again and work it out afresh">Refresh</button>
            <button class="ghost" onclick="Health.demo()" title="A made-up week of real stations with one of every fault planted in it — what each finding looks like">Demo week</button>
            <button class="ghost" onclick="Health.exportCsv()" title="Every finding, with its evidence and the station's owner, as a spreadsheet — only the owners picked, while the owner filter is on">Export findings</button>
          </div>
        </div>
        <p class="sub hl-sub">What the readings say about each field station and the network carrying them — learned check schedules
          and the checks that went missing, batteries across their solar day, rain gauges and levels against their neighbours,
          receivers and repeaters that went quiet, stored readings that are corrupted copies rather than data, and which stations' checks
          land on top of each other — with the check time or repeater delay to change.
          A missed check only counts against a station when a receiver that hears it was listening at the time.</p>
        <div id="hl-status" class="small hl-status" role="status">${statusHtml()}</div>
        <div id="hl-ownnote" class="small hl-ownnote">${ownNoteHtml()}</div>
        <div id="hl-kpis">${kpisHtml()}</div>
      </section>
      <div id="hl-body">${bodyHtml()}</div>
    </div>`;
  }

  function bodyHtml() {
    if (!H.A) return '';
    return `
      <div class="hl-grid">
        <section class="panel hl-attn" aria-labelledby="hl-h-attn">
          <div class="panel-header"><h3 id="hl-h-attn">Needs attention</h3>
            <span class="small">${esc(attnCountText())}</span></div>
          ${filtersHtml()}
          <div id="hl-findings">${findingsHtml()}</div>
        </section>
        <section class="panel hl-mapcard" aria-labelledby="hl-h-map">
          <div class="panel-header"><h3 id="hl-h-map">Where</h3>
            <span class="small">every station heard, by its worst finding</span></div>
          <div id="hl-map" class="hl-map" role="region" aria-label="Map of the stations heard, coloured by their worst finding"></div>
          ${mapLegendHtml()}
        </section>
      </div>
      <section class="panel" id="hl-station" aria-labelledby="hl-h-stn">${stationHtml()}</section>
      <section class="panel" aria-labelledby="hl-h-checks">${matrixHtml()}</section>
      <section class="panel" id="hl-airtime" aria-labelledby="hl-h-air">${typeof HealthAirtime !== 'undefined' ? HealthAirtime.render() : ''}</section>
      <section class="panel" aria-labelledby="hl-h-net">${networkHtml()}</section>
      <section class="panel" aria-labelledby="hl-h-reg">${registerHtml()}</section>
      <section class="panel" id="hl-agent" aria-labelledby="hl-h-agent">${typeof HealthAgent !== 'undefined' ? HealthAgent.render() : ''}</section>`;
  }

  // The server's last look, in a sentence: while the week loads, what it found
  // (the answer, before this tab has worked it out); after, how fresh it is —
  // and when its schedule has stopped, that it has.
  const SERVER_LATE = 45 * MIN;
  function serverHtml() {
    const S = H.server;
    if (H.demo || !S || S.missing || S.at == null) return '';
    const ago = esc(fmtAgo(S.at));
    if (H.loading) {
      const worst = S.findings.filter(f => f.severity !== 'info')
        .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
      if (!worst.length) return ` Meanwhile, the server's last look (${ago}) found nothing that needs attention.`;
      const crit = worst.filter(f => f.severity === 'critical').length;
      const named = worst.slice(0, 4).map(f => {
        const st = f.station_id ? stationById(f.station_id) : null;
        return esc((st ? st.name + ': ' : '') + f.title);
      });
      return ` Meanwhile, the server's last look (${ago}): ${num(crit)} critical, ${num(worst.length - crit)} warning${worst.length - crit === 1 ? '' : 's'} — `
        + named.join('; ') + (worst.length > named.length ? `; and ${num(worst.length - named.length)} more` : '') + '.';
    }
    return Date.now() - S.at > SERVER_LATE
      ? ` <span class="txt-warn">The server has not looked since ${esc(fmtWhen(S.at))} — its every-fifteen-minutes check may have stopped, and nothing is being noticed while this tab is closed.</span>`
      : ` The server looks every fifteen minutes too; last ${ago}.`;
  }

  function statusHtml(msg) {
    if (msg) return esc(msg);
    if (H.error) return `<span class="txt-bad">${esc(H.error)}</span>`;
    if (H.loading) return `Fetching readings from ${esc(dbHostLabel())}… ${H.fetched ? `${H.fetched.toLocaleString()} so far.` : ''}${serverHtml()}`;
    if (!H.rows) return 'Nothing fetched yet.';
    const span = H.t0 != null ? `${fmtTs(H.t0)} to ${fmtTs(H.t1)}` : 'the readings given';
    const src = H.demo ? '<strong>Demo week</strong> — made-up readings of real stations, with one of every fault planted' : esc(dbHostLabel());
    return `${num(H.rows.length)} readings, ${esc(span)}, from ${src}. Worked out ${esc(fmtAgo(H.at))}.`
      + (H.capped ? ` <span class="txt-warn">Stopped at ${num(MAX_ROWS)} readings — pick a shorter window for the rest.</span>` : '')
      + serverHtml();
  }
  function renderStatus(msg) {
    const el = document.getElementById('hl-status');
    if (el && state.activeTab === 'health') el.innerHTML = statusHtml(msg);
  }

  function kpisHtml() {
    const A = H.A;
    if (!A) return '';
    // Under the owner filter the station counts are the picked owners'
    // stations'; corrupted copies and receivers are the network's, and say so.
    const own = filtering();
    const F = ownedFindings();
    let c = A.counts;
    if (own) {
      const sch = ownedStations().filter(S => S.schedule);
      c = Object.assign({}, c, {
        stationsHeard: ownedStations().length, scheduled: sch.length,
        checksDue: sch.reduce((n, S) => n + S.schedule.counts.due, 0),
        checksReceived: sch.reduce((n, S) => n + S.schedule.counts.hits + S.schedule.counts.partial, 0),
        attention: F.filter(f => f.severity !== 'info').length,
      });
    }
    const chip = (k, v, sub, cls) => `<div class="qs-chip${cls ? ' ' + cls : ''}"><span class="qs-chip-k">${esc(k)}</span>`
      + `<span class="qs-chip-v">${v}</span>${sub ? `<span class="qs-chip-k">${sub}</span>` : ''}</div>`;
    const pct = c.checksDue ? Math.round(100 * c.checksReceived / c.checksDue) : null;
    const silent = F.filter(f => f.kind === 'silent').length;
    const power = F.filter(f => f.category === 'power' && f.severity !== 'info').length;
    const rxDown = A.findings.filter(f => f.kind === 'receiver-silent' && f.severity !== 'info').length;
    return `<div class="qs-status hl-kpis">
      ${chip('Stations heard', num(c.stationsHeard), `${num(c.scheduled)} on a learned schedule`)}
      ${chip('Checks received', pct == null ? '—' : pct + '%', `${num(c.checksReceived)} of ${num(c.checksDue)} due`, pct != null && pct < 80 ? 'warn' : '')}
      ${chip('Need attention', num(c.attention), 'critical and warnings', c.attention ? 'warn' : '')}
      ${chip('Silent now', num(silent), 'stations', silent ? 'bad' : '')}
      ${chip('Power', num(power), 'battery findings', power ? 'warn' : '')}
      ${chip('Corrupted copies', num(c.corrupted + c.ghosts), own ? 'whole network' : `${num(c.ghosts)} under the wrong address`, '')}
      ${chip('Receivers', num(c.receivers), (rxDown ? `${rxDown} stopped` : 'delivering') + (own ? ' · whole network' : ''), rxDown ? 'bad' : '')}
    </div>`;
  }

  // ── the owner filter ───────────────────────────────────────────────────────
  // A button in the header beside the window, opening a list of every owner
  // with a station heard in the window — how many it has, and how many of
  // those need attention — to tick. It narrows the KPIs, Needs attention, the
  // map and Check signals; the receivers, repeaters and register stay the
  // network's, because a receiver going quiet is everybody's problem.

  function ownerSumHtml() {
    const n = H.owners.size;
    const one = n === 1 ? [...H.owners][0] : '';
    const label = n === 0 ? 'All owners' : n === 1 ? (one === NO_OWNER ? 'No owner on record' : one) : `${n} owners`;
    return `<span class="hl-ownpick-k">Owner:</span> <span class="hl-ownpick-v">${esc(label)}</span> <span aria-hidden="true">▾</span>`;
  }
  function ownerPickHtml() {
    return `<details class="hl-ownpick${filtering() ? ' hl-ownpick--on' : ''}" id="hl-ownpick">
      <summary id="hl-ownpick-sum" title="Show only the stations of the owners picked — remembered on this device">${ownerSumHtml()}</summary>
      <div class="hl-ownpick-pop" id="hl-ownpick-pop" role="group" aria-label="Station owners to show">${ownerListHtml()}</div>
    </details>`;
  }

  // Each owner party with a station heard: how many, and how many of them
  // with a critical finding or a warning. A party picked but not heard this
  // window stays listed, at nought, so it can be unpicked.
  function ownerTally() {
    const m = new Map();
    if (H.A) {
      H.A.stations.forEach(S => {
        const o = ownerOf(S.st);
        const parties = o ? o.parties : ownersReady() ? [NO_OWNER] : [];
        parties.forEach(p => {
          const t = m.get(p) || { n: 0, attn: 0 };
          t.n++;
          if (S.status === 'critical' || S.status === 'warn') t.attn++;
          m.set(p, t);
        });
      });
    }
    H.owners.forEach(p => { if (!m.has(p)) m.set(p, { n: 0, attn: 0 }); });
    return m;
  }
  function ownerListHtml() {
    if (!H.A) return '<p class="small hl-empty">The owners are listed once the readings are worked out.</p>';
    const list = [...ownerTally().entries()]
      .sort((a, b) => ((a[0] === NO_OWNER) - (b[0] === NO_OWNER)) || (b[1].n - a[1].n) || a[0].localeCompare(b[0]));
    const note = !ownersReady()
      ? '<p class="small txt-muted">Looking up owners in the Bureau’s Service Level Specification…</p>'
      : H.slsFailed ? '<p class="small txt-warn">The Service Level Specification file did not load, so only the owners recorded on stations are here.</p>' : '';
    return `
      <div class="hl-ownpick-head">
        <button type="button" class="hl-chip hl-chip--sm" onclick="Health.clearOwners()">All owners</button>
        ${list.length > 8 ? '<input type="search" class="hl-ownpick-find" placeholder="Find an owner" aria-label="Find an owner" oninput="Health.findOwner(this.value)">' : ''}
      </div>
      ${note}
      <p class="small txt-muted hl-ownpick-key">stations heard · <span aria-hidden="true">⚠</span> of them needing attention</p>
      <div class="hl-ownpick-list">${list.map(([p, t]) => `
        <label class="hl-check hl-ownpick-row" data-find="${esc(p.toLowerCase())}">
          <input type="checkbox" data-party="${esc(p)}" ${H.owners.has(p) ? 'checked' : ''} onchange="Health.setOwner(this.dataset.party, this.checked)">
          <span class="hl-ownpick-name">${esc(p === NO_OWNER ? 'No owner on record' : p)}</span>
          <span class="hl-count">${num(t.n)}${t.attn ? ` · <span class="txt-warn"><span aria-hidden="true">⚠</span><span class="sr-only">needing attention:</span> ${num(t.attn)}</span>` : ''}</span>
        </label>`).join('') || '<p class="small hl-empty">No station heard in the window.</p>'}</div>`;
  }

  // Under the status line while the filter is on: what is shown, and what is not.
  function ownNoteHtml() {
    if (!filtering() || !H.A) return '';
    const names = [...H.owners].map(p => (p === NO_OWNER ? 'no owner on record' : p));
    const shown = ownedStations().length;
    return `Showing the stations of <b>${esc(names.join(', '))}</b>: ${num(shown)} of ${num(H.A.stations.size)} heard, and their findings.
      Receivers, repeaters and the register below are the whole network’s.
      <button class="link-btn" onclick="Health.clearOwners()">Show every owner</button>`;
  }

  function ownerFactHtml(st) {
    const o = ownerOf(st);
    if (o) return `${esc(o.name)} <span class="small txt-muted">(${esc(o.src)})</span>`;
    if (!ownersReady()) return '<span class="small txt-muted">looking it up in the Bureau’s Service Level Specification…</span>';
    return `<span class="small txt-muted">none on record${H.slsFailed ? ' — the Service Level Specification file, where most owners come from, did not load' : ''}</span>`;
  }

  // Everything the filter narrows, painted again in place — not the header,
  // so the list stays open and the keyboard stays on the box just ticked.
  // `all` also repaints the list and the open station, for when the owners
  // themselves have changed (the SLS file landing).
  function repaintOwned(all) {
    if (state.activeTab !== 'health' || !H.A) return;
    const pick = document.getElementById('hl-ownpick');
    if (pick) pick.classList.toggle('hl-ownpick--on', filtering());
    const sum = document.getElementById('hl-ownpick-sum');
    if (sum) sum.innerHTML = ownerSumHtml();
    if (all) { const pop = document.getElementById('hl-ownpick-pop'); if (pop) pop.innerHTML = ownerListHtml(); }
    const note = document.getElementById('hl-ownnote');
    if (note) note.innerHTML = ownNoteHtml();
    const k = document.getElementById('hl-kpis');
    if (k) k.innerHTML = kpisHtml();
    rerenderAttn();
    const sec = document.querySelector('[aria-labelledby="hl-h-checks"]');
    if (sec) sec.innerHTML = matrixHtml();
    if (all) rerenderStation(); else drawMap();
  }
  function saveOwners() {
    try { localStorage.setItem('mn-hl-owners', JSON.stringify([...H.owners])); } catch (_) {}
  }
  function setOwner(p, on) {
    if (!p) return;
    if (on) H.owners.add(p); else H.owners.delete(p);
    document.querySelectorAll('#hl-ownpick-pop input[data-party]').forEach(c => { if (c.dataset.party === p) c.checked = !!on; });
    saveOwners();
    repaintOwned(false);
    announce(filtering() ? `Showing the stations of ${H.owners.size} owner${H.owners.size === 1 ? '' : 's'}: ${ownedStations().length} heard.` : 'Showing every owner.');
  }
  function clearOwners() {
    H.owners.clear();
    saveOwners();
    document.querySelectorAll('#hl-ownpick-pop input[type="checkbox"]').forEach(c => { c.checked = false; });
    repaintOwned(false);
    announce('Showing every owner.');
  }
  function findOwner(q) {
    const t = String(q || '').trim().toLowerCase();
    document.querySelectorAll('#hl-ownpick-pop .hl-ownpick-row').forEach(el => { el.hidden = !!t && !el.dataset.find.includes(t); });
  }
  // Most owners are in the SLS file, which nothing fetches until it is asked
  // for; this tab asks when it opens, and repaints what the owners touch when
  // the answer (or the failure) comes back.
  function askOwners() {
    if (typeof SLS === 'undefined' || SLS.loaded() || H.slsAsked) return;
    H.slsAsked = true;
    SLS.ensureData().then(() => repaintOwned(true), () => { H.slsFailed = true; repaintOwned(true); });
  }

  // ── needs attention ────────────────────────────────────────────────────────

  function visibleFindings() {
    if (!H.A) return [];
    return ownedFindings().filter(f => (H.showInfo || f.severity !== 'info') && (H.cat === 'all' || f.category === H.cat));
  }
  function attnCountText() {
    const F = ownedFindings();
    const crit = F.filter(f => f.severity === 'critical').length;
    const warn = F.filter(f => f.severity === 'warn').length;
    const info = F.filter(f => f.severity === 'info').length;
    return `${crit} critical · ${warn} warnings · ${info} notes`;
  }

  function filtersHtml() {
    const counts = new Map();
    ownedFindings().forEach(f => { if (H.showInfo || f.severity !== 'info') counts.set(f.category, (counts.get(f.category) || 0) + 1); });
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return `<div class="hl-filters">
      <span class="hl-seg hl-seg--wrap" role="group" aria-label="Which kind of finding">
        ${CATS.map(([k, label]) => {
          const n = k === 'all' ? total : (counts.get(k) || 0);
          if (k !== 'all' && !n) return '';
          return `<button class="hl-chip${H.cat === k ? ' hl-chip--on' : ''}" aria-pressed="${H.cat === k}"
                    onclick="Health.setCat('${k}')">${esc(label)} <span class="hl-count">${n}</span></button>`;
        }).join('')}
      </span>
      <label class="hl-check"><input type="checkbox" ${H.showInfo ? 'checked' : ''} onchange="Health.setInfo(this.checked)">
        include notes</label>
    </div>`;
  }

  // Where a finding is: the station, the receiver, the repeater, the address.
  function whereHtml(f) {
    if (f.stationId && H.A.stations.has(f.stationId)) {
      return `<button class="link-btn" onclick="Health.select('${escAttr(f.stationId)}')"
                title="Open ${escAttr(f.station || '')} below — its checks, battery, sensors and the context lens">${esc(f.station || f.stationId)}</button>${ownerSmallHtml(stationById(f.stationId))}`;
    }
    if (f.host) return `<span class="mono small" title="${escAttr(f.host)}">${esc(hostLabel(f.host))}</span>`;
    if (f.repeaterId) {
      const st = stationById(f.repeaterId);
      return st ? `<button class="link-btn" onclick="goToStation('${escAttr(st.id)}')" title="The repeater on the Stations tab">${esc(st.name)}</button>${ownerSmallHtml(st)}` : esc(f.repeaterId);
    }
    if (f.addr) return `<span class="mono">${esc(f.addr)}</span>`;
    return '<span class="small txt-muted">network</span>';
  }

  // Findings about corrupted copies, which the Reception Map weighs further.
  const RX_KINDS = new Set(['repeater-bitflips', 'corrupt-copies', 'ghosts']);

  function findingsHtml() {
    const list = visibleFindings();
    if (!list.length) {
      return `<p class="small hl-empty">${filtering() && !ownedFindings().length
        ? 'Nothing found at the stations of the owners picked — or none of them was heard in the window.'
        : H.A.findings.length
        ? 'Nothing here at this level — tick “include notes” or pick another kind.'
        : 'Nothing found — every station heard is checking in, and nothing in the readings looks wrong.'}</p>`;
    }
    const rows = list.slice(0, 400).map((f, i) => `
      <tr class="hl-frow hl-frow--${f.severity}">
        <td>${sevHtml(f.severity)}</td>
        <th scope="row" class="hl-fwhere">${whereHtml(f)}</th>
        <td class="hl-fwhat"><b>${esc(f.title)}</b>
          <span class="small hl-fdetail">${esc(f.detail)}</span>
          ${f.action ? `<span class="small hl-faction"><span aria-hidden="true">→</span> ${esc(f.action)}</span>` : ''}
          ${RX_KINDS.has(f.kind) ? `<span class="small hl-faction"><button class="link-btn" onclick="Health.openReception('${escAttr(f.repeaterId || '')}')">Weigh the copies on the Reception Map</button></span>` : ''}</td>
        <td class="small hl-fsince col-optional">${f.since ? esc(fmtWhen(f.since)) : ''}</td>
      </tr>`).join('');
    return `
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="hl-h-attn">
        <table class="hl-table hl-ftable">
          <caption class="sr-only">Findings, worst first: how bad, where, what and what to do, and since when</caption>
          <colgroup><col style="width:7.5rem"><col style="width:22%"><col><col class="col-optional"></colgroup>
          <thead><tr><th scope="col">How bad</th><th scope="col">Where</th><th scope="col">What, and what to do</th><th scope="col" class="col-optional">Since</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${list.length > 400 ? `<p class="small">The first 400 of ${num(list.length)} — Export findings has them all.</p>` : ''}`;
  }

  // ── the map ────────────────────────────────────────────────────────────────

  const MAP_STATUS = [
    ['critical', 'Critical'],
    ['warn', 'Warning'],
    ['info', 'Notes only'],
    ['ok', 'Nothing found'],
    ['irregular', 'No schedule learned'],
  ];
  function mapLegendHtml() {
    return `<div class="qs-legend hl-legend">
      ${MAP_STATUS.map(([k, label]) => `<span><i class="hl-dot hl-dot--${k}" aria-hidden="true"></i>${esc(label)}</span>`).join('')}
      <span><i class="hl-ring" aria-hidden="true"></i>where a receiver hears</span>
    </div>
    <p class="qs-hint">Bigger is worse. A station's pin opens it below; the same stations are in Needs attention and in Check signals, for a keyboard.</p>`;
  }

  function statusColour(st) {
    return { critical: cssVar('--bad', '#c7401a'), warn: cssVar('--warn', '#9e5e00'), info: cssVar('--accent', '#0b5cab'),
             ok: cssVar('--ok', '#107c10'), irregular: cssVar('--muted', '#4f6478') }[st] || cssVar('--muted', '#4f6478');
  }

  function drawMap() {
    stopMap();
    const el = document.getElementById('hl-map');
    if (!el || typeof L === 'undefined' || !H.A) return;
    const map = H.map = L.map('hl-map', { zoomControl: true });
    registerLiveMap('Health', () => H.map);
    map.setView(MAP_HOME, 4);
    addBaseLayers(map);
    const layer = H.layer = L.layerGroup().addTo(map);
    const pts = [];
    const rank = { critical: 0, warn: 1, info: 2, ok: 3, irregular: 4 };
    const list = [...H.A.stations.values()].filter(S => S.st.lat != null && S.st.lon != null && (S.st.id === H.sel || stationMatches(S.st)))
      .sort((a, b) => rank[b.status] - rank[a.status]);
    list.forEach(S => {
      const r = { critical: 9, warn: 7, info: 5, ok: 5, irregular: 4 }[S.status] || 4;
      const sel = H.sel === S.st.id;
      const own = ownerOf(S.st);
      L.circleMarker([S.st.lat, S.st.lon], {
        radius: sel ? r + 3 : r, color: sel ? cssVar('--text', '#16202a') : cssVar('--panel', '#fff'), weight: sel ? 3 : 2,
        fillColor: statusColour(S.status), fillOpacity: 0.95,
      })
        .bindTooltip(`${esc(S.st.name)}${own ? ` · ${esc(own.name)}` : ''} — ${esc((S.findings[0] && S.findings[0].title) || (S.status === 'irregular' ? 'no schedule learned' : 'nothing found'))}`)
        .on('click', () => select(S.st.id))
        .addTo(layer);
      pts.push([S.st.lat, S.st.lon]);
    });
    // Where each receiver hears: the median of the stations only it can hear.
    const centres = H.A.resolveRow && H.A.resolveRow.centres;
    if (centres) {
      centres.forEach((c, host) => {
        if (!c) return;
        L.circleMarker([c.lat, c.lon], { radius: 14, color: cssVar('--accent', '#0b5cab'), weight: 2, fill: false, dashArray: '5 4' })
          .bindTooltip(`${esc(host)} hears around here (the middle of ${c.n} addresses only one station carries)`)
          .addTo(layer);
      });
    }
    if (pts.length) { const b = L.latLngBounds(pts); if (pts.length === 1) map.setView(b.getCenter(), 10); else map.fitBounds(b.pad(0.08)); }
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 0);
  }
  function stopMap() { H.map = removeMap(H.map); H.layer = null; }

  // ── one station ────────────────────────────────────────────────────────────

  function stationHtml() {
    const S = H.sel && H.A && H.A.stations.get(H.sel);
    // Asked for from another tab, and not in this window: said, with the way
    // to a longer one and back to the station, rather than the placeholder.
    const gone = !S && H.missing && H.A ? stationById(H.missing) : null;
    if (gone) {
      const w = WINDOWS.find(x => x[0] === H.win);
      const longer = WINDOWS.filter(x => x[2] > (w ? w[2] : 7));
      return `<div class="panel-header"><h3 id="hl-h-stn">${esc(gone.name)}</h3>
          <span class="hl-sev txt-muted"><span aria-hidden="true">○</span> Not heard in this window</span></div>
        <p class="small">Nothing from ${esc(gone.name)} in ${H.demo ? 'the demo week' : `the last ${esc(w ? w[1] : 'window')}`}, so there is
          nothing here to work out. Its card on the Stations tab says when Flood-Net last heard it${longer.length && !H.demo
            ? `, and a longer window may reach back to it` : ''}.</p>
        <div class="button-group hl-stn-links">
          ${!H.demo ? longer.map(([k, label]) => `<button class="ghost" onclick="Health.setWin('${k}')">Look back ${esc(label)}</button>`).join('') : ''}
          <button class="ghost" onclick="goToStation('${escAttr(gone.id)}')">Show on the Stations tab</button>
          <button class="ghost" onclick="Health.close()">Close</button>
        </div>`;
    }
    if (!S) {
      return `<div class="panel-header"><h3 id="hl-h-stn">A station</h3></div>
        <p class="small hl-empty">Pick a station — from Needs attention, the map, or Check signals — to see its check schedule slot by slot,
          its battery across its solar day, its sensors, and what the rest of the network was doing at any moment you pick.</p>`;
    }
    const st = S.st, sch = S.schedule;
    const worst = S.findings.length ? sevHtml(S.findings.reduce((w, f) => (f.severity === 'critical' || (f.severity === 'warn' && w.severity === 'info') ? f : w), S.findings[0]).severity) : '<span class="hl-sev txt-ok"><span aria-hidden="true">✓</span> Nothing found</span>';
    const facts = [];
    facts.push(['Station', `${esc(st.station_number || '—')} · ALERT ${esc(stationAlertIds(st).join(', ') || '—')}`]);
    facts.push(['Owner', ownerFactHtml(st)]);
    facts.push(['Checks', sch
      ? `every ${esc(HealthAnalysis.fmtPeriod(sch.P))}, at ${esc(phaseText(sch))} — ${num(sch.counts.hits)} received, ${num(sch.counts.partial)} with frames lost, ${num(sch.counts.misses)} missed${sch.counts.net ? `, ${num(sch.counts.net)} missed network-wide` : ''}${sch.counts.unknown ? `, ${num(sch.counts.unknown)} when nothing that hears it was listening` : ''}`
      : `no regular schedule learned from ${num(S.bursts.length)} report${S.bursts.length === 1 ? '' : 's'} — it may report on events only`]);
    facts.push(['Last heard', `${esc(fmtWhen(S.lastHeard))} (${esc(fmtAgo(S.lastHeard))})`]);
    facts.push(['Heard by', esc((S.paths || []).join(', ') || [...S.hosts].join(', '))]);
    return `
      <div class="panel-header"><h3 id="hl-h-stn">${esc(st.name)}</h3>${worst}</div>
      <dl class="hl-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
        <div><dt>Last visit</dt><dd id="hl-insp">${inspHtml(st.id)}</dd></div></dl>
      <div class="button-group hl-stn-links">
        <button class="ghost" onclick="goToStation('${escAttr(st.id)}')">Show on the Stations tab</button>
        <button class="ghost" onclick="Health.openLog('${escAttr(st.id)}')" title="This station's readings in the window, in the Message Log">Its readings in the Message Log</button>
        <button class="ghost" onclick="Health.openField('${escAttr(st.id)}')" title="Chart its sensors on the Field Data tab">Chart on Field Data</button>
        <button class="ghost" onclick="Health.close()">Close</button>
      </div>
      ${S.findings.length ? `<h4 id="hl-h-stnf">Findings</h4><ul class="hl-flist">${S.findings.map(f => `<li>${sevHtml(f.severity)} <b>${esc(f.title)}</b>
        <span class="small">${esc(f.detail)}</span>${f.action ? ` <span class="small hl-faction"><span aria-hidden="true">→</span> ${esc(f.action)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${sch ? stripHtml(S) : ''}
      <div id="hl-lens">${lensHtml()}</div>
      ${S.battery ? batteryHtml(S) : ''}
      ${S.rain ? rainHtml(S) : ''}
      ${S.level ? levelHtml(S) : ''}
      ${sensorsHtml(S)}
      ${recentHtml(S)}`;
  }

  function phaseText(sch) {
    // The slot times of one day, from the phase: "01:41, 04:41, 07:41 …".
    const out = [];
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const base = day0.getTime();
    let s = sch.phase + Math.ceil((base - sch.phase) / sch.P) * sch.P;
    for (; s < base + DAY && out.length < 4; s += sch.P) out.push(fmtHm(s));
    return out.join(', ') + (DAY / sch.P > 4 ? ' …' : '');
  }

  // Its checks, slot by slot, a row a day: the shape of a station's week at a
  // glance — a column of misses at the same hour every night is a battery, a
  // run of misses is an outage, scattered ones are a path.
  function stripHtml(S) {
    const slots = S.slots || [];
    if (!slots.length) return '';
    const days = new Map();
    slots.forEach(sl => {
      const d = new Date(sl.t); d.setHours(0, 0, 0, 0);
      const k = d.getTime();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(sl);
    });
    const P = S.schedule.P;
    const perDay = Math.max(1, Math.round(DAY / P));
    const cell = perDay > 48 ? 6 : perDay > 24 ? 9 : 16, gap = 2, labW = 92, rowH = cell + 6;
    const W = labW + perDay * (cell + gap), Hh = days.size * rowH + 4;
    const rows = [...days.entries()].sort((a, b) => a[0] - b[0]);
    let svg = '';
    rows.forEach(([d0, list], r) => {
      const y = 2 + r * rowH;
      svg += `<text class="hl-axis" x="0" y="${y + cell - 2}">${esc(fmtDay(d0))}</text>`;
      list.forEach(sl => {
        const i = Math.min(perDay - 1, Math.floor((sl.t - d0) / P));
        const x = labW + i * (cell + gap);
        const o = OUTCOME[sl.outcome] || OUTCOME.unknown;
        const sel = H.lens && H.lens.kind === 'slot' && Math.abs(H.lens.t - sl.t) < 1000;
        svg += `<rect class="hl-slot ${o.cls}${sel ? ' hl-slot--sel' : ''}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2"
                  data-t="${sl.t}"><title>${esc(fmtWhen(sl.t))} — ${esc(o.label)}${sl.missing && sl.missing.length ? ' (no ' + esc(sl.missing.join(', ')) + ')' : ''}</title></rect>`;
        if (sl.outcome === 'miss') svg += `<path class="hl-slot-x" d="M${x + 3} ${y + 3}L${x + cell - 3} ${y + cell - 3}M${x + cell - 3} ${y + 3}L${x + 3} ${y + cell - 3}"/>`;
      });
    });
    const missed = slots.filter(sl => sl.outcome === 'miss' || sl.outcome === 'partial' || sl.outcome === 'net').slice(-24);
    return `
      <h4 id="hl-h-strip">Its checks, slot by slot</h4>
      <div class="hl-strip-wrap">
        <svg class="hl-strip" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img"
             aria-label="${escAttr(`${S.st.name}: ${slots.length} check slots over the window, a row a day — ${S.schedule.counts.hits} received, ${S.schedule.counts.partial} with frames lost, ${S.schedule.counts.misses} missed`)}"
             onclick="Health.stripClick(event)">${svg}</svg>
      </div>
      <div class="qs-legend">${Object.entries(OUTCOME).map(([k, o]) => `<span><i class="hl-key ${o.cls}" aria-hidden="true"></i>${esc(o.label)}</span>`).join('')}</div>
      ${missed.length ? `<p class="small hl-missed">What was going on at a missed check:
        ${missed.map(sl => `<button class="hl-chip hl-chip--sm" onclick="Health.lensAt('${escAttr(S.st.id)}', ${sl.t}, 'slot')"
          aria-pressed="${!!(H.lens && H.lens.kind === 'slot' && Math.abs(H.lens.t - sl.t) < 1000)}">${esc(fmtWhen(sl.t))}${sl.outcome === 'partial' ? ' (partial)' : sl.outcome === 'net' ? ' (network)' : ''}</button>`).join(' ')}</p>` : ''}`;
  }

  // ── the context lens ──────────────────────────────────────────────────────

  function lensHtml() {
    const L0 = H.lens;
    if (!L0 || !H.A || L0.id !== H.sel) return '';
    const C = L0.kind === 'reading'
      ? HealthAnalysis.readingContext(H.A, L0.id, L0.addr, L0.t)
      : { context: HealthAnalysis.contextAt(H.A, L0.id, L0.t) };
    const X = C && C.context;
    if (!X) return '';
    const verdictCls = { own: 'txt-warn', shared: 'txt-warn', network: 'txt-muted', ok: 'txt-ok', info: 'txt-muted' }[X.verdict.kind] || '';
    const rx = X.receivers;
    const peers = X.peers.slice(0, 14);
    const reading = L0.kind === 'reading' && C.tx ? `
      <div class="hl-lens-reading">
        <b>${esc(SensorValues.kindLabel(C.kind) || 'Reading')} ${esc(String(C.tx.v))}${C.tx.conv && C.tx.conv.value != null ? ` = ${esc(C.tx.conv.text)}` : ''}</b>
        <span class="small">${C.onSlot ? 'part of a scheduled check' : 'off its schedule — an event report'} ·
          heard ${C.tx.copies.length} time${C.tx.copies.length === 1 ? '' : 's'} (${esc([...new Set(C.tx.copies.map(c => c.path))].join(', '))})</span>
        ${C.tx.bad.length ? `<span class="small txt-warn">${C.tx.bad.length} corrupted cop${C.tx.bad.length === 1 ? 'y' : 'ies'} stored beside it: ${C.tx.bad.map(b => `${b.v} (${b.bits} bit${b.bits === 1 ? '' : 's'}, ${b.dtS} s later)`).join(', ')}</span>` : ''}
        <span class="small">Before it: ${C.prev ? `${esc(String(C.prev.v))}${C.prev.conv && C.prev.conv.value != null ? ' = ' + esc(C.prev.conv.text) : ''}, ${esc(HealthAnalysis.fmtSpan(C.prev.dt))} earlier` : 'nothing in the window'}.
          After it: ${C.next ? `${esc(String(C.next.v))}${C.next.conv && C.next.conv.value != null ? ' = ' + esc(C.next.conv.text) : ''}, ${esc(HealthAnalysis.fmtSpan(C.next.dt))} later` : 'nothing yet'}.</span>
      </div>` : '';
    return `
      <div class="panel-sub hl-lens" role="region" aria-labelledby="hl-h-lens">
        <div class="panel-header"><h4 id="hl-h-lens">The network at ${esc(fmtWhen(X.t))}</h4>
          <button class="ghost" onclick="Health.lensClose()">Close</button></div>
        ${reading}
        <p class="${verdictCls}"><b>${esc(X.verdict.text)}</b></p>
        <div class="hl-lens-cols">
          <div>
            <h5 class="hl-h5">Receivers, ${esc(fmtHm(X.from))}–${esc(fmtHm(X.to))}</h5>
            <ul class="hl-plain">${rx.map(r => `<li>${r.binsWithTraffic ? '<span class="txt-ok" aria-hidden="true">●</span>' : '<span class="txt-bad" aria-hidden="true">○</span>'}
              <span class="mono small" title="${escAttr(r.host)}">${esc(hostLabel(r.host))}</span> <span class="small">${r.binsWithTraffic ? `delivering (${r.binsWithTraffic} of ${r.bins} ten-minute spans)` : 'nothing delivered'}</span></li>`).join('') || '<li class="small">None of the receivers that hear it was running then.</li>'}
              ${X.othersDelivering ? `<li class="small txt-muted">and ${X.othersDelivering} other receiver${X.othersDelivering === 1 ? '' : 's'} delivering, which do not hear this station</li>` : ''}</ul>
          </div>
          <div>
            <h5 class="hl-h5">Its neighbours then</h5>
            ${peers.length ? `<ul class="hl-plain">${peers.map(p => `<li>${peerMark(p)} <button class="link-btn" onclick="Health.select('${escAttr(p.id)}')">${esc(p.name)}</button>
              <span class="small">${esc(p.why)} · ${p.down ? 'already down for hours' : p.slot ? `${esc(OUTCOME[p.slot.outcome] ? OUTCOME[p.slot.outcome].label : p.slot.outcome)} at ${esc(fmtHm(p.slot.t))}` : p.heard ? 'heard' : 'nothing due'}</span></li>`).join('')}</ul>`
              : '<p class="small">No station shares a repeater with it or stands within 25 km.</p>'}
          </div>
        </div>
        ${X.mine.length ? `<p class="small">From this station in that half hour: ${X.mine.map(m => `${esc(fmtHm(m.t))} ${esc(m.addr)} = ${esc(String(m.v))}${m.bad.length ? ` (+${m.bad.length} corrupted)` : ''}`).join(' · ')}</p>` : ''}
      </div>`;
  }
  function peerMark(p) {
    if (p.down) return '<span class="txt-muted" aria-label="already down">◌</span>';
    const o = p.slot ? p.slot.outcome : p.heard ? 'hit' : null;
    if (o === 'hit' || o === 'partial') return '<span class="txt-ok" aria-label="checked in">●</span>';
    if (o === 'miss' || o === 'net') return '<span class="txt-bad" aria-label="missed">✕</span>';
    return '<span class="txt-muted" aria-label="nothing due">·</span>';
  }

  // ── the battery ────────────────────────────────────────────────────────────

  // Its voltage over the window, its night-time lows ringed, the trend through
  // those lows, and the two lines that matter: 12.2 V (about half charge at
  // rest) and 11.8 V (where the radio starts to brown out). One series, one
  // axis — the night lows are points of the same series, not a second one.
  //
  // Drawn at the width it is shown at (wireCharts measures the box and draws
  // it again), so its text is the size it says and never stretched: a viewBox
  // scaled to fit a box of another shape stretches its letters with it.
  function batterySummary(B) {
    return [
      B.lastNight != null ? `last night's low ${B.lastNight.toFixed(1)} V` : `latest ${B.latest.V.toFixed(1)} V`,
      B.slope == null ? 'not enough nights for a trend'
        : Math.abs(B.slope) < 0.01 ? 'night lows steady'
        : `night lows ${B.slope > 0 ? 'rising' : 'falling'} ${Math.abs(B.slope).toFixed(2)} V a day`,
      B.swing != null ? `daily charge swing ${B.swing.toFixed(2)} V` : '',
      B.spikes ? `${B.spikes} one-reading spike${B.spikes === 1 ? '' : 's'} left out` : '',
    ].filter(Boolean).join(' · ');
  }

  function batterySvg(S, W) {
    const B = S.battery;
    const pts = B.series || [];
    const Hh = 220, L = 46, R = 12, T = 10, Bm = 26;
    const t0 = H.A.t0, t1 = H.A.t1;
    const vMin = Math.min(11.5, ...pts.map(p => p.V)) - 0.1, vMax = Math.max(14.4, ...pts.map(p => p.V)) + 0.1;
    const x = t => L + (W - L - R) * (t - t0) / (t1 - t0);
    const y = v => T + (Hh - T - Bm) * (1 - (v - vMin) / (vMax - vMin));
    let g = '';
    for (let v = Math.ceil(vMin); v <= vMax; v += 1) {
      g += `<line class="hl-gridline" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`
         + `<text class="hl-axis" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v} V</text>`;
    }
    // A day label every day when there is room for it, every other when not.
    const dayPx = (W - L - R) / ((t1 - t0) / DAY);
    const every = dayPx >= 84 ? 1 : dayPx >= 42 ? 2 : 4;
    let k = 0;
    for (let d = new Date(t0).setHours(0, 0, 0, 0) + DAY; d < t1; d += DAY, k++) {
      g += `<line class="hl-gridline" x1="${x(d).toFixed(1)}" x2="${x(d).toFixed(1)}" y1="${T}" y2="${Hh - Bm}"/>`;
      if (k % every === 0) g += `<text class="hl-axis" x="${(x(d) + 3).toFixed(1)}" y="${Hh - 8}">${esc(fmtDay(d))}</text>`;
    }
    const thr = [[12.2, 'half charge'], [11.8, 'brown-out']].map(([v, label]) => `
      <line class="hl-thr" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="hl-axis" x="${W - R - 4}" y="${(y(v) - 4).toFixed(1)}" text-anchor="end">${v} V ${label}</text>`).join('');
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.V).toFixed(1)}`).join('');
    const dots = (B.nights || []).map(n => `<circle class="hl-night" cx="${x(n.t).toFixed(1)}" cy="${y(n.v).toFixed(1)}" r="4.5"/>`).join('');
    let trend = '';
    if (B.slope != null && B.nights.length >= 3) {
      const tm = B.nights.reduce((a, n) => a + n.t, 0) / B.nights.length;
      const vm = B.nights.reduce((a, n) => a + n.v, 0) / B.nights.length;
      const at = t => vm + B.slope * (t - tm) / DAY;
      const a = B.nights[0].t, b = B.nights[B.nights.length - 1].t;
      trend = `<path class="hl-trend" d="M${x(a).toFixed(1)} ${y(at(a)).toFixed(1)}L${x(b).toFixed(1)} ${y(at(b)).toFixed(1)}"/>`;
    }
    return `<svg class="hl-batt" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" data-w="${W}"
             aria-label="${escAttr(`Battery voltage over the window: ${batterySummary(B)}`)}">${g}${thr}
          <path class="hl-line" d="${line}"/>${trend}${dots}
          <line class="hl-cross" x1="0" x2="0" y1="${T}" y2="${Hh - Bm}" visibility="hidden"/></svg>`;
  }

  function batteryHtml(S) {
    const B = S.battery;
    if ((B.series || []).length < 2) return '';
    return `
      <h4 id="hl-h-batt">Battery — ${esc(`ALERT ${B.aid}`)}</h4>
      <p class="small">${esc(batterySummary(B))}. Night lows (ringed) are the battery at rest before dawn in the station's own solar time — the like-for-like
        measure a trend needs; the daytime peak is the charge coming in.</p>
      <div class="hl-chart" data-chart="batt">${batterySvg(S, 640)}<div class="hl-tip" hidden></div></div>
      <details class="hl-details"><summary>The night lows as a table</summary>
        <div class="table-wrap"><table class="hl-table"><caption class="sr-only">Night-time battery lows</caption>
          <thead><tr><th scope="col">Night of</th><th scope="col">Lowest</th><th scope="col">At</th></tr></thead>
          <tbody>${(B.nights || []).map(n => `<tr><td>${esc(fmtDay(n.t - 12 * HOUR))}</td><td>${n.v.toFixed(1)} V</td><td>${esc(fmtHm(n.t))}</td></tr>`).join('')}</tbody>
        </table></div></details>`;
  }

  // The hover layer for the battery chart: a crosshair that snaps to the
  // nearest reading, and one line of readout. The same values are in the
  // table under it, for a keyboard and a screen reader.
  function wireCharts() {
    document.querySelectorAll('#hl-station .hl-chart[data-chart="batt"]').forEach(box => {
      const S = H.A && H.A.stations.get(H.sel);
      if (!S || !S.battery) return;
      const W = Math.max(280, Math.round(box.clientWidth || 640));
      const old = box.querySelector('svg');
      if (old && Number(old.getAttribute('data-w')) !== W) old.outerHTML = batterySvg(S, W);
      const svg = box.querySelector('svg'), tip = box.querySelector('.hl-tip'), cross = svg.querySelector('.hl-cross');
      const pts = S.battery.series;
      const t0 = H.A.t0, t1 = H.A.t1, L = 46, R = 12;
      svg.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect();
        const t = t0 + (e.clientX - r.left - L) / (W - L - R) * (t1 - t0);
        let best = null;
        pts.forEach(p => { if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; });
        if (!best) return;
        const px = L + (W - L - R) * (best.t - t0) / (t1 - t0);
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
        tip.hidden = false;
        tip.textContent = `${best.V.toFixed(1)} V — ${fmtWhen(best.t)}`;
        tip.style.setProperty('--tip-x', `${Math.min(W - 170, Math.max(0, px + 8))}px`);
      });
      svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
    });
  }

  function rainHtml(S) {
    const R0 = S.rain;
    const nb = (S.rainNeighbours || []).slice().sort((a, b) => a.km - b.km).slice(0, 6);
    const aside = R0.outliers + R0.flips + R0.jumps;
    return `
      <h4>Rain gauge — ALERT ${esc(String(R0.aid))}</h4>
      <p class="small">${R0.mm} mm in the window (${num(R0.tips)} tips × ${R0.mmPerTip} mm${R0.recorded ? '' : ', assumed — no bucket size recorded'})${aside ? `; ${aside} count${aside === 1 ? '' : 's'} set aside as not rain (garbage frames, flipped bits, impossible jumps)` : ''}${R0.resets ? `; the counter went backwards ${R0.resets} time${R0.resets === 1 ? '' : 's'}` : ''}.</p>
      ${nb.length ? `<div class="table-wrap"><table class="hl-table"><caption class="sr-only">Rain at the nearest gauges over the same window</caption>
        <thead><tr><th scope="col">Nearest gauges</th><th scope="col">Distance</th><th scope="col">Rain in the window</th></tr></thead>
        <tbody>${nb.map(n => `<tr><th scope="row"><button class="link-btn" onclick="Health.select('${escAttr(n.id)}')">${esc(n.name)}</button></th><td>${n.km} km</td><td>${n.mm} mm</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="small">No other gauge heard within 30 km to compare it with.</p>'}`;
  }

  function levelHtml(S) {
    const Lv = S.level;
    return `<h4>Water level — ALERT ${esc(String(Lv.aid))}</h4>
      <p class="small">${num(Lv.n)} readings, ${num(Lv.distinct)} distinct values, median ${esc(String(Lv.median))} (raw counts — its scale is set per site and not on file)${Lv.spikes ? `; ${Lv.spikes} one-reading spike${Lv.spikes === 1 ? '' : 's'}` : ''}${Lv.flat ? '; it did not move at all' : ''}.</p>`;
  }

  function sensorsHtml(S) {
    return `
      <h4 id="hl-h-sens">Its sensors</h4>
      <div class="table-wrap"><table class="hl-table">
        <caption class="sr-only">Each address the station reported on in the window</caption>
        <thead><tr><th scope="col">Address</th><th scope="col">Sensor</th><th scope="col">Transmissions</th><th scope="col">Latest</th><th scope="col">Corrupted copies</th><th scope="col">Ghosts it spawned</th></tr></thead>
        <tbody>${S.sensors.map(x => `<tr>
          <th scope="row" class="mono">${esc(x.aid != null ? String(x.aid) : x.addr)}</th>
          <td>${esc((x.types && x.types.length ? x.types[0] : SensorValues.kindLabel(x.kind)) || '—')}</td>
          <td>${num(x.n)}</td>
          <td>${esc(String(x.last.v))}${x.last.conv && x.last.conv.value != null ? ` = ${esc(x.last.conv.text)}` : ''} <span class="small">${esc(fmtWhen(x.last.t))}</span></td>
          <td>${x.bad ? `<span class="txt-warn">${num(x.bad)}</span>` : '0'}</td>
          <td>${num(x.ghosts)}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  // The last readings, each one a door into the lens: the reading against the
  // ones either side of it, its copies, and the network at that moment.
  function recentHtml(S) {
    const txs = S.txs.slice(-60).reverse();
    const kindOf = addr => { const x = S.sensors.find(s => s.addr === addr); return x ? x.kind : null; };
    return `
      <h4 id="hl-h-recent">Its latest transmissions</h4>
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="hl-h-recent">
        <table class="hl-table"><caption class="sr-only">The station's latest transmissions, newest first — open one to see it in context</caption>
          <thead><tr><th scope="col">Heard</th><th scope="col">Sensor</th><th scope="col">Value</th><th scope="col">Copies</th><th scope="col">Corrupted copies</th></tr></thead>
          <tbody>${txs.map(tx => {
            const k = kindOf(tx.addr);
            const conv = SensorValues.convert(k, tx.v, S.st);
            const sel = H.lens && H.lens.kind === 'reading' && H.lens.addr === tx.addr && Math.abs(H.lens.t - tx.t) < 1000;
            return `<tr class="${sel ? 'hl-row--sel' : ''}">
              <td><button class="link-btn mono" onclick="Health.lensAt('${escAttr(S.st.id)}', ${tx.t}, 'reading', '${escAttr(tx.addr)}')"
                    aria-pressed="${sel}" title="This reading in context">${esc(fmtTs(tx.t))}</button></td>
              <td>${esc(SensorValues.kindLabel(k) || tx.addr)}</td>
              <td>${esc(String(tx.v))}${conv && conv.value != null ? ` <span class="small">= ${esc(conv.text)}</span>` : ''}</td>
              <td>${tx.copies.length}</td>
              <td>${tx.bad.length ? `<span class="txt-warn">${tx.bad.map(b => b.x.v).join(', ')}</span>` : ''}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  // ── check signals, every station ───────────────────────────────────────────

  function matrixHtml() {
    const A = H.A;
    const list = [...A.stations.values()].filter(S => S.schedule && S.schedule.daily && stationMatches(S.st));
    const rank = { critical: 0, warn: 1, info: 2, ok: 3, irregular: 4 };
    list.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.schedule.missRate - a.schedule.missRate) || a.st.name.localeCompare(b.st.name));
    const days = [];
    for (let d = new Date(A.t0).setHours(0, 0, 0, 0); d < A.t1; d += DAY) days.push(d);
    const shown = H.matrixAll ? list : list.slice(0, 40);
    const cell = (S, d) => {
      const k = new Date(d);
      const key = `${k.getFullYear()}-${p2(k.getMonth() + 1)}-${p2(k.getDate())}`;
      const x = S.schedule.daily.find(y => y.day === key);
      if (!x) return '<td class="hl-mcell"><span class="sr-only">nothing due</span></td>';
      const due = x.hit + x.partial + x.miss;
      const segs = ['hit', 'partial', 'miss', 'net', 'unknown'].filter(o => x[o])
        .map(o => `<i class="hl-seg-bar ${OUTCOME[o].cls}" style="--w:${x[o]}"></i>`).join('');
      const title = `${fmtDay(d)}: ${x.hit} received, ${x.partial} with frames lost, ${x.miss} missed${x.net ? `, ${x.net} network-wide` : ''}${x.unknown ? `, ${x.unknown} unknown` : ''}`;
      return `<td class="hl-mcell" title="${escAttr(title)}"><span class="hl-mbar">${segs}</span><span class="sr-only">${esc(title)}</span>${due ? `<span class="hl-mnum">${x.miss ? x.miss : ''}</span>` : ''}</td>`;
    };
    return `
      <div class="panel-header"><h3 id="hl-h-checks">Check signals</h3>
        <span class="small">${num(list.length)} stations with a learned schedule${filtering() ? ' of the owners picked' : ''}, worst first; the number in a day is its misses</span></div>
      <div class="qs-legend">${['hit', 'partial', 'miss', 'net', 'unknown'].map(k => `<span><i class="hl-key ${OUTCOME[k].cls}" aria-hidden="true"></i>${esc(OUTCOME[k].label)}</span>`).join('')}</div>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="hl-h-checks">
        <table class="hl-table hl-matrix">
          <caption class="sr-only">Each station's checks per day: received, received with frames lost, missed</caption>
          <colgroup><col style="width:15rem"><col style="width:4rem"><col style="width:4.5rem">${days.map(() => '<col style="width:5.5rem">').join('')}</colgroup>
          <thead><tr><th scope="col">Station</th><th scope="col">Every</th><th scope="col">Missed</th>
            ${days.map(d => `<th scope="col" class="hl-mday">${esc(fmtDay(d))}</th>`).join('')}</tr></thead>
          <tbody>${shown.map(S => `<tr>
            <th scope="row"><button class="link-btn" onclick="Health.select('${escAttr(S.st.id)}')">${esc(S.st.name)}</button>${ownerSmallHtml(S.st)}</th>
            <td>${esc(HealthAnalysis.fmtPeriod(S.schedule.P))}</td>
            <td>${Math.round(100 * S.schedule.missRate)}%</td>
            ${days.map(d => cell(S, d)).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      ${list.length > 40 ? `<button class="ghost hl-more" onclick="Health.toggleMatrix()" aria-expanded="${H.matrixAll}">${H.matrixAll ? 'Show the worst 40' : `Show all ${num(list.length)}`}</button>` : ''}`;
  }

  // ── receivers and repeaters ─────────────────────────────────────────────────

  function spark(h) {
    // Readings an hour across the window: when it was delivering, and how much.
    const A = H.A;
    const k0 = Math.floor(A.t0 / HOUR), k1 = Math.ceil(A.t1 / HOUR);
    const n = Math.max(1, k1 - k0);
    let max = 1;
    h.hourly.forEach(v => { if (v > max) max = v; });
    const W = 160, Hh = 28;
    let d = '';
    for (let k = k0; k < k1; k++) {
      const v = h.hourly.get(k) || 0;
      const x = ((k - k0) / n * W).toFixed(1), y = (Hh - 1 - (Hh - 2) * v / max).toFixed(1);
      d += `${k === k0 ? 'M' : 'L'}${x} ${y}`;
    }
    const quiet = [...Array(n).keys()].filter(i => !(h.hourly.get(k0 + i) || 0)).length;
    return `<svg class="hl-spark" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img"
      aria-label="${escAttr(`${h.host}: up to ${max} readings an hour; ${quiet} of ${n} hours with nothing`)}"><path d="${d}"/></svg>`;
  }

  function networkHtml() {
    const A = H.A;
    const rx = A.receivers;
    const reps = A.repeaters.filter(R => R.members.length).slice(0, 40);
    return `
      <div class="panel-header"><h3 id="hl-h-net">Receivers and repeaters</h3></div>
      <h4 id="hl-h-rx">Receivers</h4>
      <div class="table-wrap"><table class="hl-table">
        <caption class="sr-only">Each base station or gateway that delivered readings in the window</caption>
        <thead><tr><th scope="col">Receiver</th><th scope="col">Delivering</th><th scope="col">Readings</th><th scope="col">Last</th>
          <th scope="col">Upload lag</th><th scope="col">Corrupted copies</th><th scope="col">Channels</th></tr></thead>
        <tbody>${rx.map(h => `<tr>
          <th scope="row" class="mono small" title="${escAttr(h.host)}">${esc(hostLabel(h.host))}</th>
          <td>${spark(h)}</td>
          <td>${num(h.n)} <span class="small">(${Math.round(h.perHour)}/h)</span></td>
          <td class="${h.silentFor > HOUR ? 'txt-warn' : ''}">${esc(fmtAgo(h.last))}</td>
          <td>${h.lag.p50 != null ? `${h.lag.p50.toFixed(1)} s` : '—'}</td>
          <td>${num(h.corrupted)}${h.n ? ` <span class="small">(${(100 * h.corrupted / h.n).toFixed(1)}%)</span>` : ''}</td>
          <td class="small">${h.paths.map(p => {
            const ch = p.path === h.host ? '' : p.path.slice(h.host.length).replace(/^-/, '');
            return esc(ch ? ch + (p.freq ? ` · ${p.freq.toFixed(3)} MHz` : '') : (p.freq ? `${p.freq.toFixed(3)} MHz` : '—'));
          }).join('<br>')}</td></tr>`).join('')}</tbody>
      </table></div>
      <h4 id="hl-h-reps">Repeaters</h4>
      <p class="small">Every repeater whose pass ranges carry an address heard in the window. Blame is each corrupted copy shared evenly among
        the repeaters within reach that could have carried it — the common factor collects it. The
        <button class="link-btn" onclick="Health.openReception()">Reception Map</button> takes these same readings further: every copy, which
        repeater is the only path for some, and with positions and levels when a receiver has them.</p>
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="hl-h-reps"><table class="hl-table">
        <caption class="sr-only">Repeaters: the stations behind each that were heard, how many are silent, and corrupted copies it could have carried</caption>
        <thead><tr><th scope="col">Repeater</th><th scope="col">Stations heard behind it</th><th scope="col">Silent now</th>
          <th scope="col">Corrupted copies (blame)</th><th scope="col">Rate</th></tr></thead>
        <tbody>${reps.map(R => `<tr>
          <th scope="row"><button class="link-btn" onclick="goToStation('${escAttr(R.id)}')">${esc(R.name)}</button></th>
          <td>${num(R.members.length)}</td>
          <td class="${R.silent.length ? 'txt-warn' : ''}">${num(R.silent.length)}</td>
          <td>${R.blame.toFixed(1)}</td>
          <td>${(100 * R.rate).toFixed(1)}%</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ── the register and the data ───────────────────────────────────────────────

  function registerHtml() {
    const A = H.A;
    const reg = A.findings.filter(f => f.category === 'register' || f.kind === 'ghosts');
    const c = A.counts;
    return `
      <div class="panel-header"><h3 id="hl-h-reg">The register and the data</h3></div>
      <p class="small">${num(c.corrupted)} corrupted copies and ${num(c.ghosts)} ghosts were stored as readings in the window
        (${c.readings ? (100 * (c.corrupted + c.ghosts) / c.readings).toFixed(1) : 0}% of everything stored) — set aside here before anything else
        was worked out. Every address heard is checked against the register: one heard regularly that no station here carries is a station
        Flood-Net does not know about yet.</p>
      ${reg.length ? `<ul class="hl-flist">${reg.map(f => `<li>${sevHtml(f.severity)} <b>${esc(f.title)}</b> <span class="small">${esc(f.detail)}</span>
        ${f.addr ? `<span class="small"><button class="link-btn" onclick="Health.openAddr('${escAttr(f.addr)}')">its readings</button></span>` : ''}</li>`).join('')}</ul>`
        : '<p class="small">Every address heard matches a station on file, near enough to be heard.</p>'}`;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  function rerender() {
    const el = document.getElementById('main-content');
    if (!el || state.activeTab !== 'health') return;
    stopMap();
    el.innerHTML = render();
    afterRender();
  }
  function rerenderStation() {
    const el = document.getElementById('hl-station');
    if (!el) return;
    el.innerHTML = stationHtml();
    wireCharts();
    drawMap();
  }
  function afterRender() {
    drawMap();
    wireCharts();
    if (typeof HealthAgent !== 'undefined' && HealthAgent.init) HealthAgent.init();
  }

  function setWin(k) {
    if (!WINDOWS.some(w => w[0] === k)) return;
    H.win = k;
    try { localStorage.setItem('mn-hl-win', k); } catch (_) {}
    rerender();
    run();
  }
  function refresh() { run(); }
  function setCat(k) { H.cat = k; const el = document.getElementById('hl-findings'); if (el) { rerenderAttn(); } }
  function setInfo(v) { H.showInfo = !!v; rerenderAttn(); }
  function rerenderAttn() {
    const box = document.querySelector('.hl-attn');
    if (!box) return;
    box.innerHTML = `<div class="panel-header"><h3 id="hl-h-attn">Needs attention</h3><span class="small">${esc(attnCountText())}</span></div>${filtersHtml()}<div id="hl-findings">${findingsHtml()}</div>`;
  }
  function toggleMatrix() {
    H.matrixAll = !H.matrixAll;
    const sec = document.querySelector('[aria-labelledby="hl-h-checks"]');
    if (sec) sec.innerHTML = matrixHtml();
  }

  function select(id) {
    if (!H.A || !H.A.stations.has(id)) return;
    H.sel = id;
    H.lens = null;
    H.missing = null;
    H.want = null;               // a pick here outranks one still on its way
    rerenderStation();
    loadInspections(id);
    syncRoute();
    const el = document.getElementById('hl-station');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const h = document.getElementById('hl-h-stn');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  function close() { H.sel = null; H.lens = null; H.missing = null; H.want = null; rerenderStation(); syncRoute(); }

  function lensAt(id, t, kind, addr) {
    H.lens = { id, t: Number(t), kind: kind || 'slot', addr: addr || null };
    const S = H.A && H.A.stations.get(id);
    if (!S) return;
    rerenderStation();
    const el = document.getElementById('hl-lens');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const h = document.getElementById('hl-h-lens');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  function lensClose() { H.lens = null; rerenderStation(); }

  // A click on the slot strip is a shortcut for the buttons under it.
  function stripClick(e) {
    const r = e.target && e.target.closest && e.target.closest('rect[data-t]');
    if (!r || !H.sel) return;
    lensAt(H.sel, Number(r.getAttribute('data-t')), 'slot');
  }

  // The station's last visits, from the inspection history (anon-readable,
  // 0023's chart views): when somebody was last there and what the battery
  // measured — the number to set the trend against.
  async function loadInspections(id) {
    if (H.insp.has(id)) { paintInsp(id); return; }
    H.insp.set(id, 'loading');
    paintInsp(id);
    try {
      const visits = await dbSelect(`inspection_chart_visit?station_id=eq.${encodeURIComponent(id)}&select=id,inspected_on,date_precision&order=inspected_on.desc&limit=3`);
      let power = [];
      if (visits.length) {
        power = await dbSelect(`inspection_chart_power?inspection_id=in.(${visits.map(v => encodeURIComponent(v.id)).join(',')})&select=inspection_id,battery_existing_v,battery_existing_v_under_load,solar_output_v,solar_charge_current_ma`);
      }
      H.insp.set(id, { visits, power });
    } catch (err) {
      H.insp.set(id, { error: (err && err.message) || String(err) });
    }
    paintInsp(id);
  }
  function inspHtml(id) {
    const x = H.insp.get(id);
    if (!x) return '<span class="small txt-muted">—</span>';
    if (x === 'loading') return '<span class="small txt-muted">asking the inspection history…</span>';
    if (x.error) return `<span class="small txt-muted">the inspection history did not answer</span>`;
    if (!x.visits.length) return '<span class="small">no visit on record</span>';
    const v = x.visits[0];
    const p = x.power.find(q => q.inspection_id === v.id) || {};
    const batt = p.battery_existing_v != null ? ` — battery ${p.battery_existing_v} V${p.battery_existing_v_under_load != null ? `, ${p.battery_existing_v_under_load} V under load` : ''}` : '';
    const age = Math.round((Date.now() - Date.parse(v.inspected_on)) / (365.25 * DAY) * 10) / 10;
    return `${esc(v.inspected_on)}${esc(batt)} <span class="small">(${age} years ago${x.visits.length > 1 ? `; ${x.visits.length} visits shown on the Inspection History tab` : ''})</span>`;
  }
  function paintInsp(id) {
    const el = document.getElementById('hl-insp');
    if (el && H.sel === id) el.innerHTML = inspHtml(id);
  }

  // Doors out: the readings behind a finding, where the other tabs show them.
  function openLog(id) {
    const st = stationById(id);
    if (!st || typeof MessageLog === 'undefined' || !MessageLog.showWindow) return;
    MessageLog.showWindow(stationAlertIds(st).join(' ') || st.station_number || st.name, H.A ? H.A.t0 : Date.now() - windowMs(), H.A ? H.A.t1 : Date.now());
  }
  function openAddr(addr) {
    if (typeof MessageLog === 'undefined' || !MessageLog.showWindow) return;
    const a = String(addr || '');
    MessageLog.showWindow(a.startsWith('a:') ? a.slice(2) : a, H.A ? H.A.t0 : Date.now() - windowMs(), H.A ? H.A.t1 : Date.now());
  }
  // The Reception Map, over the readings this tab already holds.
  function openReception(repId) {
    if (typeof Reception === 'undefined' || !Reception.useReadings) { switchTab('reception'); return; }
    if (H.rows && H.rows.length) {
      const w = WINDOWS.find(x => x[0] === H.win);
      Reception.useReadings(H.rows, { label: H.demo ? 'the Station Health demo week' : `the Station Health tab's ${w ? w[1] : 'window'}`, select: repId || null });
    }
    switchTab('reception');
  }
  function openField(id) {
    switchTab('field');
    if (typeof ArroData !== 'undefined' && ArroData.fieldOpenStation) ArroData.fieldOpenStation(id);
  }
  // From another tab: open this one on a station — the Stations card's health
  // lines (#218, health-glance.js), each at the part of the station it was
  // about: 'checks' (the slot strip), 'battery' (the chart) or 'findings'.
  // With the analysis in hand it is picked before the tab is drawn; on the
  // tab's first visit it is held until the week has been fetched and worked
  // out (adopt). Either way the view goes to it and focus with it — and a
  // station the window holds nothing from says so, rather than leaving the
  // tab looking as though the press did nothing.
  function showStation(id, part) {
    if (!id) return;
    H.want = { id, part: part || null };
    const landing = takeWant();
    switchTab('health');
    if (landing) focusPart(landing.part);
  }

  // The station the tab has open — or was asked for, while the week is still
  // on its way — for the address bar: ?tab=health&station=<id> (route.js), so
  // a link into the tab with a station picked is an address like any other,
  // and a reload keeps it.
  function picked() { return H.sel || H.missing || (H.want && H.want.id) || null; }
  // The address naming a station (route.js, before the first render and on
  // back and forward): held as showStation holds it, without switching tabs —
  // the router is doing that. No station closes the one that is open.
  function wantStation(id) {
    if (!id) {
      if (H.sel || H.missing || H.want) { H.sel = null; H.missing = null; H.want = null; H.lens = null; rerenderStation(); }
      return;
    }
    if (picked() === id) return;
    H.want = { id, part: null };
    if (takeWant()) rerenderStation();
  }
  function syncRoute() { if (typeof Route !== 'undefined' && Route.sync) Route.sync(); }

  // H.want → H.sel (heard in this window) or H.missing (not), once there is
  // an analysis to look in. Returns what was wanted, or null.
  function takeWant() {
    const w = H.want;
    if (!w || !H.A) return null;
    H.want = null;
    H.lens = null;
    if (H.A.stations.has(w.id)) { H.sel = w.id; H.missing = null; }
    else { H.sel = null; H.missing = w.id; }
    return w;
  }

  const PART_HEAD = { checks: 'hl-h-strip', battery: 'hl-h-batt', findings: 'hl-h-stnf' };
  // The heading of the part asked for, or of the station when it has no such
  // part (no schedule learned, no battery heard, nothing found): scrolled to
  // and focused, the way select() does it.
  function focusPart(part) {
    if (state.activeTab !== 'health') return;
    const el = (part && document.getElementById(PART_HEAD[part])) || document.getElementById('hl-h-stn');
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }

  function exportCsv() {
    if (!H.A) return;
    const head = ['severity', 'category', 'kind', 'station', 'station_id', 'owner', 'receiver', 'repeater_id', 'address', 'title', 'detail', 'action', 'since', 'evidence'];
    const lines = [head.join(',')];
    const F = ownedFindings();
    F.forEach(f => {
      const id = f.stationId || f.repeaterId;
      const o = id ? ownerOf(stationById(id)) : null;
      lines.push([
        f.severity, f.category, f.kind, f.station || '', f.stationId || '', o ? o.name : '', f.host || '', f.repeaterId || '', f.addr || '',
        f.title, f.detail, f.action || '', f.since ? new Date(f.since).toISOString() : '', JSON.stringify(f.evidence || {}),
      ].map(csvEscape).join(','));
    });
    const slug = filtering() ? '-' + [...H.owners].sort().join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : '';
    dlText(`floodnet-station-health${slug}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
    announce(`Downloaded ${F.length} findings as CSV${filtering() ? ', for the owners picked' : ''}.`);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function stop() { stopMap(); }

  function init() {
    // Safe to repeat: the registry replaces rather than stacks (#142).
    registerTabTeardown('Health', stop);
    askOwners();
    afterRender();
    if (H.sel) loadInspections(H.sel);
    // The first visit fetches on its own, as the Message Log's does: the tab's
    // whole point is what the readings say now. After that, the board stands
    // until it is asked again.
    if (!H.rows && !H.loading) run();
  }

  // What the agent reads. Plain data, not the DOM.
  function state_() {
    return { A: H.A, rows: H.rows, sel: H.sel, win: H.win, demo: H.demo, owners: [...H.owners],
             missing: H.missing, want: H.want ? Object.assign({}, H.want) : null };
  }
  // A station's owner for the agent and the tests: { name, parties, source }, or null.
  function owner(st) {
    const o = ownerOf(st);
    return o ? { name: o.name, parties: o.parties.slice(), source: o.src } : null;
  }

  return {
    render, init, stop, run, refresh, demo, adopt,
    setWin, setCat, setInfo, toggleMatrix, select, close, lensAt, lensClose, stripClick,
    openLog, openAddr, openField, openReception, showStation, picked, wantStation, exportCsv, fetchReadings,
    setOwner, clearOwners, findOwner, owner,
    state: state_,
  };
})();

if (typeof window !== 'undefined') window.Health = Health;
