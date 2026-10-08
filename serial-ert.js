// MegaNet — serial-ert.js
//
//   SerialErt   the Serial Monitor's card for an ELPRO ERT-A2: what the unit
//               puts on a port, decoded as it arrives — the RS232 port's
//               ALERT2A ASCII lines or the USB port's binary frames (the ones
//               carrying RSSI) — each reading matched to its station, from a
//               COM port or from the log file PuTTY is writing.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, dlText, csvEscape and state; across to
// serial.js for the raw log and the card's frame (Serial.logLine,
// Serial.toolbarButtons, Serial.statsHtml, Serial.logHtml, Serial.followHtml),
// and to alert2.js for everything that knows the protocol — parseAscii for a
// line, parseBinBytes for frames, resolve for which station an address is,
// engValue, stationCell and rssiCell — so a reading here and the same reading
// pasted into the ALERT2 tab are decoded by the same code and agree. All from
// inside functions, none at load.
//
// serial.js owns the port (or the followed file) and hands this card its bytes
// (feed). The format is sniffed from them, the way the ALERT2 tab sniffs a
// paste: a line holding "ALERT2A," is the RS232 protocol; the "ALERT2" sync
// followed by a length is the USB framing, raw (a port, or PuTTY logging "All
// session output") or as hex text (a terminal that logs in hex). Once one has
// been seen the card reads only that, so a binary frame's stray newline bytes
// are never shown as lines of text and a text line is never searched for frames.

