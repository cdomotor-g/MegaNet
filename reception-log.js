// MegaNet — reception-log.js
//
//   RxLog   every frame a Serial Monitor receiver hears — good or bad — with
//           its signal level and where the receiver was at the time. The raw
//           material of the Reception Map (reception.js): driving the network
//           with a receiver, mapping who is heard where and how strongly, and
//           finding the transmitter that is sending bad packets.
//
// After core.js, before serial.js and the cards that call it; reaches across
// to serial-gps.js for the position and serial-ingest.js for the receiver's id,
// its fixed location and its token. Nothing here runs at load.
//
// A reception is not a reading. A reading is a value MegaNet keeps once (the
// same address, time and value stored once, whoever heard it); a reception is
// one receiver hearing one frame once — the same station's report heard direct
// and again through two repeaters is three receptions, and a copy that came
// through with flipped bits is a reception of something no station sent. That
// is exactly what finding a repeater that corrupts what it relays needs, and
// exactly what readings throw away. So every card logs here as well:
//
//   Quansheng   each DEC (ok), each frame the radio's own bits show it heard
//               and did not report (fault 'rejected'), and each burst nothing
//               could be read from (fault 'undecoded', no address)
//   RTL-SDR     each accepted reading (ok, with its votes), each bit-flip
//               shadow the decoder set aside (fault 'shadow'), each burst
//               with nothing decoded
//   ERT-A2      each reading (fault 'status' when its status byte is set), and
//               each frame that would not decode (fault 'frame')
//
// Where the receiver was, best first: a GPS card's fix (under 10 s old) —
// source 'gps'; this device's own location while "Track position" is on —
// source 'browser', with the accuracy it states (a phone or tablet's is GPS in
// all but name; a laptop's is Wi-Fi); the receiver's fixed location (Send to
// MegaNet); otherwise none. A reception out of a followed log's history has no
// position worth giving — the vehicle has moved since — and gets none.
//
// Kept in this browser (localStorage, the newest 10,000), exported as CSV or
// GeoJSON, and — when the receiver is sending to MegaNet — posted to
// meganet.report_receptions() (0047), the same token, editors-only to read.
// A demo card's receptions are logged (marked demo, so the map can be tried
// with nothing plugged in) and never posted.

