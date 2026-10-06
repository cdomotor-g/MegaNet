// MegaNet — reception.js
//
//   Reception   the Reception Map tab: what the Serial Monitor's receivers
//               heard, where, and how strongly — and, out of that, which
//               transmitter is sending bad packets.
//
// After core.js, map-controls.js (addBaseLayers) and app.js (MAP_HOME,
// goToStation, stationAlertIds); reads reception-log.js (RxLog) and, for the
// database, datastore.js (dbRpc). Registers its map and teardown (#142).
// Nothing here runs at load.
//
// ── The question ─────────────────────────────────────────────────────────────
// A repeater that hears a station cleanly and re-transmits it with flipped
// bits produces a packet no station sent: right station, wrong value — or, a
// bit higher up, a different station's address altogether (the ghosting the
// Bit Flipper and Ghosting Graph tabs are about). Every receiver that hears
// the repeater hears the damage, so the receivers say which repeater it is if
// you ask them the right way. This asks three ways, from the weakest evidence
// up, and prints all three so the ranking can be argued with:
//
//   1. PASS RANGES — works today, with one receiver that never moves. A bad
//      copy of station S's address A can only have come from S or from a
//      repeater whose pass ranges let A through. Each bad copy's blame is split
//      evenly across the repeaters that could have carried it; a repeater that
//      is the common factor across several stations' bad copies collects it,
//      and one that is the *only* possible path for some of them is named.
//   2. GEOMETRY — once receptions carry a position (a GPS card, or a phone's
//      location). A bad copy is loudest near the transmitter that sent it, so
//      for each candidate: how far its bad copies were heard from it, and
//      whether their signal falls with distance from it (the Pearson r of RSSI
//      against log-distance — strongly negative for the culprit, flat or
//      positive for an innocent repeater whose position has nothing to do with
//      where the damage was heard). And the centroid of the bad copies,
//      weighted by power, with the repeater nearest it.
//   3. TIMING — when repeater delays are recorded (0015's delay_ms, none yet):
//      a copy that lands its repeater's delay after the first copy came
//      through that repeater. Shown as "no delays recorded" until there are.
//
// What counts as a bad copy: a decoded frame that is not the version its
// transmission's copies agree on. The copies of one transmission land within
// seconds of each other — direct, then each repeater's re-send; on the stored
// readings a repeater's corrupted copy lands a median 2.1 s after the clean
// one, nine in ten within 6.6 s, none past 12. So a frame on the same address
// within SAME_MS is a copy, however many bits differ. A frame on another
// address is a copy only within MAX_FLIP bits: within SAME_MS when no station
// carries that address (nothing else explains it), within WINDOW_MS when one
// does (two stations' frames can be that alike by chance — 279 such pairs in a
// week of stored readings), and never when one station carries both: that is
// its next sensor, in the same burst (190 pairs a week, which this used to
// call flips). Between two addresses, the frame in line with its own
// address's other reports is the one sent (fitOf); two frames each in line
// with their own are two stations that only look alike, and both stand.
// Two more exceptions, both measured. A station reporting faster than its
// copies land — a rain gauge tipping every few seconds in a storm — puts real
// values inside one window; a value a few counts on, between the
// transmission's and the address's next or last one, sent within RAPID_MS, is
// that report, not damage (29 of the 33 one-to-three-tip "flips" on rain
// gauges in that week were carried on by the next report). And a frame whose
// address no station carries, within two bits of one heard clean, is a ghost
// — unless that address keeps turning up on its own, which makes it a station
// MegaNet does not know about. Plus whatever a card itself refused — the radio's unreported
// frames, the SDR's shadows, an ERT-A2 status byte or frame flag. A burst
// nothing decoded from counts for coverage, never as blame.
//
// Where a copy was heard bounds what could have sent it: a repeater further
// than REACH_KM from the receiver — its GPS fix, or for a stored reading the
// area its receiver hears (SensorValues: the stations it hears that nobody
// else carries) — is no candidate, and an address several stations share
// means the one nearest.
//
// Sources: this browser's reception log, live; a file (the log's CSV or
// GeoJSON export, from another computer or a vehicle rig); the stored
// readings (public: one copy of each frame the base stations kept, and which
// other receivers heard it — no positions); the receptions table (0047,
// editors: every copy, and where it was heard); and a demo drive, built
// against the real registry with one repeater made to flip bits, so the method
// can be seen before anyone drives.
//
// And SITE SURVEYS (0051): a receiver — an RPi ALERT base station — left at a
// candidate repeater or base-station site for a day or three, network or not,
// which sends what it heard there, when it is next on a network, as receptions
// tagged with the survey. Picked from the list, a survey's receptions become
// the database source (so the map and the bad-copy analysis are of that site
// alone), and survey_summary() sets each address the site heard beside what
// the network stored from it over the same days: how many of its transmissions
// the site caught while it listened, and how many the site heard that no base
// station stored — the case for building there.

