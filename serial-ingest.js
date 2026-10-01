// MegaNet — serial-ingest.js
//
//   SerialIngest   makes this computer a base station: the readings a Serial
//                  Monitor receiver decodes — a Quansheng radio, an ERT-A2, an
//                  RTL-SDR — posted into MegaNet's database, tagged with which
//                  receiver heard them and roughly where it is.
//
// After core.js (DB_URL, DB_ANON_KEY, DB_SCHEMA, esc, state, announce), before
// the three cards that call it (serial-radio.js, serial-sdr.js, serial-ert.js)
// and serial.js. Nothing in it runs at load.
//
// The door is the one every base station uses: meganet.ingest_http(), holding
// an ingest token (docs/ingest-http.md — "a PC on the end of a serial cable" is
// an ingest point, and so one token per computer). Readings go with source
// 'serial', the card's protocol, and path `serial-monitor/<point_id>`, which is
// how a reading says which receiver heard it: ingest() keeps that path, and the
// paths of up to eight more receivers that heard the same reading (dup_paths),
// so a reading heard by two of them is on record as heard by both.
//
// The receiver describes itself through meganet.report_ingest_point() (0045):
// its name, what it is, the device's details, and where it is — and where it is
// comes, today, from somewhere approximate, because none of these receivers has
// a GPS. The browser's own location (Wi-Fi or IP), a station the operator says
// it sits at, coordinates typed in, or the middle of the stations it hears: the
// database stores every one of those as approximate, and refuses to store
// anything but a GPS fix as exact.
//
// What never gets sent:
//   * a demo card's readings — they are made up;
//   * a reading without a time it can stand behind. A port's reading arriving
//     now is timed now. A followed log's history arrives all at once, so a
//     reading from it goes only if it carries its own time (the radio's clock,
//     the ERT-A2 frame's time of day); otherwise it is counted and skipped. An
//     RTL-SDR replaying an IQ file is history too.
//
// The queue survives a reload (localStorage, the newest 5,000), a retry is
// safe — ingest() stores the same reading once however often it is posted —
// and a refused token stops sending and says so rather than retrying for ever.

