// MegaNet — signal-routes.js
//
//   SignalRoutes   the Signal Routes tab: what comes in from where. Every burst
//                  a base station's receivers heard over the last day, three or
//                  seven, followed back to the transmitter that put it on the
//                  air, and drawn four ways:
//                    * Routes — a flow from each field station, through what
//                      the receiver actually heard (the station's own carrier,
//                      or the carrier of the repeater that relayed it), to the
//                      receiver channel that decoded it; ALERT2 by its path.
//                    * Map — the same routes on the ground, and where a
//                      repeater's pass ranges and its carrier disagree.
//                    * Pass ranges — each repeater whose carrier was found, its
//                      pass ranges on record set against the addresses heard on
//                      its carrier: confirmed, in a range but only ever heard
//                      another way, and on its carrier but in no range it has
//                      on record.
//                    * Protocols — ALERT2 or legacy ALERT, and of the legacy,
//                      ALERT Binary, Enhanced iFLOWS or ASCII, channel by
//                      channel; which stations arrive both ways.
//
// ── Whose carrier, worked out here ───────────────────────────────────────────
// The server already puts each legacy burst down to its transmitter (0077's
// roll_up_carriers_day, refined by 0078), but what it keeps is a row per
// transmitter — carrier_daily counts how many addresses a repeater relayed,
// not which — and it is the service key's. So the same rules are run again
// here, step for step, over the receptions an editor may read: for each
// receiver's UTC day, each register repeater's carrier is the ±30 Hz window
// holding the most addresses it passes (accepted on its own sensors, or on 4+
// addresses and half of those heard from its range); two repeaters on one
// carrier are one transmitter; then each burst goes to the repeater whose
// carrier it sits on and whose address it is to pass, else to its station — a
// copy (`duplicate`) no repeater explains is set aside as unexplained. What
// 0078 adds first, setting aside corrupted copies, is not done here: a flip
// counts under the address it arrived as, a few a day.
//
// What that makes possible, and the server does not keep: **a repeater's pass
// ranges checked against the air.** A copy that no repeater on record explains
// but that sits on a found repeater's carrier is that repeater relaying an
// address its pass ranges on record do not include — the record, or the
// radio, is wrong. And an address in a repeater's range, heard on days its
// carrier was found but never on it, is one the repeater does not relay here.
//
// ALERT2 needs none of that: each PDU names its path. The rollups
// (reception_daily, 0071) give each source's paths to each receiver; a sample
// of the last twelve hours' PDUs gives which legacy ALERT addresses each
// concentrator carries — the stations that arrive on ALERT2.
//
// Reads meganet.reception, reception_daily and ingest_point_latest — editors
// only (0047, 0071, 0045). Signed out, or not an editor, the tab says so and
// offers a demo built on the station file. After core.js, datastore.js, app.js
// (stationAlertIds, passRangeCoversId, goToStation, switchTab) and
// map-controls.js (addBaseLayers), all read at call time; before init.js.
// Nothing runs at load: app.js's renderMain calls render() and init().

