// MegaNet — airtime-analysis.js
//
//   AirtimeAnalysis   the Station Health tab's Airtime panel, with no page in
//                     it: which transmissions land on top of each other at
//                     each receiver, whether the ones that do come off worse,
//                     when each station's check signal goes out and how its
//                     logger keeps that time, which checks share a moment
//                     with another station's every few hours — and what to
//                     change: a check time, or a repeater's delay.
//
// After health-analysis.js, whose result it reads (fromHealth), and before
// health-airtime.js, which draws it. Nothing here runs at load, touches the
// DOM or fetches. analyse() takes plain objects — transmissions, stations,
// repeaters — so test/airtime.mjs holds every rule to inputs built for it in
// Node; fromHealth() is the one adapter from HealthAnalysis.run()'s result.
//
// ── What "on top of each other" can mean, given the clocks we have ──────────
// ALERT is ALOHA: a station keys up when its logger says so, nobody listens
// first, and two stations heard at one receiver in the same instant spoil
// each other — one lost, both lost, or a frame decoded with bits flipped.
// A legacy ALERT frame is 40 bits at 300 baud, 133 ms, and a keying with its
// lead-in about half a second, so "the same instant" is a second or less.
//
// The times we hold are coarser than that. An RPi ALERT base station stamps
// a reading when the RTL-SDR's decoder finishes, not when the burst began:
// 0.5–3 s after it was on the air, varying with the backlog in that
// channel's decoder (RPi_ALERT agent/lib/agent.js, sdr-worker.js). A
// Quansheng stamps when its line reaches the Pi; an ERT-A2's frames carry
// whole seconds. So two stations' frames stamped within TOGETHER_MS at one
// receiver channel are *together* — they could have overlapped on the air —
// and nothing finer is claimed. Two stamped within SAME_BURST_MS came out of
// one squelch opening, decoded at once: back to back or on top of each other
// on the air, which is the one sub-second statement these clocks support.
//
// A repeater's delay is under a second, so it cannot be measured from these
// times at all. What the readings can say about repeaters is where the
// corrupted copies are; the delays offered here are the Backbone's
// (map-backbone.js), put in front of the repeater pairs whose shared stations
// the corrupted copies point at.
//
// ── Together, and does it hurt? ──────────────────────────────────────────────
// Every transmission is marked together if another station's frame landed
// within TOGETHER_MS of one of its copies at a receiver channel that heard
// it, and damaged if it came with a corrupted copy or a ghost (Station
// Health's own two kinds of bad copy). The headline is the two damage rates
// side by side — together against alone — because crowding that does no harm
// needs no change, and crowding that does shows up as exactly that gap.
//
// ── Check signals: when, and how the logger keeps the time ──────────────────
// Station Health learns each station's period and phase. Here each check's
// distance from its slot, check after check, says how the logger keeps time,
// which is what decides how a check is moved (the "depending on the firmware"
// question, answered from what the station does rather than from a model
// number nobody has recorded):
//
//   steady     on its slot to within STEADY_SPREAD_MS, day after day — a
//              logger timing checks from its clock. Its check offset (or
//              start time) moves it, and it stays moved.
//   loose      keeps a slot, more loosely — the same, with a wider guard.
//   drifting   walks a few seconds a day or more — a free-running clock.
//              Moving it does not stay moved; it walks into and out of other
//              stations' slots, and when it reaches the next is said here.
//   jumped     stepped to a new time and stayed — the shape of a logger that
//              counts its interval from power-up, so a restart moves it. It
//              is moved by restarting it at the new time, or by changing it
//              to clock-timed checks.
//   jittered   wanders more than JITTER_SPREAD_MS about its slot — checks
//              randomised by the logger. Nothing to move; its collisions are
//              by chance, and it is left out of the clashes.
//   unclear    too few checks to tell.
//
// ── Clashes, and where to move a check ──────────────────────────────────────
// Two stations heard at a common receiver channel, or within reach of a
// common repeater, clash when their checks fall together: on a circle as
// long as the greatest common divisor of their periods (a 1-hour station and
// a 3-hour one meet every 3 hours if they meet at all), the stretch each
// check occupies — its first frame to its last, and a keying more — is within
// a guard of the other's. The guard is TOGETHER_MS and both stations' own
// spread. Each clash is held to the slots in the window when both were due:
// how often one of them came off worse, against every other check in the
// network.
//
// Stations that clash form groups. In each, the stations that cannot be moved
// usefully (drifting, unclear) stay, then the ones doing best; every one left
// clashing with a station that stays is offered the middle of the widest gap
// in its period at its receivers and repeaters — every other station there
// projected onto its circle — rounded to STEP_MS, the quieter of near-equal
// gaps preferred, then the smaller move. Moves are planned in turn, so two
// stations are never sent to one gap.

