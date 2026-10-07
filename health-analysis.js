// MegaNet — health-analysis.js
//
//   HealthAnalysis   the Station Health tab's reasoning, with no page in it:
//                    readings in, findings out. What each station's check
//                    schedule is and how much of it arrived; what its battery
//                    is doing across its solar day; whether its rain gauge and
//                    level sensor agree with their neighbours; which receivers
//                    were listening when; which repeater or area a run of
//                    silences has in common; and which stored readings are
//                    corrupted copies or ghosts rather than data.
//
// After core.js, app.js (stationAlertIds) and sensor-values.js (SensorValues);
// before health.js and health-agent.js, which read it. Nothing here runs at
// load, nothing here touches the DOM, and nothing here fetches: health.js
// hands it rows in meganet.reading's shape and draws what comes back, and
// test/health.mjs holds it to a week whose answer is known (demoWorld).
//
// ── What a reading is evidence of ────────────────────────────────────────────
// The tab exists for the questions the operation and maintenance of a field
// station actually asks, and each one is answered from the readings alone:
//
//   Is it still talking?      An ALERT station sends a timed report from every
//                             sensor — a "check" — every few hours (three, at
//                             the stations the Raspberry Pi feed hears most; two
//                             and half an hour at others), between whatever
//                             events it reports. The schedule is learned per
//                             station, not assumed: the period whose phase the
//                             station's transmissions keep, scored by checks
//                             heard minus checks missed. Then every slot in the
//                             window is a check received, a check received with
//                             a sensor missing, a check missed — or unknown,
//                             because nothing that ever heard this station was
//                             listening then.
//
//   Is the receiver the problem?
//                             A missed check only counts against a station when
//                             a receiver that has heard it was demonstrably
//                             listening — delivering other traffic — at the
//                             time. A slot most of the network missed at once is
//                             the network's (the receiver, a channel, a burst of
//                             interference), not each station's, and is counted
//                             apart.
//
//   Is its battery going?     Solar stations swing through the day: the battery
//                             is lowest just before dawn and highest in the
//                             afternoon, by half a volt or more. A trend is only
//                             a trend measured like for like, so it is the night
//                             minimum, in the station's own solar time, that is
//                             trended (Theil–Sen, which one bad night cannot
//                             move) — and the day's swing says whether charge is
//                             arriving at all.
//
//   Is the sensor right?      A rain gauge that recorded nothing while the
//                             gauges around it recorded a storm has a blocked
//                             funnel; one that recorded a storm alone was tipped.
//                             A level that did not move through rain nearby is
//                             stuck. That is the "packets received at a similar
//                             time" half of the context: a reading judged
//                             against its neighbours in space as well as in time.
//
//   Is it a reading at all?   A repeater that relays with bit errors produces a
//                             second, different copy of a reading a few seconds
//                             after the first — and because the datastore keys a
//                             reading on (address, time, value), the corrupted
//                             copy is *stored as a reading*. ~2% of what the
//                             Raspberry Pi feed stored in its first days is
//                             exactly this, 135 V heard as 151 and 1175 two
//                             seconds later. A flip in the address bits stores
//                             it under another address altogether: a ghost.
//                             Both are found and set aside before anything else
//                             is worked out, and both are evidence against the
//                             repeaters that could have carried them.
//
// Every finding carries its evidence as numbers and a suggested action in the
// words a technician would use, because a list of red badges that cannot say
// why is a list nobody acts on.

