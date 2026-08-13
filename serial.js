// MegaNet — serial.js
//
//   Serial   the Serial Monitor tab: physical serial ports opened through the
//            Web Serial API and streamed live, as text, as a hex dump, or
//            decoded as ALERT payloads through the shared Packets codec.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, slug and dlText, across to app.js for
// switchTab, and sideways to Packets — all from inside exported functions, none
// at load, so packets.js may load after this file.
//
// Live port objects hold non-serialisable streams, so connections live in this
// module's own `conns` array rather than in global state. That is what lets them
// survive a tab switch, and it is why none of this is in core.js.
//
// The last line exposes it on window. The comment above that line explains why
// it is not what makes the inline handlers work, and why the earlier fix that
// blamed the built-in Web Serial global was wrong.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── SERIAL MONITOR tab ──────────────────────────────────────────────────────────
//
// Connect physical serial devices to the browser's COM ports (Web Serial API) and
// stream their output live. Multiple ports can be open at once, each with its own
// settings (baud rate, data/stop bits, parity, flow control) and its own display
// mode:
//   • text  — bytes decoded as UTF-8/ASCII and split into lines on CR/LF
//   • hex   — raw bytes as a hex + ASCII dump, for inspecting binary framing
//   • alert — every 4 bytes decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF)
//             via the shared Packets codec and cross-referenced to the station DB
//
// Web Serial needs a Chromium browser (Chrome/Edge/Opera) served from a secure
// context (https or localhost). Live connection objects hold non-serialisable
// streams, so they live in this module's `conns` array — not in global `state` —
// and survive tab switches (reads continue in the background); the DOM is rebuilt
// from each connection's capped entry buffer whenever the tab is shown again.

