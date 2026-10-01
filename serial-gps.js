// MegaNet — serial-gps.js
//
//   SerialGps   the Serial Monitor's GPS card: a USB GPS receiver (a u-blox
//               puck, any NMEA 0183 device) read off a COM port or out of the
//               log PuTTY writes, and the position every other card stamps on
//               what it hears.
//
// After core.js, before serial.js, which lists it; reaches back to serial.js
// for the raw log and the card frame (Serial.logLine, toolbarButtons,
// statsHtml, logHtml, followHtml). Nothing here runs at load.
//
// Why a GPS card at all: a receiver in a vehicle, listening while it drives,
// is only as useful as its position, and a phone-grade "where is this
// computer" from the browser is Wi-Fi or IP on a laptop — a kilometre, often.
// A USB GPS puck costs less than a cable and speaks NMEA over serial, which is
// exactly what this tab reads. So GPS is not a future piece of hardware to
// design for; it is one more serial device, and this card makes it real:
//
//   * SerialGps.fix() — the freshest fix any GPS card holds, or null when none
//     is under ten seconds old. reception-log.js stamps it on every reception;
//     serial-ingest.js offers it as a receiver's location, source 'gps' — the
//     one source the database lets stand as exact (0045).
//
// NMEA read: GGA (fix, satellites, HDOP, height) and RMC (validity, speed,
// course, date), from any talker (GP, GN, GL, GA, BD). A sentence is checked
// against its checksum and dropped when it fails — a corrupt position is worse
// than a missing one. Accuracy is given as HDOP × 5 m, the usual rough
// conversion (a receiver's own error estimate, GST, is read when it sends one).