const SerialErt = (function () {
  const MAX_RECS = 20000;                // readings kept, for the stations table and the hand-over
  const MAX_ROWS = 400;                  // readings drawn, newest first
  const MAX_CAPTURE = 4 * 1024 * 1024;   // capture text kept for "Open in the ALERT2 tab"
  const TAG = 'ALERT2A,';
  const HEX_SYNC = /4\s*1\W*4\s*C\W*4\s*5\W*5\s*2\W*5\s*4\W*3\s*2/i;
  const BANNER = /PuTTY log (\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)/;
  const FMT = {
    ascii: 'RS232 · ALERT2A ASCII',
    bin:   'USB · binary framing',
    hex:   'USB · binary framing, logged as hex',
  };

  function fresh() {
    return {
      fmt: null, dec: new TextDecoder(), text: '', bin: [], stray: 0,
      recs: [], frames: 0, bad: 0, warned: 0, lastAt: 0, lastFrame: null,
      clock: null, skew: null, agencies: new Set(), sources: new Set(),
      bases: { utc: 0, local: 0, either: 0, none: 0 }, selfReports: 0, tests: 0,
      capture: [], captureLen: 0, res: null, dirty: true,
      pending: {}, raf: 0,
    };
  }
  function conn(id) { return Serial.findConn(id); }
  function E(c) { return c.ert || (c.ert = fresh()); }

  // ── bytes in ──────────────────────────────────────────────────────────────

  function feed(c, u8) {
    const e = E(c);
    if (e.fmt !== 'ascii' && e.fmt !== 'hex') {
      for (let i = 0; i < u8.length; i++) e.bin.push(u8[i]);
      scanBin(c);
    }
    if (e.fmt === 'bin') { e.text = ''; return; }
    e.text += e.dec.decode(u8, { stream: true });
    let m;
    while ((m = e.text.search(/\r\n|\r|\n/)) >= 0) {
      const line = e.text.slice(0, m);
      e.text = e.text.slice(m + (e.text.substr(m, 2) === '\r\n' ? 2 : 1));
      onLine(c, line);
      if (e.fmt === 'bin') { e.text = ''; return; }
    }
    // A newline-less stream is not text; do not hold it forever.
    if (e.text.length > 16384) e.text = '';
  }

  // Whatever is held mid-line, on close: a line the unit never finished.
  function flush(c) {
    const e = c.ert;
    if (!e || !e.text.trim() || e.fmt === 'bin') return;
    const t = e.text; e.text = '';
    onLine(c, t);
  }

  function setFmt(c, fmt) {
    const e = c.ert;
    e.fmt = fmt;
    if (fmt === 'ascii' || fmt === 'hex') e.bin = [];
    Serial.logLine(c, 'Reading this as ' + FMT[fmt] + (fmt === 'ascii'
      ? ' — the receiver\'s clock is in every line; RSSI is not (the USB port carries that)'
      : fmt === 'bin' ? ' — RSSI in every frame; no receiver clock (the RS232 port carries that)' : ''), 'sys');
    mark(c, 'status');
  }

  function onLine(c, raw) {
    const e = c.ert, t = raw.trim();
    if (!t) return;
    const b = BANNER.exec(t);
    if (b && t.indexOf(TAG) < 0) {
      Serial.logLine(c, 'PuTTY started this log ' + b[1] + '-' + b[2] + '-' + b[3] + ' ' + b[4] + ':' + b[5] + ':' + b[6], 'sys');
      return;
    }
    if (t.indexOf(TAG) >= 0) {
      if (!e.fmt) setFmt(c, 'ascii');
      if (e.fmt === 'ascii') { Alert2.parseAscii(t).frames.forEach(f => addFrame(c, f, t.slice(t.indexOf('ALERT2A')))); return; }
    }
    if (e.fmt === 'hex' || (!e.fmt && HEX_SYNC.test(t))) {
      if (!e.fmt) setFmt(c, 'hex');
      const bytes = Alert2.hexStream(t).bytes;
      if (bytes.length) { for (let i = 0; i < bytes.length; i++) e.bin.push(bytes[i]); scanBin(c); return; }
    }
    // Printable text that is no frame: a terminal's note, a unit's prompt.
    // While the format is still unknown a binary stream's fragments arrive
    // here too, and those are not worth a line each.
    if (/^[\x20-\x7e\t]+$/.test(t)) Serial.logLine(c, t, 'rx');
  }

  function scanBin(c) {
    const e = c.ert;
    if (e.bin.length < 7) return;
    const out = Alert2.parseBinBytes(e.bin);
    e.bin.splice(0, out.used);
    if (!e.fmt) {
      // Unknown format: only a frame that decodes cleanly says this is the
      // USB framing. Anything less could be six letters in a line of text.
      if (!out.frames.some(f => !f.error)) return;
      setFmt(c, 'bin');
    } else if (out.stray && out.frames.length) {
      e.stray += out.stray;
      Serial.logLine(c, out.stray + ' byte' + (out.stray === 1 ? '' : 's') + ' between frames skipped', 'sys');
    }
    out.frames.forEach(f => addFrame(c, f, f.raw));
  }

  // One frame, either format. `text` is what goes into the hand-over capture:
  // the ASCII line as received, or the binary frame as spaced hex — both
  // forms the ALERT2 tab reads.
  function addFrame(c, f, text) {
    const e = c.ert, t = Date.now();
    e.frames++; e.lastAt = t; e.lastFrame = f;
    keep(e, text);
    const label = f.kind === 'bin'
      ? '[frame · ' + f.bytes.length + ' bytes' + (f.hdr.rssi != null ? ' · RSSI ' + f.hdr.rssi + ' dBm' : '') + '] ' + f.raw
      : text;
    if (f.error) {
      e.bad++;
      if (typeof RxLog !== 'undefined' && typeof SerialIngest !== 'undefined')
        RxLog.add(c, { t: SerialIngest.arrival(c), protocol: 'alert2', alert_id: null, ok: false, fault: 'frame', rssi_dbm: f.hdr ? f.hdr.rssi : null, detail: { error: String(f.error).slice(0, 120) } });
      Serial.logLine(c, label, 'ert-bad');
      Serial.logLine(c, '↳ not decoded: ' + f.error, 'err');
      mark(c, 'status');
      return;
    }
    Serial.logLine(c, label, f.warn.length ? 'ert-warn' : 'ert-ok');
    if (f.warn.length) { e.warned++; Serial.logLine(c, '↳ ' + f.warn.join('; '), 'sys'); }
    if (f.hdr.agency) e.agencies.add(f.hdr.agency);
    if (f.hdr.source != null) e.sources.add(f.hdr.source);
    if (f.hdr.port === Alert2.PORT_SELF) e.selfReports++;
    const test = !!(f.payload && f.payload.ctl.test);
    if (test) e.tests++;
    if (f.hdr.clockMs) {
      e.clock = f.hdr.clockMs;
      if (!f.damaged && f.payload && f.payload.stamp != null) {
        // Signed as the ALERT2 tab reports it: the receiver's clock against
        // where the frame's half-day stamp lands (Alert2.placeStamp) — or,
        // where it lands near neither, against the receiver's own half-day.
        const p = Alert2.placeStamp(f.payload.stamp, f.hdr.clockMs);
        e.skew = (f.hdr.clockMs - (p.ms != null ? p.ms : p.local)) / 1000;
      }
    }
    const kind = f.kind === 'bin' ? 'bin' : 'ascii';
    // When each reading was taken, for the table: the frame's half-day stamp
    // put on the half-day nearest when it arrived — by the receiver's clock
    // where the line carries one, by this computer's otherwise — less the
    // seconds a repeater held it. What is sent is timed by frameTime(), below.
    const stamp = f.payload ? f.payload.stamp : null;
    const placed = stamp == null ? null : Alert2.placeStamp(stamp, f.hdr.clockMs || t);
    const ft = off => placed ? (placed.ms != null ? placed.ms : placed.local) - (off || 0) * 1000 : null;
    f.records.forEach(r => {
      e.recs.push({ t, alertId: r.alertId, value: r.value, ok: r.ok, offset: r.offset, test,
        ft: ft(r.offset), rssi: f.hdr.rssi, kind, source: f.hdr.source, warn: f.warn.length > 0 });
    });
    // A self-report's sensors, under the gauge's own address and the sensor's
    // slot — a2:<gauge>/<sensor>, the identity they are stored under (0024).
    f.sensors.forEach(x => {
      e.recs.push({ t, alertId: null, a2: { source: x.source, sensor: x.sensor, name: x.name, x }, value: x.value,
        text: Alert2.a2ValueText(x), ok: x.ok, offset: null, test,
        ft: ft(0), rssi: f.hdr.rssi, kind, source: f.hdr.source, warn: f.warn.length > 0 });
    });
    if (e.recs.length > MAX_RECS) e.recs.splice(0, e.recs.length - MAX_RECS);
    if (f.records.length || f.sensors.length) e.dirty = true;
    ingest(c, f, text);
    mark(c, 'status', 'readings', 'stations');
  }

  // To MegaNet, when the card is set to send (serial-ingest.js). Every
  // reading of a frame whose structure adds up: a concentration record under
  // its ALERT address, a self-report's sensor under its gauge and slot — and a
  // frame flagged as test data goes too, marked suspect, which is what the
  // database calls a reading its source flagged. The time is the frame's own,
  // less the seconds a repeater held a record (Alert2.placeStamp): put on the
  // half-day nearest when it arrived, in UTC and in local time, whichever lands
  // within ten minutes — live; against the receiver's own clock, out of a log's
  // history. A live frame whose stamp fits neither is timed by arrival instead,
  // and the card says so; which of the two fits is #157 Part 5's answer, and
  // the card says that too. A binary frame out of history carries no date at
  // all, and is not sent.
  function ingest(c, f, text) {
    if (typeof SerialIngest === 'undefined' || !f.payload) return;
    const ts = frameTime(c, f);
    const at = off => ts == null ? null : ts - (off || 0) * 1000;
    // Every reading to the reception log, the ones from a frame that does not
    // add up too — they are what finding a corrupting transmitter is made of.
    // A self-report is one entry for the frame: the log is of ALERT addresses,
    // and a gauge's sensors are not.
    if (typeof RxLog !== 'undefined') {
      f.records.forEach(r => RxLog.add(c, { t: at(r.offset), protocol: 'alert2', alert_id: r.alertId, value_raw: r.value,
        payload_hex: r.bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
        ok: r.ok, fault: r.ok ? null : 'frame',
        rssi_dbm: f.hdr.rssi, detail: { source: f.hdr.source, port: f.hdr.port, hop_limit: f.hdr.hopLimit, offset_s: r.offset } }));
      if (f.reports.length) RxLog.add(c, { t: ts, protocol: 'alert2', alert_id: null, ok: !f.damaged, fault: f.damaged ? 'frame' : null,
        rssi_dbm: f.hdr.rssi, detail: { source: f.hdr.source, port: f.hdr.port, hop_limit: f.hdr.hopLimit, self_report: f.sensors.length } });
    }
    const quality = f.payload.ctl.test ? 'suspect' : undefined;
    const items = [];
    f.records.filter(r => r.ok).forEach(r => items.push({ alert_id: r.alertId, value_raw: r.value, ts: at(r.offset),
      protocol: 'alert2', rssi_dbm: f.hdr.rssi, quality }));
    // Sensor 255 is the spec's marker that a time stamp follows, not a sensor,
    // and the database refuses it as one; a text value has no number to keep.
    f.sensors.filter(x => x.ok && x.sensor !== 255 && x.value != null && Number.isFinite(x.value) && f.hdr.source != null)
      .forEach(x => items.push({ a2_station: f.hdr.source, a2_sensor: x.sensor, value_raw: x.value, ts,
        protocol: 'alert2', rssi_dbm: f.hdr.rssi, quality }));
    if (!items.length) return;
    // The frame's RSSI is the ERT-A2's own, in dBm (0050); it does not say its frequency.
    items[0].line = text;
    SerialIngest.add(c, items);
  }
  function frameTime(c, f) {
    const stamp = f.payload.stamp, live = SerialIngest.arrival(c);
    if (live != null) {
      if (stamp == null) return live;
      const p = Alert2.placeStamp(stamp, live);
      c.ert.bases[p.base || 'none']++;
      if (p.base == null) {
        const off = Math.min(Math.abs(p.utc - live), Math.abs(p.local - live));
        SerialIngest.note(c, 'Frame times are ' + Math.round(off / 60000) + ' min from this computer\'s clock on both UTC and local time, so readings are timed by when they arrived.');
        return live;
      }
      SerialIngest.note(c, baseNote(c.ert.bases));
      return p.ms;
    }
    if (!f.hdr.clockMs) return null;
    if (stamp == null) return f.hdr.clockMs;
    const p = Alert2.placeStamp(stamp, f.hdr.clockMs);
    let ts = p.ms != null ? p.ms : p.local;
    if (ts > Date.now() + 5 * 60000) ts -= 86400000;
    return ts;
  }

  // What the stamps have turned out to count from — the question #157 Part 5
  // asks, answered by every frame this card has timed live.
  function baseNote(b) {
    const n = b.utc + b.local;
    if (!n) return b.either ? 'This computer is on UTC (or twelve hours from it), so a frame cannot say whether its stamp is UTC or local time.' : '';
    if (b.utc && !b.local) return 'Frame stamps are UTC, as the ALERT2 spec says — ' + b.utc + ' frame' + (b.utc === 1 ? '' : 's') + ' timed by them.';
    if (b.local && !b.utc) return 'Frame stamps are local time — the ALERT2 spec says UTC — ' + b.local + ' frame' + (b.local === 1 ? '' : 's') + ' timed by them.';
    return 'Frame stamps disagree: ' + b.utc + ' fit UTC and ' + b.local + ' local time — more than one transmitter, keeping different time.';
  }

  function keep(e, text) {
    e.capture.push(text);
    e.captureLen += text.length + 1;
    while (e.captureLen > MAX_CAPTURE && e.capture.length > 1) e.captureLen -= e.capture.shift().length + 1;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  // Everything heard so far, into the ALERT2 tab — the map, the shared-address
  // resolution, the frame anatomy and its exports are all there already.
  function openInTab(id) {
    const c = conn(id), e = c && c.ert;
    if (!e || !e.capture.length) { announce('Nothing decoded yet to open in the ALERT2 tab'); return; }
    const a = state.a2;
    a.text = e.capture.join('\n');
    a.mode = 'auto';
    a.limit = 400;
    a.sel = null;
    a.mapView = null;
    a.source = 'From the Serial Monitor — ' + c.name + ': ' + e.frames + ' frame' + (e.frames === 1 ? '' : 's')
      + (c.follow ? ', following ' + c.follow.src.name : '') + ', handed over at ' + SerialViz.hhmm(Date.now(), true) + '.';
    switchTab('alert2');
  }

  function clearData(id) {
    const c = conn(id);
    if (!c || !c.ert) return;
    const fmt = c.ert.fmt;
    c.ert = fresh();
    c.ert.fmt = fmt;
    mark(c, 'status', 'readings', 'stations');
  }

  function exportCsv(id) {
    const c = conn(id), e = c && c.ert;
    if (!e || !e.recs.length) return;
    const res = resolved(e);
    const cols = ['received', 'frame_time', 'format', 'source', 'alert_id', 'a2_sensor', 'station', 'station_number', 'match', 'value', 'engineering', 'rssi_dbm', 'time_offset_s', 'test', 'ok'];
    const lines = [cols.join(',')];
    e.recs.forEach(r => {
      const info = infoFor(res, r);
      const st = info && info.chosen ? info.chosen.station : null;
      const eng = engFor(r, info, st);
      const row = {
        received: new Date(r.t).toISOString(), frame_time: r.ft == null ? '' : new Date(r.ft).toISOString(), format: r.kind === 'bin' ? 'usb-binary' : 'rs232-ascii',
        source: r.source == null ? '' : r.source, alert_id: r.alertId == null ? '' : r.alertId, a2_sensor: r.a2 ? r.a2.sensor : '',
        station: st ? st.name : (info && info.fileName && !info.fileName.none ? info.fileName.text : ''),
        station_number: st ? (st.station_number || '') : '', match: info ? info.conf : 'unknown',
        value: r.a2 ? r.text : r.value, engineering: eng ? eng.text : '', rssi_dbm: r.rssi == null ? '' : r.rssi,
        time_offset_s: r.offset == null ? '' : r.offset, test: r.test ? 'yes' : '', ok: r.ok ? 'yes' : 'no',
      };
      lines.push(cols.map(k => csvEscape(row[k])).join(','));
    });
    dlText('ert-a2-' + slug(c.name) + '-' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\n') + '\n');
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function mark(c) {
    const e = c && c.ert;
    if (!e) return;
    for (let i = 1; i < arguments.length; i++) e.pending[arguments[i]] = true;
    if (e.raf) return;
    const run = () => { e.raf = 0; paint(c); };
    e.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  function paint(c) {
    const e = c.ert, p = e.pending;
    e.pending = {};
    if (!document.getElementById('ert-dash-' + c.id)) return;
    if (p.status) paintStatus(c);
    if (p.readings) paintReadings(c);
    if (p.stations) paintStations(c);
  }

  function mount(c) {
    E(c);
    // The national address file names addresses MegaNet has never heard of —
    // the ALERT2 tab loads it once for both.
    if (typeof Packets !== 'undefined' && Packets.loadStationsFile) Packets.loadStationsFile();
    mark(c, 'status', 'readings', 'stations');
    if (typeof SerialIngest !== 'undefined') SerialIngest.mount(c);
  }

  function resolved(e) {
    if (e.dirty || !e.res) {
      e.res = Alert2.resolve({ records: e.recs.filter(r => r.alertId != null),
                               sensors: e.recs.filter(r => r.a2).map(r => r.a2) });
      e.dirty = false;
    }
    return e.res;
  }
  // Which station a reading is, by its ALERT address or its gauge and slot.
  function infoFor(res, r) {
    return r.a2 ? (res.byA2 ? res.byA2.get(Alert2.a2Key(r.a2.source, r.a2.sensor)) : null) : res.byAlertId.get(r.alertId);
  }
  function engFor(r, info, st) {
    return r.a2 ? Alert2.a2Eng(r.a2.x, info ? info.kind : null, st) : Alert2.engValue(info ? info.kind : null, r.value, st);
  }
  function idText(r) { return r.a2 ? 'a2:' + Alert2.a2Key(r.a2.source, r.a2.sensor) : String(r.alertId); }

  function durText(sec) {
    const neg = sec < 0; let s = Math.round(Math.abs(sec));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const bits = [];
    if (h) bits.push(h + ' h');
    if (m) bits.push(m + ' min');
    if (s || !bits.length) bits.push(s + ' s');
    return (neg ? '−' : '+') + bits.join(' ');
  }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }
  function chip(label, value, cls) {
    return '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(label) + '</span>'
      + '<span class="qs-chip-v">' + value + '</span></div>';
  }
  const dim = t => '<span class="qs-dim">' + esc(t) + '</span>';

  function paintStatus(c) {
    const el = document.getElementById('ert-status-' + c.id);
    if (!el) return;
    const e = c.ert;
    const chips = [];
    chips.push(chip('Format', e.fmt ? esc(FMT[e.fmt]) : dim('waiting for a frame')));
    chips.push(chip('Frames', e.frames + (e.bad ? ' · ' + e.bad + ' bad' : '') + (e.warned ? ' · ' + e.warned + ' with warnings' : ''),
      e.bad ? 'warn' : ''));
    const res = resolved(e);
    chips.push(chip('Readings', e.recs.length + ' · ' + res.byAlertId.size + ' address' + (res.byAlertId.size === 1 ? '' : 'es')
      + (res.unknown ? ' · ' + res.unknown + ' unmatched' : '')));
    chips.push(chip('Last frame', e.lastAt ? ago(e.lastAt) : dim('—')));
    if (e.selfReports || e.tests) chips.push(chip('ALERT2', (e.selfReports ? e.selfReports + ' self-report' + (e.selfReports === 1 ? '' : 's') : '')
      + (e.selfReports && e.tests ? ' · ' : '') + (e.tests ? e.tests + ' test' : ''), e.tests ? 'warn' : ''));
    const bn = e.bases.utc + e.bases.local;
    if (bn) chips.push(chip('Frame stamps', e.bases.utc && !e.bases.local ? 'UTC' : e.bases.local && !e.bases.utc ? 'local time — the spec says UTC' : esc(e.bases.utc + ' UTC · ' + e.bases.local + ' local'),
      e.bases.local ? 'warn' : ''));
    const rssis = e.recs.filter(r => r.rssi != null).slice(-50).map(r => r.rssi);
    if (e.fmt === 'bin' || e.fmt === 'hex' || rssis.length) {
      const sorted = rssis.slice().sort((a, b) => a - b);
      chips.push(chip('RSSI', rssis.length ? rssis[rssis.length - 1] + ' dBm · median ' + sorted[sorted.length >> 1] : dim('—')));
    }
    if (e.fmt === 'ascii') {
      const big = e.skew != null && Math.abs(e.skew) >= 120;
      chips.push(chip('Receiver clock', e.skew == null ? dim('—') : esc(durText(e.skew)) + ' against the frame time'
        + (big ? ' — check the unit\'s clock' : ''), big ? 'warn' : ''));
    }
    const src = [...e.sources];
    if (src.length) chips.push(chip('Source', esc(src.slice(0, 3).join(', ')) + (e.agencies.size ? ' · ' + esc([...e.agencies].join(', ')) : '')));
    el.innerHTML = chips.join('');
  }

  function stationHtml(info) {
    if (!info) return '<span class="qs-dim">—</span>';
    return Alert2.stationCell(info);
  }

  function paintReadings(c) {
    const body = document.getElementById('ert-dec-' + c.id);
    const count = document.getElementById('ert-count-' + c.id);
    const e = c.ert;
    if (count) count.textContent = e.recs.length ? e.recs.length + ' reading' + (e.recs.length === 1 ? '' : 's')
      + (e.recs.length > MAX_ROWS ? ', newest ' + MAX_ROWS + ' shown' : '') : '';
    if (!body) return;
    if (!e.recs.length) {
      body.innerHTML = '<tr><td colspan="7" class="qs-dim">No readings yet — they appear here as frames arrive.</td></tr>';
      return;
    }
    const res = resolved(e);
    const rows = [];
    for (let i = e.recs.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
      const r = e.recs[i];
      const info = infoFor(res, r);
      const st = info && info.chosen ? info.chosen.station : null;
      const eng = engFor(r, info, st);
      rows.push('<tr' + (r.ok ? '' : ' class="ert-row-bad"') + '>'
        + '<td class="qs-time">' + SerialViz.hhmm(r.t, true) + '</td>'
        + '<td class="qs-time col-optional">' + (r.ft == null ? '—' : SerialViz.hhmm(r.ft, true)) + '</td>'
        + '<td class="qs-num">' + esc(idText(r)) + '</td>'
        + '<td>' + stationHtml(info) + '</td>'
        + '<td class="qs-num">' + esc(r.a2 ? r.text : String(r.value)) + (eng ? ' <span class="qs-dim" title="' + esc(eng.rule) + '">' + esc(eng.text) + '</span>' : '') + '</td>'
        + '<td>' + Alert2.rssiCell(r.rssi) + '</td>'
        + '<td class="col-optional">' + (!r.ok ? '<span class="txt-bad" title="The frame around it does not add up">frame</span>'
          : r.test ? '<span class="txt-warn" title="Sent as test data — stored as suspect">test</span>' : '<span class="txt-ok">ok</span>')
        + (r.offset ? ' <span class="qs-dim" title="Held this long before the frame was exported">−' + r.offset + ' s</span>' : '') + '</td></tr>');
    }
    body.innerHTML = rows.join('');
  }

  function paintStations(c) {
    const body = document.getElementById('ert-stn-' + c.id);
    if (!body) return;
    const e = c.ert;
    const by = new Map();
    e.recs.forEach(r => {
      if (!r.ok) return;
      const id = idText(r);
      let s = by.get(id);
      if (!s) { s = { aid: id, r, n: 0, rssi: [] }; by.set(id, s); }
      s.n++; s.last = r;
      if (r.rssi != null) { s.rssi.push(r.rssi); if (s.rssi.length > 24) s.rssi.shift(); }
    });
    if (!by.size) { body.innerHTML = '<tr><td colspan="6" class="qs-dim">No stations heard yet.</td></tr>'; return; }
    const res = resolved(e);
    body.innerHTML = [...by.values()].sort((a, b) => b.last.t - a.last.t).map(s => {
      const info = infoFor(res, s.r);
      const st = info && info.chosen ? info.chosen.station : null;
      const eng = engFor(s.last, info, st);
      const med = s.rssi.length ? s.rssi.slice().sort((a, b) => a - b)[s.rssi.length >> 1] : null;
      return '<tr><td class="qs-num">' + esc(s.aid) + '</td><td>' + stationHtml(info) + '</td>'
        + '<td class="qs-num">' + esc(s.last.a2 ? s.last.text : String(s.last.value)) + (eng ? ' <span class="qs-dim">' + esc(eng.text) + '</span>' : '') + '</td>'
        + '<td class="qs-num">' + s.n + '</td><td>' + Alert2.rssiCell(med) + '</td>'
        + '<td class="qs-time col-optional">' + ago(s.last.t) + '</td></tr>';
    }).join('');
  }

  // ── the card ──────────────────────────────────────────────────────────────

  function body(c) {
    const id = c.id;
    const btn = (label, fn) => '<button type="button" class="ghost" onclick="SerialErt.' + fn + '(\'' + id + '\')">' + label + '</button>';
    return '<div class="qs-dash ert-dash" id="ert-dash-' + id + '">'
      + '<div class="ser-toolbar">' + Serial.toolbarButtons(c) + '</div>'
      + Serial.followHtml(c)
      + '<div class="qs-status" id="ert-status-' + id + '"></div>'
      + '<section class="qs-panel" aria-labelledby="ert-h-dec-' + id + '"><div class="qs-panel-head"><h3 id="ert-h-dec-' + id + '">Readings</h3>'
      + '<span class="qs-small qs-dim" id="ert-count-' + id + '"></span>'
      + '<span class="qs-head-actions">' + btn('Open in the ALERT2 tab ▸', 'openInTab') + btn('Export CSV', 'exportCsv') + btn('Clear', 'clearData') + '</span></div>'
      + '<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="ert-h-dec-' + id + '"><table class="qs-table">'
      + '<caption class="sr-only">Readings decoded from the ERT-A2, newest first</caption>'
      + '<colgroup><col style="width: 11%"><col class="col-optional" style="width: 11%"><col style="width: 8%"><col style="width: 34%">'
      + '<col style="width: 14%"><col style="width: 12%"><col class="col-optional" style="width: 10%"></colgroup><thead><tr>'
      + '<th scope="col">Received</th><th scope="col" class="col-optional">Frame time</th><th scope="col">ID</th><th scope="col">Station</th>'
      + '<th scope="col">Value</th><th scope="col">RSSI</th><th scope="col" class="col-optional">Reading</th></tr></thead>'
      + '<tbody id="ert-dec-' + id + '"></tbody></table></div>'
      + '<p class="qs-hint">Stations are matched as the ALERT2 tab matches them: an address shared by several stations goes to '
      + 'the one near the rest of what this receiver hears, and a pin set on that tab applies here too. '
      + '<em>Open in the ALERT2 tab</em> takes everything heard so far there, for the map, the frame anatomy and the exports.</p></section>'
      + '<section class="qs-panel" aria-labelledby="ert-h-stn-' + id + '"><div class="qs-panel-head"><h3 id="ert-h-stn-' + id + '">Stations heard</h3></div>'
      + '<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="ert-h-stn-' + id + '"><table class="qs-table">'
      + '<caption class="sr-only">Addresses heard, most recent first</caption>'
      + '<colgroup><col style="width: 9%"><col style="width: 40%"><col style="width: 17%"><col style="width: 9%"><col style="width: 12%">'
      + '<col class="col-optional" style="width: 13%"></colgroup><thead><tr>'
      + '<th scope="col">ID</th><th scope="col">Station</th><th scope="col">Last value</th><th scope="col">Heard</th>'
      + '<th scope="col">RSSI (median)</th><th scope="col" class="col-optional">Last heard</th></tr></thead>'
      + '<tbody id="ert-stn-' + id + '"></tbody></table></div></section>'
      + (typeof SerialIngest !== 'undefined' ? SerialIngest.panel(c) : '')
      + (typeof RxLog !== 'undefined' ? RxLog.panel(c) : '')
      + '<details class="qs-ctl" open><summary>Raw stream</summary>'
      + Serial.statsHtml(c) + Serial.logHtml(c)
      + '</details>'
      + '</div>';
  }

  return { feed, flush, body, mount, openInTab, clearData, exportCsv };
})();

if (typeof window !== 'undefined') window.SerialErt = SerialErt;
