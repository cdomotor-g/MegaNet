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
// What counts as a bad copy: a decoded frame within three bits of a
// transmission heard at the same moment (the copies of one transmission land
// within seconds of each other — direct, then each repeater's re-send) that is
// not the majority version; a frame whose address no station carries but is
// within two bits of one this receiver has heard (a ghost); and whatever a
// card itself refused — the radio's unreported frames, the SDR's shadows, an
// ERT-A2 status byte or frame flag. A burst nothing decoded from counts for
// coverage, never as blame.
//
// Sources: this browser's reception log, live; a file (the log's CSV or
// GeoJSON export, from another computer or a vehicle rig); the database (0047,
// editors); and a demo drive, built against the real registry with one
// repeater made to flip bits, so the method can be seen before anyone drives.

const Reception = (function () {
  const WINDOW_MS = 3000;           // the copies of one transmission land within this of the first
  const MAX_FLIP = 3;               // bits — further apart than this is a different transmission
  const BANDS = [
    [-90, '--rssi-strong', '#137a3b'], [-100, '--rssi-good', '#5a9e18'], [-107, '--rssi-fair', '#b98511'],
    [-112, '--rssi-marginal', '#d4691f'], [-Infinity, '--rssi-weak', '#b3261e'],
  ];
  const S = {
    useLocal: true, loaded: [], loadedName: '', db: [], dbNote: '', demo: [], window: 'all', filter: '', onlyBad: false,
    sel: null, map: null, layer: null, view: null, off: null, timer: 0,
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

  // ── geometry ──────────────────────────────────────────────────────────────

  function km(aLat, aLon, bLat, bLon) {
    const R = 6371, p = Math.PI / 180;
    const dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function level(e) { return isFinite(e.rssi_dbm) && e.rssi_dbm != null ? e.rssi_dbm : isFinite(e.level_dbfs) && e.level_dbfs != null ? e.level_dbfs : null; }
  function placed(e) { return e.lat != null && e.lon != null && isFinite(e.lat) && isFinite(e.lon); }
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 4) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // ── the analysis (pure: entries in, findings out) ─────────────────────────

  function analyse(entries) {
    const R = registry();
    const list = entries.slice().sort((a, b) => a.t - b.t);
    const out = { receptions: list.length, placed: 0, undecoded: 0, events: [], bad: [], ghosts: 0, receivers: new Set() };

    // 1. Transmissions: copies of one frame, a few seconds and a few bits apart.
    const open = [];
    list.forEach(e => {
      out.receivers.add(e.point_id || e.receiver || '?');
      if (placed(e)) out.placed++;
      if (!decoded(e)) { if (e.fault === 'undecoded') out.undecoded++; return; }
      let ev = null;
      for (let i = open.length - 1; i >= 0; i--) {
        const o = open[i];
        if (e.t - o.t0 > WINDOW_MS) { open.splice(i, 1); continue; }
        if (flipBits(o.copies[0], e).total <= MAX_FLIP) { ev = o; break; }
      }
      if (!ev) { ev = { t0: e.t, copies: [] }; open.push(ev); out.events.push(ev); }
      ev.copies.push(e);
    });

    // 2. Each transmission's true version, and its bad copies.
    out.events.forEach(ev => {
      const votes = new Map();
      ev.copies.forEach(e => {
        if (!e.ok) return;
        const k = word(e);
        const v = votes.get(k) || { n: 0, lvl: -Infinity, e };
        v.n++; const l = level(e); if (l != null && l > v.lvl) v.lvl = l;
        votes.set(k, v);
      });
      // A version a station actually carries beats one nobody does; then the
      // most copies; then the loudest.
      let best = null;
      votes.forEach(v => {
        const known = R.byId.has(v.e.alert_id) ? 1 : 0;
        if (!best || known > best.known || (known === best.known && (v.n > best.n || (v.n === best.n && v.lvl > best.lvl)))) best = Object.assign({ known }, v);
      });
      ev.truth = best ? best.e : ev.copies[0];
      ev.station = stationOf(ev.truth.alert_id);
      ev.copies.forEach(e => {
        let why = null;
        if (!e.ok) why = e.fault || 'refused';
        else if (word(e) !== word(ev.truth)) why = 'flipped';
        if (why) out.bad.push({ e, why, truth: ev.truth, bits: flipBits(e, ev.truth), event: ev });
      });
    });

    // 3. Ghosts heard on their own: an address no station carries, within two
    // bits of one this receiver did hear clean.
    const heardClean = new Set(list.filter(e => e.ok && decoded(e) && R.byId.has(e.alert_id)).map(e => e.alert_id));
    out.events.forEach(ev => {
      if (ev.copies.length !== 1 || !ev.truth.ok || R.byId.has(ev.truth.alert_id)) return;
      const e = ev.truth;
      const near = [...heardClean].filter(a => pop((a ^ e.alert_id) & 0x1FFF) <= 2);
      if (!near.length) return;
      const truth = { alert_id: near[0], value_raw: e.value_raw };
      ev.station = stationOf(near[0]);
      out.ghosts++;
      out.bad.push({ e, why: 'ghost', truth, bits: flipBits(e, truth), event: ev, ghostOf: near });
    });

    // 4. Suspects.
    const sus = new Map();
    const get = r => { let s = sus.get(r.st.id); if (!s) { s = { r, events: 0, bad: 0, only: 0, blame: 0, ids: new Set(), badPts: [] }; sus.set(r.st.id, s); } return s; };
    out.events.forEach(ev => {
      const a = ev.truth.alert_id;
      if (!R.byId.has(a)) return;
      R.repeaters.forEach(r => { if (passes(r, a)) { const s = get(r); s.events++; s.ids.add(a); } });
    });
    out.bad.forEach(b => {
      const a = b.truth.alert_id;
      const cands = R.repeaters.filter(r => passes(r, a));
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
    list = list.concat(S.loaded, S.db, S.demo);
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
  function clearLoaded() { S.loaded = []; S.db = []; S.demo = []; S.loadedName = ''; S.note = ''; S.dbNote = ''; refresh(); }

  // ── rendering ─────────────────────────────────────────────────────────────

  function bandOf(l) { if (l == null) return null; return BANDS.find(b => l > b[0]) || BANDS[BANDS.length - 1]; }
  function colorOf(l) { const b = bandOf(l); return b ? cssVar(b[1], b[2]) : cssVar('--muted', '#5a6b7d'); }
  function stLink(st) { return st ? '<button type="button" class="link-btn" onclick="goToStation(\'' + escAttr(st.id) + '\')">' + esc(st.name) + '</button>' : '<span class="qs-dim">—</span>'; }
  function hm(t) { return SerialViz && SerialViz.hhmm ? SerialViz.hhmm(t, true) : new Date(t).toLocaleTimeString(); }
  function fmtKm(d) { return d == null ? '—' : d < 10 ? d.toFixed(1) + ' km' : Math.round(d) + ' km'; }

  function filtered(a) {
    const q = S.filter.trim().toLowerCase();
    if (!q) return a;
    const R = registry();
    const ids = new Set();
    q.split(/[\s,]+/).forEach(tok => {
      if (/^\d+$/.test(tok)) ids.add(+tok);
      R.stations.forEach(s => { if ((s.name || '').toLowerCase().includes(tok) || String(s.station_number || '') === tok) stationAlertIds(s).forEach(x => ids.add(x)); });
    });
    return { ...a, bad: a.bad.filter(b => ids.has(b.truth.alert_id) || ids.has(b.e.alert_id)) };
  }

  function chips(a) {
    const c = (k, v, cls) => '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(k) + '</span><span class="qs-chip-v">' + v + '</span></div>';
    return '<div class="qs-status">'
      + c('Receptions', a.receptions + (a.undecoded ? ' · ' + a.undecoded + ' undecoded bursts' : ''))
      + c('With a position', a.placed + (a.receptions ? ' (' + Math.round(100 * a.placed / a.receptions) + '%)' : ''), a.receptions && !a.placed ? 'warn' : '')
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

  function badHtml(a) {
    if (!a.bad.length) return '<p class="qs-dim small">No bad copies' + (a.receptions ? ' in what was heard.' : ' — nothing heard yet.') + '</p>';
    const rows = a.bad.slice().sort((x, y) => y.e.t - x.e.t).slice(0, 300).map(b => {
      const st = stationOf(b.truth.alert_id);
      const what = { flipped: 'flipped', ghost: 'ghost address', rejected: 'radio rejected', shadow: 'decoder shadow', status: 'status byte', frame: 'frame flagged', undecoded: 'undecoded' }[b.why] || b.why;
      return '<tr><td class="qs-time">' + hm(b.e.t) + '</td><td class="qs-num">' + b.e.alert_id + ' = ' + b.e.value_raw + '</td>'
        + '<td class="qs-num">' + b.truth.alert_id + ' = ' + b.truth.value_raw + '</td><td>' + stLink(st) + '</td>'
        + '<td class="qs-num">' + (b.bits.total ? b.bits.addr + ' addr · ' + b.bits.value + ' value' : '—') + '</td>'
        + '<td class="small">' + esc(what) + '</td><td class="qs-num">' + (level(b.e) == null ? '—' : level(b.e) + (b.e.rssi_dbm != null ? ' dBm' : ' dBFS')) + '</td>'
        + '<td class="small col-optional">' + (placed(b.e) ? b.e.lat.toFixed(4) + ', ' + b.e.lon.toFixed(4) : '—') + '</td></tr>';
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
        <p class="sub">What the Serial Monitor's receivers heard, where, and how strongly — and which transmitter is sending bad packets.
          Every frame a Quansheng, RTL-SDR or ERT-A2 card hears is logged with its level and the receiver's position (a GPS card's fix, this
          device's location, or the receiver's fixed location). Bad copies — flipped bits, ghost addresses, frames a receiver refused — are laid
          against the repeaters whose pass ranges could have carried them.</p>
        <div class="rx-sources">
          <label class="ser-check"><input type="checkbox" ${S.useLocal ? 'checked' : ''} onchange="Reception.setLocal(this.checked)"> this browser's log (${local})</label>
          <button class="ghost" onclick="Reception.chooseFile()">Load a log file…</button>
          <button class="ghost" onclick="Reception.fromDb()">From the database</button>
          <button class="ghost" onclick="Reception.loadDemo()">Demo drive</button>
          ${S.loaded.length || S.db.length || S.demo.length ? '<button class="ghost" onclick="Reception.clearLoaded()">Clear loaded</button>' : ''}
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
        ${chips(a)}
      </div>
      <div class="panel">
        <div class="rx-map" id="rx-map" role="region" aria-label="Reception map"></div>
        <div class="qs-legend">${BANDS.map((b, i) => '<span><i class="qs-sw rx-sw" style="--dot: var(' + b[1] + ')"></i>' + ['> −90', '−90 to −100', '−100 to −107', '−107 to −112', '< −112'][i] + ' dBm</span>').join('')}
          <span><i class="qs-sw rx-sw rx-sw-bad"></i>bad copy</span><span><i class="qs-sw rx-sw rx-sw-rep"></i>repeater</span><span><i class="qs-sw rx-sw rx-sw-cen"></i>where bad copies are loudest</span></div>
        <p class="qs-hint">Each dot is where a receiver was when it heard something. Pick a repeater below to draw lines from it to the bad copies it could have carried.
          ${a.receptions && !a.placed ? '<strong>None of these receptions has a position</strong> — the map is empty, but the pass-range ranking below still works. Add a GPS card on the Serial Monitor, tick “track this device’s position”, or give the receiver a fixed location.' : ''}</p>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rx-h-sus">Suspect repeaters</h3></div>
        ${cen}
        ${suspectsHtml(a)}
        <p class="qs-hint">Blame: each bad copy shared evenly among the repeaters whose pass ranges let its true address through — the common factor
          collects it. RSSI vs distance r: strongly negative when bad copies get louder the closer the receiver was to that repeater (needs positions).
          This narrows the search; it does not convict — confirm on site with the repeater's own logs or a receiver parked beside it.</p>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rx-h-bad">Bad copies</h3></div>
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

  return { render, init, stop, analyse, demoDrive, fromFile, setLocal, setWindow, setFilter, select, chooseFile, onFile, fromDb,
           loadDemo, clearLoaded, exportCsv, exportGeoJson, _state: S };
})();

if (typeof window !== 'undefined') window.Reception = Reception;