const SerialIngest = (function () {
  const STORE = 'mn-ingest';
  const QUEUE_MAX = 20000, KEEP_MAX = 5000, BATCH_MAX = 1000;
  const FLUSH_MS = 5000, REPORT_MS = 15 * 60 * 1000, BACKOFF_MAX = 5 * 60 * 1000;
  const RECEIVER = { quansheng: 'quansheng', ert: 'ert-a2', sdr: 'rtl-sdr' };
  const PREFIX = { quansheng: 'qs', ert: 'ert', sdr: 'sdr' };
  const KIND_LABEL = { quansheng: 'Quansheng radio', ert: 'ERT-A2', sdr: 'RTL-SDR' };
  const LOC_LABEL = {
    browser: 'this computer\'s location, as the browser gives it',
    station: 'at a station',
    manual:  'coordinates typed in',
    heard:   'the middle of the stations it hears',
    none:    'not given',
  };

  // ── what this browser keeps ───────────────────────────────────────────────

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) {}
    s.points = s.points || {};
    return s;
  }
  function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) {} }

  function rid() {
    const a = new Uint8Array(4);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; });
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // A receiver's identity in this browser: one slot per kind, a second for a
  // second card of the same kind at once. The point id is made once and kept,
  // so the same radio on the same computer is the same receiver next week.
  function slotFor(c) {
    const s = load();
    const used = new Set(Serial.list().filter(x => x !== c && x.ingest && x.ingest.slot).map(x => x.ingest.slot));
    let slot = c.kind, n = 1;
    while (used.has(slot)) slot = c.kind + '#' + (++n);
    if (!s.points[slot]) {
      s.points[slot] = { pointId: PREFIX[c.kind] + '-' + rid(), name: defaultName(c, n), loc: { source: 'none' }, on: false };
      save(s);
    }
    return slot;
  }
  function defaultName(c, n) {
    const ua = navigator.userAgent || '';
    const os = /Windows/.test(ua) ? 'Windows PC' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux PC' : 'computer';
    return KIND_LABEL[c.kind] + (n > 1 ? ' ' + n : '') + ' on a ' + os;
  }
  function point(c) { const s = load(); return s.points[c.ingest.slot]; }
  function setPoint(c, patch) {
    const s = load();
    s.points[c.ingest.slot] = Object.assign({}, s.points[c.ingest.slot], patch);
    save(s);
  }

  function state_(c) {
    if (!c.ingest) {
      c.ingest = { slot: null, on: false, queue: [], frames: [], inflight: false, timer: 0, reportTimer: 0, backoff: 0,
        posted: 0, accepted: 0, dup: 0, rejected: 0, reasons: [], skipped: 0, dropped: 0, lastAt: 0, err: '', label: '',
        reportErr: '', reported: false, persistTimer: 0, tsNote: '' };
      c.ingest.slot = slotFor(c);
      restore(c);
      if (point(c).on && load().token && !isDemo(c)) start(c, true);
    }
    return c.ingest;
  }

  function isDemo(c) { return c.phase === 'demo' || !!c.demo; }

  // ── readings in ───────────────────────────────────────────────────────────

  // From a card: [{ alert_id, value_raw, ts (ms) | null, protocol, line? }].
  // `ts` null is a reading with no time this card can stand behind.
  function add(c, items) {
    if (!c || isDemo(c) || !RECEIVER[c.kind]) return;
    const g = state_(c);
    if (!g.on) return;
    items.forEach(it => {
      if (it.ts == null || !isFinite(it.ts)) { g.skipped++; return; }
      g.queue.push({ alert_id: it.alert_id, reading_ts: Math.round(it.ts), value_raw: it.value_raw, protocol: it.protocol || 'alert' });
      if (it.line) { g.frames.push(it.line); if (g.frames.length > 200) g.frames.shift(); }
    });
    if (g.queue.length > QUEUE_MAX) { g.dropped += g.queue.length - QUEUE_MAX; g.queue.splice(0, g.queue.length - QUEUE_MAX); }
    persistSoon(c);
    schedule(c, g.queue.length >= 500 ? 0 : FLUSH_MS);
    paint(c);
  }

  // A time for a reading that carries none but arrived now — or null for one
  // out of a log's history or a replayed capture.
  function arrival(c) {
    if (c.history || (c.kind === 'sdr' && c.source === 'file')) return null;
    return Date.now();
  }

  function schedule(c, ms) {
    const g = c.ingest;
    if (!g.on || g.inflight) return;
    clearTimeout(g.timer);
    g.timer = setTimeout(() => flush(c), Math.max(ms, g.backoff));
  }

  function headers(token) {
    return { apikey: DB_ANON_KEY, 'X-Ingest-Token': token, 'Content-Type': 'application/json', 'Content-Profile': DB_SCHEMA };
  }

  async function flush(c) {
    const g = c.ingest, token = load().token;
    if (!g.on || g.inflight || !g.queue.length) return;
    if (!token) { stop(c, 'No ingest token — paste one in to send.'); return; }
    g.inflight = true;
    const batch = g.queue.slice(0, BATCH_MAX);
    // One protocol a batch: the envelope carries it, and ALERT and ALERT2
    // readings from one card are not mixed (an ERT-A2 sends only ALERT2).
    const proto = batch[0].protocol;
    const same = batch.filter(r => r.protocol === proto);
    const body = { payload: {
      source: 'serial', protocol: proto, path: 'serial-monitor/' + point(c).pointId,
      frame: g.frames.join('\n').slice(-32768) || undefined,
      readings: same.map(r => ({ alert_id: r.alert_id, reading_ts: r.reading_ts, value_raw: r.value_raw })),
    } };
    let res, out;
    try {
      res = await fetch(DB_URL + '/rpc/ingest_http', { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
      out = await res.json().catch(() => null);
    } catch (e) {
      g.inflight = false;
      g.err = 'Could not reach the database (' + ((e && e.message) || e) + ') — keeping ' + g.queue.length + ' to send, trying again shortly.';
      backoff(c);
      return;
    }
    g.inflight = false;
    if (res.ok && out && typeof out.accepted === 'number') {
      const sent = new Set(same);
      g.queue = g.queue.filter(r => !sent.has(r));
      g.frames = [];
      g.posted += same.length; g.accepted += out.accepted; g.dup += out.duplicates || 0;
      (out.rejected || []).forEach(x => {
        g.rejected++;
        const r = same[x.i];
        g.reasons.unshift((r ? 'ID ' + r.alert_id + ': ' : '') + x.why);
      });
      g.reasons = g.reasons.slice(0, 4);
      g.lastAt = Date.now(); g.err = ''; g.backoff = 0;
      persistSoon(c);
      if (g.queue.length) schedule(c, 0);
    } else if (res.status === 401 || res.status === 403) {
      stop(c, 'The database refused the ingest token (' + res.status + ') — it is mistyped, or it has been revoked. Nothing is lost: '
        + g.queue.length + ' reading' + (g.queue.length === 1 ? ' is' : 's are') + ' kept to send once a working token is in.');
      announce((c.name || 'Card') + ' — the ingest token was refused; sending to MegaNet stopped');
    } else if (res.status === 400) {
      // The contract was misread, by this file: the batch would fail the same
      // way for ever, so it is dropped and said rather than retried.
      const sent = new Set(same);
      g.queue = g.queue.filter(r => !sent.has(r));
      g.err = 'The database refused a batch of ' + same.length + ' as malformed (' + ((out && (out.message || out.hint)) || res.status) + ') — dropped.';
      persistSoon(c);
    } else {
      g.err = 'The database answered ' + res.status + ((out && out.message) ? ' (' + out.message + ')' : '') + ' — keeping ' + g.queue.length + ', trying again shortly.';
      backoff(c);
    }
    paint(c);
  }

  function backoff(c) {
    const g = c.ingest;
    g.backoff = Math.min(BACKOFF_MAX, g.backoff ? g.backoff * 2 : 10000);
    paint(c);
    schedule(c, g.backoff);
  }

  // ── the receiver describes itself ─────────────────────────────────────────

  function detail(c) {
    const d = { app: 'MegaNet Serial Monitor', via: c.kind === 'sdr' ? (c.source === 'file' ? 'IQ replay' : 'USB')
      : c.follow ? 'log file' : 'COM port', browser: (navigator.userAgent || '').slice(0, 160) };
    if (c.kind === 'quansheng' && c.radio) {
      const sc = c.radio.schema || {};
      if (sc.fw) d.firmware = sc.fw;
      if (sc.schema != null) d.schema = sc.schema;
      if (c.radio.stnInfo && c.radio.stnInfo.source) d.station_table = c.radio.stnInfo.source;
    }
    if (c.kind === 'ert' && c.ert) {
      if (c.ert.fmt) d.format = c.ert.fmt === 'ascii' ? 'rs232-ascii' : 'usb-binary';
      if (c.ert.lastFrame && c.ert.lastFrame.hdr && c.ert.lastFrame.hdr.decoder != null) d.decoder_address = String(c.ert.lastFrame.hdr.decoder);
      if (c.ert.sources && c.ert.sources.size) d.source_addresses = [...c.ert.sources].slice(0, 8);
    }
    if (c.kind === 'sdr' && c.cfg) {
      d.freq_mhz = +(c.cfg.freq / 1e6).toFixed(4);
      if (c.info && c.info.tuner) d.tuner = String(c.info.tuner);
      if (c.cfg.model) d.model = c.cfg.model;
    }
    return d;
  }

  async function report(c) {
    const g = c.ingest, token = load().token, p = point(c);
    if (!g.on || !token) return;
    const loc = p.loc || { source: 'none' };
    const body = { payload: {
      point_id: p.pointId, name: p.name, receiver: RECEIVER[c.kind], detail: detail(c),
      location_source: loc.source || 'none', location_note: locNote(loc),
    } };
    if (loc.source && loc.source !== 'none' && isFinite(loc.lat) && isFinite(loc.lon)) {
      body.payload.lat = loc.lat; body.payload.lon = loc.lon;
      if (isFinite(loc.accuracy_m)) body.payload.accuracy_m = loc.accuracy_m;
      if (loc.station) body.payload.host_station_id = loc.station;
    } else body.payload.location_source = 'none';
    try {
      const res = await fetch(DB_URL + '/rpc/report_ingest_point', { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (res.ok && out) { g.label = out.label || ''; g.reported = true; g.reportErr = ''; }
      else if (res.status === 404) g.reportErr = 'The database cannot record this receiver\'s description yet (migration 0045 is not applied there). Readings still go, tagged with the receiver\'s id.';
      else if (res.status === 401 || res.status === 403) g.reportErr = 'The ingest token was refused.';
      else g.reportErr = 'The receiver\'s description was not recorded (' + res.status + ((out && out.message) ? ': ' + out.message : '') + ').';
    } catch (e) {
      g.reportErr = 'The receiver\'s description was not recorded: ' + ((e && e.message) || e) + '.';
    }
    paint(c);
  }

  function locNote(loc) {
    if (!loc || !loc.source || loc.source === 'none') return 'No location given. No GPS.';
    const acc = isFinite(loc.accuracy_m) ? ', ±' + fmtDist(loc.accuracy_m) : '';
    if (loc.source === 'browser') return 'Approximate: the browser\'s location for this computer (Wi-Fi or IP)' + acc + '. No GPS.';
    if (loc.source === 'station') return 'Approximate: the operator says the receiver is at ' + (loc.stationName || loc.station) + '. No GPS.';
    if (loc.source === 'manual') return 'Approximate: coordinates typed in by the operator. No GPS.';
    if (loc.source === 'heard') return 'Approximate: the middle of ' + (loc.n || 'the') + ' stations it heard' + acc + '. No GPS.';
    return 'Approximate. No GPS.';
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km'; }

  // ── on and off ────────────────────────────────────────────────────────────

  function start(c, quiet) {
    const g = c.ingest;
    g.on = true; g.err = '';
    setPoint(c, { on: true });
    clearInterval(g.reportTimer);
    g.reportTimer = setInterval(() => report(c), REPORT_MS);
    report(c);
    schedule(c, 0);
    if (!quiet) announce((c.name || 'Card') + ' — sending readings to MegaNet');
    if (quiet && typeof Serial !== 'undefined') Serial.logLine(c, 'Sending readings to MegaNet again, as this receiver was last time', 'sys');
  }
  function stop(c, why) {
    const g = c.ingest;
    g.on = false;
    clearTimeout(g.timer); clearInterval(g.reportTimer);
    if (why) g.err = why; else setPoint(c, { on: false });
    persistNow(c);
    paint(c);
  }

  function toggle(id, on) {
    const c = Serial.findConn(id);
    if (!c) return;
    const g = state_(c);
    if (on) {
      if (isDemo(c)) { g.err = 'A demo card\'s readings are made up, so it never sends them.'; paint(c); renderCard(c); return; }
      if (!load().token) { g.err = 'Paste the ingest token for this computer first.'; paint(c); renderCard(c); return; }
      start(c);
    } else {
      stop(c);
      announce((c.name || 'Card') + ' — stopped sending readings to MegaNet');
    }
    renderCard(c);
  }

  function renderCard(c) { const el = document.getElementById('ing-' + c.id); if (el) el.outerHTML = panel(c, true); paint(c); }

  // ── the queue across a reload ─────────────────────────────────────────────

  function qkey(c) { return STORE + '-queue-' + point(c).pointId; }
  function persistSoon(c) {
    const g = c.ingest;
    if (g.persistTimer) return;
    g.persistTimer = setTimeout(() => { g.persistTimer = 0; persistNow(c); }, 2000);
  }
  function persistNow(c) {
    const g = c.ingest;
    try {
      if (g.queue.length) localStorage.setItem(qkey(c), JSON.stringify(g.queue.slice(-KEEP_MAX)));
      else localStorage.removeItem(qkey(c));
    } catch (_) {}
  }
  function restore(c) {
    try {
      const q = JSON.parse(localStorage.getItem(qkey(c)) || '[]');
      if (Array.isArray(q) && q.length) c.ingest.queue = q.filter(r => r && r.alert_id != null && r.reading_ts != null).concat(c.ingest.queue);
    } catch (_) {}
  }

  // ── the settings ──────────────────────────────────────────────────────────

  function setToken(id, v) {
    const s = load();
    s.token = String(v || '').trim();
    save(s);
    const c = Serial.findConn(id);
    if (c && c.ingest) {
      c.ingest.err = ''; c.ingest.label = '';
      if (c.ingest.on) { report(c); schedule(c, 0); }
      paint(c);
    }
  }
  function setName(id, v) {
    const c = Serial.findConn(id); if (!c) return;
    state_(c);
    setPoint(c, { name: String(v || '').trim().slice(0, 120) || defaultName(c, 1) });
    if (c.ingest.on) report(c);
  }
  function setLoc(c, loc) {
    setPoint(c, { loc });
    if (c.ingest.on) report(c);
    renderCard(c);
  }
  function setLocSource(id, src) {
    const c = Serial.findConn(id); if (!c) return;
    state_(c);
    const cur = point(c).loc || {};
    if (src === 'browser') return locate(id);
    if (src === 'heard') return fromHeard(id);
    if (src === 'none') return setLoc(c, { source: 'none' });
    // station and manual wait for what is typed; keep the source chosen
    setPoint(c, { loc: Object.assign({}, cur, { source: src, lat: undefined, lon: undefined, pending: true }) });
    renderCard(c);
  }

  function locate(id) {
    const c = Serial.findConn(id); if (!c) return;
    const g = state_(c);
    if (!navigator.geolocation) { g.err = 'This browser cannot give a location. Choose a station or type the coordinates instead.'; renderCard(c); return; }
    g.err = 'Asking the browser for this computer\'s location…'; paint(c);
    navigator.geolocation.getCurrentPosition(pos => {
      g.err = '';
      setLoc(c, { source: 'browser', lat: +pos.coords.latitude.toFixed(5), lon: +pos.coords.longitude.toFixed(5),
        accuracy_m: Math.round(pos.coords.accuracy || 0) || undefined, at: Date.now() });
    }, e => {
      g.err = (e && e.code === 1)
        ? 'The browser will not give this computer\'s location (blocked here, or by IT policy). Choose a station or type the coordinates instead.'
        : 'The browser could not work out a location (' + ((e && e.message) || 'no answer') + '). Choose a station or type the coordinates instead.';
      renderCard(c);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 });
  }

  function setStation(id, text) {
    const c = Serial.findConn(id); if (!c) return;
    const g = state_(c);
    const st = findStation(text);
    if (!st) { g.err = 'No one station matches “' + text + '” — use its station number, or more of its name.'; renderCard(c); return; }
    if (st.lat == null || st.lon == null) { g.err = st.name + ' has no coordinates on file.'; renderCard(c); return; }
    g.err = '';
    setLoc(c, { source: 'station', station: st.id, stationName: st.name, lat: +st.lat, lon: +st.lon });
  }
  function findStation(text) {
    const q = String(text || '').trim().toLowerCase();
    const list = state.data && Array.isArray(state.data.stations) ? state.data.stations : [];
    if (!q || !list.length) return null;
    const exact = list.filter(s => String(s.id).toLowerCase() === q || String(s.station_number || '').toLowerCase() === q
      || String(s.name || '').toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    const part = list.filter(s => String(s.name || '').toLowerCase().indexOf(q) >= 0);
    return part.length === 1 ? part[0] : null;
  }

  function setManual(id, text) {
    const c = Serial.findConn(id); if (!c) return;
    const g = state_(c);
    const m = String(text || '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    let lat = m ? +m[1] : NaN, lon = m ? +m[2] : NaN;
    // Written longitude first, as a map copy-out sometimes is: Australia's
    // longitudes cannot be latitudes.
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lat; lat = lon; lon = t; }
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { g.err = 'Type the location as “latitude, longitude”, e.g. −27.4698, 153.0251.'; renderCard(c); return; }
    g.err = '';
    setLoc(c, { source: 'manual', lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
  }

  // Where the stations it hears put it: the ALERT2 tab's own answer for where
  // a capture is (the median of the addresses only one station carries), with
  // the median distance from there to them as the radius.
  function fromHeard(id) {
    const c = Serial.findConn(id); if (!c) return;
    const g = state_(c);
    const ids = heardIds(c);
    const res = ids.length ? Alert2.resolve({ records: ids.map(a => ({ alertId: a, ok: true })) }) : null;
    if (!res || !res.centre) { g.err = 'Not enough heard yet: this needs readings from at least one address that only one station carries.'; renderCard(c); return; }
    const ctr = res.centre;
    const d = [];
    res.byAlertId.forEach(info => {
      if (info.conf === 'sole' && info.chosen && info.chosen.station.lat != null) {
        const s = info.chosen.station;
        const dy = (s.lat - ctr.lat) * 111320, dx = (s.lon - ctr.lon) * 111320 * Math.cos(ctr.lat * Math.PI / 180);
        d.push(Math.sqrt(dx * dx + dy * dy));
      }
    });
    d.sort((a, b) => a - b);
    g.err = '';
    setLoc(c, { source: 'heard', lat: +ctr.lat.toFixed(4), lon: +ctr.lon.toFixed(4), n: ctr.n,
      accuracy_m: d.length ? Math.max(1000, Math.round(d[d.length >> 1])) : undefined });
  }
  function heardIds(c) {
    if (c.kind === 'quansheng' && c.radio) return [...c.radio.stations.keys()];
    if (c.kind === 'ert' && c.ert) return [...new Set(c.ert.recs.filter(r => r.ok).map(r => r.alertId))];
    if (c.kind === 'sdr' && c.readings) return [...new Set(c.readings.map(r => r.sensorId))];
    return [];
  }

  // A card's word on how its readings are being timed, shown in the status.
  function note(c, text) {
    if (!c || !c.ingest || c.ingest.tsNote === text) return;
    c.ingest.tsNote = text;
    paint(c);
  }

  function sendNow(id) { const c = Serial.findConn(id); if (c && c.ingest) { c.ingest.backoff = 0; schedule(c, 0); report(c); } }

  // ── the panel ─────────────────────────────────────────────────────────────

  function locText(loc) {
    if (!loc || !loc.source || loc.source === 'none') return 'No location given.';
    if (loc.pending || !isFinite(loc.lat)) return loc.source === 'station' ? 'Type a station below.' : 'Type the coordinates below.';
    return loc.lat.toFixed(4) + ', ' + loc.lon.toFixed(4) + (isFinite(loc.accuracy_m) ? ' ± ' + fmtDist(loc.accuracy_m) : '')
      + ' — approximate (' + LOC_LABEL[loc.source] + (loc.stationName ? ': ' + loc.stationName : '') + '), recorded as approximate. No GPS.';
  }

  function panel(c, open) {
    if (!RECEIVER[c.kind]) return '';
    if (isDemo(c)) {
      return '<details class="qs-ctl ing-ctl" id="ing-' + c.id + '"><summary>Send to MegaNet <span class="qs-dim">· never, from a demo</span></summary>'
        + '<p class="qs-hint">A demo card\'s readings are made up, so it never sends them. Add a real ' + KIND_LABEL[c.kind]
        + ' card to make this computer a base station that posts what it hears into MegaNet.</p></details>';
    }
    const g = state_(c), p = point(c), id = c.id, s = load();
    const loc = p.loc || { source: 'none' };
    const demo = false;
    const radio = (v) => '<label class="ser-check"><input type="radio" name="ing-loc-' + id + '" value="' + v + '"'
      + (loc.source === v ? ' checked' : '') + ' onchange="SerialIngest.setLocSource(\'' + id + '\',this.value)"> ' + esc(LOC_LABEL[v]) + '</label>';
    return '<details class="qs-ctl ing-ctl" id="ing-' + id + '"' + (open || g.on ? ' open' : '') + '>'
      + '<summary>Send to MegaNet <span class="qs-dim" id="ing-sum-' + id + '">' + esc(summary(c)) + '</span></summary>'
      + '<p class="qs-hint">Makes this computer a base station: every reading this card decodes is posted into MegaNet\'s database '
      + 'the way a base station\'s logger posts them, tagged with this receiver so its readings can be told from every other ingest point\'s. '
      + '<a href="docs/ingest-serial-monitor.md" target="_blank" rel="noopener">How it works, and getting a token</a></p>'
      + (demo ? '<p class="qs-hint txt-warn">A demo card\'s readings are made up, so it never sends them.</p>' : '')
      + '<div class="ing-grid">'
      + '<label>Ingest token for this computer <input type="password" autocomplete="off" spellcheck="false" placeholder="mgn_…" value="' + esc(s.token || '')
      + '" onchange="SerialIngest.setToken(\'' + id + '\',this.value)"></label>'
      + '<label>Receiver name <input type="text" maxlength="120" value="' + esc(p.name) + '" onchange="SerialIngest.setName(\'' + id + '\',this.value)"></label>'
      + '</div>'
      + '<p class="qs-small qs-dim">Receiver id <code>' + esc(p.pointId) + '</code> — every reading it sends carries the path <code>serial-monitor/' + esc(p.pointId)
      + '</code>. The token is kept in this browser only.</p>'
      + '<fieldset class="ing-loc"><legend>Where the receiver is — there is no GPS, so this is approximate and recorded as such</legend>'
      + radio('browser') + radio('station') + radio('manual') + radio('heard') + radio('none')
      + (loc.source === 'station' ? '<label class="ing-inline">Station <input type="text" placeholder="name or station number" value="' + esc(loc.stationName || '')
          + '" onchange="SerialIngest.setStation(\'' + id + '\',this.value)"></label>' : '')
      + (loc.source === 'manual' ? '<label class="ing-inline">Latitude, longitude <input type="text" placeholder="-27.4698, 153.0251" value="'
          + (isFinite(loc.lat) ? loc.lat + ', ' + loc.lon : '') + '" onchange="SerialIngest.setManual(\'' + id + '\',this.value)"></label>' : '')
      + (loc.source === 'browser' ? ' <button type="button" class="ghost" onclick="SerialIngest.locate(\'' + id + '\')">Ask again</button>' : '')
      + (loc.source === 'heard' ? ' <button type="button" class="ghost" onclick="SerialIngest.setLocSource(\'' + id + '\',\'heard\')">Work it out again</button>' : '')
      + '<p class="qs-small" id="ing-loc-text-' + id + '">' + esc(locText(loc)) + '</p></fieldset>'
      + '<div class="ser-actions">'
      + '<label class="ser-check"><input type="checkbox"' + (g.on ? ' checked' : '') + (demo ? ' disabled' : '')
      + ' onchange="SerialIngest.toggle(\'' + id + '\',this.checked)"> send this card\'s readings to MegaNet</label>'
      + (g.on ? '<button type="button" class="ghost" onclick="SerialIngest.sendNow(\'' + id + '\')">Send now</button>' : '')
      + '</div>'
      + '<p class="ing-status" id="ing-status-' + id + '"></p>'
      + '</details>';
  }

  function summary(c) {
    const g = c.ingest;
    if (!g || !g.on) return '· off';
    return '· on' + (g.accepted ? ' · ' + g.accepted + ' stored' : '') + (g.queue.length ? ' · ' + g.queue.length + ' waiting' : '');
  }

  function paint(c) {
    if (!c || !c.ingest) return;
    const g = c.ingest;
    const sum = document.getElementById('ing-sum-' + c.id);
    if (sum) sum.textContent = summary(c);
    // Sending can stop on its own (a refused token), and the box has to say so.
    const box = document.querySelector('#ing-' + c.id + ' input[type=checkbox]');
    if (box) box.checked = g.on;
    const el = document.getElementById('ing-status-' + c.id);
    if (!el) return;
    const bits = [];
    if (g.on) {
      bits.push((g.label ? 'Posting as ingest point “' + g.label + '”. ' : '')
        + g.accepted + ' stored, ' + g.dup + ' already there, ' + g.rejected + ' refused'
        + (g.queue.length ? ', ' + g.queue.length + ' waiting' : '')
        + (g.lastAt ? ' — last sent ' + SerialViz.hhmm(g.lastAt, true) : '') + '.');
    } else bits.push('Off.' + (g.queue.length ? ' ' + g.queue.length + ' reading' + (g.queue.length === 1 ? '' : 's') + ' kept from before, to send when it is on.' : ''));
    if (g.skipped) bits.push(g.skipped + ' reading' + (g.skipped === 1 ? '' : 's') + ' from a log\'s history (or a replay) skipped: no time to stand behind.');
    if (g.dropped) bits.push(g.dropped + ' dropped: more than ' + QUEUE_MAX + ' were waiting.');
    if (g.tsNote) bits.push(g.tsNote);
    if (g.reasons.length) bits.push('Last refused — ' + g.reasons.join('; '));
    if (g.reportErr) bits.push(g.reportErr);
    if (g.err) bits.push(g.err);
    el.textContent = bits.join(' ');
    el.classList.toggle('txt-warn', !!(g.err || g.reportErr));
  }

  // Called by each card after it renders.
  function mount(c) { if (RECEIVER[c.kind] && !isDemo(c)) { state_(c); paint(c); } }

  // The card is going away: whatever is waiting is kept for next time.
  function detach(c) {
    if (!c || !c.ingest) return;
    clearTimeout(c.ingest.timer); clearInterval(c.ingest.reportTimer); clearTimeout(c.ingest.persistTimer);
    persistNow(c);
  }

  return { add, arrival, note, panel, mount, paint, detach, toggle, setToken, setName, setLocSource, locate, setStation, setManual, sendNow,
           // for the check
           _locNote: locNote, _findStation: findStation };
})();

if (typeof window !== 'undefined') window.SerialIngest = SerialIngest;
