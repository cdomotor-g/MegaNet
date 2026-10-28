// MegaNet — delay-plan.js
//
//   DelayPlan   what each repeater's delay should be, worked out from the
//               station register: which repeaters would relay the same
//               reading, when each copy goes out, where two copies land on
//               top of each other, and the delays that keep them apart.
//               Pure — no DOM, no state — so the 🕰️ Repeater Delays tab
//               (repeater-delays.js), the suggestion on a repeater's card
//               (map-backbone.js) and test/delays.mjs all run the same plan.
//
//   DelayPlan.plan(stations, opts)   the plan, from a stations.json list
//   DelayPlan.DEFAULTS               the settings it starts from
//   DelayPlan.band(sepMs, opts)      'ontop' | 'close' | 'clear'
//   DelayPlan.cost(sepMs, opts)      what a separation costs, 0 when clear
//
// ── Why repeaters collide ────────────────────────────────────────────────────
// A repeater stores what it decodes and sends it on after its delay. Two
// repeaters whose pass ranges both take an address, and which both hear the
// station sending it, send their copies at the same moment if their delays are
// the same — and every receiver that hears both gets two copies of one frame
// on top of each other. Bit on bit, the copies beat against each other and a
// few bits flip: the frame still passes its fixed bits and is filed under the
// wrong address, a ghost (bit-errors.js, "Collisions"). A little apart, the
// later repeater keys up during the earlier one's frame: the earlier copy is
// spoilt wherever the two arrive at about the same strength. Far enough apart,
// both copies arrive clean.
//
// ── How far apart is far enough ──────────────────────────────────────────────
// A keying is a lead-in — the transmitter coming up and the preamble the
// receivers lock on to — then the 133 ms frame (40 bits at 300 baud). The
// later repeater's carrier must not start before the earlier frame has ended,
// so two copies are clear of each other when their starts are a lead-in and a
// frame apart. The lead-in is the one figure nobody has timed on these
// repeaters: 300 ms is the app's own (propagation-physics.js LEAD_MS,
// airtime-analysis.js AIR_MS), so 433 ms clears. Three bands, and the cost the
// search below minimises:
//
//   on top   less than a frame apart: the frames overlap, and the flips that
//            make ghosts happen here. Costs 1–2, worst at the same delay.
//   close    a frame apart or more but inside the lead-in: the later key-up
//            spoils the earlier frame where both are heard about equally.
//            Costs 0.25–0.75, less the further apart.
//   clear    a lead-in and a frame apart or more. Costs nothing.
//
// ── Who hears what ───────────────────────────────────────────────────────────
// The register holds no coverage, so hearing is a distance: a repeater hears a
// field station up to fieldKm away (80 km: nine in ten stations' nearest
// carrier is within 70 km in the register) and a repeater, base or repeater
// site's own gauge up to linkKm (100 km, the Stations map's Max TX distance).
// Channels must agree — a repeater hears only on its RX, a copy is heard only
// on its TX — and an unrecorded channel is taken to agree with any, which errs
// towards a collision rather than away from one.
//
// For every address a station sends, the copies are walked hop by hop: the
// repeaters that pass it and hear the station send at (lead-in + frame +
// their delay); a repeater that passes it and hears only one of those sends
// its copy a lead-in, a frame and its own delay after the first copy it hears
// (one copy each — a repeater does not relay a reading twice). Two copies on
// one channel collide where a receiver that wants the reading — a base, or a
// repeater that passes the address — hears both. A collision with no such
// receiver costs nothing, however close the delays.
//
// ── The search ───────────────────────────────────────────────────────────────
// Delays are whole steps of gridMs (50 ms, easy to set and to read back) from
// 0 to maxMs (999: the register's own limit, 0015_repeater_delay.sql). Every
// repeater starts on the delay it has now — recorded, or the one value they
// are all thought to share — and then, busiest first, each moves to whichever
// step costs least given the rest, over and over until nothing improves; then
// the same from a few shuffled orders, keeping the best. Deterministic: the
// same register and settings always give the same plan. A delay recorded on
// a repeater's station is kept as it is unless keepRecorded is off, and among
// steps that cost the same the one it has now wins, so the plan asks for as
// few site visits as it can.