const SignalRoutes = (() => {

  const HOUR = 3600e3, DAY = 24 * HOUR;
  const PERIODS = [1, 3, 7];
  const CHUNK_MS = 6 * HOUR;       // each chunk of receptions pages on its own
  const PAGE = 1000;               // PostgREST's max rows per request on this project
  const PARALLEL = 4;
  const MAX_ROWS = 200000;         // a week of a much busier fleet; past it, say so
  const CONC_HOURS = 12;           // the ALERT2 concentration sample
  // 0077's constants, unchanged: a carrier is ±30 Hz, found in 5 Hz bins.
  const TOL = 30, BIN = 5, WIN = 6;
  const LEFT_MAX = 24, LEFT_PICKED = 60;

  const S = {
    days: 3,
    phase: 'idle',       // idle | loading | ready | error
    err: '',
    fetched: 0,
    capped: false,
    seq: 0,
    demo: false,
    A: null,             // the analysis
    mode: 'alert',       // the routes drawing: alert (by carrier) | alert2 (by path)
    pick: null,          // { col: 'l' | 'm' | 'r', id }
    rep: null,           // the repeater picked in Pass ranges
    gaps: true,          // the map's pass-range overlay
    allRoutes: false,
    flow: null,          // the drawing's nodes, for pickNode()
    map: null, layer: null, fitted: false,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(a / b < 0.1 ? 1 : 0)}%` : '—');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const dayOf = t => new Date(t).toISOString().slice(0, 10);
  const utcMidnight = t => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
  const when = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
  const km = (a, b) => (a && b && a.lat != null && b.lat != null && typeof acmaHaversineKm === 'function'
    ? acmaHaversineKm(Number(a.lat), Number(a.lon), Number(b.lat), Number(b.lon)) : null);
  const kmText = d => (d == null ? '—' : d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`);

  // The frame formats as the decoders name them (RPi ALERT's FORMAT_SHORT,
  // the Quansheng's DEC lines), in the order the key lists them.
  const FMT = [
    { key: 'ABF', label: 'ALERT Binary', cls: 'sr-c-binary' },
    { key: 'EIF', label: 'Enhanced iFLOWS', cls: 'sr-c-iflows' },
    { key: 'ASCII', label: 'ALERT ASCII', cls: 'sr-c-ascii' },
    { key: 'other', label: 'Legacy, format not stated', cls: 'sr-c-other' },
  ];
  const fmtKey = f => (f === 'ABF' || f === 'EIF' || f === 'ASCII' ? f : 'other');
  const fmtLabel = k => (FMT.find(f => f.key === k) || FMT[3]).label;

  // ── The register ──────────────────────────────────────────────────────────

  function register() {
    const list = stations();
    const byId = new Map(list.map(s => [s.id, s]));
    const idsOf = s => (typeof stationAlertIds === 'function' ? stationAlertIds(s)
      : [...new Set((s.sensors || []).map(x => Number(x.alert_id)).filter(Number.isFinite))]);
    const covers = (rep, a) => {
      if (typeof passRangeCoversId === 'function') return passRangeCoversId(rep, a);
      const ex = (rep && rep.exclusions) || [];
      return ((rep && rep.pass_ranges) || []).some(r => a >= r.low && a <= r.high && !ex.some(e => a >= e.low && a <= e.high));
    };
    const addrSt = new Map();
    list.forEach(s => idsOf(s).forEach(a => { if (!addrSt.has(a)) addrSt.set(a, []); addrSt.get(a).push(s); }));
    const a2St = new Map();
    list.forEach(s => { if (s.alert2_station_id != null) a2St.set(Number(s.alert2_station_id), s); });
    const reps = list.filter(s => (s.roles || []).includes('repeater') && s.repeater)
      .map(s => ({ id: s.id, st: s, own: new Set(idsOf(s)), rep: s.repeater }));
    const repById = new Map(reps.map(r => [r.id, r]));
    // B relays A when one of A's own addresses is in B's pass range (0077's
    // _relays): A's sensors heard on B's carrier may be B relaying them.
    const relays = new Set(), relayed = new Set();
    reps.forEach(a => a.own.forEach(addr => reps.forEach(b => {
      if (b.id !== a.id && covers(b.rep, addr)) { relays.add(b.id + '>' + a.id); relayed.add(a.id); }
    })));
    // Every repeater that might have sent an address: one it passes, or one
    // of its own — its own an anchor only when nobody else passes it.
    const candCache = new Map();
    const cands = a => {
      let c = candCache.get(a);
      if (!c) {
        c = [];
        reps.forEach(r => {
          if (r.own.has(a)) c.push({ rid: r.id, own: true, anchor: !relayed.has(r.id) });
          else if (covers(r.rep, a)) c.push({ rid: r.id, own: false, anchor: false });
        });
        candCache.set(a, c);
      }
      return c;
    };
    return { list, byId, addrSt, a2St, reps, repById, relays, cands, covers, idsOf };
  }

  // A station key for an address: the station holding it, or the address
  // itself when two stations share it or none has it (0077's `a:<address>`).
  function stationKey(reg, a) {
    const sts = reg.addrSt.get(a) || [];
    return sts.length === 1 ? 'st:' + sts[0].id : 'a:' + a;
  }
  function keyName(reg, key) {
    if (key.startsWith('st:')) { const s = reg.byId.get(key.slice(3)); return s ? s.name : key.slice(3); }
    if (key.startsWith('a:')) {
      const a = Number(key.slice(2)), sts = reg.addrSt.get(a) || [];
      return sts.length > 1 ? `ALERT ${a} (shared: ${sts.map(s => s.name).join(', ')})` : `ALERT ${a} (no station)`;
    }
    if (key.startsWith('a2:')) { const s = reg.a2St.get(Number(key.slice(3))); return s ? `${s.name} (ALERT2 ${key.slice(3)})` : `ALERT2 ${key.slice(3)}`; }
    return key;
  }
  function keyStation(reg, key) {
    if (key.startsWith('st:')) return reg.byId.get(key.slice(3)) || null;
    if (key.startsWith('a2:')) return reg.a2St.get(Number(key.slice(3))) || null;
    return null;
  }

  // ── Whose carrier (0077, step for step) ───────────────────────────────────

  // One receiver's UTC day of measured legacy bursts ({ a, cfo, dup }).
  // Sets each burst's `how` (repeater, ambiguous, unexplained, own) and `rid`;
  // answers the repeaters whose carriers were kept, with their centres.
  function attribute(group, reg) {
    const per = new Map();
    group.forEach(b => {
      b.cands = reg.cands(b.a);
      b.cands.forEach(c => {
        let p = per.get(c.rid);
        if (!p) per.set(c.rid, p = []);
        p.push({ a: b.a, anchor: c.anchor, bin: Math.floor(b.cfo / BIN), cfo: b.cfo });
      });
    });
    const found = [];
    per.forEach((list, rid) => {
      const nids = new Set(list.filter(e => !e.anchor).map(e => e.a)).size;
      const byBin = new Map();
      list.forEach(e => {
        let x = byBin.get(e.bin);
        if (!x) byBin.set(e.bin, x = { n: new Set(), o: new Set() });
        (e.anchor ? x.o : x.n).add(e.a);
      });
      let best = null;
      [...byBin.keys()].sort((p, q) => p - q).forEach(k => {
        const n = new Set(), o = new Set();
        for (let j = k - WIN; j <= k + WIN; j++) {
          const x = byBin.get(j);
          if (x) { x.n.forEach(a => n.add(a)); x.o.forEach(a => o.add(a)); }
        }
        const w = { bin: k, ids: n.size, own: o.size };
        // (own > 0) desc, ids desc, bin asc — the lowest bin wins a tie.
        if (!best || (w.own > 0 && !(best.own > 0)) || ((w.own > 0) === (best.own > 0) && w.ids > best.ids)) best = w;
      });
      if (!best || !(best.own > 0 || (best.ids >= 4 && best.ids >= 0.5 * nids))) return;
      const inWin = list.filter(e => e.bin >= best.bin - WIN && e.bin <= best.bin + WIN).map(e => e.cfo).sort((p, q) => p - q);
      found.push({ rid, ids: best.ids, own: best.own, nids, centre: median(inWin) });
    });
    // Two repeaters on one carrier are one transmitter: the one that relays
    // the other's sensors; else the one heard on its own; else neither.
    const kept = found.filter(r => !found.some(o => o !== r && Math.abs(o.centre - r.centre) <= 2 * TOL
      && (reg.relays.has(o.rid + '>' + r.rid) || !((r.own > 0 && o.own === 0) || reg.relays.has(r.rid + '>' + o.rid)))));
    const keptBy = new Map(kept.map(r => [r.rid, r]));
    group.forEach(b => {
      const claims = b.cands.filter(c => { const r = keptBy.get(c.rid); return r && Math.abs(b.cfo - r.centre) <= TOL; });
      if (claims.length === 1) { b.how = 'repeater'; b.rid = claims[0].rid; }
      else if (claims.length > 1) b.how = 'ambiguous';
      else b.how = b.dup ? 'unexplained' : 'own';
    });
    return kept;
  }

  function median(sorted) {
    if (!sorted.length) return null;
    const m = (sorted.length - 1) / 2;
    return (sorted[Math.floor(m)] + sorted[Math.ceil(m)]) / 2;
  }

  // ── The analysis ──────────────────────────────────────────────────────────

  function receivers(raw) {
    const out = new Map();
    const fromId = id => {
      const m = /-(sdr\d*)(?:-(\d+\.\d+))?/.exec(id || '');
      return m ? `${m[1].toUpperCase().replace('SDR', 'SDR ')}${m[2] ? ' · ' + m[2] : ''}`.replace('SDR  ', 'SDR ') : id;
    };
    (raw.points || []).forEach(p => {
      const label = p.token_label || `Token ${p.ingest_token_id}`;
      const name = String(p.name || '');
      const short = name.startsWith(label) ? name.slice(label.length).replace(/^\s*[—-]\s*/, '') : (name || fromId(p.point_id));
      out.set(p.point_id, { id: p.point_id, label, short: short || p.point_id, host: p.host_station_id || null, kind: p.receiver || '' });
    });
    return out;
  }

  function analyse(raw) {
    const reg = register();
    const rx = receivers(raw);
    const pointOf = id => {
      if (!rx.has(id)) rx.set(id, { id, label: 'Unnamed base station', short: id, host: null, kind: '' });
      return rx.get(id);
    };
    const P = new Map();      // receiver → its counts
    const pt = id => {
      let p = P.get(id);
      if (!p) P.set(id, p = { id, ok: 0, bad: 0, fmts: {}, faults: {}, a2ok: 0, a2bad: 0, freqs: [] });
      return p;
    };

    // Legacy: every burst, then the measured ones by receiver-day.
    const legacy = { total: 0, ok: 0, bad: 0, measured: 0, how: { own: 0, repeater: 0, ambiguous: 0, unexplained: 0, unmeasured: 0 }, fmts: {} };
    const groups = new Map();
    const okBursts = [];
    (raw.legacy || []).forEach(r => {
      legacy.total++;
      const p = pt(r.point_id);
      pointOf(r.point_id);
      if (r.freq_mhz != null && p.freqs.length < 50) p.freqs.push(Number(r.freq_mhz));
      if (!r.ok || r.alert_id == null) {
        legacy.bad++; p.bad++;
        const f = r.fault || 'failed';
        p.faults[f] = (p.faults[f] || 0) + 1;
        return;
      }
      legacy.ok++; p.ok++;
      const fk = fmtKey(r.fmt);
      p.fmts[fk] = (p.fmts[fk] || 0) + 1;
      legacy.fmts[fk] = (legacy.fmts[fk] || 0) + 1;
      const b = { a: Number(r.alert_id), pt: r.point_id, fk, dup: !!r.a2_duplicate, cfo: r.cfo_hz == null ? null : Number(r.cfo_hz),
        day: dayOf(r.heard_at), how: 'unmeasured', rid: null };
      okBursts.push(b);
      if (b.cfo == null || !Number.isFinite(b.cfo)) return;
      legacy.measured++;
      const k = b.pt + '|' + b.day;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    });

    // Each receiver-day: its repeaters' carriers, each burst to its
    // transmitter, then what sits on a carrier its pass ranges do not explain.
    const REP = new Map();
    const repOf = rid => {
      let x = REP.get(rid);
      if (!x) REP.set(rid, x = { rid, days: new Set(), pts: new Set(), centres: [], found: [], n: 0, confirmed: new Map(), elsewhere: new Map(), offrec: new Map(), groups: new Set() });
      return x;
    };
    const unxBy = new Map();
    groups.forEach((g, k) => {
      const kept = attribute(g, reg);
      kept.forEach(r => {
        const x = repOf(r.rid);
        x.days.add(g[0].day); x.pts.add(g[0].pt); x.centres.push(Math.round(r.centre)); x.groups.add(k);
        x.found.push({ pt: g[0].pt, day: g[0].day, centre: r.centre });
      });
      g.forEach(b => {
        legacy.how[b.how]++;
        if (b.how === 'repeater') {
          const x = repOf(b.rid);
          x.n++;
          x.confirmed.set(b.a, (x.confirmed.get(b.a) || 0) + 1);
          return;
        }
        if (b.how !== 'own' && b.how !== 'unexplained') return;
        // On a kept carrier, by an address that repeater does not pass?
        const on = kept.find(r => Math.abs(b.cfo - r.centre) <= TOL && !b.cands.some(c => c.rid === r.rid));
        if (on) {
          const x = repOf(on.rid);
          let o = x.offrec.get(b.a);
          if (!o) x.offrec.set(b.a, o = { dup: 0, own: 0, all: 0, pts: new Set() });
          if (b.dup) o.dup++; else o.own++;
          o.pts.add(b.pt);
        } else if (b.how === 'unexplained') {
          if (!unxBy.has(k)) unxBy.set(k, []);
          unxBy.get(k).push(b);
        }
      });
    });
    legacy.how.unmeasured = legacy.ok - legacy.measured;

    // Copies no repeater on record explains, gathered by carrier: each
    // receiver-day's densest 60 Hz windows of them, three addresses or more,
    // then one carrier on one receiver across the days (within 40 Hz — a
    // receiver's own crystal wanders that much). Each is a transmitter
    // relaying those addresses that the register's pass ranges and the day's
    // found carriers did not account for. Which one it may be: a repeater
    // whose carrier was found there on another day, and the repeaters whose
    // ranges hold the most of its addresses.
    const pieces = [];
    unxBy.forEach(list => {
      let rest = list.slice().sort((p, q) => p.cfo - q.cfo);
      for (;;) {
        let best = null;
        for (let i = 0, j = 0; i < rest.length; i++) {
          if (j < i) j = i;
          while (j < rest.length && rest[j].cfo <= rest[i].cfo + 2 * TOL) j++;
          const ids = new Set(rest.slice(i, j).map(b => b.a)).size;
          if (!best || ids > best.ids) best = { i, j, ids };
        }
        if (!best || best.ids < 3) break;
        const members = rest.slice(best.i, best.j);
        pieces.push({ pt: members[0].pt, day: members[0].day, centre: median(members.map(b => b.cfo)), members });
        rest = rest.slice(0, best.i).concat(rest.slice(best.j));
      }
    });
    const relays = [];
    pieces.sort((p, q) => p.pt.localeCompare(q.pt) || p.centre - q.centre).forEach(c => {
      let m = relays.find(x => x.pt === c.pt && Math.abs(median(x.centres.slice().sort((p, q) => p - q)) - c.centre) <= 40);
      if (!m) relays.push(m = { id: relays.length, pt: c.pt, centres: [], days: new Set(), addrs: new Map(), n: 0 });
      m.centres.push(c.centre); m.days.add(c.day);
      c.members.forEach(b => { b.unk = m.id; m.n++; m.addrs.set(b.a, (m.addrs.get(b.a) || 0) + 1); });
    });
    relays.forEach(m => {
      m.centre = median(m.centres.slice().sort((p, q) => p - q));
      const seen = new Map();
      REP.forEach(x => x.found.forEach(f => {
        if (f.pt === m.pt && Math.abs(f.centre - m.centre) <= 40) {
          const s = seen.get(x.rid) || { rid: x.rid, days: new Set(), centres: [] };
          s.days.add(f.day); s.centres.push(Math.round(f.centre)); seen.set(x.rid, s);
        }
      }));
      const addrs = [...m.addrs.keys()];
      const holds = rid => { const r = reg.repById.get(rid); return addrs.filter(a => r.own.has(a) || reg.covers(r.rep, a)).length; };
      m.seen = [...seen.values()].sort((p, q) => q.days.size - p.days.size);
      m.byRange = reg.reps.map(r => ({ rid: r.id, holds: holds(r.id) })).filter(x => x.holds > 0).sort((p, q) => q.holds - p.holds).slice(0, 3);
      m.likely = m.seen.length ? { rid: m.seen[0].rid, holds: holds(m.seen[0].rid), seen: m.seen[0] } : null;
      m.key = addrs.map(a => stationKey(reg, a));
    });
    const unknownRelay = new Map();
    unxBy.forEach(list => list.forEach(b => { if (b.unk == null) unknownRelay.set(b.a, (unknownRelay.get(b.a) || 0) + 1); }));

    // Addresses in a found repeater's range, heard on a day its carrier was
    // found, and never on it; and for the off-record ones, how much of each
    // those days measured, against how much sat on the carrier.
    REP.forEach(x => {
      const r = reg.repById.get(x.rid);
      x.groups.forEach(k => (groups.get(k) || []).forEach(b => {
        const o = x.offrec.get(b.a);
        if (o) o.all++;
        if (x.confirmed.has(b.a) || r.own.has(b.a) || !reg.covers(r.rep, b.a)) return;
        let e = x.elsewhere.get(b.a);
        if (!e) x.elsewhere.set(b.a, e = { own: 0, other: new Map(), n: 0 });
        e.n++;
        if (b.how === 'repeater') e.other.set(b.rid, (e.other.get(b.rid) || 0) + 1);
        else e.own++;
      }));
    });

    // Routes: a row per address, way in and receiver.
    const routeMap = new Map();
    const addrHeard = new Set();
    okBursts.forEach(b => {
      addrHeard.add(b.a);
      const via = b.how === 'repeater' ? 'rep:' + b.rid : b.unk != null ? 'unk:' + b.unk : b.how;
      const k = b.a + '|' + via + '|' + b.pt;
      let r = routeMap.get(k);
      if (!r) routeMap.set(k, r = { a: b.a, key: stationKey(reg, b.a), via, pt: b.pt, n: 0, alt: 0, fmts: {} });
      r.n++;
      r.fmts[b.fk] = (r.fmts[b.fk] || 0) + 1;
      if (b.fk !== 'ABF') r.alt++;
    });
    const routes = [...routeMap.values()].sort((p, q) => q.n - p.n);

    // Each found repeater, summed: its carrier, what it confirmed, what is off
    // its record, and what its ranges hold that nobody heard at all.
    const reps = [...REP.values()].filter(x => x.days.size).map(x => {
      const r = reg.repById.get(x.rid);
      // Two or more copies on its carrier is it relaying the address; one copy,
      // or every burst on its carrier with no copy, may be — or a station whose
      // own carrier sits within 30 Hz; a burst or two is a stray.
      const offrec = [...x.offrec.entries()].map(([a, o]) => ({ a, key: stationKey(reg, a), ...o,
        evidence: o.dup >= 2 ? 'copies' : o.dup === 1 || (o.own >= 3 && o.own >= 0.8 * Math.max(1, o.all)) ? 'possible' : 'stray' }))
        .filter(o => o.evidence !== 'stray').sort((p, q) => (p.evidence === q.evidence ? 0 : p.evidence === 'copies' ? -1 : 1) || (q.dup + q.own) - (p.dup + p.own));
      let notHeard = 0;
      reg.addrSt.forEach((_, a) => { if (!r.own.has(a) && reg.covers(r.rep, a) && !addrHeard.has(a)) notHeard++; });
      const sorted = x.centres.slice().sort((p, q) => p - q);
      return { rid: x.rid, st: r.st, name: r.st.name, days: x.days.size, pts: [...x.pts], centre: median(sorted), spread: sorted.length ? sorted[sorted.length - 1] - sorted[0] : 0,
        n: x.n, confirmed: x.confirmed, elsewhere: x.elsewhere, offrec, notHeard,
        ranges: (r.rep.pass_ranges || []).map(q => ({ low: Number(q.low), high: Number(q.high) })),
        exclusions: (r.rep.exclusions || []).map(q => ({ low: Number(q.low), high: Number(q.high) })),
        rx: r.rep.rx_mhz ?? null, tx: r.rep.tx_mhz ?? null };
    }).sort((p, q) => q.n - p.n);

    // ALERT2: the rollups' sources and paths, and the concentration sample.
    const a2 = { total: 0, ok: 0, routes: [], sources: new Map(), conc: new Map(), concRows: (raw.a2conc || []).length };
    const a2routeMap = new Map();
    (raw.a2daily || []).forEach(r => {
      const p = pt(r.point_id);
      pointOf(r.point_id);
      const n = Number(r.n) || 0, ok = Number(r.n_ok) || 0;
      p.a2ok += ok; p.a2bad += Math.max(0, n - ok);
      if (r.freq_min != null && p.freqs.length < 50) p.freqs.push(Number(r.freq_min));
      a2.total += n; a2.ok += ok;
      if (r.station == null || !ok) return;
      const path = Array.isArray(r.path) ? r.path.map(Number) : [];
      const k = r.station + '|' + path.join('>') + '|' + r.point_id;
      let x = a2routeMap.get(k);
      if (!x) a2routeMap.set(k, x = { src: Number(r.station), path, pt: r.point_id, n: 0, dup: 0 });
      x.n += ok; x.dup += Number(r.n_dup) || 0;
      let s = a2.sources.get(x.src);
      if (!s) a2.sources.set(x.src, s = { src: x.src, n: 0, paths: new Map(), pts: new Set(), carried: new Map() });
      s.n += ok; s.pts.add(r.point_id);
      const pk = path.join('>');
      s.paths.set(pk, (s.paths.get(pk) || 0) + ok);
    });
    a2.routes = [...a2routeMap.values()].sort((p, q) => q.n - p.n);
    (raw.a2conc || []).forEach(r => {
      if (r.alert_id == null || r.a2_source == null) return;
      const a = Number(r.alert_id), src = Number(r.a2_source);
      let m = a2.conc.get(a);
      if (!m) a2.conc.set(a, m = new Map());
      m.set(src, (m.get(src) || 0) + 1);
      let s = a2.sources.get(src);
      if (!s) a2.sources.set(src, s = { src, n: 0, paths: new Map(), pts: new Set(), carried: new Map() });
      s.carried.set(a, (s.carried.get(a) || 0) + 1);
    });

    // Stations, both ways.
    const ST = new Map();
    const stOf = key => {
      let s = ST.get(key);
      if (!s) ST.set(key, s = { key, n: 0, via: new Map(), pts: new Set(), addrs: new Set(), a2: new Map(), a2n: 0 });
      return s;
    };
    routes.forEach(r => {
      const s = stOf(r.key);
      s.n += r.n; s.pts.add(r.pt); s.addrs.add(r.a);
      s.via.set(r.via, (s.via.get(r.via) || 0) + r.n);
    });
    a2.conc.forEach((m, a) => {
      const s = stOf(stationKey(reg, a));
      s.addrs.add(a);
      m.forEach((n, src) => { s.a2.set(src, (s.a2.get(src) || 0) + n); s.a2n += n; });
    });
    const mix = { legacyOnly: 0, both: 0, a2Only: 0 };
    ST.forEach(s => { if (s.n && s.a2n) mix.both++; else if (s.n) mix.legacyOnly++; else if (s.a2n) mix.a2Only++; });

    // Each receiver: its base station, its channel and what it decodes.
    const points = [...P.values()].map(p => {
      const r = pointOf(p.id);
      const host = r.host ? reg.byId.get(r.host) || null : null;
      const freqs = p.freqs.slice().sort((x, y) => x - y);
      const fmtTop = Object.entries(p.fmts).sort((x, y) => y[1] - x[1])[0];
      return { ...p, label: r.label, short: r.short, host, freq: freqs.length ? freqs[Math.floor(freqs.length / 2)] : null,
        fmt: fmtTop ? fmtTop[0] : null, total: p.ok + p.bad + p.a2ok + p.a2bad };
    }).sort((x, y) => (x.freq ?? 999) - (y.freq ?? 999) || x.id.localeCompare(y.id));

    return { from: raw.from, to: raw.to, concFrom: raw.concFrom, days: raw.days, demo: !!raw.demo, capped: !!raw.capped,
      reg, points, pointById: new Map(points.map(p => [p.id, p])), legacy, routes, reps, repById: new Map(reps.map(r => [r.rid, r])),
      relays, unknownRelay, a2, stations: ST, mix };
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  const iso = t => encodeURIComponent(new Date(t).toISOString());

  // Receptions in [t0, t1): six-hour chunks, each paged on (heard_at, id) so
  // an offset means the same thing on every page, four chunks at a time.
  async function fetchReceptions(select, where, t0, t1, seq) {
    const chunks = [];
    for (let a = t0; a < t1; a += CHUNK_MS) chunks.push([a, Math.min(t1, a + CHUNK_MS)]);
    const out = [];
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const [a, b] = chunks[next++];
        for (let off = 0; ; off += PAGE) {
          if (seq !== S.seq || S.capped) return;
          const page = await dbSelect(`reception?select=${select}${where}&heard_at=gte.${iso(a)}&heard_at=lt.${iso(b)}`
            + `&order=heard_at.asc,id.asc&limit=${PAGE}&offset=${off}`);
          out.push(...page);
          S.fetched += page.length;
          if (S.fetched >= MAX_ROWS) S.capped = true;
          if (seq === S.seq) paintStatus();
          if (page.length < PAGE) break;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return out;
  }

  async function fetchAll(path, seq) {
    const out = [];
    for (let off = 0; ; off += PAGE) {
      if (seq !== S.seq) return out;
      const page = await dbSelect(`${path}&limit=${PAGE}&offset=${off}`);
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  async function load() {
    if (typeof dbSelect !== 'function') return;
    if (!signedIn()) { S.phase = 'idle'; redraw(); return; }
    const seq = ++S.seq;
    S.phase = 'loading'; S.err = ''; S.fetched = 0; S.capped = false; S.demo = false; S.pick = null; S.rep = null; S.fitted = false;
    redraw();
    const to = Date.now();
    const from = utcMidnight(to) - (S.days - 1) * DAY;
    const concFrom = to - CONC_HOURS * HOUR;
    try {
      const [points, legacy, a2daily, a2conc] = await Promise.all([
        fetchAll('ingest_point_latest?select=ingest_token_id,token_label,point_id,name,receiver,host_station_id&order=point_id.asc', seq),
        fetchReceptions('heard_at,point_id,alert_id,ok,fault,fmt,cfo_hz,a2_duplicate,freq_mhz', '&protocol=eq.alert', from, to, seq),
        fetchAll(`reception_daily?select=bucket,point_id,station,path,n,n_ok,n_dup,freq_min&protocol=eq.alert2&bucket=gte.${dayOf(from)}`
          + '&order=bucket.asc,ingest_token_id.asc,point_id.asc,station.asc.nullsfirst,path.asc.nullsfirst,survey.asc.nullsfirst', seq),
        fetchReceptions('point_id,alert_id,a2_source,a2_path', '&protocol=eq.alert2&alert_id=not.is.null&a2_duplicate=not.is.true', concFrom, to, seq),
      ]);
      if (seq !== S.seq) return;
      if (!legacy.length && !a2daily.length && !points.length) {
        S.phase = 'error';
        S.err = 'Nothing came back. Receptions are for editors: signed in as one, there were none in this period; otherwise this account may read readings but not what the receivers heard.';
        redraw();
        return;
      }
      S.A = analyse({ from, to, concFrom, days: S.days, capped: S.capped, points, legacy, a2daily, a2conc });
      S.phase = 'ready';
    } catch (err) {
      if (seq !== S.seq) return;
      S.phase = 'error';
      S.err = err && (err.status === 401 || err.status === 403) ? 'Receptions are for editors — sign in as one to read them.'
        : `Could not read the receptions — ${(err && err.message) || err}.`;
    }
    redraw();
  }

  // ── The demo: a made-up three days on the real station file ───────────────
  // Three repeaters, each with stations no other repeater in the register
  // passes (two repeaters passing the same stations on one carrier are one
  // transmitter to 0077, and neither is kept — and the register's ranges
  // overlap so much that near Brisbane only Mt Glorious has stations of its
  // own), each heard at the base station nearest it, on the channel it sends
  // on: its stations relayed on its carrier, some heard direct as well, one in
  // its range only ever heard direct; one station relayed by the first though
  // no range of its includes it (its copies give it away); the second's last
  // day too thin to find its carrier, so its copies are a relay nobody
  // explains that its carrier on the days before puts back to it; a
  // concentrator carrying some of the stations on ALERT2; and a channel set to
  // Enhanced iFLOWS.
  function demo() {
    const list = stations();
    if (!list.length) return;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const placed = s => s && s.lat != null && s.lon != null;
    const reg = register();
    const home = list.find(s => s.id === '18_bateson' && placed(s)) || list.find(s => (s.roles || []).includes('base') && placed(s)) || list.find(placed);
    const bases = list.filter(s => (s.roles || []).includes('base') && placed(s));
    const nearest = st => bases.slice().sort((p, q) => (km(st, p) || 0) - (km(st, q) || 0))[0] || home;
    // One pass over the stations: each one only a single repeater could send.
    const own = new Map();
    reg.list.forEach(s => {
      if (!placed(s) || !(s.roles || []).includes('field')) return;
      const rids = new Set(reg.idsOf(s).flatMap(a => reg.cands(a).map(c => c.rid)));
      if (rids.size !== 1) return;
      const rid = [...rids][0], r = reg.repById.get(rid);
      if (rid === s.id || !placed(r.st) || (km(r.st, s) || 999) >= 140 || !reg.idsOf(s).some(a => reg.covers(r.rep, a))) return;
      if (!own.has(rid)) own.set(rid, []);
      own.get(rid).push(s);
    });
    const picked = [...own.entries()].filter(([, c]) => c.length >= 6).map(([rid, carried]) => ({ r: reg.repById.get(rid), carried }))
      .sort((p, q) => (km(home, p.r.st) || 0) - (km(home, q.r.st) || 0)).slice(0, 3);
    const to = Date.now(), days = 3, from = utcMidnight(to) - (days - 1) * DAY;
    const pointMap = new Map();
    const point = (b, mhz, stick) => {
      const id = `demo-${b.id}-${stick}-${mhz.toFixed(4).replace(/(\.\d{3})0$/, '$1')}`;
      if (!pointMap.has(id)) pointMap.set(id, { ingest_token_id: 0, token_label: b.name, point_id: id, receiver: 'rtl-sdr', host_station_id: b.id,
        name: `${b.name} — RTL-SDR${stick === 'sdr2' ? ' 2' : ''} · ${mhz.toFixed(4).replace(/(\.\d{3})0$/, '$1')}`, mhz });
      return id;
    };
    const legacy = [];
    const at = (d, h) => new Date(Math.min(to - 60e3, from + d * DAY + h * HOUR)).toISOString();
    const burst = (d, pt, a, cfo, o) => legacy.push({ heard_at: at(d, rnd() * 23.5), point_id: pt, alert_id: a, ok: true, fault: null, fmt: 'ABF',
      cfo_hz: cfo == null ? null : Math.round(cfo + (rnd() - 0.5) * 16), a2_duplicate: false, freq_mhz: pointMap.get(pt).mhz, ...o });
    const used = new Set();
    picked.forEach((x, i) => {
      const centre = -450 + i * 290;
      const b = i === 0 ? home : nearest(x.r.st);
      const pt = point(b, Number(x.r.rep.tx_mhz) || 151.5, 'sdr1');
      x.pt = pt;
      let j = 0;
      x.carried.slice(0, 16).forEach(s => {
        const a = reg.idsOf(s).find(id => reg.covers(x.r.rep, id));
        if (a == null || used.has(a) || j >= 12) return;
        used.add(a);
        const own = 900 * (rnd() - 0.5), direct = (km(b, s) || 999) < 60 && j % 2 === 0;
        const onlyDirect = j === 11;
        for (let d = 0; d < days; d++) {
          const thin = i === 1 && d === days - 1;
          if (thin && j >= 3) continue;
          for (let k = 0; k < 6 + Math.floor(rnd() * 6); k++) {
            if (direct || onlyDirect || thin) burst(d, pt, a, own);
            if (!onlyDirect) burst(d, pt, a, centre, { a2_duplicate: direct || thin });
            if (k === 0) burst(d, pt, a, null);
          }
        }
        j++;
      });
    });
    if (picked.length) {
      const x = picked[0];
      const off = reg.list.find(s => placed(s) && (s.roles || []).includes('field') && (km(x.r.st, s) || 999) < 60
        && reg.idsOf(s).length && !reg.idsOf(s).some(a => reg.covers(x.r.rep, a) || used.has(a)));
      if (off) {
        const a = reg.idsOf(off)[0];
        used.add(a);
        for (let d = 0; d < days; d++) for (let k = 0; k < 5; k++) { burst(d, x.pt, a, 320); burst(d, x.pt, a, -450, { a2_duplicate: true }); }
      }
    }
    const eifPt = point(home, 152.4, 'sdr2'), a2Pt = point(home, 151.5375, 'sdr2'), mainPt = picked.length ? picked[0].pt : point(home, 151.5, 'sdr1');
    for (let d = 0; d < days; d++) {
      for (let k = 0; k < 4; k++) legacy.push({ heard_at: at(d, 9 + k), point_id: eifPt, alert_id: 4078, ok: true, fault: null, fmt: 'EIF', cfo_hz: 140, a2_duplicate: false, freq_mhz: 152.4 });
      for (let k = 0; k < 12; k++) legacy.push({ heard_at: at(d, rnd() * 23), point_id: mainPt, alert_id: null, ok: false, fault: 'undecoded', fmt: 'ABF', cfo_hz: null, a2_duplicate: false, freq_mhz: pointMap.get(mainPt).mhz });
    }
    const a2only = reg.list.filter(s => placed(s) && reg.idsOf(s).length && !reg.idsOf(s).some(a => used.has(a))).slice(0, 8).map(s => reg.idsOf(s)[0]);
    const a2conc = [];
    [...used].slice(0, 10).concat(a2only).forEach(a => { for (let k = 0; k < 4; k++) a2conc.push({ point_id: a2Pt, alert_id: a, a2_source: 11762, a2_path: [11056, 10019] }); });
    const a2daily = [];
    for (let d = 0; d < days; d++) {
      const bucket = dayOf(from + d * DAY);
      a2daily.push({ bucket, point_id: a2Pt, station: 11762, path: [11056, 10019], n: 2400, n_ok: 2390, n_dup: 900, freq_min: 151.5375 });
      a2daily.push({ bucket, point_id: a2Pt, station: 11762, path: [10115, 11056, 10019], n: 600, n_ok: 598, n_dup: 600, freq_min: 151.5375 });
      a2daily.push({ bucket, point_id: a2Pt, station: 10019, path: [], n: 140, n_ok: 140, n_dup: 0, freq_min: 151.5375 });
      a2daily.push({ bucket, point_id: a2Pt, station: 10020, path: [11099, 10019], n: 90, n_ok: 88, n_dup: 10, freq_min: 151.5375 });
    }
    legacy.sort((p, q) => p.heard_at.localeCompare(q.heard_at));
    ++S.seq;
    S.demo = true; S.phase = 'ready'; S.err = ''; S.pick = null; S.rep = null; S.fitted = false;
    S.A = analyse({ from, to, concFrom: to - CONC_HOURS * HOUR, days, demo: true, points: [...pointMap.values()], legacy, a2daily, a2conc });
    redraw();
  }

  // ── Routes: the drawing ───────────────────────────────────────────────────

  const VIA = {
    own: { word: 'Direct — its own carrier', short: 'Direct', cls: 'sr-c-direct' },
    unexplained: { word: 'A copy no repeater on record explains', short: 'Unexplained copies', cls: 'sr-c-unexplained' },
    ambiguous: { word: 'On two repeaters\' carriers', short: 'Two repeaters\' carriers', cls: 'sr-c-other' },
    unmeasured: { word: 'Carrier not measured', cls: 'sr-c-unmeasured' },
  };
  const hz = c => (c == null ? '—' : `${c > 0 ? '+' : ''}${Math.round(c)} Hz`);
  function relayWord(A, m) {
    const r = m.likely ? A.reg.byId.get(m.likely.rid) : null;
    return `Unexplained relay at ${hz(m.centre)}${r ? ` — probably ${r.name}` : ''}`;
  }
  // `short` for the drawing, whose column heading already says "on the air from".
  function viaWord(A, via, short) {
    if (via.startsWith('rep:')) { const r = A.reg.byId.get(via.slice(4)); return `${r ? r.name : via.slice(4)}${short ? '' : ' (its carrier)'}`; }
    if (via.startsWith('unk:')) { const m = A.relays[Number(via.slice(4))]; return m ? relayWord(A, m) : 'Unexplained relay'; }
    if (short && VIA[via] && VIA[via].short) return VIA[via].short;
    if (via.startsWith('p:')) { const p = via.slice(2); return p ? `via ${p.split('>').map(a => a2Name(A, a)).join(' → ')}` : 'Direct from the source'; }
    return (VIA[via] || { word: via }).word;
  }
  function viaCls(via) {
    if (via.startsWith('rep:')) return 'sr-c-relay';
    if (via.startsWith('unk:')) return 'sr-c-unexplained';
    if (via.startsWith('p:')) return 'sr-c-alert2';
    return (VIA[via] || { cls: 'sr-c-other' }).cls;
  }
  function a2Name(A, a) { const s = A.reg.a2St.get(Number(a)); return s ? s.name : String(a); }
  // A receiver by its channel, and its base station's name too when there is
  // more than one base station to tell apart.
  function rxName(A, id) {
    const p = A.pointById.get(id);
    if (!p) return id;
    return new Set(A.points.map(x => x.label)).size > 1 ? `${p.label} — ${p.short}` : p.short;
  }
  function rxLong(A, id) { const p = A.pointById.get(id); return p ? `${p.label} — ${p.short}` : id; }

  // The flows of the mode on screen, L → M → R.
  function flowRows(A) {
    if (S.mode === 'alert2') {
      return A.a2.routes.map(r => ({ L: 'a2:' + r.src, M: 'p:' + r.path.join('>'), R: r.pt, n: r.n, alt: 0 }));
    }
    return A.routes.map(r => ({ L: r.key, M: r.via, R: r.pt, n: r.n, alt: r.alt, fmts: r.fmts }));
  }

  // A station's bar takes the colour of the format most of its bursts came
  // in, when that is not ALERT Binary: an iFLOWS station stands out in orange.
  function stationCls(rows, l) {
    const f = {};
    rows.forEach(r => { if (r.L === l && r.fmts) Object.entries(r.fmts).forEach(([k, n]) => { f[k] = (f[k] || 0) + n; }); });
    const top = Object.entries(f).sort((a, b) => b[1] - a[1])[0];
    return top && top[0] === 'EIF' ? 'sr-c-iflows' : top && top[0] === 'ASCII' ? 'sr-c-ascii' : 'sr-c-station';
  }

  function flowModel(A) {
    const rows = flowRows(A);
    const total = rows.reduce((t, r) => t + r.n, 0);
    if (!total) return null;
    const sum = (key) => { const m = new Map(); rows.forEach(r => m.set(r[key], (m.get(r[key]) || 0) + r.n)); return m; };
    const lTot = sum('L'), mTot = sum('M'), rTot = sum('R');
    // The left column: the busiest stations, or every one through what is
    // picked; the rest as one node.
    const p = S.pick;
    let leftKeep;
    if (p && p.col === 'm') leftKeep = new Set([...lTot.entries()].filter(([l]) => rows.some(r => r.L === l && r.M === p.id)).sort((a, b) => b[1] - a[1]).slice(0, LEFT_PICKED).map(e => e[0]));
    else if (p && p.col === 'r') leftKeep = new Set([...lTot.entries()].filter(([l]) => rows.some(r => r.L === l && r.R === p.id)).sort((a, b) => b[1] - a[1]).slice(0, LEFT_PICKED).map(e => e[0]));
    else leftKeep = new Set([...lTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, LEFT_MAX).map(e => e[0]));
    if (p && p.col === 'l') leftKeep.add(p.id);
    const OTHER = '~other';
    const lOf = l => (leftKeep.has(l) ? l : OTHER);
    const others = [...lTot.keys()].filter(l => !leftKeep.has(l)).length;
    // Middle first by kind (direct, repeaters, then the rest), then by size.
    const mRank = m => (m === 'own' || m === 'p:' ? 0 : m.startsWith('rep:') || m.startsWith('p:') ? 1 : m.startsWith('unk:') ? 2 : 3);
    const mids = [...mTot.keys()].sort((a, b) => mRank(a) - mRank(b) || mTot.get(b) - mTot.get(a));
    const rights = [...rTot.keys()].sort((a, b) => rTot.get(b) - rTot.get(a));
    const mPos = new Map(mids.map((m, i) => [m, i]));
    // The left in the order of where their flows go, so ribbons cross less.
    const bary = new Map();
    rows.forEach(r => { const l = lOf(r.L); const b = bary.get(l) || { s: 0, n: 0 }; b.s += mPos.get(r.M) * r.n; b.n += r.n; bary.set(l, b); });
    const lefts = [...bary.keys()].sort((a, b) => (a === OTHER) - (b === OTHER) || bary.get(a).s / bary.get(a).n - bary.get(b).s / bary.get(b).n);
    // Links, merged.
    const lm = new Map(), mr = new Map();
    rows.forEach(r => {
      const l = lOf(r.L);
      const k1 = l + '\u0001' + r.M, k2 = r.M + '\u0001' + r.R;
      const a = lm.get(k1) || { s: l, t: r.M, n: 0, alt: 0, Ls: new Set(), Rs: new Set() };
      a.n += r.n; a.alt += r.alt; a.Ls.add(r.L); a.Rs.add(r.R); lm.set(k1, a);
      const b = mr.get(k2) || { s: r.M, t: r.R, n: 0, alt: 0, Ls: new Set(), Rs: new Set() };
      b.n += r.n; b.alt += r.alt; b.Ls.add(r.L); b.Rs.add(r.R); mr.set(k2, b);
    });
    const lVal = new Map(); rows.forEach(r => lVal.set(lOf(r.L), (lVal.get(lOf(r.L)) || 0) + r.n));
    const nodes = [];
    const add = (col, id, value, name, cls) => { nodes.push({ col, id, value, name, cls, i: nodes.length }); return nodes[nodes.length - 1]; };
    lefts.forEach(l => add('l', l, lVal.get(l), l === OTHER ? `${plural(others, 'other station')}` : keyName(A.reg, l),
      S.mode === 'alert2' ? 'sr-c-alert2' : l === OTHER ? 'sr-c-station' : stationCls(rows, l)));
    mids.forEach(m => add('m', m, mTot.get(m), viaWord(A, m, true), viaCls(m)));
    rights.forEach(r => add('r', r, rTot.get(r), rxLong(A, r), 'sr-c-receiver'));
    return { total, nodes, lm: [...lm.values()], mr: [...mr.values()], others, stationsShown: lefts.filter(l => l !== OTHER).length, stations: lTot.size, OTHER };
  }

  // A Sankey of three columns. Each node's height is its share of the bursts;
  // a node too small for its label keeps a 14 px slot, so labels never sit on
  // each other. Every link is a ribbon from its share of one node to its share
  // of the next.
  function flowSvg(A) {
    const F = flowModel(A);
    S.flow = F;
    if (!F) return '<p class="small">Nothing to draw for this protocol in this period.</p>';
    const W = 1000, TOP = 26, GAP = 5, SLOT = 14, NW = 12;
    const X = { l: 250, m: 520, r: 760 };
    const cols = ['l', 'm', 'r'].map(c => F.nodes.filter(n => n.col === c));
    const most = Math.max(...cols.map(c => c.length));
    const target = Math.max(300, most * 17);
    const k = (target - GAP * (most - 1)) / F.total;
    let H = 0;
    cols.forEach(col => {
      let y = TOP;
      col.forEach(n => { n.h = Math.max(1.5, n.value * k); n.y = y; n.slot = Math.max(n.h, SLOT); y += n.slot + GAP; });
      H = Math.max(H, y);
    });
    H += 8;
    const byId = new Map(F.nodes.map(n => [n.col + '\u0001' + n.id, n]));
    const node = (c, id) => byId.get(c + '\u0001' + id);
    const p = S.pick;
    const lit = l => !p || (p.col === 'm' && (l.s === p.id || l.t === p.id)) || (p.col === 'l' && (l.Ls.has(p.id) || l.s === p.id))
      || (p.col === 'r' && (l.Rs.has(p.id) || l.t === p.id));
    const ribbons = (links, sc, tc) => {
      const out = [];
      const so = new Map(), to = new Map();
      links.slice().sort((a, b) => node(tc, a.t).y - node(tc, b.t).y || node(sc, a.s).y - node(sc, b.s).y).forEach(l => {
        const s = node(sc, l.s), t = node(tc, l.t);
        if (!s || !t) return;
        const w = l.n * k;
        const sy = s.y + (so.get(s) || 0), ty = t.y + (to.get(t) || 0);
        so.set(s, (so.get(s) || 0) + w); to.set(t, (to.get(t) || 0) + w);
        out.push({ l, s, t, w, sy, ty });
      });
      // Draw the lit ones last, over the faded.
      return out.sort((a, b) => lit(a.l) - lit(b.l)).map(({ l, s, t, w, sy, ty }) => {
        const x0 = X[sc] + NW, x1 = X[tc], xm = (x0 + x1) / 2, ww = Math.max(w, 0.8);
        const mid = sc === 'm' ? s : t;
        const d = `M${x0},${sy.toFixed(1)}C${xm},${sy.toFixed(1)} ${xm},${ty.toFixed(1)} ${x1},${ty.toFixed(1)}`
          + `L${x1},${(ty + ww).toFixed(1)}C${xm},${(ty + ww).toFixed(1)} ${xm},${(sy + ww).toFixed(1)} ${x0},${(sy + ww).toFixed(1)}Z`;
        const tip = `${s.name} → ${t.name}: ${num(l.n)} ${S.mode === 'alert2' ? 'records' : 'bursts'}${l.alt ? ` (${num(l.alt)} not ALERT Binary)` : ''}`;
        return `<path class="sr-link ${mid.cls}${lit(l) ? '' : ' is-faded'}" d="${d}"><title>${esc(tip)}</title></path>`;
      }).join('');
    };
    const labels = F.nodes.map(n => {
      const x = X[n.col];
      const sel = p && p.col === n.col && p.id === n.id;
      const tx = n.col === 'l' ? x - 6 : x + NW + 6, anchor = n.col === 'l' ? 'end' : 'start';
      const ty = n.y + Math.min(n.h, n.slot) / 2 + 4;
      const max = n.col === 'm' ? 38 : 34;
      const name = n.name.length > max ? n.name.slice(0, max - 1) + '…' : n.name;
      return `<g class="sr-node${sel ? ' is-picked' : ''}" onclick="SignalRoutes.pickNode(${n.i})">
        <rect class="${n.cls}" x="${x}" y="${n.y.toFixed(1)}" width="${NW}" height="${n.h.toFixed(1)}" rx="2"></rect>
        <text class="chart-text sr-label" x="${tx}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${esc(name)} <tspan class="chart-muted">${num(n.value)}</tspan></text>
        <title>${esc(`${n.name}: ${num(n.value)} ${S.mode === 'alert2' ? 'records' : 'bursts'} (${pct(n.value, F.total)})`)}</title>
      </g>`;
    }).join('');
    const heads = [['l', S.mode === 'alert2' ? 'ALERT2 source' : 'Sent by'], ['m', S.mode === 'alert2' ? 'Path (repeaters it came through)' : 'On the air from'], ['r', 'Heard on']]
      .map(([c, t]) => `<text class="chart-muted sr-head" x="${c === 'l' ? X.l + NW : X[c]}" y="14" text-anchor="${c === 'l' ? 'end' : 'start'}">${esc(t)}</text>`).join('');
    return `<div class="chart-scroll sr-flow-scroll" role="region" tabindex="0" aria-label="Route diagram, ${num(Math.round(W))} units wide — scroll sideways to read the whole of it; the table under it holds the same">
      <svg class="sr-flow" viewBox="0 0 ${W} ${Math.ceil(H)}" role="img" aria-label="${escAttr(flowHeadline(A, F))}">
        ${heads}${ribbons(F.lm, 'l', 'm')}${ribbons(F.mr, 'm', 'r')}${labels}
      </svg></div>`;
  }

  function flowHeadline(A, F) {
    if (S.mode === 'alert2') {
      return `ALERT2 routes: ${num(F.total)} records decoded from ${plural(A.a2.sources.size, 'source')}, through ${plural(F.nodes.filter(n => n.col === 'm').length, 'path')}, on ${plural(F.nodes.filter(n => n.col === 'r').length, 'receiver')}.`;
    }
    const h = A.legacy.how, m = A.legacy.measured || 1;
    return `Legacy ALERT routes: ${num(F.total)} bursts from ${plural(F.stations, 'station')} — ${pct(h.own, m)} of those measured heard direct, `
      + `${pct(h.repeater, m)} on ${plural(A.reps.length, 'repeater')}'s carrier${A.reps.length === 1 ? '' : 's'}, ${pct(h.unexplained, m)} copies no repeater on record explains.`;
  }

  function routesHtml(A) {
    const modes = [['alert', 'Legacy ALERT — by carrier'], ['alert2', 'ALERT2 — by path']];
    const F0 = flowRows(A);
    const mids = [...new Set(F0.map(r => r.M))];
    const mTot = new Map(); F0.forEach(r => mTot.set(r.M, (mTot.get(r.M) || 0) + r.n));
    mids.sort((a, b) => mTot.get(b) - mTot.get(a));
    const rxs = [...new Set(F0.map(r => r.R))];
    const chip = (col, id, word, n) => {
      const on = S.pick && S.pick.col === col && S.pick.id === id;
      return `<button class="btn btn-sm${on ? ' btn-primary' : ''}" aria-pressed="${on}" onclick="SignalRoutes.pick('${col}', ${escAttr(JSON.stringify(id))})">${esc(word)} <span class="small">${num(n)}</span></button>`;
    };
    return `<div class="control-row" role="group" aria-label="Protocol">
        ${modes.map(([m, w]) => `<button class="btn${S.mode === m ? ' btn-primary' : ''}" aria-pressed="${S.mode === m}" onclick="SignalRoutes.setMode('${m}')">${esc(w)}</button>`).join('')}
      </div>
      ${mids.length ? `<div class="control-row sr-chips" role="group" aria-label="Pick what they came through"><span class="small">${S.mode === 'alert2' ? 'Path:' : 'Through:'}</span>
        ${mids.slice(0, 16).map(m => chip('m', m, viaWord(A, m), mTot.get(m))).join('')}</div>` : ''}
      ${rxs.length > 1 ? `<div class="control-row sr-chips" role="group" aria-label="Pick a receiver"><span class="small">Heard on:</span>
        ${rxs.map(r => chip('r', r, rxName(A, r), F0.filter(x => x.R === r).reduce((t, x) => t + x.n, 0))).join('')}</div>` : ''}
      ${S.pick ? `<p class="small">Showing <b>${esc(pickName(A))}</b>. <button class="link-btn" onclick="SignalRoutes.pick(null)">Show everything</button></p>` : ''}
      ${flowSvg(A)}
      ${keyHtml()}
      ${routeTableHtml(A)}`;
  }

  function pickName(A) {
    const p = S.pick;
    if (!p) return '';
    if (p.col === 'l') return keyName(A.reg, p.id);
    if (p.col === 'm') return viaWord(A, p.id);
    return rxLong(A, p.id);
  }

  function keyHtml() {
    const sw = (cls, word) => `<span class="sr-key"><span class="sr-sw ${cls}" aria-hidden="true"></span>${esc(word)}</span>`;
    return `<p class="small sr-keys">${S.mode === 'alert2'
      ? sw('sr-c-alert2', 'ALERT2, by the path the PDU names')
      : sw('sr-c-direct', 'heard direct, on its own carrier') + sw('sr-c-relay', 'on a repeater\'s carrier — that repeater relayed it')
        + sw('sr-c-unexplained', 'a copy no repeater on record explains') + sw('sr-c-unmeasured', 'carrier not measured')
        + sw('sr-c-iflows', 'a station\'s bar in orange: it sent Enhanced iFLOWS')}</p>`;
  }

  function routeTableHtml(A) {
    const p = S.pick;
    let rows;
    if (S.mode === 'alert2') {
      rows = A.a2.routes.filter(r => !p || (p.col === 'l' && p.id === 'a2:' + r.src) || (p.col === 'm' && p.id === 'p:' + r.path.join('>')) || (p.col === 'r' && p.id === r.pt));
    } else {
      // A station a row, its ways in beside it.
      const by = new Map();
      A.routes.forEach(r => {
        if (p && !((p.col === 'l' && p.id === r.key) || (p.col === 'm' && p.id === r.via) || (p.col === 'r' && p.id === r.pt))) return;
        let x = by.get(r.key);
        if (!x) by.set(r.key, x = { key: r.key, n: 0, addrs: new Set(), via: new Map(), pts: new Set() });
        x.n += r.n; x.addrs.add(r.a); x.pts.add(r.pt);
        x.via.set(r.via, (x.via.get(r.via) || 0) + r.n);
      });
      rows = [...by.values()].sort((a, b) => b.n - a.n);
    }
    const shown = S.allRoutes ? rows : rows.slice(0, 40);
    if (!rows.length) return '';
    // From the nearest of the base stations whose receivers heard it.
    const fromBase = (st, pts) => {
      const d = [...pts].map(id => { const p = A.pointById.get(id); return p && p.host ? km(st, p.host) : null; }).filter(x => x != null);
      return d.length ? Math.min(...d) : null;
    };
    const body = S.mode === 'alert2'
      ? shown.map(r => {
        const s = A.a2.sources.get(r.src);
        return `<tr><th scope="row"><button class="link-btn" onclick="SignalRoutes.pick('l', ${escAttr(JSON.stringify('a2:' + r.src))})">${esc(keyName(A.reg, 'a2:' + r.src))}</button>
          ${s && s.carried.size ? `<br><span class="small">carries ${plural(s.carried.size, 'ALERT address', 'ALERT addresses')}</span>` : ''}</th>
          <td>${esc(viaWord(A, 'p:' + r.path.join('>')))}</td><td>${esc(rxLong(A, r.pt))}</td><td class="num">${num(r.n)}</td><td class="num">${num(r.dup)}</td></tr>`;
      }).join('')
      : shown.map(r => {
        const st = keyStation(A.reg, r.key);
        const d = fromBase(st, r.pts);
        const ways = [...r.via.entries()].sort((a, b) => b[1] - a[1]);
        return `<tr><th scope="row"><button class="link-btn" onclick="SignalRoutes.pick('l', ${escAttr(JSON.stringify(r.key))})">${esc(keyName(A.reg, r.key))}</button>
            <br><span class="small">${[...r.addrs].sort((a, b) => a - b).map(a => esc(String(a))).join(', ')}</span></th>
          <td>${ways.map(([v, n]) => `<span class="sr-sw ${viaCls(v)}" aria-hidden="true"></span>${esc(viaWord(A, v))} <span class="small">${num(n)}</span>`).join('<br>')}</td>
          <td class="small">${[...r.pts].map(x => esc(rxName(A, x))).join(', ')}</td><td class="num">${num(r.n)}</td><td class="num">${kmText(d)}</td></tr>`;
      }).join('');
    return `<details class="sr-table-fold"${S.pick ? ' open' : ''}><summary>The routes as a table — ${plural(rows.length, S.mode === 'alert2' ? 'route' : 'station')}</summary>
      <div class="table-wrap tall" role="region" tabindex="0" aria-label="The routes, busiest first">
        <table class="hl-table sr-routes">
          <caption class="sr-only">${S.mode === 'alert2' ? 'Each ALERT2 source, the path its PDUs named and the receiver that decoded them' : 'Each station heard, the ways its bursts came in — direct or the repeater whose carrier they sat on — the receivers and how far it is from the base station'}</caption>
          <thead><tr>${S.mode === 'alert2'
            ? '<th scope="col">Source</th><th scope="col">Path</th><th scope="col">Heard on</th><th scope="col" class="num">Records</th><th scope="col" class="num">Repeats</th>'
            : '<th scope="col">Station and its addresses</th><th scope="col">Came in</th><th scope="col">Heard on</th><th scope="col" class="num">Bursts</th><th scope="col" class="num">From the base</th>'}</tr></thead>
          <tbody>${body}</tbody></table></div>
      ${rows.length > shown.length ? `<p><button class="btn" onclick="SignalRoutes.showAll()">Show all ${num(rows.length)}</button></p>` : ''}</details>`;
  }

  // ── Pass ranges against the air ───────────────────────────────────────────

  function passHtml(A) {
    if (!A.reps.length) {
      return `<p class="small">No repeater's carrier was found in this period: none of the register's repeaters had 4 or more of the addresses it passes
        heard on one carrier by one receiver in a day${A.legacy.measured ? '' : ' — and no burst came with a carrier offset (RPi ALERT 0.14 or later measures them)'}.</p>
        ${relaysHtml(A)}`;
    }
    const rows = A.reps.map(r => {
      const conf = r.confirmed.size, else_ = r.elsewhere.size, copies = r.offrec.filter(o => o.evidence === 'copies').length, poss = r.offrec.filter(o => o.evidence === 'possible').length;
      const sel = S.rep === r.rid;
      return `<tr class="${sel ? 'is-selected' : ''}">
        <th scope="row"><button class="link-btn" aria-pressed="${sel}" onclick="SignalRoutes.pickRep(${escAttr(JSON.stringify(r.rid))})">${esc(r.name)}</button>
          <br><span class="small">${r.ranges.map(q => `${q.low}–${q.high}`).join(', ') || 'no pass ranges'}${r.exclusions.length ? ` · except ${r.exclusions.map(q => `${q.low}–${q.high}`).join(', ')}` : ''}</span></th>
        <td class="num">${r.centre == null ? '—' : `${r.centre > 0 ? '+' : ''}${Math.round(r.centre)} Hz`}${r.spread > 40 ? `<br><span class="small">±${Math.round(r.spread / 2)} over the days</span>` : ''}</td>
        <td class="num">${num(r.days)}</td>
        <td class="num">${num(conf)}<br><span class="small">${num(r.n)} bursts</span></td>
        <td class="num">${else_ ? `<span class="txt-warn">${num(else_)}</span>` : '0'}</td>
        <td class="num">${copies ? `<span class="txt-bad">${num(copies)}</span>` : '0'}${poss ? `<br><span class="small">${num(poss)} possible</span>` : ''}</td>
        <td class="num">${num(r.notHeard)}</td>
      </tr>`;
    }).join('');
    const pick = S.rep ? A.repById.get(S.rep) : null;
    const unknown = [...A.unknownRelay.entries()].sort((a, b) => b[1] - a[1]);
    return `<p class="small">Each repeater whose carrier a receiver found, its pass ranges on record set against what came in on that carrier.
        <b>On its carrier</b>: addresses in its ranges heard relayed by it — the record confirmed. <b>Heard another way</b>: in its ranges, heard on a day its
        carrier was found, never on it — it does not relay them here (they come direct, or through another repeater), or its radio's ranges are not the
        record's. <b>Off its record</b>: addresses on its carrier that no range on record includes — copies arriving a second after the original, on its
        carrier, are it relaying them; <i>possible</i> is every burst of an address sitting on its carrier with no copy to prove it, which a station whose
        own carrier happens to sit within 30 Hz also does.</p>
      <div class="table-wrap" role="region" tabindex="0" aria-label="Repeaters whose carrier was found, against their pass ranges">
        <table class="hl-table sr-reps">
          <caption class="sr-only">Repeaters whose carrier was found, with their pass ranges on record, the carrier's offset, the days it was found, the addresses heard on it that its ranges hold, those in its ranges heard only another way, those on its carrier outside every range, and those in its ranges not heard at all</caption>
          <thead><tr><th scope="col">Repeater and its ranges on record</th><th scope="col" class="num">Carrier</th><th scope="col" class="num">Days found</th>
            <th scope="col" class="num">On its carrier</th><th scope="col" class="num">Heard another way</th><th scope="col" class="num">Off its record</th>
            <th scope="col" class="num">In range, not heard</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      <h4 class="sr-sub">Each repeater's address space</h4>
      <p class="small sr-keys"><span class="sr-key"><span class="sr-sw sr-c-range" aria-hidden="true"></span>a pass range on record</span>
        <span class="sr-key"><span class="sr-sw sr-c-relay" aria-hidden="true"></span>on its carrier</span>
        <span class="sr-key"><span class="sr-sw sr-c-elsewhere" aria-hidden="true"></span>heard another way</span>
        <span class="sr-key"><span class="sr-sw sr-c-unexplained" aria-hidden="true"></span>off its record, with copies</span>
        <span class="sr-key"><span class="sr-sw sr-c-possible" aria-hidden="true"></span>off its record, possible</span></p>
      ${(pick ? [pick] : A.reps.slice(0, 12)).map(r => rulerHtml(A, r)).join('')}
      ${!pick && A.reps.length > 12 ? `<p class="small">The busiest 12 drawn; pick a repeater in the table for any other.</p>` : ''}
      ${pick ? repDetailHtml(A, pick) : ''}
      ${relaysHtml(A)}
      ${unknown.length ? `<details class="sr-fold"><summary>Other copies on no repeater's carrier — ${plural(unknown.length, 'address', 'addresses')}</summary>
        <p class="small">Copies arriving a second after their original, on a carrier no repeater was found on, too few on any one carrier to call it a relay.</p>
        <ul class="hl-plain">${unknown.slice(0, 40).map(([a, n]) => `<li>${esc(keyName(A.reg, stationKey(A.reg, a)))} — <b>${esc(String(a))}</b>, ${plural(n, 'copy', 'copies')}</li>`).join('')}</ul></details>` : ''}`;
  }

  // Copies gathered on one carrier that no repeater on record explains.
  function relaysHtml(A) {
    if (!A.relays.length) return '';
    const name = a => keyName(A.reg, stationKey(A.reg, a));
    const rname = rid => (A.reg.byId.get(rid) || {}).name || rid;
    return `<h4 class="sr-sub" id="sr-h-relays">Relays no repeater on record explains</h4>
      <p class="small">Copies of readings, each arriving a second after its original, gathered on one carrier: a transmitter relaying these addresses
        that the day's found carriers and the pass ranges on record do not account for. When a register repeater's carrier was found at the same offset on
        this receiver on another day, it is probably that repeater — its carrier went unfound on these days because too few of the addresses its ranges
        hold were heard on it, which is itself a sign its ranges on record are wider than what it relays. Otherwise it is a transmitter the register has no
        carrier for.</p>
      <ul class="hl-plain sr-relays">${A.relays.slice().sort((p, q) => q.n - p.n).map(m => {
        const addrs = [...m.addrs.entries()].sort((p, q) => q[1] - p[1]);
        const lk = m.likely;
        return `<li><b>${esc(hz(m.centre))}</b> on ${esc(rxLong(A, m.pt))}, ${plural(m.days.size, 'day')} — ${plural(m.n, 'copy', 'copies')} of
          ${plural(addrs.length, 'address', 'addresses')}.
          ${lk ? `<b>Probably ${esc(rname(lk.rid))}</b>: its carrier was found at ${lk.seen.centres.slice(0, 4).map(c => esc(hz(c))).join(', ')} here on
            ${plural(lk.seen.days.size, 'day')}; its ranges on record hold ${num(lk.holds)} of the ${num(addrs.length)}${lk.holds < addrs.length ? ` — the other ${num(addrs.length - lk.holds)} are off its record` : ''}.`
            : `No repeater's carrier was found here in this period.${m.byRange.length ? ` The ranges that hold the most of them: ${m.byRange.map(x => `${esc(rname(x.rid))} (${num(x.holds)})`).join(', ')}.` : ' No range on record holds any of them.'}`}
          <button class="link-btn" onclick="SignalRoutes.pick('m', 'unk:${m.id}'); SignalRoutes.scrollTo('sr-h-routes')">Its routes</button>
          <details class="sr-fold"><summary>The addresses</summary><ul class="hl-plain sr-cols">${addrs.map(([a, n]) => `<li><b>${esc(String(a))}</b> ${esc(name(a))} <span class="small">${num(n)}</span></li>`).join('')}</ul></details></li>`;
      }).join('')}</ul>`;
  }

  // The address space a repeater's ranges cover, squeezed: each range (and
  // each off-record address) a segment drawn to scale, with the empty stretch
  // between segments cut out.
  function rulerHtml(A, r) {
    const W = 720, H = 66, PADX = 8, GAPW = 14, CH = 5.4;   // CH: a 9 px digit's width, for labels that must not collide
    const spans = r.ranges.map(q => [q.low, q.high, true]);
    r.offrec.forEach(o => spans.push([o.a - 2, o.a + 2, false]));
    if (!spans.length) return '';
    spans.sort((a, b) => a[0] - b[0]);
    const segs = [];
    spans.forEach(([lo, hi, range]) => {
      const last = segs[segs.length - 1];
      if (last && lo <= last.hi + 20) { last.hi = Math.max(last.hi, hi); last.range = last.range || range; } else segs.push({ lo, hi, range });
    });
    const width = segs.reduce((t, s) => t + (s.hi - s.lo + 1), 0);
    const scale = (W - 2 * PADX - GAPW * (segs.length - 1)) / width;
    let x = PADX;
    segs.forEach(s => { s.x = x; x += (s.hi - s.lo + 1) * scale + GAPW; });
    const xOf = a => { const s = segs.find(q => a >= q.lo && a <= q.hi); return s ? s.x + (a - s.lo + 0.5) * scale : null; };
    const band = (q, cls) => { const x0 = xOf(q.low), x1 = xOf(q.high); return x0 == null || x1 == null ? '' : `<rect class="${cls}" x="${(x0 - scale / 2).toFixed(1)}" y="26" width="${Math.max(1.5, x1 - x0 + scale).toFixed(1)}" height="20"><title>${esc(`${cls === 'sr-c-range' ? 'Pass range' : 'Exclusion'} ${q.low}–${q.high}`)}</title></rect>`; };
    const tick = (a, cls, y0, y1, tip) => { const xx = xOf(a); return xx == null ? '' : `<line class="sr-tick ${cls}" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${y0}" y2="${y1}"><title>${esc(tip)}</title></line>`; };
    const name = a => keyName(A.reg, stationKey(A.reg, a));
    const ticks = [
      ...[...r.elsewhere.entries()].map(([a, e]) => tick(a, 'sr-c-elsewhere', 28, 44, `${a} ${name(a)}: in its range, heard ${num(e.n)} times, never on its carrier`)),
      ...[...r.confirmed.entries()].map(([a, n]) => tick(a, 'sr-c-relay', 24, 48, `${a} ${name(a)}: ${num(n)} bursts on its carrier`)),
      ...r.offrec.map(o => tick(o.a, o.evidence === 'copies' ? 'sr-c-unexplained' : 'sr-c-possible', 16, 54,
        `${o.a} ${name(o.a)}: on its carrier but in no range on record — ${num(o.dup)} copies, ${num(o.own)} other bursts`)),
    ].join('');
    // Labels left to right, each dropped when it would sit on the one before:
    // a range's two ends under it, an off-record address over its tick.
    const placeLabels = (items, y) => {
      let right = -Infinity;
      return items.sort((p, q) => p.x - q.x).map(it => {
        const w = String(it.text).length * CH, left = it.anchor === 'end' ? it.x - w : it.anchor === 'middle' ? it.x - w / 2 : it.x;
        if (left < right + 4) return '';
        right = left + w;
        return `<text class="${it.cls} sr-axis" x="${it.x.toFixed(1)}" y="${y}"${it.anchor !== 'start' ? ` text-anchor="${it.anchor}"` : ''}>${esc(String(it.text))}</text>`;
      }).join('');
    };
    const under = [];
    r.ranges.forEach(q => {
      const x0 = xOf(q.low), x1 = xOf(q.high);
      if (x0 == null || x1 == null) return;
      under.push({ x: x0 - scale / 2, text: q.low, anchor: 'start', cls: 'chart-muted' });
      if (q.high !== q.low) under.push({ x: x1 + scale / 2, text: q.high, anchor: 'end', cls: 'chart-muted' });
    });
    const over = r.offrec.map(o => ({ x: xOf(o.a), text: o.a, anchor: 'middle', cls: 'chart-text' })).filter(it => it.x != null);
    const axis = placeLabels(under, H - 2) + placeLabels(over, 11);
    const label = `${r.name}: ${plural(r.confirmed.size, 'address', 'addresses')} on its carrier, ${num(r.elsewhere.size)} in its ranges heard another way, `
      + `${num(r.offrec.filter(o => o.evidence === 'copies').length)} off its record with copies`;
    return `<figure class="sr-ruler"><figcaption class="small"><b>${esc(r.name)}</b> — ${esc(label.slice(r.name.length + 2))}</figcaption>
      <div class="chart-scroll" role="region" tabindex="0" aria-label="${escAttr(`${r.name}'s address space — scroll sideways for the whole of it`)}">
      <svg viewBox="0 0 ${W} ${H + 4}" role="img" aria-label="${escAttr(label)}">
        ${r.ranges.map(q => band(q, 'sr-c-range')).join('')}${r.exclusions.map(q => band(q, 'sr-c-excl')).join('')}${ticks}${axis}
      </svg></div></figure>`;
  }

  function repDetailHtml(A, r) {
    const name = a => keyName(A.reg, stationKey(A.reg, a));
    const conf = [...r.confirmed.entries()].sort((a, b) => a[0] - b[0]);
    const els = [...r.elsewhere.entries()].sort((a, b) => b[1].n - a[1].n);
    const st = r.st;
    return `<div class="sr-detail">
      <p class="small">${esc(r.name)}: carrier ${r.centre == null ? '—' : `${r.centre > 0 ? '+' : ''}${Math.round(r.centre)} Hz`} from the channel, found on
        ${plural(r.days, 'day')} by ${r.pts.map(x => esc(rxLong(A, x))).join(', ')}. ${r.rx != null || r.tx != null ? `On record it listens on ${esc(String(r.rx ?? '—'))} and sends on ${esc(String(r.tx ?? '—'))} MHz.` : ''}
        ${st && typeof goToStation === 'function' ? `<button class="link-btn" onclick="goToStation(${escAttr(JSON.stringify(st.id))})">Open it in Stations</button>` : ''}
        <button class="link-btn" onclick="SignalRoutes.pick('m', ${escAttr(JSON.stringify('rep:' + r.rid))}); SignalRoutes.scrollTo('sr-h-routes')">Its routes</button></p>
      ${r.offrec.length ? `<h5>Off its record</h5><ul class="hl-plain">${r.offrec.map(o => `<li class="${o.evidence === 'copies' ? 'txt-bad' : ''}"><b>${esc(String(o.a))}</b> ${esc(name(o.a))} —
        ${o.evidence === 'copies' ? `${plural(o.dup, 'copy', 'copies')} on its carrier a second after the original: it relays this address, and no range on record says so`
          : `${plural(o.own, 'burst')} on its carrier, no copies: it may relay it, or the station's own carrier sits within 30 Hz of this one`}</li>`).join('')}</ul>` : ''}
      ${els.length ? `<h5>In its ranges, heard another way</h5><ul class="hl-plain">${els.slice(0, 40).map(([a, e]) => `<li><b>${esc(String(a))}</b> ${esc(name(a))} — ${num(e.n)} heard:
        ${[e.own ? `${num(e.own)} direct` : '', ...[...e.other.entries()].map(([rid, n]) => `${num(n)} through ${esc((A.reg.byId.get(rid) || {}).name || rid)}`)].filter(Boolean).join(', ')}</li>`).join('')}</ul>` : ''}
      ${conf.length ? `<details class="sr-fold"><summary>On its carrier — ${plural(conf.length, 'address', 'addresses')}</summary>
        <ul class="hl-plain sr-cols">${conf.map(([a, n]) => `<li><b>${esc(String(a))}</b> ${esc(name(a))} <span class="small">${num(n)}</span></li>`).join('')}</ul></details>` : ''}
      <p class="small">${plural(r.notHeard, 'address', 'addresses')} in its ranges belong${r.notHeard === 1 ? 's' : ''} to a station in the register and ${r.notHeard === 1 ? 'was' : 'were'} not heard by any receiver in this period.</p>
    </div>`;
  }

  // ── Protocols and formats ─────────────────────────────────────────────────

  function protoHtml(A) {
    const L = A.legacy, f = L.fmts;
    const eif = f.EIF || 0, ascii = f.ASCII || 0;
    const eifPts = A.points.filter(p => p.fmts.EIF);
    const verdict = !L.ok ? 'No legacy ALERT was decoded in this period.'
      : eif ? `<b>${num(eif)} legacy frame${eif === 1 ? '' : 's'} decoded as Enhanced iFLOWS</b>, on ${eifPts.map(p => esc(rxLong(A, p.id))).join(', ')} —
          ${pct(eif, L.ok)} of the legacy frames; the rest ALERT Binary${ascii ? ` and ${num(ascii)} ASCII` : ''}.`
      : `<b>No Enhanced iFLOWS.</b> Every one of the ${num(L.ok)} legacy frames decoded was ${ascii ? `ALERT Binary but ${num(ascii)} ASCII` : 'ALERT Binary'}${f.other ? ` (${num(f.other)} from a receiver that does not say)` : ''}.`;
    const totalA2 = A.a2.ok;
    // A bar a receiver, each its own whole: what it heard, split by protocol
    // and format, with how many beside it. ALERT2 counts records, legacy
    // bursts, so one scale for all would hide the legacy channels' mix.
    const W = 720, ROW = 26, LABEL = 230, TOT = 70;
    const pts = A.points.filter(p => p.total);
    const seg = [['ABF', 'sr-c-binary'], ['EIF', 'sr-c-iflows'], ['ASCII', 'sr-c-ascii'], ['other', 'sr-c-other']];
    const bars = pts.map((p, i) => {
      const y = i * ROW + 4;
      let x = LABEL;
      const parts = seg.map(([k, cls]) => [p.fmts[k] || 0, cls, fmtLabel(k)]).concat([[p.a2ok, 'sr-c-alert2', 'ALERT2 records'], [p.bad + p.a2bad, 'sr-c-failed', 'heard, not decoded']]);
      const rects = parts.filter(q => q[0] > 0).map(([n, cls, word]) => {
        const w = Math.max(1, (n / p.total) * (W - LABEL - TOT));
        const r = `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW - 8}"><title>${esc(`${rxLong(A, p.id)}: ${num(n)} ${word} (${pct(n, p.total)})`)}</title></rect>`;
        x += w;
        return r;
      }).join('');
      const name = rxName(A, p.id);
      return `<text class="chart-text sr-label" x="${LABEL - 6}" y="${y + 13}" text-anchor="end">${esc(name.length > 36 ? name.slice(0, 35) + '…' : name)}</text>${rects}
        <text class="chart-muted sr-label" x="${(W - TOT + 6).toFixed(1)}" y="${y + 13}">${num(p.total)}</text>`;
    }).join('');
    const tbl = pts.map(p => `<tr><th scope="row">${esc(rxLong(A, p.id))}</th><td class="num">${p.freq != null ? Number(p.freq).toFixed(4).replace(/(\.\d{3})0$/, '$1') : '—'}</td>
        <td>${p.fmt ? esc(fmtLabel(p.fmt)) : p.a2ok ? 'ALERT2 only' : '—'}</td>
        <td class="num">${num(p.fmts.ABF || 0)}</td><td class="num">${num(p.fmts.EIF || 0)}</td><td class="num">${num(p.fmts.ASCII || 0)}</td>
        <td class="num">${num(p.a2ok)}</td><td class="num">${num(p.bad + p.a2bad)}</td></tr>`).join('');
    const mix = A.mix, mt = mix.legacyOnly + mix.both + mix.a2Only;
    const mixBar = mt ? (() => {
      let x = 0;
      return `<svg class="sr-mix" viewBox="0 0 ${W} 30" role="img" aria-label="${escAttr(`Of ${num(mt)} stations heard: ${num(mix.legacyOnly)} on legacy ALERT only, ${num(mix.both)} both ways, ${num(mix.a2Only)} on ALERT2 only`)}">
        ${[[mix.legacyOnly, 'sr-c-binary', 'legacy ALERT only'], [mix.both, 'sr-c-both', 'both ways'], [mix.a2Only, 'sr-c-alert2', 'ALERT2 only']].filter(q => q[0]).map(([n, cls, w]) => {
          const ww = (n / mt) * W; const r = `<rect class="${cls}" x="${x.toFixed(1)}" y="2" width="${ww.toFixed(1)}" height="26"><title>${esc(`${num(n)} stations: ${w}`)}</title></rect>`; x += ww; return r;
        }).join('')}</svg>`;
    })() : '';
    const both = [...A.stations.values()].filter(s => s.n && s.a2n).sort((a, b) => b.n - a.n);
    const srcs = [...A.a2.sources.values()].sort((a, b) => b.carried.size - a.carried.size || b.n - a.n);
    return `<p>${verdict}</p>
      <p class="small">Each SDR channel is decoded in the one format set for it (RPi ALERT's <i>format</i>): Enhanced iFLOWS read off a strong Binary burst
        makes ghosts with a good CRC, so no channel tries both. So an iFLOWS station on a channel set to Binary would not show as iFLOWS here — it would show
        as bursts heard and not decoded, the grey below. A Quansheng radio decodes both and says which. ALERT2 is tried on every burst no legacy format reads.</p>
      ${pts.length ? `<div class="chart-scroll" role="region" tabindex="0" aria-label="What each receiver decoded, by protocol and format — scroll sideways for the whole of it">
        <svg class="sr-bars" viewBox="0 0 ${W} ${pts.length * ROW + 8}" role="img" aria-label="${escAttr(`${plural(pts.length, 'receiver')}: ${num(L.ok)} legacy frames decoded, ${num(eif)} of them Enhanced iFLOWS; ${num(totalA2)} ALERT2 records`)}">${bars}</svg></div>
      <p class="small sr-keys">${seg.slice(0, 3).map(([k, cls]) => `<span class="sr-key"><span class="sr-sw ${cls}" aria-hidden="true"></span>${esc(fmtLabel(k))}</span>`).join('')}
        <span class="sr-key"><span class="sr-sw sr-c-alert2" aria-hidden="true"></span>ALERT2 (records)</span><span class="sr-key"><span class="sr-sw sr-c-failed" aria-hidden="true"></span>heard, not decoded</span></p>
      <details class="sr-table-fold"><summary>The receivers as a table</summary>
        <div class="table-wrap" role="region" tabindex="0" aria-label="What each receiver decoded">
        <table class="hl-table"><caption class="sr-only">Each receiver channel, its frequency, the format it decodes, and how many frames of each protocol and format it decoded or failed</caption>
          <thead><tr><th scope="col">Receiver</th><th scope="col" class="num">MHz</th><th scope="col">Decodes</th><th scope="col" class="num">Binary</th><th scope="col" class="num">iFLOWS</th>
            <th scope="col" class="num">ASCII</th><th scope="col" class="num">ALERT2</th><th scope="col" class="num">Not decoded</th></tr></thead>
          <tbody>${tbl}</tbody></table></div></details>` : ''}
      <h4 class="sr-sub">Which stations arrive which way</h4>
      <p class="small">Legacy over the period; ALERT2 from the PDUs of the last ${CONC_HOURS} hours, which name the legacy ALERT addresses an ALERT2
        concentrator heard and passed on${A.a2.concRows ? '' : ' — none came in that time'}.</p>
      ${mixBar}
      <p class="small sr-keys"><span class="sr-key"><span class="sr-sw sr-c-binary" aria-hidden="true"></span>legacy ALERT only — ${num(mix.legacyOnly)}</span>
        <span class="sr-key"><span class="sr-sw sr-c-both" aria-hidden="true"></span>both ways — ${num(mix.both)}</span>
        <span class="sr-key"><span class="sr-sw sr-c-alert2" aria-hidden="true"></span>ALERT2 only — ${num(mix.a2Only)}</span></p>
      ${srcs.length ? `<div class="table-wrap" role="region" tabindex="0" aria-label="ALERT2 sources">
        <table class="hl-table"><caption class="sr-only">Each ALERT2 source: the legacy addresses it carries, the paths its PDUs came by, and the receivers</caption>
          <thead><tr><th scope="col">ALERT2 source</th><th scope="col" class="num">Legacy addresses it carries</th><th scope="col">Paths</th><th scope="col" class="num">Records</th></tr></thead>
          <tbody>${srcs.slice(0, 30).map(s => `<tr><th scope="row">${esc(keyName(A.reg, 'a2:' + s.src))}</th><td class="num">${num(s.carried.size)}</td>
            <td class="small">${[...s.paths.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${esc(p ? p.split('>').map(a => a2Name(A, a)).join(' → ') : 'direct')} ${num(n)}`).join('<br>') || '—'}</td>
            <td class="num">${num(s.n)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${both.length ? `<details class="sr-fold"><summary>Stations heard both ways — ${num(both.length)}</summary>
        <ul class="hl-plain">${both.slice(0, 60).map(s => `<li>${esc(keyName(A.reg, s.key))} — legacy ${num(s.n)}, carried on ALERT2 by ${[...s.a2.keys()].map(src => esc(keyName(A.reg, 'a2:' + src))).join(', ')}</li>`).join('')}</ul></details>` : ''}`;
  }

  // ── The page ──────────────────────────────────────────────────────────────

  function statusText() {
    if (S.phase === 'loading') return `Reading receptions… ${num(S.fetched)} so far.`;
    return '';
  }
  function paintStatus() {
    const el = document.getElementById('sr-status');
    if (el) el.textContent = statusText();
  }

  function leadHtml(A) {
    const L = A.legacy, h = L.how;
    const reps = A.reps.length;
    const off = A.reps.reduce((t, r) => t + r.offrec.filter(o => o.evidence === 'copies').length, 0);
    const els = A.reps.reduce((t, r) => t + r.elsewhere.size, 0);
    const span = `${new Date(A.from).toLocaleDateString([], { day: 'numeric', month: 'short' })} to ${when(A.to)}`;
    return `<p>${A.demo ? '<b>Demo — made-up receptions on the real station file.</b> ' : ''}<b>${num(L.ok)} legacy ALERT bursts</b> and <b>${num(A.a2.ok)} ALERT2 records</b>
        decoded by ${plural(A.points.filter(p => p.total).length, 'receiver')} (${esc(span)}).
        ${L.measured ? `Of the ${num(L.measured)} legacy bursts with a carrier measured, ${pct(h.own, L.measured)} were heard direct and ${pct(h.repeater, L.measured)}
        came on the carrier of one of ${plural(reps, 'repeater')}; ${pct(h.unexplained, L.measured)} were copies no repeater on record explains.` : 'None of the legacy bursts came with a carrier measured, so who relayed them cannot be told.'}</p>
      ${reps || A.relays.length ? `<p>Against the pass ranges on record: ${off ? `<b class="txt-bad">${plural(off, 'address', 'addresses')} relayed by a repeater whose ranges do not include ${off === 1 ? 'it' : 'them'}</b>` : 'no found repeater was caught relaying an address outside its ranges'};
        ${els ? `${plural(els, 'address', 'addresses')} in a found repeater's range ${els === 1 ? 'was' : 'were'} only ever heard another way` : 'every address heard from a found repeater\'s range came through it'}${A.relays.length
          ? `; and <b class="txt-bad">${plural(A.relays.length, 'relay', 'relays')} no repeater on record explains</b>, ${plural(A.relays.reduce((t, m) => t + m.addrs.size, 0), 'address', 'addresses')} between them` : ''}.
        <button class="link-btn" onclick="SignalRoutes.scrollTo('sr-h-pass')">See Pass ranges</button></p>` : ''}
      ${A.capped ? `<p class="txt-warn small">Stopped at ${num(MAX_ROWS)} receptions — pick a shorter period for all of them.</p>` : ''}`;
  }

  function render() {
    const A = S.A;
    const out = !signedIn() && !S.demo;
    const body = out
      ? `<p>What the receivers heard is for editors — sign in as one to read it. <button class="btn" onclick="SignalRoutes.demo()">Show a demo</button></p>`
      : S.phase === 'error' ? `<p class="txt-bad" role="alert">${esc(S.err)}</p><p><button class="btn" onclick="SignalRoutes.load()">Try again</button> <button class="btn" onclick="SignalRoutes.demo()">Show a demo</button></p>`
      : S.phase === 'loading' ? `<p class="small" aria-busy="true">Asking the database for what the receivers heard…</p>`
      : !A ? `<p><button class="btn btn-primary" onclick="SignalRoutes.load()">Read the receptions</button> <button class="btn" onclick="SignalRoutes.demo()">Show a demo</button></p>`
      : leadHtml(A);
    return `
    <div class="page sr-page" style="--page-max:1200px">
      <div class="panel">
        <div class="panel-header"><h2>Signal Routes</h2><span class="small">what comes in from where</span></div>
        <p class="small txt-muted">Every burst the base stations' receivers heard, followed back to the transmitter that put it on the air: the field station
          itself, or the repeater whose carrier it came on (its carrier fingerprint); ALERT2 by the path it names. Set against the pass ranges on record, and
          split by protocol — ALERT2 or legacy ALERT, ALERT Binary or Enhanced iFLOWS.</p>
        <div class="control-row" role="group" aria-label="Period">
          ${PERIODS.map(d => `<button class="btn${S.days === d ? ' btn-primary' : ''}" aria-pressed="${S.days === d}" onclick="SignalRoutes.setDays(${d})">${d === 1 ? 'Today' : `Last ${d} days`}</button>`).join('')}
          ${signedIn() ? `<button class="btn" onclick="SignalRoutes.load()"${S.phase === 'loading' ? ' disabled' : ''}>↻ Read again</button>` : ''}
          ${S.demo ? '<span class="small">Demo</span>' : ''}
        </div>
        <p id="sr-status" class="small" role="status">${esc(statusText())}</p>
        ${body}
      </div>
      ${A ? `
      <div class="panel">
        <div class="panel-header"><h3 id="sr-h-routes">Routes</h3><span class="small">sent by → on the air from → heard on</span></div>
        ${routesHtml(A)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="sr-h-map">Map</h3><span class="small">legacy ALERT routes on the ground</span></div>
        <div class="control-row"><label class="check-label"><input type="checkbox" ${S.gaps ? 'checked' : ''} onchange="SignalRoutes.setGaps(this.checked)">
          <span>Show where pass ranges and carriers disagree</span></label></div>
        <div id="sr-map" class="sr-map" aria-label="Map of the routes: field stations joined to the repeater whose carrier they came on, or to the base station when heard direct; dashed where a repeater's pass range and its carrier disagree. The Routes table holds the same."></div>
        <p class="small sr-keys"><span class="sr-key"><span class="sr-sw sr-c-direct" aria-hidden="true"></span>direct to the base station</span>
          <span class="sr-key"><span class="sr-sw sr-c-relay" aria-hidden="true"></span>to the repeater that relayed it, and on to the base station</span>
          <span class="sr-key"><span class="sr-sw sr-c-unexplained" aria-hidden="true"></span>dashed: relayed, though no range on record says so</span>
          <span class="sr-key"><span class="sr-sw sr-c-elsewhere" aria-hidden="true"></span>dashed: in its range, never on its carrier</span>
          <span class="sr-key"><span class="sr-sw sr-c-alert2" aria-hidden="true"></span>ringed: carried on ALERT2 too</span></p>
        <p class="small">${S.pick ? `Showing ${esc(pickName(A))}.` : 'Pick a repeater or a station (in Routes, or on the map) to see only its routes.'}</p>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="sr-h-pass">Pass ranges against the air</h3><span class="small">what each repeater's carrier carried, against its record</span></div>
        ${passHtml(A)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="sr-h-proto">Protocols and formats</h3><span class="small">ALERT2 or legacy; Binary or iFLOWS</span></div>
        ${protoHtml(A)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="sr-h-read">Reading it</h3></div>
        <p class="small">A repeater sends what it relays on its own carrier, a few hundred hertz from the next transmitter's, and a base station's SDR measures
          every burst's (RPi ALERT 0.14 or later). So a burst on a repeater's carrier was relayed by that repeater; one on a carrier of its own came straight
          from its station. The rules are the server's (Station Health's Transmitter frequency): a repeater's carrier is found each day from the addresses it
          passes, so one with too few of them heard that day, or one the register does not have, is not found — its relays then count as direct, or as copies
          no repeater explains. "Direct" means not on a found repeater's carrier. A Quansheng or ERT-A2 receiver measures no carrier.</p>
        <p class="small"><button class="link-btn" onclick="switchTab('health')">Station Health</button> ·
          <button class="link-btn" onclick="switchTab('passranges')">ALERT IDs</button> ·
          <button class="link-btn" onclick="switchTab('flipsources')">Bit-Flip Sources</button> ·
          <button class="link-btn" onclick="switchTab('reception')">Reception Map</button></p>
      </div>` : ''}
    </div>`;
  }

  function redraw() {
    const host = typeof state !== 'undefined' && state.activeTab === 'signalroutes' ? document.getElementById('main-content') : null;
    if (!host) return;
    host.innerHTML = render();
    initMap();
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function stopMap() {
    if (S.map) { try { removeMap(S.map); } catch (_) { /* gone */ } }
    S.map = null; S.layer = null;
  }

  function initMap() {
    if (typeof registerTabTeardown === 'function') registerTabTeardown('SignalRoutes', stopMap);
    stopMap();
    const el = document.getElementById('sr-map');
    if (!el || typeof L === 'undefined' || !S.A) return;
    S.map = L.map('sr-map').setView([-27.4, 152.8], 8);
    if (typeof registerLiveMap === 'function') registerLiveMap('SignalRoutes', () => S.map);
    if (typeof addBaseLayers === 'function') addBaseLayers(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    drawMap();
  }

  // The page's own tokens (styles.css, .sr-page), resolved under the theme on.
  function cssVar(name, dflt) {
    try { return getComputedStyle(document.querySelector('.sr-page') || document.documentElement).getPropertyValue(name).trim() || dflt; } catch (_) { return dflt; }
  }

  function drawMap() {
    const A = S.A;
    if (!S.map || !S.layer || !A) return;
    S.layer.clearLayers();
    const col = { direct: cssVar('--sr-direct', '#0b5cab'), relay: cssVar('--sr-relay', '#00838f'), off: cssVar('--sr-unexplained', '#c7401a'),
      els: cssVar('--sr-elsewhere', '#9e5e00'), a2: cssVar('--sr-alert2', '#7c35a3'), base: cssVar('--text', '#16202a') };
    const pts = [];
    const placed = s => s && s.lat != null && s.lon != null;
    const ll = s => [Number(s.lat), Number(s.lon)];
    // Base stations at their host station.
    const bases = new Map();
    A.points.forEach(p => { if (placed(p.host)) bases.set(p.host.id, p.host); });
    const baseOf = ptId => { const p = A.pointById.get(ptId); return p && placed(p.host) ? p.host : null; };
    const p = S.pick;
    const show = r => !p || (p.col === 'l' && p.id === r.key) || (p.col === 'm' && p.id === r.via) || (p.col === 'r' && p.id === r.pt);
    const repUsed = new Map(), stDone = new Map(), lines = new Set();
    A.routes.filter(show).forEach(r => {
      const st = keyStation(A.reg, r.key), base = baseOf(r.pt);
      if (!placed(st)) return;
      const d = stDone.get(r.key) || { st, n: 0, via: new Map() };
      d.n += r.n; d.via.set(r.via, (d.via.get(r.via) || 0) + r.n); stDone.set(r.key, d);
      if (r.n < 2) return;
      if (r.via === 'own' && placed(base)) {
        const k = r.key + '>' + base.id;
        if (!lines.has(k)) { lines.add(k); L.polyline([ll(st), ll(base)], { color: col.direct, weight: 1.2, opacity: 0.55 }).bindTooltip(`${st.name} → ${base.name}, direct: ${num(r.n)} bursts`).addTo(S.layer); }
      } else if (r.via.startsWith('rep:')) {
        const rep = A.reg.byId.get(r.via.slice(4));
        if (!placed(rep)) return;
        const k = r.key + '>' + rep.id;
        if (!lines.has(k)) { lines.add(k); L.polyline([ll(st), ll(rep)], { color: col.relay, weight: 1.6, opacity: 0.7 }).bindTooltip(`${st.name} → ${rep.name}: ${num(r.n)} bursts on its carrier`).addTo(S.layer); }
        const u = repUsed.get(rep.id) || { rep, n: 0, bases: new Set() };
        u.n += r.n; if (placed(base)) u.bases.add(base); repUsed.set(rep.id, u);
      } else if (r.via.startsWith('unk:') && S.gaps) {
        // An unexplained relay put down to the repeater it probably is.
        const m = A.relays[Number(r.via.slice(4))], rep = m && m.likely ? A.reg.byId.get(m.likely.rid) : null;
        if (!placed(rep)) return;
        const k = r.key + '>?' + rep.id;
        if (!lines.has(k)) {
          lines.add(k);
          L.polyline([ll(st), ll(rep)], { color: col.off, weight: 1.6, dashArray: '6 5', opacity: 0.8 })
            .bindTooltip(`${st.name}: ${num(r.n)} copies on ${hz(m.centre)}, probably ${rep.name} relaying it`).addTo(S.layer);
        }
      }
    });
    repUsed.forEach(u => u.bases.forEach(b => {
      L.polyline([ll(u.rep), ll(b)], { color: col.relay, weight: 2 + Math.min(6, Math.sqrt(u.n) / 6), opacity: 0.85 })
        .bindTooltip(`${u.rep.name} → ${b.name}: ${num(u.n)} bursts relayed`).addTo(S.layer);
    }));
    // Where pass ranges and carriers disagree.
    if (S.gaps) {
      A.reps.filter(r => !p || (p.col === 'm' && p.id === 'rep:' + r.rid) || p.col !== 'm').forEach(r => {
        if (!placed(r.st)) return;
        r.offrec.forEach(o => {
          const st = keyStation(A.reg, o.key);
          if (!placed(st) || (p && p.col === 'l' && p.id !== o.key)) return;
          L.polyline([ll(st), ll(r.st)], { color: col.off, weight: 2, dashArray: '6 5', opacity: o.evidence === 'copies' ? 0.95 : 0.55 })
            .bindTooltip(`${st.name} on ${r.name}'s carrier, in no range on record (${num(o.dup)} copies, ${num(o.own)} other bursts)`).addTo(S.layer);
          if (!stDone.has(o.key)) stDone.set(o.key, { st, n: o.dup + o.own, via: new Map([['unexplained', o.dup + o.own]]) });
        });
        if (p && p.col === 'm' && p.id === 'rep:' + r.rid) {
          r.elsewhere.forEach((e, a) => {
            const st = keyStation(A.reg, stationKey(A.reg, a));
            if (!placed(st)) return;
            L.polyline([ll(st), ll(r.st)], { color: col.els, weight: 1.2, dashArray: '3 5', opacity: 0.8 })
              .bindTooltip(`${st.name} is in ${r.name}'s range, and was heard ${num(e.n)} times — never on its carrier`).addTo(S.layer);
          });
        }
      });
    }
    // Stations, coloured by how most of their bursts came.
    stDone.forEach((d, key) => {
      const top = [...d.via.entries()].sort((a, b) => b[1] - a[1])[0];
      const c = top ? (top[0] === 'own' ? col.direct : top[0].startsWith('rep:') ? col.relay : top[0] === 'unexplained' || top[0].startsWith('unk:') ? col.off : cssVar('--muted', '#7a8794')) : col.direct;
      const s = A.stations.get(key);
      const a2 = s && s.a2n > 0;
      const m = L.circleMarker(ll(d.st), { radius: 3 + Math.min(5, Math.sqrt(d.n) / 3), weight: a2 ? 3 : 1, color: a2 ? col.a2 : c, fillColor: c, fillOpacity: 0.75 });
      m.bindTooltip(`${d.st.name}: ${num(d.n)} bursts — ${[...d.via.entries()].map(([v, n]) => `${viaWord(A, v)} ${num(n)}`).join(', ')}${a2 ? '; carried on ALERT2 too' : ''}`);
      m.on('click', () => pick('l', key));
      m.addTo(S.layer);
      pts.push(ll(d.st));
    });
    // Repeaters whose carrier was found.
    A.reps.forEach(r => {
      if (!placed(r.st)) return;
      const sel = p && p.col === 'm' && p.id === 'rep:' + r.rid;
      const m = L.circleMarker(ll(r.st), { radius: 7 + Math.min(8, Math.sqrt(r.n) / 4), weight: sel ? 4 : 2, color: col.relay, fillColor: cssVar('--panel', '#fff'), fillOpacity: 0.95 });
      m.bindTooltip(`${r.name}: carrier found on ${plural(r.days, 'day')}, ${plural(r.confirmed.size, 'address', 'addresses')} relayed${r.offrec.length ? `, ${num(r.offrec.length)} off its record` : ''}`);
      m.on('click', () => pick('m', 'rep:' + r.rid));
      m.addTo(S.layer);
      pts.push(ll(r.st));
    });
    bases.forEach(b => {
      L.marker(ll(b), { icon: L.divIcon({ className: 'sr-base-icon', html: '<span aria-hidden="true">▣</span>', iconSize: [18, 18] }), title: b.name, alt: `Base station ${b.name}` })
        .bindTooltip(`${b.name} — the base station`).addTo(S.layer);
      pts.push(ll(b));
    });
    if (pts.length && !S.fitted) { try { S.map.fitBounds(pts, { padding: [24, 24], maxZoom: 10 }); S.fitted = true; } catch (_) { /* one point */ } }
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  // Signed in, a period is read; the demo is three days whatever is picked.
  function setDays(d) {
    S.days = PERIODS.includes(d) ? d : 3;
    if (signedIn()) load(); else redraw();
  }
  // The same read from another tab (backbone.js's pass ranges against the
  // air), which waits for it: its promise, settled once the analysis is in.
  function loadDays(d) {
    S.days = PERIODS.includes(d) ? d : 3;
    return signedIn() ? load() : Promise.resolve();
  }
  function setMode(m) { S.mode = m === 'alert2' ? 'alert2' : 'alert'; S.pick = null; S.allRoutes = false; redraw(); }
  function pick(col, id) {
    if (!col || (S.pick && S.pick.col === col && S.pick.id === id)) S.pick = null;
    else S.pick = { col, id };
    S.fitted = false;
    if (S.pick && S.pick.col === 'm' && String(S.pick.id).startsWith('rep:')) S.rep = S.pick.id.slice(4);
    redraw();
  }
  function pickNode(i) {
    const n = S.flow && S.flow.nodes[i];
    if (!n || n.id === S.flow.OTHER) return;
    pick(n.col, n.id);
  }
  function pickRep(rid) {
    S.rep = S.rep === rid ? null : rid;
    redraw();
    scrollTo('sr-h-pass');
  }
  function setGaps(on) { S.gaps = !!on; drawMap(); }
  function showAll() { S.allRoutes = true; redraw(); }
  function scrollTo(id) {
    const el = document.getElementById(id);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }

  // app.js's renderMain: the page, then the map, and the data on first visit.
  function init() {
    if (!S.A && S.phase === 'idle' && signedIn()) load(); else initMap();
  }
  // Signing in or out (auth.js): read again as whoever it is now. The demo
  // stays up for somebody signed out; signing in leaves it for the real thing.
  function authChanged() {
    if (S.demo && !signedIn()) return;
    ++S.seq;
    S.A = null; S.demo = false; S.phase = 'idle'; S.err = '';
    if (typeof state !== 'undefined' && state.activeTab === 'signalroutes') { if (signedIn()) load(); else redraw(); }
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportRoutesCsv() {
    const A = S.A;
    if (!A || (!A.routes.length && !A.a2.routes.length)) return;
    const head = ['protocol', 'station', 'station_id', 'address', 'came_in', 'via_station_id', 'receiver', 'base_station', 'count', 'not_alert_binary'];
    const lines = [head.join(',')];
    A.routes.forEach(r => {
      const st = keyStation(A.reg, r.key), p = A.pointById.get(r.pt);
      lines.push(['ALERT', keyName(A.reg, r.key), st ? st.id : '', r.a, viaWord(A, r.via), r.via.startsWith('rep:') ? r.via.slice(4) : '',
        p ? p.short : r.pt, p ? p.label : '', r.n, r.alt].map(csvEscape).join(','));
    });
    A.a2.routes.forEach(r => {
      const p = A.pointById.get(r.pt);
      lines.push(['ALERT2', keyName(A.reg, 'a2:' + r.src), '', r.src, viaWord(A, 'p:' + r.path.join('>')), r.path.join(' '),
        p ? p.short : r.pt, p ? p.label : '', r.n, 0].map(csvEscape).join(','));
    });
    dlText(`signal-routes-${A.demo ? 'demo-' : ''}${A.days}d.csv`, lines.join('\n') + '\n');
  }
  function exportPassCsv() {
    const A = S.A;
    if (!A || !A.reps.length) return;
    const head = ['repeater', 'repeater_id', 'pass_ranges', 'carrier_hz', 'days_found', 'address', 'station', 'status', 'bursts', 'copies'];
    const lines = [head.join(',')];
    A.reps.forEach(r => {
      const rr = r.ranges.map(q => `${q.low}-${q.high}`).join(' ');
      const row = (a, status, n, dup) => lines.push([r.name, r.rid, rr, r.centre == null ? '' : Math.round(r.centre), r.days, a,
        keyName(A.reg, stationKey(A.reg, a)), status, n, dup].map(csvEscape).join(','));
      r.confirmed.forEach((n, a) => row(a, 'on its carrier', n, ''));
      r.elsewhere.forEach((e, a) => row(a, 'in its range, heard another way', e.n, ''));
      r.offrec.forEach(o => row(o.a, o.evidence === 'copies' ? 'off its record — copies on its carrier' : 'off its record — possible', o.dup + o.own, o.dup));
    });
    dlText(`signal-routes-pass-ranges-${A.demo ? 'demo-' : ''}${A.days}d.csv`, lines.join('\n') + '\n');
  }

  // For the tests: fill it from receptions, without the server.
  function adopt(raw) {
    ++S.seq;
    S.demo = !!raw.demo; S.phase = 'ready'; S.err = ''; S.pick = null; S.rep = null; S.fitted = false;
    S.A = analyse(Object.assign({ from: Date.now() - DAY, to: Date.now(), concFrom: Date.now() - CONC_HOURS * HOUR, days: 1 }, raw));
    redraw();
  }
  function state_() { return { days: S.days, phase: S.phase, mode: S.mode, pick: S.pick, rep: S.rep, demo: S.demo, err: S.err, A: S.A }; }

  // register() and attribute() are also ⏱️ Latency's (map-latency.js): it puts
  // each copy of a message landing live to the transmitter whose carrier it
  // came on, by the same rule.
  return { render, init, load, loadDays, demo, setDays, setMode, pick, pickNode, pickRep, setGaps, showAll, scrollTo, authChanged,
    exportRoutesCsv, exportPassCsv, adopt, analyse, attribute, register, state: state_ };
})();