const Reception = (function () {
  const SAME_MS = 12000;            // a copy on the same address lands within this of the first
  const WINDOW_MS = 3000;           // …and one on another address that a station carries, within this
  const MAX_FLIP = 3;               // bits — another address further apart than this is a different transmission
  const RAPID_MS = 120000;          // a station's next report this soon can fall inside one copy window
  const RAPID_STEP = 8;             // …moving a few counts; a flipped bit can move a thousand
  const GHOST_MAX = 3;              // an unknown address heard alone this often is a station, not a ghost
  const FIT_TOL = 5;                // counts — a value this near its address's last or next report is that address's own
  const REACH_KM = 400;             // further than this from the receiver, a repeater could not have been heard
  const RD_SELECT = 'alert_id,reading_ts,value_raw,path,dup_count,dup_paths,rssi_dbm,level_dbfs,snr_db';
  const BANDS = [
    [-90, '--rssi-strong', '#137a3b'], [-100, '--rssi-good', '#5a9e18'], [-107, '--rssi-fair', '#b98511'],
    [-112, '--rssi-marginal', '#d4691f'], [-Infinity, '--rssi-weak', '#b3261e'],
  ];
  const S = {
    useLocal: true, loaded: [], loadedName: '', db: [], dbNote: '', readings: [], rdNote: '', rdSeq: 0, demo: [],
    window: 'all', filter: '', onlyBad: false, sel: null, map: null, layer: null, view: null, off: null, timer: 0,
    surveys: null, svNote: '', survey: null, svId: null, svAll: false, svSeq: 0,
  };

  // ── bits ──────────────────────────────────────────────────────────────────

  function pop(x) { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }
  function word(e) { return ((e.alert_id & 0x1FFF) * 2048) + (e.value_raw & 0x7FF); }
  function flipBits(a, b) {
    const da = (a.alert_id ^ b.alert_id) & 0x1FFF, dv = (a.value_raw ^ b.value_raw) & 0x7FF;
    return { addr: pop(da), value: pop(dv), total: pop(da) + pop(dv) };
  }
  function decoded(e) { return e.alert_id != null && e.value_raw != null; }

  // ── the registry ──────────────────────────────────────────────────────────

  let reg = null, regSrc = null;
  function registry() {
    if (!state.data || !Array.isArray(state.data.stations)) return { byId: new Map(), repeaters: [], stations: [] };
    if (regSrc === state.data) return reg;
    regSrc = state.data;
    const byId = new Map(), repeaters = [];
    state.data.stations.forEach(s => {
      (typeof stationAlertIds === 'function' ? stationAlertIds(s) : []).forEach(a => {
        if (!byId.has(a)) byId.set(a, []);
        byId.get(a).push(s);
      });
      if (s.repeater && Array.isArray(s.repeater.pass_ranges) && s.lat != null && s.lon != null) {
        repeaters.push({ st: s, ranges: s.repeater.pass_ranges, excl: s.repeater.exclusions || [], delay: s.repeater.delay_ms });
      }
    });
    reg = { byId, repeaters, stations: state.data.stations };
    return reg;
  }
  function passes(r, a) {
    const inR = r.ranges.some(x => a >= x.low && a <= x.high);
    if (!inR) return false;
    return !r.excl.some(x => (typeof x === 'number' ? x === a : (a >= x.low && a <= x.high)));
  }
  function stationOf(a) { const l = registry().byId.get(a); return l && l.length ? l[0] : null; }
  // An address several stations share means the one nearest where it was heard.
  function stationNear(a, w) {
    const l = registry().byId.get(a);
    if (!l || !l.length) return null;
    if (l.length === 1 || !w) return l[0];
    let best = null, bd = Infinity;
    l.forEach(s => { if (s.lat == null || s.lon == null) return; const d = km(w.lat, w.lon, s.lat, s.lon); if (d < bd) { bd = d; best = s; } });
    return best || l[0];
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  function km(aLat, aLon, bLat, bLon) {
    const R = 6371, p = Math.PI / 180;
    const dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function level(e) { return isFinite(e.rssi_dbm) && e.rssi_dbm != null ? e.rssi_dbm : isFinite(e.level_dbfs) && e.level_dbfs != null ? e.level_dbfs : null; }
  function placed(e) { return e.lat != null && e.lon != null && isFinite(e.lat) && isFinite(e.lon); }
  // Where a copy was heard, as near as it can be said: the receiver's position,
  // or the area a stored reading's receiver hears. Not for the map — an area is
  // tens of kilometres wide — only for what is within reach.
  function whereOf(e) { return placed(e) ? { lat: e.lat, lon: e.lon } : e.area || null; }
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 4) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // ── the analysis (pure: entries in, findings out) ─────────────────────────

  // May copy e, on another address than the transmission's first copy f and
  // dt after it, be a copy of that transmission?
  function crossCopy(f, e, dt, R) {
    if (flipBits(f, e).total > MAX_FLIP) return false;
    const a = R.byId.get(f.alert_id), b = R.byId.get(e.alert_id);
    if (!a || !b) return true;                     // one is on no station: nothing else explains it
    if (a.some(s => b.includes(s))) return false;  // one station's two sensors, in its burst
    return dt <= WINDOW_MS;
  }

  // How well value v at time t fits its own address's other reports: how far
  // it is from the nearest one at least SAME_MS away on either side. Small for
  // the station's own report; large — or Infinity, never heard otherwise — for
  // a ghost of another station's frame landing on the address.
  function fitOf(series, a, v, t) {
    const s = series.get(a);
    if (!s) return Infinity;
    const ts = s.ts;
    let lo = 0, hi = ts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t - SAME_MS) lo = m + 1; else hi = m; }
    let d = Infinity, j = lo;
    if (lo > 0) d = Math.abs(s.vs[lo - 1] - v);
    while (j < ts.length && ts[j] <= t + SAME_MS) j++;
    if (j < ts.length) d = Math.min(d, Math.abs(s.vs[j] - v));
    return d;
  }

  // Which of two versions of a transmission is the one sent? See analyse(), 2.
  function better(x, y, last) {
    if (x.known !== y.known) return x.known > y.known;
    if (x.e.alert_id !== y.e.alert_id) {
      const fx = x.fit <= FIT_TOL, fy = y.fit <= FIT_TOL;
      if (fx !== fy) return fx;
    }
    if (x.n !== y.n) return x.n > y.n;
    if (x.e.alert_id === y.e.alert_id && last.has(x.e.alert_id)) {
      const p = last.get(x.e.alert_id), dx = Math.abs(x.e.value_raw - p), dy = Math.abs(y.e.value_raw - p);
      if (dx !== dy) return dx < dy;
    }
    if (x.t !== y.t) return x.t < y.t;
    return x.lvl > y.lvl;
  }
  function between(x, a, b) { return x !== a && x >= Math.min(a, b) && x <= Math.max(a, b); }
  // x carries on the run from p to v, no further than it went.
  function carriesOn(x, p, v) { const d = v - p; return d !== 0 && Math.sign(x - v) === Math.sign(d) && Math.abs(x - v) <= Math.abs(d); }

  function analyse(entries) {
    const R = registry();
    const list = entries.slice().sort((a, b) => a.t - b.t);
    const out = { receptions: list.length, placed: 0, undecoded: 0, events: [], bad: [], ghosts: 0, rapid: 0, own: 0, unknown: [], receivers: new Set() };

    // 1. Transmissions: the copies of one frame, seconds apart — on its own
    // address however many bits differ; on another, within a few bits and
    // never one station's next sensor (crossCopy).
    const open = [];
    list.forEach(e => {
      out.receivers.add(e.point_id || e.receiver || '?');
      if (placed(e)) out.placed++;
      if (!decoded(e)) { if (e.fault === 'undecoded') out.undecoded++; return; }
      let ev = null;
      for (let i = open.length - 1; i >= 0; i--) {
        const o = open[i], dt = e.t - o.t0;
        if (dt > SAME_MS) { open.splice(i, 1); continue; }
        if (o.addrs.has(e.alert_id) || crossCopy(o.copies[0], e, dt, R)) { ev = o; break; }
      }
      if (!ev) { ev = { t0: e.t, copies: [], addrs: new Set() }; open.push(ev); out.events.push(ev); }
      ev.copies.push(e);
      ev.addrs.add(e.alert_id);
    });

    // 2. Each transmission's true version. A version a station carries beats
    // one nobody does. On two addresses, the one its own address's other
    // reports agree with beats one they do not (fitOf) — the context a packet
    // is heard in: 4803 = 51 two seconds after 4801 = 51, where 4801 reads
    // 50-odd all week and 4803 reads in the thousands, is 4801's frame with a
    // bit flipped in its address. Then the most copies; then, on one address,
    // the one nearest that address's last value (a battery does not jump
    // 1.6 V and back in two seconds); then the first heard — the direct copy
    // lands before any repeater's; then the loudest.
    const series = new Map();
    list.forEach(e => {
      if (!e.ok || !decoded(e)) return;
      let s = series.get(e.alert_id);
      if (!s) series.set(e.alert_id, s = { ts: [], vs: [] });
      s.ts.push(e.t); s.vs.push(e.value_raw);
    });
    const last = new Map();
    out.events.forEach(ev => {
      const votes = new Map();
      ev.copies.forEach(e => {
        if (!e.ok) return;
        const k = word(e);
        let v = votes.get(k);
        if (!v) {
          votes.set(k, v = { n: 0, lvl: -Infinity, e, t: e.t, known: R.byId.has(e.alert_id) ? 1 : 0,
            fit: ev.addrs.size > 1 ? fitOf(series, e.alert_id, e.value_raw, e.t) : 0 });
        }
        v.n++; const l = level(e); if (l != null && l > v.lvl) v.lvl = l;
      });
      let best = null;
      votes.forEach(v => { if (!best || better(v, best, last)) best = v; });
      ev.truth = best ? best.e : ev.copies[0];
      ev.versions = votes.size;
      if (!best) return;
      last.set(ev.truth.alert_id, ev.truth.value_raw);
      // A version on another address that fits that address's own reports is
      // that station's report, which only looked like this one.
      votes.forEach((v, k) => { if (v.e.alert_id !== ev.truth.alert_id && v.fit <= FIT_TOL) (ev.own = ev.own || new Set()).add(k); });
    });

    // Versions split out as transmissions of their own, not counted against
    // any repeater: those just found to be another station's own report, and
    // a station reporting faster than its copies land — a version on the
    // truth's address a few counts from its value, between it and the
    // address's next or last one, that one within RAPID_MS, or carrying on the
    // run the last one started.
    const split = (ev, pick, tag, into) => {
      const moved = new Map();
      ev.copies.forEach(e => { if (e.ok && pick(e)) { const k = word(e); if (!moved.has(k)) moved.set(k, []); moved.get(k).push(e); } });
      if (!moved.size) return 0;
      ev.copies = ev.copies.filter(e => !(e.ok && moved.has(word(e))));
      ev.versions -= moved.size;
      moved.forEach(copies => into.push({ t0: copies[0].t, copies, addrs: new Set([copies[0].alert_id]), truth: copies[0], versions: 1, [tag]: true }));
      return moved.size;
    };
    let extra = [];
    out.events.forEach(ev => { if (ev.own) out.own += split(ev, e => ev.own.has(word(e)), 'own', extra); });
    if (extra.length) out.events = out.events.concat(extra).sort((x, y) => x.t0 - y.t0);
    const byAddr = new Map();
    out.events.forEach(ev => {
      if (!ev.truth.ok) return;
      const a = ev.truth.alert_id;
      if (!byAddr.has(a)) byAddr.set(a, []);
      byAddr.get(a).push(ev);
    });
    extra = [];
    byAddr.forEach(evs => evs.forEach((ev, i) => {
      if (ev.versions < 2) return;
      const v = ev.truth.value_raw, a = ev.truth.alert_id;
      const nb = [evs[i - 1], evs[i + 1]].filter(o => o && Math.abs(o.t0 - ev.t0) <= RAPID_MS);
      if (!nb.length) return;
      const prev = nb.includes(evs[i - 1]) ? evs[i - 1].truth.value_raw : null;
      out.rapid += split(ev, e => e.alert_id === a && e.value_raw !== v && Math.abs(e.value_raw - v) <= RAPID_STEP
        && (nb.some(o => between(e.value_raw, v, o.truth.value_raw)) || (prev != null && carriesOn(e.value_raw, prev, v))), 'rapid', extra);
    }));
    if (extra.length) out.events = out.events.concat(extra).sort((x, y) => x.t0 - y.t0);

    // …and its bad copies.
    out.events.forEach(ev => {
      const w = ev.copies.find(placed) || ev.copies.find(e => e.area);
      ev.where = w ? whereOf(w) : null;
      ev.station = stationNear(ev.truth.alert_id, ev.where);
      ev.copies.forEach(e => {
        let why = null;
        if (!e.ok) why = e.fault || 'refused';
        else if (word(e) !== word(ev.truth)) why = 'flipped';
        if (why) out.bad.push({ e, why, truth: ev.truth, bits: flipBits(e, ev.truth), event: ev });
      });
    });

    // 3. Ghosts heard on their own: an address no station carries, within two
    // bits of one heard clean — unless it turns up on its own again and again,
    // which is a station MegaNet does not know about (or a repeater stuck on
    // one bit, whose victim this receiver never hears): said, not blamed.
    const heardClean = new Set(list.filter(e => e.ok && decoded(e) && R.byId.has(e.alert_id)).map(e => e.alert_id));
    const lone = ev => ev.versions === 1 && ev.truth.ok && !R.byId.has(ev.truth.alert_id) && ev.copies.every(e => e.ok);
    const alone = new Map();
    out.events.forEach(ev => { if (lone(ev)) alone.set(ev.truth.alert_id, (alone.get(ev.truth.alert_id) || 0) + 1); });
    alone.forEach((n, a) => { if (n >= GHOST_MAX) out.unknown.push({ alert_id: a, n }); });
    out.unknown.sort((x, y) => y.n - x.n);
    out.events.forEach(ev => {
      if (!lone(ev) || alone.get(ev.truth.alert_id) >= GHOST_MAX) return;
      const e = ev.truth;
      const near = [...heardClean].filter(a => pop((a ^ e.alert_id) & 0x1FFF) <= 2);
      if (!near.length) return;
      const truth = { alert_id: near[0], value_raw: e.value_raw };
      ev.station = stationNear(near[0], ev.where);
      out.ghosts++;
      ev.copies.forEach(c => out.bad.push({ e: c, why: 'ghost', truth, bits: flipBits(c, truth), event: ev, ghostOf: near }));
    });

    // 4. Suspects: the repeaters that pass an address, and are within reach
    // of where its copies were heard.
    const sus = new Map();
    const get = r => { let s = sus.get(r.st.id); if (!s) { s = { r, events: 0, bad: 0, only: 0, blame: 0, ids: new Set(), badPts: [] }; sus.set(r.st.id, s); } return s; };
    const passMemo = new Map();
    const passing = a => { let l = passMemo.get(a); if (!l) passMemo.set(a, l = R.repeaters.filter(r => passes(r, a))); return l; };
    const reach = (r, w) => !w || km(w.lat, w.lon, r.st.lat, r.st.lon) <= REACH_KM;
    out.events.forEach(ev => {
      const a = ev.truth.alert_id;
      if (!R.byId.has(a)) return;
      passing(a).forEach(r => { if (reach(r, ev.where)) { const s = get(r); s.events++; s.ids.add(a); } });
    });
    out.outOfReach = 0;
    out.bad.forEach(b => {
      const a = b.truth.alert_id;
      const w = whereOf(b.e) || b.event.where;
      const all = passing(a), cands = all.filter(r => reach(r, w));
      out.outOfReach += all.length - cands.length;
      b.candidates = cands.map(r => r.st.id);
      cands.forEach(r => {
        const s = get(r);
        s.bad++; s.blame += 1 / cands.length;
        if (cands.length === 1) s.only++;
        if (placed(b.e)) s.badPts.push(b.e);
      });
    });
    const repOrder = [...sus.values()].filter(s => s.bad || s.events);
    repOrder.forEach(s => {
      const pts = s.badPts.filter(e => level(e) != null);
      const d = pts.map(e => Math.max(0.05, km(e.lat, e.lon, s.r.st.lat, s.r.st.lon)));
      s.r_dist = pearson(d.map(x => Math.log10(x)), pts.map(level));
      const all = s.badPts.map(e => km(e.lat, e.lon, s.r.st.lat, s.r.st.lon)).sort((x, y) => x - y);
      s.medKm = all.length ? all[all.length >> 1] : null;
      s.rate = s.events ? s.bad / s.events : null;
    });
    repOrder.sort((a, b) => (b.blame - a.blame) || ((a.r_dist == null ? 0 : a.r_dist) - (b.r_dist == null ? 0 : b.r_dist)) || (b.events - a.events));
    out.suspects = repOrder;

    // 5. Where the bad copies were loudest.
    const pb = out.bad.filter(b => placed(b.e));
    if (pb.length) {
      let w = 0, la = 0, lo = 0;
      pb.forEach(b => { const l = level(b.e); const k = l == null ? 1 : Math.pow(10, (l + 120) / 20); w += k; la += k * b.e.lat; lo += k * b.e.lon; });
      out.centroid = { lat: la / w, lon: lo / w, n: pb.length };
      let near = null;
      repOrder.forEach(s => { const d = km(out.centroid.lat, out.centroid.lon, s.r.st.lat, s.r.st.lon); if (!near || d < near.d) near = { s, d }; });
      out.centroid.nearest = near;
    }
    out.delays = R.repeaters.filter(r => r.delay != null).length;
    out.receivers = out.receivers.size;
    return out;
  }

  // ── sources ───────────────────────────────────────────────────────────────

  function entries() {
    let list = [];
    if (S.useLocal && typeof RxLog !== 'undefined') list = list.concat(RxLog.all());
    list = list.concat(S.loaded, S.db, S.readings, S.demo);
    const now = Date.now(), span = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[S.window];
    if (span) list = list.filter(e => now - e.t <= span);
    return list;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function fromFile(text, name) {
    const t = String(text || '').trim();
    let out = [];
    const numOr = v => v === '' || v == null ? null : (isFinite(+v) ? +v : null);
    if (t.startsWith('{')) {
      const j = JSON.parse(t);
      (j.features || []).forEach(f => {
        const p = Object.assign({}, f.properties || {});
        const c = f.geometry && f.geometry.coordinates;
        if (c) { p.lon = c[0]; p.lat = c[1]; }
        p.t = Date.parse(p.time) || p.t;
        out.push(p);
      });
    } else {
      const rows = parseCsv(t);
      const head = rows.shift() || [];
      out = rows.filter(r => r.length > 3).map(r => {
        const o = {};
        head.forEach((h, i) => { o[h] = r[i]; });
        return {
          t: Date.parse(o.time), receiver: o.receiver, point_id: o.point_id, point_name: o.point_name, protocol: o.protocol,
          alert_id: numOr(o.alert_id), value_raw: numOr(o.value_raw), payload_hex: o.payload_hex, ok: o.ok === 'true' || o.ok === '1',
          fault: o.fault || null, rssi_dbm: numOr(o.rssi_dbm), level_dbfs: numOr(o.level_dbfs), nf_dbm: numOr(o.nf_dbm), votes: numOr(o.votes),
          lat: numOr(o.lat), lon: numOr(o.lon), accuracy_m: numOr(o.accuracy_m), location_source: o.location_source || 'none',
          location_approx: o.location_approx !== 'false', speed_mps: numOr(o.speed_mps), heading_deg: numOr(o.heading_deg),
          demo: o.demo === 'true' || undefined,
        };
      });
    }
    out = out.filter(e => isFinite(e.t));
    out.forEach(e => { e.src = 'file'; });
    return out;
  }

  function chooseFile() { const el = document.getElementById('rx-file'); if (el) { el.value = ''; el.click(); } }
  function onFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { S.loaded = fromFile(r.result, f.name); S.loadedName = f.name; S.note = 'Loaded ' + S.loaded.length + ' receptions from ' + f.name + '.'; }
      catch (e) { S.note = 'Could not read ' + f.name + ': ' + e.message; }
      refresh();
    };
    r.readAsText(f);
  }

  async function fromDb() {
    S.dbNote = 'Asking the database…'; refresh();
    try {
      const days = S.window === '1h' ? 1 / 24 : S.window === '24h' ? 1 : 7;
      const r = await dbRpc('reception_window', { p_from: new Date(Date.now() - days * 86400e3).toISOString(), p_to: new Date().toISOString(), p_limit: 20000 });
      S.db = (Array.isArray(r) ? r : []).map(e => Object.assign({}, e, { t: Date.parse(e.heard_at), src: 'db' }));
      S.dbNote = S.db.length + ' receptions from the database.';
    } catch (err) {
      S.dbNote = err.status === 404 ? 'The database does not keep receptions yet — apply db/migrations/0047_receptions.sql.'
        : err.status === 401 || err.status === 403 || /editor/i.test(err.message) ? 'Receptions are for editors — sign in to read them.'
        : 'Could not read receptions: ' + err.message;
    }
    refresh();
  }

  // The stored readings (meganet.reading, public) as receptions: the copy the
  // datastore kept, and one more for each further path that heard the same
  // frame (dup_paths) — the copy count is the vote. The level is the kept
  // copy's; none has a position, so each carries the area its receiver hears
  // instead (SensorValues: where the stations it hears that nobody else
  // carries are), which bounds the repeaters that could have sent it. ALERT
  // frames only: nothing else has bits to flip.
  function fromReadings(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.alert_id != null);
    const SV = typeof SensorValues !== 'undefined' ? SensorValues : null;
    const res = SV ? SV.resolver(list) : null;
    const hostOf = p => (SV && SV.hostOf(p || '')) || p || '';
    const areas = new Map();
    const areaOf = p => {
      const h = hostOf(p);
      if (!areas.has(h)) { const c = res && res.centreFor(h); areas.set(h, c ? { lat: c.lat, lon: c.lon } : null); }
      return areas.get(h);
    };
    const out = [];
    list.forEach(r => {
      const t = Date.parse(r.reading_ts), a = Number(r.alert_id), v = Number(r.value_raw);
      if (!isFinite(t) || !Number.isInteger(a) || a < 0 || a > 8191 || !Number.isInteger(v) || v < 0 || v > 2047) return;
      const copy = (path, kept) => ({
        t, receiver: hostOf(path), point_id: path || '', point_name: String(path || '').replace(/^serial-monitor\//, ''),
        protocol: 'alert', alert_id: a, value_raw: v, ok: true, fault: null,
        rssi_dbm: kept && r.rssi_dbm != null ? Number(r.rssi_dbm) : null,
        level_dbfs: kept && r.level_dbfs != null ? Number(r.level_dbfs) : null,
        snr_db: kept && r.snr_db != null ? Number(r.snr_db) : null,
        lat: null, lon: null, location_source: 'none', location_approx: true, area: areaOf(path), src: 'readings',
      });
      out.push(copy(r.path, true));
      const dups = Array.isArray(r.dup_paths) ? r.dup_paths : [];
      const n = Math.max(dups.length, Number(r.dup_count) || 0);
      for (let i = 0; i < n; i++) out.push(copy(dups[i] || r.path, false));
    });
    return out;
  }

  function rdNoteFor(n, frames, what) {
    return n.toLocaleString() + ' stored reading' + (n === 1 ? '' : 's') + ' (' + what + ') — ' + frames.toLocaleString()
      + ' copies of ALERT frames. Stored readings carry no position: the area each receiver hears rules out repeaters out of reach.';
  }
  function paintRdNote() { const el = document.getElementById('rx-rd-note'); if (el) el.textContent = S.rdNote; }

  // From the datastore, for the time window picked (everything means a week).
  async function fromStored() {
    const seq = ++S.rdSeq;
    if (typeof Health === 'undefined' || !Health.fetchReadings) { S.rdNote = 'The stored readings cannot be read from here.'; refresh(); return; }
    const days = S.window === '1h' ? 1 / 24 : S.window === '24h' ? 1 : 7;
    const t1 = Date.now(), t0 = t1 - days * 86400e3;
    S.rdNote = 'Reading the stored readings…'; refresh();
    try {
      const got = await Health.fetchReadings(t0, t1, {
        select: RD_SELECT, where: '&alert_id=not.is.null', alive: () => S.rdSeq === seq,
        onPage: n => { S.rdNote = 'Reading the stored readings… ' + n.toLocaleString(); paintRdNote(); },
      });
      if (S.rdSeq !== seq) return;
      S.readings = fromReadings(got.rows);
      S.rdNote = rdNoteFor(got.rows.length, S.readings.length, days < 1 ? 'the last hour' : days === 1 ? 'the last 24 hours' : 'the last 7 days')
        + (got.capped ? ' Capped — pick a shorter time.' : '');
    } catch (err) {
      if (S.rdSeq !== seq) return;
      S.rdNote = 'Could not read the stored readings: ' + ((err && err.message) || err) + '.';
    }
    refresh();
  }

  // Readings another tab already holds — the Station Health tab's window —
  // shown here without asking the datastore again. `select` picks a repeater.
  function useReadings(rows, opts) {
    const o = opts || {};
    S.rdSeq++;
    S.readings = fromReadings(rows);
    S.rdNote = rdNoteFor((rows || []).length, S.readings.length, o.label || 'handed over');
    S.window = 'all';
    S.view = null;
    if (o.select) S.sel = o.select;
    refresh();
  }

  // A drive past two real repeaters that relay the same stations, one of them
  // made to flip bits in a third of what it relays. Seeded, so the same drive
  // every time — the check holds the method to it.
  function demoDrive(seed) {
    const R = registry();
    let x = seed || 1234567;
    const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    // Two repeaters within 120 km sharing at least three addresses of stations
    // with positions; the one with more of them flips.
    let pick = null;
    for (let i = 0; i < R.repeaters.length && !pick; i++) {
      for (let j = 0; j < R.repeaters.length && !pick; j++) {
        if (i === j) continue;
        const a = R.repeaters[i], b = R.repeaters[j];
        if (km(a.st.lat, a.st.lon, b.st.lat, b.st.lon) > 120) continue;
        const shared = [...R.byId.keys()].filter(id => passes(a, id) && passes(b, id) && stationOf(id) && stationOf(id).lat != null).slice(0, 4);
        const onlyA = [...R.byId.keys()].filter(id => passes(a, id) && !passes(b, id) && stationOf(id) && stationOf(id).lat != null).slice(0, 2);
        if (shared.length >= 2 && onlyA.length >= 1) pick = { bad: a, good: b, ids: shared.concat(onlyA) };
      }
    }
    if (!pick) return [];
    const { bad, good, ids } = pick;
    const out = [];
    const t0 = Date.now() - 40 * 60e3;
    const steps = 240;
    for (let k = 0; k < steps; k++) {
      const f = k / (steps - 1);
      // drive from just past the good repeater, through the bad one, and on
      const lat = good.st.lat + (bad.st.lat - good.st.lat) * (f * 1.4 - 0.2) + 0.01 * Math.sin(k / 9);
      const lon = good.st.lon + (bad.st.lon - good.st.lon) * (f * 1.4 - 0.2) + 0.01 * Math.cos(k / 11);
      const t = t0 + k * 10e3;
      const a = ids[k % ids.length], st = stationOf(a), v = Math.floor(rnd() * 2000);
      const heard = (from, delay, flip) => {
        const d = Math.max(0.2, km(lat, lon, from.lat, from.lon));
        const rssi = Math.round(-55 - 28 * Math.log10(d) + (rnd() - 0.5) * 6);
        if (rssi < -118) return;
        let id = a, val = v;
        if (flip) {
          const bit = Math.floor(rnd() * 24);
          if (bit < 11) val ^= 1 << bit; else id ^= 1 << (bit - 11);
        }
        out.push({ t: t + delay, receiver: 'rtl-sdr', point_id: 'demo-drive', point_name: 'Demo drive', protocol: 'alert',
          alert_id: id, value_raw: val, ok: true, rssi_dbm: rssi, lat: +lat.toFixed(5), lon: +lon.toFixed(5), accuracy_m: 5,
          location_source: 'gps', location_approx: false, demo: true, src: 'demo' });
      };
      heard(st, 0, false);
      if (passes(good, a)) heard(good.st, 450, false);
      if (passes(bad, a)) heard(bad.st, 900, rnd() < 0.35);
    }
    S.demoTruth = { bad: bad.st.id, good: good.st.id };
    return out;
  }
  function loadDemo() { S.demo = demoDrive(); S.note = S.demo.length ? 'Demo drive: ' + S.demo.length + ' receptions, made up, with one repeater flipping bits. Which one does the method name?' : 'No two repeaters in the registry fit a demo drive.'; refresh(); }
  function clearLoaded() { S.loaded = []; S.db = []; S.readings = []; S.rdSeq++; S.demo = []; S.loadedName = ''; S.note = ''; S.dbNote = ''; S.rdNote = ''; S.svSeq++; S.svId = null; S.survey = null; refresh(); }

  // ── site surveys (0051) ───────────────────────────────────────────────────

  function dbErr(err, what) {
    return err.status === 404 ? 'The database does not keep site surveys yet — apply db/migrations/0051_site_surveys.sql.'
      : err.status === 401 || err.status === 403 || /editor/i.test(err.message) ? 'Site surveys are for editors — sign in to read them.'
      : 'Could not read ' + what + ': ' + err.message;
  }

  async function listSurveys() {
    S.svNote = 'Asking the database for site surveys…'; refresh();
    try {
      const r = await dbRpc('survey_list', {});
      S.surveys = Array.isArray(r) ? r : [];
      S.svNote = S.surveys.length ? '' : 'No site surveys yet. Start one on an RPi ALERT base station (its Survey page, or survey = <name> on its SD card); what it hears arrives here when it is next on a network.';
    } catch (err) { S.surveys = S.surveys || []; S.svNote = dbErr(err, 'site surveys'); }
    refresh();
  }

  // One survey: its summary, and its receptions as the database source.
  async function openSurvey(id) {
    const seq = ++S.svSeq;
    S.svId = id; S.survey = null;
    S.svNote = 'Reading the survey…'; refresh();
    try {
      const [sum, rx] = await Promise.all([dbRpc('survey_summary', { p_survey: id }), dbRpc('survey_receptions', { p_survey: id, p_limit: 50000 })]);
      if (seq !== S.svSeq) return;
      S.survey = sum || null;
      S.db = (Array.isArray(rx) ? rx : []).map(e => Object.assign({}, e, { t: Date.parse(e.heard_at), src: 'db' }));
      S.dbNote = S.db.length.toLocaleString() + ' receptions from the survey' + (sum && sum.name ? ' “' + sum.name + '”' : '') + '.'
        + (sum && S.db.length < sum.frames ? ' The first ' + S.db.length.toLocaleString() + ' of ' + sum.frames.toLocaleString() + ' are on the map; the table counts them all.' : '');
      // The site alone: not this browser's own log, and over the survey's days.
      S.useLocal = false; S.window = 'all'; S.view = null; S.sel = null;
      S.svNote = sum ? '' : 'That survey has no receptions.';
    } catch (err) { if (seq === S.svSeq) S.svNote = dbErr(err, 'the survey'); }
    refresh();
  }
  function closeSurvey() { S.svSeq++; S.svId = null; S.survey = null; S.db = []; S.dbNote = ''; S.view = null; refresh(); }
  function setSurveyAll(v) { S.svAll = !!v; refresh(); }

  function pct(n, d) { return d ? Math.round(100 * n / d) : null; }
  function svRows() {
    const v = S.survey;
    if (!v) return [];
    const site = v.lat != null && v.lon != null ? { lat: v.lat, lon: v.lon } : null;
    const ids = filterIds();
    return (v.stations || []).map(r => {
      const st = stationNear(r.alert_id, site);
      return Object.assign({}, r, { st, km: st && site && st.lat != null && st.lon != null ? km(site.lat, site.lon, st.lat, st.lon) : null,
        pct: pct(r.heard_of_sent, r.sent) });
    }).filter(r => (S.svAll || r.ok > 0) && (!ids || ids.has(r.alert_id)));
  }
  // The signal a row was heard at: dBm off a radio, else dBFS off an RTL-SDR.
  function svLevel(r) {
    const a = r.rssi_dbm || r.level_dbfs;
    if (!Array.isArray(a)) return null;
    return { p10: a[0], p50: a[1], p90: a[2], unit: r.rssi_dbm ? 'dBm' : 'dBFS' };
  }
  function pctColor(p) {
    return p == null ? cssVar('--accent', '#1f6feb') : p >= 90 ? cssVar('--rssi-strong', '#137a3b') : p >= 70 ? cssVar('--rssi-good', '#5a9e18')
      : p >= 40 ? cssVar('--rssi-fair', '#b98511') : p > 0 ? cssVar('--rssi-marginal', '#d4691f') : cssVar('--rssi-weak', '#b3261e');
  }

  function surveyListHtml() {
    if (!S.surveys || !S.surveys.length) return '';
    const rows = S.surveys.map(v => {
      const sel = S.svId === v.id;
      return '<tr' + (sel ? ' class="rx-sel"' : '') + '><th scope="row"><button type="button" class="link-btn" aria-pressed="' + sel + '" onclick="Reception.openSurvey(\'' + escAttr(v.id) + '\')">'
        + esc(v.name || v.id) + '</button></th><td class="small">' + esc(v.token_label || '') + '</td>'
        + '<td class="qs-time">' + esc(when(Date.parse(v.first_heard), true)) + ' – ' + esc(when(Date.parse(v.last_heard), true)) + '</td>'
        + '<td class="qs-num">' + Number(v.ok).toLocaleString() + '</td><td class="qs-num">' + v.addresses + '</td>'
        + '<td class="small col-optional">' + (v.lat != null ? Number(v.lat).toFixed(4) + ', ' + Number(v.lon).toFixed(4) + (v.gps ? ' (GPS)' : ' (approximate)') : '—') + '</td></tr>';
    }).join('');
    return '<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="rx-h-sv"><table class="qs-table">'
      + '<caption class="sr-only">Site surveys, newest first</caption>'
      + '<thead><tr><th scope="col">Site</th><th scope="col">Base station</th><th scope="col">Heard</th><th scope="col">Good frames</th>'
      + '<th scope="col">Addresses</th><th scope="col" class="col-optional">Where</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function surveyHtml() {
    const v = S.survey;
    if (!v) return '';
    const rows = svRows();
    const all = v.stations || [];
    const sent = all.reduce((a, r) => a + r.sent, 0), got = all.reduce((a, r) => a + r.heard_of_sent, 0), only = all.reduce((a, r) => a + r.only_here, 0);
    const unheard = all.filter(r => !r.ok && r.sent).length;
    const c = (k, val, cls) => '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(k) + '</span><span class="qs-chip-v">' + val + '</span></div>';
    const chans = (v.points || []).map(p => (p.freq_mhz ? p.freq_mhz + ' MHz' : esc(p.point_id)) + ' <span class="qs-dim">' + p.ok + '</span>').join(' · ');
    const body = rows.map(r => {
      const lv = svLevel(r);
      return '<tr><th scope="row">' + stLink(r.st) + '</th><td class="qs-num">' + r.alert_id + '</td><td class="qs-num col-optional">' + fmtKm(r.km) + '</td>'
        + '<td class="qs-num">' + r.ok + (r.bad ? ' <span class="qs-dim" title="' + r.bad + ' bad">+' + r.bad + '</span>' : '') + '</td>'
        + '<td class="qs-num">' + (r.sent ? r.heard_of_sent + ' / ' + r.sent + ' <span class="rx-pct" style="--dot:' + pctColor(r.pct) + '">' + r.pct + '%</span>' : '<span class="qs-dim">—</span>') + '</td>'
        + '<td class="qs-num">' + (r.only_here || '') + '</td>'
        + '<td class="qs-num"' + (lv ? ' title="10–90 %: ' + lv.p10 + ' … ' + lv.p90 + ' ' + lv.unit + '"' : '') + '>' + (lv ? lv.p50 + ' ' + lv.unit : '—') + '</td>'
        + '<td class="qs-num">' + (r.snr_db != null ? r.snr_db + ' dB' : '—') + '</td>'
        + '<td class="small col-optional"' + (r.last_heard ? ' title="last heard ' + escAttr(when(Date.parse(r.last_heard), true)) + '"' : '') + '>' + esc((r.freqs || []).join(', ')) + '</td></tr>';
    }).join('');
    return '<div class="panel">'
      + '<div class="panel-header"><h3 id="rx-h-svs">Site survey: ' + esc(v.name || v.id) + '</h3>'
      + '<button class="ghost" onclick="Reception.exportSurveyCsv()">Export CSV</button><button class="ghost" onclick="Reception.closeSurvey()">Close</button></div>'
      + '<p class="small">' + esc(v.token_label || '') + ' · ' + esc(when(Date.parse(v.first_heard), true)) + ' – ' + esc(when(Date.parse(v.last_heard), true))
      + ' · listening about ' + v.listening_h + ' h · ' + (v.lat != null ? Number(v.lat).toFixed(5) + ', ' + Number(v.lon).toFixed(5) + (v.gps ? ' (GPS)' : ' (approximate — typed in on the Pi)') : 'no position')
      + (chans ? ' · ' + chans : '') + '</p>'
      + '<div class="qs-status">'
      + c('Good frames', Number(v.ok).toLocaleString()) + c('Bad', Number(v.bad).toLocaleString(), v.bad ? 'warn' : '')
      + c('Undecoded bursts', Number(v.undecoded).toLocaleString())
      + c('Addresses heard', String(all.filter(r => r.ok).length))
      + c('Of all the network stored', sent ? got.toLocaleString() + ' of ' + sent.toLocaleString() + ' (' + pct(got, sent) + '%)' : 'nothing to compare')
      + c('Heard only here', only.toLocaleString(), only ? 'ok' : '')
      + '</div>'
      + (unheard ? '<label class="ser-check"><input type="checkbox" ' + (S.svAll ? 'checked' : '') + ' onchange="Reception.setSurveyAll(this.checked)"> also the '
        + unheard + ' address' + (unheard === 1 ? '' : 'es') + ' the network stored while this site listened and did not hear</label>' : '')
      + (rows.length ? '<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="rx-h-svs"><table class="qs-table">'
        + '<caption class="sr-only">What the site heard, address by address, most heard first</caption>'
        + '<colgroup><col style="width:auto"><col style="width:5.5rem"><col style="width:4.75rem"><col style="width:4.5rem"><col style="width:8.25rem">'
        + '<col style="width:6.25rem"><col style="width:6.25rem"><col style="width:4.75rem"><col style="width:5.5rem"></colgroup>'
        + '<thead><tr><th scope="col">Station</th><th scope="col">Address</th><th scope="col" class="col-optional">Away</th><th scope="col" title="Good frames (+ bad)">Good</th>'
        + '<th scope="col">Heard of sent</th><th scope="col">Only here</th><th scope="col" title="Median; hover a cell for the 10–90 % spread">Signal</th><th scope="col">SNR</th>'
        + '<th scope="col" class="col-optional" title="Hover a cell for when it was last heard">MHz</th></tr></thead><tbody>' + body + '</tbody></table></div>'
        : '<p class="qs-dim small">Nothing matches the station filter.</p>')
      + '<p class="qs-hint">Heard of sent: of the transmissions the network stored from that address while the site was listening (any frame of its within 20 minutes), how many the site heard — the same value within '
      + v.match_s + ' s. Copies within 5 s are one transmission. Only here: transmissions the site heard that no base station stored. Signal: dBm off a radio, dBFS off an RTL-SDR (relative to its own gain — compare stations at one site, and sites surveyed with the same stick and gain). '
      + 'The map draws a line from the site to each station heard, coloured by how much of it the site caught.</p></div>';
  }

  function exportSurveyCsv() {
    const v = S.survey;
    if (!v) return;
    const q = (x) => { const t = x == null ? '' : String(x); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const head = ['survey', 'site', 'station_id', 'station', 'alert_id', 'km_from_site', 'good', 'bad', 'sent', 'heard_of_sent', 'heard_pct', 'only_here', 'signal_p10', 'signal_p50', 'signal_p90', 'signal_unit', 'snr_db', 'mhz', 'first_heard', 'last_heard'];
    const lines = [head.join(',')].concat(svRows().map(r => {
      const lv = svLevel(r) || {};
      return [v.id, v.name, r.st && r.st.id, r.st && r.st.name, r.alert_id, r.km == null ? '' : r.km.toFixed(1), r.ok, r.bad, r.sent, r.heard_of_sent, r.pct, r.only_here,
        lv.p10, lv.p50, lv.p90, lv.unit, r.snr_db, (r.freqs || []).join(' '), r.first_heard, r.last_heard].map(q).join(',');
    }));
    dlText('site-survey-' + String(v.name || v.id).replace(/[^\w.-]+/g, '-').slice(0, 40) + '.csv', lines.join('\n') + '\n');
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function bandOf(l) { if (l == null) return null; return BANDS.find(b => l > b[0]) || BANDS[BANDS.length - 1]; }
  function colorOf(l) { const b = bandOf(l); return b ? cssVar(b[1], b[2]) : cssVar('--muted', '#5a6b7d'); }
  function stLink(st) { return st ? '<button type="button" class="link-btn" onclick="goToStation(\'' + escAttr(st.id) + '\')">' + esc(st.name) + '</button>' : '<span class="qs-dim">—</span>'; }
  function hm(t) { return SerialViz && SerialViz.hhmm ? SerialViz.hhmm(t, true) : new Date(t).toLocaleTimeString(); }
  // A week of stored readings needs the day as well as the time.
  function when(t, long) {
    if (!long) return hm(t);
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + hm(t);
  }
  function fmtKm(d) { return d == null ? '—' : d < 10 ? d.toFixed(1) + ' km' : Math.round(d) + ' km'; }

  // The addresses the Station-or-address box names; null when it is empty.
  function filterIds() {
    const q = S.filter.trim().toLowerCase();
    if (!q) return null;
    const R = registry();
    const ids = new Set();
    q.split(/[\s,]+/).forEach(tok => {
      if (/^\d+$/.test(tok)) ids.add(+tok);
      R.stations.forEach(s => { if ((s.name || '').toLowerCase().includes(tok) || String(s.station_number || '') === tok) stationAlertIds(s).forEach(x => ids.add(x)); });
    });
    return ids;
  }
  function filtered(a) {
    const ids = filterIds();
    if (!ids) return a;
    return { ...a, bad: a.bad.filter(b => ids.has(b.truth.alert_id) || ids.has(b.e.alert_id)) };
  }

  function chips(a) {
    const c = (k, v, cls) => '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(k) + '</span><span class="qs-chip-v">' + v + '</span></div>';
    return '<div class="qs-status">'
      + c('Receptions', a.receptions + (a.undecoded ? ' · ' + a.undecoded + ' undecoded bursts' : ''))
      + c('With a position', a.placed + (a.receptions ? ' (' + Math.round(100 * a.placed / a.receptions) + '%)' : ''), a.receptions && !a.placed && !S.readings.length ? 'warn' : '')
      + c('Transmissions', String(a.events.length))
      + c('Bad copies', a.bad.length + (a.ghosts ? ' · ' + a.ghosts + ' ghosts' : ''), a.bad.length ? 'warn' : '')
      + c('Receivers', String(a.receivers))
      + c('Repeater delays', a.delays ? a.delays + ' recorded' : 'none recorded — timing not used')
      + '</div>';
  }

  function suspectsHtml(a) {
    if (!a.suspects.length) return '<p class="qs-dim small">No repeater passes any address heard yet.</p>';
    const rows = a.suspects.slice(0, 25).map((s, i) => {
      const r = s.r_dist == null ? '—' : s.r_dist.toFixed(2);
      const verdict = !s.bad ? 'clean so far'
        : s.only ? 'the only path for ' + s.only + ' bad cop' + (s.only === 1 ? 'y' : 'ies')
        : s.r_dist != null && s.r_dist < -0.5 ? 'bad copies loudest near it'
        : 'shares the blame';
      return '<tr' + (S.sel === s.r.st.id ? ' class="rx-sel"' : '') + '><td class="qs-num">' + (i + 1) + '</td>'
        + '<th scope="row"><button type="button" class="link-btn" onclick="Reception.select(\'' + escAttr(s.r.st.id) + '\')" aria-pressed="' + (S.sel === s.r.st.id) + '">'
        + esc(s.r.st.name) + '</button></th>'
        + '<td class="qs-num">' + s.ids.size + '</td><td class="qs-num">' + s.events + '</td>'
        + '<td class="qs-num">' + s.bad + (s.rate != null && s.events ? ' <span class="qs-dim">(' + Math.round(100 * s.rate) + '%)</span>' : '') + '</td>'
        + '<td class="qs-num">' + s.blame.toFixed(1) + '</td>'
        + '<td class="qs-num col-optional">' + r + '</td><td class="qs-num col-optional">' + fmtKm(s.medKm) + '</td>'
        + '<td class="small">' + esc(verdict) + '</td></tr>';
    }).join('');
    return '<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="rx-h-sus"><table class="qs-table">'
      + '<caption class="sr-only">Repeaters that pass the addresses heard, most to blame first</caption>'
      + '<thead><tr><th scope="col">#</th><th scope="col">Repeater</th><th scope="col">Addresses it passes</th><th scope="col">Transmissions it could carry</th>'
      + '<th scope="col">Bad copies it could carry</th><th scope="col">Blame</th><th scope="col" class="col-optional">RSSI vs distance r</th>'
      + '<th scope="col" class="col-optional">Bad copies, median distance</th><th scope="col">Why</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // What the method set aside, and why — so a short table is not read as a clean network.
  function notesHtml(a) {
    const li = [];
    if (a.own) {
      li.push(a.own + ' frame' + (a.own === 1 ? '' : 's') + ' within a few bits of another station\'s, in the same seconds, but in line with '
        + (a.own === 1 ? 'its own station\'s' : 'their own stations\'') + ' reports either side — two stations that only looked alike, counted as both, not as ghosts.');
    }
    if (a.rapid) {
      li.push(a.rapid + ' value' + (a.rapid === 1 ? '' : 's') + ' a station sent faster than its copies land — a rain gauge tipping through a storm —'
        + ' counted as ' + (a.rapid === 1 ? 'its report' : 'its reports') + ', not as damage.');
    }
    if (a.unknown.length) {
      const list = a.unknown.slice(0, 8).map(u => u.alert_id + ' (' + u.n + '×)').join(', ');
      li.push(a.unknown.length + ' address' + (a.unknown.length === 1 ? '' : 'es') + ' on no station turned up on ' + (a.unknown.length === 1 ? 'its' : 'their')
        + ' own again and again — ' + esc(list) + (a.unknown.length > 8 ? ', …' : '') + '. A station MegaNet does not know about, or a repeater stuck'
        + ' on one bit whose victim this receiver never hears: not counted as ghosts. The Station Health tab lists them under the register.');
    }
    return li.length ? '<ul class="small rx-notes">' + li.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '';
  }

  function badHtml(a) {
    if (!a.bad.length) return '<p class="qs-dim small">No bad copies' + (a.receptions ? ' in what was heard.' : ' — nothing heard yet.') + '</p>';
    let t0 = Infinity, t1 = -Infinity;
    a.bad.forEach(b => { if (b.e.t < t0) t0 = b.e.t; if (b.e.t > t1) t1 = b.e.t; });
    const long = t1 - t0 > 20 * 3600e3;
    const rows = a.bad.slice().sort((x, y) => y.e.t - x.e.t).slice(0, 300).map(b => {
      const st = (b.event && b.event.station) || stationOf(b.truth.alert_id);
      const what = { flipped: 'flipped', ghost: 'ghost address', rejected: 'radio rejected', shadow: 'decoder shadow', status: 'status byte', frame: 'frame flagged', undecoded: 'undecoded' }[b.why] || b.why;
      return '<tr><td class="qs-time">' + esc(when(b.e.t, long)) + '</td><td class="qs-num">' + b.e.alert_id + ' = ' + b.e.value_raw + '</td>'
        + '<td class="qs-num">' + b.truth.alert_id + ' = ' + b.truth.value_raw + '</td><td>' + stLink(st) + '</td>'
        + '<td class="qs-num">' + (b.bits.total ? b.bits.addr + ' addr · ' + b.bits.value + ' value' : '—') + '</td>'
        + '<td class="small">' + esc(what) + '</td><td class="qs-num">' + (level(b.e) == null ? '—' : level(b.e) + (b.e.rssi_dbm != null ? ' dBm' : ' dBFS')) + '</td>'
        + '<td class="small col-optional">' + (placed(b.e) ? b.e.lat.toFixed(4) + ', ' + b.e.lon.toFixed(4)
          : b.e.point_name || b.e.receiver ? '<span class="mono">' + esc(b.e.point_name || b.e.receiver) + '</span>' : '—') + '</td></tr>';
    }).join('');
    return '<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="rx-h-bad"><table class="qs-table">'
      + '<caption class="sr-only">Bad copies, newest first</caption>'
      + '<thead><tr><th scope="col">Heard</th><th scope="col">Heard as</th><th scope="col">Should be</th><th scope="col">Station</th>'
      + '<th scope="col">Bits flipped</th><th scope="col">Why bad</th><th scope="col">Level</th><th scope="col" class="col-optional">Where</th></tr></thead><tbody>'
      + rows + '</tbody></table></div>';
  }

  function render() {
    const local = typeof RxLog !== 'undefined' ? RxLog.all().length : 0;
    const a = filtered(analyse(entries()));
    S.last = a;
    const w = (v, l) => '<option value="' + v + '"' + (S.window === v ? ' selected' : '') + '>' + l + '</option>';
    let cen = '';
    if (a.centroid) {
      cen = '<p class="small">Bad copies are loudest around <strong>' + a.centroid.lat.toFixed(4) + ', ' + a.centroid.lon.toFixed(4) + '</strong> ('
        + a.centroid.n + ' placed)' + (a.centroid.nearest ? ' — nearest repeater ' + esc(a.centroid.nearest.s.r.st.name) + ', ' + fmtKm(a.centroid.nearest.d) + ' away.' : '.') + '</p>';
    }
    return `
    <div class="page rx-page" style="--page-max:1280px">
      <div class="panel">
        <div class="panel-header"><h2>Reception Map</h2></div>
        <p class="sub">What the receivers heard, where, and how strongly — and which transmitter is sending bad packets.
          Every frame a Quansheng, RTL-SDR or ERT-A2 card hears is logged with its level and the receiver's position (a GPS card's fix, this
          device's location, or the receiver's fixed location), and every base station's stored readings can be read in too. Bad copies —
          flipped bits, ghost addresses, frames a receiver refused — are laid against the repeaters whose pass ranges could have carried them.</p>
        <div class="rx-sources">
          <label class="ser-check"><input type="checkbox" ${S.useLocal ? 'checked' : ''} onchange="Reception.setLocal(this.checked)"> this browser's log (${local})</label>
          <button class="ghost" onclick="Reception.chooseFile()">Load a log file…</button>
          <button class="ghost" onclick="Reception.fromStored()" title="Every base station's stored ALERT readings for the time picked — public, no positions">From the stored readings</button>
          <button class="ghost" onclick="Reception.fromDb()" title="Every copy each receiver sending to MegaNet heard, with where — editors only">Receptions table (editors)</button>
          <button class="ghost" onclick="Reception.listSurveys()" title="A receiver left at a candidate repeater or base-station site: what it heard there, beside what the network received — editors only">Site surveys (editors)</button>
          <button class="ghost" onclick="Reception.loadDemo()">Demo drive</button>
          ${S.loaded.length || S.db.length || S.readings.length || S.demo.length ? '<button class="ghost" onclick="Reception.clearLoaded()">Clear loaded</button>' : ''}
          <button class="ghost" onclick="Reception.exportCsv()">Export CSV</button>
          <button class="ghost" onclick="Reception.exportGeoJson()">Export GeoJSON</button>
          <input type="file" id="rx-file" hidden accept=".csv,.geojson,.json,text/csv,application/json" aria-label="Reception log file" onchange="Reception.onFile(this)">
        </div>
        <div class="rx-filters">
          <label>Time <select onchange="Reception.setWindow(this.value)">${w('all', 'everything')}${w('1h', 'last hour')}${w('24h', 'last 24 h')}${w('7d', 'last 7 days')}</select></label>
          <label>Station or address <input type="text" value="${escAttr(S.filter)}" placeholder="e.g. 4078, Rothwell" onchange="Reception.setFilter(this.value)"></label>
        </div>
        ${S.note ? '<p class="small" role="status">' + esc(S.note) + '</p>' : ''}
        ${S.dbNote ? '<p class="small" role="status">' + esc(S.dbNote) + '</p>' : ''}
        <p class="small" id="rx-rd-note" role="status">${esc(S.rdNote)}</p>
        ${chips(a)}
      </div>
      ${S.surveys || S.svNote ? '<div class="panel"><div class="panel-header"><h3 id="rx-h-sv">Site surveys</h3></div>'
        + '<p class="sub">A receiver left at a candidate repeater or base-station site for a day or three — an RPi ALERT base station on its Survey page — sends what it heard there when it is next on a network. Pick one to see each station it heard, how much of what the network received it caught, and what it heard that no base station did.</p>'
        + (S.svNote ? '<p class="small" role="status">' + esc(S.svNote) + '</p>' : '') + surveyListHtml() + '</div>' : ''}
      ${surveyHtml()}
      <div class="panel">
        <div class="rx-map" id="rx-map" role="region" aria-label="Reception map"></div>
        <div class="qs-legend">${BANDS.map((b, i) => '<span><i class="qs-sw rx-sw" style="--dot: var(' + b[1] + ')"></i>' + ['> −90', '−90 to −100', '−100 to −107', '−107 to −112', '< −112'][i] + ' dBm</span>').join('')}
          <span><i class="qs-sw rx-sw rx-sw-bad"></i>bad copy</span><span><i class="qs-sw rx-sw rx-sw-rep"></i>repeater</span><span><i class="qs-sw rx-sw rx-sw-cen"></i>where bad copies are loudest</span>
          ${S.survey ? '<span><i class="qs-sw rx-sw rx-sw-site"></i>survey site</span><span>lines: share of a station\'s transmissions the site heard — ≥ 90 %, ≥ 70 %, ≥ 40 %, less, none; blue: heard only here</span>' : ''}</div>
        <p class="qs-hint">Each dot is where a receiver was when it heard something. Pick a repeater below to draw lines from it to the bad copies it could have carried.
          ${a.receptions && !a.placed ? (S.readings.length
            ? '<strong>Stored readings carry no position</strong> — the map shows the suspect repeaters only, and the pass-range ranking below works without. Each reading is placed by the area its receiver hears, which is enough to rule out repeaters too far away to have been heard. A drive with a GPS card is what fills the map.'
            : '<strong>None of these receptions has a position</strong> — the map is empty, but the pass-range ranking below still works. Add a GPS card on the Serial Monitor, tick “track this device’s position”, or give the receiver a fixed location.') : ''}</p>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rx-h-sus">Suspect repeaters</h3></div>
        ${cen}
        ${suspectsHtml(a)}
        <p class="qs-hint">Blame: each bad copy shared evenly among the repeaters whose pass ranges let its true address through and that are
          within ${REACH_KM} km of where it was heard — the common factor collects it. RSSI vs distance r: strongly negative when bad copies get louder
          the closer the receiver was to that repeater (needs positions). This narrows the search; it does not convict — confirm on site with the
          repeater's own logs or a receiver parked beside it.</p>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rx-h-bad">Bad copies</h3></div>
        ${notesHtml(a)}
        ${badHtml(a)}
      </div>
    </div>`;
  }

  // ── the map ───────────────────────────────────────────────────────────────

  function drawMap() {
    stopMap();
    const el = document.getElementById('rx-map');
    const a = S.last;
    if (!el || typeof L === 'undefined' || !a) return;
    const map = S.map = L.map('rx-map');
    registerLiveMap('Reception', () => S.map);
    map.setView(MAP_HOME, 4);
    addBaseLayers(map);
    const layer = S.layer = L.layerGroup().addTo(map);
    const R = registry();
    const pts = [];
    const ents = entries().filter(placed);
    // the track, in time order per receiver
    const byRx = new Map();
    ents.slice().sort((x, y) => x.t - y.t).forEach(e => { const k = e.point_id || e.receiver; if (!byRx.has(k)) byRx.set(k, []); byRx.get(k).push([e.lat, e.lon]); });
    byRx.forEach(line => { if (line.length > 1) L.polyline(line, { color: cssVar('--muted', '#5a6b7d'), weight: 2, opacity: .45, interactive: false }).addTo(layer); });
    const badSet = new Set(a.bad.map(b => b.e));
    ents.forEach(e => {
      if (badSet.has(e)) return;
      L.circleMarker([e.lat, e.lon], { radius: 5, color: '#fff', weight: 1, fillColor: colorOf(level(e)), fillOpacity: .85 })
        .bindPopup('<b>' + (decoded(e) ? e.alert_id + ' = ' + e.value_raw : 'undecoded burst') + '</b><br>' + esc(new Date(e.t).toLocaleString())
          + (level(e) != null ? '<br>' + level(e) + (e.rssi_dbm != null ? ' dBm' : ' dBFS') : '') + '<br>' + esc(e.point_name || e.receiver || '')
          + ' · position ' + esc(e.location_source || '') + (e.location_approx ? ' (approximate)' : ''))
        .addTo(layer);
      pts.push([e.lat, e.lon]);
    });
    a.bad.forEach(b => {
      if (!placed(b.e)) return;
      L.circleMarker([b.e.lat, b.e.lon], { radius: 7, color: cssVar('--bad', '#b3261e'), weight: 2.5, fillColor: colorOf(level(b.e)), fillOpacity: .9, dashArray: '3 2' })
        .bindPopup('<b>Bad copy</b>: heard ' + b.e.alert_id + ' = ' + b.e.value_raw + ', should be ' + b.truth.alert_id + ' = ' + b.truth.value_raw
          + '<br>' + esc(b.why) + (b.bits.total ? ' · ' + b.bits.total + ' bit' + (b.bits.total === 1 ? '' : 's') : '') + (level(b.e) != null ? ' · ' + level(b.e) : ''))
        .addTo(layer);
      pts.push([b.e.lat, b.e.lon]);
    });
    // repeaters that matter here
    a.suspects.slice(0, 25).forEach((s, i) => {
      const sel = S.sel === s.r.st.id;
      L.circleMarker([s.r.st.lat, s.r.st.lon], { radius: sel ? 10 : 7, color: cssVar('--text', '#1b2733'), weight: sel ? 3 : 1.5,
        fillColor: s.bad ? cssVar('--warn', '#b98511') : cssVar('--panel', '#fff'), fillOpacity: 1 })
        .bindPopup('<b>' + esc(s.r.st.name) + '</b><br>#' + (i + 1) + ' · blame ' + s.blame.toFixed(1) + ' · ' + s.bad + ' bad of ' + s.events)
        .on('click', () => select(s.r.st.id))
        .addTo(layer);
      pts.push([s.r.st.lat, s.r.st.lon]);
      if (sel) a.bad.forEach(b => { if (placed(b.e) && (b.candidates || []).includes(s.r.st.id)) L.polyline([[s.r.st.lat, s.r.st.lon], [b.e.lat, b.e.lon]], { color: cssVar('--bad', '#b3261e'), weight: 1, opacity: .5, interactive: false }).addTo(layer); });
    });
    if (a.centroid) {
      L.circleMarker([a.centroid.lat, a.centroid.lon], { radius: 12, color: cssVar('--bad', '#b3261e'), weight: 3, fill: false, dashArray: '6 4' })
        .bindPopup('Bad copies are loudest here (' + a.centroid.n + ' placed)').addTo(layer);
    }
    // A site survey: the site, and a line to each station it heard, coloured by how much of it the site caught.
    const v = S.survey;
    if (v && v.lat != null && v.lon != null) {
      svRows().forEach(r => {
        if (!r.st || r.st.lat == null || r.st.lon == null) return;
        const col = pctColor(r.sent ? r.pct : null);
        const lv = svLevel(r);
        L.polyline([[v.lat, v.lon], [r.st.lat, r.st.lon]], { color: col, weight: r.ok ? 2.5 : 1.5, opacity: .75, dashArray: r.ok ? null : '4 4', interactive: false }).addTo(layer);
        L.circleMarker([r.st.lat, r.st.lon], { radius: 6, color: '#fff', weight: 1, fillColor: col, fillOpacity: r.ok ? .95 : .4 })
          .bindPopup('<b>' + esc(r.st.name) + '</b> · ' + r.alert_id + '<br>' + (r.sent ? r.heard_of_sent + ' of ' + r.sent + ' heard at the site (' + r.pct + '%)' : r.ok + ' heard at the site; the network stored none')
            + (r.only_here ? '<br>' + r.only_here + ' heard only here' : '') + (lv ? '<br>' + lv.p50 + ' ' + lv.unit + ' median' : '') + (r.snr_db != null ? ', SNR ' + r.snr_db + ' dB' : '')
            + (r.km != null ? '<br>' + fmtKm(r.km) + ' from the site' : ''))
          .addTo(layer);
        pts.push([r.st.lat, r.st.lon]);
      });
      L.circleMarker([v.lat, v.lon], { radius: 11, color: cssVar('--text', '#1b2733'), weight: 3, fillColor: cssVar('--accent', '#1f6feb'), fillOpacity: .9 })
        .bindPopup('<b>Survey site: ' + esc(v.name || v.id) + '</b><br>' + Number(v.ok).toLocaleString() + ' good frames over about ' + v.listening_h + ' h').addTo(layer);
      pts.push([v.lat, v.lon]);
    }
    if (pts.length) { const b = L.latLngBounds(pts); if (pts.length === 1) map.setView(b.getCenter(), 11); else map.fitBounds(b.pad(0.1)); }
    if (S.view) map.setView(S.view.center, S.view.zoom);
    map.on('moveend zoomend', () => { S.view = { center: map.getCenter(), zoom: map.getZoom() }; });
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 0);
  }
  function stopMap() { S.map = removeMap(S.map); S.layer = null; }

  // ── events ────────────────────────────────────────────────────────────────

  function refresh() { if (state.activeTab === 'reception') renderMain(); }
  function setLocal(v) { S.useLocal = !!v; refresh(); }
  function setWindow(v) { S.window = v; refresh(); }
  function setFilter(v) { S.filter = v; refresh(); }
  function select(id) { S.sel = S.sel === id ? null : id; refresh(); }
  function exportCsv() { RxLog.exportCsv(entries()); }
  function exportGeoJson() { RxLog.exportGeoJson(entries()); }

  function init() {
    registerTabTeardown('Reception', stop);
    drawMap();
    // Live: a new reception from this browser's cards redraws, at most every 3 s.
    if (!S.off && typeof RxLog !== 'undefined') S.off = RxLog.on(() => {
      if (!S.useLocal || state.activeTab !== 'reception' || S.timer) return;
      S.timer = setTimeout(() => { S.timer = 0; refresh(); }, 3000);
    });
  }
  function stop() {
    stopMap();
    if (S.off) { S.off(); S.off = null; }
    clearTimeout(S.timer); S.timer = 0;
  }

  return { render, init, stop, analyse, demoDrive, fromFile, fromReadings, setLocal, setWindow, setFilter, select, chooseFile, onFile, fromDb,
           fromStored, useReadings, loadDemo, clearLoaded, exportCsv, exportGeoJson, listSurveys, openSurvey, closeSurvey, setSurveyAll,
           exportSurveyCsv, _state: S };
})();

if (typeof window !== 'undefined') window.Reception = Reception;
