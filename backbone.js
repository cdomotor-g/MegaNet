// MegaNet — backbone.js
//
//   Backbone   the Backbone tab, headed "State of the backbone": the repeaters
//              that carry the network's readings to the base stations, each
//              with what has gone wrong with it over a period picked (7 to 90
//              days, 30 by default) — off air, dropping out, relaying corrupted
//              copies, a carrier that is off the fleet or will not stay put,
//              its power, and its pass ranges against what it really relays —
//              ranked by the sum of it, worst first, and inside each repeater
//              its issues ranked by how much each one matters. A summary first
//              (every repeater and its one or two key issues, a bar of its
//              score, a map), then a section a repeater: a timeline of the
//              period, each issue with its evidence, and what they point to.
//
// ── Where it comes from ──────────────────────────────────────────────────────
// Nothing new is measured here. This gathers, repeater by repeater, what the
// network's other tools already find, and reads it all again every fifteen
// minutes while the tab is open, so the page is the period up to now:
//
//   health_finding (0059)        Station Health's findings with when each
//                                opened and cleared: the repeater's own station
//                                silent, the stations behind it gone quiet
//                                together (repeater-down), an area silence it
//                                was part of, its battery — and the server's
//                                transmitter findings (0075, 0077, 0078, 0083):
//                                off channel, drifting, corrupting, its signal
//                                fading.
//   transmitter_summary (0077)   its carrier against the fleet, day by day: the
//                                fingerprint every burst it relays carries.
//   recent_flips() (0078)        every corrupted copy that came on its carrier
//                                in the period — as strong as the clean copy or
//                                not, the clean one reaching us another way or
//                                not, and at what hours.
//   flip_summary, flip_sources   what it sent in the last week, and its share
//   (0078, 0079)                 of the corrupted copies by pass range — the
//                                circumstantial side, for a repeater no carrier
//                                has caught.
//   reading_daily, station_health   its own sensors' reports day by day, and
//                                when it was last heard.
//   Signal Routes (editors)      its pass ranges on record set against the air
//                                (signal-routes.js), when the receptions have
//                                been read this session — or read from here.
//
// All but the last are public: none names a receiver. So the tab works for
// anybody, signed in or not; the pass ranges against the air need an editor.
// The stations behind a repeater are the register's: field stations whose
// addresses its pass ranges hold, within REACH_KM of it, and of those the ones
// no other repeater on record passes ("only it").
//
// ── How it is ranked ─────────────────────────────────────────────────────────
// Each issue scores its severity (critical 10, warning 4, note 1) × how much
// of the network leans on the repeater (1 to 2.5: the stations only it passes
// in full and the rest a quarter, on a log scale) × whether it is still going
// on (1; ½ for one that cleared in the period; ¾ for a run of dropouts, which
// is a habit rather than an event) × what kind of trouble it is (off air 1.2,
// corrupted relays 1, its signal fading 0.9, dropping out and power 0.8,
// carrier 0.7, pass ranges 0.5) — and corrupted copies count up to half again as much as they mount.
// A repeater's score is the sum of its issues', which is what ranks it; its
// state is the worst of what is still going on. docs/backbone.md has the rest.
//
// After core.js, datastore.js (dbSelect, dbRpc), app.js (repeaterList,
// stationAlertIds, passRangeCoversId, goToStation, switchTab), health.js
// (Health.showStation) and signal-routes.js (SignalRoutes), all read at call
// time; before init.js. Nothing runs at load: app.js's renderMain calls
// render() and init().