const RxLog = (function () {
  const STORE = 'mn-rxlog', KEEP = 10000, MAX = 50000, BATCH = 1000, UPLOAD_MS = 10000;
  const DEV_STALE_MS = 30000;
  let entries = null, seq = 0, persistTimer = 0, uploadTimer = 0, uploading = false;
  let watchId = null, devFix = null, devErr = '';
  const status = { sent: 0, refused: 0, err: '', missing: false };
  const listeners = new Set();

  function all() {
    if (!entries) {
      try { entries = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch (_) { entries = []; }
      if (!Array.isArray(entries)) entries = [];
      seq = entries.reduce((m, e) => Math.max(m, e.n || 0), 0);
    }
    return entries;
  }
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      try { localStorage.setItem(STORE, JSON.stringify(all().slice(-KEEP))); } catch (_) {
        try { localStorage.setItem(STORE, JSON.stringify(all().slice(-Math.floor(KEEP / 4)))); } catch (_) {}
      }
    }, 3000);
  }

  function isDemo(c) { return c.phase === 'demo' || !!c.demo; }
  const RECEIVER = { quansheng: 'quansheng', ert: 'ert-a2', sdr: 'rtl-sdr', serial: 'serial' };

  // ── where the receiver is ─────────────────────────────────────────────────

  function position(c) {
    if (c.history) return { location_source: 'none' };
    const g = typeof SerialGps !== 'undefined' ? SerialGps.fix(isDemo(c)) : null;
    if (g) return { lat: g.lat, lon: g.lon, accuracy_m: g.accuracy_m, speed_mps: g.speed_mps, heading_deg: g.heading_deg,
      location_source: 'gps', location_approx: false };
    if (devFix && Date.now() - devFix.t < DEV_STALE_MS) return { lat: devFix.lat, lon: devFix.lon, accuracy_m: devFix.accuracy_m,
      speed_mps: devFix.speed_mps, heading_deg: devFix.heading_deg, location_source: 'browser', location_approx: true };
    const loc = typeof SerialIngest !== 'undefined' && SerialIngest.locOf ? SerialIngest.locOf(c) : null;
    if (loc && loc.source && loc.source !== 'none' && isFinite(loc.lat)) {
      return { lat: loc.lat, lon: loc.lon, accuracy_m: loc.accuracy_m, location_source: loc.source, location_approx: true };
    }
    return { location_source: 'none' };
  }

  function track(on) {
    if (!on) {
      if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null; devFix = null; devErr = '';
      notify();
      return;
    }
    if (!navigator.geolocation) { devErr = 'This browser cannot give a position.'; notify(); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(p => {
      devErr = '';
      devFix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy || 0) || null,
        speed_mps: p.coords.speed, heading_deg: p.coords.heading, t: Date.now() };
      notify();
    }, e => {
      devErr = e && e.code === 1 ? 'The browser will not give a position here (blocked, or by policy).' : 'No position yet (' + ((e && e.message) || 'no answer') + ').';
      notify();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    notify();
  }
  function tracking() { return watchId != null; }

  // ── receptions in ─────────────────────────────────────────────────────────

  function add(c, rx) {
    if (!c || c.rxlogOff || !RECEIVER[c.kind]) return;
    if (rx.t == null || !isFinite(rx.t)) return;
    const info = typeof SerialIngest !== 'undefined' && SerialIngest.pointInfo ? SerialIngest.pointInfo(c) : null;
    const e = Object.assign({
      n: ++seq, receiver: RECEIVER[c.kind], point_id: info ? info.pointId : null, point_name: info ? info.name : c.name,
      demo: isDemo(c) || undefined,
    }, rx, position(c));
    e.t = Math.round(e.t);
    all().push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    persistSoon();
    if (!e.demo) scheduleUpload();
    notify(e);
    paint(c);
  }

  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function notify(e) { listeners.forEach(fn => { try { fn(e); } catch (_) {} }); }

  // ── the database (0047) ───────────────────────────────────────────────────

  function scheduleUpload() {
    if (uploadTimer) return;
    uploadTimer = setTimeout(() => { uploadTimer = 0; upload(); }, UPLOAD_MS);
  }

  async function upload() {
    if (uploading || typeof SerialIngest === 'undefined' || !SerialIngest.token) return;
    const token = SerialIngest.token();
    if (!token) return;
    // Per receiver, and only while that receiver is set to send.
    const groups = new Map();
    all().forEach(e => {
      if (e.sent || e.demo || !e.point_id || !SerialIngest.pointIsOn(e.point_id)) return;
      const k = e.point_id + '|' + e.receiver;
      if (!groups.has(k)) groups.set(k, []);
      if (groups.get(k).length < BATCH) groups.get(k).push(e);
    });
    if (!groups.size) return;
    uploading = true;
    let more = false;
    for (const [k, batch] of groups) {
      const [point_id, receiver] = k.split('|');
      const body = { payload: { point_id, receiver, receptions: batch.map(e => ({
        heard_at: e.t, protocol: e.protocol || null, alert_id: e.alert_id == null ? null : e.alert_id,
        value_raw: e.value_raw == null ? null : e.value_raw, payload_hex: e.payload_hex || null, ok: !!e.ok, fault: e.fault || null,
        rssi_dbm: num(e.rssi_dbm), level_dbfs: num(e.level_dbfs), nf_dbm: num(e.nf_dbm), votes: e.votes == null ? null : e.votes,
        lat: num(e.lat), lon: num(e.lon), accuracy_m: num(e.accuracy_m), speed_mps: num(e.speed_mps), heading_deg: num(e.heading_deg),
        location_source: e.location_source || 'none', detail: e.detail || {},
      })) } };
      try {
        const res = await fetch(DB_URL + '/rpc/report_receptions', { method: 'POST',
          headers: { apikey: DB_ANON_KEY, 'X-Ingest-Token': token, 'Content-Type': 'application/json', 'Content-Profile': DB_SCHEMA },
          body: JSON.stringify(body) });
        const out = await res.json().catch(() => null);
        if (res.ok && out) {
          batch.forEach(e => { e.sent = 1; });
          status.sent += out.accepted || 0; status.refused += (out.rejected || []).length; status.err = ''; status.missing = false;
          if (batch.length === BATCH) more = true;
        } else if (res.status === 404) { status.missing = true; status.err = 'The database cannot keep receptions yet (migration 0047 is not applied there); they stay in this browser.'; }
        else status.err = 'Receptions not sent (' + res.status + ((out && out.message) ? ': ' + out.message : '') + ') — kept, and tried again.';
      } catch (err) {
        status.err = 'Receptions not sent (' + ((err && err.message) || err) + ') — kept, and tried again.';
      }
    }
    uploading = false;
    persistSoon();
    notify();
    if (more || (status.err && !status.missing)) scheduleUpload();
  }
  function num(v) { return v == null || !isFinite(v) ? null : +v; }

  // ── out ───────────────────────────────────────────────────────────────────

  const COLS = ['time', 'receiver', 'point_id', 'point_name', 'protocol', 'alert_id', 'value_raw', 'payload_hex', 'ok', 'fault',
    'rssi_dbm', 'level_dbfs', 'nf_dbm', 'votes', 'lat', 'lon', 'accuracy_m', 'location_source', 'location_approx', 'speed_mps', 'heading_deg', 'demo', 'detail'];
  function toCsv(list) {
    return COLS.join(',') + '\n' + list.map(e => COLS.map(k => {
      const v = k === 'time' ? new Date(e.t).toISOString() : k === 'detail' ? (e.detail ? JSON.stringify(e.detail) : '') : e[k];
      return csvEscape(v == null ? '' : v);
    }).join(',')).join('\n') + '\n';
  }
  function toGeoJson(list) {
    return JSON.stringify({ type: 'FeatureCollection', features: list.filter(e => isFinite(e.lat) && isFinite(e.lon)).map(e => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
      properties: Object.assign({}, e, { time: new Date(e.t).toISOString(), lat: undefined, lon: undefined }) })) });
  }
  function exportCsv(list) { dlText('receptions-' + new Date().toISOString().slice(0, 10) + '.csv', toCsv(list || all())); }
  function exportGeoJson(list) { dlText('receptions-' + new Date().toISOString().slice(0, 10) + '.geojson', toGeoJson(list || all())); }
  function clear() { entries = []; try { localStorage.removeItem(STORE); } catch (_) {} notify(); }

  // ── the card's panel ──────────────────────────────────────────────────────

  function countFor(c) {
    const info = typeof SerialIngest !== 'undefined' && SerialIngest.pointInfo ? SerialIngest.pointInfo(c) : null;
    const pid = info ? info.pointId : null;
    let n = 0, bad = 0, placed = 0;
    all().forEach(e => { if (e.point_id === pid && e.receiver === RECEIVER[c.kind]) { n++; if (!e.ok) bad++; if (isFinite(e.lat)) placed++; } });
    return { n, bad, placed };
  }
  function where() {
    const g = typeof SerialGps !== 'undefined' ? SerialGps.fix(false) : null;
    if (g) return 'GPS ' + g.lat.toFixed(5) + ', ' + g.lon.toFixed(5) + (g.accuracy_m ? ' ± ' + g.accuracy_m + ' m' : '');
    if (devFix && Date.now() - devFix.t < DEV_STALE_MS) return 'this device ' + devFix.lat.toFixed(5) + ', ' + devFix.lon.toFixed(5) + (devFix.accuracy_m ? ' ± ' + devFix.accuracy_m + ' m' : '') + ' (approximate)';
    return devErr || 'no live position — the receiver\'s fixed location is used, if it has one';
  }

  function panel(c) {
    if (!RECEIVER[c.kind] || c.kind === 'serial') return '';
    const id = c.id;
    return '<details class="qs-ctl rx-ctl" id="rx-' + id + '"><summary>Reception log <span class="qs-dim" id="rx-sum-' + id + '"></span></summary>'
      + '<p class="qs-hint">Every frame this card hears — good or bad — with its signal level and where the receiver was: the raw material of the '
      + '<button type="button" class="link-btn" onclick="switchTab(\'reception\')">Reception Map</button>, for mapping coverage and finding the transmitter sending bad packets.</p>'
      + '<div class="ser-actions">'
      + '<label class="ser-check"><input type="checkbox"' + (c.rxlogOff ? '' : ' checked') + ' onchange="RxLog.setOn(\'' + id + '\',this.checked)"> log this card\'s receptions</label>'
      + '<label class="ser-check"><input type="checkbox"' + (tracking() ? ' checked' : '') + ' onchange="RxLog.track(this.checked)"> track this device\'s position</label>'
      + '<button type="button" class="ghost" onclick="switchTab(\'reception\')">Open the Reception Map ▸</button>'
      + '</div>'
      + '<p class="qs-small" id="rx-where-' + id + '"></p>'
      + '<p class="qs-small qs-dim">A GPS card on this tab, when it has a fix, is used first and recorded as exact. Receptions go to MegaNet while this card is set to send there.</p>'
      + '</details>';
  }
  function setOn(id, v) { const c = Serial.findConn(id); if (c) { c.rxlogOff = !v; paint(c); } }
  function paint(c) {
    const s = document.getElementById('rx-sum-' + c.id);
    if (!s) return;
    const k = countFor(c);
    s.textContent = c.rxlogOff ? '· off' : '· ' + k.n + ' heard' + (k.bad ? ', ' + k.bad + ' bad' : '') + (k.n ? ', ' + k.placed + ' placed' : '');
    const w = document.getElementById('rx-where-' + c.id);
    if (w) w.textContent = 'Position now: ' + where() + '.' + (status.err ? ' ' + status.err : '');
  }
  function mount(c) { if (RECEIVER[c.kind]) paint(c); }

  return { add, all, on, track, tracking, position, panel, setOn, mount, paint, upload, toCsv, toGeoJson, exportCsv, exportGeoJson, clear,
           status: () => Object.assign({}, status), devFix: () => devFix };
})();

if (typeof window !== 'undefined') window.RxLog = RxLog;