const AirtimeAnalysis = (() => {

  const SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;

  // Stamped within this at one receiver channel: could have been on the air
  // together. The decode lag of an RTL-SDR base station varies over 0.5–3 s.
  const TOGETHER_MS = 3000;
  // Stamped within this: decoded out of one squelch opening. Not claimed on a
  // channel whose times are whole seconds.
  const SAME_BURST_MS = 300;
  // One keying on the air: lead-in, a 133 ms frame, tail. Pads a check's
  // footprint, which is otherwise first frame to last.
  const AIR_MS = 500;
  // An address no station carries that rides with one station's transmissions
  // — within RIDE_MS of them at least RIDE_FRAC of the time — is that
  // station's sensor not on file, and is not crowding it.
  const RIDE_MS = 15000, RIDE_FRAC = 0.7, RIDE_MIN = 4;
  // The hour, folded: 120 bins of 30 s.
  const FOLD_BIN = 30000;
  // A check time offered is a whole half-minute.
  const STEP_MS = 30000;
  // How a logger keeps time.
  const STEADY_SPREAD_MS = 15000;
  const JITTER_SPREAD_MS = 45000;
  const DRIFT_S_PER_DAY = 5;
  const JUMP_MS = 30000;
  const MIN_RESID = 6;
  // A drifting check reaching another station's within this is said now.
  const HORIZON_MS = 14 * DAY;
  // A rate is only compared when both sides hold this many, and this many
  // damaged between them.
  const ENOUGH_TX = 20, ENOUGH_DAMAGED = 3;
  // A repeater hears stations about this far away, not the 400 km an address
  // can be filed across. Two stations further than this from a repeater are
  // not crowding each other there.
  const REP_HEAR_KM = 120;
  // Two repeater delays closer than this re-send one frame together — the
  // Backbone's own spacing (REPEATER_DELAY_STEP_MS).
  const REP_SEP_MS = 150;
  // A move is offered only past this much clearance; less is said as such.
  const CLEAR_MS = 60000;
  // The nearest time that clears everything by this much is offered before
  // the middle of the widest gap: a few minutes is plenty against stamps good
  // to a few seconds, and the smaller the move the less else it disturbs.
  const ROOM_MS = 5 * MIN;

  // ── small arithmetic ────────────────────────────────────────────────────────

  const mod = (a, n) => ((a % n) + n) % n;
  const round = (v, dp) => { const k = Math.pow(10, dp || 0); return Math.round(v * k) / k; };
  function median(xs) {
    const s = xs.filter(x => isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // The median absolute deviation, scaled to read as a standard deviation.
  function spread(xs) {
    const m = median(xs);
    if (m == null) return null;
    return 1.4826 * median(xs.map(x => Math.abs(x - m)));
  }
  function theilSen(xs, ys) {
    const s = [];
    const n = xs.length;
    const step = n > 60 ? Math.ceil(n / 60) : 1;
    for (let i = 0; i < n; i += step) {
      for (let j = i + step; j < n; j += step) {
        if (xs[j] !== xs[i]) s.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
      }
    }
    return s.length ? median(s) : null;
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }
  const lcm = (a, b) => a / gcd(a, b) * b;
  function lowerBound(a, x, key) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if ((key ? key(a[m]) : a[m]) < x) lo = m + 1; else hi = m; }
    return lo;
  }
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const placed = s => s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);

  // How far apart two stretches are on a circle of circumference g: the
  // smaller gap between them, or minus how much they overlap.
  function clearance(xa, fa, xb, fb, g) {
    const d1 = mod(xb - xa, g);     // b starts this long after a does
    const d2 = mod(xa - xb, g);     // …and a this long after b
    if (d1 <= fa) return -Math.min(fa - d1, fb);
    if (d2 <= fb) return -Math.min(fb - d2, fa);
    return Math.min(d1 - fa, d2 - fb);
  }
  // The same, on a line: two stretches that start at a and b.
  function lineClearance(a, fa, b, fb) {
    if (b >= a) return b <= a + fa ? -Math.min(a + fa - b, fb) : b - (a + fa);
    return a <= b + fb ? -Math.min(b + fb - a, fa) : a - (b + fb);
  }

  // ── words ───────────────────────────────────────────────────────────────────

  const p2 = n => String(n).padStart(2, '0');
  function fmtPeriod(P) {
    const m = P / MIN;
    return m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${round(m / 60, 1)} h`;
  }
  function fmtDur(ms) {
    const a = Math.abs(ms);
    if (a < 90 * SEC) return `${Math.round(a / SEC)} s`;
    const m = Math.floor(a / MIN), s = Math.round((a - m * MIN) / SEC);
    if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    return mm ? `${h} h ${mm} min` : `${h} h`;
  }
  function fmtDays(ms) {
    const d = ms / DAY;
    return d < 1.5 ? `${Math.max(1, Math.round(ms / HOUR))} h` : `${Math.round(d)} days`;
  }
  // Local midnight on the day of t.
  function midnight(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hms(t) { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }
  // When a check whose arrivals sit at `at` (mod P) goes out, as people say
  // it: the first after midnight and the period, or the minutes past the hour.
  function clockOf(at, P, now) {
    const m0 = midnight(now);
    const first = m0 + mod(at - m0, P);
    if (P >= HOUR) return P === DAY ? `${hms(first)} daily` : `${hms(first)}, then every ${fmtPeriod(P)}`;
    const ms = [];
    for (let k = 0; k * P < HOUR; k++) {
      const d = new Date(first + k * P);
      ms.push(`:${p2(d.getMinutes())}:${p2(d.getSeconds())}`);
    }
    return P === HOUR ? `${ms[0]} past every hour` : `${ms.join(', ')} past every hour`;
  }
  function plural(n, one, many) { return `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`; }
  const pct = (d, n) => (n ? Math.round(100 * d / n) : 0);
  const pathLabel = p => String(p || '').replace(/^serial-monitor\//, '');

  const BEHAVIOUR = {
    steady:   'keeps its time',
    loose:    'keeps its time loosely',
    drifting: 'drifting',
    jumped:   'jumped to a new time',
    jittered: 'randomised',
    unclear:  'too few to tell',
  };
  // How a check is moved, by how the station's logger keeps its time. Said
  // from what the checks do, because the register records no logger model or
  // firmware; where somebody knows the logger, they know which line is theirs.
  function howToMove(c) {
    switch (c.behaviour) {
      case 'steady':
      case 'loose':
        return `Its checks keep their slot (±${fmtDur(c.spreadMs || 0)}), the way a logger that times its checks off its clock does: change its timed-report offset or start time. On a logger that counts its interval from when it powered up instead, the check moves with a restart at the new time.`;
      case 'jumped':
        return `Its check time stepped by ${fmtDur(c.jump.ms)} on ${new Date(c.jump.t).toDateString()} and stayed there — the pattern of a logger that counts its interval from power-up, so a restart moved it. Restart it at the new time, or set it to clock-timed checks if its firmware has them, so the next restart does not move it again.`;
      case 'drifting':
        return `Its checks walk ${round(Math.abs(c.driftSPerDay), 1)} s a day ${c.driftSPerDay > 0 ? 'later' : 'earlier'} — a clock running free. A new offset will not stay put: set its clock (and check the clock battery), or turn on time sync if its firmware has it, first.`;
      default:
        return 'Too few checks to tell how its logger keeps time; confirm the check time on the logger before changing it.';
    }
  }

  // ── 1. how each station keeps its check time ────────────────────────────────

  // resid: [{t, d}] — each check heard, its slot's time, and how far after the
  // slot it was heard. Returns how it keeps time, its spread, and offAt(t):
  // where its check lands relative to its slot at time t.
  function timing(resid) {
    const r = (resid || []).filter(x => isFinite(x.t) && isFinite(x.d)).slice().sort((a, b) => a.t - b.t);
    const n = r.length;
    const ds = r.map(x => x.d);
    const med = n ? median(ds) : 0;
    const out = { n, behaviour: 'unclear', spreadMs: n ? spread(ds) : null, driftSPerDay: null, jump: null, offAt: () => med };
    if (n < MIN_RESID) return out;
    // A step: the split that leaves each side tightest about its own median
    // — then it is a step if the medians are far apart against that, and it
    // happens between two checks rather than across many.
    // Searched on the checks thinned evenly to 150 at most (a 15-minute
    // station's fortnight is 1,300), then pinned to the one check, of those
    // the thinning stepped over, where the step is.
    let best = null;
    const k = Math.max(1, Math.ceil(n / 150));
    const th = ds.filter((_, i) => i % k === 0);
    for (let m = 3; m <= th.length - 3; m++) {
      const left = th.slice(0, m), right = th.slice(m);
      const L = median(left), R = median(right);
      let cost = 0;
      left.forEach(d => { cost += Math.abs(d - L); });
      right.forEach(d => { cost += Math.abs(d - R); });
      if (!best || cost < best.cost) best = { m: m * k, L, R, cost };
    }
    if (best && k > 1) {
      const sign = Math.sign(best.R - best.L);
      let at = best.m, big = -Infinity;
      for (let i = Math.max(1, best.m - k + 1); i <= Math.min(n - 1, best.m); i++) {
        const d = sign * (ds[i] - ds[i - 1]);
        if (d > big) { big = d; at = i; }
      }
      best.m = at;
    }
    if (best) {
      const step = best.R - best.L;
      const within = 1.4826 * median(ds.slice(0, best.m).map(d => Math.abs(d - best.L)).concat(ds.slice(best.m).map(d => Math.abs(d - best.R))));
      const abrupt = Math.abs(ds[best.m] - ds[best.m - 1]) >= 0.6 * Math.abs(step);
      if (Math.abs(step) >= Math.max(JUMP_MS, 6 * within) && abrupt) {
        return Object.assign(out, { behaviour: 'jumped', jump: { t: r[best.m].t, ms: step }, spreadMs: within, offAt: () => best.R });
      }
    }
    if (r[n - 1].t - r[0].t >= 2 * DAY) {
      const slope = theilSen(r.map(x => x.t / DAY), ds.map(d => d / SEC));    // s a day
      if (slope != null) out.driftSPerDay = round(slope, 1);
      if (slope != null && Math.abs(slope) >= DRIFT_S_PER_DAY) {
        const icpt = median(r.map(x => x.d - slope * SEC * x.t / DAY));
        const res = r.map(x => x.d - (icpt + slope * SEC * x.t / DAY));
        // A walk, not a slope fitted to scatter: over the window it has to go
        // well past how far the checks stray about it.
        const walked = Math.abs(slope) * SEC * (r[n - 1].t - r[0].t) / DAY;
        const sp = spread(res);
        if (walked >= Math.max(20 * SEC, 3 * sp)) {
          return Object.assign(out, { behaviour: 'drifting', spreadMs: sp, offAt: t => icpt + slope * SEC * t / DAY });
        }
      }
    }
    out.behaviour = out.spreadMs > JITTER_SPREAD_MS ? 'jittered' : out.spreadMs <= STEADY_SPREAD_MS ? 'steady' : 'loose';
    return out;
  }

  // ── the analysis ────────────────────────────────────────────────────────────

  // input:
  //   t0, t1, now
  //   txs        [{ t, src, ghost, damaged, check, arr: [{ path, t, bad }] }]
  //              src is who sent it (a station id, or an address no station
  //              carries); a ghost is a corrupted copy filed under another
  //              address — on the air, but not a transmission of its own.
  //   stations   [{ id, name, lat, lon, P, phase, resid: [{t, d}], footMs,
  //                 paths: [..], reps: [..], slots: [{ t, outcome, damaged, spell }] }]
  //   repeaters  [{ id, name, delayMs, suggestedMs, txMhz, members: [station ids] }]
  //   names      Map src -> how to say it, for an address no station carries
  function analyse(input) {
    const I = input || {};
    const now = I.now != null ? I.now : Date.now();
    const t0 = I.t0 != null ? I.t0 : now - 7 * DAY, t1 = I.t1 != null ? I.t1 : now;
    const days = Math.max(1 / 24, (t1 - t0) / DAY);
    const txs = (I.txs || []).filter(tx => tx && isFinite(tx.t) && Array.isArray(tx.arr));
    const stations = I.stations || [];
    const stById = new Map(stations.map(s => [s.id, s]));
    const nameOf = src => (stById.has(src) ? stById.get(src).name : (I.names && I.names.get(src)) || `address ${String(src).replace(/^a:/, '')} (not on file)`);

    // ── per receiver channel: who landed together ──
    const byPath = new Map();
    txs.forEach(tx => {
      tx.together = false; tx.togetherAt = null;
      tx.arr.forEach(a => {
        if (!a.path || !isFinite(a.t)) return;
        if (!byPath.has(a.path)) byPath.set(a.path, []);
        byPath.get(a.path).push({ t: a.t, src: tx.src, tx, bad: !!a.bad });
      });
    });
    const paths = [];
    const piles = [];
    byPath.forEach((ev, path) => {
      ev.sort((a, b) => a.t - b.t);
      const whole = ev.length >= 20 && ev.filter(e => e.t % SEC === 0).length >= 0.95 * ev.length;
      let j0 = 0;
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        while (ev[j0].t < e.t - TOGETHER_MS) j0++;
        let gap = Infinity, other = null;
        for (let j = j0; j < ev.length && ev[j].t <= e.t + TOGETHER_MS; j++) {
          if (j === i || ev[j].src === e.src) continue;
          const d = Math.abs(ev[j].t - e.t);
          if (d < gap) { gap = d; other = ev[j]; }
        }
        e.gap = gap;
        if (other) {
          e.tx.together = true;
          (e.tx.togetherAt || (e.tx.togetherAt = new Set())).add(path);
        }
      }
      // Runs of frames each within TOGETHER_MS of the last, from two
      // stations or more: a pile-up.
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const srcs = [...new Set(cur.ev.map(e => e.src))];
        if (srcs.length >= 2) {
          const minGap = Math.min(...cur.ev.map(e => e.gap));
          piles.push({
            path, t: cur.ev[0].t, span: cur.ev[cur.ev.length - 1].t - cur.ev[0].t, srcs, frames: cur.ev.length,
            damaged: cur.ev.some(e => e.bad || e.tx.damaged || e.tx.ghost),
            minGap, sameBurst: !whole && minGap <= SAME_BURST_MS,
            checks: srcs.filter(s => cur.ev.some(e => e.src === s && e.tx.check)).length,
          });
        }
        cur = null;
      };
      ev.forEach(e => {
        if (cur && e.t - cur.ev[cur.ev.length - 1].t <= TOGETHER_MS) { cur.ev.push(e); return; }
        flush();
        cur = { ev: [e] };
      });
      flush();

      // Each transmission once at this channel, at its first copy here.
      const first = new Map();
      ev.forEach(e => { if (!e.tx.ghost && !first.has(e.tx)) first.set(e.tx, e.t); });
      const bins = Math.round(HOUR / FOLD_BIN);
      const fold = { bin: FOLD_BIN, n: new Array(bins).fill(0), checks: new Array(bins).fill(0), damaged: new Array(bins).fill(0), together: new Array(bins).fill(0) };
      const tog = { n: 0, d: 0 }, alone = { n: 0, d: 0 };
      first.forEach((t, tx) => {
        const b = Math.floor(mod(t, HOUR) / FOLD_BIN);
        fold.n[b]++;
        if (tx.check) fold.checks[b]++;
        if (tx.damaged) fold.damaged[b]++;
        const here = !!(tx.togetherAt && tx.togetherAt.has(path));
        if (here) fold.together[b]++;
        const box = here ? tog : alone;
        box.n++;
        if (tx.damaged) box.d++;
      });
      const mine = piles.filter(p => p.path === path);
      const dayMap = new Map();
      mine.forEach(p => {
        const k = midnight(p.t);
        let d = dayMap.get(k);
        if (!d) dayMap.set(k, d = { day: k, piles: 0, damaged: 0 });
        d.piles++;
        if (p.damaged) d.damaged++;
      });
      paths.push({
        path, label: pathLabel(path), wholeSeconds: whole,
        n: first.size, perDay: first.size / days,
        together: tog.n, togetherShare: first.size ? tog.n / first.size : 0,
        sameBurst: mine.filter(p => p.sameBurst).length,
        piles: mine.length, damagedPiles: mine.filter(p => p.damaged).length,
        dmg: { together: tog, alone },
        fold, days: [...dayMap.values()].sort((a, b) => a.day - b.day),
      });
    });
    paths.sort((a, b) => b.n - a.n);

    // ── together against alone, network-wide ──
    const tog = { n: 0, d: 0 }, alone = { n: 0, d: 0 };
    txs.forEach(tx => {
      if (tx.ghost) return;
      const b = tx.together ? tog : alone;
      b.n++;
      if (tx.damaged) b.d++;
    });
    const enough = tog.n >= ENOUGH_TX && alone.n >= ENOUGH_TX && tog.d + alone.d >= ENOUGH_DAMAGED;
    const rate = b => (b.n ? b.d / b.n : 0);
    // Half a damaged transmission added to an empty side, so "none of them"
    // reads as a large ratio rather than infinity.
    const ratio = enough ? (rate(tog) || 0) / Math.max(rate(alone), 0.5 / Math.max(1, alone.n)) : null;
    const damage = { together: tog, alone, enough, ratio: ratio != null ? round(ratio, 1) : null };

    // ── each station's check: when, how it keeps time, what it occupies ──
    const checks = [];
    stations.forEach(s => {
      if (!s.P || !isFinite(s.phase)) return;
      const tm = timing(s.resid);
      const at = mod(s.phase + tm.offAt(now), s.P);
      checks.push({
        id: s.id, name: s.name, P: s.P, at, clock: clockOf(at, s.P, now),
        behaviour: tm.behaviour, behaviourLabel: BEHAVIOUR[tm.behaviour],
        spreadMs: tm.spreadMs != null ? Math.round(tm.spreadMs) : null, driftSPerDay: tm.driftSPerDay, jump: tm.jump,
        footMs: Math.max(AIR_MS, Math.round(s.footMs || 0) + AIR_MS), n: tm.n,
        paths: s.paths || [], reps: s.reps || [], offAt: tm.offAt, phase: s.phase,
        slots: s.slots || [], lat: s.lat, lon: s.lon,
        clashes: [],
      });
    });
    const ckById = new Map(checks.map(c => [c.id, c]));
    // The guard either side of a check: the timing slop and its own spread,
    // a randomised logger's held at the cap so one cannot claim a whole hour.
    const sp = c => Math.min(c.spreadMs != null ? c.spreadMs : STEADY_SPREAD_MS, JITTER_SPREAD_MS);
    const guardOf = (a, b) => TOGETHER_MS + sp(a) + sp(b);

    // Who shares a hearer with whom: a receiver channel that hears both, or a
    // repeater both are within reach of.
    const share = new Map();      // id -> Map(id -> { paths:Set, reps:Set })
    const link = (a, b, kind, h) => {
      if (a === b) return;
      const [x, y] = a < b ? [a, b] : [b, a];
      if (!share.has(x)) share.set(x, new Map());
      if (!share.has(y)) share.set(y, new Map());
      let e = share.get(x).get(y);
      if (!e) { e = { paths: new Set(), reps: new Set() }; share.get(x).set(y, e); share.get(y).set(x, e); }
      e[kind].add(h);
    };
    const hearers = new Map();
    checks.forEach(c => {
      c.paths.forEach(p => { const k = 'p|' + p; if (!hearers.has(k)) hearers.set(k, []); hearers.get(k).push(c.id); });
      c.reps.forEach(r => { const k = 'r|' + r; if (!hearers.has(k)) hearers.set(k, []); hearers.get(k).push(c.id); });
    });
    hearers.forEach((ids, k) => {
      const kind = k[0] === 'p' ? 'paths' : 'reps', h = k.slice(2);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(ids[i], ids[j], kind, h);
    });
    const neighbours = id => (share.get(id) ? [...share.get(id).keys()].map(k => ckById.get(k)).filter(Boolean) : []);
    const randomised = c => c.behaviour === 'jittered';

    // ── clashes ──
    const judged = sl => sl.outcome && sl.outcome !== 'unknown' && sl.outcome !== 'net' && !sl.spell;
    const clashes = [];
    share.forEach((m, a) => m.forEach((where, b) => {
      if (a > b) return;
      const A = ckById.get(a), B = ckById.get(b);
      if (!A || !B || randomised(A) || randomised(B)) return;
      const g = gcd(A.P, B.P);
      const cl = clearance(mod(A.at, g), A.footMs, mod(B.at, g), B.footMs, g);
      const guard = guardOf(A, B);
      if (cl >= guard) return;
      // The slots in the window when both were due together.
      const bArr = B.slots.map(sl => ({ sl, a: sl.t + B.offAt(sl.t) }));
      let together = 0, damaged = 0;
      A.slots.forEach(sa => {
        const xa = sa.t + A.offAt(sa.t);
        const i = lowerBound(bArr, xa - guard - B.footMs, o => o.a);
        for (let j = i; j < bArr.length && bArr[j].a <= xa + A.footMs + guard; j++) {
          const sb = bArr[j].sl;
          if (lineClearance(xa, A.footMs, bArr[j].a, B.footMs) >= guard) continue;
          sa.together = true; sb.together = true;
          if (!judged(sa) || !judged(sb)) continue;
          together++;
          if (sa.damaged || sb.damaged) damaged++;
        }
      });
      const c = {
        a, b, clearanceMs: Math.round(cl), guardMs: Math.round(guard), everyMs: lcm(A.P, B.P),
        together, damaged, paths: [...where.paths], reps: [...where.reps],
      };
      clashes.push(c);
      A.clashes.push(c); B.clashes.push(c);
    }));

    // Every other check in the network: the rate a clash is judged against.
    const base = { n: 0, d: 0 };
    checks.forEach(c => c.slots.forEach(sl => {
      if (!judged(sl) || sl.together) return;
      base.n++;
      if (sl.damaged) base.d++;
    }));
    const baseRate = base.n ? base.d / base.n : 0;
    const hurts = (d, n) => n >= 4 && d >= 2 && d / n >= Math.max(2 * baseRate, baseRate + 0.1);
    clashes.forEach(c => { c.rate = c.together ? c.damaged / c.together : 0; c.hurts = hurts(c.damaged, c.together); });
    clashes.sort((x, y) => (y.hurts - x.hurts) || (y.damaged - x.damaged) || (x.clearanceMs - y.clearanceMs));

    // ── the hour, folded, per channel: its busiest minute of checks ──
    paths.forEach(P => {
      const here = checks.filter(c => c.paths.includes(P.path));
      const marks = [];
      here.forEach(c => {
        const step = Math.min(c.P, HOUR);
        for (let k = 0; k * step < HOUR; k++) marks.push({ id: c.id, x: mod(c.at + k * step, HOUR) });
      });
      marks.sort((a, b) => a.x - b.x);
      // Round the end of the hour into the start of the next.
      const ext = marks.concat(marks.map(m => ({ id: m.id, x: m.x + HOUR })));
      let hot = null;
      for (let i = 0; i < marks.length; i++) {
        const ids = new Set();
        for (let j = i; j < ext.length && ext[j].x - marks[i].x <= MIN; j++) ids.add(ext[j].id);
        if (!hot || ids.size > hot.ids.size) hot = { from: marks[i].x, ids };
      }
      P.marks = here.map(c => ({ id: c.id, P: c.P, at: c.at, clash: c.clashes.length > 0 }));
      P.hot = hot && hot.ids.size >= 3 ? { from: hot.from, to: hot.from + MIN, stations: [...hot.ids] } : null;
    });

    // ── where to move a check ──
    const planned = new Map();          // id -> at, after the moves planned so far
    const atOf = c => (planned.has(c.id) ? planned.get(c.id) : c.at);
    const damagedShare = c => {
      let n = 0, d = 0;
      c.slots.forEach(sl => { if (judged(sl)) { n++; if (sl.damaged) d++; } });
      return n ? d / n : 0;
    };
    const movable = c => c.behaviour === 'steady' || c.behaviour === 'loose' || c.behaviour === 'jumped';
    const clashesNow = (c, others) => others.some(o => {
      const g = gcd(c.P, o.P);
      return clearance(mod(atOf(c), g), c.footMs, mod(atOf(o), g), o.footMs, g) < guardOf(c, o);
    });
    // The quietest of near-equal gaps: what lands at the channels that hear
    // it, in the folded hour, at a candidate time.
    const loadAt = (c, x) => {
      let s = 0;
      c.paths.forEach(p => {
        const P = paths.find(q => q.path === p);
        if (!P) return;
        const step = Math.min(c.P, HOUR);
        for (let k = 0; k * step < HOUR; k++) s += P.fold.n[Math.floor(mod(x + k * step, HOUR) / FOLD_BIN)];
      });
      return s;
    };
    function bestSlot(c) {
      // Every other check that shares a hearer, projected onto c's circle as
      // a stretch c's start must keep out of.
      const zones = [];
      neighbours(c.id).forEach(o => {
        if (randomised(o)) return;
        const g = gcd(c.P, o.P);
        const guard = guardOf(c, o);
        const x = mod(atOf(o), g);
        for (let k = 0; k * g < c.P; k++) {
          const s = x + k * g;
          zones.push([s - guard - c.footMs, s + o.footMs + guard]);
        }
      });
      const P = c.P;
      if (!zones.length) return { at: mod(Math.round(c.at / STEP_MS) * STEP_MS, P), clearMs: P / 2, free: true };
      // Onto [0, P), split where they wrap, merged.
      const segs = [];
      zones.forEach(([a, b]) => {
        if (b - a >= P) { segs.push([0, P]); return; }
        const x = mod(a, P), y = x + (b - a);
        if (y <= P) segs.push([x, y]); else { segs.push([x, P]); segs.push([0, y - P]); }
      });
      segs.sort((u, v) => u[0] - v[0]);
      const merged = [];
      segs.forEach(s => {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push(s.slice());
      });
      // The gaps between, the last wrapping round to the first.
      const gaps = [];
      for (let i = 0; i < merged.length; i++) {
        const a = merged[i][1], b = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + P;
        if (b > a) gaps.push([a, b]);
      }
      if (!gaps.length) return null;
      const shiftOf = x => mod(x - c.at + P / 2, P) - P / 2;
      // Room enough: the half-minute nearest where it is now that clears
      // everything by ROOM_MS (an eighth of a short period), the quieter of
      // two equally near.
      const room = Math.min(ROOM_MS, P / 8);
      const near = [];
      gaps.forEach(g => {
        const a = Math.ceil((g[0] + room) / STEP_MS) * STEP_MS, b = g[1] - room;
        if (a > b) return;
        // The nearest grid point to c.at inside [a, b], on the circle.
        const want = c.at + Math.round((a - c.at) / P) * P;
        [a, b, Math.round(want / STEP_MS) * STEP_MS].forEach(x0 => {
          const x = Math.min(Math.max(x0, a), Math.floor(b / STEP_MS) * STEP_MS);
          if (x < a || x > b) return;
          near.push({ at: mod(x, P), clearMs: Math.min(x - g[0], g[1] - x), load: loadAt(c, x), shift: shiftOf(x) });
        });
      });
      if (near.length) {
        near.sort((u, v) => (Math.abs(u.shift) - Math.abs(v.shift)) || (u.load - v.load));
        return near[0];
      }
      // No room that wide anywhere: the middle of the widest gap there is.
      const widest = gaps.reduce((w, g) => (g[1] - g[0] > w[1] - w[0] ? g : w));
      const mid = (widest[0] + widest[1]) / 2;
      let x = Math.round(mid / STEP_MS) * STEP_MS;
      if (x < widest[0] || x > widest[1]) x = mid;
      return { at: mod(x, P), clearMs: Math.min(x - widest[0], widest[1] - x), load: loadAt(c, x), shift: shiftOf(x) };
    }

    const moves = [];
    const stays = [];
    const seen = new Set();
    // Groups of stations that clash, biggest first.
    const groups = [];
    checks.forEach(c => {
      if (seen.has(c.id) || !c.clashes.length) return;
      const g = [];
      const q = [c];
      seen.add(c.id);
      while (q.length) {
        const x = q.shift();
        g.push(x);
        x.clashes.forEach(cl => {
          const o = ckById.get(cl.a === x.id ? cl.b : cl.a);
          if (o && !seen.has(o.id)) { seen.add(o.id); q.push(o); }
        });
      }
      groups.push(g);
    });
    groups.sort((a, b) => b.length - a.length);
    groups.forEach(g => {
      // Stays first: what cannot usefully be moved, then what is doing best.
      const order = g.slice().sort((a, b) => (movable(a) - movable(b))
        || (damagedShare(a) - damagedShare(b)) || ((a.spreadMs || 0) - (b.spreadMs || 0)) || (b.n - a.n) || (a.id < b.id ? -1 : 1));
      const kept = [];
      order.forEach(c => {
        const against = kept.filter(o => clashesNow(c, [o]));
        if (!against.length) { kept.push(c); return; }
        if (!movable(c)) { kept.push(c); stays.push({ c, against }); return; }
        const slot = bestSlot(c);
        if (!slot) { kept.push(c); stays.push({ c, against }); return; }
        planned.set(c.id, slot.at);
        kept.push(c);
        moves.push({ c, slot, against });
      });
    });

    // ── suggestions ──
    const suggestions = [];
    const whereText = cl => {
      const bits = [];
      if (cl.paths.length) bits.push(`at ${cl.paths.map(pathLabel).join(', ')}`);
      if (cl.reps.length) bits.push(`within reach of ${cl.reps.map(r => (I.repeaterNames && I.repeaterNames.get(r)) || r).join(', ')}`);
      return bits.join(' and ');
    };
    moves.forEach(({ c, slot, against }) => {
      const ids = new Set(against.map(o => o.id));
      const mine = c.clashes.filter(cl => ids.has(cl.a === c.id ? cl.b : cl.a));
      const others = mine.map(cl => ckById.get(cl.a === c.id ? cl.b : cl.a));
      const together = mine.reduce((n, cl) => n + cl.together, 0);
      const damaged = mine.reduce((n, cl) => n + cl.damaged, 0);
      const hurt = mine.some(cl => cl.hurts);
      const worst = mine[0];
      const shift = slot.shift;
      const fromClock = c.clock, toClock = clockOf(slot.at, c.P, now);
      suggestions.push({
        kind: 'move-check', severity: hurt ? 'warn' : 'info', key: 'move:' + c.id, stationId: c.id, station: c.name,
        others: others.map(o => o.id),
        title: `Move ${c.name}'s check ${fmtDur(shift)} ${shift >= 0 ? 'later' : 'earlier'}`,
        detail: `Its check (${fromClock}) falls together with ${others.map(o => `${o.name}'s (${o.clock})`).join(', ')} ${worst ? whereText(worst) : ''}`
          + ` — every ${fmtPeriod(Math.min(...mine.map(cl => cl.everyMs)))}.`
          + (together ? ` They were due together ${plural(together, 'time')} in the window, and one of them lost a frame, missed or came with a corrupted copy ${plural(damaged, 'time')} (${pct(damaged, together)}%, against ${Math.round(100 * baseRate)}% of every other check).` : '')
          + ` Moved to ${toClock}, it clears every check heard where it is heard by ${fmtDur(slot.clearMs)}${slot.clearMs < CLEAR_MS ? ' — the widest gap there is, and still close' : ''}.`,
        how: howToMove(c),
        evidence: { together, damaged, rate: together ? round(damaged / together, 2) : null, baseline: round(baseRate, 3),
          fromMs: Math.round(c.at), toMs: Math.round(slot.at), shiftMs: Math.round(shift), clearMs: Math.round(slot.clearMs), periodMs: c.P,
          behaviour: c.behaviour },
      });
    });
    // Drifting checks: when each next lands on another station's.
    checks.forEach(c => {
      if (c.behaviour !== 'drifting' || !c.driftSPerDay) return;
      const v = c.driftSPerDay * SEC / DAY;    // ms per ms
      let soon = null;
      neighbours(c.id).forEach(o => {
        if (randomised(o)) return;
        const g = gcd(c.P, o.P), guard = guardOf(c, o);
        const xc = mod(c.at, g), xo = mod(o.at, g);
        const cl = clearance(xc, c.footMs, xo, o.footMs, g);
        if (cl < guard) {
          // On it now: how long until it has walked clear past.
          const left = v > 0 ? mod(xo + o.footMs + guard - xc, g) : mod(xc + c.footMs + guard - xo, g);
          const t = left / Math.abs(v);
          if (!soon || soon.now !== true || t < soon.t) soon = { o, t, now: true };
          return;
        }
        if (soon && soon.now) return;
        const d = v > 0 ? mod(xo - (xc + c.footMs), g) - guard : mod(xc - (xo + o.footMs), g) - guard;
        const t = d / Math.abs(v);
        if (d > 0 && t <= HORIZON_MS && (!soon || t < soon.t)) soon = { o, t, now: false };
      });
      // A clock walking with nothing in its way for a fortnight is Station
      // Health's clock-drift note, not a matter of airtime.
      if (!soon) return;
      suggestions.push({
        kind: 'clock-drift', severity: soon.now || soon.t <= 3 * DAY ? 'warn' : 'info', key: 'drift:' + c.id, stationId: c.id, station: c.name,
        others: [soon.o.id],
        title: `${c.name}'s checks are walking ${round(Math.abs(c.driftSPerDay), 1)} s a day`,
        detail: soon.now
          ? `It is on ${soon.o.name}'s check (${soon.o.clock}) now, and will walk clear in about ${fmtDays(soon.t)} — into whatever is next.`
          : `In about ${fmtDays(soon.t)} it reaches ${soon.o.name}'s check (${soon.o.clock}), heard at the same receivers or repeater.`,
        how: howToMove(c),
        evidence: { driftSPerDay: c.driftSPerDay, withId: soon.o.id, inMs: Math.round(soon.t), now: soon.now },
      });
    });
    // Stations that clash and cannot be moved usefully, said once each.
    stays.forEach(({ c, against }) => {
      if (c.behaviour === 'drifting') return;     // said above
      const others = against;
      suggestions.push({
        kind: 'cannot-move', severity: 'info', key: 'stay:' + c.id, stationId: c.id, station: c.name, others: others.map(o => o.id),
        title: `${c.name}'s check shares its moment, with nowhere clear to go`,
        detail: `Its check (${c.clock}) falls together with ${others.map(o => o.name).join(', ')}, and ${movable(c) ? 'no gap in its period at its receivers and repeaters is clear of every other check' : 'how its logger keeps time could not be read from the window'}.`,
        how: movable(c) ? 'Space the checks at its receivers further apart, or move one of the others first.' : howToMove(c),
        evidence: { behaviour: c.behaviour },
      });
    });

    // ── repeater pairs whose shared stations carry the corrupted copies ──
    const srcDmg = new Map();
    txs.forEach(tx => {
      if (tx.ghost) return;
      let s = srcDmg.get(tx.src);
      if (!s) srcDmg.set(tx.src, s = { n: 0, d: 0 });
      s.n++;
      if (tx.damaged) s.d++;
    });
    const netRate = rate({ n: tog.n + alone.n, d: tog.d + alone.d });
    const reps = (I.repeaters || []).filter(R => R && R.members && R.members.length);
    const repPairs = [];
    for (let i = 0; i < reps.length; i++) {
      for (let j = i + 1; j < reps.length; j++) {
        const R1 = reps[i], R2 = reps[j];
        if (R1.txMhz != null && R2.txMhz != null && Math.abs(R1.txMhz - R2.txMhz) > 0.0005) continue;
        const d1 = R1.delayMs, d2 = R2.delayMs;
        const sameDelay = (d1 == null && d2 == null) || (d1 != null && d2 != null && Math.abs(d1 - d2) < REP_SEP_MS);
        if (!sameDelay) continue;
        const m2 = new Set(R2.members);
        const shared = R1.members.filter(id => m2.has(id));
        if (shared.length < 2) continue;
        let n = 0, d = 0;
        shared.forEach(id => { const s = srcDmg.get(id); if (s) { n += s.n; d += s.d; } });
        if (d < 5 || n < ENOUGH_TX || d / n < Math.max(0.03, 2 * netRate)) continue;
        repPairs.push({ R1, R2, shared, n, d });
      }
    }
    repPairs.sort((a, b) => (b.d - a.d) || (b.shared.length - a.shared.length));
    // Each repeater in one pair at most: a repeater that relays with bit
    // errors on its own would otherwise head every pair it is in.
    const inPair = new Set();
    const picked = repPairs.filter(p => {
      if (inPair.has(p.R1.id) || inPair.has(p.R2.id)) return false;
      inPair.add(p.R1.id); inPair.add(p.R2.id);
      return true;
    }).slice(0, 6);
    picked.forEach(({ R1, R2, shared, n, d }) => {
      const s1 = R1.suggestedMs, s2 = R2.suggestedMs;
      const offer = s1 != null && s2 != null && Math.abs(s1 - s2) >= REP_SEP_MS
        ? `The Backbone suggests ${R1.name} ${s1} ms and ${R2.name} ${s2} ms.`
        : `The Backbone does not put them within the Max TX distance of each other, so it has no pair of values for them; any two at least ${REP_SEP_MS} ms apart do it.`;
      const set = R1.delayMs == null && R2.delayMs == null ? 'Neither has a delay on file' : `Both hold ${R1.delayMs} ms`;
      suggestions.push({
        kind: 'stagger-repeaters', severity: R1.delayMs != null ? 'warn' : 'info', key: `reps:${R1.id}|${R2.id}`,
        repeaterIds: [R1.id, R2.id], repeaterNames: [R1.name, R2.name], station: `${R1.name} & ${R2.name}`,
        title: `Stagger ${R1.name} and ${R2.name}`,
        detail: `Both pass ${plural(shared.length, 'station')} heard in the window, and ${plural(d, 'transmission')} of those stations' ${n.toLocaleString()} came with a corrupted copy or a ghost (${pct(d, n)}%, against ${Math.round(100 * netRate)}% across the network). ${set}, so a frame both accept is re-sent by both in the same instant, and collides wherever both are heard. ${offer} If either is already named under Repeaters as relaying with bit errors, that is the likelier cause — start there.`,
        how: 'Record the delay on each repeater\'s station (Stations tab → the repeater → Delay) and set the same in its hardware. Delays are under a second, too fine for the readings\' times to measure — this pair is picked by where the corrupted copies are, and the readings afterwards say whether they fell.',
        evidence: { shared: shared.length, transmissions: n, damaged: d, rate: round(d / n, 3), networkRate: round(netRate, 3),
          delays: [R1.delayMs, R2.delayMs], suggested: [s1, s2] },
      });
    });
    const sevRank = { warn: 0, info: 1 };
    const kindRank = { 'move-check': 0, 'stagger-repeaters': 1, 'clock-drift': 2, 'cannot-move': 3 };
    suggestions.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (kindRank[a.kind] - kindRank[b.kind])
      || (((b.evidence && b.evidence.damaged) || 0) - ((a.evidence && a.evidence.damaged) || 0)));

    // Who lands together again and again: every two stations in a pile-up,
    // counted once a moment however many channels heard it (the copies of a
    // moment at a second channel land within COPY seconds), with the minute
    // past the hour it usually happens — a check, or a check meeting events.
    const COPY = 12000;
    const pairMap = new Map();
    piles.slice().sort((a, b) => a.t - b.t).forEach(p => {
      const s = p.srcs.slice(0, 8).sort();
      for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
          const k = s[i] + '|' + s[j];
          let e = pairMap.get(k);
          if (!e) pairMap.set(k, e = { a: s[i], b: s[j], n: 0, damaged: 0, first: p.t, last: -Infinity, gaps: [], bins: new Map(), paths: new Set() });
          e.paths.add(p.path);
          if (p.t - e.last <= COPY) { if (p.damaged && !e.lastDamaged) { e.damaged++; e.lastDamaged = true; } continue; }
          e.n++; e.last = p.t; e.lastDamaged = p.damaged;
          if (p.damaged) e.damaged++;
          e.gaps.push(p.minGap);
          const b = Math.floor(mod(p.t, HOUR) / FOLD_BIN);
          e.bins.set(b, (e.bins.get(b) || 0) + 1);
        }
      }
    });
    const pairs = [...pairMap.values()].filter(e => e.n >= 2).map(e => {
      let bestB = 0, bestN = -1;
      e.bins.forEach((n, b) => { if (n > bestN) { bestN = n; bestB = b; } });
      return { a: e.a, b: e.b, names: [nameOf(e.a), nameOf(e.b)], n: e.n, damaged: e.damaged, first: e.first, last: e.last,
        usualMs: bestB * FOLD_BIN, usualShare: e.n ? bestN / e.n : 0, gapMs: median(e.gaps), paths: [...e.paths] };
    }).sort((x, y) => (y.n - x.n) || (y.damaged - x.damaged) || (y.last - x.last)).slice(0, 25);
    // …and the moments three stations or more landed at once.
    const moments = piles.filter(p => p.srcs.length >= 3).sort((a, b) => (b.srcs.length - a.srcs.length) || (b.damaged - a.damaged) || (b.t - a.t))
      .slice(0, 25).map(p => Object.assign({}, p, { names: p.srcs.map(nameOf) }));

    const repSet = (I.repeaters || []).filter(R => R);
    return {
      t0, t1, now, days,
      paths, damage, pairs, moments,
      checks: checks.map(c => {
        const o = Object.assign({}, c);
        delete o.offAt; delete o.slots;
        o.clashWith = c.clashes.map(cl => (cl.a === c.id ? cl.b : cl.a));
        delete o.clashes;
        return o;
      }).sort((a, b) => (b.clashWith.length > 0) - (a.clashWith.length > 0) || String(a.name).localeCompare(String(b.name))),
      clashes, suggestions,
      baseline: { n: base.n, d: base.d, rate: round(baseRate, 3) },
      counts: {
        transmissions: tog.n + alone.n, together: tog.n, piles: piles.length, sameBurst: piles.filter(p => p.sameBurst).length,
        checks: checks.length, clashes: clashes.length, hurting: clashes.filter(c => c.hurts).length,
        moves: moves.length, repeaters: repSet.length, repeatersWithDelay: repSet.filter(R => R.delayMs != null).length,
      },
      nameOf,
    };
  }

  // ── from Station Health's result ────────────────────────────────────────────

  // A: HealthAnalysis.run()'s result (with .txs). opts:
  //   suggestDelay(station) → ms or null — the Backbone's suggested delay
  //                           (map-backbone.js suggestedRepeaterDelayMs)
  function fromHealth(A, opts) {
    const o = opts || {};
    if (!A || !A.stations) return analyse({});
    const sidOf = new Map();
    A.stations.forEach((S, id) => S.txs.forEach(tx => sidOf.set(tx, id)));
    const checkTx = new Set();
    A.stations.forEach(S => (S.slots || []).forEach(sl => { if (sl.burst) sl.burst.txs.forEach(tx => checkTx.add(tx)); }));

    // An address no station carries, riding with one station's frames, is
    // that station's (a sensor the register does not list): crowding it with
    // itself would be counted as crowding.
    const resolved = [];
    A.stations.forEach((S, id) => S.txs.forEach(tx => resolved.push({ t: tx.t, id })));
    resolved.sort((a, b) => a.t - b.t);
    const unfiled = new Map();
    (A.txs || []).forEach(tx => {
      if (sidOf.has(tx) || tx.ghostOf) return;
      if (!unfiled.has(tx.addr)) unfiled.set(tx.addr, []);
      unfiled.get(tx.addr).push(tx);
    });
    const alias = new Map();
    unfiled.forEach((list, addr) => {
      if (list.length < RIDE_MIN) return;
      const cnt = new Map();
      list.forEach(tx => {
        const near = new Set();
        for (let j = lowerBound(resolved, tx.t - RIDE_MS, x => x.t); j < resolved.length && resolved[j].t <= tx.t + RIDE_MS; j++) near.add(resolved[j].id);
        near.forEach(id => cnt.set(id, (cnt.get(id) || 0) + 1));
      });
      let best = null, bestN = 0;
      cnt.forEach((n, id) => { if (n > bestN) { bestN = n; best = id; } });
      if (best && bestN >= RIDE_FRAC * list.length) alias.set(addr, best);
    });
    const srcOf = tx => {
      if (tx.ghostOf && tx.ghostOf.of) {
        const tw = tx.ghostOf.of;
        return sidOf.get(tw) || alias.get(tw.addr) || tw.addr;
      }
      return sidOf.get(tx) || alias.get(tx.addr) || tx.addr;
    };
    const txs = (A.txs || []).map(tx => ({
      t: tx.t, src: srcOf(tx), ghost: !!tx.ghostOf, check: checkTx.has(tx),
      damaged: !tx.ghostOf && ((tx.bad && tx.bad.length > 0) || (tx.ghosts || 0) > 0),
      arr: (tx.copies || []).map(c => ({ path: c.path || c.host, t: c.t, bad: !!tx.ghostOf || c.v !== tx.v })),
    }));

    const repsOf = new Map();
    const repNames = new Map();
    (A.repeaters || []).forEach(R => {
      repNames.set(R.id, R.name);
      const rs = R.rep && R.rep.st;
      R.members.forEach(S => {
        if (placed(rs) && placed(S.st) && km(rs, S.st) > REP_HEAR_KM) return;
        if (!repsOf.has(S.st.id)) repsOf.set(S.st.id, []);
        repsOf.get(S.st.id).push(R.id);
      });
    });
    const stations = [];
    A.stations.forEach((S, id) => {
      const sch = S.schedule;
      const base = { id, name: S.st.name, lat: S.st.lat, lon: S.st.lon, paths: S.paths || [], reps: repsOf.get(id) || [] };
      if (!sch) { stations.push(base); return; }
      const slots = S.slots || [];
      const resid = slots.filter(sl => sl.burst).map(sl => ({ t: sl.t, d: sl.burst.t - sl.t }));
      const feet = slots.filter(sl => sl.burst && sl.burst.txs.length > 1).map(sl => sl.burst.txs[sl.burst.txs.length - 1].t - sl.burst.t);
      stations.push(Object.assign(base, {
        P: sch.P, phase: sch.phase, resid, footMs: feet.length ? median(feet) : 0,
        slots: slots.map(sl => ({
          t: sl.t, outcome: sl.outcome, spell: !!sl.spell,
          damaged: sl.outcome === 'partial' || sl.outcome === 'miss'
            || !!(sl.burst && sl.burst.txs.some(tx => (tx.bad && tx.bad.length) || tx.ghosts)),
        })),
      }));
    });
    const names = new Map();
    unfiled.forEach((list, addr) => { if (!alias.has(addr)) names.set(addr, `address ${String(addr).replace(/^a:/, '')} (not on file)`); });
    const repeaters = (A.repeaters || []).map(R => {
      const st = R.rep && R.rep.st;
      const r = (st && st.repeater) || {};
      let sug = null;
      try { sug = o.suggestDelay && st ? o.suggestDelay(st) : null; } catch (_) { sug = null; }
      return {
        id: R.id, name: R.name, delayMs: r.delay_ms != null ? Number(r.delay_ms) : null,
        txMhz: r.tx_mhz != null && isFinite(Number(r.tx_mhz)) ? Number(r.tx_mhz) : null,
        suggestedMs: sug, members: R.members.map(S => S.st.id),
      };
    });
    return analyse({ t0: A.t0, t1: A.t1, now: A.now, txs, stations, repeaters, names, repeaterNames: repNames });
  }

  return {
    analyse, fromHealth,
    // The arithmetic, for test/airtime.mjs.
    _timing: timing, _clearance: clearance, _gcd: gcd, _clockOf: clockOf,
    BEHAVIOUR, TOGETHER_MS, SAME_BURST_MS, FOLD_BIN, STEP_MS, fmtDur, fmtPeriod, pathLabel,
  };
})();

if (typeof window !== 'undefined') window.AirtimeAnalysis = AirtimeAnalysis;
if (typeof module !== 'undefined' && module.exports) module.exports = AirtimeAnalysis;