const DelayPlan = (function () {
  const DEFAULTS = {
    fieldKm: 80,        // a repeater hears a field station this far away
    linkKm: 100,        // a repeater or base hears a repeater (or a repeater site's gauge) this far away
    leadMs: 300,        // key-up and preamble before the frame
    frameMs: 133,       // 40 bits at 300 baud
    gridMs: 50,         // delays are whole steps of this
    maxMs: 999,         // the longest delay the repeaters (and the register) take
    maxHops: 4,         // a reading is followed this many repeaters from its station
    currentMs: null,    // the one delay every repeater is thought to be on now, if known
    keepRecorded: true, // a delay recorded on a station is kept as it is
  };
  const EPS = 1e-9;
  const CHANGE_COST = 1e-3;   // a tie goes to the delay a repeater has now
  const ANNEAL_PER_REPEATER = 2500;   // tries per repeater in a group

  // ── Settings and the cost of a separation ──────────────────────────────────

  function settings(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const num = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' && v != null ? Math.min(hi, Math.max(lo, +v)) : d);
    o.fieldKm = num(o.fieldKm, 1, 400, DEFAULTS.fieldKm);
    o.linkKm = num(o.linkKm, 1, 400, DEFAULTS.linkKm);
    o.leadMs = num(o.leadMs, 0, 2000, DEFAULTS.leadMs);
    o.frameMs = num(o.frameMs, 1, 2000, DEFAULTS.frameMs);
    o.gridMs = Math.round(num(o.gridMs, 1, 1000, DEFAULTS.gridMs));
    o.maxMs = Math.round(num(o.maxMs, 0, 60000, DEFAULTS.maxMs));
    o.maxHops = Math.round(num(o.maxHops, 1, 8, DEFAULTS.maxHops));
    o.currentMs = o.currentMs === '' || o.currentMs == null || !Number.isFinite(+o.currentMs)
      ? null : Math.max(0, Math.round(+o.currentMs));
    o.keepRecorded = o.keepRecorded !== false;
    o.clearMs = o.leadMs + o.frameMs;
    return o;
  }

  function band(sepMs, opts) {
    const o = opts && opts.clearMs != null ? opts : settings(opts);
    if (sepMs < o.frameMs) return 'ontop';
    if (sepMs < o.clearMs) return 'close';
    return 'clear';
  }

  function cost(sepMs, opts) {
    const o = opts && opts.clearMs != null ? opts : settings(opts);
    const s = Math.abs(sepMs);
    if (s < o.frameMs) return 1 + (o.frameMs - s) / o.frameMs;
    if (s < o.clearMs) return 0.25 + 0.5 * (o.clearMs - s) / Math.max(1, o.clearMs - o.frameMs);
    return 0;
  }

  // ── The register, read the way the plan needs it ───────────────────────────

  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  const located = s => s && Number.isFinite(s.lat) && Number.isFinite(s.lon);
  const has = (s, role) => Array.isArray(s.roles) && s.roles.includes(role);
  const mhz = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  // Two channels agree when either is unrecorded or they are the same.
  const agree = (a, b) => a == null || b == null || Math.abs(a - b) < 0.0005;
  const agreeAny = (a, list) => !list.length || list.some(b => agree(a, b));

  // Every ALERT address a station sends — its sensors, or the older alert_ids
  // object where it has none (core.js stationSensors, restated so this file
  // stands alone).
  function addresses(s) {
    const ids = new Set();
    if (Array.isArray(s.sensors) && s.sensors.length) {
      for (const se of s.sensors) if (se && Number.isInteger(se.alert_id)) ids.add(se.alert_id);
    } else {
      for (const v of Object.values(s.alert_ids || {})) {
        for (const id of (Array.isArray(v) ? v : [v])) if (Number.isInteger(id)) ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  // A repeater's open windows: pass ranges less exclusions, an inverted range
  // being the empty one it is (map-backbone.js repeaterOpenWindows).
  function windows(rep) {
    if (!rep || !Array.isArray(rep.pass_ranges)) return [];
    let spans = rep.pass_ranges.filter(r => r && r.high >= r.low).map(r => [r.low, r.high]);
    for (const e of (rep.exclusions || [])) {
      if (!e || e.high < e.low) continue;
      const next = [];
      for (const [lo, hi] of spans) {
        if (e.high < lo || e.low > hi) { next.push([lo, hi]); continue; }
        if (lo < e.low) next.push([lo, e.low - 1]);
        if (hi > e.high) next.push([e.high + 1, hi]);
      }
      spans = next;
    }
    return spans;
  }

  function baseChannels(s) {
    const out = [];
    if (s.repeater && mhz(s.repeater.rx_mhz) != null) out.push(mhz(s.repeater.rx_mhz));
    for (const f of (Array.isArray(s.frequencies) ? s.frequencies : [])) {
      if (f && mhz(f.rx_mhz) != null && !out.some(x => agree(x, mhz(f.rx_mhz)))) out.push(mhz(f.rx_mhz));
    }
    return out;
  }

  // Deterministic shuffles for the restarts (mulberry32).
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── The plan ───────────────────────────────────────────────────────────────

  function plan(stations, opts) {
    const o = settings(opts);
    const list = Array.isArray(stations) ? stations : [];
    const live = s => s && s.enabled !== false && !s.proposed;

    // Repeaters, numbered. A repeater with no position or no open window can
    // relay nothing the plan can place; it is listed, and left out of the search.
    const reps = list.filter(s => live(s) && has(s, 'repeater') && s.repeater);
    const rIndex = new Map(reps.map((r, i) => [r.id, i]));
    const R = reps.map(r => ({
      st: r, id: r.id, name: r.name || r.id,
      rx: mhz(r.repeater.rx_mhz), tx: mhz(r.repeater.tx_mhz),
      win: windows(r.repeater),
      recorded: Number.isFinite(r.repeater.delay_ms) ? r.repeater.delay_ms : null,
      ok: located(r),
    }));

    const bases = list.filter(s => live(s) && has(s, 'base') && located(s));

    // address → repeaters whose windows take it, for every address a station sends.
    const sources = list.filter(s => live(s) && located(s));
    const addrReps = new Map();
    const covering = a => {
      let v = addrReps.get(a);
      if (v) return v;
      v = [];
      for (let i = 0; i < R.length; i++) {
        if (!R[i].ok) continue;
        if (R[i].win.some(([lo, hi]) => a >= lo && a <= hi)) v.push(i);
      }
      addrReps.set(a, v);
      return v;
    };

    const dRR = new Map();
    const repKm = (i, j) => {
      const k = i < j ? i * 4096 + j : j * 4096 + i;
      let v = dRR.get(k);
      if (v == null) { v = km(R[i].st, R[j].st); dRR.set(k, v); }
      return v;
    };
    const baseKm = new Map();
    const repBaseKm = (i, b) => {
      const k = i + '|' + b.id;
      let v = baseKm.get(k);
      if (v == null) { v = km(R[i].st, b); baseKm.set(k, v); }
      return v;
    };

    // ── Scenarios: one reading, every copy of it, and where copies meet ──────
    const scen = new Map();   // signature → scenario
    for (const s of sources) {
      const ids = addresses(s);
      if (!ids.length) continue;
      const elevated = has(s, 'repeater') || has(s, 'base');
      const reach = elevated ? o.linkKm : o.fieldKm;
      const selfIdx = rIndex.has(s.id) ? rIndex.get(s.id) : -1;
      for (const a of ids) {
        const cand = covering(a).filter(i => i !== selfIdx);
        if (cand.length < 2) continue;
        const hop1 = cand.filter(i => km(s, R[i].st) <= reach);
        if (!hop1.length) continue;
        // The station sends on one channel. Its repeaters' receive channels
        // say which it could be; each is followed on its own.
        const chans = [];
        for (const i of hop1) if (R[i].rx != null && !chans.some(c => agree(c, R[i].rx))) chans.push(R[i].rx);
        if (!chans.length) chans.push(null);
        for (const ch of chans) {
          const first = hop1.filter(i => agree(R[i].rx, ch));
          const hop = new Map(first.map(i => [i, { hop: 1, from: [-1] }]));
          let layer = first;
          for (let h = 2; h <= o.maxHops && layer.length; h++) {
            const next = [];
            for (const i of cand) {
              if (hop.has(i)) continue;
              const from = [];
              for (const [p, info] of hop) {
                if (info.hop < h && repKm(p, i) <= o.linkKm && agree(R[p].tx, R[i].rx)) from.push(p);
              }
              if (from.length) next.push([i, from]);
            }
            for (const [i, from] of next) hop.set(i, { hop: h, from: from.sort((x, y) => x - y) });
            layer = next.map(n => n[0]);
          }
          if (hop.size < 2) continue;
          const relays = [...hop.keys()].sort((x, y) => hop.get(x).hop - hop.get(y).hop || x - y);
          const pairs = [];
          for (let x = 0; x < relays.length; x++) {
            for (let y = x + 1; y < relays.length; y++) {
              const i = relays[x], j = relays[y];
              if (!agree(R[i].tx, R[j].tx)) continue;
              const tx = R[i].tx != null ? R[i].tx : R[j].tx;
              const where = [];
              for (const b of bases) {
                if (b.id === R[i].id || b.id === R[j].id) continue;
                if (!agreeAny(tx, baseChannels(b))) continue;
                if (repBaseKm(i, b) <= o.linkKm && repBaseKm(j, b) <= o.linkKm) where.push(b.id);
              }
              for (const c of cand) {
                if (c === i || c === j || where.includes(R[c].id)) continue;
                if (!agree(tx, R[c].rx)) continue;
                if (repKm(i, c) <= o.linkKm && repKm(j, c) <= o.linkKm) where.push(R[c].id);
              }
              if (where.length) pairs.push([i, j, where]);
            }
          }
          if (!pairs.length) continue;
          const order = relays.map(i => [i, hop.get(i).hop, hop.get(i).from]);
          const sig = order.map(([i, h, f]) => i + ':' + h + ':' + f.join(',')).join(';')
            + '|' + pairs.map(p => p[0] + '-' + p[1]).join(';');
          let sc = scen.get(sig);
          if (!sc) {
            sc = { order, pairs, weight: 0, sources: [] };
            scen.set(sig, sc);
          }
          sc.weight++;
          if (sc.sources.length < 12) sc.sources.push({ id: s.id, name: s.name || s.id, address: a });
        }
      }
    }
    const scenarios = [...scen.values()];

    // Which scenarios each repeater is in — what changes when its delay does.
    const byRep = R.map(() => []);
    scenarios.forEach((sc, k) => { for (const [i] of sc.order) byRep[i].push(k); });
    const linked = R.map((r, i) => byRep[i].some(k => scenarios[k].pairs.some(p => p[0] === i || p[1] === i)));

    // ── Delays: the starting point, the steps and what is fixed ──────────────
    const steps = [];
    for (let v = 0; v <= o.maxMs; v += o.gridMs) steps.push(v);
    if (!steps.length) steps.push(0);
    const baseline = R.map(r => (r.recorded != null ? r.recorded : o.currentMs));
    const fixed = R.map(r => o.keepRecorded && r.recorded != null);
    const choices = R.map((r, i) => {
      const c = steps.slice();
      const b = baseline[i];
      if (b != null && !c.includes(b)) c.push(b);
      return c.sort((x, y) => x - y);
    });
    const start = R.map((r, i) => (baseline[i] != null ? baseline[i] : 0));

    const t = new Float64Array(R.length);
    function scenCost(sc, d) {
      const lf = o.leadMs + o.frameMs;
      for (const [i, , from] of sc.order) {
        let arrive = Infinity;
        for (const f of from) {
          const ts = f < 0 ? 0 : t[f];
          if (ts < arrive) arrive = ts;
        }
        t[i] = arrive + lf + d[i];
      }
      let c = 0;
      for (const [i, j] of sc.pairs) c += cost(t[i] - t[j], o);
      return c * sc.weight;
    }
    const repCost = (i, d) => byRep[i].reduce((s, k) => s + scenCost(scenarios[k], d), 0);
    const total = d => scenarios.reduce((s, sc) => s + scenCost(sc, d), 0);
    const changes = d => R.reduce((n, r, i) => n + (baseline[i] != null && d[i] !== baseline[i] ? 1 : 0), 0);

    // Busiest first: the repeaters in the most readings that collide.
    const busy = R.map((r, i) => byRep[i].reduce((s, k) => s + scenarios[k].weight, 0));
    const movable = R.map((r, i) => i).filter(i => linked[i] && !fixed[i])
      .sort((x, y) => busy[y] - busy[x] || (R[x].id < R[y].id ? -1 : 1));

    function descend(d, orderIdx) {
      for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (const i of orderIdx) {
          const was = d[i];
          let best = was, bestC = repCost(i, d) + (baseline[i] != null && was !== baseline[i] ? CHANGE_COST : 0);
          for (const v of choices[i]) {
            if (v === was) continue;
            d[i] = v;
            const c = repCost(i, d) + (baseline[i] != null && v !== baseline[i] ? CHANGE_COST : 0);
            if (c < bestC - EPS) { bestC = c; best = v; }
          }
          d[i] = best;
          if (best !== was) moved = true;
        }
        if (!moved) break;
      }
      return d;
    }

    // The repeaters that share a reading's copies are searched together and
    // apart from every other such group: nothing one group does changes
    // another's cost. Each group is annealed — a delay moved at random, kept
    // if it costs less and sometimes if it costs a little more, the "a
    // little" shrinking as it goes — from a seed of its own, then settled by
    // the descent; the best the group has seen is what it keeps.
    const pen = (i, v) => (baseline[i] != null && v !== baseline[i] ? CHANGE_COST : 0);
    const groupOf = R.map((r, i) => i);
    const gfind = i => (groupOf[i] === i ? i : (groupOf[i] = gfind(groupOf[i])));
    for (const sc of scenarios) {
      for (const [i] of sc.order) groupOf[gfind(i)] = gfind(sc.order[0][0]);
    }
    const gMembers = new Map();
    for (const i of movable) {
      const g = gfind(i);
      if (!gMembers.has(g)) gMembers.set(g, []);
      gMembers.get(g).push(i);
    }
    const d = descend(start.slice(), movable);
    for (const members of gMembers.values()) {
      if (members.length < 2) continue;
      const ks = [...new Set(members.flatMap(i => byRep[i]))];
      const gCost = () => ks.reduce((s, k) => s + scenCost(scenarios[k], d), 0)
        + members.reduce((s, i) => s + pen(i, d[i]), 0);
      let seed = 0;
      for (const ch of R[members[0]].id) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
      const rand = rng(seed ^ 0x5eed);
      let cur = gCost();
      let bestC = cur, bestD = members.map(i => d[i]);
      const scale = Math.max(1, ks.reduce((s, k) => s + scenarios[k].weight, 0) / ks.length);
      const iters = ANNEAL_PER_REPEATER * members.length;
      for (let it = 0; it < iters; it++) {
        const temp = scale * 0.6 * Math.pow(0.002, it / iters);
        const i = members[Math.floor(rand() * members.length)];
        const ch = choices[i];
        const v = ch[Math.floor(rand() * ch.length)];
        const was = d[i];
        if (v === was) continue;
        const c0 = repCost(i, d) + pen(i, was);
        d[i] = v;
        const delta = repCost(i, d) + pen(i, v) - c0;
        if (delta <= 0 || rand() < Math.exp(-delta / temp)) {
          cur += delta;
          if (cur < bestC - EPS) { bestC = cur; bestD = members.map(m => d[m]); }
        } else {
          d[i] = was;
        }
      }
      members.forEach((m, n) => { d[m] = bestD[n]; });
      descend(d, members);
    }
    const delay = d;

    // ── What the plan comes to ───────────────────────────────────────────────
    // Each pair once: the closest its copies come under the plan (and with
    // every repeater on one delay), how many readings put them together and
    // where they meet.
    const pairInfo = new Map();
    const lf = o.leadMs + o.frameMs;
    const evalTimes = (sc, d) => {
      for (const [i, , from] of sc.order) {
        let arrive = Infinity;
        for (const f of from) { const ts = f < 0 ? 0 : t[f]; if (ts < arrive) arrive = ts; }
        t[i] = arrive + lf + d[i];
      }
    };
    const same = start.map(() => (o.currentMs != null ? o.currentMs : 0));
    for (const sc of scenarios) {
      evalTimes(sc, same);
      const before = sc.pairs.map(([i, j]) => Math.abs(t[i] - t[j]));
      evalTimes(sc, delay);
      sc.pairs.forEach(([i, j, where], n) => {
        const key = i < j ? i + '|' + j : j + '|' + i;
        let p = pairInfo.get(key);
        if (!p) {
          p = { a: Math.min(i, j), b: Math.max(i, j), weight: 0, sepMs: Infinity, sepSameMs: Infinity,
                where: new Set(), sources: [] };
          pairInfo.set(key, p);
        }
        p.weight += sc.weight;
        p.sepMs = Math.min(p.sepMs, Math.abs(t[i] - t[j]));
        p.sepSameMs = Math.min(p.sepSameMs, before[n]);
        for (const w of where) p.where.add(w);
        for (const s of sc.sources) if (p.sources.length < 8 && !p.sources.some(x => x.id === s.id)) p.sources.push(s);
      });
    }
    const name = new Map(list.map(s => [s.id, s.name || s.id]));
    const pairs = [...pairInfo.values()].map(p => ({
      a: R[p.a].id, b: R[p.b].id, aName: R[p.a].name, bName: R[p.b].name,
      km: Math.round(repKm(p.a, p.b) * 10) / 10,
      weight: p.weight, sepMs: Math.round(p.sepMs), band: band(p.sepMs, o),
      sepSameMs: Math.round(p.sepSameMs), bandSame: band(p.sepSameMs, o),
      where: [...p.where].map(id => ({ id, name: name.get(id) || id })),
      sources: p.sources,
    })).sort((x, y) => y.weight - x.weight || (x.a + x.b < y.a + y.b ? -1 : 1));

    // Clusters: repeaters joined by a pair, each to be set as a group.
    const parent = R.map((r, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const p of pairInfo.values()) parent[find(p.a)] = find(p.b);
    const groups = new Map();
    R.forEach((r, i) => {
      if (!linked[i]) return;
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    });
    const worstOf = bands => (bands.includes('ontop') ? 'ontop' : bands.includes('close') ? 'close' : 'clear');
    const placeName = members => {
      const tally = new Map();
      for (const i of members) {
        const st = R[i].st;
        const k = st.basin || st.lga || (st.hub_id ? st.hub_id[0].toUpperCase() + st.hub_id.slice(1) + ' hub' : '');
        if (k) tally.set(k, (tally.get(k) || 0) + busy[i] + 1);
      }
      const top = [...tally.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      return top.length ? top.slice(0, 2).map(x => x[0]).join(' / ') : 'Unplaced';
    };
    const clusterOf = new Map();
    const clusters = [...groups.values()].map(members => {
      members.sort((x, y) => busy[y] - busy[x] || (R[x].name < R[y].name ? -1 : 1));
      const ids = new Set(members.map(i => R[i].id));
      const own = pairs.filter(p => ids.has(p.a));
      return {
        name: placeName(members), repeaters: members.map(i => R[i].id),
        pairs: own.length, worst: worstOf(own.map(p => p.band)), worstSame: worstOf(own.map(p => p.bandSame)),
        weight: own.reduce((s, p) => s + p.weight, 0),
        delays: [...new Set(members.map(i => delay[i]))].sort((x, y) => x - y),
      };
    }).sort((x, y) => y.weight - x.weight || (x.name < y.name ? -1 : 1));
    clusters.forEach((c, n) => { c.n = n + 1; for (const id of c.repeaters) clusterOf.set(id, c.n); });

    const repeaters = R.map((r, i) => {
      const mine = pairs.filter(p => p.a === r.id || p.b === r.id).map(p => {
        const other = p.a === r.id ? p.b : p.a;
        return { id: other, name: p.a === r.id ? p.bName : p.aName, sepMs: p.sepMs, band: p.band,
                 weight: p.weight, km: p.km, otherDelay: delay[rIndex.get(other)] };
      }).sort((x, y) => x.sepMs - y.sepMs || y.weight - x.weight);
      const st = r.st;
      let status;
      if (!r.ok) status = 'unplaced';
      else if (!r.win.length) status = 'nothing-passed';
      else if (!linked[i]) status = 'free';
      else status = worstOf(mine.map(m => m.band));
      return {
        id: r.id, name: r.name, hub: st.hub_id || '', basin: st.basin || '', lga: st.lga || '',
        rx: r.rx, tx: r.tx, channelUnknown: r.rx == null || r.tx == null,
        recorded: r.recorded, baseline: baseline[i],
        delay: delay[i], fixed: fixed[i], linked: linked[i],
        change: baseline[i] == null ? null : delay[i] !== baseline[i],
        readings: busy[i], cluster: clusterOf.get(r.id) || null,
        status, neighbours: mine,
      };
    });

    const count = b => pairs.filter(p => p.band === b).length;
    const countSame = b => pairs.filter(p => p.bandSame === b).length;
    const usedDelays = [...new Set(repeaters.filter(r => r.linked).map(r => r.delay))].sort((x, y) => x - y);
    return {
      settings: o,
      repeaters, pairs, clusters,
      counts: {
        repeaters: R.length, linked: linked.filter(Boolean).length,
        free: repeaters.filter(r => r.status === 'free').length,
        unplaced: repeaters.filter(r => r.status === 'unplaced' || r.status === 'nothing-passed').length,
        channelUnknown: repeaters.filter(r => r.channelUnknown).length,
        recorded: R.filter(r => r.recorded != null).length,
        pairs: pairs.length, ontop: count('ontop'), close: count('close'), clear: count('clear'),
        ontopSame: countSame('ontop'), closeSame: countSame('close'), clearSame: countSame('clear'),
        scenarios: scenarios.length, readings: scenarios.reduce((s, sc) => s + sc.weight, 0),
        changes: repeaters.filter(r => r.change).length,
        biggestCluster: clusters.reduce((m, c) => Math.max(m, c.repeaters.length), 0),
        delaysUsed: usedDelays,
      },
      costSame: total(same), costPlan: total(delay),
    };
  }

  return { DEFAULTS, plan, band, cost, settings, addresses, windows };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DelayPlan;
