// MegaNet — map-latency.js
//
//   MapLatency   ⏱️ Latency, a tool in the Stations map's side panel. It
//                colours every station pin by how fresh its data is — how long
//                since Flood-Net last heard it, how long its readings take to
//                reach the database, or how many of its timed checks went
//                missing — and its pane sums that up for the stations in view,
//                following the map as it moves. Pick a station on the map and
//                the pane is about that station instead: its checks slot by
//                slot, its readings' delay one by one, and the receivers that
//                carried them.
//
// After core.js (state, esc, escAttr, announce), app.js (refreshMapLayers,
// rerenderMapLegend, rerenderMapDisplayControls, focusStationOnMap,
// stationOwner, MAP_PIN_RING), map-controls.js (MapChrome), map-symbols.js
// (MapSymbols), health-analysis.js (HealthAnalysis), health.js
// (Health.fetchReadings, and the analysis the Station Health tab last made)
// and health-glance.js (HealthGlance — when each station was last heard);
// before init.js. All of it at call time, so its place among the modules is
// free (`npm run toplevel`). Nothing runs at load: initMap() attaches it,
// refreshMapLayers() calls reset() once per rebuild and pinStyle() per pin,
// renderDock() calls shown() when its pane comes into view, the strip's ⏱️
// calls opened() when it is pressed open, and the station card calls follow()
// with the station it is on.
//
// ── What "latency" means here ────────────────────────────────────────────────
// Three measures, because "how late is this station's data" is three
// questions and each has a different fault behind it:
//
//   Age      now − when Flood-Net last heard the station. The one that says a
//            station has gone quiet. Absolute bands, on purpose: Colour pins by
//            health (#218) already judges a silence against the station's own
//            check period; this is the plain clock, which is what somebody
//            asking "how old is the data on this part of the map" means.
//   Delay    received_at − reading_ts for each transmission, the first copy to
//            land: how long a reading takes from the air to the database. A
//            serial-monitor base posts in batches (about a minute, measured
//            when this was written: a median of 52 s, 95% inside 84 s) and the
//            MQTT feed in a second or two, so a station whose delay is
//            minutes is behind a receiver that is queuing.
//   Checks   the share of its timed checks that never arrived while a receiver
//            that hears it was listening — the Station Health tab's own slots,
//            from the same HealthAnalysis.run(), so the two cannot disagree.
//            A check most of the network missed at once is the network's and
//            is not counted against the station (`net`).
//
// ── What it costs ────────────────────────────────────────────────────────────
// Age costs nothing new: it is HealthGlance's one batch of last-heard times,
// which the Stations tab already asks for its Last heard column. Delay and
// Checks need the readings themselves — the window, 24 h by default (about
// 27,000 readings when this was written, ~27 pages fetched four at a time the
// way Station Health fetches its week) — fetched when the pane is first opened
// or the pins are coloured by one of them, kept for WIN_TTL, and asked again
// only by ↻, a new window, or a map rebuilt after that. An analysis the Station
// Health tab made of the same window in the last BORROW_TTL is used instead of
// fetching it again.
//
// ── The pins ─────────────────────────────────────────────────────────────────
// Only the fill changes, and the size with it. The shape (a triangle for a
// river height gauge), the Bureau's solid and dashed pink outlines, a filter's
// ring and the selection's are all left as they are — they say things latency
// does not. Colour is never the only channel: the worse bands are a step or two
// bigger, a station never heard is hollow in a dotted ring, one heard before
// the window but not in it hollow in a maroon one, and the pane says every
// figure in words. A gauge read by hand or a TM station that Flood-Net has
// never heard keeps its grey or black: nothing reports it over the radio, so
// its silence is not latency.
//
// The ramp is literals, in both themes, for ROLE_COLOR's reason (design-system
// §1): a Leaflet path option takes no var(), and the base maps do not go dark
// with the app. Green through gold to maroon, saturated enough to read over
// satellite imagery under the white ring every pin wears, and none of them the
// amber of a filter match, the violet of the selection or the pink of an
// outline.
//
// ── One colouring at a time ──────────────────────────────────────────────────
// Latency and Colour pins by health both want the pin's fill, so turning one on
// turns the other off — MapFreq's rule for the links, applied to the pins. The
// switch is remembered, on Colour pins by health's terms, and the first time the
// pane is opened in a session it turns itself on: opening the tool is asking
// for the view.
//
// Exposes: attach, detach, reset, shown, opened, follow, pinStyle, legendHtml,
//          altText, noteText, on, setOn, setMode, setWin,
//          setScope, pickBand, back, focus, refresh, yieldTo, and the rules
//          for test/latency.mjs (classifyValue, quantile, BANDS).
const MapLatency = (() => {
  const SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;

  const WINDOWS = [
    ['1d', '24 h', 1],
    ['3d', '3 days', 3],
    ['7d', '7 days', 7],
  ];
  // What HealthAnalysis reads off a reading, and no more — HealthGlance's
  // card asks for the same columns. The signal and duplicate bookkeeping are
  // the Station Health tab's, not this pane's.
  const SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
               + 'reading_ts,received_at,value_raw,protocol,path';
  // Station Health's own analysis stands in for a fetch while it is this young.
  const BORROW_TTL = 10 * MIN;
  // …and this pane's window is fetched again after this, by a rebuild of the
  // map or the pane coming back into view.
  const WIN_TTL = 15 * MIN;
  // How many stations a band lists before saying how many more.
  const LIST_N = 12;

  const MODES = {
    age:    { label: 'Age',    title: 'How long since Flood-Net last heard each station',
              long: 'how long since Flood-Net last heard it',
              head: 'How long since each was heard', worst: 'Longest quiet' },
    delay:  { label: 'Delay',  title: 'How long each station’s readings take to reach the database — the median over the window',
              long: 'how long its readings take to reach the database',
              head: 'How long readings take to arrive', worst: 'Slowest to arrive' },
    checks: { label: 'Checks', title: 'The share of each station’s timed checks that went missing over the window',
              long: 'how many of its timed checks went missing',
              head: 'How many checks went missing', worst: 'Most checks missed' },
  };
  const MODE_KEYS = Object.keys(MODES);

  // Fresh to stale. See the header for why literals and why these.
  const RAMP = ['#1a7f37', '#57a83a', '#a3b92b', '#e0a21b', '#e8711c', '#c8341f', '#6b1717'];
  // A value at or under `max` is in the band. Age in ms, delay in seconds,
  // checks as the share missed. `grow` is pixels on the pin's radius.
  const BANDS = {
    age: [
      { k: 'a0', max: 15 * MIN, label: 'under 15 min', fill: RAMP[0], grow: 0 },
      { k: 'a1', max: HOUR,     label: '15 min – 1 h', fill: RAMP[1], grow: 0 },
      { k: 'a2', max: 3 * HOUR, label: '1 – 3 h',      fill: RAMP[2], grow: 0 },
      { k: 'a3', max: 6 * HOUR, label: '3 – 6 h',      fill: RAMP[3], grow: 1 },
      { k: 'a4', max: DAY,      label: '6 – 24 h',     fill: RAMP[4], grow: 1 },
      { k: 'a5', max: 7 * DAY,  label: '1 – 7 days',   fill: RAMP[5], grow: 2 },
      { k: 'a6', max: Infinity, label: 'over 7 days',  fill: RAMP[6], grow: 2 },
    ],
    delay: [
      { k: 'd0', max: 10,       label: 'under 10 s',   fill: RAMP[0], grow: 0 },
      { k: 'd1', max: 60,       label: '10 s – 1 min', fill: RAMP[1], grow: 0 },
      { k: 'd2', max: 120,      label: '1 – 2 min',    fill: RAMP[2], grow: 0 },
      { k: 'd3', max: 300,      label: '2 – 5 min',    fill: RAMP[3], grow: 1 },
      { k: 'd4', max: 1800,     label: '5 – 30 min',   fill: RAMP[4], grow: 1 },
      { k: 'd5', max: Infinity, label: 'over 30 min',  fill: RAMP[5], grow: 2 },
    ],
    checks: [
      { k: 'c0', max: 0,        label: 'none missed',  fill: RAMP[0], grow: 0 },
      { k: 'c1', max: 0.1,      label: 'under 10%',    fill: RAMP[1], grow: 0 },
      { k: 'c2', max: 0.25,     label: '10 – 25%',     fill: RAMP[3], grow: 1 },
      { k: 'c3', max: 0.5,      label: '25 – 50%',     fill: RAMP[4], grow: 1 },
      { k: 'c4', max: Infinity, label: 'over half',    fill: RAMP[5], grow: 2 },
    ],
  };
  // What is not a band. `fill: null` leaves the pin as the map would draw it
  // without this view (a gauge read by hand keeps its grey). The rings are
  // black-ish rather than white for HealthGlance's reason: a dash has to show
  // against the tiles, and a white one vanished into the topo base.
  const SPECIAL = {
    never:   { label: 'never heard', fill: '#ffffff', ring: '#4f6478', weight: 2, dash: '1,3', grow: -1,
               key: 'never' },
    quiet:   { label: 'heard before the window, not in it', fill: '#ffffff', ring: RAMP[6], weight: 2.5, dash: null, grow: 0,
               key: 'quiet' },
    unknown: { label: null, fill: '#ffffff', ring: '#4f6478', weight: 2, dash: null, grow: 0, key: 'unknown' },
    offair:  { label: 'read by hand or by modem, not heard by radio', fill: null, key: 'offair' },
  };
  // A measure that could not be worked out for a station heard in the window,
  // said for the measure.
  const UNKNOWN_LABEL = {
    age:    'not known',
    delay:  'heard, no arrival times',
    checks: 'heard, no check schedule learned',
  };
  // Which of them a mode can produce: Age is known for every station heard, so
  // it has no "heard, but…" of its own.
  const SPECIAL_ORDER = ['quiet', 'unknown', 'never', 'offair'];
  const specialsFor = mode => (mode === 'age' ? ['never', 'offair'] : SPECIAL_ORDER);

  // The Station Health tab's slot outcomes, its words and its classes, so the
  // strip here reads the same as the strip there.
  const OUTCOME = {
    hit:     { label: 'received',              cls: 'hl-slot--hit' },
    partial: { label: 'received, frames lost', cls: 'hl-slot--partial' },
    miss:    { label: 'missed',                cls: 'hl-slot--miss' },
    net:     { label: 'missed network-wide',   cls: 'hl-slot--net' },
    unknown: { label: 'no receiver listening', cls: 'hl-slot--unknown' },
  };

  const stored = (k, ok, dflt) => {
    try { const v = localStorage.getItem(k); return ok.includes(v) ? v : dflt; } catch (_) { return dflt; }
  };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private browsing — still works this session */ } };

  // The view's settings. `on` and the mode and window are remembered; the
  // rest is the session's.
  const U = {
    on: stored('mn-map-latency', ['on', 'off'], 'off') === 'on',
    mode: stored('mn-latency-mode', MODE_KEYS, 'age'),
    win: stored('mn-latency-win', WINDOWS.map(w => w[0]), '1d'),
    scope: 'view',           // 'view' | 'all'
    band: null,              // the band whose stations are listed, or null for the worst
    sel: null,               // the station the pane is about, or null for the summary
    lastCard: null,          // the station card's station, as last told (follow)
    autoOn: false,           // the pane has turned the view on once this session
    announce: false,         // the next answer to land is one somebody asked for
  };
  // The window: its readings, worked out.
  const W = {
    key: null, status: 'idle', A: null, t0: null, t1: null, at: 0, rows: 0, fetched: 0,
    capped: false, error: '', denied: false, seq: 0, borrowed: false,
  };

  let map = null;
  let root = null;
  let classes = null;          // station id → classification, for this rebuild's mode
  let classesMode = null;
  let classesAt = 0;
  const statMemo = new Map();  // station id → the delay and check figures off W.A
  let pinTimer = null;
  let paintTimer = null;
  let netHooked = false;
  let resizeObs = null;
  let paintedW = 0;

  const now_ = () => Date.now();
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
  const errText = err => (err && err.message) || String(err || 'unknown error');
  const isDenied = err => !!err && (err.status === 401 || err.status === 403 || err.status === 404);
  const stations = () => (state.data && state.data.stations) || [];
  const stationById = id => stations().find(s => s.id === id) || null;
  const winOf = k => WINDOWS.find(w => w[0] === k) || WINDOWS[0];
  const fmtWhen = (t, now) => HealthAnalysis.fmtWhen(t, now);
  const fmtSpan = ms => HealthAnalysis.fmtSpan(ms);
  const p2 = n => String(n).padStart(2, '0');
  const fmtHm = t => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  // A receiver as people say it, as Station Health says it.
  const hostLabel = h => String(h || '').replace(/^serial-monitor\//, '').replace(/^meganet\/v1\/([^/]+)\/logger\/reading\//, '$1 · ');

  // A delay in seconds, short: "1.6 s", "52 s", "4.5 min", "2.1 h".
  function fmtDelay(s) {
    if (s == null || !isFinite(s)) return '—';
    const a = Math.abs(s);
    const sign = s < 0 ? '−' : '';
    if (a < 10) return `${sign}${a.toFixed(1)} s`;
    if (a < 90) return `${sign}${Math.round(a)} s`;
    if (a < 90 * 60) return `${sign}${(a / 60).toFixed(a < 600 ? 1 : 0)} min`;
    return `${sign}${(a / 3600).toFixed(1)} h`;
  }
  // An age in ms, short, as the station list's Last heard column says it.
  function fmtAge(ms) {
    if (ms == null) return '—';
    if (ms < 90 * SEC) return 'just now';
    return `${fmtSpan(ms)} ago`;
  }

  // ── The rules (pure) ───────────────────────────────────────────────────────

  // The value at `q` of a list of numbers, interpolated; null for none.
  function quantile(list, q) {
    const a = (list || []).filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }
  // The band a value is in, for a mode. A negative delay — a receiver whose
  // clock runs ahead — is the fastest band: the reading did not arrive before
  // it was heard, but nothing about it was late.
  function classifyValue(mode, v) {
    const list = BANDS[mode] || BANDS.age;
    const x = Math.max(0, Number(v) || 0);
    return list.find(b => x <= b.max) || list[list.length - 1];
  }

  // ── What is known about one station ───────────────────────────────────────

  // Delay and checks, off the window's analysis, once per analysis.
  function statsOf(S) {
    const id = S.st.id;
    let m = statMemo.get(id);
    if (m) return m;
    const series = [];             // { t, d } — each transmission's first arrival, seconds
    const byPath = new Map();
    for (const tx of S.txs || []) {
      let rt = Infinity;
      for (const c of tx.copies || []) {
        if (c.rt == null) continue;
        if (c.rt < rt) rt = c.rt;
        let p = byPath.get(c.path);
        if (!p) byPath.set(c.path, p = { path: c.path, host: c.host, d: [], last: 0 });
        p.d.push((c.rt - c.t) / SEC);
        if (c.t > p.last) p.last = c.t;
      }
      if (isFinite(rt)) series.push({ t: tx.t, d: (rt - tx.t) / SEC });
    }
    series.sort((a, b) => a.t - b.t);
    const ds = series.map(x => x.d);
    const sch = S.schedule;
    m = {
      delay: ds.length ? { p50: quantile(ds, 0.5), p95: quantile(ds, 0.95), max: Math.max(...ds), n: ds.length,
                           newest: series[series.length - 1] } : null,
      series,
      paths: [...byPath.values()]
        .map(p => ({ path: p.path, host: p.host, n: p.d.length, p50: quantile(p.d, 0.5), p95: quantile(p.d, 0.95), last: p.last }))
        .sort((a, b) => b.n - a.n),
      checks: sch && sch.counts ? Object.assign({}, sch.counts, { rate: sch.missRate || 0, P: sch.P }) : null,
    };
    statMemo.set(id, m);
    return m;
  }

  // Whether the last-heard batch has answered, or a card has.
  function netKnown() {
    const c = HealthGlance.counts ? HealthGlance.counts() : null;
    return !!(c && c.okAt);
  }
  function lastHeardOf(s) {
    const k = HealthGlance.known ? HealthGlance.known(s.id) : null;
    let last = k && k.lastHeard != null ? k.lastHeard : null;
    const S = W.A ? W.A.stations.get(s.id) : null;
    if (S && S.lastHeard != null && (last == null || S.lastHeard > last)) last = S.lastHeard;
    return last;
  }
  // Read by hand or a TM station: the radio never hears it, by its record.
  function offAir(s) {
    const k = MapSymbols.kind ? MapSymbols.kind(s) : null;
    return !!(k && (k.manual || k.tm));
  }

  // One station, for one mode: { key, band?, value?, last }. key is a band's
  // `k`, a SPECIAL key, 'asking' (the answer is on its way) or 'proposed'.
  function classify(s, mode, now) {
    if (!s || s.proposed) return { key: 'proposed' };
    const last = lastHeardOf(s);
    const air = offAir(s);
    if (mode === 'age') {
      if (last == null) return { key: !netKnown() && !W.A ? 'asking' : air ? 'offair' : 'never', last };
      const v = Math.max(0, now - last);
      const band = classifyValue('age', v);
      return { key: band.k, band, value: v, last };
    }
    if (!W.A) return { key: 'asking', last };
    const S = W.A.stations.get(s.id);
    const st = S ? statsOf(S) : null;
    if (mode === 'delay' && st && st.delay) {
      const band = classifyValue('delay', st.delay.p50);
      return { key: band.k, band, value: st.delay.p50, last, st };
    }
    if (mode === 'checks' && st && st.checks && st.checks.due > 0) {
      const band = classifyValue('checks', st.checks.rate);
      return { key: band.k, band, value: st.checks.rate, last, st };
    }
    // Heard in the window — through its own readings, or by the ingest's
    // record of an address it shares with another station — and the measure
    // still not worked out.
    if (S || (last != null && last >= W.t0)) return { key: 'unknown', last, st };
    if (last != null) return { key: 'quiet', last };
    return { key: air ? 'offair' : netKnown() ? 'never' : 'asking', last };
  }

  // Every station's class at once, per rebuild and per answer — never per pin.
  function classOf(s) {
    if (!classes || classesMode !== U.mode) {
      const now = now_();
      classes = new Map();
      for (const x of stations()) classes.set(x.id, classify(x, U.mode, now));
      classesMode = U.mode;
      classesAt = now;
    }
    return classes.get(s.id) || classify(s, U.mode, classesAt || now_());
  }
  function dirty() { classes = null; }

  // ── The pins ──────────────────────────────────────────────────────────────

  // What refreshMapLayers lays over a pin's own style while the view is on:
  // { cls, fill, ring, grow, weight, dash }, or null — the view off, the
  // answer not in yet, or a station this view leaves as it is.
  function pinStyle(s) {
    if (!U.on || !s) return null;
    const c = classOf(s);
    const ring = typeof MAP_PIN_RING !== 'undefined' ? MAP_PIN_RING : '#ffffff';
    if (c.band) return { cls: c.key, fill: c.band.fill, ring, grow: c.band.grow, weight: null, dash: null };
    const sp = SPECIAL[c.key];
    if (!sp || !sp.fill) return null;
    return { cls: c.key, fill: sp.fill, ring: sp.ring, grow: sp.grow, weight: sp.weight, dash: sp.dash };
  }

  // The pins again, once, when an answer lands or the mode changes.
  function repins() {
    if (pinTimer) return;
    pinTimer = setTimeout(() => {
      pinTimer = null;
      dirty();
      if (U.on && state.activeTab === 'stations' && state.map && typeof refreshMapLayers === 'function') {
        refreshMapLayers({ skipFit: true });
      }
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      paint();
    }, 0);
  }

  // Once per map rebuild, from refreshMapLayers: the classes are worked out
  // again (the clock has moved), and whatever the pins need is asked for.
  function reset() {
    dirty();
    if (!U.on) return;
    if (HealthGlance.askNet) HealthGlance.askNet();
    if (U.mode !== 'age') ensureWindow(false);
  }

  // ── The switch, the mode, the window ──────────────────────────────────────

  function setOn(on, opts = {}) {
    // Somebody's own choice, made once, is the session's from then on.
    if (!opts.auto) U.autoOn = true;
    U.on = !!on;
    keep('mn-map-latency', U.on ? 'on' : 'off');
    // One colouring of the pins at a time: health gives way.
    if (U.on && state.mapHealth) {
      state.mapHealth = false;
      keep('mn-map-health', 'off');
      if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    }
    if (U.on) {
      if (HealthGlance.askNet) HealthGlance.askNet();
      if (U.mode !== 'age') ensureWindow(false);
    }
    dirty();
    if (!opts.quiet) {
      announce(U.on ? `Pins coloured by latency — ${MODES[U.mode].long}. ${summaryText()}`
                    : 'Pins are back in their roles’ colours.');
    }
    if (typeof refreshMapLayers === 'function' && state.map) refreshMapLayers({ skipFit: true });
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    paint();
  }
  // Colour pins by health was turned on: this view gives way, without a word —
  // the switch that was pressed says what the pins are now.
  function yieldTo() {
    if (!U.on) return;
    U.on = false;
    keep('mn-map-latency', 'off');
    dirty();
    paint();
  }

  function setMode(m) {
    if (!MODES[m] || m === U.mode) return;
    U.mode = m;
    U.band = null;
    keep('mn-latency-mode', m);
    dirty();
    if (m !== 'age') { U.announce = W.status !== 'ok'; ensureWindow(false); }
    if (U.on) repins();
    else paint();
    if (W.status === 'ok' || m === 'age') announce(`${MODES[m].label}: ${summaryText()}`);
  }

  function setWin(k) {
    if (!WINDOWS.some(w => w[0] === k)) return;
    const same = k === U.win;
    U.win = k;
    keep('mn-latency-win', k);
    U.announce = true;
    ensureWindow(!same ? false : true);
    paint();
  }

  function setScope(sc) {
    if (sc !== 'view' && sc !== 'all') return;
    U.scope = sc;
    U.band = null;
    paint();
  }

  function pickBand(k) {
    U.band = U.band === k ? null : k;
    paint();
  }

  function refresh() {
    U.announce = true;
    if (HealthGlance.askAgain && U.mode === 'age') HealthGlance.askAgain();
    ensureWindow(true);
    paint();
  }

  // ── The window ────────────────────────────────────────────────────────────

  function ensureWindow(force) {
    if (W.status === 'loading' || W.status === 'working') { if (W.key === U.win && !force) return; }
    const fresh = W.status === 'ok' && W.key === U.win && now_() - W.at < WIN_TTL;
    if (!force && fresh) return;
    if (!force && borrow()) return;
    fetchWindow();
  }

  // The Station Health tab's analysis of the same window, if it made one lately.
  function borrow() {
    if (typeof Health === 'undefined' || !Health.state) return false;
    let hs = null;
    try { hs = Health.state(); } catch (_) { return false; }
    const A = hs && hs.A;
    if (!A || hs.demo || A.now == null || now_() - A.now > BORROW_TTL || A.t0 == null || A.t1 == null) return false;
    if (Math.abs((A.t1 - A.t0) / DAY - winOf(U.win)[2]) > 0.05) return false;
    W.seq++;
    adoptA(A, { t0: A.t0, t1: A.t1, rows: hs.rows ? hs.rows.length : (A.counts ? A.counts.rows : 0), capped: false, borrowed: true });
    return true;
  }

  async function fetchWindow() {
    if (typeof Health === 'undefined' || !Health.fetchReadings) return;
    const seq = ++W.seq;
    const t1 = now_(), t0 = t1 - winOf(U.win)[2] * DAY;
    Object.assign(W, { key: U.win, status: 'loading', fetched: 0, error: '', denied: false });
    paintStatus();
    let got = null;
    try {
      got = await Health.fetchReadings(t0, t1, {
        select: SELECT,
        alive: () => seq === W.seq,
        onPage: n => { W.fetched = n; paintStatusSoon(); },
      });
    } catch (err) {
      if (seq !== W.seq) return;
      Object.assign(W, { status: 'error', at: now_(), error: errText(err), denied: isDenied(err) });
      if (U.announce) { U.announce = false; announce('Latency: the readings could not be fetched.'); }
      paint();
      return;
    }
    if (seq !== W.seq) return;
    W.status = 'working';
    paintStatus();
    // A frame for the status line to say so before the analysis takes the
    // thread for half a second.
    await new Promise(r => setTimeout(r, 30));
    if (seq !== W.seq) return;
    let A = null;
    try {
      A = HealthAnalysis.run(got.rows, { t0, t1, now: t1 });
    } catch (err) {
      Object.assign(W, { status: 'error', at: now_(), error: 'the analysis failed: ' + errText(err), denied: false });
      if (typeof recordError === 'function') recordError({ kind: 'latency', message: W.error, where: '', stack: (err && err.stack) || '' });
      paint();
      return;
    }
    adoptA(A, { t0, t1, rows: got.rows.length, capped: got.capped, borrowed: false });
  }

  function adoptA(A, o) {
    Object.assign(W, { key: U.win, status: 'ok', A, t0: o.t0, t1: o.t1, at: now_(), rows: o.rows || 0,
                       capped: !!o.capped, borrowed: !!o.borrowed, error: '', denied: false });
    statMemo.clear();
    dirty();
    if (U.announce) { U.announce = false; announce(`Latency worked out from ${num(W.rows)} readings over ${winOf(U.win)[1]}. ${summaryText()}`); }
    if (U.on && U.mode !== 'age') repins();
    else { if (typeof rerenderMapLegend === 'function' && U.on) rerenderMapLegend(); paint(); }
  }

  // ── The stations being summed up ──────────────────────────────────────────

  function scopeList() {
    const b = U.scope === 'view' && map ? map.getBounds() : null;
    return stations().filter(s => s.lat != null && s.lon != null && !s.proposed
      && (!MapSymbols.ownerDrawn || MapSymbols.ownerDrawn(s))
      && (!b || b.contains([s.lat, s.lon])));
  }

  // Everything the summary says, in one pass over the scope.
  function summary() {
    const list = scopeList();
    const now = classesAt || now_();
    const bands = new Map();
    const ages = [];
    let heard = 0, hour = 0, day = 0, week = 0, never = 0, offair = 0;
    const delays = [];
    let due = 0, got = 0, missed = 0, netMissed = 0, scheduled = 0;
    for (const s of list) {
      const c = classOf(s);
      bands.set(c.key, (bands.get(c.key) || 0) + 1);
      const last = c.last != null ? c.last : lastHeardOf(s);
      if (last != null) {
        heard++;
        const a = now - last;
        ages.push(a);
        if (a <= HOUR) hour++;
        if (a > DAY) day++;
        if (a > 7 * DAY) week++;
      } else if (offAir(s)) offair++;
      else never++;
      if (W.A) {
        const S = W.A.stations.get(s.id);
        if (S) {
          const st = statsOf(S);
          for (const x of st.series) delays.push(x.d);
          if (st.checks) {
            scheduled++;
            due += st.checks.due;
            got += st.checks.hits + st.checks.partial;
            missed += st.checks.misses;
            netMissed += st.checks.net;
          }
        }
      }
    }
    return {
      list, bands, n: list.length, heard, hour, day, week, never, offair,
      medAge: quantile(ages, 0.5),
      delay: delays.length ? { p50: quantile(delays, 0.5), p95: quantile(delays, 0.95), n: delays.length } : null,
      checks: { due, got, missed, net: netMissed, scheduled },
    };
  }

  // The stations of one band, or the worst of the scope: worst first.
  function listFor(sum, band) {
    const now = classesAt || now_();
    const rows = sum.list.map(s => ({ s, c: classOf(s) }));
    const keyed = band ? rows.filter(r => r.c.key === band)
      : rows.filter(r => r.c.band);
    const score = r => (r.c.value != null ? r.c.value : r.c.last != null ? now - r.c.last : -1);
    keyed.sort((a, b) => score(b) - score(a) || String(a.s.name).localeCompare(String(b.s.name)));
    return keyed;
  }

  function valueText(c, mode, now) {
    if (c.band) {
      if (mode === 'age') return fmtAge(c.value);
      if (mode === 'delay') return fmtDelay(c.value);
      const k = c.st && c.st.checks;
      return k ? `${num(k.misses)} of ${num(k.due)} missed` : `${Math.round(100 * c.value)}%`;
    }
    if (c.key === 'quiet' && c.last != null) return `last ${fmtAge(now - c.last)}`;
    if (c.key === 'unknown') return UNKNOWN_LABEL[mode];
    const sp = SPECIAL[c.key];
    return sp && sp.label ? sp.label : '';
  }

  function summaryText() {
    if (U.mode !== 'age' && !W.A) {
      return W.status === 'error' ? 'The readings could not be fetched.' : 'Fetching the readings…';
    }
    const t = summary();
    const where = U.scope === 'view' ? 'in view' : 'on the map';
    const parts = [];
    BANDS[U.mode].forEach(b => { const n = t.bands.get(b.k) || 0; if (n) parts.push(`${num(n)} ${b.label}`); });
    specialsFor(U.mode).forEach(k => {
      const n = t.bands.get(k) || 0;
      if (n) parts.push(`${num(n)} ${k === 'unknown' ? UNKNOWN_LABEL[U.mode] : SPECIAL[k].label}`);
    });
    return `${num(t.n)} stations ${where}: ${parts.join(', ') || 'none'}.`;
  }

  // ── The pane ──────────────────────────────────────────────────────────────

  const seg = (label, items, cur, fn) => `
    <span class="lat-seg" role="group" aria-label="${escAttr(label)}">${items.map(([k, text, title]) => `
      <button type="button" class="lat-chip${cur === k ? ' is-on' : ''}" aria-pressed="${cur === k}"
              data-lat-f="${escAttr(fn + ':' + k)}" ${title ? `title="${escAttr(title)}"` : ''}
              onclick="MapLatency.${fn}('${escAttr(k)}')">${esc(text)}</button>`).join('')}
    </span>`;

  function controlsHtml() {
    return `
      <div class="lat-controls">
        <label class="filter-check lat-switch"
               title="Colour every station pin by latency instead of by its role. Its shape and the Bureau's outlines stay as they are.">
          <input type="checkbox" data-lat-f="on" ${U.on ? 'checked' : ''} onchange="MapLatency.setOn(this.checked)">
          Colour pins by latency
        </label>
        <div class="lat-row"><span class="lat-row-h" aria-hidden="true">Colour by</span>
          ${seg('Colour by', MODE_KEYS.map(k => [k, MODES[k].label, MODES[k].title]), U.mode, 'setMode')}</div>
        <div class="lat-row"><span class="lat-row-h" aria-hidden="true">Readings</span>
          ${seg('Readings from the last', WINDOWS.map(([k, label]) => [k, label, `Delay and checks from the last ${label} of readings`]), U.win, 'setWin')}
          <button type="button" class="link-btn lat-again" data-lat-f="again" onclick="MapLatency.refresh()"
                  title="Ask the datastore again — last-heard times and the window's readings">↻</button></div>
        <p class="small lat-status" id="lat-status" role="status">${statusHtml()}</p>
      </div>`;
  }

  function statusHtml() {
    const w = winOf(U.win)[1];
    if (W.status === 'loading') return `Fetching the last ${esc(w)} of readings… ${W.fetched ? `${num(W.fetched)} so far` : ''}`;
    if (W.status === 'working') return `Working out ${num(W.fetched)} readings…`;
    if (W.status === 'error') {
      return `<span class="txt-warn">${W.denied ? 'The datastore would not let this browser read the readings'
        : `The readings could not be fetched (${esc(W.error)})`}</span> — delay and checks are not known.
        <button type="button" class="link-btn" data-lat-f="retry" onclick="MapLatency.refresh()">Try again</button>`;
    }
    if (W.status === 'ok') {
      const span = W.t1 && W.t0 ? esc(fmtSpan(W.t1 - W.t0)) : esc(w);
      return `${num(W.rows)} readings over ${span}, to ${esc(fmtWhen(W.t1))}${W.borrowed ? ' — the Station Health tab’s, worked out ' + esc(fmtAge(now_() - W.at)) : ''}${W.capped ? ' <span class="txt-warn">(stopped at the cap)</span>' : ''}.`;
    }
    return 'Delay and checks come from the readings, fetched when they are first wanted.';
  }

  function paneHtml() {
    const s = U.sel ? stationById(U.sel) : null;
    return controlsHtml() + `<div class="lat-body" id="lat-body">${s ? stationHtml(s) : summaryHtml()}</div>`;
  }

  // ── The summary ──

  function tile(label, value, sub, cls) {
    return `<div class="adm-kpi lat-kpi${cls ? ' ' + cls : ''}"><div class="adm-kpi-label">${label}</div>
      <div class="adm-kpi-value">${value}</div><div class="adm-kpi-sub">${sub}</div></div>`;
  }

  function swatch(key, mode) {
    const b = (BANDS[mode] || []).find(x => x.k === key);
    if (b) return `<span class="lat-key" style="--dot:${b.fill}" aria-hidden="true"></span>`;
    return `<span class="lat-key lat-key--${esc(key)}" aria-hidden="true"></span>`;
  }

  function summaryHtml() {
    const t = summary();
    const mode = U.mode;
    const now = classesAt || now_();
    const glance = HealthGlance.counts ? HealthGlance.counts() : { status: 'idle' };
    const scope = U.scope === 'view' ? 'in view' : 'on the map';
    const head = `
      <div class="lat-sum-head">
        <h4 class="lat-h" id="lat-h-sum">${num(t.n)} station${t.n === 1 ? '' : 's'} ${scope}</h4>
        ${seg('Which stations', [['view', 'In view', 'The stations in the map’s view — move the map and this follows'], ['all', 'Whole map', 'Every station the map draws']], U.scope, 'setScope')}
      </div>`;
    if (!t.n) {
      return head + `<p class="small lat-empty">No stations ${scope}. Move the map, or look at the whole map.</p>`;
    }
    const ageTiles = !netKnown() && !W.A
      ? tile('Heard in the last hour', '…', glance.status === 'error' ? 'the datastore could not be asked' : 'asking when each was last heard')
        + tile('Quiet over a day', '…', '')
      : tile('Heard in the last hour', `${num(t.hour)} <small>of ${num(t.heard)}</small>`,
          `${pct(t.hour, t.heard)}% of those ever heard${t.never ? ` · ${num(t.never)} never heard` : ''}`,
          t.heard && t.hour / t.heard >= 0.5 ? 'adm-kpi--ok' : '')
        + tile('Quiet over a day', num(t.day),
          t.day ? `${num(t.week)} of them over a week · median age ${esc(t.medAge != null ? fmtSpan(t.medAge) : '—')}`
                : `median age ${esc(t.medAge != null ? fmtSpan(t.medAge) : '—')}`,
          t.day ? 'adm-kpi--warn' : 'adm-kpi--ok');
    const winTiles = W.A
      ? tile('Delay to the database', t.delay ? esc(fmtDelay(t.delay.p50)) : '—',
          t.delay ? `median of ${num(t.delay.n)} transmissions · 95% within ${esc(fmtDelay(t.delay.p95))}` : 'nothing heard in the window',
          t.delay && t.delay.p50 > 120 ? 'adm-kpi--warn' : '')
        + tile('Checks received', t.checks.due ? `${pct(t.checks.got, t.checks.due)}%` : '—',
          t.checks.due ? `${num(t.checks.got)} of ${num(t.checks.due)} · ${num(t.checks.missed)} missed${t.checks.net ? ` · ${num(t.checks.net)} network-wide` : ''}`
                       : 'no check schedule learned here',
          t.checks.due && t.checks.missed / t.checks.due > 0.1 ? 'adm-kpi--warn' : t.checks.due ? 'adm-kpi--ok' : '')
      : tile('Delay to the database', '…', W.status === 'error' ? 'the readings could not be fetched' : 'fetching the readings')
        + tile('Checks received', '…', '');
    return head + `<div class="adm-kpis lat-kpis">${ageTiles}${winTiles}</div>` + barsHtml(t, mode, now)
      + receiversHtml() + netEventsHtml() + footHtml(mode);
  }

  // The scope by band, for the mode the pins wear — the legend, counted, and
  // each row the way to the stations in it.
  function barsHtml(t, mode, now) {
    if (mode !== 'age' && !W.A) return '';
    const bands = BANDS[mode].map(b => ({ k: b.k, label: b.label, n: t.bands.get(b.k) || 0 }));
    const other = specialsFor(mode).map(k => ({ k, label: k === 'unknown' ? UNKNOWN_LABEL[mode] : SPECIAL[k].label, n: t.bands.get(k) || 0 }))
      .filter(r => r.n);
    // The bars are read against each other, so they are scaled to the bands
    // alone: a thousand stations nobody has heard would make every band a sliver.
    const max = Math.max(1, ...bands.map(r => r.n));
    const h = 'lat-h-bars';
    const list = listFor(t, U.band);
    const pick = U.band ? bands.concat(other).find(r => r.k === U.band) : null;
    const shown = list.slice(0, LIST_N);
    const row = (r, bar) => `
        <li><button type="button" class="lat-bar${U.band === r.k ? ' is-on' : ''}" aria-pressed="${U.band === r.k}"
                data-lat-f="${escAttr('band:' + r.k)}" ${r.n ? '' : 'disabled'}
                onclick="MapLatency.pickBand('${escAttr(r.k)}')"
                title="${escAttr(r.n ? `List the ${r.n} station${r.n === 1 ? '' : 's'} ${r.label}` : `None ${r.label}`)}">
          ${swatch(r.k, mode)}<span class="lat-bar-label">${esc(r.label)}</span>
          ${bar ? `<span class="lat-bar-track" aria-hidden="true"><span class="lat-bar-fill" style="width:${(100 * r.n / max).toFixed(1)}%;--dot:${escAttr(barColour(r.k, mode))}"></span></span>` : ''}
          <span class="lat-bar-n">${num(r.n)}</span></button></li>`;
    return `
      <h4 class="lat-h" id="${h}">${esc(MODES[mode].head)}</h4>
      <ul class="lat-bars" aria-labelledby="${h}">${bands.map(r => row(r, true)).join('')}</ul>
      ${other.length ? `<ul class="lat-bars lat-bars--other" aria-label="Not on that scale">${other.map(r => row(r, false)).join('')}</ul>` : ''}
      <h5 class="lat-h5">${pick ? `${esc(pick.label[0].toUpperCase() + pick.label.slice(1))} — ${num(list.length)}` : `${esc(MODES[mode].worst)} ${esc(scopeWord())}`}</h5>
      ${shown.length ? `<ol class="lat-list">${shown.map(r => `
        <li><button type="button" class="link-btn" data-lat-f="${escAttr('stn:' + r.s.id)}"
                onclick="MapLatency.focus('${escAttr(r.s.id)}')" title="Show ${escAttr(r.s.name || r.s.id)} on the map, and its latency here">${esc(r.s.name || r.s.id)}</button>
          <span class="lat-list-v">${swatch(r.c.key, mode)} ${esc(valueText(r.c, mode, now))}</span></li>`).join('')}</ol>
        ${list.length > shown.length ? `<p class="small txt-muted">…and ${num(list.length - shown.length)} more. Zoom the map in to narrow it down.</p>` : ''}`
        : '<p class="small txt-muted">None.</p>'}`;
  }
  const scopeWord = () => (U.scope === 'view' ? 'in view' : 'on the map');
  function barColour(k, mode) {
    const b = (BANDS[mode] || []).find(x => x.k === k);
    if (b) return b.fill;
    return k === 'quiet' ? RAMP[6] : '#7b8189';
  }

  // The receivers, and how long each takes to deliver — the network's half of
  // delay, where a queue behind one base station shows up as one row.
  function receiversHtml() {
    if (!W.A || !(W.A.receivers || []).length) return '';
    const now = W.t1 || now_();
    const rx = W.A.receivers.slice(0, 12);
    return `
      <h4 class="lat-h" id="lat-h-rx">Receivers over ${esc(fmtSpan(W.t1 - W.t0))}</h4>
      <div class="lat-table-wrap"><table class="lat-table" aria-labelledby="lat-h-rx">
        <thead><tr><th scope="col">Receiver</th><th scope="col" class="num">Readings</th>
          <th scope="col" class="num" title="Median time from being heard to reaching the database">Delay</th>
          <th scope="col" class="num" title="95 in every 100 readings reached the database within this">95%</th>
          <th scope="col" class="num">Last</th></tr></thead>
        <tbody>${rx.map(h => `<tr>
          <td><span class="mono" title="${escAttr(h.host)}">${esc(hostLabel(h.host))}</span></td>
          <td class="num">${num(h.n)}</td>
          <td class="num${h.lag && h.lag.p50 > 120 ? ' txt-warn' : ''}">${esc(fmtDelay(h.lag ? h.lag.p50 : null))}</td>
          <td class="num">${esc(fmtDelay(h.lag ? h.lag.p95 : null))}</td>
          <td class="num${now - h.last > HOUR ? ' txt-warn' : ''}">${esc(now - h.last < 90 * SEC ? 'now' : fmtSpan(now - h.last))}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  function netEventsHtml() {
    const ev = W.A && W.A.netEvents;
    if (!ev || !ev.length) return '';
    const last = ev.slice(-4).reverse();
    return `<p class="small lat-net"><span aria-hidden="true">⚠</span> ${num(ev.length)} moment${ev.length === 1 ? '' : 's'} when most of the
      network missed its checks at once — the receivers, a channel or interference, not the stations:
      ${last.map(e => `${esc(fmtWhen(e.from))} (${num(e.missed)} of ${num(e.due)})`).join(', ')}.</p>`;
  }

  function footHtml(mode) {
    const what = {
      age: 'Age is how long since Flood-Net last heard each station — from the ingest’s record, so it reaches back further than the window.',
      delay: 'Delay is how long a reading takes from being heard to reaching the database — each transmission’s first copy to land, the median over the window.',
      checks: 'Checks are each station’s timed reports, learned from its own rhythm. A miss counts only while a receiver that hears it was listening, and one most of the network missed at once is the network’s.',
    }[mode];
    return `<p class="small txt-muted lat-foot">${esc(what)} Pick a station on the map to see its checks slot by slot.</p>`;
  }

  // ── One station ──

  function stationHtml(s) {
    const now = now_();
    const c = classify(s, U.mode, now);
    const ca = classify(s, 'age', now);
    const last = ca.last;
    const S = W.A ? W.A.stations.get(s.id) : null;
    const st = S ? statsOf(S) : null;
    const sch = S && S.schedule;
    const k = MapSymbols.kind ? MapSymbols.kind(s) : null;
    const what = [
      s.station_number ? `No. ${esc(s.station_number)}` : '',
      k && k.river ? 'river height gauge' : k && k.rain ? 'rain gauge' : '',
      k && k.manual ? 'read by hand' : k && k.tm ? 'TM station' : '',
    ].filter(Boolean).join(' · ');
    const role = k && k.role === 'forecast' ? '<span class="lat-pill lat-pill--forecast">Forecast location</span>'
      : k && k.role === 'information' ? '<span class="lat-pill lat-pill--info">Information location</span>' : '';
    const back = `<button type="button" class="link-btn lat-back" data-lat-f="back" onclick="MapLatency.back()">
      <span aria-hidden="true">←</span> The stations ${esc(scopeWord())}</button>`;
    const head = `${back}
      <div class="lat-stn-head"><h4 class="lat-h" id="lat-h-stn">${esc(s.name || s.id)}</h4>${role}</div>
      ${what ? `<p class="small txt-muted lat-stn-what">${what}</p>` : ''}`;

    // Last heard, against its checks.
    let ageSub = '';
    if (last == null) ageSub = ca.key === 'offair' ? 'read by hand or by modem — the radio does not hear it' : ca.key === 'asking' ? 'asking…' : 'Flood-Net’s receivers have not heard it';
    else {
      ageSub = esc(fmtWhen(last, now));
      const gone = sch ? Math.floor((now - last) / sch.P) : 0;
      if (gone >= 2) ageSub += ` · <span class="txt-warn">${num(gone)} checks gone by</span>`;
    }
    const ai = ca.band ? BANDS.age.indexOf(ca.band) : -1;
    const ageTile = tile('Last heard', last == null ? (ca.key === 'asking' ? '…' : 'never') : esc(fmtAge(now - last)),
      ageSub, ai < 0 ? '' : ai <= 2 ? 'adm-kpi--ok' : ai >= 4 ? 'adm-kpi--warn' : '');
    const delayTile = !W.A ? tile('Delay', '…', W.status === 'error' ? 'the readings could not be fetched' : 'fetching the readings')
      : st && st.delay ? tile('Delay', esc(fmtDelay(st.delay.p50)),
          `median of ${num(st.delay.n)} · 95% within ${esc(fmtDelay(st.delay.p95))} · newest ${esc(fmtDelay(st.delay.newest.d))}`,
          st.delay.p50 > 120 ? 'adm-kpi--warn' : '')
      : tile('Delay', '—', S ? 'no arrival times in the window' : `nothing from it in the last ${esc(winOf(U.win)[1])}`);
    const checkTile = !W.A ? tile('Checks', '…', '')
      : sch ? tile('Checks received', st.checks.due ? `${pct(st.checks.hits + st.checks.partial, st.checks.due)}%` : '—',
          `every ${esc(HealthAnalysis.fmtPeriod(sch.P))} · ${num(st.checks.hits + st.checks.partial)} of ${num(st.checks.due)}, ${num(st.checks.misses)} missed`
            + (st.checks.net ? `, ${num(st.checks.net)} network-wide` : '') + (st.checks.partial ? ` · ${num(st.checks.partial)} with frames lost` : ''),
          st.checks.due && st.checks.misses / st.checks.due > 0.1 ? 'adm-kpi--warn' : st.checks.due ? 'adm-kpi--ok' : '')
      : tile('Checks', '—', S ? `no regular schedule learned from ${num((S.bursts || []).length)} report${(S.bursts || []).length === 1 ? '' : 's'} — it may report on events only`
                              : 'nothing from it in the window');

    // The fourth: when its next check is due, while its schedule is known —
    // the time to watch the map for it — else how many receivers carry it.
    const nextTile = sch ? tile('Next check', esc(fmtHm(nextCheck(sch, now))),
        `in ${esc(nextCheck(sch, now) - now < 90 * SEC ? 'a minute' : fmtSpan(nextCheck(sch, now) - now))} · at ${esc(slotTimes(sch))}`)
      : st && st.paths.length ? tile('Heard through', `${num(st.paths.length)} <small>receiver${st.paths.length === 1 ? '' : 's'}</small>`,
        esc(st.paths.map(p => hostLabel(p.path)).slice(0, 2).join(', ')))
      : '';
    let body = `<div class="adm-kpis lat-kpis">${ageTile}${delayTile}${checkTile}${nextTile}</div>`;
    if (c.band || SPECIAL[c.key]) {
      body += `<p class="small lat-stn-band">${swatch(c.key, U.mode)} On the map now: <b>${esc(c.band ? c.band.label
        : c.key === 'unknown' ? UNKNOWN_LABEL[U.mode] : (SPECIAL[c.key].label || ''))}</b> — ${esc(MODES[U.mode].long)}.</p>`;
    }
    if (W.A && !S) {
      const longer = WINDOWS.filter(w => w[2] > winOf(U.win)[2]);
      body += `<p class="small">Nothing from it in the last ${esc(winOf(U.win)[1])}${last != null && last < W.t0 ? `; it was last heard ${esc(fmtWhen(last, now))}` : ''}.
        ${longer.length ? `${longer.map(([kk, label]) => `<button type="button" class="link-btn" data-lat-f="${escAttr('win:' + kk)}" onclick="MapLatency.setWin('${kk}')">Look back ${esc(label)}</button>`).join(' · ')}` : ''}</p>`;
    }
    if (sch && S.slots && S.slots.length) body += stripHtml(S);
    if (st && st.series.length) body += delayChartHtml(s, st);
    if (st && st.paths.length) body += pathsHtml(st);
    body += `<div class="button-group lat-stn-links">
        <button type="button" class="ghost" data-lat-f="health" onclick="MapLatency.openHealth('${escAttr(s.id)}')"
                title="The Station Health tab on this station — its findings, battery and the network at any missed check">Open in Station Health</button>
      </div>`;
    return head + body;
  }

  function nextCheck(sch, now) {
    return sch.phase + Math.ceil((now - sch.phase) / sch.P) * sch.P;
  }
  // A day's first few slot times, from the phase: "00:27, 00:57, 01:27 …".
  function slotTimes(sch) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const base = day0.getTime();
    const out = [];
    for (let t = sch.phase + Math.ceil((base - sch.phase) / sch.P) * sch.P; t < base + DAY && out.length < 3; t += sch.P) out.push(fmtHm(t));
    return out.join(', ') + (DAY / sch.P > 3 ? ' …' : '');
  }

  // The available width for a drawing in the pane: what the pane measures,
  // or the default pane's when it is not on screen to be measured.
  function paneWidth() {
    const w = root ? root.clientWidth : 0;
    return Math.max(260, (w || 450) - 4);
  }

  // Its checks, slot by slot, a row a day — the Station Health tab's strip,
  // fitted to the pane: a column of misses at the same hour every night is a
  // battery, a run of them an outage, scattered ones a path.
  function stripHtml(S) {
    const slots = S.slots;
    const P = S.schedule.P;
    const days = new Map();
    slots.forEach(sl => {
      const d = new Date(sl.t); d.setHours(0, 0, 0, 0);
      const k = d.getTime();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(sl);
    });
    const perDay = Math.max(1, Math.round(DAY / P));
    const labW = 74, gap = 2;
    const pitch = Math.max(5, Math.min(18, Math.floor((paneWidth() - labW) / perDay)));
    // Square cells while there is room; past that, narrower but never shorter
    // than a finger's worth of target or a row's label.
    const cell = pitch - gap, cellH = Math.max(cell, 10), rowH = Math.max(cellH + 4, 15);
    const W_ = labW + perDay * pitch, H_ = days.size * rowH + 16;
    const rows = [...days.entries()].sort((a, b) => a[0] - b[0]);
    let svg = '';
    // The hours along the top — where in its day a miss fell — as often as
    // there is room for "06:00" between them.
    const every = [3, 6, 12].find(h => (h * HOUR / P) * pitch >= 34);
    for (let h = 0; every && h < 24; h += every) {
      const x = labW + (h * HOUR / P) * pitch;
      svg += `<text class="hl-axis" x="${x.toFixed(1)}" y="10">${p2(h)}:00</text>`;
    }
    rows.forEach(([d0, list], r) => {
      const y = 16 + r * rowH;
      svg += `<text class="hl-axis" x="0" y="${y + cellH - 1}">${esc(fmtDay(d0))}</text>`;
      list.forEach(sl => {
        const i = Math.min(perDay - 1, Math.floor((sl.t - d0) / P));
        const x = labW + i * pitch;
        const o = OUTCOME[sl.outcome] || OUTCOME.unknown;
        svg += `<rect class="hl-slot ${o.cls}" x="${x}" y="${y}" width="${cell}" height="${cellH}" rx="1.5"><title>${esc(fmtWhen(sl.t))} — ${esc(o.label)}${sl.missing && sl.missing.length ? ' (no ' + esc(sl.missing.join(', ')) + ')' : ''}</title></rect>`;
        if (sl.outcome === 'miss' && cell >= 7) {
          svg += `<path class="hl-slot-x" d="M${x + 2} ${y + 2}L${x + cell - 2} ${y + cellH - 2}M${x + cell - 2} ${y + 2}L${x + 2} ${y + cellH - 2}"/>`;
        }
      });
    });
    const c = S.schedule.counts;
    const missed = slots.filter(sl => sl.outcome === 'miss').slice(-10).reverse();
    const nets = slots.filter(sl => sl.outcome === 'net').length;
    return `
      <h4 class="lat-h" id="lat-h-strip">Its checks, slot by slot</h4>
      <div class="hl-strip-wrap lat-strip-wrap">
        <svg class="lat-strip" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" role="img"
             aria-label="${escAttr(`${S.st.name}: ${slots.length} check slots, every ${HealthAnalysis.fmtPeriod(P)}, a row a day — ${c.hits} received, ${c.partial} with frames lost, ${c.misses} missed${c.net ? `, ${c.net} missed network-wide` : ''}${c.unknown ? `, ${c.unknown} with no receiver listening` : ''}. The missed ones are listed under it.`)}">${svg}</svg>
      </div>
      <div class="qs-legend">${Object.values(OUTCOME).map(o => `<span><i class="hl-key ${o.cls}" aria-hidden="true"></i>${esc(o.label)}</span>`).join('')}</div>
      <p class="small lat-missed">${missed.length
        ? `Missed while a receiver that hears it was listening${c.misses > missed.length ? ` — the latest ${num(missed.length)} of ${num(c.misses)}` : ''}: ${missed.map(sl => esc(fmtWhen(sl.t))).join(', ')}.`
        : 'No check missed while a receiver that hears it was listening.'}${nets ? ` ${num(nets)} more went when most of the network missed at once.` : ''}</p>`;
  }

  // Its readings' delay, one dot a transmission, on a log scale from a second
  // to an hour: a band along the bottom is a receiver posting as it hears; a
  // band at a minute, a base station posting in batches; dots climbing to an
  // hour, a queue that had to drain.
  function delayChartHtml(s, st) {
    const W_ = paneWidth(), H_ = 132, L = 38, R = 6, T = 8, B = 20;
    const t0 = W.t0, t1 = W.t1;
    const lo = Math.log10(1), hi = Math.log10(3600);
    const x = t => L + (W_ - L - R) * (t - t0) / Math.max(1, t1 - t0);
    const y = d => {
      const v = Math.log10(Math.min(3600, Math.max(1, d)));
      return T + (H_ - T - B) * (1 - (v - lo) / (hi - lo));
    };
    let g = '';
    [[1, '1 s'], [10, '10 s'], [60, '1 min'], [600, '10 min'], [3600, '1 h']].forEach(([v, label]) => {
      const yy = y(v).toFixed(1);
      g += `<line class="lat-grid" x1="${L}" x2="${W_ - R}" y1="${yy}" y2="${yy}"/><text class="hl-axis" x="${L - 4}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${label}</text>`;
    });
    // A tick a day along the bottom.
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    const step = t1 - t0 > 3 * DAY ? DAY : t1 - t0 > DAY ? 12 * HOUR : 6 * HOUR;
    for (let t = d0.getTime(); t <= t1; t += step) {
      if (t < t0) continue;
      const xx = x(t).toFixed(1);
      const lab = step >= DAY || new Date(t).getHours() === 0 ? fmtDay(t).replace(/,.*$/, '') : fmtHm(t);
      g += `<line class="lat-grid" x1="${xx}" x2="${xx}" y1="${T}" y2="${H_ - B}"/><text class="hl-axis" x="${xx}" y="${H_ - 6}" text-anchor="middle">${esc(lab)}</text>`;
    }
    const pts = st.series;
    // Thousands of dots are one path, not thousands of elements.
    let d = '';
    pts.forEach(p => { const xx = x(p.t).toFixed(1), yy = y(p.d).toFixed(1); d += `M${xx} ${yy}h0.01`; });
    const med = y(st.delay.p50).toFixed(1);
    const lateN = pts.filter(p => p.d > 300).length;
    return `
      <h4 class="lat-h" id="lat-h-delay">Its delay, reading by reading</h4>
      <svg class="lat-delay" viewBox="0 0 ${W_} ${H_}" width="${W_}" height="${H_}" role="img"
           aria-label="${escAttr(`${s.name}: ${pts.length} transmissions over ${fmtSpan(t1 - t0)}; the median reached the database ${fmtDelay(st.delay.p50)} after it was heard, 95% within ${fmtDelay(st.delay.p95)}, the slowest ${fmtDelay(st.delay.max)}${lateN ? `; ${lateN} took over five minutes` : ''}. Its receivers are listed under it.`)}">
        ${g}
        <line class="lat-med" x1="${L}" x2="${W_ - R}" y1="${med}" y2="${med}"/>
        <path class="lat-dots" d="${d}"/>
      </svg>
      <p class="small txt-muted lat-cap">One dot a transmission: from being heard to the database, the first copy to land. The dashed line is the median, ${esc(fmtDelay(st.delay.p50))}${lateN ? `; <span class="txt-warn">${num(lateN)} took over five minutes</span>` : ''}.</p>`;
  }

  function pathsHtml(st) {
    return `
      <h4 class="lat-h" id="lat-h-paths">Heard through</h4>
      <div class="lat-table-wrap"><table class="lat-table" aria-labelledby="lat-h-paths">
        <thead><tr><th scope="col">Receiver</th><th scope="col" class="num">Copies</th>
          <th scope="col" class="num" title="Median time from being heard to reaching the database, through this receiver">Delay</th>
          <th scope="col" class="num">95%</th></tr></thead>
        <tbody>${st.paths.slice(0, 8).map(p => `<tr>
          <td><span class="mono" title="${escAttr(p.path)}">${esc(hostLabel(p.path))}</span></td>
          <td class="num">${num(p.n)}</td>
          <td class="num${p.p50 > 120 ? ' txt-warn' : ''}">${esc(fmtDelay(p.p50))}</td>
          <td class="num">${esc(fmtDelay(p.p95))}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  function rootEl() {
    if (root && document.contains(root)) return root;
    root = document.getElementById('map-latency-panel');
    return root;
  }
  const onScreen = () => { const r = rootEl(); return !!(r && r.getClientRects().length); };

  // The pane again, keeping focus on the same control (data-lat-f) — a
  // repaint replaces every button in it, the pressed one included.
  function paint() {
    const r = rootEl();
    if (!r) return;
    const a = document.activeElement;
    const had = a && r.contains(a) ? (a.dataset && a.dataset.latF) || null : null;
    const scroller = r.closest('.dock-pane') || null;
    const top = scroller ? scroller.scrollTop : 0;
    r.innerHTML = paneHtml();
    paintedW = r.clientWidth;
    if (scroller) scroller.scrollTop = top;
    if (had) {
      const to = r.querySelector(`[data-lat-f="${CSS.escape(had)}"]`) || (had.startsWith('stn:') || had === 'back' ? r.querySelector('#lat-h-stn, #lat-h-sum') : null);
      if (to) {
        if (!to.matches('button, input, a[href], [tabindex]')) to.tabIndex = -1;
        to.focus({ preventScroll: true });
      }
    }
  }
  function paintSoon() {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 120);
  }
  function paintStatus() {
    const el = document.getElementById('lat-status');
    if (el) el.innerHTML = statusHtml();
  }
  let statusTimer = null;
  function paintStatusSoon() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; paintStatus(); }, 150);
  }

  // The map moved: the summary is about what is in view.
  function onMove() {
    if (U.sel || U.scope !== 'view' || !onScreen()) return;
    paintSoon();
  }

  // ── The station on the card ───────────────────────────────────────────────

  // From the station card, every time it is painted or shut: the pane is about
  // the station the card is on. Only a change counts — the card repaints on a
  // save, a filter keystroke, the trail — so "← The stations in view" stays
  // pressed until another station is picked.
  function follow(id) {
    const v = id || null;
    if (v === U.lastCard) return;
    U.lastCard = v;
    U.sel = v;
    if (onScreen()) paint();
  }

  // Back to the summary. The card stays where it is: it is the map's, and
  // this pane only follows it. Focus lands on the summary's heading (paint).
  function back() {
    U.sel = null;
    paint();
  }

  // A station pressed in the pane: on the map with its card, and here.
  function focus(id) {
    const s = stationById(id);
    if (!s) return;
    U.sel = id;
    U.lastCard = id;
    if (typeof focusStationOnMap === 'function' && state.map) focusStationOnMap(s, document.activeElement);
    paint();
    const h = document.getElementById('lat-h-stn');
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }

  function openHealth(id) {
    if (HealthGlance.open) HealthGlance.open(id, 'checks');
  }

  // ── The pane coming into view ─────────────────────────────────────────────

  // From renderDock(), as the pane is shown: it asks for whatever is stale.
  // Run after the render that showed it — the pane can come into view while the
  // map that owns it is being built, when the side panel puts back the pane it
  // was showing last time.
  function shown() {
    setTimeout(() => {
      if (state.activeTab !== 'stations') return;
      if (HealthGlance.askNet) HealthGlance.askNet();
      ensureWindow(false);
      paint();
    }, 0);
  }

  // From the strip's ⏱️, pressed open: the first time in a session it turns the
  // view on — opening the tool is asking for the view. Not when the side panel
  // merely puts the pane back as a page loads (shown), and not once the switch
  // in the pane has been used: then that is the answer.
  function opened() {
    if (U.autoOn) return;
    U.autoOn = true;
    if (!U.on) setOn(true, { auto: true });
  }

  // ── The legend, the map's name, Map display's note ────────────────────────

  function legendHtml() {
    if (!U.on) return '';
    const mode = U.mode;
    const t = (mode === 'age' && (netKnown() || W.A)) || (mode !== 'age' && W.A) ? summary() : null;
    const rows = BANDS[mode].map(b => ({ k: b.k, label: b.label }))
      .concat(specialsFor(mode).map(k => ({ k, label: k === 'unknown' ? UNKNOWN_LABEL[mode] : SPECIAL[k].label })));
    return `<span class="legend-item legend-lat-h"><span class="small"><strong>⏱️ Latency — ${esc(MODES[mode].long)}</strong></span></span>`
      + rows.map(r => `
      <span class="legend-item">
        ${swatch(r.k, mode)}
        <span class="small">${esc(r.label[0].toUpperCase() + r.label.slice(1))}${t ? ` <span class="txt-muted">(${num(t.bands.get(r.k) || 0)})</span>` : ''}</span>
      </span>`).join('') + `
      <span class="legend-item legend-off">
        <span class="small txt-muted">Pins are coloured by latency, not by role${t && U.scope === 'view' ? ' — counted in view' : ''}. The worse bands are a step bigger.
          Shapes and the forecast and information outlines are as always. ⏱️ Latency in the side panel says more.</span>
      </span>`;
  }

  // A clause for the map's accessible name while the pins wear it.
  function altText() {
    if (!U.on) return '';
    if (U.mode !== 'age' && !W.A) return `pins coloured by latency (${MODES[U.mode].label.toLowerCase()}) once the readings are in`;
    return `pins coloured by latency, ${MODES[U.mode].long} — ${summaryText().replace(/\.$/, '')}`;
  }

  // What Map display's health switch says while this view has the pins.
  function noteText() {
    return U.on ? 'Off — the pins are coloured by latency (⏱️ Latency, in the side panel).' : '';
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function attach(m) {
    map = m;
    root = null;
    MapChrome.panel(m, {
      id: 'latency', icon: '⏱️', title: 'Latency',
      btnLabel: 'Latency — colour the pins by how fresh each station’s data is, and see its checks slot by slot',
      group: 'show', order: 40,
      html: () => `<div class="lat-pane" id="map-latency-panel">${paneHtml()}</div>`,
      onMount(el) { root = el.querySelector('#map-latency-panel'); },
    });
    m.on('moveend', onMove);
    // Last-heard times landing repaint the pins the age colouring is made of.
    if (!netHooked && HealthGlance.onNet) {
      netHooked = true;
      HealthGlance.onNet(() => { dirty(); if (U.on && U.mode === 'age') repins(); else paintSoon(); });
    }
    // A pane made wider or narrower draws its strip and chart again at the new
    // width, so their text stays the size it says.
    if (!resizeObs && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        const r = rootEl();
        if (!r || !U.sel || !r.clientWidth) return;
        if (Math.abs(r.clientWidth - paintedW) > 24) paintSoon();
      });
    }
    setTimeout(() => { const r = rootEl(); if (r && resizeObs) resizeObs.observe(r); }, 0);
  }

  function detach() {
    if (map) { try { map.off('moveend', onMove); } catch (_) {} }
    if (resizeObs) resizeObs.disconnect();
    map = null;
    root = null;
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
    if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; }
  }

  return {
    attach, detach, reset, shown, opened, follow, pinStyle,
    legendHtml, altText, noteText,
    on: () => U.on,
    mode: () => U.mode,
    setOn, setMode, setWin, setScope, pickBand, back, focus, refresh, openHealth, yieldTo,
    // The rules, for test/latency.mjs.
    classifyValue, quantile, BANDS, SPECIAL, fmtDelay,
    classOf: id => { const s = stationById(id); return s ? classOf(s) : null; },
    _state: () => ({ on: U.on, mode: U.mode, win: U.win, scope: U.scope, sel: U.sel, band: U.band,
                     window: { key: W.key, status: W.status, rows: W.rows, borrowed: W.borrowed, error: W.error } }),
  };
})();

if (typeof window !== 'undefined') window.MapLatency = MapLatency;