const Serial = (function () {
  const MAX_ENTRIES = 1000;                    // per-connection scrollback cap
  const BAUD_RATES  = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400];
  const DEFAULTS_KEY = 'mn-serial-defaults';

  const conns = [];          // live connection objects (module-scoped, not serialised)
  let nextId = 1;
  let disconnectHooked = false;
  let knownPorts = [];       // ports the browser has already granted us (getPorts)

  const supported = typeof navigator !== 'undefined' && 'serial' in navigator;

  // Bumped whenever the Serial Monitor changes. Shown in the tab header so it is
  // possible to confirm at a glance which build of app.js the browser actually
  // loaded — a stale, cached app.js is the usual reason a "fixed" bug persists.
  const SERIAL_BUILD = '2026-07-16e';

  function loadDefaults() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}'); } catch (_) {}
    return {
      baudRate:    d.baudRate    || 9600,
      dataBits:    d.dataBits    || 8,
      stopBits:    d.stopBits    || 1,
      parity:      d.parity      || 'none',
      flowControl: d.flowControl || 'none',
      mode:        d.mode        || 'text',
    };
  }
  function saveDefaults(conn) {
    const d = Object.assign({}, conn.settings, { mode: conn.mode });
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch (_) {}
  }

  function byId(id) { return conns.find(c => c.id === id); }

  // ── connection lifecycle ──────────────────────────────────────────────────────
  function addConnection() {
    const d = loadDefaults();
    const conn = {
      id: 'c' + (nextId++),
      name: 'Connection ' + (conns.length + 1),
      phase: 'setup',                    // setup | open | closed | error
      port: null,
      portLabel: '',
      settings: { baudRate: d.baudRate, dataBits: d.dataBits, stopBits: d.stopBits,
                  parity: d.parity, flowControl: d.flowControl },
      mode: d.mode,
      entries: [],                       // {ts, cls, body(html), raw(text)}
      bytes: 0,
      count: 0,                          // lines (text) / rows (hex) / frames (alert)
      openedAt: null,
      paused: false,
      autoscroll: true,
      timestamps: true,
      err: null,
      // per-mode framing buffers
      decoder: null,
      textBuf: '',
      hexBuf: [],
      hexOffset: 0,
      alertBuf: [],
      reader: null,
      writer: null,
      keepReading: false,
      readLoopPromise: null,
      flushTimer: null,
      statsPending: false,
    };
    conns.push(conn);
    renderList();
    // reveal the freshly added card
    const el = document.getElementById('ser-card-' + conn.id);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Write a short status line beneath the "Choose COM port…" button. Colour is
  // set inline so the message is legible regardless of the stylesheet.
  function setPortStatus(conn, msg, kind) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#c7401a' : kind === 'warn' ? '#b26a00' : '';
  }

  // requestPort() rejects with the SAME NotFoundError whether the user cancelled
  // the picker or the browser refused to show a picker at all (enterprise policy
  // on a managed computer, kiosk/headless build, chooser UI unavailable). The one
  // observable difference is time: a human needs well over this many milliseconds
  // to see and dismiss a dialog, while a suppressed picker rejects almost
  // instantly after the call.
  const PICKER_INSTANT_MS = 350;

  async function choosePort(id) {
    const conn = byId(id);
    if (!conn) return;
    // The port picker can never look like a dead click: every path below either
    // opens the browser chooser, updates the UI, or leaves a visible message.
    console.log('[Serial] choosePort() invoked for', id, '(build ' + SERIAL_BUILD + ')');
    if (!supported) {
      alert('Web Serial isn’t available in this browser.\n\n'
        + 'Use a Chromium-based browser — Chrome, Edge or Opera — served over https or from localhost.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      alert('Choosing a COM port needs a secure context (https or localhost).\n\n'
        + 'This page is being served insecurely, so the browser blocks access to serial ports.');
      return;
    }
    if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
      const m = 'navigator.serial.requestPort is unavailable, so no COM-port picker can be shown.';
      setPortStatus(conn, m, 'err');
      alert(m);
      return;
    }
    // Definite Permissions-Policy block: the picker would be refused before it is
    // even requested — typically because this page is embedded in an <iframe>
    // without allow="serial" (a portal, SharePoint or Teams wrapper page).
    try {
      const fp = document.featurePolicy;
      if (fp && fp.features && fp.features().includes('serial') && !fp.allowsFeature('serial')) {
        setPortStatus(conn, (window.self !== window.top)
          ? 'Serial access is blocked because this page is embedded inside another page. '
            + 'Open the app in its own browser tab and try again.'
          : 'Serial access is disabled for this page by a Permissions-Policy.', 'err');
        return;
      }
    } catch (_) { /* diagnostic only — never blocks the real attempt */ }
    // Proof the handler ran, shown before the (blocking) native chooser opens.
    setPortStatus(conn, 'Opening the browser’s serial-port picker…', '');
    const t0 = Date.now();
    try {
      const port = await navigator.serial.requestPort();
      conn.port = port;
      conn.portLabel = portLabel(port);
      conn.err = null;
      hookDisconnect();
      await refreshKnownPorts();
      renderList();
    } catch (e) {
      const ms = Date.now() - t0;
      console.warn('[Serial] requestPort failed after ' + ms + ' ms:', e && e.name, '-', e && e.message);
      if (e && e.name === 'NotFoundError' && ms < PICKER_INSTANT_MS) {
        // Rejected faster than any human could close a dialog: the browser never
        // showed the picker. On managed (work) computers this is nearly always an
        // enterprise policy blocking Web Serial. Ports pre-approved by IT policy
        // still surface via getPorts(), so refresh the "Previously allowed" list
        // before showing the advice.
        await refreshKnownPorts();
        renderList();
        showBlockedPickerHelp(conn);
        return;
      }
      // Slow NotFoundError = the picker really opened and no port was chosen
      // (dismissed, or the device list was empty).
      if (e && e.name === 'NotFoundError') {
        setPortStatus(conn, 'No port selected. Click “Choose COM port…” again and pick your device. '
          + 'If the list is empty, the browser can’t see a serial device: check the USB cable/driver, and '
          + 'that no other program or browser tab already has the COM port open.', 'warn');
        return;
      }
      if (e && e.name === 'SecurityError') {
        setPortStatus(conn, 'The browser blocked the request: ' + ((e && e.message) || 'SecurityError')
          + ' — if this page is embedded inside another page or portal, open it in its own tab; '
          + 'otherwise check the padlock menu → Site settings → Serial ports.', 'err');
        return;
      }
      setPortStatus(conn, 'Could not select a COM port: ' + ((e && e.message) || e), 'err');
      alert('Could not select a COM port: ' + ((e && e.message) || e) + '\n\n'
        + 'If no port picker appeared, check that serial access is allowed for this site.');
    }
  }

  // Written into the status line when requestPort() rejected instantly, i.e. the
  // chooser was suppressed rather than cancelled. All markup here is our own —
  // the only dynamic value is the count of policy-granted ports.
  function showBlockedPickerHelp(conn) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    // The advice is long: let the port cell span the whole form row so it does
    // not squeeze into (and collide with) the narrow settings columns. The next
    // renderList() rebuilds the DOM and resets this automatically.
    const cell = el.closest ? el.closest('.ser-f-port') : null;
    if (cell) cell.style.gridColumn = '1 / -1';
    const isEdge = /Edg\//.test(navigator.userAgent);
    const policyPage = isEdge ? 'edge://policy' : 'chrome://policy';
    const granted = knownPorts.length
      ? '<p style="margin:.35rem 0 0"><strong>' + knownPorts.length + ' pre-approved port'
        + (knownPorts.length > 1 ? 's are' : ' is') + ' available</strong> under “Previously allowed” '
        + 'above — use that button instead of the picker.</p>'
      : '';
    el.style.color = '#c7401a';
    el.innerHTML =
        '<strong>The browser refused to show the port picker.</strong> It rejected the request instantly, '
      + 'so no dialog was ever displayed — this is a browser or IT-policy block, not an empty device list. '
      + '(If you did see a picker and closed it, ignore this and just click the button again.)'
      + granted
      + '<ol style="margin:.35rem 0 0 1.1rem;padding:0">'
      + '<li>Open <code>' + policyPage + '</code> and search for <code>serial</code>. '
      +   '<code>DefaultSerialGuardSetting = 2</code>, or this site listed under <code>SerialBlockedForUrls</code>, '
      +   'means your organisation blocks Web Serial — IT must add this site to <code>SerialAskForUrls</code>.</li>'
      + '<li>Click the padlock by the address bar → <em>Site settings</em> → <em>Serial ports</em> → set to '
      +   '<em>Ask</em>. If the control is greyed out, it is locked by IT policy.</li>'
      + '<li>IT can instead pre-approve the device itself (<code>SerialAllowUsbDevicesForUrls</code> or '
      +   '<code>SerialAllowAllPortsForUrls</code>) — pre-approved ports appear here under “Previously allowed” '
      +   'and need no picker at all. A ready-to-send request for IT is in '
      +   '<a href="docs/serial-help.html" target="_blank" rel="noopener">the serial access guide</a>.</li>'
      + '<li>Try the other browser — if Chrome is blocked, Edge often isn’t (and vice-versa).</li>'
      + '</ol>';
  }

  // Ports the browser has already granted us in a previous pick (persist across
  // reloads). Surfacing them lets the user reconnect a known device with one
  // click instead of fighting the picker, and is a live check of what the
  // browser can actually see.
  async function refreshKnownPorts() {
    try {
      knownPorts = (navigator.serial && navigator.serial.getPorts)
        ? await navigator.serial.getPorts() : [];
    } catch (_) { knownPorts = []; }
  }

  // Attach a previously-granted port (from the "Previously allowed" list) to a
  // connection without going through the picker.
  function useKnownPort(id, index) {
    const conn = byId(id);
    if (!conn) return;
    const port = knownPorts[index];
    if (!port) return;
    conn.port = port;
    conn.portLabel = portLabel(port);
    conn.err = null;
    hookDisconnect();
    renderList();
  }

  function portLabel(port) {
    try {
      const info = port.getInfo ? port.getInfo() : {};
      if (info && info.usbVendorId != null) {
        const v = info.usbVendorId.toString(16).padStart(4, '0');
        const p = (info.usbProductId != null ? info.usbProductId : 0).toString(16).padStart(4, '0');
        return 'USB serial (VID:PID ' + v + ':' + p + ')';
      }
    } catch (_) {}
    return 'Serial port';
  }

  // Translate a port.open() DOMException into a plain-English cause + remedy.
  // The raw messages ("Failed to open serial port.") tell the user nothing.
  function describeOpenError(e) {
    const name = e && e.name;
    const msg  = (e && e.message) || String(e);
    if (name === 'InvalidStateError')
      return 'The port is already open. Close it in the other browser tab or program that has it, then try again.';
    if (name === 'NotFoundError')
      return 'The device is no longer connected. Re-plug it, click “Change…”, pick it again, then Open.';
    if (name === 'SecurityError')
      return 'Serial access was blocked. Click “Change…” and pick the port again to re-grant permission, then Open.';
    if (name === 'NetworkError' || /failed to open|access is denied|access denied/i.test(msg))
      return 'The operating system refused to open the COM port. It is almost always still held by another '
        + 'program — a terminal (PuTTY/RealTerm), a logger, or this Serial Monitor in another tab. '
        + 'Close whatever else has the port open and try again.';
    return msg;
  }

  async function openConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (!conn.port) { alert('Choose a COM port first.'); return; }
    const s = conn.settings;
    const baudRate = +s.baudRate || 0;
    if (baudRate < 1) {
      conn.phase = 'setup';
      conn.err = 'Baud rate must be a positive number (e.g. 9600).';
      renderList();
      return;
    }
    // Always start from a clean slate. If a stale handle to this port is still
    // open — from a previous session, or a device that dropped without being
    // closed — a fresh open() would throw "The port is already open". Release it
    // first so re-opening (and re-plug → Reopen) reliably works.
    await teardown(conn);
    try {
      await conn.port.open({
        baudRate:    baudRate,
        dataBits:    +s.dataBits || 8,
        stopBits:    +s.stopBits || 1,
        parity:      s.parity || 'none',
        flowControl: s.flowControl || 'none',
        bufferSize:  4096,
      });
    } catch (e) {
      // keep the setup form up so the user can adjust settings and retry
      console.warn('[Serial] open failed:', e && e.name, '-', e && e.message);
      conn.phase = 'setup';
      conn.err = describeOpenError(e);
      renderList();
      return;
    }
    // reset framing buffers for a clean session
    conn.decoder   = new TextDecoder();
    conn.textBuf   = '';
    conn.hexBuf    = [];
    conn.hexOffset = 0;
    conn.alertBuf  = [];
    conn.phase     = 'open';
    conn.err       = null;
    conn.openedAt  = Date.now();
    conn.keepReading = true;
    saveDefaults(conn);
    emitSys(conn, 'Opened ' + conn.portLabel + ' @ ' + conn.settings.baudRate + ' baud, '
      + conn.settings.dataBits + fmtParity(conn.settings.parity) + conn.settings.stopBits
      + ', flow ' + conn.settings.flowControl + ' — mode: ' + MODE_LABEL[conn.mode], 'sys');
    conn.readLoopPromise = readLoop(conn);
    renderList();
  }

  function fmtParity(p) { return p === 'none' ? 'N' : p === 'even' ? 'E' : 'O'; }

  async function readLoop(conn) {
    while (conn.port && conn.port.readable && conn.keepReading) {
      const reader = conn.port.readable.getReader();
      conn.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) handleChunk(conn, value);
        }
      } catch (e) {
        emitSys(conn, 'Read error: ' + e.message, 'err');
      } finally {
        try { reader.releaseLock(); } catch (_) {}
        conn.reader = null;
      }
    }
    // loop exited: if we didn't ask to stop, the device went away
    if (conn.keepReading) {
      conn.keepReading = false;
      conn.phase = 'error';
      conn.err = 'Device disconnected';
      emitSys(conn, 'Device disconnected', 'err');
      flushPartials(conn);
      renderList();
    }
  }

  // Stop reading and release the OS port handle. Best-effort: every step is
  // guarded so it is safe to call in any state (never opened, open, or already
  // dropped). Used both by Close and as the clean-slate step before (re)opening.
  async function teardown(conn) {
    conn.keepReading = false;
    try { if (conn.reader) await conn.reader.cancel(); } catch (_) {}
    try { if (conn.readLoopPromise) await conn.readLoopPromise; } catch (_) {}
    conn.readLoopPromise = null;
    conn.reader = null;
    try { if (conn.writer) await conn.writer.close().catch(() => {}); } catch (_) {}
    conn.writer = null;
    // Only close if the port is actually open; closing a never-opened port
    // throws, and we want teardown to be a safe no-op in that case.
    try {
      if (conn.port && (conn.port.readable || conn.port.writable)) await conn.port.close();
    } catch (_) {}
  }

  async function closeConn(id, opts) {
    const conn = byId(id);
    if (!conn) return;
    await teardown(conn);
    flushPartials(conn);
    conn.phase = 'closed';
    emitSys(conn, 'Port closed', 'sys');
    if (!(opts && opts.silent)) renderList();
  }

  async function removeConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (conn.phase === 'open') await closeConn(id, { silent: true });
    const i = conns.indexOf(conn);
    if (i >= 0) conns.splice(i, 1);
    renderList();
  }

  function reopenConn(id) {
    const conn = byId(id);
    if (!conn) return;
    // reset counters for the new session; keep the scrollback
    conn.bytes = 0; conn.count = 0;
    openConn(id);
  }

  // ── incoming data handling ────────────────────────────────────────────────────
  function handleChunk(conn, u8) {
    conn.bytes += u8.length;
    if      (conn.mode === 'text')  handleText(conn, u8);
    else if (conn.mode === 'hex')   handleHex(conn, u8);
    else if (conn.mode === 'alert') handleAlert(conn, u8);
    scheduleStats(conn);
  }

  function handleText(conn, u8) {
    conn.textBuf += conn.decoder.decode(u8, { stream: true });
    let m;
    // split on CRLF, LF or lone CR
    while ((m = conn.textBuf.search(/\r\n|\r|\n/)) >= 0) {
      const line = conn.textBuf.slice(0, m);
      conn.textBuf = conn.textBuf.slice(m + (conn.textBuf.substr(m, 2) === '\r\n' ? 2 : 1));
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(line) || '&nbsp;', raw: line });
    }
    // don't let a newline-less stream buffer forever
    if (conn.textBuf.length > 8192) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
  }

  function handleHex(conn, u8) {
    for (const b of u8) conn.hexBuf.push(b);
    while (conn.hexBuf.length >= 16) emitHexRow(conn, conn.hexBuf.splice(0, 16));
    scheduleFlush(conn);
  }

  function emitHexRow(conn, bytes) {
    const off = conn.hexOffset; conn.hexOffset += bytes.length;
    conn.count++;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    const offStr = off.toString(16).padStart(6, '0');
    const body = '<span class="ser-hex-off">' + offStr + '</span>'
      + '<span class="ser-hex-bytes">' + esc(hex) + '</span>'
      + '<span class="ser-hex-ascii">' + esc(ascii) + '</span>';
    emit(conn, { ts: Date.now(), cls: 'hex', body, raw: offStr + '  ' + hex + '  ' + ascii });
  }

  function handleAlert(conn, u8) {
    for (const b of u8) conn.alertBuf.push(b);
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
  }

  function emitAlertFrame(conn, bytes) {
    conn.count++;
    const hex = '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const dec = Packets.decodeMessage(hex);
    let body, raw;
    if (dec.ok && dec.best) {
      const r = dec.results.find(x => x.format === dec.best);
      const st = Packets.stationName(r.values.A);
      const val = r.values.D !== undefined ? ' <span class="ser-alert-val">val ' + r.values.D + '</span>' : '';
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge ok">' + r.format.toUpperCase() + '</span> '
        + '<span class="ser-alert-id">ID ' + r.values.A + '</span>' + val + ' '
        + '<span class="ser-alert-stn' + (st.none ? ' none' : '') + '">' + esc(st.text) + '</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">details ▸</a>';
      raw = hex + '  ' + r.format.toUpperCase() + '  ID ' + r.values.A
        + (r.values.D !== undefined ? '  val ' + r.values.D : '') + '  ' + st.text;
    } else {
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge bad">no ALERT match</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">inspect ▸</a>';
      raw = hex + '  no ALERT match';
    }
    emit(conn, { ts: Date.now(), cls: 'alert', body, raw });
  }

  function scheduleFlush(conn) {
    if (conn.flushTimer) return;
    conn.flushTimer = setTimeout(() => { conn.flushTimer = null; flushPartials(conn); }, 300);
  }

  // Emit whatever bytes/text are held mid-frame — on idle, close or disconnect —
  // so slow trickle output isn't stuck waiting for a full row/line/frame.
  function flushPartials(conn) {
    if (conn.hexBuf && conn.hexBuf.length) emitHexRow(conn, conn.hexBuf.splice(0, conn.hexBuf.length));
    if (conn.textBuf) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
    scheduleStats(conn);
  }

  function resync(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.alertBuf.shift();                       // drop one byte to shift frame alignment
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
    emitSys(conn, 'Resynced — dropped 1 byte to shift ALERT frame alignment', 'sys');
  }

  function emitSys(conn, text, cls) {
    emit(conn, { ts: Date.now(), cls: cls || 'sys', body: esc(text), raw: text, sys: true });
  }

  // ── entry buffer + surgical DOM append ────────────────────────────────────────
  function emit(conn, entry) {
    conn.entries.push(entry);
    if (conn.entries.length > MAX_ENTRIES) conn.entries.splice(0, conn.entries.length - MAX_ENTRIES);
    if (conn.paused) return;
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.insertAdjacentHTML('beforeend', entryHtml(conn, entry));
    while (log.children.length > MAX_ENTRIES) log.removeChild(log.firstChild);
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function entryHtml(conn, e) {
    const ts = conn.timestamps ? '<span class="ser-ts">' + fmtTime(e.ts) + '</span>' : '';
    return '<div class="ser-line ser-' + e.cls + '">' + ts + '<span class="ser-linebody">' + e.body + '</span></div>';
  }

  function fmtTime(t) {
    const d = new Date(t);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function repaintLog(conn) {
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.innerHTML = conn.entries.map(e => entryHtml(conn, e)).join('');
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function scheduleStats(conn) {
    if (conn.statsPending) return;
    conn.statsPending = true;
    requestAnimationFrame(() => { conn.statsPending = false; paintStats(conn); });
  }
  function paintStats(conn) {
    const el = document.getElementById('ser-stats-' + conn.id);
    if (!el) return;
    el.textContent = statsText(conn);
  }
  function statsText(conn) {
    const unit = conn.mode === 'alert' ? 'frames' : conn.mode === 'hex' ? 'rows' : 'lines';
    const secs = conn.openedAt ? Math.max(1, (Date.now() - conn.openedAt) / 1000) : 1;
    const rate = conn.bytes ? ' · ' + Math.round(conn.bytes / secs) + ' B/s' : '';
    return conn.bytes.toLocaleString() + ' bytes · ' + conn.count.toLocaleString() + ' ' + unit + rate;
  }

  // ── toolbar actions ───────────────────────────────────────────────────────────
  function togglePause(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.paused = !conn.paused;
    if (!conn.paused) repaintLog(conn);
    renderList();
  }
  function clearLog(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.entries = [];
    repaintLog(conn);
  }
  function saveLog(id) {
    const conn = byId(id);
    if (!conn) return;
    const header = '# MegaNet Serial Monitor log — ' + conn.name + ' (' + conn.portLabel + ')\n'
      + '# ' + conn.settings.baudRate + ' baud, ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ', mode ' + conn.mode + '\n';
    const lines = conn.entries.map(e => (conn.timestamps ? fmtTime(e.ts) + '  ' : '') + e.raw).join('\n');
    dlText('serial-' + slug(conn.name) + '.log', header + lines + '\n');
  }
  function toggleFlag(id, flag, val) {
    const conn = byId(id);
    if (!conn) return;
    conn[flag] = val;
    if (flag === 'timestamps') repaintLog(conn);
    if (flag === 'autoscroll' && val) { const log = document.getElementById('ser-log-' + id); if (log) log.scrollTop = log.scrollHeight; }
  }

  async function sendData(id) {
    const conn = byId(id);
    if (!conn || conn.phase !== 'open') return;
    const inp = document.getElementById('ser-send-' + id);
    const endSel = document.getElementById('ser-send-end-' + id);
    if (!inp) return;
    const text = inp.value;
    const end = endSel ? endSel.value : 'lf';
    const suffix = end === 'lf' ? '\n' : end === 'cr' ? '\r' : end === 'crlf' ? '\r\n' : '';
    try {
      if (!conn.port.writable) throw new Error('port is not writable');
      if (!conn.writer) conn.writer = conn.port.writable.getWriter();
      await conn.writer.write(new TextEncoder().encode(text + suffix));
      emit(conn, { ts: Date.now(), cls: 'tx', body: '<span class="ser-tx-arrow">»</span> ' + esc(text), raw: '» ' + text });
      inp.value = '';
    } catch (e) {
      emitSys(conn, 'Send failed: ' + e.message, 'err');
    }
  }

  function openInPackets(hex) {
    state.pkt.decInput = hex;
    state.pkt.lastDecode = hex;
    switchTab('packets');
  }

  // ── live setting binders (keep conn state current without a re-render) ─────────
  function setName(id, val) { const c = byId(id); if (c) c.name = val; }
  function setSetting(id, key, val) {
    const c = byId(id); if (!c) return;
    c.settings[key] = (key === 'baudRate' || key === 'dataBits' || key === 'stopBits') ? (parseInt(val, 10) || 0) : val;
  }
  function setMode(id, val) {
    const c = byId(id); if (!c) return;
    c.mode = val;
    const note = document.getElementById('ser-mode-note-' + id);
    if (note) note.textContent = MODE_HINT[val];
  }

  // ── disconnect handling ───────────────────────────────────────────────────────
  function hookDisconnect() {
    if (disconnectHooked || !supported) return;
    disconnectHooked = true;
    // A device being plugged in may newly appear in getPorts(): refresh so it
    // shows in the "Previously allowed" list ready to reconnect.
    navigator.serial.addEventListener('connect', () => { refreshKnownPorts().then(renderList); });
    navigator.serial.addEventListener('disconnect', e => {
      const conn = conns.find(c => c.port === e.target);
      if (conn) {
        if (conn.phase === 'open') {
          conn.phase = 'error';
          conn.err = 'Device disconnected';
          emitSys(conn, 'Device disconnected', 'err');
        }
        // Release our handle so a later reopen (after re-plugging) succeeds
        // instead of failing with "The port is already open".
        teardown(conn).then(() => renderList());
      }
      refreshKnownPorts().then(renderList);
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  const MODE_LABEL = { text: 'ASCII text', hex: 'Hex dump', alert: 'ALERT decode' };
  const MODE_HINT = {
    text:  'Bytes are decoded as UTF-8/ASCII and split into lines on CR/LF.',
    hex:   'Raw bytes shown as a hex + ASCII dump (16 bytes per row) — best for inspecting binary framing.',
    alert: 'Every 4 bytes are decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF) and matched to the station database. Use “Resync” to shift byte alignment if frames don’t line up. ALERT2 support is planned.',
  };

  function statusBadge(conn) {
    if (conn.phase === 'open')   return '<span class="ser-badge ok">● live</span>';
    if (conn.phase === 'closed') return '<span class="ser-badge">closed</span>';
    if (conn.phase === 'error')  return '<span class="ser-badge bad">● ' + esc(conn.err || 'error') + '</span>';
    return '<span class="ser-badge warn">not opened</span>';
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (String(cur) === String(val) ? ' selected' : '') + '>' + label + '</option>';
  }

  function setupBody(conn) {
    const s = conn.settings;
    const portBtn = conn.port
      ? '<span class="ser-port-ok">✓ ' + esc(conn.portLabel) + '</span> '
        + '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Change…</button>'
      : '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Choose COM port…</button>';
    // Ports already granted in a previous pick — one click to reconnect without
    // the picker. Shown only before a port is chosen for this connection.
    const knownHtml = (!conn.port && knownPorts.length)
      ? '<div class="ser-known" style="margin-top:.4rem;font-size:.8rem">'
        + '<span style="opacity:.7">Previously allowed:</span> '
        + knownPorts.map((p, i) => '<button class="ghost" onclick="Serial.useKnownPort(\''
            + conn.id + '\',' + i + ')">' + esc(portLabel(p)) + '</button>').join(' ')
        + '</div>'
      : '';
    return ''
      + '<div class="ser-form">'
      + '  <label class="ser-f-name">Name'
      + '    <input type="text" value="' + esc(conn.name) + '" oninput="Serial.setName(\'' + conn.id + '\',this.value)">'
      + '  </label>'
      + '  <div class="ser-f-port"><label>COM port</label><div class="ser-port-row">' + portBtn + '</div>'
      + knownHtml
      + '    <div class="ser-port-status" id="ser-port-status-' + conn.id + '" style="font-size:.8rem;margin-top:.35rem"></div></div>'
      + '  <label>Baud rate'
      + '    <input type="number" list="ser-bauds" value="' + esc(s.baudRate) + '" min="1"'
      + '           oninput="Serial.setSetting(\'' + conn.id + '\',\'baudRate\',this.value)">'
      + '  </label>'
      + '  <label>Data bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'dataBits\',this.value)">'
      +        opt(8, '8', s.dataBits) + opt(7, '7', s.dataBits) + '</select></label>'
      + '  <label>Parity'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'parity\',this.value)">'
      +        opt('none', 'None', s.parity) + opt('even', 'Even', s.parity) + opt('odd', 'Odd', s.parity) + '</select></label>'
      + '  <label>Stop bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'stopBits\',this.value)">'
      +        opt(1, '1', s.stopBits) + opt(2, '2', s.stopBits) + '</select></label>'
      + '  <label>Flow control'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'flowControl\',this.value)">'
      +        opt('none', 'None', s.flowControl) + opt('hardware', 'Hardware (RTS/CTS)', s.flowControl) + '</select></label>'
      + '  <label>Display mode'
      + '    <select onchange="Serial.setMode(\'' + conn.id + '\',this.value)">'
      +        opt('text', 'ASCII text', conn.mode) + opt('hex', 'Hex dump', conn.mode) + opt('alert', 'ALERT decode', conn.mode) + '</select></label>'
      + '</div>'
      + '<p class="ser-mode-note" id="ser-mode-note-' + conn.id + '">' + MODE_HINT[conn.mode] + '</p>'
      + (conn.err ? '<p class="ser-err">Could not open port: ' + esc(conn.err) + '</p>' : '')
      + '<div class="ser-actions">'
      + '  <button class="primary" onclick="Serial.openConn(\'' + conn.id + '\')"' + (conn.port ? '' : ' disabled') + '>Open / Connect</button>'
      + '  <button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>'
      + '</div>';
  }

  function liveBody(conn) {
    const isOpen = conn.phase === 'open';
    const cfg = conn.settings.baudRate + ' baud · ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ' · ' + MODE_LABEL[conn.mode];
    let tb = '<div class="ser-toolbar">';
    if (isOpen) {
      tb += '<button class="ghost" onclick="Serial.togglePause(\'' + conn.id + '\')">' + (conn.paused ? 'Resume' : 'Pause') + '</button>';
      if (conn.mode === 'alert')
        tb += '<button class="ghost" onclick="Serial.resync(\'' + conn.id + '\')">Resync</button>';
    } else {
      tb += '<button class="primary" onclick="Serial.reopenConn(\'' + conn.id + '\')">Reopen</button>';
    }
    tb += '<button class="ghost" onclick="Serial.clearLog(\'' + conn.id + '\')">Clear</button>';
    tb += '<button class="ghost" onclick="Serial.saveLog(\'' + conn.id + '\')">Save log</button>';
    if (isOpen) tb += '<button class="ghost" onclick="Serial.closeConn(\'' + conn.id + '\')">Close</button>';
    tb += '<button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.timestamps ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'timestamps\',this.checked)"> timestamps</label>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.autoscroll ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'autoscroll\',this.checked)"> autoscroll</label>';
    tb += '</div>';

    const stats = '<div class="ser-substats"><span class="ser-cfg">' + esc(cfg) + '</span>'
      + '<span class="ser-stats" id="ser-stats-' + conn.id + '">' + esc(statsText(conn)) + '</span></div>';

    const log = '<div class="ser-log' + (conn.mode === 'text' ? ' ser-log-text' : '') + '" id="ser-log-' + conn.id + '"></div>';

    let send = '';
    if (isOpen) {
      send = '<div class="ser-send">'
        + '<input type="text" id="ser-send-' + conn.id + '" placeholder="Send to device…"'
        + ' onkeydown="if(event.key===\'Enter\')Serial.sendData(\'' + conn.id + '\')">'
        + '<select id="ser-send-end-' + conn.id + '">'
        +   '<option value="lf">\\n (LF)</option><option value="crlf">\\r\\n (CRLF)</option>'
        +   '<option value="cr">\\r (CR)</option><option value="none">no line ending</option>'
        + '</select>'
        + '<button class="ghost" onclick="Serial.sendData(\'' + conn.id + '\')">Send</button>'
        + '</div>';
    }
    return tb + stats + send + log;
  }

  function connCardHtml(conn) {
    return '<div class="panel ser-conn ser-' + conn.phase + '" id="ser-card-' + conn.id + '">'
      + '<div class="ser-conn-head">'
      + '  <span class="ser-conn-name">' + esc(conn.name) + '</span>'
      + '  ' + statusBadge(conn)
      + '  <span class="ser-conn-port small">' + (conn.portLabel ? esc(conn.portLabel) : '') + '</span>'
      + '</div>'
      + (conn.phase === 'setup' ? setupBody(conn) : liveBody(conn))
      + '</div>';
  }

  function renderList() {
    const host = document.getElementById('serial-conns');
    if (!host) return;
    if (!conns.length) {
      host.innerHTML = '<div class="panel ser-empty"><p>No connections yet. Click '
        + '<strong>+ Add connection</strong> to choose a COM port and open a serial device.</p></div>';
      return;
    }
    host.innerHTML = conns.map(connCardHtml).join('');
    // repopulate live logs from each connection's retained scrollback
    conns.forEach(c => { if (c.phase !== 'setup') repaintLog(c); });
  }

  function render() {
    const bauds = '<datalist id="ser-bauds">' + BAUD_RATES.map(b => '<option value="' + b + '">').join('') + '</datalist>';
    let banner = '';
    if (!supported) {
      banner = '<div class="panel ser-warn"><h3>Web Serial isn’t available in this browser</h3>'
        + '<p>The Serial Monitor uses the <a href="https://developer.mozilla.org/docs/Web/API/Web_Serial_API" target="_blank" rel="noopener">Web Serial API</a>, '
        + 'which needs a Chromium-based browser — <strong>Chrome, Edge or Opera</strong> — served over <strong>https</strong> or from <strong>localhost</strong>. '
        + 'It is not supported in Firefox or Safari, or when this page is opened directly from a <code>file://</code> path.</p></div>';
    } else if (typeof location !== 'undefined' && !window.isSecureContext) {
      banner = '<div class="panel ser-warn"><h3>Not a secure context</h3>'
        + '<p>Web Serial only works over <strong>https</strong> or <strong>localhost</strong>. This page appears to be served insecurely, '
        + 'so opening a COM port will be blocked by the browser.</p></div>';
    }
    return '<div class="serial">' + bauds
      + '<div class="panel">'
      + '  <div class="panel-header"><h2>Serial Monitor '
      + '<span class="small" style="opacity:.55;font-weight:normal">build ' + SERIAL_BUILD + '</span></h2>'
      + '    <button class="primary" onclick="Serial.addConnection()"' + (supported ? '' : ' disabled') + '>+ Add connection</button>'
      + '  </div>'
      + '  <p class="sub">Connect physical serial devices to your computer’s COM ports and watch their output live. '
      + '     Open several devices at once — each connection has its own port, baud rate and framing, and its own display mode: '
      + '     plain <strong>ASCII text</strong>, a raw <strong>hex dump</strong>, or live <strong>ALERT</strong> binary decoding '
      + '     (ABF/BCC/EAF/EIF) cross-referenced to the station database. Click <em>+ Add connection</em>, choose a COM port, '
      + '     set the serial parameters, then <em>Open / Connect</em>.</p>'
      + '</div>'
      + banner
      + '<div id="serial-conns"></div>'
      + '</div>';
  }

  function init() {
    hookDisconnect();
    renderList();
    // Fill in the "Previously allowed" ports once the browser answers; keeps the
    // first paint instant and non-blocking.
    refreshKnownPorts().then(renderList);
  }

  return {
    render, init, addConnection, choosePort, useKnownPort, openConn, closeConn, removeConn, reopenConn,
    togglePause, clearLog, saveLog, toggleFlag, sendData, resync, openInPackets,
    setName, setSetting, setMode,
  };
})();

// Expose the module on `window` for parity with the other tab modules and for
// debugging from the console. NOTE: the built-in Web Serial `Serial` interface
// on `window` does NOT actually break the inline onclick handlers — a top-level
// `const Serial` lives in the global lexical environment, which name resolution
// consults before the global object, so `Serial.choosePort(…)` resolves to this
// module with or without this line. (An earlier fix wrongly blamed that global
// collision; the real "does nothing" reports trace to a silent NotFoundError or
// a stale, cached app.js — hence the visible status line and build stamp above.)
if (typeof window !== 'undefined') window.Serial = Serial;