const HealthAnalysis = (() => {

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  // The copies of one transmission land within this of the first: direct, then
  // each repeater's re-send. Measured on the stored readings: a corrupted copy
  // arrives a median 2.7 s after the clean one and never more than 10 s.
  const COPY_WINDOW = 12000;
  // A station's check: every sensor's frame, a few seconds apart (rain, level,
  // battery at 5.4 s spacing at Strathpine), inside a minute and a half.
  const BURST_WINDOW = 90000;
  // A station reporting faster than its copies land — a rain gauge tipping
  // every six to eleven seconds through a storm, as a:5356 did in the first
  // week of stored readings — puts two real values inside one copy window,
  // and the second reads as a corrupted copy of the first. It is a report if
  // the address's next (or last) transmission, this soon, carries on past it.
  const RAPID_MS = 120000;
  const RAPID_STEP = 8;     // counts — a report in such a run moves a few; a flipped bit can move a thousand
  // A repeater further than this from a station cannot be relaying it; one
  // further than this from where a receiver hears could not be heard
  // (SensorValues.FAR_KM, the same bound for an address).
  const REACH_KM = 400;
  // Counts. A value this near its own address's last or next transmission is
  // that address's own report; further, and a frame on another address it
  // could be a corrupted copy of says it is a ghost.
  const FIT_TOL = 5;
  // Timed-report intervals an ALERT logger is set to. The schedule is chosen
  // among these rather than fitted freely, because a free fit to a station
  // that missed every other check finds a period of six hours, and the station
  // is set to three.
  const PERIODS = [15, 30, 60, 120, 180, 240, 360, 720, 1440].map(m => m * MIN);
  // Receiver coverage, in bins: a receiver was listening at a moment if it
  // delivered anything within LISTEN_PAD bins either side of it.
  const BIN = 10 * MIN;
  const LISTEN_PAD = 2;
  // A check whose report has not had time to arrive is not missed yet.
  const ARRIVAL_GRACE = 2 * MIN;
  // Network-wide miss events: a quarter hour in which most of what was due
  // was missed is the network's, not each station's.
  const NET_BIN = 15 * MIN;
  const NET_MIN_DUE = 5;
  const NET_MISS_FRAC = 0.6;

  // Battery. 12.2 V at rest is a lead-acid battery at roughly half charge, and
  // 11.8 V is the point past which a station's radio starts to brown out.
  const BATT_WARN_V = 12.2;
  const BATT_CRIT_V = 11.8;
  const BATT_OVER_V = 15.0;
  const BATT_FALL_V_PER_DAY = -0.04;
  const BATT_SWING_MIN_V = 0.15;

  const RAIN_NEAR_KM = 30;
  // A gauge reports tips as they come, so consecutive transmissions in a storm
  // differ by a tip or a few. A jump of this many between two of them is a
  // frame that was not the gauge, or a counter rewritten — unconfirmed, and
  // never counted as rain on its own word.
  const RAIN_BIG_STEP = 50;
  const AREA_KM = 30;

  const SEV_RANK = { critical: 0, warn: 1, info: 2 };
  const CAT_RANK = { network: 0, power: 1, comms: 2, sensor: 3, data: 4, register: 5 };

  // ── small arithmetic ────────────────────────────────────────────────────────

  function pop(x) { x = x >>> 0; let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }
  function median(xs) { return SensorValues.median(xs); }
  function quantile(xs, q) {
    const s = xs.filter(x => isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }
  // The median of every pairwise slope. One wild point moves an ordinary least
  // squares line; it cannot move this.
  function theilSen(xs, ys) {
    const s = [];
    const n = xs.length;
    // Thinned evenly past 60 points — the pairs grow as n², and a slope over
    // a week does not need every one of them.
    const step = n > 60 ? Math.ceil(n / 60) : 1;
    for (let i = 0; i < n; i += step) {
      for (let j = i + step; j < n; j += step) {
        if (xs[j] !== xs[i]) s.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
      }
    }
    return s.length ? median(s) : null;
  }
  const km = (a, b) => SensorValues.km(a.lat, a.lon, b.lat, b.lon);
  const placed = s => s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);
  const mod = (a, n) => ((a % n) + n) % n;
  const round = (v, dp) => { const k = Math.pow(10, dp || 0); return Math.round(v * k) / k; };

  // First index in a sorted array with a[i] >= x.
  function lowerBound(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }
  // The element of sorted `a` nearest x, within tol, or -1.
  function nearestWithin(a, x, tol) {
    const i = lowerBound(a, x - tol);
    let best = -1, bd = Infinity;
    for (let j = i; j < a.length && a[j] <= x + tol; j++) {
      const d = Math.abs(a[j] - x);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  function fmtClock(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtWhen(t, now) {
    const d = new Date(t), n = new Date(now == null ? Date.now() : now);
    const p = x => String(x).padStart(2, '0');
    const sameDay = d.toDateString() === n.toDateString();
    const yest = new Date(n.getTime() - DAY).toDateString() === d.toDateString();
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (sameDay) return `${hm} today`;
    if (yest) return `${hm} yesterday`;
    return `${hm} ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  }
  function fmtSpan(ms) {
    const m = Math.round(ms / MIN);
    if (m < 90) return `${m} min`;
    const h = ms / HOUR;
    if (h < 48) return `${round(h, h < 10 ? 1 : 0)} h`;
    return `${round(ms / DAY, 1)} days`;
  }
  function fmtPeriod(P) {
    const m = P / MIN;
    return m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${round(m / 60, 1)} h`;
  }
  function dayKey(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`; }
  // A receiver as people say it: "rpi-6dfef7f4", not "serial-monitor/rpi-6dfef7f4".
  const hostName = h => String(h || '').replace(/^serial-monitor\//, '').replace(/^meganet\/v1\/([^/]+)\/logger\/reading\//, '$1 · ');

  // ── the register's repeaters ─────────────────────────────────────────────────

  function repeatersOf(stations) {
    const out = [];
    for (const s of stations || []) {
      const r = s.repeater;
      if (!r || !Array.isArray(r.pass_ranges) || !r.pass_ranges.length) continue;
      out.push({ st: s, ranges: r.pass_ranges, excl: r.exclusions || [] });
    }
    return out;
  }
  function passes(rep, aid) {
    if (!rep.ranges.some(x => aid >= x.low && aid <= x.high)) return false;
    return !rep.excl.some(x => (typeof x === 'number' ? x === aid : (aid >= x.low && aid <= x.high)));
  }

  // ── 1. normalise ─────────────────────────────────────────────────────────────

  function normalise(rows) {
    const out = [];
    for (const r of rows || []) {
      const t = Date.parse(r.reading_ts);
      const v = Number(r.value_raw);
      if (!isFinite(t) || !isFinite(v)) continue;
      const rt = Date.parse(r.received_at);
      out.push({
        r, t, rt: isFinite(rt) ? rt : null, v,
        aid: r.alert_id != null ? Number(r.alert_id) : null,
        addr: r.addr || (r.alert_id != null ? 'a:' + r.alert_id : ''),
        path: r.path || '', host: SensorValues.hostOf(r.path || '') || '(no path)',
        proto: r.protocol, alert: r.protocol === 1 || r.protocol === 2 || r.protocol == null && r.alert_id != null,
        lvl: r.rssi_dbm != null ? Number(r.rssi_dbm) : r.level_dbfs != null ? Number(r.level_dbfs) : null,
        lvlUnit: r.rssi_dbm != null ? 'dBm' : r.level_dbfs != null ? 'dBFS' : null,
        snr: r.snr_db != null ? Number(r.snr_db) : null,
      });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // ── 2. receivers ─────────────────────────────────────────────────────────────

  function receivers(recs, t0, t1, now) {
    const hosts = new Map();
    for (const x of recs) {
      let h = hosts.get(x.host);
      if (!h) hosts.set(x.host, h = { host: x.host, paths: new Map(), times: [], lags: [], bins: new Set(), addrs: new Set(), corrupted: 0, sig: [], snr: [] });
      h.times.push(x.t);
      if (x.rt != null) h.lags.push((x.rt - x.t) / 1000);
      h.bins.add(Math.floor(x.t / BIN));
      if (x.aid != null) h.addrs.add(x.aid);
      if (x.lvl != null) { h.sig.push(x.lvl); h.sigUnit = x.lvlUnit; }
      if (x.snr != null) h.snr.push(x.snr);
      let p = h.paths.get(x.path);
      if (!p) h.paths.set(x.path, p = { path: x.path, n: 0, first: x.t, last: x.t, freq: null, bins: new Set() });
      p.n++; p.last = x.t;
      p.bins.add(Math.floor(x.t / BIN));
      if (x.r.freq_mhz != null && p.freq == null) p.freq = Number(x.r.freq_mhz);
    }
    const list = [];
    hosts.forEach(h => {
      const ts = h.times;
      // Gaps between bursts, not between readings: a gateway that posts a
      // station's six sensors once an hour has a median gap of seconds and
      // an hour between posts, and the hour is its rhythm, not an outage.
      const bt = [];
      ts.forEach(t => { if (!bt.length || t - bt[bt.length - 1] > 2 * MIN) bt.push(t); });
      const gaps = [];
      for (let i = 1; i < bt.length; i++) gaps.push(bt[i] - bt[i - 1]);
      const typical = gaps.length ? median(gaps) : HOUR;
      const outGap = Math.max(45 * MIN, 4 * (quantile(gaps, 0.9) || HOUR));
      const outages = [];
      if (bt.length >= 30) {
        for (let i = 1; i < bt.length; i++) {
          if (bt[i] - bt[i - 1] > outGap) outages.push({ from: bt[i - 1], to: bt[i], ms: bt[i] - bt[i - 1] });
        }
      }
      const hourly = new Map();
      ts.forEach(t => { const k = Math.floor(t / HOUR); hourly.set(k, (hourly.get(k) || 0) + 1); });
      const spanH = Math.max(1, (Math.min(t1, ts[ts.length - 1]) - Math.max(t0, ts[0])) / HOUR);
      list.push({
        host: h.host,
        paths: [...h.paths.values()].sort((a, b) => b.n - a.n),
        span: ts[ts.length - 1] - ts[0],
        n: ts.length, first: ts[0], last: ts[ts.length - 1],
        addrs: h.addrs.size, perHour: ts.length / spanH,
        typicalGapMs: typical, outages, hourly, bins: h.bins,
        lag: { p05: quantile(h.lags, 0.05), p50: quantile(h.lags, 0.5), p95: quantile(h.lags, 0.95) },
        sig: h.sig.length ? { p50: quantile(h.sig, 0.5), unit: h.sigUnit || null } : null,
        snr: h.snr.length ? { p50: quantile(h.snr, 0.5) } : null,
        silentFor: now - ts[ts.length - 1],
        corrupted: 0, ghosts: 0,
      });
    });
    list.sort((a, b) => b.n - a.n);
    return list;
  }

  // Was any of these hosts listening at t? Delivering something within
  // LISTEN_PAD bins before it *and* within LISTEN_PAD bins after it is the
  // evidence. One side is not enough: a receiver that died at 02:03 delivered
  // plenty at 01:55, and a check due at 02:10 that it could not hear would
  // otherwise be counted against the station.
  function makeListening(rx) {
    // By ingress path, not by host: a Pi with three sticks on three channels
    // is three receivers, and a stick retuned or unplugged stops hearing its
    // stations while its siblings carry on.
    const bins = new Map();
    rx.forEach(h => h.paths.forEach(p => bins.set(p.path, p.bins)));
    return (hosts, t) => {
      const b = Math.floor(t / BIN);
      for (const h of hosts) {
        const set = bins.get(h);
        if (!set) continue;
        let before = false, after = false;
        for (let k = 0; k <= LISTEN_PAD; k++) {
          if (set.has(b - k)) before = true;
          if (set.has(b + k)) after = true;
        }
        if (before && after) return true;
      }
      return false;
    };
  }

  // ── 3. transmissions: copies, corrupted copies ───────────────────────────────

  // Per address, the copies of one transmission grouped, and the version that
  // was sent chosen: the value most copies agree on; on a tie, the one nearest
  // the address's previous transmission (a battery does not jump 1.6 V and back
  // in two seconds); failing that, the first heard — the direct copy lands
  // before any repeater's.
  function transmissions(recs) {
    const byAddr = new Map();
    for (const x of recs) {
      if (!x.addr) continue;
      if (!byAddr.has(x.addr)) byAddr.set(x.addr, []);
      byAddr.get(x.addr).push(x);
    }
    const all = [];
    byAddr.forEach((list, addr) => {
      const mine = [];
      let prevV = null;
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const votes = new Map();
        cur.copies.forEach(c => votes.set(c.v, (votes.get(c.v) || 0) + 1));
        let best = null, bestN = -1, tie = false;
        votes.forEach((n, v) => { if (n > bestN) { best = v; bestN = n; tie = false; } else if (n === bestN) tie = true; });
        if (tie) {
          const top = [...votes.entries()].filter(([, n]) => n === bestN).map(([v]) => v);
          if (prevV != null) best = top.slice().sort((a, b) => Math.abs(a - prevV) - Math.abs(b - prevV))[0];
          else best = cur.copies.find(c => top.includes(c.v)).v;
        }
        cur.v = best;
        cur.bad = [];
        const radio = cur.copies[0].alert && Number.isInteger(best) && best >= 0 && best <= 2047;
        cur.copies.forEach(c => {
          if (c.v === best) return;
          // Only an ALERT frame has bits to flip in a way that means anything;
          // two different values at one instant from anything else are two
          // readings, and stay so.
          if (radio && Number.isInteger(c.v) && c.v >= 0 && c.v <= 2047) {
            cur.bad.push({ x: c, bits: pop((c.v ^ best) & 0x7FF), dt: c.t - cur.t });
          }
        });
        if (!radio && cur.copies.some(c => c.v !== best)) {
          // Not a radio frame: every distinct value is its own transmission.
          const vals = [...new Set(cur.copies.map(c => c.v))].filter(v => v !== best);
          vals.forEach(v => {
            const copies = cur.copies.filter(c => c.v === v);
            mine.push({ addr, aid: cur.aid, t: copies[0].t, v, copies, bad: [], hosts: new Set(copies.map(c => c.host)) });
          });
          cur.copies = cur.copies.filter(c => c.v === best);
        }
        cur.hosts = new Set(cur.copies.map(c => c.host));
        mine.push(cur);
        prevV = best;
        cur = null;
      };
      for (const x of list) {
        if (cur && x.t - cur.t <= COPY_WINDOW) { cur.copies.push(x); continue; }
        flush();
        cur = { addr, aid: x.aid, t: x.t, copies: [x] };
      }
      flush();
      all.push(...mine, ...settleRapid(mine));
    });
    all.sort((a, b) => a.t - b.t);
    return all;
  }

  // A "corrupted copy" a few counts from its transmission's value, between it
  // and the address's next or last one, that one within RAPID_MS — or carrying
  // on the run the last one started, no further than it went — is the
  // station's own next report: taken out of the bad copies and returned as a
  // transmission of its own. 29 of the 33 one-to-three-tip "corruptions" on rain gauges in a
  // week of stored readings were carried on like this.
  function between(x, a, b) { return x !== a && x >= Math.min(a, b) && x <= Math.max(a, b); }
  function carriesOn(x, p, v) { const d = v - p; return d !== 0 && Math.sign(x - v) === Math.sign(d) && Math.abs(x - v) <= Math.abs(d); }
  function settleRapid(mine) {
    const extra = [];
    mine.forEach((tx, i) => {
      if (!tx.bad.length) return;
      const nb = [mine[i - 1], mine[i + 1]].filter(o => o && Math.abs(o.t - tx.t) <= RAPID_MS);
      if (!nb.length) return;
      const prev = nb.includes(mine[i - 1]) ? mine[i - 1] : null;
      const moved = new Set(tx.bad.filter(b => Math.abs(b.x.v - tx.v) <= RAPID_STEP
        && (nb.some(o => between(b.x.v, tx.v, o.v)) || (prev && carriesOn(b.x.v, prev.v, tx.v)))).map(b => b.x.v));
      if (!moved.size) return;
      moved.forEach(v => {
        const copies = tx.copies.filter(c => c.v === v);
        extra.push({ addr: tx.addr, aid: tx.aid, t: copies[0].t, v, copies, bad: [], hosts: new Set(copies.map(c => c.host)), rapid: true });
      });
      tx.copies = tx.copies.filter(c => !moved.has(c.v));
      tx.bad = tx.bad.filter(b => !moved.has(b.x.v));
      tx.hosts = new Set(tx.copies.map(c => c.host));
    });
    return extra;
  }

  // ── 4. ghosts ────────────────────────────────────────────────────────────────

  // A transmission within three bits — address and value together — of one
  // heard on another address in the same seconds is that transmission with
  // its address corrupted, when nothing else explains it:
  //
  //   on an address no station here uses   always (5,122 of 8,192 are on
  //                                        file nationally; an unfiled one
  //                                        heard beside a near-twin is the
  //                                        twin)
  //   on a station's own address           only when its value is out of line
  //                                        with that address's own reports and
  //                                        the twin's is in line with its own
  //                                        — the context it was heard in. In a
  //                                        week of stored readings, 4803 = 51
  //                                        two seconds after 4801 = 51: 4801
  //                                        reads 50-odd all week, 4803 in the
  //                                        thousands. Two stations' frames that
  //                                        only look alike are both in line
  //                                        with their own, and stay readings.
  //
  // A ghost is set aside from its address's station before anything else is
  // worked out, so it neither counts as a check nor bends a battery trend.
  function findGhosts(txs, resolveTx) {
    const byAid = new Map();
    txs.forEach(tx => {
      if (tx.aid == null || tx.aid > 8191 || !Number.isInteger(tx.v)) return;
      if (!byAid.has(tx.aid)) byAid.set(tx.aid, { txs: [], ts: [] });
      const a = byAid.get(tx.aid);
      a.txs.push(tx); a.ts.push(tx.t);
    });
    // The gap from v to the nearest transmission of the same address at least
    // a copy window away, either side; Infinity when there is none.
    const fits = new Map();
    const fit = tx => {
      if (fits.has(tx)) return fits.get(tx);
      const a = byAid.get(tx.aid);
      let d = Infinity;
      if (a) {
        const i = lowerBound(a.ts, tx.t - COPY_WINDOW) - 1, j = lowerBound(a.ts, tx.t + COPY_WINDOW + 1);
        if (i >= 0) d = Math.abs(a.txs[i].v - tx.v);
        if (j < a.txs.length) d = Math.min(d, Math.abs(a.txs[j].v - tx.v));
      }
      fits.set(tx, d);
      return d;
    };
    const real = txs.filter(tx => tx.aid != null && tx.aid <= 8191 && !resolveTx(tx).foreign);
    const times = real.map(tx => tx.t);
    let n = 0;
    for (const tx of txs) {
      if (tx.aid == null || tx.aid > 8191) continue;
      const own = resolveTx(tx);
      const filed = !own.foreign;
      // A station's own address: one version only, out of line with its own.
      if (filed && (tx.bad.length || !Number.isInteger(tx.v) || fit(tx) <= FIT_TOL)) continue;
      const i = lowerBound(times, tx.t - COPY_WINDOW);
      let best = null;
      for (let j = i; j < real.length && real[j].t <= tx.t + COPY_WINDOW; j++) {
        const o = real[j];
        if (o.aid === tx.aid || o.ghostOf) continue;
        const ab = pop((o.aid ^ tx.aid) & 0x1FFF);
        const vb = Number.isInteger(o.v) && Number.isInteger(tx.v) ? pop((o.v ^ tx.v) & 0x7FF) : 99;
        if (ab + vb > 3 || (best && ab + vb >= best.bits)) continue;
        if (filed) {
          const os = resolveTx(o).st;
          if (os && own.st && os.id === own.st.id) continue;   // one station's two sensors
          if (fit(o) > FIT_TOL) continue;                      // the twin must be in line with its own
        }
        best = { of: o, bits: ab + vb, addrBits: ab, valueBits: vb, filed };
      }
      if (best) { tx.ghostOf = best; best.of.ghosts = (best.of.ghosts || 0) + 1; n++; }
    }
    return n;
  }

  // ── 5. schedules ─────────────────────────────────────────────────────────────

  // The period, and the phase within it, that the times keep — read off the
  // gaps between consecutive reports, not off a grid of slots. A station that
  // reports every 30 minutes, falls silent for two days and comes back has
  // dozens of 30-minute gaps and one long one; scored against slots, those
  // two days of misses would argue for some longer period whose few slots
  // happened to land on reports. Against gaps, the silence is one gap.
  //
  // A period explains a gap that is a whole number of periods long. The one
  // chosen explains most of the gaps, and most often in one step: a 3-hour
  // station's gaps are all whole numbers of 90 minutes too, but never one of
  // them. Among the periods that pass, the longest wins — every divisor of
  // the true period also explains its gaps, in steps of two or more.
  //
  // Then the phase (the circular mean of the explained times), and every slot
  // in the window scored as a hit, or a miss where a receiver that hears the
  // station was listening.
  function detectSchedule(times, covered, t0, t1, now) {
    if (times.length < 5) return null;
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    let best = null;
    for (const P of PERIODS) {
      const tolGap = Math.max(2 * MIN, 0.03 * P);
      let explained = 0, one = 0;
      gaps.forEach(g => {
        const k = Math.round(g / P);
        if (k >= 1 && Math.abs(g - k * P) <= tolGap * Math.sqrt(k)) { explained++; if (k === 1) one++; }
      });
      const f = explained / gaps.length;
      if (explained < 4 || f < 0.7 || one / explained < 0.5) continue;
      if (!best || P > best.P) best = { P, f, one: one / explained };
    }
    if (!best) return null;
    const P = best.P;
    const tol = Math.max(3 * MIN, 0.03 * P);
    // The phase: the circular mean of every time, weighted to the densest
    // window so a stray event report cannot pull it.
    const ph = times.map(t => mod(t, P)).sort((a, b) => a - b);
    const n = ph.length;
    const ext = ph.concat(ph.map(p => p + P));
    let bestC = 0, bestI = 0, bestJ = 0, j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j + 1 < i + n && ext[j + 1] - ext[i] <= 2 * tol) j++;
      if (j - i + 1 > bestC) { bestC = j - i + 1; bestI = i; bestJ = j; }
    }
    let sum = 0;
    for (let k = bestI; k <= bestJ; k++) sum += ext[k];
    const phase = mod(sum / (bestJ - bestI + 1), P);
    let hits = 0, exp = 0;
    const k0 = Math.ceil((t0 - phase) / P), k1 = Math.floor((Math.min(t1, now - ARRIVAL_GRACE - tol) - phase) / P);
    for (let k = k0; k <= k1; k++) {
      const s = phase + k * P;
      if (!covered(s)) continue;
      exp++;
      if (nearestWithin(times, s, tol) >= 0) hits++;
    }
    return { P, phase, tol, hits, exp, gapFit: round(best.f, 2), gapOne: round(best.one, 2) };
  }

  // ── 6. the station's battery, by its solar day ──────────────────────────────

  function solarHours(t, lon) { return t / HOUR + (isFinite(lon) ? lon : 150) / 15; }

  // A silence that begins in the evening and ends mid-morning or later is the
  // shape of a solar site whose battery cannot carry it through the night:
  // the radio browns out after dark and comes back once the panel has put
  // enough back. Said as a hint, because a link that drops at night does too.
  function solarNight(from, to, lon) {
    const a = mod(solarHours(from, lon), 24), b = mod(solarHours(to, lon), 24);
    return (a >= 16 || a < 4) && b >= 8 && b <= 16 && to - from <= 30 * HOUR;
  }
  const SOLAR_HINT = 'It went at night and came back in daylight — the pattern of a solar site whose battery cannot carry it through the night.';

  function batteryOf(series, st, now) {
    // series: [{t, V}] with corrupted copies and implausible values already out.
    if (series.length < 3) return null;
    const lon = st && isFinite(st.lon) ? st.lon : 150;
    const nights = new Map(), days = new Map();
    for (const p of series) {
      const sh = solarHours(p.t, lon);
      const hod = mod(sh, 24);
      if (hod >= 18 || hod < 9) {
        const k = Math.floor((sh - 12) / 24);
        let n = nights.get(k);
        if (!n) nights.set(k, n = { k, min: Infinity, t: 0, n: 0 });
        n.n++;
        if (p.V < n.min) { n.min = p.V; n.t = p.t; }
      }
      if (hod >= 9 && hod < 17) {
        const k = Math.floor(sh / 24);
        let d = days.get(k);
        if (!d) days.set(k, d = { k, max: -Infinity, t: 0, n: 0 });
        d.n++;
        if (p.V > d.max) { d.max = p.V; d.t = p.t; }
      }
    }
    const nightList = [...nights.values()].filter(n => n.n >= 2).sort((a, b) => a.k - b.k);
    const dayList = [...days.values()].filter(d => d.n >= 1).sort((a, b) => a.k - b.k);
    const Vs = series.map(p => p.V);
    const out = {
      latest: series[series.length - 1],
      min: Math.min(...Vs), max: Math.max(...Vs),
      nights: nightList.map(n => ({ t: n.t, v: n.min })),
      days: dayList.map(d => ({ t: d.t, v: d.max })),
      slope: null, swing: null, lastNight: nightList.length ? nightList[nightList.length - 1].min : null,
      daysTo: null, flat: false,
    };
    if (nightList.length >= 3) {
      out.slope = theilSen(nightList.map(n => n.t / DAY), nightList.map(n => n.min));
    }
    if (nightList.length >= 2 && dayList.length >= 2) {
      out.swing = median(dayList.map(d => d.max)) - median(nightList.map(n => n.min));
    }
    const distinct = new Set(Vs.map(v => v.toFixed(1)));
    out.flat = series.length >= 8 && distinct.size <= 1;
    if (out.slope != null && out.slope < 0 && out.lastNight != null && out.lastNight > BATT_CRIT_V) {
      out.daysTo = (out.lastNight - BATT_CRIT_V) / -out.slope;
    }
    return out;
  }

  // ── 7. rain and level ────────────────────────────────────────────────────────

  // A tipping-bucket accumulator: the tips between successive transmissions.
  // The counter only ever goes up — until it wraps at 2,048, or the logger is
  // reset — and that is the whole of the robustness here, because the stored
  // readings carry three kinds of count that are not rain:
  //
  //   garbage   frames decoded onto the address that are not the gauge at
  //             all: 1220, 16, 14, 1220 at Beachmere (St Smith Rd); 9, 1183, 12
  //             at Springfield Lakes between two real tips; 26 and 525 (1050
  //             with a bit lost, and slipped one bit right) at Harding St.
  //   flips     a jump of 64 tips or more that is two bits or fewer from the
  //             count before it. 265 → 1801 at Torridon is 1,536 tips — 307 mm
  //             — and exactly two bits; a corrupted frame, not a storm.
  //   resets    a step back that the counts after it confirm by staying down.
  //
  // So: undo the wraps, split at the confirmed resets, and in each piece keep
  // the longest run that never goes down (the smallest-valued one, when two
  // are as long) — everything off that run is garbage. What is left is rain.
  function lnds(vs) {
    // Longest non-decreasing subsequence, with the smallest possible tail at
    // every length — so a garbage high value never wins a tie. Indices.
    const tails = [], tailIdx = [], prev = new Array(vs.length).fill(-1);
    for (let i = 0; i < vs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] <= vs[i]) lo = m + 1; else hi = m; }
      tails[lo] = vs[i]; tailIdx[lo] = i;
      prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const out = [];
    for (let i = tailIdx[tails.length - 1]; i >= 0; i = prev[i]) out.push(i);
    return out.reverse();
  }

  function rainOf(txs, st) {
    const b = typeof bucketSizeMm === 'function' ? bucketSizeMm(st) : { mm: 0.2, recorded: false };
    const vals = txs.map(tx => ({ t: tx.t, raw: tx.v })).filter(p => Number.isInteger(p.raw) && p.raw >= 0);
    // Undo the wraps: a count near the top followed by counts near the bottom
    // that stay there.
    let off = 0;
    for (let i = 0; i < vals.length; i++) {
      const p = vals[i - 1], q = vals[i], r = vals[i + 1];
      if (p && p.raw >= 1900 && p.raw <= 2047 && q.raw <= 150 && (!r || r.raw <= 300)) off += 2048;
      q.v = q.raw + off;
    }
    // Split at confirmed resets: a drop of more than 50 that the next two
    // counts agree with.
    const pieces = [[]];
    let resets = 0, resetEg = null;
    for (let i = 0; i < vals.length; i++) {
      const cur = pieces[pieces.length - 1];
      const last = cur.length ? cur[cur.length - 1] : null;
      const q = vals[i];
      if (last && q.v < last.v - 50) {
        const r1 = vals[i + 1], r2 = vals[i + 2];
        const stays = r1 && r2 && r1.v >= q.v - 2 && r1.v <= q.v + 60 && r2.v >= r1.v - 2 && r2.v <= r1.v + 60;
        if (stays) { resets++; if (!resetEg) resetEg = { from: last.raw, to: q.raw, t: q.t }; pieces.push([q]); continue; }
      }
      cur.push(q);
    }
    const keep = [], garbage = [];
    pieces.forEach(pc => {
      const idx = new Set(lnds(pc.map(p => p.v)));
      pc.forEach((p, i) => (idx.has(i) ? keep : garbage).push(p));
      keep.push(null);               // a reset: no step across it
    });
    const steps = [];
    let tips = 0, flips = 0, flipEg = null, jumps = 0, jumpEg = null;
    for (let i = 1; i < keep.length; i++) {
      const a = keep[i - 1], c = keep[i];
      if (!a || !c) continue;
      const d = c.v - a.v;
      if (!d) continue;
      if (d >= 64 && pop((a.raw ^ c.raw) & 0xFFF) <= 2) {
        flips++;
        if (!flipEg) flipEg = { from: a.raw, to: c.raw, t: c.t, tips: d };
        continue;
      }
      if (d >= RAIN_BIG_STEP) {
        jumps++;
        if (!jumpEg) jumpEg = { from: a.raw, to: c.raw, t: c.t, tips: d };
        continue;
      }
      const next = keep[i + 1];
      tips += d;
      // Held: the gauge carried on from it. The last count of the window has
      // nothing after it to say so, and counts only when the step was small.
      steps.push({ t: c.t, from: a.t, tips: d, held: next ? true : d < 20 });
    }
    return {
      mmPerTip: b.mm, recorded: b.recorded, tips, mm: round(tips * b.mm, 1), steps,
      resets, resetEg, flips, flipEg, jumps, jumpEg, outliers: garbage.length,
      outlierEg: garbage.slice(0, 3).map(g => ({ t: g.t, v: g.raw })), n: vals.length,
    };
  }

  function rainBetween(rain, a, b, heldOnly) {
    if (!rain) return 0;
    let tips = 0;
    for (const s of rain.steps) if (s.t > a && s.t <= b && (!heldOnly || s.held)) tips += s.tips;
    return tips * rain.mmPerTip;
  }

  // One-reading spikes: a value far from both neighbours while the neighbours
  // agree — and a few bits from them, which is what a flip is and a real
  // change seldom is. A corrupted copy that arrived without its clean twin
  // looks exactly like this. Only judged between readings at most 3.5 h
  // apart: a station checking every six hours legitimately goes 12.9, 14.0,
  // 13.0 V across a sunny day, and would otherwise read as spiking at noon.
  // `raw` is the count to compare bits on (the battery series carries volts).
  function spikesOf(vals, thr, raw) {
    const out = [];
    const r = raw || (p => p.v);
    for (let i = 1; i + 1 < vals.length; i++) {
      const A = vals[i - 1], B = vals[i], C = vals[i + 1];
      if (B.t - A.t > 3.5 * HOUR || C.t - B.t > 3.5 * HOUR) continue;
      const a = A.v, b = B.v, c = C.v;
      if (!(Math.abs(b - a) > thr && Math.abs(b - c) > thr && Math.abs(a - c) <= thr / 4)) continue;
      const rb = r(B), ra = r(A);
      if (Number.isInteger(rb) && Number.isInteger(ra) && pop((rb ^ ra) & 0xFFFF) > 3) continue;
      out.push(B);
    }
    return out;
  }

  // ── findings ─────────────────────────────────────────────────────────────────

  const ACTION = {
    'battery-critical':  'Visit: replace or recharge the battery and check the charging circuit before the radio browns out.',
    'battery-low':       'Plan a visit: test the battery under load, and the panel, regulator and fuse.',
    'battery-falling':   'Check the solar panel (shade, dirt, cable), regulator and fuse while there is margin left.',
    'battery-no-charge': 'Check the panel, its cable, the regulator and the fuse — no daily charge is reaching the battery.',
    'battery-float':     'Nothing to do if the station is mains-charged; a solar one reading dead flat has a stuck sensor.',
    'battery-overcharge':'Check the regulator — it is holding the battery above 15 V.',
    'silent':            'Check power and radio at the station; if its repeater went quiet too, start there.',
    'silent-spell':      'Look for what comes and goes: battery voltage overnight, connectors, the antenna mount, the repeater.',
    'missed-rising':     'Check the antenna, cable and connectors, and the path to its repeater — compare with its last fade margin.',
    'missed-checks':     'A marginal path: antenna alignment, cable and connectors, the repeater; a fade-margin test settles it.',
    'partial-checks':    'Frames are being lost on the way: check the antenna and cable, and the radio\'s transmit power.',
    'corrupt-copies':    'One of the repeaters on its path relays with bit errors — see Repeaters below.',
    'clock-drift':       'Set the logger\'s clock, and check its clock battery.',
    'value-spikes':      'Single wild readings were stored — corrupted copies that arrived without their clean twin. Check the path.',
    'rain-blocked':      'Clean the funnel, and check the bucket pivots and the reed switch.',
    'rain-isolated':     'Was the gauge tipped — a visit, wildlife, vandalism? No gauge nearby recorded rain.',
    'rain-reset':        'The counter went backwards: a logger restart or reset. Check its power supply.',
    'level-stuck':       'Check the level sensor — float, encoder or transducer — it did not move through rain nearby.',
    'level-zero':        'Reading zero throughout: a dry pool, or a sensor that is disconnected.',
    'receiver-silent':   'Check the base station on the Base Stations tab — power, network, and the receiver software.',
    'receiver-outage':   'The base station stopped delivering for a while: power, network, or the receiver restarting.',
    'receiver-latency':  'Uploads are queuing — check the base station\'s network link.',
    'receiver-clock':    'Set the base station\'s clock (NTP) — its timestamps run ahead of the database.',
    'repeater-down':     'Check the repeater — power, antenna, radio: every station behind it went quiet together.',
    'shared-spell':      'Check the shared repeater\'s logs and power for that time — a solar repeater that browns out, a link that drops.',
    'area-silence':      'Something these stations share went quiet: a repeater, a link, or local interference.',
    'repeater-bitflips': 'Check the repeater\'s receiver and transmitter — it is relaying frames with flipped bits.',
    'network-miss':      'A network-wide gap: check the receiver, and for interference on the channel at that time.',
    'ghosts':            'Nothing at the stations — these are corrupted copies stored under the wrong address.',
    'registry-far':      'Fix the register: find the station here that uses this address and record it (Stations tab).',
    'registry-unknown':  'Fix the register: a station is reporting on an address no station on file carries.',
    'registry-kind':     'Fix the register: the address\'s values do not fit the sensor type on file.',
    'registry-ambiguous':'Fix the register: two nearby stations share this address, so its readings cannot be attributed.',
    'not-heard':         'Confirm whether these are decommissioned, or check them — their repeaters were relaying others.',
  };

  const CATEGORY = {
    'battery-critical': 'power', 'battery-low': 'power', 'battery-falling': 'power', 'battery-no-charge': 'power',
    'battery-float': 'power', 'battery-overcharge': 'power',
    'silent': 'comms', 'silent-spell': 'comms', 'missed-rising': 'comms', 'missed-checks': 'comms', 'partial-checks': 'comms',
    'corrupt-copies': 'comms', 'clock-drift': 'comms',
    'value-spikes': 'data', 'ghosts': 'data',
    'rain-blocked': 'sensor', 'rain-isolated': 'sensor', 'rain-reset': 'sensor', 'level-stuck': 'sensor', 'level-zero': 'sensor',
    'receiver-silent': 'network', 'receiver-outage': 'network', 'receiver-latency': 'network', 'receiver-clock': 'network',
    'repeater-down': 'network', 'area-silence': 'network', 'shared-spell': 'network', 'repeater-bitflips': 'network', 'network-miss': 'network',
    'not-heard': 'network',
    'registry-far': 'register', 'registry-unknown': 'register', 'registry-kind': 'register', 'registry-ambiguous': 'register',
  };

  function finding(kind, sev, f) {
    return Object.assign({
      id: `${kind}:${f.key || f.stationId || f.host || f.repeaterId || f.addr || ''}`,
      kind, severity: sev, category: CATEGORY[kind] || 'data', action: ACTION[kind] || '',
    }, f);
  }

  // ── the analysis ─────────────────────────────────────────────────────────────

  // rows    meganet.reading rows (any protocol)
  // opts    { t0, t1, now, stations }   — stations defaults to the loaded file
  function run(rows, opts) {
    const o = opts || {};
    const now = o.now != null ? o.now : Date.now();
    const recs = normalise(rows);
    const t0 = o.t0 != null ? o.t0 : (recs.length ? recs[0].t : now - 7 * DAY);
    const t1 = o.t1 != null ? o.t1 : now;
    const stations = o.stations || ((typeof state !== 'undefined' && state.data && state.data.stations) || []);
    const resolveRow = SensorValues.resolver(rows || []);
    const reps = repeatersOf(stations);

    // Resolution per transmission, memoised per (address, host): it is the
    // same answer for every reading of one address through one receiver.
    const resMemo = new Map();
    const resolveTx = tx => {
      const c = tx.copies[0];
      const k = tx.addr + '|' + c.host;
      let got = resMemo.get(k);
      if (!got) {
        const r = resolveRow(c.r);
        got = Object.assign({}, r, { foreign: r.conf === 'unknown' || r.conf === 'far' });
        resMemo.set(k, got);
      }
      return got;
    };

    const rx = receivers(recs, t0, t1, now);
    const listening = makeListening(rx);
    const txs = transmissions(recs);
    const ghostCount = findGhosts(txs, resolveTx);

    // ── stations ──
    const byStation = new Map();
    const addrNotes = new Map();     // addr -> { aid, res, txs, ghosts, bad }
    let corruptedTotal = 0;
    const hostCorrupt = new Map();
    for (const tx of txs) {
      corruptedTotal += tx.bad.length;
      tx.bad.forEach(b => hostCorrupt.set(b.x.host, (hostCorrupt.get(b.x.host) || 0) + 1));
      const res = resolveTx(tx);
      let note = addrNotes.get(tx.addr);
      if (!note) addrNotes.set(tx.addr, note = { addr: tx.addr, aid: tx.aid, res, txs: [], ghosts: 0, bad: 0, hosts: new Set() });
      note.txs.push(tx);
      note.bad += tx.bad.length;
      tx.hosts.forEach(h => note.hosts.add(h));
      if (tx.ghostOf) { note.ghosts++; continue; }
      if (!res.st || res.foreign || res.conf === 'ambiguous') continue;
      let S = byStation.get(res.st.id);
      if (!S) byStation.set(res.st.id, S = { st: res.st, addrs: new Map(), txs: [], hosts: new Set(), pathN: new Map(), findings: [] });
      let A = S.addrs.get(tx.addr);
      if (!A) S.addrs.set(tx.addr, A = { addr: tx.addr, aid: tx.aid, kind: res.kind, types: res.types, txs: [], bad: 0, ghostsOf: 0 });
      A.txs.push(tx);
      A.bad += tx.bad.length;
      S.txs.push(tx);
      tx.hosts.forEach(h => S.hosts.add(h));
      new Set(tx.copies.map(c => c.path)).forEach(p => S.pathN.set(p, (S.pathN.get(p) || 0) + 1));
    }
    rx.forEach(h => { h.corrupted = hostCorrupt.get(h.host) || 0; });

    // ── pass 1: schedules and every slot's outcome ──
    const allSlots = [];
    byStation.forEach(S => {
      S.txs.sort((a, b) => a.t - b.t);
      // Bursts: the station's frames inside a minute and a half of each other.
      const bursts = [];
      for (const tx of S.txs) {
        const last = bursts[bursts.length - 1];
        if (last && tx.t - last.t <= BURST_WINDOW) { last.addrs.add(tx.addr); last.txs.push(tx); continue; }
        bursts.push({ t: tx.t, addrs: new Set([tx.addr]), txs: [tx] });
      }
      S.bursts = bursts;
      const times = bursts.map(b => b.t);
      // The paths whose listening counts for this station: those that heard it
      // at least three times. A receiver that caught it once, on a channel it
      // is not really on, would otherwise make every one of its checks "due".
      const strong = [...S.pathN.entries()].filter(([, n]) => n >= 3).map(([p]) => p);
      S.paths = strong.length ? strong : [...S.pathN.keys()];
      const covered = t => listening(S.paths, t);
      // The schedule is learned from the battery's times when the station has
      // a battery heard often enough: a battery reports on the timed check and
      // nothing else, where a rain gauge reports every tip and a level every
      // change. Failing that, from bursts carrying two or more sensors (a check
      // is all of them, an event one); failing that, from everything.
      //
      // Both are tried when both exist, and the shorter period wins when the
      // longer is a whole multiple of it: a battery frame lost on every other
      // check makes the battery look six-hourly, while the station's checks —
      // its rain and level frames, arriving together — keep the three hours.
      const battA = [...S.addrs.values()].filter(A => A.kind === 'battery').sort((a, b) => b.txs.length - a.txs.length)[0];
      const multi = bursts.filter(b => b.addrs.size >= 2).map(b => b.t);
      const fromBatt = battA && battA.txs.length >= 4 ? detectSchedule(battA.txs.map(tx => tx.t).sort((a, b) => a - b), covered, t0, t1, now) : null;
      const fromMulti = multi.length >= 4 ? detectSchedule(multi, covered, t0, t1, now) : null;
      let sch = fromBatt || fromMulti;
      if (sch) sch.from = fromBatt ? 'battery' : 'checks';
      if (fromBatt && fromMulti && fromMulti.P < fromBatt.P && fromBatt.P % fromMulti.P === 0) { sch = fromMulti; sch.from = 'checks'; }
      if (!sch && !battA && multi.length < 4) { sch = detectSchedule(times, covered, t0, t1, now); if (sch) sch.from = 'all'; }
      S.lastHeard = times.length ? times[times.length - 1] : null;
      if (!sch) { S.schedule = null; return; }
      // The addresses a check normally carries: those in at least 55% of the
      // bursts that landed on a slot. Then each slot again, against them: a
      // burst on the slot carrying every one is a check received; some of
      // them, a check received with frames lost; none of them — a level
      // report that happened to land near the slot — is not a check at all,
      // and the slot is missed. Without that last rule a station that reports
      // events often enough would never miss a check.
      const k0 = Math.ceil((t0 - sch.phase) / sch.P);
      const k1 = Math.floor((Math.min(t1, now - ARRIVAL_GRACE - sch.tol) - sch.phase) / sch.P);
      const near = s => {
        const i = lowerBound(times, s - sch.tol);
        const out = [];
        for (let j = i; j < times.length && times[j] <= s + sch.tol; j++) out.push(bursts[j]);
        return out;
      };
      const count = new Map();
      let onSlot = 0;
      for (let k = k0; k <= k1; k++) {
        const nb = near(sch.phase + k * sch.P);
        if (!nb.length) continue;
        onSlot++;
        const seen = new Set();
        nb.forEach(b => b.addrs.forEach(a => seen.add(a)));
        seen.forEach(a => count.set(a, (count.get(a) || 0) + 1));
      }
      // 55%, not half: a sensor set to report on every other check sits at
      // half by design and is not "missing" from the rest.
      const core = [...count.entries()].filter(([, n]) => n >= 0.55 * onSlot).map(([a]) => a);
      const slots = [];
      for (let k = k0; k <= k1; k++) {
        const s0 = sch.phase + k * sch.P;
        const nb = near(s0);
        const have = new Set();
        nb.forEach(b => b.addrs.forEach(a => have.add(a)));
        const got = core.length ? core.filter(a => have.has(a)) : [...have];
        const burst = got.length ? nb.find(b => [...b.addrs].some(a => !core.length || core.includes(a))) : null;
        const sl = { t: s0, burst, covered: covered(s0), outcome: null, st: S.st.id, missing: [] };
        if (burst) {
          sl.missing = core.filter(a => !have.has(a));
          sl.outcome = sl.missing.length ? 'partial' : 'hit';
        } else {
          sl.outcome = sl.covered ? 'miss' : 'unknown';
        }
        slots.push(sl);
      }
      // Drift: how far each on-slot check landed from its slot, against time.
      const resid = slots.filter(sl => sl.burst).map(sl => ({ t: sl.t, d: sl.burst.t - sl.t }));
      sch.offsetMs = resid.length ? median(resid.map(r => r.d)) : 0;
      sch.driftSPerDay = resid.length >= 6 && resid[resid.length - 1].t - resid[0].t >= 2 * DAY
        ? theilSen(resid.map(r => r.t / DAY), resid.map(r => r.d / 1000)) : null;
      // Runs of misses. A run of four or more is a spell — the station (or
      // its path) gone for a while — and is reported as one; a miss with a
      // check received either side of it is isolated, and isolated misses
      // are what a network-wide moment is made of.
      const judged = slots.filter(sl => sl.outcome !== 'unknown');
      let run = [];
      const spells = [];
      const close = () => { if (run.length >= 4) spells.push({ from: run[0].t, to: run[run.length - 1].t, n: run.length, slots: run }); run = []; };
      judged.forEach((sl, i) => {
        if (sl.outcome === 'miss') {
          run.push(sl);
          const prev = judged[i - 1], next = judged[i + 1];
          sl.isolated = (!prev || prev.outcome !== 'miss') && (!next || next.outcome !== 'miss');
        } else close();
      });
      close();
      spells.forEach(sp => sp.slots.forEach(sl => { sl.spell = true; }));
      sch.spells = spells.map(sp => ({ from: sp.from, to: sp.to, n: sp.n, open: sp.slots[sp.slots.length - 1] === judged[judged.length - 1] }));
      sch.core = core;
      S.schedule = sch;
      S.slots = slots;
      slots.forEach(sl => allSlots.push(sl));
    });

    // ── pass 2: what the whole network missed at once ──
    const netBins = new Map();
    // Of the stations that were reporting normally around a moment — a check
    // received, or a lone miss between two received — how many missed it.
    // A station in a long silence misses every slot at its phase, and left in
    // it would make the same quarter-hour look like a network event every
    // three hours for as long as it stays down.
    allSlots.forEach(sl => {
      if (sl.outcome === 'unknown' || (sl.outcome === 'miss' && !sl.isolated)) return;
      const b = Math.floor(sl.t / NET_BIN);
      let e = netBins.get(b);
      if (!e) netBins.set(b, e = { b, due: 0, missed: 0, slots: [] });
      e.due++;
      if (sl.outcome === 'miss') e.missed++;
      e.slots.push(sl);
    });
    const netEvents = [];
    [...netBins.values()].sort((a, b) => a.b - b.b).forEach(e => {
      if (e.due < NET_MIN_DUE || e.missed / e.due < NET_MISS_FRAC) return;
      e.slots.forEach(sl => { if (sl.outcome === 'miss') sl.outcome = 'net'; });
      const last = netEvents[netEvents.length - 1];
      const from = e.b * NET_BIN, to = from + NET_BIN;
      if (last && last.to >= from) { last.to = to; last.due += e.due; last.missed += e.missed; }
      else netEvents.push({ from, to, due: e.due, missed: e.missed });
    });

    // ── pass 3: each station's verdicts ──
    const allStations = [];
    byStation.forEach(S => {
      const st = S.st;
      const F = S.findings;
      const sch = S.schedule;
      // Addresses: their kinds, values and what came of them.
      S.sensors = [...S.addrs.values()].map(A => {
        A.txs.sort((a, b) => a.t - b.t);
        A.ghostsOf = A.txs.reduce((n, tx) => n + (tx.ghosts || 0), 0);
        const lastTx = A.txs[A.txs.length - 1];
        const conv = SensorValues.convert(A.kind, lastTx.v, st);
        return {
          addr: A.addr, aid: A.aid, kind: A.kind, types: A.types, n: A.txs.length, bad: A.bad, ghosts: A.ghostsOf,
          last: { t: lastTx.t, v: lastTx.v, conv },
          txs: A.txs,
        };
      }).sort((a, b) => (a.aid || 0) - (b.aid || 0));

      // Schedule verdicts.
      if (sch) {
        const sl = S.slots;
        const counted = sl.filter(x => x.outcome !== 'unknown');
        const hits = counted.filter(x => x.outcome === 'hit').length;
        const partial = counted.filter(x => x.outcome === 'partial').length;
        const misses = counted.filter(x => x.outcome === 'miss').length;
        const net = counted.filter(x => x.outcome === 'net').length;
        const own = hits + partial + misses;
        sch.counts = { hits, partial, misses, net, unknown: sl.length - counted.length, due: own };
        sch.missRate = own ? misses / own : 0;
        // Scattered misses: those outside a spell — the marginal-path measure.
        const spellMisses = sl.filter(x => x.spell && x.outcome === 'miss').length;
        const scatteredDue = own - spellMisses;
        sch.scatteredMisses = misses - spellMisses;
        sch.scatteredRate = scatteredDue > 0 ? sch.scatteredMisses / scatteredDue : 0;
        sch.partialRate = hits + partial ? partial / (hits + partial) : 0;
        // Daily.
        const days = new Map();
        sl.forEach(x => {
          const k = dayKey(x.t);
          let d = days.get(k);
          if (!d) days.set(k, d = { day: k, t: x.t, hit: 0, partial: 0, miss: 0, net: 0, unknown: 0 });
          d[x.outcome === 'hit' ? 'hit' : x.outcome]++;
        });
        sch.daily = [...days.values()].sort((a, b) => a.t - b.t);
        // The run of misses the window ends on — the station's current silence.
        let trailing = 0;
        for (let i = sl.length - 1; i >= 0; i--) {
          if (sl[i].outcome === 'unknown' || sl[i].outcome === 'net') continue;
          if (sl[i].outcome === 'miss') trailing++; else break;
        }
        sch.trailingMisses = trailing;
        const last24 = counted.filter(x => x.t > now - DAY && x.outcome !== 'net');
        const before = counted.filter(x => x.t <= now - DAY && x.outcome !== 'net');
        const rate = xs => xs.length ? xs.filter(x => x.outcome === 'miss').length / xs.length : 0;
        sch.rate24 = rate(last24); sch.ratePrior = rate(before);
        sch.n24 = last24.length; sch.nPrior = before.length;
        const dailyRates = sch.daily.filter(d => d.hit + d.partial + d.miss >= 3)
          .map(d => ({ x: d.t / DAY, y: d.miss / (d.hit + d.partial + d.miss) }));
        sch.trend = dailyRates.length >= 4 ? theilSen(dailyRates.map(d => d.x), dailyRates.map(d => d.y)) : null;

        const every = `every ${fmtPeriod(sch.P)}`;
        const silentMs = S.lastHeard != null ? now - S.lastHeard : Infinity;
        if (trailing >= 2 && silentMs >= Math.max(90 * MIN, 2 * sch.P)) {
          const since = S.lastHeard;
          F.push(finding('silent', trailing >= 4 || silentMs >= DAY ? 'critical' : 'warn', {
            stationId: st.id, since,
            title: `Silent — missed its last ${plural(trailing, 'check')}`,
            detail: `Checks ${every}; nothing heard since ${fmtWhen(since, now)} (${fmtSpan(silentMs)}), while the receivers that hear it kept delivering other traffic.`,
            evidence: { trailingMisses: trailing, lastHeard: since, periodMin: sch.P / MIN },
          }));
        } else if (sch.n24 >= 4 && sch.nPrior >= 8 && sch.rate24 >= sch.ratePrior + 0.2
                   && last24.filter(x => x.outcome === 'miss').length >= 2) {
          // Two misses in a day is worth a line; three is worth a visit.
          F.push(finding('missed-rising', last24.filter(x => x.outcome === 'miss').length >= 3 ? 'warn' : 'info', {
            stationId: st.id,
            title: `Missed checks rising — ${Math.round(100 * sch.rate24)}% in the last 24 h`,
            detail: `${last24.filter(x => x.outcome === 'miss').length} of ${sch.n24} checks missed in the last day, against ${Math.round(100 * sch.ratePrior)}% before (${every}).`,
            evidence: { rate24: round(sch.rate24, 2), ratePrior: round(sch.ratePrior, 2), n24: sch.n24, nPrior: sch.nPrior },
          }));
        } else if (sch.trend != null && sch.trend >= 0.08 && dailyRates[dailyRates.length - 1].y >= 0.2) {
          F.push(finding('missed-rising', 'warn', {
            stationId: st.id,
            title: `Missed checks rising — up ${Math.round(100 * sch.trend)} points a day`,
            detail: `Its daily share of missed checks has climbed to ${Math.round(100 * dailyRates[dailyRates.length - 1].y)}% (${every}).`,
            evidence: { trendPerDay: round(sch.trend, 3), daily: sch.daily.map(d => [d.day, d.miss, d.hit + d.partial + d.miss]) },
          }));
        } else if (own - spellMisses >= 8 && sch.scatteredRate >= 0.1) {
          F.push(finding('missed-checks', sch.scatteredRate >= 0.25 ? 'warn' : 'info', {
            stationId: st.id,
            title: `Misses ${Math.round(100 * sch.scatteredRate)}% of its checks`,
            detail: `${sch.scatteredMisses} of ${own - spellMisses} checks missed here and there (${every}) while the receivers were listening — a marginal path rather than a dead station.`,
            evidence: { misses: sch.scatteredMisses, due: own - spellMisses, rate: round(sch.scatteredRate, 2) },
          }));
        }
        // A spell it came back from: gone for hours, then reporting again.
        const closed = sch.spells.filter(sp => !sp.open).sort((a, b) => b.n - a.n)[0];
        if (closed && closed.to - closed.from >= 6 * HOUR) {
          F.push(finding('silent-spell', 'info', {
            stationId: st.id, since: closed.from, key: st.id + '@' + closed.from,
            title: `Went silent for ${fmtSpan(closed.to - closed.from + sch.P)}, then came back`,
            detail: `${plural(closed.n, 'check')} in a row missed from ${fmtWhen(closed.from, now)} to ${fmtWhen(closed.to, now)} while the receivers that hear it were listening, then reporting again. `
                  + (solarNight(closed.from, closed.to + sch.P, st.lon) ? SOLAR_HINT : 'Intermittent power, a loose connection, or a path that comes and goes.'),
            evidence: { from: closed.from, to: closed.to, checks: closed.n, spells: sch.spells.length },
          }));
        }
        if (hits + partial >= 8 && sch.partialRate >= 0.25) {
          const lostAddr = new Map();
          sl.forEach(x => (x.missing || []).forEach(a => lostAddr.set(a, (lostAddr.get(a) || 0) + 1)));
          const worst = [...lostAddr.entries()].sort((a, b) => b[1] - a[1])[0];
          const wa = worst && S.addrs.get(worst[0]);
          const what = wa ? `${SensorValues.kindLabel(wa.kind) || 'address'} ${wa.aid != null ? wa.aid : wa.addr}` : 'a sensor';
          F.push(finding('partial-checks', 'info', {
            stationId: st.id,
            title: `${Math.round(100 * sch.partialRate)}% of its checks arrive incomplete`,
            detail: `${partial} of ${hits + partial} checks arrived without every sensor's frame — most often ${what}. Frames lost on a marginal path go missing one at a time like this before whole checks do.`,
            evidence: { partial, received: hits + partial, mostOftenMissing: wa ? wa.addr : null },
          }));
        }
        if (sch.driftSPerDay != null && Math.abs(sch.driftSPerDay) >= 30) {
          F.push(finding('clock-drift', 'info', {
            stationId: st.id,
            title: `Clock drifting ${Math.abs(Math.round(sch.driftSPerDay))} s a day ${sch.driftSPerDay > 0 ? 'late' : 'early'}`,
            detail: `Its checks land ${Math.round(Math.abs(sch.offsetMs) / 1000)} s ${sch.offsetMs >= 0 ? 'after' : 'before'} the slot on average and walk ${sch.driftSPerDay > 0 ? 'later' : 'earlier'} each day — a logger clock left to run.`,
            evidence: { driftSPerDay: round(sch.driftSPerDay, 1), offsetS: round(sch.offsetMs / 1000, 1) },
          }));
        }
      } else if (S.bursts.length >= 2 && S.lastHeard != null) {
        // No schedule to judge it by — it may report on events only — but a
        // long quiet while its receivers listened is still worth a line.
        const gaps = [];
        for (let i = 1; i < S.bursts.length; i++) gaps.push(S.bursts[i].t - S.bursts[i - 1].t);
        const typical = median(gaps);
        const quiet = now - S.lastHeard;
        if (quiet >= Math.max(12 * HOUR, 4 * typical) && listening(S.paths, now - HOUR)) {
          F.push(finding('silent', 'warn', {
            stationId: st.id, since: S.lastHeard,
            title: `Quiet for ${fmtSpan(quiet)}`,
            detail: `No regular check schedule could be learned from ${plural(S.bursts.length, 'report')}; last heard ${fmtWhen(S.lastHeard, now)}, and its receivers are still delivering.`,
            evidence: { reports: S.bursts.length, lastHeard: S.lastHeard },
          }));
        }
      }

      // Corrupted copies of its own transmissions.
      const sent = S.txs.length;
      const bad = S.txs.reduce((n, tx) => n + tx.bad.length, 0);
      S.corrupted = bad;
      if (bad >= 5 && bad / sent >= 0.08) {
        const bits = [];
        S.txs.forEach(tx => tx.bad.forEach(b => bits.push(b.bits)));
        F.push(finding('corrupt-copies', 'info', {
          stationId: st.id,
          title: `1 in ${Math.max(2, Math.round(sent / bad))} of its transmissions has a corrupted copy`,
          detail: `${plural(bad, 'corrupted copy', 'corrupted copies')} of ${plural(sent, 'transmission')}, a median ${median(bits)} bit${median(bits) === 1 ? '' : 's'} flipped, each landing seconds after the clean one — a repeater on its path relays with errors. Each was stored as a reading.`,
          evidence: { corrupted: bad, transmissions: sent, medianBits: median(bits) },
        }));
      }

      // Battery.
      const batt = S.sensors.filter(x => x.kind === 'battery').sort((a, b) => b.n - a.n)[0];
      if (batt) {
        const raw = batt.txs.map(tx => ({ t: tx.t, V: round(tx.v / 10, 1) }));
        const ok = raw.filter(p => p.V >= SensorValues.BATT_MIN_V && p.V <= SensorValues.BATT_MAX_V);
        if (raw.length >= 4 && ok.length < raw.length * 0.5) {
          const med = median(batt.txs.map(tx => tx.v));
          F.push(finding('registry-kind', 'info', {
            stationId: st.id, addr: batt.addr,
            title: `Address ${batt.aid} does not read like a battery`,
            detail: `The register calls it ${st.name}'s battery, but ${raw.length - ok.length} of ${raw.length} readings are not a 12 V battery (median count ${med}, which would be ${round(med / 10, 1)} V). Another sensor, or another station, is on this address here.`,
            evidence: { aid: batt.aid, medianRaw: med, implausible: raw.length - ok.length, n: raw.length },
          }));
        } else if (ok.length >= 3) {
          const spikes = spikesOf(ok.map(p => ({ t: p.t, v: p.V })), 0.6, p => Math.round(p.v * 10));
          const cleanSet = new Set(spikes.map(s => s.t));
          const clean = ok.filter(p => !cleanSet.has(p.t));
          const B = batteryOf(clean, st, now);
          S.battery = Object.assign(B || {}, { addr: batt.addr, aid: batt.aid, series: clean, spikes: spikes.length });
          if (B) {
            const L = B.lastNight != null ? B.lastNight : B.latest.V;
            const where = B.lastNight != null ? 'its lowest last night' : 'its latest';
            if (L <= BATT_CRIT_V || B.latest.V <= BATT_CRIT_V - 0.2) {
              F.push(finding('battery-critical', 'critical', {
                stationId: st.id, addr: batt.addr,
                title: `Battery critical — ${L.toFixed(1)} V`,
                detail: `${where[0].toUpperCase() + where.slice(1)} was ${L.toFixed(1)} V — at or below ${BATT_CRIT_V} V the radio starts to brown out.`,
                evidence: { lastNightV: B.lastNight, latestV: B.latest.V, slopeVPerDay: B.slope != null ? round(B.slope, 3) : null },
              }));
            } else if (L <= BATT_WARN_V) {
              F.push(finding('battery-low', 'warn', {
                stationId: st.id, addr: batt.addr,
                title: `Battery low — ${L.toFixed(1)} V`,
                detail: `${where[0].toUpperCase() + where.slice(1)} was ${L.toFixed(1)} V, under ${BATT_WARN_V} V (about half charge at rest).`,
                evidence: { lastNightV: B.lastNight, latestV: B.latest.V },
              }));
            }
            if (B.slope != null && B.slope <= BATT_FALL_V_PER_DAY && B.nights.length >= 4
                && B.nights[0].v - B.nights[B.nights.length - 1].v >= 0.15 && L > BATT_CRIT_V) {
              F.push(finding('battery-falling', (B.daysTo != null && B.daysTo <= 30) || L <= 12.4 ? 'warn' : 'info', {
                stationId: st.id, addr: batt.addr,
                title: `Battery falling ${Math.abs(B.slope).toFixed(2)} V a day`,
                detail: `Its night-time low has gone ${B.nights[0].v.toFixed(1)} → ${B.nights[B.nights.length - 1].v.toFixed(1)} V over ${plural(B.nights.length, 'night')}`
                      + (B.daysTo != null ? `; at this rate it reaches ${BATT_CRIT_V} V in about ${plural(Math.max(1, Math.round(B.daysTo)), 'day')}.` : '.'),
                evidence: { slopeVPerDay: round(B.slope, 3), nights: B.nights.map(n => round(n.v, 1)), daysTo: B.daysTo != null ? Math.round(B.daysTo) : null },
              }));
            }
            if (B.swing != null && B.swing < BATT_SWING_MIN_V - 0.03 && B.nights.length >= 3) {
              const level = median(clean.map(p => p.V));
              if (level >= 13.3) {
                F.push(finding('battery-float', 'info', {
                  stationId: st.id, addr: batt.addr,
                  title: `Battery steady at ${level.toFixed(1)} V, day and night`,
                  detail: `No daily swing at all — a charger holding it at float (mains), or a reading that is stuck.`,
                  evidence: { medianV: level, swingV: round(B.swing, 2) },
                }));
              } else {
                F.push(finding('battery-no-charge', level <= 12.6 ? 'warn' : 'info', {
                  stationId: st.id, addr: batt.addr,
                  title: `No daily charge — battery flat-lining at ${level.toFixed(1)} V`,
                  detail: `A solar station's battery rises through the day; this one moved ${round(B.swing, 2)} V between night and day over ${plural(B.nights.length, 'night')}.`,
                  evidence: { medianV: level, swingV: round(B.swing, 2) },
                }));
              }
            }
            // Held high, not touched high once: one reading at 15.6 V is far
            // likelier a flipped bit than a regulator fault.
            const over = clean.filter(p => p.V >= BATT_OVER_V);
            const overDays = new Set(over.map(p => dayKey(p.t)));
            if (over.length >= 3 && overDays.size >= 2) {
              F.push(finding('battery-overcharge', 'warn', {
                stationId: st.id, addr: batt.addr,
                title: `Battery held at ${B.max.toFixed(1)} V`,
                detail: `${plural(over.length, 'reading')} at or above ${BATT_OVER_V} V on ${plural(overDays.size, 'day')} — more than any charger should hold a lead-acid battery at.`,
                evidence: { maxV: B.max, readingsOver: over.length, days: overDays.size },
              }));
            }
          }
          if (spikes.length >= 2) {
            F.push(finding('value-spikes', 'info', {
              stationId: st.id, addr: batt.addr, key: st.id + ':batt',
              title: `${spikes.length} one-reading battery spikes`,
              detail: `Readings like ${spikes[0].v.toFixed(1)} V between two that agree — corrupted copies that arrived without a clean twin to set them against.`,
              evidence: { spikes: spikes.length },
            }));
          }
        }
      }

      // Rain.
      const rainS = S.sensors.filter(x => x.kind === 'rain').sort((a, b) => b.n - a.n)[0];
      if (rainS && rainS.txs.length >= 3) {
        S.rain = Object.assign(rainOf(rainS.txs, st), { addr: rainS.addr, aid: rainS.aid });
        const junk = S.rain.outliers + S.rain.flips + S.rain.jumps;
        if (junk >= 2) {
          const eg = S.rain.flipEg ? `${S.rain.flipEg.from} → ${S.rain.flipEg.to} (${S.rain.flipEg.tips} tips that are ${pop((S.rain.flipEg.from ^ S.rain.flipEg.to) & 0xFFF)} flipped bits)`
                   : S.rain.jumpEg ? `${S.rain.jumpEg.from} → ${S.rain.jumpEg.to} between two transmissions (${S.rain.jumpEg.tips} tips, which a gauge reporting its tips never jumps)`
                   : S.rain.outlierEg.length ? `counts like ${S.rain.outlierEg.map(g => g.v).join(', ')} off the gauge's running total` : '';
          F.push(finding('value-spikes', 'info', {
            stationId: st.id, addr: rainS.addr, key: st.id + ':rain',
            title: `${junk} corrupted rain-gauge counts set aside`,
            detail: `Counts that are not rain — ${eg}. Left in, ${junk === 1 ? 'it' : 'they'} would read as a downpour; they are corrupted frames stored as readings.`,
            evidence: { outliers: S.rain.outliers, flips: S.rain.flips, jumps: S.rain.jumps, example: S.rain.flipEg || S.rain.jumpEg || S.rain.outlierEg[0] || null },
          }));
        }
        if (S.rain.resets >= 1) {
          F.push(finding('rain-reset', 'info', {
            stationId: st.id, addr: rainS.addr,
            title: `Rain counter went backwards ${plural(S.rain.resets, 'time')}`,
            detail: `e.g. ${S.rain.resetEg.from} → ${S.rain.resetEg.to} at ${fmtWhen(S.rain.resetEg.t, now)} — not the counter wrapping, so a reset or a logger restart.`,
            evidence: { resets: S.rain.resets, example: S.rain.resetEg },
          }));
        }
      }

      // Level.
      const lev = S.sensors.filter(x => x.kind === 'level').sort((a, b) => b.n - a.n)[0];
      if (lev && lev.txs.length >= 3) {
        const vals = lev.txs.map(tx => ({ t: tx.t, v: tx.v }));
        const med = median(vals.map(p => p.v));
        const spikes = spikesOf(vals, Math.max(10, 0.1 * Math.abs(med)));
        const distinct = new Set(vals.map(p => p.v)).size;
        S.level = { addr: lev.addr, aid: lev.aid, n: vals.length, median: med, distinct, spikes: spikes.length,
                    flat: distinct === 1 && vals.length >= 8 && vals[vals.length - 1].t - vals[0].t >= 2 * DAY,
                    zero: distinct === 1 && vals[0].v === 0 };
        if (spikes.length >= 2) {
          F.push(finding('value-spikes', 'info', {
            stationId: st.id, addr: lev.addr, key: st.id + ':level',
            title: `${spikes.length} one-reading level spikes`,
            detail: `Counts like ${spikes[0].v} between two readings that agree (median ${med}) — corrupted copies stored as readings, which the 357 filter exists to catch.`,
            evidence: { spikes: spikes.length, median: med },
          }));
        }
        if (S.level.zero && vals.length >= 8) {
          F.push(finding('level-zero', 'info', {
            stationId: st.id, addr: lev.addr,
            title: 'Level reads zero throughout',
            detail: `${plural(vals.length, 'reading')}, every one 0.`,
            evidence: { n: vals.length },
          }));
        }
      }

      allStations.push(S);
    });

    // ── space: rain against the neighbours, levels against nearby rain ──
    const rainStations = allStations.filter(S => S.rain && placed(S.st));
    rainStations.forEach(S => {
      const nb = rainStations.filter(o => o !== S && km(S.st, o.st) <= RAIN_NEAR_KM);
      S.rainNeighbours = nb.map(o => ({ id: o.st.id, name: o.st.name, km: round(km(S.st, o.st), 1), mm: o.rain.mm }));
      if (nb.length < 2) return;
      const nbMm = nb.map(o => o.rain.mm);
      const medNb = median(nbMm), maxNb = Math.max(...nbMm);
      // Blocked: nothing here, a real fall around it, and its checks were
      // arriving through the rain — a silent station is not a blocked gauge.
      if (S.rain.mm === 0 && medNb >= 10 && S.schedule && S.schedule.counts && S.schedule.counts.hits + S.schedule.counts.partial >= 4) {
        S.findings.push(finding('rain-blocked', 'warn', {
          stationId: S.st.id, addr: S.rain.addr,
          title: 'No rain recorded while its neighbours had rain',
          detail: `${plural(nb.length, 'gauge')} within ${RAIN_NEAR_KM} km recorded a median ${round(medNb, 1)} mm (up to ${round(maxNb, 1)} mm) in the window; this one recorded nothing while still checking in.`,
          evidence: { mm: 0, neighbourMedianMm: round(medNb, 1), neighbourMaxMm: round(maxNb, 1), neighbours: S.rainNeighbours.slice(0, 6) },
        }));
      }
      // Isolated: a real fall here in some six hours when no neighbour saw any
      // — counted only from steps the gauge held, on a gauge heard often
      // enough to have a record to hold them in.
      if (S.rain.n < 4) return;
      for (let a = Math.floor(t0 / (6 * HOUR)) * 6 * HOUR; a < t1; a += 6 * HOUR) {
        const mine = rainBetween(S.rain, a, a + 6 * HOUR, true);
        if (mine < 10) continue;
        const theirs = nb.map(o => rainBetween(o.rain, a, a + 6 * HOUR));
        if (Math.max(...theirs) <= 1) {
          S.findings.push(finding('rain-isolated', 'warn', {
            stationId: S.st.id, addr: S.rain.addr, since: a,
            title: `${round(mine, 1)} mm recorded alone`,
            detail: `Between ${fmtWhen(a, now)} and ${fmtClock(a + 6 * HOUR)} it recorded ${round(mine, 1)} mm; ${plural(nb.length, 'gauge')} within ${RAIN_NEAR_KM} km recorded at most ${round(Math.max(...theirs), 1)} mm.`,
            evidence: { mm: round(mine, 1), from: a, neighbours: nb.length, neighbourMaxMm: round(Math.max(...theirs), 1) },
          }));
          break;
        }
      }
    });
    allStations.forEach(S => {
      if (!S.level || !S.level.flat || S.level.zero || !placed(S.st)) return;
      const nb = rainStations.filter(o => km(S.st, o.st) <= RAIN_NEAR_KM);
      if (!nb.length) return;
      const mm = median(nb.map(o => o.rain.mm));
      if (mm < 15) return;
      S.findings.push(finding('level-stuck', 'warn', {
        stationId: S.st.id, addr: S.level.addr,
        title: `Level unchanged through ${round(mm, 0)} mm of rain nearby`,
        detail: `Every one of its ${S.level.n} level readings is ${S.level.median}, while gauges within ${RAIN_NEAR_KM} km recorded a median ${round(mm, 1)} mm.`,
        evidence: { value: S.level.median, n: S.level.n, nearbyRainMm: round(mm, 1) },
      }));
    });

    // ── repeaters: shared silence and shared corruption ──
    const stationIds = new Set(allStations.map(S => S.st.id));
    const repStats = [];
    // A repeater relays a station only if it passes the address and is within
    // reach of it: the register's pass ranges are written for a network, and
    // the same address numbers recur across the country.
    const inReach = (rep, st) => !placed(rep.st) || !placed(st) || km(rep.st, st) <= REACH_KM;
    const carriers = new Map();
    const carriersOf = (S, aid) => {
      const k = S.st.id + '|' + aid;
      let l = carriers.get(k);
      if (!l) carriers.set(k, l = reps.filter(r => passes(r, aid) && inReach(r, S.st)));
      return l;
    };
    reps.forEach(rep => {
      const members = allStations.filter(S => inReach(rep, S.st) && [...S.addrs.values()].some(A => A.aid != null && A.aid <= 8191 && passes(rep, A.aid)));
      if (!members.length) return;
      let sent = 0, bad = 0, blame = 0, ghosts = 0;
      members.forEach(S => {
        S.txs.forEach(tx => {
          const n = tx.aid != null && tx.aid <= 8191 ? (carriersOf(S, tx.aid).length || 1) : 1;
          sent += 1 / n;
          if (tx.bad.length) { bad += tx.bad.length; blame += tx.bad.length / n; }
          if (tx.ghosts) ghosts += tx.ghosts / n;
        });
      });
      const silent = members.filter(S => S.findings.some(f => f.kind === 'silent'));
      repStats.push({ rep, id: rep.st.id, name: rep.st.name, members, silent, sent, bad, blame, ghosts, rate: sent ? blame / sent : 0 });
    });
    const rates = repStats.filter(r => r.sent >= 20).map(r => r.rate);
    const medRate = rates.length ? median(rates) : 0;
    const netFindings = [];
    repStats.forEach(R => {
      if (R.blame >= 5 && R.sent >= 20 && R.rate >= Math.max(0.03, 3 * medRate)) {
        netFindings.push(finding('repeater-bitflips', 'warn', {
          repeaterId: R.id,
          title: `${R.name}: relays with bit errors`,
          detail: `The common factor in ${round(R.blame, 1)} corrupted copies (${Math.round(100 * R.rate)}% of what it could have carried, against ${Math.round(100 * medRate)}% across the network's repeaters), over ${plural(R.members.length, 'station')} whose addresses it passes.`,
          evidence: { blame: round(R.blame, 1), rate: round(R.rate, 3), networkMedianRate: round(medRate, 3), stations: R.members.length },
        }));
      }
    });
    // Shared silence. A repeater that fails at T silences each station behind
    // it at that station's next check after T — so the last checks heard fall
    // across up to one check period before T, not at one moment. The window
    // is that wide: the longest period among the silent stations, and a bit.
    const periodOf = S => (S.schedule ? S.schedule.P : 3 * HOUR);
    const groupsOf = (silent) => {
      const xs = silent.filter(S => S.lastHeard != null).sort((a, b) => a.lastHeard - b.lastHeard);
      let best = [];
      for (let i = 0; i < xs.length; i++) {
        const W = Math.max(3 * HOUR, 1.25 * Math.max(...xs.slice(i).map(periodOf)));
        const g = xs.filter(S => S.lastHeard >= xs[i].lastHeard && S.lastHeard <= xs[i].lastHeard + W);
        if (g.length > best.length) best = g;
      }
      return best;
    };
    const candidates = [];
    repStats.forEach(R => {
      if (R.members.length < 3 || R.silent.length < 3) return;
      const G = groupsOf(R.silent);
      if (G.length < 3) return;
      const from = G[0].lastHeard, to = G[G.length - 1].lastHeard;
      // Against the members that were being heard before it and still are.
      const still = R.members.filter(S => !R.silent.includes(S) && S.bursts.length && S.bursts[0].t < from);
      const ratio = G.length / (G.length + still.length);
      if (ratio < 0.6) return;
      const own = byStation.get(R.id) || null;
      candidates.push({ R, G, from, to, ratio, still: still.length, ownSilent: own && own.findings.some(f => f.kind === 'silent') ? own : null });
    });
    // Two repeaters relaying the same stations explain the same silence: one
    // finding, naming both, the likelier first.
    candidates.sort((a, b) => b.ratio - a.ratio || b.G.length - a.G.length || (b.ownSilent ? 1 : 0) - (a.ownSilent ? 1 : 0));
    const merged = [];
    candidates.forEach(c => {
      const ids = new Set(c.G.map(S => S.st.id));
      const m = merged.find(x => { const inter = [...ids].filter(i => x.ids.has(i)).length; return inter >= 0.8 * Math.min(ids.size, x.ids.size); });
      if (m) { m.reps.push(c); c.G.forEach(S => m.ids.add(S.st.id)); return; }
      merged.push({ ids, reps: [c], lead: c });
    });
    merged.forEach(m => {
      const c = m.lead;
      const names = m.reps.map(x => x.R.name);
      const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
      const own = m.reps.find(x => x.ownSilent);
      netFindings.push(finding('repeater-down', 'critical', {
        repeaterId: c.R.id, since: c.from, key: 'rep:' + c.R.id,
        title: `${c.G.length} stations behind ${who} went quiet together`,
        detail: `Their last checks landed between ${fmtWhen(c.from, now)} and ${fmtWhen(c.to, now)} — inside one check period of each other, which is how a shared failure looks — while the receivers kept listening`
              + (c.still ? `; ${plural(c.still, 'station')} behind it ${c.still === 1 ? 'is' : 'are'} still heard, perhaps direct.` : '.')
              + (own ? ` The repeater site's own station, ${own.ownSilent.st.name}, went quiet too.` : '')
              + (names.length > 1 ? ` Every one of them passes through ${names.length} repeaters on file; ${c.R.name} explains them best.` : ''),
        evidence: { stations: c.G.map(S => S.st.id), repeaters: m.reps.map(x => x.R.id), from: c.from, to: c.to, stillHeard: c.still, ratio: round(c.ratio, 2) },
      }));
      c.G.forEach(S => S.findings.forEach(f => {
        if (f.kind !== 'silent' || f.cause) return;
        f.cause = { repeaterId: c.R.id, name: c.R.name };
        f.severity = 'warn';
        f.detail += ` One of ${c.G.length} behind ${who} that went quiet together — see that finding first.`;
      }));
    });
    // An area going quiet together with no repeater to blame: silent stations
    // whose last checks fell within two hours of each other, close together.
    // Each group is centred on the station that gathers the most, biggest
    // first — not on whichever was listed first, which split one evening's
    // silence north of Brisbane into two groups and left a third station out.
    const unexplained = allStations.filter(S => S.findings.some(f => f.kind === 'silent' && !f.cause) && placed(S.st));
    const used = new Set();
    const gather = S => unexplained.filter(o => !used.has(o) && km(S.st, o.st) <= AREA_KM
      && Math.abs(o.lastHeard - S.lastHeard) <= Math.max(2 * HOUR, 1.25 * Math.max(periodOf(o), periodOf(S))));
    for (;;) {
      let S = null, group = [];
      unexplained.forEach(c => {
        if (used.has(c)) return;
        const g = gather(c);
        if (g.length > group.length || (g.length === group.length && S && c.st.id < S.st.id)) { S = c; group = g; }
      });
      if (!S || group.length < 3) break;
      group.forEach(o => used.add(o));
      const onsets = group.map(o => o.lastHeard).sort((a, b) => a - b);
      netFindings.push(finding('area-silence', 'warn', {
        key: 'area:' + S.st.id, since: onsets[0],
        title: `${group.length} stations around ${S.st.name} went quiet together`,
        detail: `Within ${AREA_KM} km of ${S.st.name}, last heard between ${fmtWhen(onsets[0], now)} and ${fmtClock(onsets[onsets.length - 1])}. Something they share — a repeater not on file, a link, local interference.`,
        evidence: { stations: group.map(o => o.st.id), from: onsets[0], to: onsets[onsets.length - 1] },
      }));
      group.forEach(o => o.findings.forEach(f => {
        if (f.kind === 'silent' && !f.cause) { f.cause = { area: S.st.name }; f.severity = 'warn'; }
      }));
    }

    // ── spells shared: stations that went silent together and came back ──
    // The same reasoning as a shared silence, after the fact. Spells that
    // overlap by at least half the shorter one, at stations that share a
    // repeater or lie within AREA_KM of each other, are one event — a
    // repeater, a link or a receiver's channel that went away and came back —
    // and one finding says so, rather than a dozen saying "intermittent".
    const repsOf = new Map();
    repStats.forEach(R => R.members.forEach(S => { if (!repsOf.has(S)) repsOf.set(S, new Set()); repsOf.get(S).add(R.id); }));
    const spellList = [];
    allStations.forEach(S => (S.schedule ? S.schedule.spells : []).forEach(sp => {
      if (!sp.open && sp.to - sp.from >= 6 * HOUR) spellList.push({ S, from: sp.from, to: sp.to + S.schedule.P });
    }));
    const parent = spellList.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < spellList.length; i++) {
      for (let j = i + 1; j < spellList.length; j++) {
        const a = spellList[i], b = spellList[j];
        if (a.S === b.S) continue;
        const ov = Math.min(a.to, b.to) - Math.max(a.from, b.from);
        if (ov < 0.5 * Math.min(a.to - a.from, b.to - b.from)) continue;
        const ra = repsOf.get(a.S), rb = repsOf.get(b.S);
        const shareRep = ra && rb && [...ra].some(x => rb.has(x));
        const near = placed(a.S.st) && placed(b.S.st) && km(a.S.st, b.S.st) <= AREA_KM;
        if (shareRep || near) parent[find(i)] = find(j);
      }
    }
    const comps = new Map();
    spellList.forEach((sp, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(sp); });
    comps.forEach(group => {
      const sts = [...new Set(group.map(g => g.S))];
      if (sts.length < 3) return;
      const from = median(group.map(g => g.from)), to = median(group.map(g => g.to));
      // What they share, when it is a repeater on file.
      const counts = new Map();
      sts.forEach(S => (repsOf.get(S) || []).forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
      const top = [...counts.entries()].filter(([, n]) => n === sts.length).map(([id]) => repStats.find(R => R.id === id));
      const via = top.length ? top.map(R => R.name).slice(0, 2).join(' or ') : null;
      const anchor = sts.slice().sort((a, b) => b.bursts.length - a.bursts.length)[0];
      // How far the group spreads: chained neighbours can reach across a
      // city, and "around one station" would then undersell it.
      const pl = sts.filter(S => placed(S.st));
      let spread = 0, ends = null;
      for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) {
        const d = km(pl[i].st, pl[j].st);
        if (d > spread) { spread = d; ends = [pl[i].st.name, pl[j].st.name]; }
      }
      const where = via ? `behind ${via}` : spread > 40 && ends ? `across ${Math.round(spread)} km, ${ends[0]} to ${ends[1]},` : `around ${anchor.st.name}`;
      const lon = median(pl.map(S => S.st.lon)) || 150;
      netFindings.push(finding('shared-spell', 'warn', {
        key: 'spell:' + anchor.st.id + '@' + Math.round(from / HOUR), since: from,
        title: `${sts.length} stations ${where} went silent together, and came back`,
        detail: `Silent from about ${fmtWhen(from, now)} to ${fmtWhen(to, now)} while the receivers listened, then reporting again — together, so not ${sts.length} faults but one: ${via ? 'the repeater they share, or its link' : 'something they share — a repeater, a link, a channel'} went away for a while.`
              + (solarNight(from, to, lon) ? ' ' + SOLAR_HINT : ''),
        evidence: { stations: sts.map(S => S.st.id), from, to, repeaters: top.map(R => R.id), spreadKm: Math.round(spread) },
      }));
      sts.forEach(S => S.findings.forEach(f => {
        if (f.kind !== 'silent-spell' || f.cause) return;
        f.cause = via ? { name: via } : { area: anchor.st.name };
        f.detail += ` One of ${sts.length} ${via ? `behind ${via}` : 'nearby'} that went silent together — see that finding first.`;
      }));
    });

    // ── receivers ──
    rx.forEach(h => {
      if (h.n >= 50 && h.silentFor >= HOUR && t1 >= now - HOUR) {
        // A receiver that ran for an hour days ago was a session, not an
        // outage; one that ran for days and stopped this morning is the news.
        const session = h.span < 6 * HOUR;
        const sev = session ? 'info' : h.silentFor > DAY ? 'warn' : 'critical';
        const next = rx.filter(o => o !== h && o.first > h.last - 10 * MIN && o.first <= h.last + 3 * HOUR)
          .sort((a, b) => a.first - b.first)[0];
        netFindings.push(finding('receiver-silent', sev, {
          host: h.host, since: h.last,
          title: session ? `${hostName(h.host)}: a ${fmtSpan(h.span)} session, ${fmtSpan(h.silentFor)} ago`
                         : `${hostName(h.host)}: nothing delivered for ${fmtSpan(h.silentFor)}`,
          detail: `It delivered ${plural(h.n, 'reading')} (${round(h.perHour, 0)} an hour) and stopped at ${fmtWhen(h.last, now)}.`
                + (next ? ` ${hostName(next.host)} began delivering ${fmtSpan(Math.max(0, next.first - h.last))} later — if that is this receiver under a new name, only its stations' history is split.`
                        : ' Stations only it heard cannot be judged from then on.'),
          evidence: { readings: h.n, perHour: round(h.perHour, 1), last: h.last, ranFor: Math.round(h.span / MIN), successor: next ? next.host : null },
        }));
      }
      h.outages.slice(-3).forEach(o => {
        netFindings.push(finding('receiver-outage', 'warn', {
          host: h.host, key: h.host + '@' + o.from, since: o.from,
          title: `${hostName(h.host)}: ${fmtSpan(o.ms)} with nothing delivered`,
          detail: `From ${fmtWhen(o.from, now)} to ${fmtWhen(o.to, now)}, against a usual ${round(h.perHour, 0)} readings an hour. Checks due in that time are not counted against the stations.`,
          evidence: { from: o.from, to: o.to, minutes: Math.round(o.ms / MIN) },
        }));
      });
      if (h.lag.p50 != null && h.lag.p50 > 120) {
        netFindings.push(finding('receiver-latency', 'warn', {
          host: h.host,
          title: `${hostName(h.host)}: uploads arriving ${fmtSpan(h.lag.p50 * 1000)} late`,
          detail: `The median reading reaches the database ${Math.round(h.lag.p50)} s after it was heard (95th percentile ${Math.round(h.lag.p95)} s).`,
          evidence: { p50s: round(h.lag.p50, 1), p95s: round(h.lag.p95, 1) },
        }));
      }
      if (h.lag.p05 != null && h.lag.p05 < -5) {
        netFindings.push(finding('receiver-clock', 'warn', {
          host: h.host,
          title: `${hostName(h.host)}: clock running ahead`,
          detail: `Readings are stamped up to ${Math.round(-h.lag.p05)} s after the database received them — its clock is fast.`,
          evidence: { p05s: round(h.lag.p05, 1) },
        }));
      }
    });

    // ── network-wide misses ──
    netEvents.forEach(e => {
      netFindings.push(finding('network-miss', 'warn', {
        key: 'net@' + e.from, since: e.from,
        title: `${e.missed} of ${e.due} checks missed at once, ${fmtWhen(e.from, now)}`,
        detail: `Between ${fmtClock(e.from)} and ${fmtClock(e.to)} most of the network's due checks did not arrive although the receivers were up — the receiver, the channel, or interference, not the stations. Not counted against any one station.`,
        evidence: { from: e.from, to: e.to, missed: e.missed, due: e.due },
      }));
    });

    // ── addresses: ghosts, the register's gaps ──
    const regFindings = [];
    if (ghostCount) {
      const byOf = new Map();
      txs.forEach(tx => {
        if (!tx.ghostOf) return;
        const k = tx.ghostOf.of.addr;
        byOf.set(k, (byOf.get(k) || 0) + 1);
      });
      const worst = [...byOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const filed = txs.filter(tx => tx.ghostOf && tx.ghostOf.filed).length;
      const where = filed === ghostCount ? 'all under stations\' own addresses, out of line with what those addresses report'
        : filed ? `${ghostCount - filed} under addresses nobody here uses, ${filed} under stations' own addresses but out of line with what those addresses report`
        : 'under addresses nobody here uses';
      regFindings.push(finding('ghosts', 'info', {
        key: 'ghosts',
        title: `${plural(ghostCount, 'ghost reading')} stored under the wrong address`,
        detail: `Each sits within three bits — address and value together — of a transmission heard on another address in the same seconds: a corrupted copy filed under the wrong address, ${where}. Set aside before anything else was worked out. Most from ${worst.map(([a, n]) => `${a} (${n})`).join(', ')}.`,
        evidence: { ghosts: ghostCount, onStationAddresses: filed, worstSources: worst },
      }));
    }
    const addrList = [...addrNotes.values()];
    addrList.forEach(nt => {
      const real = nt.txs.filter(tx => !tx.ghostOf);
      if (real.length < 4 || nt.aid == null) return;
      const times = real.map(tx => tx.t);
      const sch = detectSchedule(times, t => listening([...nt.hosts], t), t0, t1, now);
      const cadence = sch ? `, every ${fmtPeriod(sch.P)} like a station's checks` : '';
      if (nt.res.conf === 'unknown') {
        regFindings.push(finding('registry-unknown', sch ? 'warn' : 'info', {
          addr: nt.addr,
          title: `Address ${nt.aid} is in use, and no station on file has it`,
          detail: `Heard ${plural(real.length, 'time')}${cadence} (not ghosts — nothing near it was heard at those moments). A station not yet in Flood-Net, or one whose address changed.`,
          evidence: { aid: nt.aid, heard: real.length, periodMin: sch ? sch.P / MIN : null },
        }));
      } else if (nt.res.conf === 'far') {
        regFindings.push(finding('registry-far', sch ? 'warn' : 'info', {
          addr: nt.addr, stationId: nt.res.st ? nt.res.st.id : null,
          title: `Address ${nt.aid} is heard here, but filed ${Math.round(nt.res.distKm).toLocaleString()} km away`,
          detail: `Heard ${plural(real.length, 'time')}${cadence}. The only station on file with it is ${nt.res.st ? nt.res.st.name : '?'} — too far for this receiver to hear; a station nearby is using the address.`,
          evidence: { aid: nt.aid, heard: real.length, filedAt: nt.res.st ? nt.res.st.id : null, km: Math.round(nt.res.distKm) },
        }));
      } else if (nt.res.conf === 'ambiguous') {
        regFindings.push(finding('registry-ambiguous', 'info', {
          addr: nt.addr,
          title: `Address ${nt.aid} is shared by ${nt.res.others + 1} stations here`,
          detail: `${plural(real.length, 'reading')} that cannot be attributed: ${nt.res.how}.`,
          evidence: { aid: nt.aid, heard: real.length },
        }));
      }
    });

    // ── stations nobody heard, whose repeaters relayed others ──
    const heardRepIds = new Set(repStats.filter(R => R.members.length >= 2).map(R => R.id));
    const notHeard = [];
    if (heardRepIds.size) {
      for (const s of stations) {
        if (stationIds.has(s.id) || s.enabled === false || s.proposed) continue;
        if (Array.isArray(s.roles) && s.roles.includes('repeater')) continue;
        const ids = typeof stationAlertIds === 'function' ? stationAlertIds(s).filter(a => a <= 8191) : [];
        if (!ids.length) continue;
        const via = reps.filter(r => heardRepIds.has(r.st.id) && inReach(r, s) && ids.some(a => passes(r, a)));
        if (!via.length) continue;
        // Only where every address it has is its own: a station whose addresses
        // are shared would have been heard under the other station's name.
        const idx = SensorValues.index();
        if (ids.some(a => (idx.get(a) || []).length > 1)) continue;
        notHeard.push({ st: s, via: via.map(r => r.st.name) });
      }
    }
    if (notHeard.length) {
      netFindings.push(finding('not-heard', 'info', {
        key: 'not-heard',
        title: `${plural(notHeard.length, 'station')} not heard at all`,
        detail: `Registered, enabled, and on repeaters that relayed other stations' traffic in the window — but not one reading from them. Decommissioned, on a channel no receiver here is tuned to, or dead.`,
        evidence: { stations: notHeard.slice(0, 50).map(n => ({ id: n.st.id, name: n.st.name, via: n.via.slice(0, 3) })), total: notHeard.length },
      }));
    }

    // ── assemble ──
    allStations.forEach(S => {
      S.status = S.findings.reduce((w, f) => (SEV_RANK[f.severity] < SEV_RANK[w] ? f.severity : w), 'ok');
      if (S.status === 'ok' && !S.schedule) S.status = 'irregular';
    });
    const findings = [];
    allStations.forEach(S => S.findings.forEach(f => findings.push(Object.assign(f, { station: S.st.name }))));
    netFindings.forEach(f => findings.push(f));
    regFindings.forEach(f => findings.push(f));
    findings.sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity])
                          || ((CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9))
                          || ((b.since || 0) - (a.since || 0)));

    const scheduled = allStations.filter(S => S.schedule);
    const due = scheduled.reduce((n, S) => n + S.schedule.counts.due, 0);
    const got = scheduled.reduce((n, S) => n + S.schedule.counts.hits + S.schedule.counts.partial, 0);
    return {
      t0, t1, now,
      counts: {
        rows: (rows || []).length, readings: recs.length, transmissions: txs.length,
        corrupted: corruptedTotal, ghosts: ghostCount,
        stationsHeard: allStations.length, scheduled: scheduled.length,
        checksDue: due, checksReceived: got,
        receivers: rx.length, addresses: addrNotes.size,
        attention: findings.filter(f => f.severity !== 'info').length,
      },
      stations: new Map(allStations.map(S => [S.st.id, S])),
      // Every transmission, its copies, its corrupted ones and its ghosts —
      // what the Airtime panel (airtime-analysis.js) reads who landed on top
      // of whom from.
      txs,
      receivers: rx,
      repeaters: repStats.sort((a, b) => b.blame - a.blame || b.members.length - a.members.length),
      netEvents,
      notHeard,
      addresses: addrList,
      findings,
      resolveRow,
      listening,
    };
  }

  // ── the context lens ─────────────────────────────────────────────────────────

  // What else was happening when station `id` was due, or reported, at `t`:
  // which receivers were delivering, what the stations it shares a repeater or
  // a neighbourhood with did at their own slots nearby, and what that makes
  // of this one. The per-packet half of "the context of the packets around it".
  function contextAt(A, id, t, opts) {
    const S = A.stations.get(id);
    if (!S) return null;
    const span = (opts && opts.spanMs) || 15 * MIN;
    const from = t - span, to = t + span;
    const hostsHere = [...S.hosts];
    // The receivers: the ones that hear this station and were running within
    // a day of the moment, each with how much it delivered around it — the
    // others only as a count. A receiver that ran for an hour last week is not
    // part of this moment's story.
    const rxAll = A.receivers.map(h => {
      let n = 0;
      // Ten-minute spans with traffic, from its bins: cheap, and exact enough.
      for (let b = Math.floor(from / BIN); b <= Math.floor(to / BIN); b++) if (h.bins.has(b)) n++;
      return { host: h.host, hearsThis: hostsHere.includes(h.host), binsWithTraffic: n, bins: Math.floor(to / BIN) - Math.floor(from / BIN) + 1,
               around: h.first <= t + DAY && h.last >= t - DAY };
    });
    const rxNear = rxAll.filter(r => r.hearsThis && r.around);
    const othersDelivering = rxAll.filter(r => !r.hearsThis && r.binsWithTraffic > 0).length;
    const listeningHere = rxNear.some(r => r.binsWithTraffic > 0);
    const slot = S.slots ? S.slots.reduce((best, sl) => (Math.abs(sl.t - t) < (best ? Math.abs(best.t - t) : Infinity) ? sl : best), null) : null;
    const mine = S.txs.filter(tx => tx.t >= from && tx.t <= to);

    // Peers: the nearest stations sharing a repeater with it, then the
    // nearest few of any kind. A big repeater carries a hundred stations
    // across two hundred kilometres, and the far ones say nothing about this
    // one's moment — so repeater-mates are taken nearest first, and only
    // within 60 km.
    const reps = A.repeaters.filter(R => R.members.includes(S));
    const peers = new Map();
    const dist = P => (placed(S.st) && placed(P.st) ? km(S.st, P.st) : Infinity);
    const viaRep = [];
    reps.forEach(R => R.members.forEach(P => { if (P !== S && !peers.has(P.st.id)) { peers.set(P.st.id, true); viaRep.push({ P, d: dist(P), why: `also behind ${R.name}` }); } }));
    peers.clear();
    viaRep.filter(x => x.d <= 60).sort((a, b) => a.d - b.d).slice(0, 8)
      .forEach(x => peers.set(x.P.st.id, { S: x.P, d: x.d, why: `${round(x.d, 1)} km away, ${x.why}` }));
    [...A.stations.values()].filter(P => P !== S && !peers.has(P.st.id))
      .map(P => ({ P, d: dist(P) })).filter(x => x.d <= 25).sort((a, b) => a.d - b.d).slice(0, 6)
      .forEach(x => peers.set(x.P.st.id, { S: x.P, d: x.d, why: `${round(x.d, 1)} km away` }));
    // What each did at its own slot nearest the moment. A peer already in a
    // long silence then was down anyway, and is said apart rather than
    // counted: it would make every moment look shared.
    const peerRows = [...peers.values()].sort((a, b) => a.d - b.d).map(({ S: P, why }) => {
      const win = Math.max(span, P.schedule ? P.schedule.P / 2 : 30 * MIN);
      const near = P.slots ? P.slots.filter(sl => Math.abs(sl.t - t) <= win) : [];
      const sl = near.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] || null;
      const heard = P.txs.some(tx => tx.t >= from && tx.t <= to);
      return { id: P.st.id, name: P.st.name, why, heard, down: !!(sl && sl.spell),
               slot: sl ? { t: sl.t, outcome: sl.outcome } : null };
    });
    const due = peerRows.filter(p => p.slot && p.slot.outcome !== 'unknown' && !p.down);
    const missed = due.filter(p => p.slot.outcome === 'miss' || p.slot.outcome === 'net');
    const downN = peerRows.filter(p => p.down).length;
    const ev = A.netEvents.find(e => t >= e.from && t < e.to);

    let verdict;
    const outcome = slot && Math.abs(slot.t - t) <= (S.schedule ? S.schedule.tol : 0) + MIN ? slot.outcome : null;
    const downTxt = downN ? ` (${plural(downN, 'neighbour')} ${downN === 1 ? 'was' : 'were'} already down for hours, and not counted)` : '';
    const frac = due.length ? missed.length / due.length : 0;
    if (!listeningHere) {
      verdict = { kind: 'network', text: 'None of the receivers that hear this station delivered anything around then — it is the receiver that was not there, not the station.' };
    } else if (ev) {
      verdict = { kind: 'network', text: `Part of a network-wide gap: ${ev.missed} of ${ev.due} checks due between ${fmtClock(ev.from)} and ${fmtClock(ev.to)} were missed.` };
    } else if (outcome === 'miss' && due.length >= 2 && frac >= 0.5) {
      verdict = { kind: 'shared', text: `${missed.length} of ${due.length} of its neighbours missed their checks around then too${downTxt} — the shared path or the area, not this station.` };
    } else if (outcome === 'miss' && due.length >= 2 && frac >= 0.25) {
      verdict = { kind: 'shared', text: `${missed.length} of ${due.length} of its neighbours missed theirs around then too${downTxt} — partly the path or the area; watch whether this station misses more than they do.` };
    } else if (outcome === 'miss') {
      verdict = { kind: 'own', text: due.length
        ? `The receivers were delivering and ${due.length - missed.length} of ${due.length} of its neighbours checked in on time${downTxt} — this miss is the station's own.`
        : `The receivers were delivering; no neighbour was due at the same time to compare with${downTxt}.` };
    } else if (outcome === 'partial') {
      verdict = { kind: 'own', text: 'The check arrived, but without every sensor\'s frame — frames lost on the way, one at a time.' };
    } else if (outcome === 'hit') {
      verdict = { kind: 'ok', text: 'Checked in on time.' };
    } else {
      verdict = { kind: 'info', text: mine.length ? 'Off its check schedule — an event report (rain, a level change) or a station that reports on events only.' : 'Nothing due from this station around then.' };
    }
    return {
      t, from, to, slot: outcome ? { t: slot.t, outcome } : null,
      mine: mine.map(tx => ({ t: tx.t, addr: tx.addr, aid: tx.aid, v: tx.v, copies: tx.copies.length, bad: tx.bad.map(b => ({ v: b.x.v, bits: b.bits, host: b.x.host })), ghosts: tx.ghosts || 0 })),
      receivers: rxNear, othersDelivering, peers: peerRows, netEvent: ev || null, verdict,
    };
  }

  // A reading in the context of the same address's readings either side.
  function readingContext(A, id, addr, t) {
    const S = A.stations.get(id);
    if (!S) return null;
    const sen = S.sensors.find(x => x.addr === addr);
    if (!sen) return null;
    const i = sen.txs.findIndex(tx => Math.abs(tx.t - t) < 1000);
    if (i < 0) return null;
    const tx = sen.txs[i], prev = sen.txs[i - 1] || null, next = sen.txs[i + 1] || null;
    const conv = v => SensorValues.convert(sen.kind, v, S.st);
    const onSlot = S.slots ? S.slots.some(sl => sl.burst && sl.burst.txs.includes(tx)) : false;
    return {
      kind: sen.kind, tx: { t: tx.t, v: tx.v, conv: conv(tx.v), copies: tx.copies.map(c => ({ host: c.host, path: c.path, v: c.v, t: c.t, lvl: c.lvl, lvlUnit: c.lvlUnit })),
                           bad: tx.bad.map(b => ({ v: b.x.v, bits: b.bits, dtS: round(b.dt / 1000, 1), host: b.x.host })) },
      prev: prev ? { t: prev.t, v: prev.v, conv: conv(prev.v), dt: tx.t - prev.t } : null,
      next: next ? { t: next.t, v: next.v, conv: conv(next.v), dt: next.t - tx.t } : null,
      onSlot,
      context: contextAt(A, id, tx.t),
    };
  }

  // ── a week whose answer is known ─────────────────────────────────────────────
  //
  // The oracle for test/health.mjs, and the tab's demo: a week of a network
  // built against the real register, with every fault the analysis claims to
  // find planted in it once. Seeded, so the same week every time.
  //
  //   steady     checks every 3 h, a battery swinging 12.9 → 14.0 V a day
  //   falling    the same, its night low sliding 0.12 V a night
  //   fading     checks fine for four days, then missing more each day
  //   silent     stops at noon on day 6
  //   partial    every other check without its battery frame
  //   flatline   a battery at 12.4 V day and night (no charge)
  //   corrupt    a third of its frames followed by a copy with bits flipped
  //   blocked    a rain gauge that records nothing through a storm its
  //              neighbours all record
  //   + the receiver drops out for three hours on day 2, and one ghost.
  function demoWorld(seed, opts) {
    const stations = (opts && opts.stations) || ((typeof state !== 'undefined' && state.data && state.data.stations) || []);
    let x = (seed || 20261006) >>> 0;
    const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    const idx = SensorValues.index();
    const own = a => (idx.get(a) || []).length === 1;
    // Stations with a battery, a rain gauge and a level, every address theirs
    // alone, with a position — the ones whose readings can only mean them.
    const full = stations.filter(s => placed(s) && s.lat < -10 && s.lon > 140).map(s => {
      const by = {};
      stationSensors(s).forEach(se => { const k = SensorValues.kindOf(se.type); if (k && se.alert_id != null && !by[k]) by[k] = se.alert_id; });
      return { s, by };
    }).filter(o => o.by.battery && o.by.rain && own(o.by.battery) && own(o.by.rain) && (!o.by.level || own(o.by.level)));
    if (full.length < 10) return { rows: [], roles: {}, now: Date.now() };
    // The densest neighbourhood: the station with most others within 30 km.
    let centre = null, bestN = -1;
    full.forEach(o => {
      const n = full.filter(p => p !== o && km(o.s, p.s) <= RAIN_NEAR_KM).length;
      if (n > bestN) { bestN = n; centre = o; }
    });
    const pool = full.slice().sort((a, b) => km(a.s, centre.s) - km(b.s, centre.s)).slice(0, 12);
    const now = (opts && opts.now) || Date.UTC(2026, 9, 6, 0, 30);
    const t0 = now - 7 * DAY;
    const P = 3 * HOUR;
    const host = 'serial-monitor/demo-pi-sdr1';
    const rows = [];
    const roles = {};
    const order = ['blocked', 'steady', 'falling', 'fading', 'silent', 'partial', 'flatline', 'corrupt', 'steady2', 'steady3', 'steady4', 'steady5'];
    const outageFrom = t0 + DAY + 2 * HOUR, outageTo = outageFrom + 3 * HOUR;
    // 20:00 to 09:00 in the station's own solar time, on the fifth night.
    const lon0 = centre.s.lon;
    const spellFrom = Math.floor((t0 + 4 * DAY) / DAY) * DAY + (20 - lon0 / 15) * HOUR;
    const spellTo = spellFrom + 13 * HOUR;
    const storm = t0 + 3 * DAY + 4 * HOUR;
    const push = (aid, t, v, path) => rows.push({
      addr: 'a:' + aid, alert_id: aid, station_number: null, channel: '', station_id: null,
      reading_ts: new Date(t).toISOString(), received_at: new Date(t + 5300).toISOString(),
      value_raw: v, value: null, unit: null, protocol: 1, source: 5, path: path || host,
      dup_count: 0, dup_paths: [], freq_mhz: null, rssi_dbm: null, level_dbfs: null, snr_db: null,
    });
    // Background traffic so the receiver is demonstrably listening between
    // checks: a station's level every 20 min (event reports), on the steady
    // stations.
    const phases = {};
    pool.forEach((o, i) => {
      const role = order[i] || 'steady';
      roles[role] = o.s.id;
      let phase = Math.round(rnd() * 170) * MIN + 41 * 1000;
      // One clash for the Airtime panel: steady2's check starts 0.9 s after
      // the partial station's battery frame — the frame that goes missing on
      // a third of its checks. The draw above is still made, so every other
      // station's week is the one it always was.
      if (role === 'steady2' && phases.partial != null) phase = phases.partial + 10800 + 900;
      phases[role] = phase;
      let rainCount = Math.floor(rnd() * 1500);
      for (let k = Math.ceil((t0 - phase) / P); phase + k * P < now - 5 * MIN; k++) {
        const t = phase + k * P;
        if (t < t0) continue;
        if (t >= outageFrom && t < outageTo) continue;                     // nothing heard at all
        const day = (t - t0) / DAY;
        if (role === 'silent' && day >= 5.5) continue;
        // Three neighbours gone together overnight, and back after breakfast.
        if ((role === 'steady3' || role === 'steady4' || role === 'steady5') && t >= spellFrom && t < spellTo) continue;
        if (role === 'fading' && day >= 4 && rnd() < Math.min(0.85, 0.25 * (day - 3.5))) continue;
        // Battery: the station's solar day.
        const sh = mod(solarHours(t, o.s.lon), 24);
        const sun = Math.max(0, Math.sin((sh - 6) / 12 * Math.PI));
        let V = 12.9 + 1.1 * sun;
        if (role === 'falling') V = 12.95 - 0.12 * day + 0.9 * sun;
        if (role === 'flatline') V = 12.4;
        const battRaw = Math.round(V * 10);
        // The storm: 18 mm over its six hours everywhere except the blocked gauge.
        if (t > storm && t <= storm + 6 * HOUR + P && role !== 'blocked') rainCount = (rainCount + 30) % 2048;
        const level = 40 + Math.round(5 * Math.sin(day));
        push(o.by.rain, t, rainCount);
        if (o.by.level) push(o.by.level, t + 5400, level);
        const skipBatt = role === 'partial' && rnd() < 0.35;
        if (!skipBatt) {
          push(o.by.battery, t + 10800, battRaw);
          if (role === 'corrupt' && rnd() < 0.34) {
            const bit = 1 << Math.floor(rnd() * 11);
            push(o.by.battery, t + 12900, battRaw ^ bit);
          }
        }
      }
      // Event traffic: keeps the receiver visibly listening.
      if (o.by.level && (role === 'steady' || role === 'steady2')) {
        for (let t = t0 + 7 * MIN; t < now - 5 * MIN; t += 20 * MIN) {
          if (t >= outageFrom && t < outageTo) continue;
          push(o.by.level, t, 40 + Math.round(5 * Math.sin((t - t0) / DAY)) + (Math.floor(t / (20 * MIN)) % 2));
        }
      }
    });
    // One ghost: the steady station's battery frame relayed with one address
    // bit flipped — onto the first such address no station carries.
    const steady = pool[1];
    if (steady) {
      let ghostAid = null;
      for (let bit = 0; bit < 13 && ghostAid == null; bit++) {
        const g = steady.by.battery ^ (1 << bit);
        if (g >= 1 && g <= 8191 && !(idx.get(g) || []).length) ghostAid = g;
      }
      const t = rows.find(r => r.alert_id === steady.by.battery && Date.parse(r.reading_ts) > t0 + 4 * DAY);
      if (ghostAid != null && t) { push(ghostAid, Date.parse(t.reading_ts) + 2100, t.value_raw); roles.ghost = ghostAid; }
    }
    // Each role's check phase: the oracle for the Airtime panel's clashes. The
    // draws after a role whose loop draws per slot (fading, partial, corrupt)
    // move with the window, so two of the later stations can land on one
    // minute by chance — a clash as real as the planted one.
    roles.phases = phases;
    roles.spell = { from: spellFrom, to: spellTo };
    roles.outage = { from: outageFrom, to: outageTo };
    roles.storm = storm;
    rows.sort((a, b) => a.reading_ts < b.reading_ts ? -1 : 1);
    return { rows, roles, now, t0, t1: now, host };
  }

  return {
    run, contextAt, readingContext, demoWorld,
    // The arithmetic, for test/health.mjs.
    _detectSchedule: detectSchedule, _theilSen: theilSen, _batteryOf: batteryOf, _rainOf: rainOf,
    _transmissions: transmissions, _normalise: normalise, _pop: pop,
    fmtWhen, fmtSpan, fmtPeriod, ACTION, CATEGORY,
    PERIODS, COPY_WINDOW, BURST_WINDOW,
  };
})();

if (typeof window !== 'undefined') window.HealthAnalysis = HealthAnalysis;