const Backbone = (() => {

  const HOUR = 3600e3, DAY = 24 * HOUR;
  const PERIODS = [7, 14, 30, 60, 90];
  const DEFAULT_DAYS = 30;
  const DAYS_KEY = 'mn-backbone-days';
  const REFRESH_MS = 15 * 60e3;
  const PAGE = 1000;                 // PostgREST's max rows per request on this project
  const ID_CHUNK = 50;               // station ids in one in.(…) list
  const FLIP_CALLS = 14;             // repeaters whose corrupted copies are read one by one
  const PARALLEL = 4;
  const REACH_KM = 150;              // a field station further than this is not behind a repeater
  const SR_DAYS = 7;                 // the receptions read for the pass ranges against the air
  const TOP = 12;                    // repeaters in the summary and sections until "Show all"

  const SEV_W = { critical: 10, warn: 4, info: 1 };
  const SEV_RANK = { critical: 0, warn: 1, info: 2 };
  const SEV = {
    critical: { label: 'Critical', icon: '⛔', cls: 'txt-bad' },
    warn:     { label: 'Warning',  icon: '⚠',  cls: 'txt-warn' },
    info:     { label: 'Note',     icon: 'ℹ',  cls: 'txt-muted' },
  };
  // What kind of trouble an issue is: its weight in the score, and the colour
  // its share of a repeater's bar is drawn in (styles.css, .bk-c-*).
  const CATS = {
    air:     { label: 'Off air',          w: 1.2 },
    bits:    { label: 'Corrupted relays', w: 1.0 },
    signal:  { label: 'Signal',           w: 0.9 },
    drops:   { label: 'Dropping out',     w: 0.8 },
    power:   { label: 'Power',            w: 0.8 },
    carrier: { label: 'Carrier',          w: 0.7 },
    ranges:  { label: 'Pass ranges',      w: 0.5 },
  };
  const CAT_ORDER = ['air', 'bits', 'signal', 'drops', 'power', 'carrier', 'ranges'];
  const BATTERY = ['battery-critical', 'battery-low', 'battery-no-charge', 'battery-falling', 'battery-overcharge'];
  const NET_KINDS = ['repeater-down', 'area-silence', 'shared-spell'];
  const F_COLS = 'id,source,kind,subject,station_id,severity,title,detail,evidence,first_seen,last_seen,cleared_at';
  const T_COLS = 'tx,via,freq_mhz,w_days,w_ppm,w_hz,b_days,b_ppm,change_ppm,bursts,receivers,days,ppm,judged_at';
  const FS_COLS = 'tx,station_id,bursts,flips,rate,clear,clear_rate,clean_upstream,addr_flips,addresses,top,fleet_rate,judged_at';

  const S = {
    days: DEFAULT_DAYS,
    phase: 'idle',       // idle | loading | ready | error
    err: '',
    raw: null,           // what was read
    A: null,             // the analysis
    demo: false,
    seq: 0,
    loadedAt: null,
    note: '',            // what could not be read, said under the summary
    timer: null,
    pick: null,          // the repeater picked on the map
    all: false,          // every repeater with a warning or worse, not the first TOP
    air: '',             // '' | 'loading' — reading the receptions for the pass ranges
    map: null, layer: null, fitted: false,
    readDays: false,     // the stored period has been read once
  };

  // ── Small things ──────────────────────────────────────────────────────────

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const pct = r => (r == null || !Number.isFinite(Number(r)) ? '—' : `${(Number(r) * 100).toFixed(Number(r) < 0.1 ? 1 : 0)}%`);
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;
  const sgn = (v, d) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const ms = v => (v == null || v === '' ? null : typeof v === 'number' ? v : Date.parse(v));
  const placed = s => !!s && s.lat != null && s.lon != null && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon));
  const km = (a, b) => (placed(a) && placed(b) && typeof acmaHaversineKm === 'function'
    ? acmaHaversineKm(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon)) : null);
  const dayMs = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  const isoDay = t => new Date(t).toISOString().slice(0, 10);
  const median = xs => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const worstSev = list => list.reduce((w, x) => (SEV_RANK[x] < SEV_RANK[w] ? x : w), 'info');

  // Times as people say them, in the browser's own zone: "Mon 26 Oct, 2:15 pm".
  function when(t) {
    const d = new Date(t);
    return Number.isFinite(d.getTime())
      ? d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
  }
  function whenShort(t) {
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '—';
    const days = (Date.now() - d.getTime()) / DAY;
    return days < 6 ? d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  const dayLabel = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function span(msec) {
    const m = Math.round(msec / 60e3);
    if (m < 90) return `${m} min`;
    const h = msec / HOUR;
    if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
    return `${(msec / DAY).toFixed(1)} days`;
  }
  function readLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  // ── The register: the repeaters and the stations behind each ─────────────

  let regCache = null;
  function register() {
    const list = stations();
    if (regCache && regCache.list === list && regCache.n === list.length) return regCache;
    const reps = (typeof repeaterList === 'function' && typeof state !== 'undefined' && state.data
      ? repeaterList(list) : list.filter(s => (s.roles || []).includes('repeater') && s.repeater)).slice();
    const idsOf = s => (typeof stationAlertIds === 'function' ? stationAlertIds(s)
      : [...new Set((s.sensors || []).map(x => Number(x.alert_id)).filter(Number.isFinite))]);
    const covers = (rep, a) => {
      if (typeof passRangeCoversId === 'function') return passRangeCoversId(rep, a);
      const ex = (rep && rep.exclusions) || [];
      return ((rep && rep.pass_ranges) || []).some(r => a >= r.low && a <= r.high && !ex.some(e => a >= e.low && a <= e.high));
    };
    const members = new Map(reps.map(r => [r.id, []]));
    const carriers = new Map();
    list.forEach(s => {
      if (!(s.roles || []).includes('field')) return;
      const ids = idsOf(s).filter(a => a >= 0 && a <= 8191);
      if (!ids.length) return;
      const by = [];
      reps.forEach(r => {
        if (r.id === s.id) return;
        const d = km(r, s);
        if (d != null && d > REACH_KM) return;
        if (ids.some(a => covers(r.repeater, a))) by.push(r.id);
      });
      if (!by.length) return;
      carriers.set(s.id, by);
      by.forEach(id => members.get(id).push(s));
    });
    const byId = new Map();
    const out = reps.map(r => {
      const m = members.get(r.id) || [];
      const x = { id: r.id, st: r, rep: r.repeater, members: m, only: m.filter(s => (carriers.get(s.id) || []).length === 1),
        own: idsOf(r) };
      byId.set(r.id, x);
      return x;
    });
    regCache = { list, n: list.length, reps: out, byId, carriers };
    return regCache;
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  // A value list for in.(…), quoted, so an id with a comma or a dot is one id.
  const inList = ids => encodeURIComponent(`in.(${ids.map(id => `"${String(id).replace(/["\\]/g, '\\$&')}"`).join(',')})`);
  const chunks = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

  async function fetchAll(path, seq) {
    const out = [];
    for (let off = 0; ; off += PAGE) {
      if (seq !== S.seq) throw Object.assign(new Error('superseded'), { stale: true });
      const rows = await dbSelect(`${path}&limit=${PAGE}&offset=${off}`);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  async function pool(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, run));
    return out;
  }
  const quietly = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

  // Everything for the period up to now. `soft` keeps the page as it is while
  // it reads (the quarter-hourly refresh), rather than saying "Reading…".
  async function load(soft) {
    if (typeof dbSelect !== 'function') return;
    const reg = register();
    if (!reg.reps.length) { S.phase = 'error'; S.err = 'The station file has no repeaters in it.'; redraw(); return; }
    const seq = ++S.seq;
    if (!soft || !S.A) { S.phase = 'loading'; S.err = ''; redraw(); }
    const now = Date.now(), days = S.days, from = now - days * DAY;
    const iso = t => new Date(t).toISOString();
    // Open at some moment of the period: found before its end, cleared after its start or not yet.
    const overlap = `first_seen=lte.${iso(now)}&or=(cleared_at.is.null,cleared_at.gte.${iso(from)})`;
    const ids = reg.reps.map(r => r.id);
    try {
      const [own, network, openSilent, tsum, fsum, fsrc, daily, health] = await Promise.all([
        Promise.all(chunks(ids, ID_CHUNK).map(c => fetchAll(`health_finding?select=${F_COLS}&station_id=${inList(c)}&${overlap}&order=id.asc`, seq)))
          .then(x => x.flat()),
        fetchAll(`health_finding?select=${F_COLS}&kind=in.(${NET_KINDS.join(',')})&${overlap}&order=id.asc`, seq),
        quietly(fetchAll('health_finding?select=station_id,severity,first_seen&kind=eq.silent&cleared_at=is.null&order=id.asc', seq)),
        quietly(dbSelect(`transmitter_summary?select=${T_COLS}&limit=5000`)),
        quietly(dbSelect(`flip_summary?select=${FS_COLS}&flips=gt.0&limit=2000`)),
        quietly(dbSelect('flip_sources?select=period_days,data,built_at')),
        quietly(Promise.all(chunks(ids, ID_CHUNK).map(c => fetchAll(`reading_daily?select=station_id,bucket,n&station_id=${inList(c)}`
          + `&bucket=gte.${isoDay(from)}&order=station_id.asc,addr.asc,bucket.asc`, seq))).then(x => x.flat())),
        quietly(Promise.all(chunks(ids, ID_CHUNK).map(c => dbSelect(`station_health?select=station_id,last_seen_at,last_reading_at&station_id=${inList(c)}&limit=${PAGE}`)))
          .then(x => x.flat())),
      ]);
      if (seq !== S.seq) return;
      const missed = [];
      const val = (r, what) => { if (r.ok) return r.v; missed.push(what); return []; };
      const raw = { now, from, to: now, days, findings: own, network,
        openSilent: val(openSilent, 'who is quiet now'), tsum: val(tsum, 'the carriers'), fsum: val(fsum, 'the week\'s corrupted copies'),
        fsrc: val(fsrc, 'the pass-range shares'), daily: val(daily, 'the repeaters\' own reports'), health: val(health, 'when each was last heard'),
        flips: new Map() };
      // The corrupted copies, repeater by repeater, for the period exactly:
      // the ones any evidence points at, the most first.
      const want = flipSuspects(raw).slice(0, FLIP_CALLS);
      const got = await pool(want, rid => quietly(dbRpc('recent_flips', { p_days: Math.min(400, days), p_addr: null, p_tx: 'st:' + rid })));
      if (seq !== S.seq) return;
      got.forEach((r, i) => { if (r.ok && Array.isArray(r.v)) raw.flips.set(want[i], r.v); });
      if (got.some(r => !r.ok)) missed.push('some repeaters\' corrupted copies');
      S.raw = raw; S.demo = false; S.note = missed.length ? `Could not read ${missed.join(', ')}; the rest is shown without it.` : '';
      S.A = analyse(raw); S.phase = 'ready'; S.err = ''; S.loadedAt = Date.now();
    } catch (err) {
      if (err && err.stale) return;
      if (seq !== S.seq) return;
      if (soft && S.A) { S.note = `The last refresh failed (${(err && err.message) || err}); showing what was read at ${clock(S.loadedAt)}.`; redraw(); return; }
      const missing = err && (err.status === 404 || /does not exist|Could not find/.test(String(err.message || err)));
      S.phase = 'error';
      S.err = missing ? 'This database does not keep the findings this tab reads yet (migration 0059).'
        : `Could not read the network's findings — ${(err && err.message) || err}.`;
    }
    redraw();
  }

  // The repeaters whose own carrier any evidence has caught relaying a
  // corrupted copy, the most first.
  function flipSuspects(raw) {
    const reg = register();
    const score = new Map();
    const add = (rid, n) => { if (reg.byId.has(rid)) score.set(rid, (score.get(rid) || 0) + n); };
    (raw.fsum || []).forEach(r => { if (String(r.tx).startsWith('st:')) add(r.tx.slice(3), Number(r.flips) || 0); });
    (raw.fsrc || []).forEach(row => ((row.data && row.data.candidates) || []).forEach(c => add(c.rid, Number(c.by_carrier) || 0)));
    (raw.findings || []).forEach(f => { if (f.kind === 'transmitter-corrupting' && f.station_id) add(f.station_id, 5); });
    return [...score.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([rid]) => rid);
  }

  // ── The analysis ──────────────────────────────────────────────────────────

  function group(list, key) {
    const m = new Map();
    list.forEach(x => { const k = key(x); if (k == null) return; if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return m;
  }
  const ev = f => (f && f.evidence && typeof f.evidence === 'object' ? f.evidence : {});
  // When a silence began: the last thing heard, else when it was found.
  const quietFrom = f => { const e = ev(f); return Number(e.lastHeard) || ms(e.since) || ms(f.first_seen); };
  // A silence counts when the station kept a schedule, or was heard often
  // enough to be missed — the Network Weather bulletin's "regular". One heard a
  // few times a week, with no schedule to it, is a repeater our receivers
  // catch by luck from far away: its silence is not news (a note, below).
  const SELDOM_REPORTS = 30;
  function regularSilence(f) {
    const e = ev(f);
    if (e.periodMin) return true;
    return e.reports == null || Number(e.reports) >= SELDOM_REPORTS;
  }
  // A finding about the stations behind a repeater names it as the lead
  // (its subject) or as one of the repeaters that would explain it.
  const leadOf = f => { const m = /:rep:(.+)$/.exec(f.subject || ''); return m ? m[1] : null; };
  function names(f, rid) {
    const e = ev(f);
    if (f.kind === 'repeater-down') return leadOf(f) === rid || (Array.isArray(e.repeaters) && e.repeaters.includes(rid));
    if (f.kind === 'shared-spell') return (Array.isArray(e.repeaters) && e.repeaters.includes(rid)) || (Array.isArray(e.stations) && e.stations.includes(rid));
    if (f.kind === 'area-silence') return Array.isArray(e.stations) && e.stations.includes(rid);
    return false;
  }

  // How much of the network leans on a repeater, 1 to 2.5.
  function impactOf(R) {
    const n = R.only.length + 0.25 * (R.members.length - R.only.length);
    return 1 + Math.min(1.5, Math.log10(1 + n) / 1.3);
  }
  function scoreOf(i, R) {
    const imp = i.cat === 'ranges' ? 1 : i.cat === 'power' ? 1 + (impactOf(R) - 1) / 2 : impactOf(R);
    const persist = i.persist != null ? i.persist : i.ongoing ? 1 : 0.5;
    return SEV_W[i.sev] * imp * persist * CATS[i.cat].w * (i.strength || 1);
  }

  function analyse(raw) {
    const reg = register();
    const now = raw.now, from = raw.from;
    const own = group(raw.findings || [], f => f.station_id);
    const net = raw.network || [];
    const quietNow = new Set((raw.openSilent || []).map(f => f.station_id).filter(Boolean));
    const tsum = new Map((raw.tsum || []).map(r => [r.tx, r]));
    const fsum = new Map((raw.fsum || []).map(r => [r.tx, r]));
    const fsRow = (raw.fsrc || []).find(r => Number(r.period_days) === (raw.days <= 7 ? 7 : 30))
      || (raw.fsrc || []).slice().sort((a, b) => Number(b.period_days) - Number(a.period_days))[0] || null;
    const fs = fsRow && fsRow.data ? fsRow.data : null;
    const cand = new Map(((fs && fs.candidates) || []).map(c => [c.rid, c]));
    const daily = group(raw.daily || [], r => r.station_id);
    const heard = new Map((raw.health || []).map(h => [h.station_id, h]));
    const flips = raw.flips instanceof Map ? raw.flips : new Map(Object.entries(raw.flips || {}));
    const sr = airAnalysis(raw);
    const ctxBase = { now, from, to: raw.to, days: raw.days, quietNow, tsum, fsum, cand, fs, flips, sr };

    const rows = [];
    reg.reps.forEach(R => {
      const c = Object.assign({ R, own: own.get(R.id) || [], net: net.filter(f => names(f, R.id)) }, ctxBase);
      const issues = [offAir(c), dropouts(c), corrupt(c), signal(c), carrier(c), power(c), ranges(c)].filter(Boolean);
      if (!issues.length) return;
      issues.forEach(i => { i.score = scoreOf(i, R); });
      issues.sort((a, b) => b.score - a.score || SEV_RANK[a.sev] - SEV_RANK[b.sev]);
      const live = issues.filter(i => i.ongoing);
      const days = new Map((daily.get(R.id) || []).map(r => [String(r.bucket).slice(0, 10), 0]));
      (daily.get(R.id) || []).forEach(r => { const k = String(r.bucket).slice(0, 10); days.set(k, (days.get(k) || 0) + (Number(r.n) || 0)); });
      const h = heard.get(R.id) || null;
      rows.push({
        id: R.id, name: R.st.name, R, issues,
        score: sum(issues.map(i => i.score)),
        level: worstSev((live.length ? live : issues).map(i => i.sev)),
        resolved: !live.length,
        lastHeard: h ? ms(h.last_seen_at) : null,
        reports: days,
        spans: spansOf(c),
      });
    });
    // Repeaters that went off air within half an hour of each other: one
    // cause they share fits better than as many faults — the bulletin's first
    // question, "what do they share?".
    const offs = rows.map(r => ({ r, i: r.issues.find(i => i.kind === 'offair') })).filter(x => x.i && x.i.ev.since);
    offs.forEach(a => {
      const near = offs.filter(b => b !== a && Math.abs(b.i.ev.since - a.i.ev.since) <= 30 * 60e3);
      if (!near.length) return;
      const gap = Math.max(...near.map(b => Math.abs(b.i.ev.since - a.i.ev.since)));
      const names = near.map(b => b.r.name);
      a.i.ev.together = names;
      a.i.facts.push(`It went quiet within ${gap < 90e3 ? 'a minute' : span(gap)} of ${names.join(', ')}: one thing they share — a link between them, a channel, a site's power — fits better than ${near.length + 1} separate faults.`);
    });
    rows.forEach(r => { r.points = pointsTo(r.issues); });
    rows.sort((a, b) => b.score - a.score || SEV_RANK[a.level] - SEV_RANK[b.level] || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i + 1; });
    const flagged = rows.filter(r => !r.resolved && r.level !== 'info');
    return {
      from, to: raw.to, now, days: raw.days, demo: !!raw.demo, rows,
      counts: {
        repeaters: reg.reps.length,
        listed: rows.filter(r => r.level !== 'info').length,
        notes: rows.filter(r => r.level === 'info').length,
        critical: rows.filter(r => !r.resolved && r.level === 'critical').length,
        offAir: rows.filter(r => r.issues.some(i => i.kind === 'offair' && i.ongoing)).length,
        corrupting: rows.filter(r => r.issues.some(i => i.kind === 'corrupt' && i.sev !== 'info')).length,
        behind: new Set(flagged.flatMap(r => r.R.members.map(s => s.id))).size,
        quietBehind: new Set(flagged.flatMap(r => r.R.members.filter(s => quietNow.has(s.id)).map(s => s.id))).size,
      },
      network: fs ? { corrupted: Number(fs.corrupted) || 0, rate: Number(fs.network_rate) || null, days: Number(fs.days) || null } : null,
      quietNow, sr: sr ? { days: sr.days, from: sr.from, to: sr.to, found: sr.reps.length } : null,
    };
  }

  // The period's findings about a repeater as spans for its timeline.
  function spansOf(c) {
    const out = [];
    const end = f => ms(f.cleared_at);
    c.own.forEach(f => {
      if (f.kind === 'silent') out.push({ row: 'air', from: quietFrom(f), to: end(f), sev: f.severity, what: 'Not heard' });
      else if (BATTERY.includes(f.kind)) out.push({ row: 'power', from: ms(f.first_seen), to: end(f), sev: f.severity, what: f.title });
      else if (f.kind === 'transmitter-corrupting') out.push({ row: 'bits', from: ms(f.first_seen), to: end(f), sev: f.severity, what: f.title });
      else if (f.kind === 'transmitter-off-channel' || f.kind === 'transmitter-drift') out.push({ row: 'carrier', from: ms(f.first_seen), to: end(f), sev: f.severity, what: f.title });
      else if (f.kind === 'transmitter-snr-falling') out.push({ row: 'signal', from: ms(f.first_seen), to: end(f), sev: f.severity, what: f.title });
    });
    c.net.forEach(f => {
      const lead = f.kind !== 'repeater-down' || leadOf(f) === c.R.id;
      if (!lead) return;
      out.push({ row: 'air', from: Number(ev(f).from) || ms(f.first_seen), to: end(f), sev: f.kind === 'repeater-down' ? 'critical' : 'warn',
        what: f.title });
    });
    return out.filter(s => s.from != null);
  }

  // ── The issues ────────────────────────────────────────────────────────────
  // Each returns null or { kind, cat, sev, ongoing, title, short, detail,
  // facts[], ev{} } — `short` is what the summary says of it, `detail` the
  // sentence under its title, `facts` the evidence a line each.

  function offAir(c) {
    const R = c.R;
    const openSilent = c.own.filter(f => f.kind === 'silent' && !f.cleared_at).sort((a, b) => quietFrom(a) - quietFrom(b))[0] || null;
    const downs = c.net.filter(f => f.kind === 'repeater-down' && !f.cleared_at);
    const lead = downs.find(f => leadOf(f) === R.id) || null;
    const named = downs.find(f => leadOf(f) !== R.id) || null;
    const silent = openSilent && regularSilence(openSilent) ? openSilent : null;
    if (openSilent && !silent && !lead && !named) {
      const e = ev(openSilent), since = quietFrom(openSilent);
      return {
        kind: 'seldom', cat: 'air', sev: 'info', ongoing: true,
        title: `Seldom heard — last on ${when(since)}`,
        short: `Seldom heard (last ${whenShort(since)})`,
        detail: 'Its own station is heard only now and then.',
        facts: [`Only ${plural(Number(e.reports) || 0, 'report')} in the week before ${when(since)}, with no schedule to them: probably beyond our receivers most of the time rather than missing.`],
        ev: { since },
      };
    }
    if (!silent && !lead && !named) return null;
    const quiet = R.members.filter(s => c.quietNow.has(s.id));
    const quietOnly = R.only.filter(s => c.quietNow.has(s.id));
    // Critical when a share of the network has gone with it: the stations
    // behind it quiet together, three that only it passes, or a good part of
    // all of them (overlapping pass ranges hide a chain — Toowoomba's stations
    // are Mt Glorious's on the register too, but reach it through Toowoomba).
    let sev = silent ? silent.severity : lead ? 'critical' : 'warn';
    if (sev !== 'critical' && (lead || quietOnly.length >= 3 || (quiet.length >= 5 && quiet.length >= 0.4 * R.members.length))) sev = 'critical';
    const since = silent ? quietFrom(silent) : Number(ev(lead || named).from) || ms((lead || named).first_seen);
    const facts = [];
    if (silent) {
      const e = ev(silent);
      const sched = e.periodMin ? `it reports every ${span(Number(e.periodMin) * 60e3)}${e.trailingMisses ? ` and has missed its last ${num(e.trailingMisses)}` : ''}`
        : e.reports ? `no schedule could be learned from its ${num(e.reports)} reports` : '';
      facts.push(`Its own reports stopped ${when(since)} — ${span(c.now - since)} ago${sched ? `; ${sched}` : ''} — while the receivers kept delivering other traffic.`);
      const area = c.net.find(f => f.kind === 'area-silence' && !f.cleared_at);
      if (area) facts.push(`${plural(Math.max(0, (ev(area).stations || []).length - 1), 'station')} near it went quiet at about the same time — an area going quiet together.`);
    }
    if (lead) {
      const e = ev(lead);
      facts.push(`${plural((e.stations || []).length, 'station')} behind it went quiet together between ${when(e.from || ms(lead.first_seen))} and ${clock(e.to || ms(lead.first_seen))}${e.stillHeard ? `; ${plural(e.stillHeard, 'station')} behind it ${e.stillHeard === 1 ? 'is' : 'are'} still heard, perhaps direct` : ''}.`);
    } else if (named) {
      facts.push(`One of the repeaters that would explain "${named.title}".`);
    }
    if (R.members.length) {
      facts.push(`${num(quiet.length)} of the ${num(R.members.length)} field stations whose addresses it passes ${quiet.length === 1 ? 'is' : 'are'} quiet now`
        + (R.only.length ? `; ${num(quietOnly.length)} of the ${num(R.only.length)} that no other repeater on record passes.` : '.'));
    }
    const t = c.tsum.get('st:' + R.id);
    if (t && Array.isArray(t.days) && t.days.length) {
      const last = dayMs(t.days[t.days.length - 1]);
      if (c.now - last > 1.5 * DAY) facts.push(`Its carrier was last measured on ${dayLabel(last + 12 * HOUR)}.`);
    }
    return {
      kind: 'offair', cat: 'air', sev, ongoing: true,
      title: silent ? `Off air — not heard since ${when(since)}` : `${plural((ev(lead || named).stations || []).length, 'station')} behind it quiet since ${when(since)}`,
      short: silent ? `Off air since ${whenShort(since)}` : `${num((ev(lead || named).stations || []).length)} behind it quiet since ${whenShort(since)}`,
      detail: silent ? 'The repeater\'s own station has stopped reporting.' : 'The stations behind it stopped together, which is how a shared failure looks.',
      facts, ev: { since, quiet: quiet.length, quietOnly: quietOnly.length, own: !!silent },
    };
  }

  function dropouts(c) {
    const R = c.R;
    const eps = [];
    c.own.filter(f => f.kind === 'silent' && f.cleared_at && regularSilence(f)).forEach(f => {
      const e = ev(f);
      eps.push({ from: quietFrom(f), to: ms(f.cleared_at), note: e.cause && e.cause.area ? `with stations around ${e.cause.area}` : e.cause && e.cause.name ? `behind ${e.cause.name}` : '' });
    });
    c.net.filter(f => f.cleared_at && (f.kind === 'shared-spell' || (f.kind === 'repeater-down' && leadOf(f) === R.id))).forEach(f => {
      const e = ev(f);
      // From the group's last checks, but no more than a day before it was
      // found: a group can gather a station that had been quiet for days.
      const found = ms(f.first_seen);
      eps.push({ from: Math.max(Number(e.from) || found, found - DAY), to: ms(f.cleared_at), note: `${plural((e.stations || []).length, 'station')} behind it with it` });
    });
    const list = eps.filter(e => e.from != null && e.to != null && e.to > e.from).sort((a, b) => a.from - b.from);
    if (!list.length) return null;
    // Overlapping records of one dropout are one dropout.
    const merged = [];
    list.forEach(e => {
      const last = merged[merged.length - 1];
      if (last && e.from <= last.to) { last.to = Math.max(last.to, e.to); if (!last.note && e.note) last.note = e.note; return; }
      merged.push({ ...e });
    });
    const total = sum(merged.map(e => e.to - e.from));
    const night = merged.filter(e => { const h = new Date(e.from).getHours(); return h >= 17 || h < 6; }).length;
    const sev = merged.length >= 3 || total >= DAY ? 'warn' : 'info';
    const facts = merged.slice(-4).reverse().map(e => `${span(e.to - e.from)} from ${when(e.from)}${e.note ? ` (${e.note})` : ''}.`);
    if (merged.length > 4) facts.push(`…and ${plural(merged.length - 4, 'earlier one')}.`);
    if (night >= 2 && night >= 0.6 * merged.length) facts.push(`${num(night)} of them began in the evening or overnight — the pattern of a solar site that cannot carry the night.`);
    return {
      kind: 'dropouts', cat: 'drops', sev, ongoing: true, persist: 0.75,
      title: `Dropped out ${merged.length === 1 ? 'once' : `${num(merged.length)} times`} — ${span(total)} in all`,
      short: `Dropped out ${merged.length === 1 ? 'once' : `${num(merged.length)}×`} (${span(total)})`,
      detail: 'Spells it, or the stations behind it, went quiet and came back.',
      facts, ev: { n: merged.length, total, night },
    };
  }

  // The 24 hours' shape: the share of the copies in the busiest six hours, and
  // how many hours of the day saw any.
  function hoursOf(rows) {
    const h = new Array(24).fill(0);
    rows.forEach(r => { const t = ms(r.heard_at); if (t != null) h[new Date(t).getHours()]++; });
    const n = sum(h);
    const win = i => { let s = 0; for (let k = 0; k < 6; k++) s += h[(i + k) % 24]; return s; };
    const best = Math.max(...h.map((_, i) => win(i)));
    // Of the busiest windows, the one that starts on a busy hour — so seven
    // to ten in the evening reads 19:00 to 01:00, not 17:00 to 23:00.
    const ties = h.map((_, i) => i).filter(i => win(i) === best);
    const at = ties.find(i => h[i] > 0) ?? ties[0] ?? 0;
    const used = h.filter(x => x > 0).length;
    const pattern = n < 12 ? '' : best / n >= 0.6 ? 'hours' : used >= 16 ? 'all' : '';
    return { h, n, share: n ? best / n : 0, at, used, pattern };
  }

  function corrupt(c) {
    const R = c.R, tx = 'st:' + R.id;
    const fnd = c.own.filter(f => f.kind === 'transmitter-corrupting');
    const fOpen = fnd.find(f => !f.cleared_at) || null;
    const fWorst = fnd.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0] || null;
    const fs = c.fsum.get(tx) || null;
    const rows = (c.flips.get(R.id) || []).filter(r => r.bad_tx == null || r.bad_tx === tx);
    const ca = c.cand.get(R.id) || null;
    const ownAddrs = new Set(R.own);
    if (!rows.length && !fnd.length) {
      // Nothing on its own carrier: the circumstantial side, said as a note
      // when its share stands out.
      const nr = c.fs && Number(c.fs.network_rate);
      const ratio = ca && nr > 0 && ca.rate != null ? Number(ca.rate) / nr : null;
      if (!ca || ratio == null || !((ratio >= 2 && Number(ca.blame) >= 10) || (ratio >= 1.3 && Number(ca.only_it) >= 5))) return null;
      return {
        kind: 'corrupt', cat: 'bits', sev: 'info', ongoing: true,
        title: `Could have carried about ${num(Math.round(Number(ca.blame)))} corrupted copies, by pass range`,
        short: `${ratio.toFixed(1)}× the network's corruption rate, by pass range`,
        detail: 'Nothing has been caught on its own carrier; this is the circumstantial side.',
        facts: [
          ratio != null ? `The corrupted copies of the addresses it passes come at ${pct(ca.rate)} of what it could have carried — ${ratio.toFixed(1)}× the network's ${pct(nr)} (last ${num(c.fs.days)} days).` : '',
          Number(ca.only_it) ? `${num(ca.only_it)} of them were of addresses no other repeater on record passes.` : '',
          'A broad pass range collects a big share just by passing many stations: a carrier caught relaying them is what would settle it (Bit-Flip Sources).',
        ].filter(Boolean),
        ev: { n: 0, circumstantial: true },
      };
    }
    const n = rows.length;
    const capped = n >= 1000;
    const clear = rows.filter(r => r.bad_snr == null || r.good_snr == null || Number(r.bad_snr) >= Number(r.good_snr) - 6).length;
    const upstream = rows.filter(r => r.good_tx && r.good_tx !== tx && !ownAddrs.has(Number(r.true_addr))).length;
    const ghosts = rows.filter(r => r.addr_flip).length;
    const H = hoursOf(rows);
    const rateOf = f => (f && ev(f).rate != null && Number.isFinite(Number(ev(f).rate)) ? Number(ev(f).rate) : null);
    const rate = fs && fs.rate != null ? Number(fs.rate) : rateOf(fOpen) != null ? rateOf(fOpen) : rateOf(fWorst);
    // A rate is a headline only on enough copies to mean it: the server's own
    // floor for a corrupting transmitter is five as strong as the clean copy.
    const flipsWeek = fs ? Number(fs.flips) || 0 : 0;
    const rateSays = rate != null && rate >= 0.005 && (flipsWeek >= 5 || !!fWorst);
    const last = rows.reduce((m, r) => Math.max(m, ms(r.heard_at) || 0), 0);
    let sev = fWorst ? fWorst.severity : rate != null && rate >= 0.1 && clear >= 10 ? 'critical' : rate != null && rate >= 0.02 && clear >= 5 ? 'warn' : 'info';
    const pairs = new Map();
    rows.forEach(r => { const k = r.true_addr === r.bad_addr ? `${r.true_addr}` : `${r.true_addr}→${r.bad_addr}`; pairs.set(k, (pairs.get(k) || 0) + 1); });
    const top = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).filter(([, k]) => k > 1);
    const facts = [];
    facts.push(`${capped ? 'At least 1,000' : num(n)} corrupted cop${n === 1 ? 'y' : 'ies'} came on its own carrier in the period`
      + (fs ? `; in the last week ${num(fs.flips)} of the ${num(fs.bursts)} bursts it sent (${pct(fs.rate)}, against ${pct(fs.fleet_rate)} for a typical transmitter).` : '.'));
    if (n) facts.push(`${num(clear)} arrived as strong as the clean copy, so the bits were already wrong when it sent them — its receiver, its site or its radio — not misheard at our end.`);
    if (upstream) facts.push(`${num(upstream)} also reached us clean by another way, so the corruption entered at this repeater.`);
    if (ghosts) facts.push(`${num(ghosts)} landed on another address: readings filed under a station that did not send them.`);
    if (H.pattern === 'hours') facts.push(`${pct(H.share)} of them came between ${String(H.at).padStart(2, '0')}:00 and ${String((H.at + 6) % 24).padStart(2, '0')}:00 — interference keeps hours like that.`);
    else if (H.pattern === 'all') facts.push(`They come at all hours (${num(H.used)} of the 24) — more like equipment or a weak input than interference, which keeps hours.`);
    if (ca && Number(ca.only_it)) facts.push(`${num(ca.only_it)} corrupted copies were of addresses no other repeater on record passes (by pass range, last ${num(c.fs.days)} days).`);
    if (top.length) facts.push(`Most often: ${top.map(([k, v]) => `${k} ×${v}`).join(', ')}.`);
    return {
      kind: 'corrupt', cat: 'bits', sev, ongoing: !!fOpen || (last && c.now - last < 2 * DAY),
      strength: 1 + Math.min(0.5, n / 200),
      title: rateSays ? `${pct(rate)} of what it relays arrives corrupted` : `${capped ? '1,000+' : num(n)} corrupted cop${n === 1 ? 'y' : 'ies'} on its carrier`,
      short: rateSays ? `${pct(rate)} of relays corrupted` : `${capped ? '1,000+' : num(n)} corrupted cop${n === 1 ? 'y' : 'ies'}`,
      detail: 'Copies of other stations\' readings with a bit or two wrong, on its own carrier — so it sent them.',
      facts, hours: n >= 6 ? H : null,
      ev: { n, clear, upstream, ghosts, rate, pattern: H.pattern },
    };
  }

  function carrier(c) {
    const R = c.R;
    const t = c.tsum.get('st:' + R.id);
    if (!t || !Array.isArray(t.days) || !Array.isArray(t.ppm)) return null;
    const floor = dayMs(isoDay(c.from));
    const all = t.days.map((d, i) => ({ t: dayMs(d), ppm: Number(t.ppm[i]) })).filter(p => Number.isFinite(p.ppm) && p.t >= floor);
    if (!all.length) return null;
    // One day far from all the others is set aside: more often a receiver's
    // tuning that day than the radio (21 Oct's sticks had no correction yet,
    // and put two transmitters 17 ppm out for the day).
    let pts = all, odd = null;
    if (all.length >= 3) {
      const far = all.map(p => {
        const rest = all.filter(q => q !== p).map(q => q.ppm), m = median(rest);
        return { p, d: Math.abs(p.ppm - m), lim: Math.max(2.5, 4 * median(rest.map(v => Math.abs(v - m)))) };
      }).sort((a, b) => b.d - a.d)[0];
      if (far.d > far.lim) { odd = far.p; pts = all.filter(q => q !== odd); }
    }
    const f = Number(t.freq_mhz) || null;
    const med = median(pts.map(p => p.ppm));
    const lo = Math.min(...pts.map(p => p.ppm)), hi = Math.max(...pts.map(p => p.ppm));
    const range = hi - lo;
    const nd = pts.length;
    const fOff = c.own.find(x => (x.kind === 'transmitter-off-channel' || x.kind === 'transmitter-drift') && !x.cleared_at) || null;
    const off = Math.abs(med) >= 2.5 && nd >= 2;
    const moves = range >= 1 && nd >= 2;
    if (!off && !moves && !fOff) return null;
    let sev = 'info';
    if (off) sev = Math.abs(med) >= 5 && nd >= 3 ? 'critical' : 'warn';
    else if (range >= 2 && nd >= 3) sev = 'warn';
    const series = all.map(p => `${sgn(p.ppm, 1)} on ${dayLabel(p.t + 12 * HOUR)}`).join(', ');
    const hz = v => (f ? ` (${sgn(v * f, 0)} Hz at ${f.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} MHz)` : '');
    const facts = [`Against the fleet the same receivers hear, in parts per million: ${series}.`];
    if (odd) facts.push(`${dayLabel(odd.t + 12 * HOUR)} (${sgn(odd.ppm, 1)}) is far from every other day, and is left out below: one day like that is more often a receiver's tuning than this radio.`);
    if (off) facts.push(`Its median over the ${plural(nd, 'day')} measured is ${sgn(med, 1)} ppm${hz(med)}: a transmitter this far off decodes worse, and then not at all.`);
    if (moves) facts.push(`It moved ${range.toFixed(1)} ppm between days. A carrier that will not stay put is a crystal or synthesiser warming, ageing or failing — or two transmitters answering to one name; one day far from the rest can be a receiver's tuning that day rather than this radio.`);
    if (fOff) facts.push(`The server's own check: ${fOff.title}.`);
    facts.push('Every burst it relays carries this carrier — the fingerprint that puts a corrupted copy on it.');
    const last = pts[pts.length - 1].t;
    return {
      kind: 'carrier', cat: 'carrier', sev, ongoing: c.now - last < 3 * DAY,
      title: off ? `Carrier ${sgn(med, 1)} ppm off the fleet` : `Carrier moved ${range.toFixed(1)} ppm over ${plural(nd, 'day')} measured`,
      short: off ? `Carrier ${sgn(med, 1)} ppm off` : `Carrier moved ${range.toFixed(1)} ppm`,
      detail: 'Its transmitter\'s frequency, measured on every burst the base stations decode.',
      facts, pts, ev: { med, range, nd },
    };
  }

  // Its signal (0083): the server's transmitter-snr-falling on its own carrier
  // — everything it relays reaching the base stations that much weaker, their
  // own steps already taken out, judged against its own past at each.
  function signal(c) {
    const list = c.own.filter(f => f.kind === 'transmitter-snr-falling');
    if (!list.length) return null;
    const open = list.filter(f => !f.cleared_at);
    const lead = (open.length ? open : list).slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || ms(b.last_seen) - ms(a.last_seen))[0];
    const e = ev(lead);
    const drop = Number(e.drop_db) || null;
    const facts = [lead.detail].filter(Boolean);
    facts.push('Everything it relays reaches the base stations that much weaker, so the stations behind it have lost that margin too — the weakest of them go quiet first.');
    if (e.action) facts.push(e.action);
    return {
      kind: 'signal', cat: 'signal', sev: lead.severity, ongoing: !lead.cleared_at,
      title: String(lead.title).replace(/^.*?: (?=SNR)/, '') + (lead.cleared_at ? ` — cleared ${whenShort(ms(lead.cleared_at))}` : ''),
      short: drop ? `Signal down ${drop.toFixed(1)} dB` : 'Signal fading',
      detail: 'How far above the base stations\' noise its own transmissions arrive, against its own past.',
      facts, ev: { drop, window: e.window || null },
    };
  }

  function power(c) {
    const list = c.own.filter(f => BATTERY.includes(f.kind));
    if (!list.length) return null;
    const open = list.filter(f => !f.cleared_at);
    const lead = (open.length ? open : list).slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || ms(b.last_seen) - ms(a.last_seen))[0];
    const e = ev(lead);
    // The voltage its title gives first, so the summary says what the finding says.
    const tv = /(\d+(?:\.\d+)?)\s*V\b/.exec(lead.title || '');
    const v = (tv ? Number(tv[1]) : null) || Number(e.lastNightV) || Number(e.latestV) || Number(e.medianV) || null;
    const others = list.filter(f => f !== lead && f.kind !== lead.kind);
    const facts = [lead.detail].filter(Boolean);
    if (others.length) facts.push(`Also in the period: ${[...new Set(others.map(f => `${f.title}${f.cleared_at ? ' (cleared)' : ''}`))].slice(0, 3).join('; ')}.`);
    if (e.action) facts.push(e.action);
    return {
      kind: 'power', cat: 'power', sev: lead.severity, ongoing: !lead.cleared_at,
      title: lead.title + (lead.cleared_at ? ` — cleared ${whenShort(ms(lead.cleared_at))}` : ''),
      short: lead.kind === 'battery-no-charge' ? `No daily charge${v ? ` (${v.toFixed(1)} V)` : ''}`
        : `Battery ${lead.kind.replace('battery-', '')}${v ? ` (${v.toFixed(1)} V)` : ''}`,
      detail: 'The repeater site\'s own battery, read from its battery sensor.',
      facts, ev: { kind: lead.kind, v },
    };
  }

  // The pass ranges on record: what the register itself gets wrong, and — when
  // the receptions have been read (Signal Routes) — what the air says.
  function ranges(c) {
    const R = c.R;
    const pr = (R.rep && R.rep.pass_ranges) || [];
    const facts = [];
    let sev = null, short = '', offrec = 0, elsewhere = 0;
    const raise = s => { sev = sev == null || SEV_RANK[s] < SEV_RANK[sev] ? s : sev; };
    if (!pr.length) { raise('info'); short = 'No pass ranges on record'; facts.push('No pass range is on record, so nothing it relays can be put down to it — by the register or by its carrier.'); }
    const inv = pr.filter(r => Number(r.high) < Number(r.low));
    if (inv.length) { raise('info'); short = short || 'A pass range runs backwards'; facts.push(`${inv.map(r => `${r.low}–${r.high}`).join(', ')} run${inv.length === 1 ? 's' : ''} backwards and match${inv.length === 1 ? 'es' : ''} no address.`); }
    const x = c.sr && c.sr.repById ? c.sr.repById.get(R.id) : null;
    if (x) {
      const copies = (x.offrec || []).filter(o => o.evidence === 'copies');
      const possible = (x.offrec || []).filter(o => o.evidence === 'possible');
      offrec = copies.length;
      elsewhere = x.elsewhere ? x.elsewhere.size : 0;
      const name = a => { const st = stationOfAddr(a); return st ? `${a} (${st.name})` : String(a); };
      if (copies.length) {
        raise('warn');
        short = `Relays ${plural(copies.length, 'address', 'addresses')} off its record`;
        facts.push(`On its carrier, with copies, though no pass range on record includes ${copies.length === 1 ? 'it' : 'them'}: ${copies.slice(0, 6).map(o => name(o.a)).join(', ')}${copies.length > 6 ? ` and ${num(copies.length - 6)} more` : ''}. The record, or the radio, is wrong.`);
      }
      if (possible.length) { raise('info'); facts.push(`Possibly also ${possible.slice(0, 4).map(o => name(o.a)).join(', ')} — on its carrier, but without a copy to prove it.`); }
      if (elsewhere >= 3) {
        raise('info');
        short = short || `${num(elsewhere)} in its ranges reach us another way`;
        facts.push(`${plural(elsewhere, 'address', 'addresses')} in its ranges reached us only another way — direct, or through another repeater — on days its carrier was found: its ranges are wider than what it hears from there, or the other way wins.`);
      }
      if (facts.length) facts.push(`From ${num(c.sr.days)} days of receptions (Signal Routes): its carrier found on ${plural(x.days, 'day')}, centred ${sgn(x.centre, 0)} Hz${x.spread > 60 ? `, moving ${Math.round(x.spread)} Hz between days` : ''}.`);
    }
    if (sev == null) return null;
    return {
      kind: 'ranges', cat: 'ranges', sev, ongoing: true,
      title: offrec ? `Relays ${plural(offrec, 'address', 'addresses')} its pass ranges do not include` : short,
      short, detail: 'Its pass ranges on record, against what it actually relays.',
      facts, ev: { offrec, elsewhere },
    };
  }
  function stationOfAddr(a) {
    return stations().find(s => (typeof stationAlertIds === 'function' ? stationAlertIds(s) : []).includes(Number(a))) || null;
  }

  // What the issues together point to — said as possibilities, never orders.
  function pointsTo(issues) {
    const has = k => issues.find(i => i.kind === k) || null;
    const off = has('offair'), bits = has('corrupt'), car = has('carrier'), pow = has('power'), drops = has('dropouts'), rng = has('ranges'), sig = has('signal');
    const out = [];
    if (off && off.ev.together) out.push(`It stopped together with ${off.ev.together.join(', ')}: look first for what they share.`);
    const bitsReal = bits && !bits.ev.circumstantial && bits.ev.clear >= 5;
    const v = pow && pow.ev.v ? ` (${pow.ev.v.toFixed(1)} V)` : '';
    const battery = pow && ({ 'battery-no-charge': `its battery showed no daily charge${v}`, 'battery-critical': `its battery is critical${v}`,
      'battery-low': `its battery is low${v}`, 'battery-falling': `its battery is falling${v}` })[pow.ev.kind];
    if (off && battery) out.push(`Power first: ${battery}${pow.ongoing ? '' : ' earlier in the period'}.`);
    if (off && bitsReal) out.push(`${battery ? 'A failing radio fits as well' : 'A failing radio fits'}: it was corrupting what it relayed before it stopped.`);
    if (!off && bitsReal && bits.ev.upstream > 0) out.push('The corruption enters at this repeater — the same readings reach us clean another way: its receiver hearing the stations badly (antenna, feeder, the site, local noise) or its radio.');
    else if (!off && bitsReal) out.push('It sends the wrong bits: its receiver, its site or its radio — a receiver parked beside it would tell which.');
    if (bitsReal && bits.ev.pattern === 'hours') out.push('The corrupted copies keep hours, which interference near the site does and a failing radio does not.');
    if (bitsReal && bits.ev.pattern === 'all' && !off) out.push('At all hours, which is more like equipment or a weak input than interference.');
    // Its antenna and feeder are what it hears through as well as what it
    // sends on: weaker out and corrupting what comes in point at both.
    if (sig && bitsReal && !off) out.push('Weaker on the air and corrupting what it relays: its antenna, feeder or connectors, which it hears through as well as sends on, fit both.');
    else if (sig && !off) out.push('Its own signal is weaker at the base stations that hear it: its antenna, feeder or connectors, or its transmitter\'s power.');
    if (car && bitsReal) {
      out.push(car.sev !== 'info' ? 'A carrier that is off or moving, as well as corrupted relays, points at the radio itself.'
        : `Its carrier moved ${car.ev.range.toFixed(1)} ppm across the ${plural(car.ev.nd, 'day')} it was measured${car.ev.nd < 3 ? ' — too few to lean on, but' : ', and'} a failing radio would do both.`);
    }
    if (drops && drops.ev.night >= 2) out.push('Dropping out in the evenings and overnight is the pattern of a solar site that cannot carry the night.');
    if (rng && rng.ev.offrec) out.push('What it relays and its pass ranges on record disagree: the record or the radio wants correcting.');
    if (off && !out.length) out.push('Nothing else on record here says why: its power, its radio, or its antenna and feeder.');
    return out.slice(0, 3);
  }

  // ── Pass ranges against the air (Signal Routes, editors) ─────────────────

  function airAnalysis(raw) {
    if (raw.demo || typeof SignalRoutes === 'undefined' || !SignalRoutes.state) return raw.sr || null;
    const s = SignalRoutes.state();
    return s && s.phase === 'ready' && s.A && !s.A.demo ? s.A : null;
  }
  async function readAir() {
    if (typeof SignalRoutes === 'undefined' || !signedIn() || S.air) return;
    S.air = 'loading';
    redraw();
    try {
      if (SignalRoutes.loadDays) await SignalRoutes.loadDays(SR_DAYS);
      else await SignalRoutes.load();
    } catch (_) { /* Signal Routes says what went wrong in its own state */ }
    S.air = '';
    if (S.raw && !S.demo) S.A = analyse(S.raw);
    redraw();
  }
  function airHtml() {
    if (S.demo) return '';
    const s = typeof SignalRoutes !== 'undefined' && SignalRoutes.state ? SignalRoutes.state() : null;
    const A = s && s.phase === 'ready' && s.A && !s.A.demo ? s.A : null;
    if (A) {
      return `<p class="small bk-air"><b>Pass ranges against the air:</b> from Signal Routes' ${plural(A.days, 'day')} of receptions
        (${esc(dayLabel(A.from))} to ${esc(clock(A.to))}), ${plural(A.reps.length, 'repeater')} found on ${A.reps.length === 1 ? 'its carrier' : 'their carriers'}.
        ${signedIn() ? `<button class="link-btn" onclick="Backbone.readAir()"${S.air ? ' disabled' : ''}>${S.air ? 'Reading…' : 'Read again'}</button>` : ''}</p>`;
    }
    if (!signedIn()) {
      return '<p class="small txt-muted bk-air"><b>Pass ranges against the air</b> — what each repeater really relays, set against its ranges on record — need the receptions, which editors can read: sign in as one to add them here.</p>';
    }
    const err = s && s.phase === 'error' && s.err ? ` <span class="txt-bad">${esc(s.err)}</span>` : '';
    return `<p class="small bk-air"><b>Pass ranges against the air:</b> read the last ${SR_DAYS} days of receptions (as Signal Routes does) to set each repeater's
      pass ranges on record against what it really relays. It takes a minute.
      <button class="btn btn-sm" onclick="Backbone.readAir()"${S.air || (s && s.phase === 'loading') ? ' disabled' : ''}>${S.air || (s && s.phase === 'loading') ? 'Reading the receptions…' : 'Read them'}</button>${err}</p>`;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function sevHtml(sev, resolved) {
    const s = SEV[sev] || SEV.info;
    return `<span class="hl-sev ${resolved ? 'txt-muted' : s.cls}"><span aria-hidden="true">${resolved ? '✓' : s.icon}</span> <span class="hl-sev-word">${esc(resolved ? 'Cleared' : s.label)}</span></span>`;
  }

  function periodHtml() {
    return `<div class="control-row bk-controls" role="group" aria-label="Period">
      ${PERIODS.map(d => `<button class="hl-chip${S.days === d ? ' hl-chip--on' : ''}" aria-pressed="${S.days === d}" onclick="Backbone.setDays(${d})">Last ${d} days</button>`).join('')}
      <button class="btn" onclick="Backbone.refresh()"${S.phase === 'loading' ? ' disabled' : ''} title="Read everything again now">↻ Refresh</button>
    </div>`;
  }

  function statusHtml() {
    const A = S.A;
    if (!A) return '';
    const upd = S.demo ? '<b>A demo:</b> made-up findings on the real station file — nothing here is about the real repeaters.'
      : `Read at ${esc(clock(S.loadedAt))}; reads itself again every 15 minutes while this tab is open.`;
    const busy = S.phase === 'loading' && !S.demo ? `<br><span role="status">Reading the last ${S.days} days…</span>` : '';
    return `<p class="small txt-muted" id="bk-status">${upd} The period: ${esc(dayLabel(A.from))} to now.${busy}
      ${S.note ? `<br><span class="txt-warn">${esc(S.note)}</span>` : ''}</p>`;
  }

  function tilesHtml(A) {
    const c = A.counts;
    const tile = (n, label, bad) => `<div class="bk-tile"><span class="bk-tile-n${bad && n ? ' stat-bad' : ''}">${num(n)}</span> <span class="bk-tile-l">${esc(label)}</span></div>`;
    return `<div class="bk-tiles">
      ${tile(c.listed, `of the ${num(c.repeaters)} repeaters with a warning or worse`)}
      ${tile(c.critical, 'critical now', true)}
      ${tile(c.offAir, 'off air now', true)}
      ${tile(c.corrupting, 'relaying corrupted copies', true)}
      ${tile(c.quietBehind, `stations quiet now behind the ones still at fault, of ${num(c.behind)}`, true)}
    </div>`;
  }

  // A repeater's score as a bar, its issues' shares in their colours, scaled to
  // the worst repeater's.
  function barHtml(r, max) {
    const by = {};
    r.issues.forEach(i => { by[i.cat] = (by[i.cat] || 0) + i.score; });
    const w = v => `${Math.max(0.5, (100 * v) / max).toFixed(1)}%`;
    const label = CAT_ORDER.filter(k => by[k]).map(k => `${CATS[k].label} ${Math.round(by[k])}`).join(', ');
    return `<span class="bk-bar" role="img" aria-label="${escAttr(`Score ${Math.round(r.score)}: ${label}`)}">${CAT_ORDER.filter(k => by[k]).map(k =>
      `<span class="bk-seg bk-c-${k}" style="--bk-w:${w(by[k])}" title="${escAttr(`${CATS[k].label}: ${Math.round(by[k])}`)}"></span>`).join('')}</span>
      <span class="bk-score">${Math.round(r.score)}</span>`;
  }

  function keyHtml() {
    return `<p class="small bk-key" aria-label="What the bar's colours mean">${CAT_ORDER.map(k => `<span class="bk-key-item"><span class="bk-sw bk-c-${k}" aria-hidden="true"></span>${esc(CATS[k].label)}</span>`).join('')}</p>`;
  }

  // The repeaters the summary and the sections show — a warning or worse, the
  // first TOP of them unless every one was asked for — and those with only a
  // note, which are listed together under them.
  function split(A) {
    const ranked = A.rows.filter(r => r.level !== 'info');
    const main = S.all ? ranked : ranked.slice(0, TOP);
    return { main, more: ranked.length - main.length, minor: A.rows.filter(r => r.level === 'info') };
  }

  function summaryHtml(A, shown) {
    if (!shown.length) {
      return `<p>No repeater on record has a warning or worse in this period — none off air, none relaying corrupted copies, no carrier off the fleet.${
        A.rows.length ? ` ${plural(A.rows.length, 'repeater has', 'repeaters have')} a note, listed at the foot of the page.` : ''}</p>`;
    }
    const max = Math.max(...shown.map(r => r.score), 1);
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bk-h-summary">
      <table class="hl-table bk-summary">
        <caption class="sr-only">The repeaters, worst first: each one's state now, its one or two key issues, and its score, split by kind of trouble</caption>
        <thead><tr><th scope="col" class="num">#</th><th scope="col">Repeater</th><th scope="col">State</th><th scope="col">Key issues</th><th scope="col">Score</th></tr></thead>
        <tbody>${shown.map(r => `<tr class="${r.resolved ? 'is-resolved' : `bk-row--${r.level}`}${S.pick === r.id ? ' is-selected' : ''}">
          <td class="num">${r.rank}</td>
          <th scope="row"><button class="link-btn" onclick="Backbone.goTo('${escAttr(r.id)}')">${esc(r.name)}</button>
            <span class="small txt-muted bk-behind">${esc(behindText(r))}</span></th>
          <td>${sevHtml(r.level, r.resolved)}</td>
          <td class="bk-keyissues">${r.issues.slice(0, 2).map(i => `<span class="bk-ki${i.sev === 'info' ? ' bk-ki--note' : ''}"><span class="bk-sw bk-c-${i.cat}" aria-hidden="true"></span>${esc(i.short)}</span>`).join('')}</td>
          <td class="bk-barcell">${barHtml(r, max)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${keyHtml()}`;
  }
  function behindText(r) {
    const R = r.R;
    return R.members.length ? `${plural(R.members.length, 'station')} behind it${R.only.length ? `, ${num(R.only.length)} only through it` : ''}` : 'no field station on record behind it';
  }

  // The period, one row a kind of trouble: when it was off air, its own
  // reports day by day, its corrupted copies day by day, its carrier on each
  // day measured, and its power.
  function timelineSvg(r, A) {
    const W = 720, L = 104, RP = 10, RH = 14, GAP = 7, TOP = 4;
    const x0 = A.from, x1 = A.to;
    const X = t => L + ((Math.min(x1, Math.max(x0, t)) - x0) / (x1 - x0)) * (W - L - RP);
    const rows = [];
    const flips = r.issues.find(i => i.kind === 'corrupt' && i.ev.n);
    const car = S.raw && Array.isArray(S.raw.tsum) ? S.raw.tsum.find(t => t.tx === 'st:' + r.id) || null : null;
    const spans = r.spans;
    const add = (key, label, body) => rows.push({ key, label, body });
    // Own reports, a cell a day — from the first day it was heard in the
    // period: before that is no record, not a silence.
    if (r.R.own.length) {
      const cells = [];
      const vals = [...r.reports.values()].filter(v => v > 0);
      const med = median(vals) || 1;
      const first = [...r.reports.keys()].filter(k => r.reports.get(k) > 0).sort()[0];
      for (let d = first ? dayMs(first) : x1 + DAY; d <= x1; d += DAY) {
        const k = isoDay(d), n = r.reports.get(k) || 0;
        const a = X(d), b = X(d + DAY);
        if (b - a < 0.5) continue;
        const cls = n === 0 ? 'bk-cell-0' : n < 0.5 * med ? 'bk-cell-1' : 'bk-cell-2';
        cells.push(`<rect class="${cls}" x="${(a + 0.5).toFixed(1)}" y="0" width="${Math.max(0.5, b - a - 1).toFixed(1)}" height="${RH}"><title>${esc(`${dayLabel(d + 12 * HOUR)}: ${n ? `${num(n)} reports` : 'nothing heard'}`)}</title></rect>`);
      }
      add('own', 'Own reports', first ? cells.join('') : `<text class="bk-axis" x="${L + 6}" y="${RH - 3}">nothing heard in the period</text>`);
    }
    const bar = (s, cls) => {
      const a = X(s.from), b = X(s.to == null ? x1 : s.to);
      return `<rect class="${cls}" x="${a.toFixed(1)}" y="1" width="${Math.max(2, b - a).toFixed(1)}" height="${RH - 2}" rx="2"><title>${esc(`${s.what}: ${when(s.from)} to ${s.to == null ? 'now' : when(s.to)}`)}</title></rect>`;
    };
    // The worst drawn last, so an area's warning never paints over a critical.
    const air = spans.filter(s => s.row === 'air' && (s.to == null || s.to >= x0)).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
    if (air.length) add('air', 'Off air', air.map(s => bar(s, s.sev === 'critical' ? 'bk-span-bad' : 'bk-span-warn')).join(''));
    if (flips && S.raw) {
      const rowsF = (S.raw.flips instanceof Map ? S.raw.flips.get(r.id) : null) || [];
      const per = new Map();
      rowsF.forEach(f => { const t = ms(f.heard_at); if (t == null || t < x0) return; const k = isoDay(t); per.set(k, (per.get(k) || 0) + 1); });
      const mx = Math.max(1, ...per.values());
      const bars = [...per.entries()].map(([k, n]) => {
        const d = dayMs(k), a = X(d), b = X(d + DAY), h = Math.max(2, (n / mx) * RH);
        return `<rect class="bk-c-bits" x="${(a + 0.5).toFixed(1)}" y="${(RH - h).toFixed(1)}" width="${Math.max(1, b - a - 1).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(`${dayLabel(d + 12 * HOUR)}: ${num(n)} corrupted`)}</title></rect>`;
      });
      add('bits', 'Corrupted', bars.join('') + spans.filter(s => s.row === 'bits').map(s => `<line class="bk-flag" x1="${X(s.from).toFixed(1)}" x2="${X(s.to == null ? x1 : s.to).toFixed(1)}" y1="${RH + 1}" y2="${RH + 1}"><title>${esc(s.what)}</title></line>`).join(''));
    }
    if (car && Array.isArray(car.days)) {
      const dots = car.days.map((d, i) => ({ t: dayMs(d), v: Number(car.ppm[i]) })).filter(p => Number.isFinite(p.v) && p.t + DAY >= x0)
        .map(p => {
          const cls = Math.abs(p.v) >= 2.5 ? 'bk-dot-bad' : Math.abs(p.v) >= 1 ? 'bk-dot-warn' : 'bk-dot-ok';
          return `<circle class="${cls}" cx="${X(p.t + 12 * HOUR).toFixed(1)}" cy="${RH / 2}" r="4"><title>${esc(`${dayLabel(p.t + 12 * HOUR)}: ${sgn(p.v, 2)} ppm from the fleet`)}</title></circle>`;
        });
      if (dots.length) add('carrier', 'Carrier', dots.join(''));
    }
    const sg = spans.filter(s => s.row === 'signal' && (s.to == null || s.to >= x0)).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
    if (sg.length) add('signal', 'Signal', sg.map(s => bar(s, s.sev === 'critical' ? 'bk-span-bad' : 'bk-span-warn')).join(''));
    const pw = spans.filter(s => s.row === 'power' && (s.to == null || s.to >= x0)).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
    if (pw.length) add('power', 'Power', pw.map(s => bar(s, s.sev === 'critical' ? 'bk-span-bad' : s.sev === 'warn' ? 'bk-span-warn' : 'bk-span-info')).join(''));
    if (!rows.length) return '';
    const H = TOP + rows.length * (RH + GAP) + 18;
    // Day ticks: every day for a week, then sparser.
    const step = A.days <= 7 ? 1 : A.days <= 14 ? 2 : A.days <= 30 ? 5 : A.days <= 60 ? 10 : 15;
    const ticks = [];
    let i = 0;
    for (let d = dayMs(isoDay(x0)) + DAY; d <= x1; d += DAY, i++) {
      if (i % step) continue;
      const x = X(d);
      ticks.push(`<line class="bk-grid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${TOP}" y2="${H - 16}"/><text class="bk-axis" x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(dayLabel(d))}</text>`);
    }
    const parts = rows.map((row, k) => {
      const y = TOP + k * (RH + GAP);
      return `<g transform="translate(0 ${y})"><text class="bk-rowlabel" x="0" y="${RH - 3}">${esc(row.label)}</text>
        <rect class="bk-track" x="${L}" y="0" width="${W - L - RP}" height="${RH}"/>${row.body}</g>`;
    });
    const said = [];
    if (air.length) said.push(`off air ${air.map(s => `from ${when(s.from)}${s.to == null ? ', still' : ` to ${when(s.to)}`}`).join('; ')}`);
    if (flips) said.push(`${num(flips.ev.n)} corrupted copies`);
    if (sg.length) said.push(`signal fading from ${when(sg[0].from)}`);
    if (pw.length) said.push(`power findings ${pw.length}`);
    return `<svg class="bk-timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(`${r.name} over the last ${A.days} days: ${said.join('; ') || 'what was found, day by day'}`)}">
      ${ticks.join('')}${parts.join('')}<line class="bk-now" x1="${W - RP}" x2="${W - RP}" y1="0" y2="${H - 16}"/>
    </svg>`;
  }

  function hoursSvg(H) {
    const W = 192, h = 34, bw = W / 24, mx = Math.max(1, ...H.h);
    return `<svg class="bk-hours" viewBox="0 0 ${W} ${h + 12}" role="img" aria-label="${escAttr(`Corrupted copies by hour of day: most between ${H.at}:00 and ${(H.at + 6) % 24}:00`)}">
      ${H.h.map((v, k) => `<rect class="bk-c-bits" x="${(k * bw + 0.5).toFixed(1)}" y="${(h - (v / mx) * h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${((v / mx) * h).toFixed(1)}"><title>${esc(`${String(k).padStart(2, '0')}:00 — ${v}`)}</title></rect>`).join('')}
      ${[0, 6, 12, 18].map(k => `<text class="bk-axis" x="${(k * bw + bw / 2).toFixed(1)}" y="${h + 10}" text-anchor="middle">${k}</text>`).join('')}
    </svg>`;
  }

  function issueHtml(i) {
    return `<li class="bk-issue bk-issue--${i.sev}">
      <h4 class="bk-issue-h"><span class="bk-sw bk-c-${i.cat}" aria-hidden="true"></span>${esc(i.title)}</h4>
      <p class="small bk-issue-meta">${sevHtml(i.sev, false)} · ${esc(CATS[i.cat].label)} · ${i.ongoing ? 'going on' : 'cleared in the period'} · score ${Math.round(i.score)}</p>
      <ul class="bk-facts">${i.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      ${i.hours && i.hours.n >= 6 ? `<figure class="bk-fig"><figcaption class="small txt-muted">By hour of day</figcaption>${hoursSvg(i.hours)}</figure>` : ''}
    </li>`;
  }

  function sectionHtml(r, A) {
    const R = r.R;
    const freq = R.rep && R.rep.tx_mhz ? `${Number(R.rep.tx_mhz).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} MHz` : '';
    const heard = r.lastHeard ? `own reports last heard ${when(r.lastHeard)}` : R.own.length ? 'its own reports not heard lately' : 'no sensors of its own';
    const bits = r.issues.some(i => i.kind === 'corrupt');
    return `<section class="panel bk-sec bk-sec--${r.resolved ? 'resolved' : r.level}" id="bk-r-${escAttr(r.id)}" aria-labelledby="bk-h-${escAttr(r.id)}">
      <div class="panel-header"><h3 id="bk-h-${escAttr(r.id)}">${r.rank}. ${esc(r.name)}</h3>${sevHtml(r.level, r.resolved)}</div>
      <p class="small txt-muted">${esc([behindText(r), freq, heard].filter(Boolean).join(' · '))} · score ${Math.round(r.score)}</p>
      ${timelineSvg(r, A)}
      ${r.points.length ? `<div class="bk-points"><b>What it points to.</b> ${r.points.map(esc).join(' ')}</div>` : ''}
      <ol class="bk-issues">${r.issues.map(issueHtml).join('')}</ol>
      <p class="small bk-links">
        <button class="link-btn" onclick="Backbone.showOnMap('${escAttr(r.id)}', true)">Show on the map above</button> ·
        <button class="link-btn" onclick="Backbone.openHealth('${escAttr(r.id)}')">Open in Station Health</button> ·
        <button class="link-btn" onclick="Backbone.openStation('${escAttr(r.id)}')">Open in Stations</button>
        ${bits ? ' · <button class="link-btn" onclick="switchTab(\'flipsources\')">Bit-Flip Sources</button>' : ''}
        ${signedIn() ? ' · <button class="link-btn" onclick="switchTab(\'signalroutes\')">Signal Routes</button>' : ''}
      </p>
    </section>`;
  }

  function minorHtml(A, rows) {
    if (!rows.length) return '';
    return `<div class="panel">
      <details class="bk-minor" data-k="minor"><summary><h3 class="bk-inline-h" id="bk-h-minor">Notes only — ${plural(rows.length, 'repeater')}</h3></summary>
        <p class="small">Each has only a note in this period — something worth knowing, nothing at fault.</p>
        <ul class="bk-minor-list">${rows.map(r => `<li><button class="link-btn" onclick="Backbone.openHealth('${escAttr(r.id)}')">${esc(r.name)}</button>
          — ${r.issues.map(i => esc(i.short)).join('; ')}</li>`).join('')}</ul>
      </details></div>`;
  }

  function howHtml(A) {
    return `<div class="panel">
      <details class="bk-how" data-k="how"><summary><h3 class="bk-inline-h" id="bk-h-how">How it is worked out</h3></summary>
        <p class="small">Every repeater on record, with what the network's own tools found about it in the period: Station Health's findings (its own station
          silent, the stations behind it gone quiet together, its battery) and when each opened and cleared; the carrier fingerprint every burst it relays
          carries (Station Health's <em>Transmitter frequency</em>); the corrupted copies that came on that carrier (<em>Bit-Flip Sources</em>); and, for editors,
          its pass ranges on record against what it really relays (<em>Signal Routes</em>).</p>
        <p class="small"><b>The ranking.</b> Each issue scores its severity (critical 10, warning 4, note 1) × how much of the network leans on the repeater
          (1 to 2.5 — the field stations only it passes in full and the others a quarter) × whether it is still going on (1, or ½ once it cleared) × what
          kind of trouble it is (off air 1.2, corrupted relays 1, dropping out and power 0.8, carrier 0.7, pass ranges 0.5); corrupted copies count up to half
          again as they mount. A repeater's score is the sum, and the repeaters are ranked by it; its state is the worst of what is still going on.
          The stations behind a repeater are the field stations whose addresses its pass ranges hold, within ${REACH_KM} km of it.</p>
        <p class="small"><b>Reading it.</b> "As strong as the clean copy" means the bits were already wrong when the repeater sent them: its receiver heard the
          station badly, or its radio is failing — not our receiver mishearing it. "Reached us clean another way" means the error entered at this repeater.
          Interference keeps hours; a failing radio does not. A carrier measured on one or two days, and a day far from the rest, can be a receiver's tuning
          rather than the repeater: say so before it is a crystal. The history behind these findings began on 21 October 2026, so a long period holds what
          there is.</p>
      </details></div>`;
  }

  function render() {
    const A = S.A;
    let body;
    if (S.phase === 'error' && !A) {
      body = `<p class="txt-bad" role="alert">${esc(S.err)}</p><p><button class="btn" onclick="Backbone.refresh()">Try again</button>
        <button class="btn" onclick="Backbone.demo()">Show a demo</button></p>`;
    } else if (!A) {
      body = `<p class="small" role="status">Reading the network's findings, carriers and corrupted copies for the last ${S.days} days…</p>`;
    } else {
      body = `${statusHtml()}${tilesHtml(A)}`;
    }
    const { main, more, minor } = A ? split(A) : { main: [], more: 0, minor: [] };
    const moreHtml = more ? `<p><button class="btn" onclick="Backbone.showAll(true)">Show all ${num(main.length + more)} repeaters with a warning or worse</button></p>`
      : S.all && main.length > TOP ? `<p><button class="btn" onclick="Backbone.showAll(false)">Show the first ${TOP} only</button></p>` : '';
    return `
    <div class="page bk-page" style="--page-max:1200px">
      <div class="panel">
        <div class="panel-header"><h2>State of the backbone</h2></div>
        <p class="small txt-muted">The repeaters that carry the network's readings to the base stations, ranked by what has gone wrong with each over the
          period: off air, dropping out, relaying corrupted copies, a carrier off the fleet or moving, power, and pass ranges against what each really relays.
          Worst first; inside each, its worst issue first.</p>
        ${periodHtml()}
        ${body}
      </div>
      ${A ? `
      <div class="panel">
        <div class="panel-header"><h3 id="bk-h-summary">Summary</h3><span class="small">${main.length ? `${more ? `the worst ${num(main.length)} of ${num(main.length + more)}` : plural(main.length, 'repeater')}, worst first` : ''}</span></div>
        ${summaryHtml(A, main)}
        ${moreHtml}
        ${airHtml()}
        <div id="bk-map" class="bk-map" aria-label="Map of the repeaters in the summary, coloured by state and sized by score; one picked shows the stations behind it, those quiet now in red. The summary table holds the same."></div>
        <p class="small"><span class="txt-bad">●</span> critical · <span class="txt-warn">●</span> warning · <span class="txt-muted">●</span> note or cleared ·
          bigger is a higher score · ◆ base stations. Pick a repeater to show the stations behind it.</p>
      </div>
      ${main.map(r => sectionHtml(r, A)).join('')}
      ${minorHtml(A, minor)}
      ${howHtml(A)}` : ''}
    </div>`;
  }

  function redraw() {
    const host = typeof state !== 'undefined' && state.activeTab === 'backbone' ? document.getElementById('main-content') : null;
    if (!host) return;
    const y = typeof window !== 'undefined' ? window.scrollY : 0;
    // The folds left open stay open through a redraw — the quarter-hourly one too.
    const open = [...host.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
    host.innerHTML = render();
    open.forEach(k => { const d = host.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
    initMap();
    if (y && typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, y);
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function stopMap() {
    if (S.map) { try { removeMap(S.map); } catch (_) { /* gone */ } }
    S.map = null; S.layer = null;
  }
  function cssVar(name, dflt) {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt; } catch (_) { return dflt; }
  }
  function initMap() {
    stopMap();
    const el = document.getElementById('bk-map');
    if (!el || typeof L === 'undefined' || !S.A) return;
    S.map = L.map('bk-map', { scrollWheelZoom: false }).setView([-27.5, 152.6], 8);
    if (typeof registerLiveMap === 'function') registerLiveMap('Backbone', () => S.map);
    if (typeof addBaseLayers === 'function') addBaseLayers(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    S.fitted = false;
    drawMap();
  }
  function drawMap() {
    const A = S.A;
    if (!S.map || !S.layer || !A) return;
    S.layer.clearLayers();
    const pts = [];
    const colour = r => (r.resolved || r.level === 'info' ? cssVar('--muted', '#4f6478') : r.level === 'critical' ? cssVar('--bad', '#c7401a') : cssVar('--warn', '#9e5e00'));
    const pick = S.pick ? A.rows.find(r => r.id === S.pick) : null;
    if (pick && placed(pick.R.st)) {
      pick.R.members.forEach(s => {
        if (!placed(s)) return;
        const quiet = A.quietNow.has(s.id);
        L.polyline([[pick.R.st.lat, pick.R.st.lon], [s.lat, s.lon]], { weight: 1, opacity: quiet ? 0.7 : 0.25,
          color: quiet ? cssVar('--bad', '#c7401a') : cssVar('--muted', '#4f6478'), dashArray: quiet ? null : '3 4' }).addTo(S.layer);
        L.circleMarker([s.lat, s.lon], { radius: quiet ? 4 : 3, weight: 1, fillOpacity: 0.8,
          color: quiet ? cssVar('--bad', '#c7401a') : cssVar('--accent', '#0b5cab') })
          .bindTooltip(`${s.name}${quiet ? ' — quiet now' : ''}${pick.R.only.includes(s) ? ' (only through this repeater)' : ''}`).addTo(S.layer);
        pts.push([s.lat, s.lon]);
      });
    }
    stations().filter(s => (s.roles || []).includes('base') && placed(s)).forEach(s => {
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'bk-base-icon', html: '◆', iconSize: [14, 14] }), keyboard: false })
        .bindTooltip(`${s.name} (base station)`).addTo(S.layer);
    });
    A.rows.filter(r => r.level !== 'info').reverse().forEach(r => {
      if (!placed(r.R.st)) return;
      const m = L.circleMarker([r.R.st.lat, r.R.st.lon], { radius: 5 + Math.min(12, Math.sqrt(r.score)), weight: S.pick === r.id ? 3 : 1.5,
        color: colour(r), fillOpacity: 0.65 });
      m.bindTooltip(`${r.rank}. ${r.name} — ${r.resolved ? 'cleared' : SEV[r.level].label.toLowerCase()}, score ${Math.round(r.score)}: ${r.issues.slice(0, 2).map(i => i.short).join('; ')}`);
      m.on('click', () => showOnMap(r.id));
      m.addTo(S.layer);
      if (!pick) pts.push([r.R.st.lat, r.R.st.lon]);
    });
    if (pick && placed(pick.R.st)) pts.push([pick.R.st.lat, pick.R.st.lon]);
    if (pts.length && !S.fitted) { try { S.map.fitBounds(pts, { padding: [24, 24], maxZoom: 10 }); S.fitted = true; } catch (_) { /* one point */ } }
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  function setDays(d) {
    S.days = PERIODS.includes(Number(d)) ? Number(d) : DEFAULT_DAYS;
    writeLS(DAYS_KEY, String(S.days));
    S.pick = null;
    if (S.demo) { S.A = analyse(demoRaw()); redraw(); return; }
    load();
  }
  function refresh() { if (S.demo) { S.demo = false; S.A = null; } load(); }
  function showAll(on) { S.all = !!on; redraw(); }
  function goTo(rid) {
    const el = document.getElementById('bk-r-' + rid);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const h = document.getElementById('bk-h-' + rid);
    if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (_) { /* old browser */ } }
  }
  // From the map or the summary a second press lets go; from a section it
  // always shows (`keep`).
  function showOnMap(rid, keep) {
    S.pick = keep ? rid : S.pick === rid ? null : rid;
    S.fitted = false;
    redraw();
    const el = document.getElementById('bk-map');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }
  function openHealth(rid) {
    if (typeof Health !== 'undefined' && Health.showStation) Health.showStation(rid, 'findings');
    else if (typeof switchTab === 'function') switchTab('health');
  }
  function openStation(rid) { if (typeof goToStation === 'function') goToStation(rid); }

  // Every fifteen minutes while the tab is open and the page is visible.
  function startTimer() {
    stopTimer();
    S.timer = setInterval(() => {
      if (typeof state === 'undefined' || state.activeTab !== 'backbone') { stopTimer(); return; }
      if (S.demo || S.phase === 'loading' || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      load(true);
    }, REFRESH_MS);
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  // app.js's renderMain: the page, then the map, the clock and the data.
  function init() {
    if (typeof registerTabTeardown === 'function') registerTabTeardown('Backbone', () => { stopMap(); stopTimer(); });
    if (!S.readDays) {
      S.readDays = true;
      const d = Number(readLS(DAYS_KEY));
      if (PERIODS.includes(d) && d !== S.days) { S.days = d; redraw(); }
    }
    startTimer();
    const stale = !S.loadedAt || Date.now() - S.loadedAt > REFRESH_MS;
    if (!S.demo && S.phase !== 'loading' && (!S.A || stale)) load(!!S.A);
    else initMap();
  }
  // Signing in or out: who may read the receptions changed, so the pass-range
  // line and the links change with it. The findings are the same for anybody.
  function authChanged() {
    if (S.raw && !S.demo) S.A = analyse(S.raw);
    redraw();
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportCsv() {
    const A = S.A;
    if (!A || !A.rows.length) return;
    const head = ['rank', 'repeater', 'station_id', 'score', 'state', 'stations_behind', 'only_through_it', 'issue', 'kind', 'severity', 'going_on', 'issue_score', 'evidence'];
    const lines = [head.join(',')];
    A.rows.forEach(r => r.issues.forEach(i => lines.push([r.rank, r.name, r.id, Math.round(r.score), r.resolved ? 'cleared' : r.level,
      r.R.members.length, r.R.only.length, i.title, CATS[i.cat].label, i.sev, i.ongoing ? 'yes' : 'no', Math.round(i.score), i.facts.join(' ')]
      .map(csvEscape).join(','))));
    dlText(`backbone-${A.demo ? 'demo-' : ''}${A.days}d.csv`, lines.join('\n') + '\n');
  }
  // The summary as text, for a meeting's notes or an email.
  function summaryText() {
    const A = S.A;
    if (!A) return '';
    const out = [`State of the backbone — the last ${A.days} days, to ${when(A.to)}${A.demo ? ' (DEMO — made-up findings)' : ''}`, ''];
    A.rows.filter(r => r.level !== 'info').forEach(r => {
      out.push(`${r.rank}. ${r.name} — ${r.resolved ? 'cleared' : SEV[r.level].label.toLowerCase()} (score ${Math.round(r.score)}): ${r.issues.slice(0, 2).map(i => i.short).join('; ')}`);
      if (r.points.length) out.push(`   ${r.points[0]}`);
    });
    return out.join('\n') + '\n';
  }
  function exportText() {
    const A = S.A;
    if (!A || !A.rows.length) return;
    dlText(`backbone-summary-${A.demo ? 'demo-' : ''}${A.days}d.txt`, summaryText(), 'text/plain');
  }

  // ── The demo: a made-up month on the real station file ───────────────────
  // Five repeaters, each with a different kind of trouble planted: one off air
  // after a fortnight of corrupting half of what it relays (all hours, clean
  // copies upstream) with no daily charge; one whose stations went quiet
  // together, its carrier swinging and its corrupted copies keeping evening
  // hours; one dropping out overnight with its battery low; one whose carrier
  // sits three parts per million off the fleet; one with only a note.
  function demoRaw() {
    const reg = register();
    const now = Date.now(), days = S.days, from = now - days * DAY;
    const iso = t => new Date(t).toISOString();
    const home = { lat: -27.47, lon: 152.95 };
    const picks = reg.reps.filter(r => placed(r.st) && r.members.length >= 3 && (km(home, r.st) || 999) < 160)
      .sort((a, b) => b.members.length - a.members.length).slice(0, 5);
    while (picks.length < 5 && reg.reps[picks.length]) picks.push(reg.reps.find(r => !picks.includes(r)));
    const [R1, R2, R3, R4, R5] = picks;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    let id = 1;
    const F = (o) => Object.assign({ id: id++, source: 'stations', subject: `${o.kind}:${o.station_id || ''}`, station_id: null, severity: 'warn',
      title: '', detail: '', evidence: {}, first_seen: iso(now - DAY), last_seen: iso(now - HOUR), cleared_at: null }, o);
    const findings = [], network = [], openSilent = [], tsum = [], fsum = [], daily = [], health = [];
    const flips = new Map();
    const quietSome = (R, k) => R.members.slice(0, k).forEach(s => openSilent.push({ station_id: s.id, severity: 'warn', first_seen: iso(now - DAY) }));
    const ownDays = (R, stopAt) => { for (let d = dayMs(isoDay(from)); d <= now; d += DAY) if (d < stopAt) daily.push({ station_id: R.id, bucket: isoDay(d), n: 8 + Math.floor(rnd() * 3) }); };
    const flipRows = (R, n, hourOf, upstreamEvery) => {
      const out = [];
      const addrs = R.members.flatMap(s => (typeof stationAlertIds === 'function' ? stationAlertIds(s) : [])).slice(0, 12);
      for (let k = 0; k < n; k++) {
        const d = from + rnd() * (now - from - 2 * DAY) + DAY;
        const t = new Date(d); t.setHours(hourOf(k), Math.floor(rnd() * 60));
        const a = addrs.length ? addrs[k % addrs.length] : 4000 + k;
        const flipAddr = k % 3 === 0;
        out.push({ heard_at: iso(Math.min(now - HOUR, t.getTime())), true_addr: a, true_value: 120 + k, bad_addr: flipAddr ? a ^ 16 : a, bad_value: flipAddr ? 120 + k : (120 + k) ^ 64,
          bits: 1, addr_flip: flipAddr, gap_s: 2.4, rule: 'fit', bad_snr: 21, good_snr: 22, bad_tx: 'st:' + R.id, bad_how: 'carrier',
          good_tx: upstreamEvery && k % upstreamEvery === 0 ? 'st:' + (R.members[0] ? R.members[0].id : 'x') : 'st:' + R.id, good_measured: true });
      }
      return out;
    };
    if (R1) {
      const off = now - 16 * HOUR;
      ownDays(R1, off);
      findings.push(F({ kind: 'silent', station_id: R1.id, subject: 'silent:' + R1.id, severity: 'critical', title: 'Silent — missed its last 5 checks',
        evidence: { lastHeard: off, since: iso(off), periodMin: 180, trailingMisses: 5 }, first_seen: iso(off + 9 * HOUR) }));
      findings.push(F({ source: 'transmitters', kind: 'transmitter-corrupting', station_id: R1.id, subject: 'st:' + R1.id, severity: 'critical',
        title: `${R1.st.name}: 48 corrupted copies in a week (46.0% of what it sent)`, first_seen: iso(now - 12 * DAY), evidence: { rate: 0.46 } }));
      findings.push(F({ kind: 'battery-no-charge', station_id: R1.id, subject: 'battery-no-charge:' + R1.id, severity: 'info',
        title: 'No daily charge — battery flat-lining at 13.1 V', detail: 'A solar station\'s battery rises through the day; this one moved 0.1 V between night and day over 6 nights.',
        evidence: { medianV: 13.1, swingV: 0.1, action: 'Check the panel, its cable, the regulator and the fuse — no daily charge is reaching the battery.' }, first_seen: iso(now - 5 * DAY) }));
      fsum.push({ tx: 'st:' + R1.id, station_id: R1.id, bursts: 104, flips: 48, rate: 0.46, clear: 47, clear_rate: 0.45, clean_upstream: 6, addr_flips: 16, addresses: 20, top: [], fleet_rate: 0.0004 });
      flips.set(R1.id, flipRows(R1, 60, k => k % 24, 8));
      quietSome(R1, Math.min(4, R1.members.length));
      health.push({ station_id: R1.id, last_seen_at: iso(off) });
    }
    if (R2) {
      const down = now - 2.2 * DAY;
      findings.push(F({ source: 'transmitters', kind: 'transmitter-corrupting', station_id: R2.id, subject: 'st:' + R2.id, severity: 'warn',
        title: `${R2.st.name}: 22 corrupted copies in a week (6.2% of what it sent)`, first_seen: iso(now - 9 * DAY), cleared_at: iso(down), evidence: { rate: 0.062 } }));
      network.push(F({ kind: 'repeater-down', subject: 'repeater-down:rep:' + R2.id, severity: 'critical',
        title: `${Math.min(8, R2.members.length)} stations behind ${R2.st.name} went quiet together`, first_seen: iso(down + 4 * HOUR),
        evidence: { stations: R2.members.slice(0, 8).map(s => s.id), repeaters: [R2.id], from: down, to: down + 2 * HOUR, stillHeard: 1 } }));
      tsum.push({ tx: 'st:' + R2.id, via: 'repeater', freq_mhz: Number(R2.rep.tx_mhz) || 151.525, days: [isoDay(now - 6 * DAY), isoDay(now - 3 * DAY)], ppm: [1.4, -1.5], bursts: 168, receivers: 1 });
      fsum.push({ tx: 'st:' + R2.id, station_id: R2.id, bursts: 355, flips: 22, rate: 0.062, clear: 22, clear_rate: 0.062, clean_upstream: 3, addr_flips: 9, addresses: 11, top: [], fleet_rate: 0.0004 });
      flips.set(R2.id, flipRows(R2, 26, k => [19, 20, 21, 22, 23, 0, 1][k % 7], 0).filter(f => ms(f.heard_at) < down));
      quietSome(R2, Math.min(8, R2.members.length));
    }
    if (R3) {
      ownDays(R3, now + DAY);
      [9, 6, 2].forEach((dAgo, k) => {
        const t = new Date(now - dAgo * DAY); t.setHours(19 + k, 10);
        findings.push(F({ kind: 'silent', station_id: R3.id, subject: 'silent:' + R3.id, severity: 'warn', title: 'Silent — missed its last 3 checks',
          evidence: { lastHeard: t.getTime(), periodMin: 180, trailingMisses: 3 }, first_seen: iso(t.getTime() + 9 * HOUR), cleared_at: iso(t.getTime() + 13 * HOUR) }));
      });
      findings.push(F({ kind: 'battery-low', station_id: R3.id, subject: 'battery-low:' + R3.id, severity: 'warn', title: 'Battery low — 12.0 V at night',
        detail: 'Its night-time lows have sat near 12.0 V for a week: half charge for a lead-acid battery.', evidence: { medianV: 12.0 },
        first_seen: iso(now - 8 * DAY), cleared_at: iso(now - 3 * DAY) }));
      health.push({ station_id: R3.id, last_seen_at: iso(now - 40 * 60e3) });
    }
    if (R4) {
      tsum.push({ tx: 'st:' + R4.id, via: 'repeater', freq_mhz: Number(R4.rep.tx_mhz) || 151.525,
        days: [4, 3, 2, 1].map(k => isoDay(now - k * DAY)), ppm: [-2.8, -2.9, -2.7, -2.8], bursts: 960, receivers: 1 });
      findings.push(F({ source: 'transmitters', kind: 'transmitter-off-channel', station_id: R4.id, subject: 'st:' + R4.id, severity: 'warn',
        title: `${R4.st.name}: transmitting -2.8 ppm off the others (-424 Hz)`, first_seen: iso(now - 3 * DAY) }));
    }
    if (R5) {
      fsum.push({ tx: 'st:' + R5.id, station_id: R5.id, bursts: 900, flips: 3, rate: 0.003, clear: 2, clear_rate: 0.002, clean_upstream: 0, addr_flips: 1, addresses: 3, top: [], fleet_rate: 0.0004 });
      flips.set(R5.id, flipRows(R5, 3, k => 3 + k * 5, 0));
    }
    return { now, from, to: now, days, demo: true, findings, network, openSilent, tsum, fsum, fsrc: [], daily, health, flips };
  }
  function demo() {
    if (!stations().length) return;
    ++S.seq;
    S.demo = true; S.raw = demoRaw(); S.A = analyse(S.raw); S.phase = 'ready'; S.err = ''; S.note = ''; S.loadedAt = Date.now(); S.pick = null;
    redraw();
  }

  // For the tests: fill it from what the server would have answered.
  function adopt(raw) {
    ++S.seq;
    const r = Object.assign({ now: Date.now(), days: S.days }, raw);
    r.from = r.from != null ? r.from : r.now - r.days * DAY;
    r.to = r.to != null ? r.to : r.now;
    if (!(r.flips instanceof Map)) r.flips = new Map(Object.entries(r.flips || {}));
    S.demo = !!r.demo; S.raw = r; S.A = analyse(r); S.phase = 'ready'; S.err = ''; S.note = ''; S.loadedAt = Date.now();
    redraw();
  }
  function state_() { return { days: S.days, phase: S.phase, err: S.err, demo: S.demo, pick: S.pick, A: S.A, note: S.note, air: S.air }; }

  return { render, init, load, refresh, demo, adopt, analyse, setDays, showAll, goTo, showOnMap, openHealth, openStation, readAir, authChanged,
    exportCsv, exportText, summaryText, register, state: state_, PERIODS };
})();