const SerialGps = (function () {
  const STALE_MS = 10000;
  const TRACK_MAX = 3600;
  const FIX_LABEL = { 0: 'no fix', 1: 'GPS fix', 2: 'DGPS fix', 4: 'RTK fixed', 5: 'RTK float', 6: 'dead reckoning' };

  function fresh() {
    return { dec: new TextDecoder(), text: '', fix: null, sats: null, hdop: null, alt: null, quality: 0,
      speed: null, course: null, valid: false, date: null, utc: null, gstM: null,
      sentences: 0, bad: 0, track: [], lastAt: 0, raf: 0 };
  }
  function G(c) { return c.gps || (c.gps = fresh()); }

  // ── NMEA ──────────────────────────────────────────────────────────────────

  function checksumOk(s) {
    const star = s.lastIndexOf('*');
    if (star < 0) return true;                      // no checksum sent: nothing to check
    let x = 0;
    for (let i = 1; i < star; i++) x ^= s.charCodeAt(i);
    return parseInt(s.slice(star + 1, star + 3), 16) === x;
  }
  // ddmm.mmmm + hemisphere → signed degrees
  function deg(v, h) {
    if (!v) return null;
    const n = parseFloat(v);
    if (!isFinite(n)) return null;
    const d = Math.floor(n / 100), m = n - d * 100;
    const out = d + m / 60;
    return (h === 'S' || h === 'W') ? -out : out;
  }

  // One sentence → { type, ... } or null. Pure, for the check.
  function parse(line) {
    const s = String(line || '').trim();
    const at = s.indexOf('$');
    if (at < 0) return null;
    const t = s.slice(at);
    if (!/^\$[A-Z]{2}[A-Z]{3},/.test(t)) return null;
    if (!checksumOk(t)) return { type: 'bad' };
    const f = t.replace(/\*[0-9A-Fa-f]{2}\s*$/, '').split(',');
    const kind = f[0].slice(3);
    if (kind === 'GGA') {
      return { type: 'GGA', time: f[1], lat: deg(f[2], f[3]), lon: deg(f[4], f[5]), quality: +f[6] || 0,
        sats: f[7] ? +f[7] : null, hdop: f[8] ? +f[8] : null, alt: f[9] ? +f[9] : null };
    }
    if (kind === 'RMC') {
      return { type: 'RMC', time: f[1], valid: f[2] === 'A', lat: deg(f[3], f[4]), lon: deg(f[5], f[6]),
        knots: f[7] ? +f[7] : null, course: f[8] ? +f[8] : null, date: f[9] || null };
    }
    if (kind === 'GST') {
      const a = f[6] ? +f[6] : null, b = f[7] ? +f[7] : null;
      return { type: 'GST', m: a != null && b != null ? Math.sqrt(a * a + b * b) : null };
    }
    return { type: kind };
  }

  function utcOf(time, date) {
    if (!time || !date || date.length < 6) return null;
    const hh = +time.slice(0, 2), mm = +time.slice(2, 4), ss = parseFloat(time.slice(4));
    const d = +date.slice(0, 2), mo = +date.slice(2, 4), y = 2000 + +date.slice(4, 6);
    const ms = Date.UTC(y, mo - 1, d, hh, mm, Math.floor(ss), Math.round((ss % 1) * 1000));
    return isFinite(ms) ? ms : null;
  }

  // ── bytes in ──────────────────────────────────────────────────────────────

  function feed(c, u8) {
    const g = G(c);
    g.text += g.dec.decode(u8, { stream: true });
    let m;
    while ((m = g.text.search(/\r\n|\r|\n/)) >= 0) {
      const line = g.text.slice(0, m);
      g.text = g.text.slice(m + (g.text.substr(m, 2) === '\r\n' ? 2 : 1));
      onLine(c, line);
    }
    if (g.text.length > 4096) g.text = '';
  }

  function onLine(c, line) {
    const g = c.gps, t = line.trim();
    if (!t) return;
    const p = parse(t);
    if (!p) { if (/^[\x20-\x7e]+$/.test(t)) Serial.logLine(c, t, 'rx'); return; }
    if (p.type === 'bad') { g.bad++; Serial.logLine(c, t + '  ✗ checksum', 'err'); return; }
    g.sentences++;
    // GGA and RMC carry the position; the rest (GSV, GSA, VTG…) only clutter
    // the log at ten sentences a second, so they are counted and not shown.
    if (p.type === 'GGA' || p.type === 'RMC') Serial.logLine(c, t, 'qs-rec');
    // Out of a followed log's history the position is history too: it is
    // shown in the log but never offered as where the receivers are now.
    if (c.history) return;
    const now = Date.now();
    if (p.type === 'GGA') {
      g.quality = p.quality; g.sats = p.sats; g.hdop = p.hdop; g.alt = p.alt;
      if (p.quality > 0 && p.lat != null && p.lon != null) setFix(c, p.lat, p.lon, now);
    } else if (p.type === 'RMC') {
      g.valid = p.valid;
      g.speed = p.knots != null ? p.knots * 0.514444 : null;
      g.course = p.course;
      g.utc = utcOf(p.time, p.date);
      if (p.valid && p.lat != null && p.lon != null && !(g.fix && now - g.fix.t < 500)) setFix(c, p.lat, p.lon, now);
    } else if (p.type === 'GST') g.gstM = p.m;
    mark(c);
  }

  function setFix(c, lat, lon, now) {
    const g = c.gps;
    g.fix = { lat: +lat.toFixed(7), lon: +lon.toFixed(7), t: now };
    g.lastAt = now;
    const last = g.track[g.track.length - 1];
    if (!last || now - last.t > 1000) {
      g.track.push({ lat: g.fix.lat, lon: g.fix.lon, t: now });
      if (g.track.length > TRACK_MAX) g.track.shift();
    }
  }

  function accuracyOf(g) {
    if (g.gstM != null && isFinite(g.gstM)) return Math.max(1, Math.round(g.gstM));
    if (g.hdop != null && isFinite(g.hdop)) return Math.max(2, Math.round(g.hdop * 5));
    return null;
  }

  // The freshest fix any GPS card holds now, or null. A demo GPS card's made-up
  // drive is offered only when asked for (`allowDemo`) — to demo receivers,
  // never to a real one.
  function fix(allowDemo) {
    if (typeof Serial === 'undefined') return null;
    let best = null;
    Serial.list().forEach(c => {
      if (c.kind !== 'gps' || !c.gps || !c.gps.fix || (c.phase === 'demo' && !allowDemo)) return;
      if (Date.now() - c.gps.fix.t > STALE_MS) return;
      if (!best || c.gps.fix.t > best.t) {
        const g = c.gps;
        best = { lat: g.fix.lat, lon: g.fix.lon, t: g.fix.t, accuracy_m: accuracyOf(g), sats: g.sats, hdop: g.hdop,
          speed_mps: g.speed, heading_deg: g.course, alt_m: g.alt, demo: c.phase === 'demo' };
      }
    });
    return best;
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function mark(c) {
    const g = c.gps;
    if (g.raf) return;
    g.raf = requestAnimationFrame(() => { g.raf = 0; paint(c); });
  }
  function chip(label, value, cls) {
    return '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(label) + '</span><span class="qs-chip-v">' + value + '</span></div>';
  }
  function paint(c) {
    const el = document.getElementById('gps-status-' + c.id);
    if (!el) return;
    const g = c.gps, f = g.fix, stale = !f || Date.now() - f.t > STALE_MS;
    const dim = t => '<span class="qs-dim">' + esc(t) + '</span>';
    el.innerHTML = [
      chip('Fix', stale ? (f ? 'lost ' + Math.round((Date.now() - f.t) / 1000) + ' s ago' : dim('waiting')) : esc(FIX_LABEL[g.quality] || 'fix'), stale ? 'warn' : ''),
      chip('Position', f ? f.lat.toFixed(5) + ', ' + f.lon.toFixed(5) : dim('—')),
      chip('Accuracy', accuracyOf(g) != null ? '± ' + accuracyOf(g) + ' m' + (g.gstM == null ? ' (HDOP ' + g.hdop + ' × 5 m)' : '') : dim('—')),
      chip('Satellites', g.sats != null ? String(g.sats) : dim('—')),
      chip('Speed', g.speed != null ? (g.speed * 3.6).toFixed(0) + ' km/h' + (g.course != null ? ' · ' + Math.round(g.course) + '°' : '') : dim('—')),
      chip('GPS time', g.utc ? esc(new Date(g.utc).toISOString().replace('T', ' ').slice(0, 19)) + ' UTC' + clockSkew(g) : dim('—')),
      chip('Sentences', g.sentences + (g.bad ? ' · ' + g.bad + ' failed checksum' : ''), g.bad ? 'warn' : ''),
    ].join('');
  }
  function clockSkew(g) {
    if (!g.utc || !g.lastAt) return '';
    const d = (Date.now() - g.lastAt) + (g.lastAt - g.utc);
    return Math.abs(d) > 5000 ? ' <span class="txt-warn">(this computer is ' + Math.round(d / 1000) + ' s ' + (d > 0 ? 'ahead' : 'behind') + ')</span>' : '';
  }

  function body(c) {
    return '<div class="qs-dash gps-dash" id="gps-dash-' + c.id + '">'
      + '<div class="ser-toolbar">' + Serial.toolbarButtons(c) + '</div>'
      + Serial.followHtml(c)
      + '<div class="qs-status" id="gps-status-' + c.id + '"></div>'
      + '<p class="qs-hint">Every receiver card on this tab stamps what it hears with this position while the fix is fresh '
      + '(under 10 s old), and a receiver sending to MegaNet can use it as its location — the one kind the database records as exact. '
      + 'Open the <button type="button" class="link-btn" onclick="switchTab(\'reception\')">Reception Map</button> to see where things were heard.</p>'
      + '<details class="qs-ctl" open><summary>Raw stream</summary>' + Serial.statsHtml(c) + Serial.logHtml(c) + '</details>'
      + '</div>';
  }

  function mount(c) { G(c); paint(c); }

  // A demo: a short drive west out of Toowoomba, played at real speed, so the
  // receivers' demos and the Reception Map have a moving position to use.
  function demo(c) {
    const g = G(c);
    g.demoLive = true;
    let i = 0;
    const tick = () => {
      if (!Serial.findConn(c.id)) { clearInterval(g.demoTimer); return; }
      const lat = -27.5606 - 0.0002 * Math.sin(i / 30), lon = 151.9507 - 0.00025 * i;
      const ns = lat < 0 ? 'S' : 'N', ew = lon < 0 ? 'W' : 'E';
      const dm = (v, w) => { v = Math.abs(v); const d = Math.floor(v); return String(d).padStart(w, '0') + ((v - d) * 60).toFixed(4).padStart(7, '0'); };
      const t = new Date(), hhmmss = t.toISOString().slice(11, 19).replace(/:/g, '') + '.00';
      const date = t.toISOString().slice(8, 10) + t.toISOString().slice(5, 7) + t.toISOString().slice(2, 4);
      const withCs = s => { let x = 0; for (let k = 1; k < s.length; k++) x ^= s.charCodeAt(k); return s + '*' + x.toString(16).toUpperCase().padStart(2, '0'); };
      const lines = withCs('$GNGGA,' + hhmmss + ',' + dm(lat, 2) + ',' + ns + ',' + dm(lon, 3) + ',' + ew + ',1,09,0.9,690.0,M,40.0,M,,') + '\r\n'
        + withCs('$GNRMC,' + hhmmss + ',A,' + dm(lat, 2) + ',' + ns + ',' + dm(lon, 3) + ',' + ew + ',29.2,268.0,' + date + ',,,A') + '\r\n';
      Serial.feed(c, new TextEncoder().encode(lines));
      i++;
    };
    tick();
    g.demoTimer = setInterval(tick, 1000);
  }
  function detach(c) { if (c && c.gps) clearInterval(c.gps.demoTimer); }

  return { feed, body, mount, demo, detach, fix, parse, STALE_MS };
})();

if (typeof window !== 'undefined') window.SerialGps = SerialGps;
