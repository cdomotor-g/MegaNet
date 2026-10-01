// MegaNet — serial.js
//
//   Serial   the Serial Monitor tab: physical serial ports opened through the
//            Web Serial API and streamed live, as text, as a hex dump, or
//            decoded as ALERT payloads through the shared Packets codec — and
//            three kinds of card that are more than a stream: a Quansheng ALERT
//            receiver (serial-radio.js), an ELPRO ERT-A2 (serial-ert.js) and an
//            RTL-SDR on USB (serial-sdr.js). Where the browser will not open a
//            port, any serial card can follow the log file a terminal such as
//            PuTTY is writing instead (log-follow.js) — same pipeline, same card.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, slug and dlText, across to app.js for
// switchTab, and sideways to Packets, SerialRadio, SerialErt, SerialSdr,
// SerialViz, Quansheng, Alert2 and LogFollow — all from inside exported
// functions, none at load, so those files may load after this one.
//
// The three kinds share one list of connections (`conns`) and one card frame
// (name, status badge, port). A 'serial' card is this file's from end to end.
// A 'quansheng' card is a serial port like any other — this file opens it,
// reads it and keeps its raw log — but it hands its bytes to SerialRadio, which
// builds the card's body; an 'ert' card the same, to SerialErt. An 'sdr' card
// is not a serial port at all (WebUSB),
// and SerialSdr owns it whole; it lives in this list so the tab has one place
// to add, show and remove a device.
//
// Live port objects hold non-serialisable streams, so connections live in this
// module's own `conns` array rather than in global state. That is what lets them
// survive a tab switch, and it is why none of this is in core.js.
//
// Where the bytes come from is the card's `source`: 'port' (Web Serial) or
// 'file' (a log a terminal is writing, followed by LogFollow — the way round a
// managed computer that blocks Web Serial). A followed card's phase is
// 'follow' rather than 'open', because everything that sends — the send box,
// the radio's console — needs a port, and 'open' is what those check for.
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
  const SERIAL_BUILD = '2026-10-01b';

  function loadDefaults() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}'); } catch (_) {}
    return {
      baudRate:    d.baudRate    || 9600,
      dataBits:    d.dataBits    || 8,
      stopBits:    d.stopBits    || 1,
      parity:      d.parity      || 'none',
      flowControl: d.flowControl || 'none',
      mode:        ['text', 'hex', 'alert'].indexOf(d.mode) >= 0 ? d.mode : 'text',
      // A computer that blocks Web Serial blocks it every time, so the source
      // last used is the one to offer first.
      source:      d.source      || (supported ? 'port' : 'file'),
    };
  }
  function saveDefaults(conn) {
    const d = Object.assign({}, conn.settings, { mode: conn.mode === 'radio' || conn.mode === 'ert' ? loadDefaults().mode : conn.mode, source: conn.source });
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch (_) {}
  }

  function byId(id) { return conns.find(c => c.id === id); }

  // A serial connection's state. `kind` is 'serial', 'quansheng' or 'ert';
  // an 'sdr' card is made by SerialSdr.create instead.
  function makeConn(kind, extra) {
    const d = loadDefaults();
    const radio = kind === 'quansheng', ert = kind === 'ert';
    return Object.assign({
      id: 'c' + (nextId++),
      kind: kind || 'serial',
      name: radio ? 'Quansheng radio' : ert ? 'ERT-A2' : 'Connection ' + (conns.length + 1),
      phase: 'setup',                    // setup | open | follow | closed | error | demo
      source: d.source,                  // port | file
      follow: null,                      // { src, follower, note } while a log file is the source
      fromStart: true,                   // a followed log: read what is already in it first
      port: null,
      portLabel: '',
      settings: { baudRate: radio ? 115200 : d.baudRate, dataBits: d.dataBits, stopBits: d.stopBits,
                  parity: d.parity, flowControl: d.flowControl },
      mode: radio ? 'radio' : ert ? 'ert' : d.mode,
      entries: [],                       // {ts, cls, body(html), raw(text)}
      bytes: 0,
      count: 0,                          // lines (text) / rows (hex) / frames (alert)
      openedAt: null,
      paused: false,
      autoscroll: true,
      timestamps: true,
      err: null,
      // per-mode framing buffers
      decoder: new TextDecoder(),
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
      act: new Array(120).fill(0),       // bytes a second, the last two minutes
    }, extra || {});
  }

  // ── connection lifecycle ──────────────────────────────────────────────────────
  // `kind`: 'serial' (the default), 'quansheng', 'ert', or 'sdr' (WebUSB, SerialSdr's).
  function addConnection(kind) {
    const conn = kind === 'sdr'
      ? SerialSdr.create('c' + (nextId++), 'RTL-SDR ' + (conns.filter(c => c.kind === 'sdr').length + 1))
      : makeConn(kind === 'quansheng' || kind === 'ert' ? kind : 'serial');
    conns.push(conn);
    renderList();
    // reveal the freshly added card
    const el = document.getElementById('ser-card-' + conn.id);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Write a short status line beneath the "Choose COM port…" button. The
  // colour is a pattern-9 class (#140): an inline color was a decision the
  // contrast check could not see, and the literals it used were the status
  // tokens' values written out by hand.
  function setPortStatus(conn, msg, kind) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('txt-bad', kind === 'err');
    el.classList.toggle('txt-warn', kind === 'warn');
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
      recognise(conn);
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
    if (cell) cell.classList.add('ser-f-port--wide');
    const isEdge = /Edg\//.test(navigator.userAgent);
    const policyPage = isEdge ? 'edge://policy' : 'chrome://policy';
    const granted = knownPorts.length
      ? '<p class="ser-help-p"><strong>' + knownPorts.length + ' pre-approved port'
        + (knownPorts.length > 1 ? 's are' : ' is') + ' available</strong> under “Previously allowed” '
        + 'above — use that button instead of the picker.</p>'
      : '';
    el.classList.add('txt-bad');
    el.innerHTML =
        '<strong>The browser refused to show the port picker.</strong> It rejected the request instantly, '
      + 'so no dialog was ever displayed — this is a browser or IT-policy block, not an empty device list. '
      + '(If you did see a picker and closed it, ignore this and just click the button again.)'
      + granted
      + '<ol class="ser-help-ol">'
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
      + '</ol>'
      + '<p class="ser-help-p"><strong>Or do without Web Serial:</strong> open the port in PuTTY with logging on, and let this '
      +   'card follow the log file. <button type="button" class="ghost" onclick="Serial.setSource(\'' + conn.id + '\',\'file\')">'
      +   'Follow a log file instead</button></p>';
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
    recognise(conn);
    hookDisconnect();
    renderList();
  }

  // §2 of the radio's interface document: find it by VID, not by name. A port
  // with the ALERT firmware's VID becomes a Quansheng card on its own.
  function recognise(conn) {
    try {
      const info = conn.port && conn.port.getInfo ? conn.port.getInfo() : {};
      if (info && info.usbVendorId === Quansheng.USB_VID && conn.kind !== 'quansheng') {
        setKind(conn.id, 'quansheng', true);
        conn.recognised = true;
      }
    } catch (_) {}
  }

  function portLabel(port) {
    try {
      const info = port.getInfo ? port.getInfo() : {};
      if (info && info.usbVendorId != null) {
        const v = info.usbVendorId.toString(16).padStart(4, '0');
        const p = (info.usbProductId != null ? info.usbProductId : 0).toString(16).padStart(4, '0');
        if (typeof Quansheng !== 'undefined' && info.usbVendorId === Quansheng.USB_VID) return 'Quansheng ALERT radio (USB ' + v + ':' + p + ')';
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
    // A port replaces a followed log on this card for good.
    stopFollower(conn);
    conn.follow = null;
    conn.source = 'port';
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
    // The radio sends only while the host holds DTR, and a fresh
    // SET_CONTROL_LINE_STATE is what tells it a host is there (§2): drop DTR,
    // wait 50 ms, raise it.
    if (conn.kind === 'quansheng') await toggleDtr(conn);
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
    // The live-region policy for a streaming surface (#140, design-system §4):
    // the stream announces when it starts and stops and never per frame — the
    // frames live in the log region, read at the reader's own pace.
    announce(conn.name + ' — serial port open, streaming');
    conn.readLoopPromise = readLoop(conn);
    if (conn.kind === 'quansheng') SerialRadio.attach(conn);
    startTicker();
    renderList();
  }

  async function toggleDtr(conn) {
    if (!conn.port || !conn.port.setSignals) return;
    try {
      await conn.port.setSignals({ dataTerminalReady: false });
      await new Promise(r => setTimeout(r, 50));
      await conn.port.setSignals({ dataTerminalReady: true });
    } catch (e) {
      emitSys(conn, 'Could not set DTR: ' + ((e && e.message) || e), 'err');
    }
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
      // The stop half of the start/stop policy. Not user-initiated, but it is
      // the end of a stream the user started, and the alternative is a reader
      // listening to silence with no idea the port died.
      announce(conn.name + ' — device disconnected, stream stopped');
      flushPartials(conn);
      renderList();
    }
  }

  // Stop reading and release the OS port handle. Best-effort: every step is
  // guarded so it is safe to call in any state (never opened, open, or already
  // dropped). Used both by Close and as the clean-slate step before (re)opening.
  async function teardown(conn) {
    if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
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
    if (!(opts && opts.silent)) {
      announce(conn.name + ' — serial port closed');
      renderList();
    }
  }

  async function removeConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (conn.kind === 'sdr') await SerialSdr.remove(conn);          // a USB card: none of the serial teardown applies
    else {
      if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
      if (conn.phase === 'open') await closeConn(id, { silent: true });
      stopFollower(conn);
    }
    SerialIngest.detach(conn);
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

  // A demo connection: the live card — toolbar, stats, log, the works — with
  // nothing plugged in. Two consumers on purpose (#140): a person on a machine
  // with no serial device (or behind a blocked picker) can see what the tab
  // does before fighting IT for a COM port, and the test harness can hold the
  // live view to the per-tab Definition of Done, which no headless browser
  // could otherwise reach without hardware. The sample bytes run through the
  // real pipeline — handleChunk → the mode framers → the shared Packets codec
  // — so what the demo shows is what a device produces, not a mock-up.
  //
  // `kind` picks which demo: the plain stream (the default, and what the tabs
  // check seeds), a Quansheng radio (SerialRadio.demo — the firmware's own
  // example lines through the real parser), or an RTL-SDR (SerialSdr.demo —
  // synthesised bursts through the real decoder).
  function addDemo(kind) {
    if (kind === 'quansheng') {
      const conn = makeConn('quansheng', { name: 'Demo Quansheng radio', phase: 'demo', portLabel: 'Demo (no radio attached)' });
      conns.push(conn);
      SerialRadio.demo(conn);
      startTicker();
      renderList();
      const el = document.getElementById('ser-card-' + conn.id);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (kind === 'ert') {
      // Real frames off a test unit's USB port — the binary framing, the one
      // carrying RSSI — as the raw bytes the port puts out, through the same
      // handleChunk → SerialErt.feed → Alert2 path a live unit takes.
      const conn = makeConn('ert', { name: 'Demo ERT-A2', phase: 'demo', portLabel: 'Demo (no unit attached)' });
      conns.push(conn);
      emitSys(conn, 'Demo ERT-A2 — real frames from a test unit\'s USB port, no unit attached', 'sys');
      handleChunk(conn, Uint8Array.from(Alert2.hexStream(Alert2.samples().bin).bytes));
      emitSys(conn, 'End of demo — Remove this card, then add an ERT-A2 and choose its COM port or follow its log file', 'sys');
      renderList();
      const el = document.getElementById('ser-card-' + conn.id);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (kind === 'sdr') {
      const conn = SerialSdr.create('c' + (nextId++), 'Demo RTL-SDR');
      conns.push(conn);
      renderList();
      SerialSdr.demo(conn);
      const el = document.getElementById('ser-card-' + conn.id);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const conn = makeConn('serial', { name: 'Demo connection', phase: 'closed', portLabel: 'Demo (no device attached)', mode: 'text' });
    conns.push(conn);
    emitSys(conn, 'Demo connection — sample data, no device attached', 'sys');
    handleChunk(conn, new TextEncoder().encode('MegaNet serial demo — plain text mode\r\n'));
    // a logger printing readings, for the plotter
    conn.plot = { on: true, n: 0, series: new Map(), raf: 0 };
    let lines = '';
    for (let i = 0; i < 90; i++) {
      const stage = 1.2 + 0.35 * Math.sin(i / 14) + 0.02 * Math.sin(i * 1.7);
      lines += 'stage=' + stage.toFixed(3) + ' batt=' + (13.4 - i * 0.004 + 0.03 * Math.sin(i / 3)).toFixed(2)
        + ' rssi=' + Math.round(-82 + 6 * Math.sin(i / 9) + 3 * Math.cos(i * 0.9)) + '\r\n';
    }
    handleChunk(conn, new TextEncoder().encode(lines));
    conn.mode = 'hex';
    handleChunk(conn, new TextEncoder().encode('hex dump demo bytes'));
    conn.mode = 'alert';
    handleChunk(conn, new Uint8Array([0x07, 0xD5, 0xF8, 0xFE]));
    flushPartials(conn);
    conn.mode = 'text';   // where it started, so the plot toggle shows beside the plot
    emitSys(conn, 'End of demo — Remove this card and Add connection to open a real port', 'sys');
    renderList();
    const el = document.getElementById('ser-card-' + conn.id);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── following a log file instead of a port ────────────────────────────────────
  //
  // For a computer whose browser will not open a COM port (Web Serial blocked
  // by policy, or a browser without it): PuTTY opens the port and logs it to a
  // file (Session → Logging), and the card follows that file — every byte
  // appended goes through handleChunk exactly as a port's would, so a followed
  // radio or ERT-A2 is the same dashboard. How the file is re-read, and why a
  // dropped file works where the picker is blocked, is log-follow.js's header.
  //
  // Receive-only by nature: PuTTY holds the port, so nothing can be sent from
  // here. The radio's card says so and copies its console commands for pasting
  // into PuTTY instead (serial-radio.js).

  function setSource(id, source) {
    const c = byId(id); if (!c) return;
    c.source = source === 'file' ? 'file' : 'port';
    c.followMsg = null;
    if (c.phase !== 'setup') c.phase = 'setup';
    renderList();
  }
  function setFromStart(id, on) { const c = byId(id); if (c) c.fromStart = !!on; }

  // A line under the follow controls. `html` only for LogFollow.refusal's
  // markup, which escapes what it did not write; kept on the card so a
  // re-render does not lose why the picker said no.
  function setFollowStatus(conn, msg, kind, html) {
    conn.followMsg = msg ? { msg, kind, html: !!html } : null;
    const el = document.getElementById('ser-follow-status-' + conn.id);
    if (!el) return;
    if (html) el.innerHTML = msg || ''; else el.textContent = msg || '';
    el.classList.toggle('txt-bad', kind === 'err');
    el.classList.toggle('txt-warn', kind === 'warn');
  }

  // "Pick the log file…": the File System Access picker, where the browser
  // allows it. Where it does not, the refusal says to drag the file instead.
  async function chooseLog(id) {
    const conn = byId(id);
    if (!conn) return;
    setFollowStatus(conn, 'Opening the file picker…', '');
    const r = await LogFollow.pick();
    if (!r) { setFollowStatus(conn, '', ''); return; }
    if (r.error) { setFollowStatus(conn, LogFollow.refusal(r.error), 'err', true); return; }
    beginFollow(conn, r.src);
  }

  // "Read it once…": a plain file input, which every browser has and no
  // policy blocks — but its File goes stale as soon as PuTTY writes again, so
  // reading more means picking it again (Read again…).
  function readOnce(id) {
    const el = document.getElementById('ser-file-' + id);
    if (el) { el.value = ''; el.click(); }
  }
  function onFile(id, input) {
    const conn = byId(id);
    const file = input && input.files && input.files[0];
    if (!conn || !file) return;
    const fo = conn.follow;
    if (fo && fo.src.via === 'manual' && fo.follower && conn.phase === 'follow') { fo.follower.feed(file); return; }
    beginFollow(conn, LogFollow.fromFile(file).src);
  }

  // Drops: onto a card, or anywhere else on the tab (dropAnywhere). A drop is
  // the way in that works on a locked-down machine, so it is accepted
  // generously — and a file let fall beside the target must not make the
  // browser navigate away to show it, taking every connection with it.
  function dragOver(e, id) {
    if (!LogFollow.isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const card = document.getElementById('ser-card-' + id);
    if (card) card.classList.add('ser-drag');
  }
  function dragLeave(e, id) {
    const card = document.getElementById('ser-card-' + id);
    if (card && !(e.relatedTarget && card.contains(e.relatedTarget))) card.classList.remove('ser-drag');
  }
  function drop(e, id) {
    if (!LogFollow.isFileDrag(e)) return;
    const conn = byId(id);
    const card = document.getElementById('ser-card-' + id);
    if (card) card.classList.remove('ser-drag');
    // A card with its port open is not where a log goes: a new card is.
    if (!conn || conn.phase === 'open' || conn.kind === 'sdr') return;
    e.preventDefault();
    const r = LogFollow.fromDrop(e.dataTransfer);       // synchronously: the items die with the event
    if (r.error) { setFollowStatus(conn, r.error.message, 'err'); return; }
    beginFollow(conn, r.src, r.more);
  }
  function dropAnywhere(e) {
    if (e.defaultPrevented || !LogFollow.isFileDrag(e)) return;
    e.preventDefault();
    if (state.activeTab !== 'serial') return;
    const r = LogFollow.fromDrop(e.dataTransfer);
    if (r.error) return;
    let conn = conns.find(c => c.kind !== 'sdr' && c.phase === 'setup' && c.source === 'file');
    if (!conn) { conn = makeConn('serial', { source: 'file' }); conns.push(conn); }
    beginFollow(conn, r.src, r.more);
  }
  function guardDragOver(e) {
    if (!LogFollow.isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  // Before following: a generic card whose log turns out to be a radio's or an
  // ERT-A2's becomes that card — the way a radio's USB ID does on a port.
  async function beginFollow(conn, src, more) {
    if (conn.kind === 'serial') {
      try {
        const kind = sniffKind(await LogFollow.peek(src, 65536));
        if (kind) { setKind(conn.id, kind, true); conn.recognised = 'contents'; }
      } catch (_) { /* the follower reports a file it cannot read */ }
    }
    startFollow(conn, src);
    if (more) emitSys(conn, 'Only the first of the ' + (more + 1) + ' things dropped is followed — drop the others on cards of their own', 'sys');
  }

  // What a log holds, from its first 64 kB: an ERT-A2's ALERT2A lines or its
  // binary frames ("ALERT2", a length, then the version element 75 01), or a
  // line that is one of the Quansheng firmware's records.
  function sniffKind(u8) {
    const text = new TextDecoder('latin1').decode(u8);
    if (text.indexOf('ALERT2A,') >= 0) return 'ert';
    for (let i = text.indexOf('ALERT2'); i >= 0 && i + 8 < text.length; i = text.indexOf('ALERT2', i + 1)) {
      if (text.charCodeAt(i + 7) === 0x75 && text.charCodeAt(i + 8) === 0x01) return 'ert';
    }
    if (/4\s*1\W*4\s*C\W*4\s*5\W*5\s*2\W*5\s*4\W*3\s*2/i.test(text)) return 'ert';
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length && i < 2000; i++) {
      if (Quansheng.classify(lines[i].trim()) === 'record' && !/^ALERT2/.test(lines[i].trim())) return 'quansheng';
    }
    return null;
  }

  function stopFollower(conn) {
    if (conn.follow && conn.follow.follower) conn.follow.follower.stop();
  }

  function startFollow(conn, src, offset) {
    stopFollower(conn);
    if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
    const resumed = offset != null;
    conn.source = 'file';
    conn.follow = { src, follower: null, note: '', quiet: false };
    conn.followMsg = null;
    conn.portLabel = LogFollow.describe(src);
    conn.phase = 'follow';
    conn.err = null;
    conn.openedAt = Date.now();
    if (!resumed) {
      conn.decoder   = new TextDecoder();
      conn.textBuf   = '';
      conn.hexBuf    = [];
      conn.hexOffset = 0;
      conn.alertBuf  = [];
    }
    saveDefaults(conn);
    emitSys(conn, (resumed ? 'Following again: ' : 'Following ') + conn.portLabel + ' — '
      + (src.live ? 'read every second as it grows' : 'read when you pick it again; this browser cannot follow it by itself')
      + (conn.kind === 'serial' ? ' — mode: ' + MODE_LABEL[conn.mode] : ''), 'sys');
    if (conn.recognised === 'contents') emitSys(conn, 'Recognised as ' + MODE_LABEL[conn.mode] + ' from what is in the log', 'sys');
    if (conn.kind === 'quansheng') SerialRadio.attach(conn);
    const fo = conn.follow;
    fo.follower = LogFollow.start(src, {
      fromStart: conn.fromStart,
      offset: resumed ? offset : null,
      onData: (u8, m) => {
        if (fo.follower && fo.follower.trimmed && !fo.saidTrim) {
          fo.saidTrim = true;
          emitSys(conn, src.name + ' is ' + fmtBytes(m.size) + ' — reading its last ' + fmtBytes(m.size - fo.follower.trimmed) + ' only', 'sys');
        }
        // What was already in the file when following started is history:
        // its readings have no arrival time worth the name, which is what
        // SerialIngest.arrival() needs to know before timing one by "now".
        if (fo.historyEnd == null) fo.historyEnd = src.via === 'manual' ? Infinity : conn.fromStart || resumed ? m.size : m.from;
        conn.history = m.from < fo.historyEnd;
        // A big read (the file's history) is drawn once at the end rather
        // than line by line.
        conn.bulk = u8.length > 65536;
        handleChunk(conn, u8);
        conn.history = false;
        if (conn.bulk) { conn.bulk = false; repaintLog(conn); }
      },
      onReset: (why, name) => {
        fo.historyEnd = null;
        flushPartials(conn);
        conn.decoder = new TextDecoder();
        conn.portLabel = LogFollow.describe(src);
        const head = document.getElementById('ser-port-' + conn.id);
        if (head) head.textContent = conn.portLabel;
        emitSys(conn, why === 'switched'
          ? 'Now following ' + name + (src.via === 'folder' ? ', the newest log in ' + src.folder : '') + ' — reading it from the top'
          : name + ' got shorter — PuTTY started it again for a new session — reading it from the top', 'sys');
      },
      onError: (e, fatal) => {
        const text = LogFollow.trouble(e, src, fatal);
        fo.note = text;
        emitSys(conn, text, 'err');
        if (fatal) {
          conn.phase = 'closed';
          if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
          announce(conn.name + ' — stopped following ' + src.name);
          renderList();
        } else paintFollow(conn);
      },
      onTick: f => {
        if (!f.err && fo.note && !f.fails) fo.note = '';
        paintFollow(conn);
      },
    });
    announce(conn.name + ' — following ' + src.name);
    startTicker();
    renderList();
  }

  function stopFollow(id) {
    const conn = byId(id);
    if (!conn || !conn.follow) return;
    stopFollower(conn);
    flushPartials(conn);
    if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
    conn.phase = 'closed';
    emitSys(conn, 'Stopped following ' + conn.follow.src.name, 'sys');
    announce(conn.name + ' — stopped following the log');
    renderList();
  }
  function followAgain(id) {
    const conn = byId(id);
    if (!conn || !conn.follow) return;
    const f = conn.follow.follower;
    startFollow(conn, conn.follow.src, f ? f.offset : 0);
  }
  function readNow(id) {
    const conn = byId(id);
    if (!conn || !conn.follow || !conn.follow.follower) return;
    if (conn.follow.src.via === 'manual') { readOnce(id); return; }
    conn.follow.follower.readNow();
  }

  const QUIET_MS = 60000;
  function followText(conn) {
    const fo = conn.follow, f = fo && fo.follower;
    if (!f) return { text: '', kind: '' };
    const src = fo.src, name = src.via === 'folder' ? (src.name || 'nothing yet') + ' (newest in ' + src.folder + ')' : src.name;
    if (src.via === 'manual') {
      return { text: 'Read ' + fmtBytes(f.offset) + ' of ' + name + '. This browser cannot keep reading it by itself: '
        + 'drop the file on this card again, or press Read again…, to take what has been added since.', kind: '' };
    }
    const live = conn.phase === 'follow';
    let text = (live ? 'Following ' : 'Stopped following ') + name + ' — ' + fmtBytes(f.offset) + ' read';
    text += f.lastGrow ? ', last grew ' + agoText(f.lastGrow) : ', nothing added since following started';
    let kind = '';
    const since = Date.now() - (f.lastGrow || f.started);
    if (live && since > QUIET_MS) {
      text += '. Nothing new for ' + agoText(Date.now() - since).replace(' ago', '') + ' — is PuTTY still connected, and still logging to this file (Session → Logging)?';
      kind = 'warn';
    }
    if (fo.note) { text += '. ' + fo.note; kind = 'warn'; }
    return { text, kind };
  }
  function followHtml(conn) {
    if (!conn.follow) return '';
    const t = followText(conn);
    return '<p class="ser-follow-line' + (t.kind === 'warn' ? ' txt-warn' : '') + '" id="ser-follow-' + conn.id + '">' + esc(t.text) + '</p>';
  }
  function paintFollow(conn) {
    const el = document.getElementById('ser-follow-' + conn.id);
    if (!el) return;
    const t = followText(conn);
    el.textContent = t.text;
    el.classList.toggle('txt-warn', t.kind === 'warn');
  }
  function fmtBytes(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
  }
  function agoText(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }

  // ── incoming data handling ────────────────────────────────────────────────────
  function handleChunk(conn, u8) {
    conn.bytes += u8.length;
    tally(conn, u8.length);
    if (conn.kind === 'quansheng') { SerialRadio.feed(conn, u8); scheduleStats(conn); return; }
    if (conn.kind === 'ert') { SerialErt.feed(conn, u8); scheduleStats(conn); return; }
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
      plotLine(conn, line);
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
        + ' <button type="button" class="link-btn ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">details ▸</button>';
      raw = hex + '  ' + r.format.toUpperCase() + '  ID ' + r.values.A
        + (r.values.D !== undefined ? '  val ' + r.values.D : '') + '  ' + st.text;
    } else {
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge bad">no ALERT match</span>'
        + ' <button type="button" class="link-btn ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">inspect ▸</button>';
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
    if (conn.kind === 'ert') { SerialErt.flush(conn); scheduleStats(conn); return; }
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

  // A line into a connection's raw log, for SerialRadio: what the radio said
  // (classed by §3's four kinds), what was sent, and system notes. `t`
  // backdates it — the demo's history.
  function logLine(conn, text, cls, t) {
    if (cls !== 'sys' && cls !== 'err' && cls !== 'tx') conn.count++;
    const body = cls === 'tx' ? '<span class="ser-tx-arrow">»</span> ' + esc(String(text).replace(/^» /, '')) : (esc(text) || '&nbsp;');
    emit(conn, { ts: t || Date.now(), cls: cls || 'rx', body, raw: text });
  }

  // ── the plotter ───────────────────────────────────────────────────────────
  //
  // Numbers in text lines, drawn as they arrive — the Arduino IDE's serial
  // plotter, for a logger printing readings. A line of `key=value` (or
  // `key: value`) pairs names its series; otherwise its numbers are series 1,
  // 2, 3… in order. Up to eight series and 600 points each; every series is
  // scaled to its own range, so a river stage in metres and an RSSI in dBm
  // can share the picture, and the legend carries the units' worth of truth:
  // last, minimum and maximum.
  const PLOT_MAX = 600;
  const NUM = '-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?';
  function plotLine(conn, line) {
    const p = conn.plot;
    if (!p || !p.on) return;
    let pairs = [];
    const kv = line.match(new RegExp('([A-Za-z_][\\w.]*)\\s*[=:]\\s*(' + NUM + ')', 'g'));
    if (kv && kv.length) {
      pairs = kv.map(t => { const m = new RegExp('([A-Za-z_][\\w.]*)\\s*[=:]\\s*(' + NUM + ')').exec(t); return [m[1], parseFloat(m[2])]; });
    } else {
      const nums = line.match(new RegExp(NUM, 'g'));
      if (!nums) return;
      pairs = nums.slice(0, 8).map((n, i) => ['#' + (i + 1), parseFloat(n)]);
    }
    p.n++;
    pairs.forEach(([k, v]) => {
      if (!Number.isFinite(v)) return;
      if (!p.series.has(k)) { if (p.series.size >= 8) return; p.series.set(k, []); }
      const a = p.series.get(k);
      a.push([p.n, v]);
      if (a.length > PLOT_MAX) a.shift();
    });
    if (!p.raf) p.raf = requestAnimationFrame(() => { p.raf = 0; paintPlot(conn); });
  }

  function togglePlot(id, on) {
    const conn = byId(id);
    if (!conn) return;
    conn.plot = conn.plot || { on: false, n: 0, series: new Map(), raf: 0 };
    conn.plot.on = !!on;
    if (on && !conn.plot.series.size) conn.entries.forEach(e => { if (e.cls === 'rx') plotLine(conn, e.raw); });
    renderList();
  }

  function plotHtml(conn) {
    if (!conn.plot || !conn.plot.on) return '';
    return '<div class="ser-plot"><canvas class="qs-canvas" id="ser-plot-' + conn.id + '" role="img" aria-label="Plot of the numbers in each line"></canvas>'
      + '<div class="qs-legend" id="ser-plot-legend-' + conn.id + '"></div></div>';
  }

  function paintPlot(conn) {
    const cv = document.getElementById('ser-plot-' + conn.id);
    if (!cv || typeof SerialViz === 'undefined') return;
    const f = SerialViz.fit(cv, 170);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors(), p = conn.plot;
    ctx.clearRect(0, 0, w, h);
    const palette = [col.accent, col.ok, col.warn, col.bad, col.crc, col.ident, col.addr, col.muted];
    const n1 = p.n, n0 = Math.max(0, n1 - PLOT_MAX);
    ctx.strokeStyle = col.border; ctx.lineWidth = dpr;
    for (let k = 1; k < 4; k++) { const y = Math.round(k * h / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const legend = [];
    let i = 0;
    for (const [name, pts] of p.series) {
      const color = palette[i++ % palette.length];
      if (!pts.length) continue;
      let lo = Infinity, hi = -Infinity;
      pts.forEach(q => { if (q[1] < lo) lo = q[1]; if (q[1] > hi) hi = q[1]; });
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
      const L = lo - pad, H = hi + pad;
      ctx.beginPath();
      pts.forEach((q, j) => {
        const x = (q[0] - n0) / Math.max(1, n1 - n0) * (w - 4 * dpr) + 2 * dpr, y = h - 4 * dpr - (q[1] - L) / (H - L) * (h - 8 * dpr);
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 1.6 * dpr; ctx.stroke();
      const last = pts[pts.length - 1][1];
      legend.push('<span><i class="qs-sw ser-plot-sw" style="--dot: ' + color + '"></i>' + esc(name) + ' <strong>' + esc(String(+last.toPrecision(6)))
        + '</strong> <span class="qs-dim">(' + esc(String(+lo.toPrecision(5))) + ' – ' + esc(String(+hi.toPrecision(5))) + ')</span></span>');
    }
    const lg = document.getElementById('ser-plot-legend-' + conn.id);
    if (lg) lg.innerHTML = legend.length ? legend.join('') : '<span>No numbers in the lines yet.</span>';
    cv.setAttribute('aria-label', 'Plot of ' + p.series.size + ' series from the last ' + Math.min(PLOT_MAX, n1) + ' lines, each scaled to its own range; '
      + 'the legend beside it gives each one\'s last, lowest and highest value.');
  }

  // Bytes a second, for the activity sparkline.
  function tally(conn, n) {
    if (!conn.act) conn.act = new Array(120).fill(0);
    const sec = Math.floor(Date.now() / 1000);
    if (conn.actSec == null) conn.actSec = sec;
    const steps = Math.min(120, sec - conn.actSec);
    for (let i = 0; i < steps; i++) { conn.act.shift(); conn.act.push(0); }
    conn.actSec = sec;
    conn.act[conn.act.length - 1] += n;
  }

  // One second tick for every card's sparkline, running only while a card can
  // be receiving. Started by open and by a demo, never at load.
  let ticker = null;
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      const live = conns.filter(c => c.kind !== 'sdr' && (c.phase === 'open' || c.phase === 'demo' || c.phase === 'follow'));
      if (!live.length) { clearInterval(ticker); ticker = null; return; }
      live.forEach(c => { tally(c, 0); paintSpark(c); if (c.follow) paintFollow(c); });
    }, 1000);
  }
  function paintSpark(conn) {
    const cv = document.getElementById('ser-spark-' + conn.id);
    if (!cv || typeof SerialViz === 'undefined') return;
    SerialViz.spark(cv, conn.act || [], { height: 26 });
    const recent = (conn.act || []).slice(-10).reduce((a, b) => a + b, 0) / 10;
    cv.setAttribute('aria-label', 'Bytes received a second over the last two minutes; ' + Math.round(recent) + ' B/s over the last ten seconds.');
  }

  // ── entry buffer + surgical DOM append ────────────────────────────────────────
  function emit(conn, entry) {
    conn.entries.push(entry);
    if (conn.entries.length > MAX_ENTRIES) conn.entries.splice(0, conn.entries.length - MAX_ENTRIES);
    if (conn.paused || conn.bulk) return;
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
    // A followed log's history arrives in one read, so a rate would mean nothing.
    const rate = conn.bytes && !conn.follow ? ' · ' + Math.round(conn.bytes / secs) + ' B/s' : '';
    return conn.bytes.toLocaleString() + ' bytes · ' + conn.count.toLocaleString() + ' ' + unit + rate;
  }

  // ── toolbar actions ───────────────────────────────────────────────────────────
  function togglePause(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.paused = !conn.paused;
    if (!conn.paused) repaintLog(conn);
    announce(conn.name + (conn.paused ? ' — display paused; the port stays open' : ' — display resumed'));
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
      await writeText(conn, text + suffix, text);
      inp.value = '';
    } catch (e) {
      emitSys(conn, 'Send failed: ' + e.message, 'err');
    }
  }

  // Write text to an open port, and log what was sent (`echo`, if given).
  async function writeText(conn, text, echo) {
    if (!conn.port || !conn.port.writable) throw new Error('port is not writable');
    if (!conn.writer) conn.writer = conn.port.writable.getWriter();
    await conn.writer.write(new TextEncoder().encode(text));
    if (echo != null) emit(conn, { ts: Date.now(), cls: 'tx', body: '<span class="ser-tx-arrow">»</span> ' + esc(echo), raw: '» ' + echo });
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
  // Generic stream or Quansheng radio. The radio ignores the baud rate (it is
  // USB CDC) and its card is SerialRadio's dashboard rather than a stream.
  function setKind(id, kind, quiet) {
    const c = byId(id); if (!c) return;
    c.kind = kind === 'quansheng' || kind === 'ert' ? kind : 'serial';
    const plain = /^(Connection \d+|Quansheng radio|ERT-A2)$/.test(c.name);
    if (c.kind === 'quansheng') {
      c.mode = 'radio';
      if (plain) c.name = 'Quansheng radio';
      c.settings.baudRate = 115200;
    } else if (c.kind === 'ert') {
      c.mode = 'ert';
      if (plain) c.name = 'ERT-A2';
    } else if (c.mode === 'radio' || c.mode === 'ert') {
      c.mode = loadDefaults().mode;
      if (plain) c.name = 'Connection ' + (conns.indexOf(c) + 1);
    }
    if (!quiet) renderList();
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
        if (conn.kind === 'quansheng' && conn.radio) SerialRadio.detach(conn);
        // Release our handle so a later reopen (after re-plugging) succeeds
        // instead of failing with "The port is already open".
        teardown(conn).then(() => renderList());
      }
      refreshKnownPorts().then(renderList);
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  const MODE_LABEL = { text: 'ASCII text', hex: 'Hex dump', alert: 'ALERT decode', radio: 'Quansheng ALERT receiver', ert: 'ELPRO ERT-A2' };
  const MODE_HINT = {
    text:  'Bytes are decoded as UTF-8/ASCII and split into lines on CR/LF.',
    hex:   'Raw bytes shown as a hex + ASCII dump (16 bytes per row) — best for inspecting binary framing.',
    alert: 'Every 4 bytes are decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF) and matched to the station database. Use “Resync” to shift byte alignment if frames don’t line up. For ALERT2, choose the ELPRO ERT-A2 device instead.',
    radio: 'A Quansheng UV-K5 V3 / UV-K1 running the ALERT receiver firmware: its readings, bursts, noise floor and battery as a dashboard, and its console (clock, settings, flash log, station table, screen) as controls. The radio ignores the baud rate — any value works.',
    ert:   'An ELPRO ERT-A2: the RS232 port’s ALERT2A lines (with the receiver’s clock) or the USB port’s binary frames (with RSSI), told apart by what arrives, and every reading matched to its station the way the ALERT2 tab matches them.',
  };

  function statusBadge(conn) {
    if (conn.phase === 'demo')   return '<span class="ser-badge ok">● demo</span>';
    if (conn.phase === 'open')   return '<span class="ser-badge ok">● live</span>';
    if (conn.phase === 'follow') return '<span class="ser-badge ok">● ' + (conn.follow && conn.follow.src.via === 'manual' ? 'read on request' : 'following') + '</span>';
    if (conn.phase === 'closed') return '<span class="ser-badge">closed</span>';
    if (conn.phase === 'error')  return '<span class="ser-badge bad">● ' + esc(conn.err || 'error') + '</span>';
    return '<span class="ser-badge warn">not opened</span>';
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (String(cur) === String(val) ? ' selected' : '') + '>' + label + '</option>';
  }

  function setupBody(conn) {
    const id = conn.id;
    const file = conn.source === 'file';
    const radio = conn.kind === 'quansheng', ert = conn.kind === 'ert';
    const radioBtn = (v, label) => '<label class="ser-check"><input type="radio" name="ser-src-' + id + '" value="' + v + '"'
      + (conn.source === v ? ' checked' : '') + ' onchange="Serial.setSource(\'' + id + '\',this.value)"> ' + label + '</label>';
    let html = '<div class="ser-form">'
      + '  <label class="ser-f-name">Name'
      + '    <input type="text" value="' + esc(conn.name) + '" oninput="Serial.setName(\'' + id + '\',this.value)">'
      + '  </label>'
      + '  <label class="ser-f-kind">Device'
      + '    <select onchange="Serial.setKind(\'' + id + '\',this.value)">'
      +        opt('serial', 'Generic serial device', conn.kind) + opt('quansheng', 'Quansheng ALERT receiver (UV-K5 V3 / UV-K1)', conn.kind)
      +        opt('ert', 'ELPRO ERT-A2 (ALERT2 — RS232 ASCII or USB)', conn.kind) + '</select>'
      + (conn.recognised ? '<span class="ser-port-ok">✓ recognised ' + (conn.recognised === 'contents' ? 'from its log' : 'by its USB ID') + '</span>' : '')
      + '  </label>'
      + '  <fieldset class="ser-f-source"><legend>Read from</legend>'
      +      radioBtn('port', 'a COM port, opened here (Web Serial)')
      +      radioBtn('file', 'a log file PuTTY or another terminal is writing')
      + '  </fieldset>';
    if (file) html += followSetup(conn);
    else html += portSetup(conn);
    if (!radio && !ert) html += '  <label>Display mode'
      + '    <select onchange="Serial.setMode(\'' + id + '\',this.value)">'
      +        opt('text', 'ASCII text', conn.mode) + opt('hex', 'Hex dump', conn.mode) + opt('alert', 'ALERT decode', conn.mode) + '</select></label>';
    html += '</div>'
      + '<p class="ser-mode-note" id="ser-mode-note-' + id + '">' + MODE_HINT[conn.mode] + '</p>'
      + (conn.err && !file ? '<p class="ser-err">Could not open port: ' + esc(conn.err) + '</p>' : '')
      + '<div class="ser-actions">'
      + (file ? '' : '  <button class="primary" onclick="Serial.openConn(\'' + id + '\')"' + (conn.port ? '' : ' disabled') + '>Open / Connect</button>')
      + '  <button class="ghost" onclick="Serial.removeConn(\'' + id + '\')">Remove</button>'
      + '</div>';
    return html;
  }

  function portSetup(conn) {
    const s = conn.settings, id = conn.id;
    const portBtn = !supported
      ? '<span class="txt-warn">This browser has no Web Serial — follow a log file instead (above).</span>'
      : conn.port
      ? '<span class="ser-port-ok">✓ ' + esc(conn.portLabel) + '</span> '
        + '<button class="ghost" onclick="Serial.choosePort(\'' + id + '\')">Change…</button>'
      : '<button class="ghost" onclick="Serial.choosePort(\'' + id + '\')">Choose COM port…</button>';
    // Ports already granted in a previous pick — one click to reconnect without
    // the picker. Shown only before a port is chosen for this connection.
    const knownHtml = (!conn.port && knownPorts.length)
      ? '<div class="ser-known">'
        + '<span class="ser-known-label">Previously allowed:</span> '
        + knownPorts.map((p, i) => '<button class="ghost" onclick="Serial.useKnownPort(\''
            + id + '\',' + i + ')">' + esc(portLabel(p)) + '</button>').join(' ')
        + '</div>'
      : '';
    return ''
      + '  <div class="ser-f-port"><label>COM port</label><div class="ser-port-row">' + portBtn + '</div>'
      + knownHtml
      + '    <div class="ser-port-status" id="ser-port-status-' + id + '"></div></div>'
      + '  <label>Baud rate'
      + '    <input type="number" list="ser-bauds" value="' + esc(s.baudRate) + '" min="1"'
      + '           oninput="Serial.setSetting(\'' + id + '\',\'baudRate\',this.value)">'
      + '  </label>'
      + '  <label>Data bits'
      + '    <select onchange="Serial.setSetting(\'' + id + '\',\'dataBits\',this.value)">'
      +        opt(8, '8', s.dataBits) + opt(7, '7', s.dataBits) + '</select></label>'
      + '  <label>Parity'
      + '    <select onchange="Serial.setSetting(\'' + id + '\',\'parity\',this.value)">'
      +        opt('none', 'None', s.parity) + opt('even', 'Even', s.parity) + opt('odd', 'Odd', s.parity) + '</select></label>'
      + '  <label>Stop bits'
      + '    <select onchange="Serial.setSetting(\'' + id + '\',\'stopBits\',this.value)">'
      +        opt(1, '1', s.stopBits) + opt(2, '2', s.stopBits) + '</select></label>'
      + '  <label>Flow control'
      + '    <select onchange="Serial.setSetting(\'' + id + '\',\'flowControl\',this.value)">'
      +        opt('none', 'None', s.flowControl) + opt('hardware', 'Hardware (RTS/CTS)', s.flowControl) + '</select></label>';
  }

  // The log-file half of the setup form. The drop zone is first because it is
  // the way that works everywhere, a managed computer included; the picker
  // follows where the browser offers one, and "Read it once" is the last resort.
  function followSetup(conn) {
    const id = conn.id, m = conn.followMsg;
    const status = m ? (m.html ? m.msg : esc(m.msg)) : '';
    const cls = m && m.kind === 'err' ? ' txt-bad' : m && m.kind === 'warn' ? ' txt-warn' : '';
    return '  <div class="ser-f-follow">'
      + '    <div class="ser-drop" id="ser-drop-' + id + '">'
      + '      <strong>Drag the log file here</strong> from File Explorer — or the folder PuTTY logs into, to follow whichever log in it is newest.'
      + '      <span>It is read every second as it grows, including where IT has switched the browser’s file picker off.</span>'
      + '    </div>'
      + '    <div class="ser-port-row">'
      + (LogFollow.canPick() ? '<button class="ghost" onclick="Serial.chooseLog(\'' + id + '\')">Pick the log file…</button>' : '')
      + '      <button class="ghost" onclick="Serial.readOnce(\'' + id + '\')">Read it once…</button>'
      + '      <label class="ser-check"><input type="checkbox"' + (conn.fromStart ? ' checked' : '')
      + ' onchange="Serial.setFromStart(\'' + id + '\',this.checked)"> start with what is already in it</label>'
      + '    </div>'
      + '    <div class="ser-port-status' + cls + '" id="ser-follow-status-' + id + '">' + status + '</div>'
      + '    <p class="ser-follow-how">In PuTTY: <em>Session → Logging</em>, choose <strong>All session output</strong> and a file name, '
      + 'then open the port as usual. PuTTY holds the port, so this card only listens — '
      + '<a href="docs/serial-help.html#putty" target="_blank" rel="noopener">step by step</a>.</p>'
      + '  </div>';
  }

  // The toolbar every stream card has. SerialRadio puts its own buttons in
  // front of these.
  function toolbarButtons(conn) {
    const isOpen = conn.phase === 'open', demo = conn.phase === 'demo', following = conn.phase === 'follow';
    let tb = '';
    if (isOpen || following) {
      tb += '<button class="ghost" onclick="Serial.togglePause(\'' + conn.id + '\')">' + (conn.paused ? 'Resume' : 'Pause') + '</button>';
      if (conn.mode === 'alert')
        tb += '<button class="ghost" onclick="Serial.resync(\'' + conn.id + '\')">Resync</button>';
    }
    if (following) {
      tb += conn.follow.src.via === 'manual'
        ? '<button class="primary" onclick="Serial.readNow(\'' + conn.id + '\')">Read again…</button>'
        : '<button class="ghost" onclick="Serial.readNow(\'' + conn.id + '\')">Read now</button>';
    } else if (!isOpen && !demo && conn.follow && conn.follow.src.live) {
      tb += '<button class="primary" onclick="Serial.followAgain(\'' + conn.id + '\')">Follow again</button>';
    } else if (!isOpen && !demo && conn.port) {
      tb += '<button class="primary" onclick="Serial.reopenConn(\'' + conn.id + '\')">Reopen</button>';
    }
    tb += '<button class="ghost" onclick="Serial.clearLog(\'' + conn.id + '\')">Clear' + (conn.kind === 'quansheng' ? ' raw' : '') + '</button>';
    tb += '<button class="ghost" onclick="Serial.saveLog(\'' + conn.id + '\')">Save log</button>';
    if (isOpen) tb += '<button class="ghost" onclick="Serial.closeConn(\'' + conn.id + '\')">Close</button>';
    if (following) tb += '<button class="ghost" onclick="Serial.stopFollow(\'' + conn.id + '\')">Stop following</button>';
    tb += '<button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.timestamps ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'timestamps\',this.checked)"> timestamps</label>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.autoscroll ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'autoscroll\',this.checked)"> autoscroll</label>';
    if (conn.kind === 'serial' && conn.mode === 'text') {
      tb += '<label class="ser-check"><input type="checkbox"' + (conn.plot && conn.plot.on ? ' checked' : '')
        + ' onchange="Serial.togglePlot(\'' + conn.id + '\',this.checked)"> plot numbers</label>';
    }
    return tb;
  }

  // The settings line, the byte counter and the activity sparkline.
  function statsHtml(conn) {
    const cfg = conn.follow && conn.source === 'file'
      ? 'Log file · ' + MODE_LABEL[conn.mode]
      : conn.kind === 'quansheng'
      ? 'USB CDC · ' + MODE_LABEL.radio
      : conn.settings.baudRate + ' baud · ' + conn.settings.dataBits + fmtParity(conn.settings.parity) + conn.settings.stopBits + ' · ' + MODE_LABEL[conn.mode];
    return '<div class="ser-substats"><span class="ser-cfg">' + esc(cfg) + '</span>'
      + '<canvas class="ser-spark" id="ser-spark-' + conn.id + '" role="img" aria-label="Bytes received a second"></canvas>'
      + '<span class="ser-stats" id="ser-stats-' + conn.id + '">' + esc(statsText(conn)) + '</span></div>';
  }

  // The log is a fixed-height scroller, so it is a named region with a tab
  // stop (pattern 7 — overflow: auto is keyboard-scrollable in Firefox and
  // nothing else). It is deliberately NOT a live region: at 9600 baud a
  // role="log" would announce every line, which is the unusable half of the
  // aria-live failure mode. The policy (design-system §4): announce start
  // and stop, keep the stream in a region the reader visits at their own
  // pace, with the stats line beside it as the on-demand summary.
  function logHtml(conn) {
    return '<div class="ser-log' + (conn.mode === 'text' || conn.kind === 'quansheng' || conn.kind === 'ert' ? ' ser-log-text' : '') + '" id="ser-log-' + conn.id + '"'
      + ' role="region" tabindex="0" aria-label="Received data — ' + esc(conn.name) + '"></div>';
  }

  function liveBody(conn) {
    if (conn.kind === 'quansheng') return SerialRadio.body(conn);
    if (conn.kind === 'ert') return SerialErt.body(conn);
    const isOpen = conn.phase === 'open';
    const tb = '<div class="ser-toolbar">' + toolbarButtons(conn) + '</div>' + followHtml(conn);
    let send = '';
    if (isOpen) {
      send = '<div class="ser-send">'
        + '<input type="text" id="ser-send-' + conn.id + '" placeholder="Send to device…"'
        + ' aria-label="Text to send to the device"'
        + ' onkeydown="if(event.key===\'Enter\')Serial.sendData(\'' + conn.id + '\')">'
        + '<select id="ser-send-end-' + conn.id + '" aria-label="Line ending">'
        +   '<option value="lf">\\n (LF)</option><option value="crlf">\\r\\n (CRLF)</option>'
        +   '<option value="cr">\\r (CR)</option><option value="none">no line ending</option>'
        + '</select>'
        + '<button class="ghost" onclick="Serial.sendData(\'' + conn.id + '\')">Send</button>'
        + '</div>';
    }
    return tb + statsHtml(conn) + plotHtml(conn) + send + logHtml(conn);
  }

  // Every serial card takes a dropped log file — onto its setup form to start
  // following, onto a followed card to follow another file instead.
  function connCardHtml(conn) {
    if (conn.kind === 'sdr') return SerialSdr.cardHtml(conn);
    const id = conn.id;
    return '<div class="panel ser-conn ser-' + conn.phase + (conn.kind === 'quansheng' ? ' ser-radio' : conn.kind === 'ert' ? ' ser-ert' : '') + '" id="ser-card-' + id + '"'
      + ' ondragover="Serial.dragOver(event,\'' + id + '\')" ondragleave="Serial.dragLeave(event,\'' + id + '\')" ondrop="Serial.drop(event,\'' + id + '\')">'
      + '<div class="ser-conn-head">'
      + '  <span class="ser-conn-name">' + esc(conn.name) + '</span>'
      + '  ' + statusBadge(conn)
      + '  <span class="ser-conn-port small" id="ser-port-' + id + '">' + (conn.portLabel ? esc(conn.portLabel) : '') + '</span>'
      + '</div>'
      + (conn.phase === 'setup' ? setupBody(conn) : liveBody(conn))
      + '<input type="file" id="ser-file-' + id + '" hidden accept=".log,.txt,.csv,.hex,.dat,text/plain" aria-label="Log file to read"'
      + ' onchange="Serial.onFile(\'' + id + '\',this)">'
      + '</div>';
  }

  function renderList() {
    const host = document.getElementById('serial-conns');
    if (!host) return;
    if (!conns.length) {
      host.innerHTML = '<div class="panel ser-empty"><p>No connections yet. Add a <strong>serial device</strong>, a '
        + '<strong>Quansheng ALERT radio</strong> or an <strong>ERT-A2</strong> to choose a COM port, or an <strong>RTL-SDR</strong> to pick a USB stick — '
        + 'or look at what each card does first, with nothing plugged in:</p>'
        + '<div class="button-group">'
        + '<button class="ghost" onclick="Serial.addDemo()">Show a demo connection</button>'
        + '<button class="ghost" onclick="Serial.addDemo(\'quansheng\')">Demo Quansheng radio</button>'
        + '<button class="ghost" onclick="Serial.addDemo(\'ert\')">Demo ERT-A2</button>'
        + '<button class="ghost" onclick="Serial.addDemo(\'sdr\')">Demo RTL-SDR</button>'
        + '</div>'
        + '<p class="ser-empty-follow"><strong>No COM port on this computer?</strong> Open the port in PuTTY with logging on '
        + '(Session → Logging → <em>All session output</em>), then drag the log file — or the folder it logs into — anywhere on this tab. '
        + 'It is followed as it grows, and a radio’s or an ERT-A2’s log becomes that card by itself. '
        + '<a href="docs/serial-help.html#putty" target="_blank" rel="noopener">How to set PuTTY up</a></p>'
        + '</div>';
      return;
    }
    host.innerHTML = conns.map(connCardHtml).join('');
    // repopulate live logs from each connection's retained scrollback, and
    // redraw each card's graphics from its own model — the canvases are new
    conns.forEach(c => {
      if (c.kind === 'sdr') { SerialSdr.mount(c); return; }
      if (c.phase === 'setup') return;
      repaintLog(c);
      paintSpark(c);
      if (c.plot && c.plot.on) paintPlot(c);
      if (c.kind === 'quansheng') { SerialRadio.mount(c); SerialIngest.mount(c); }
      if (c.kind === 'ert') SerialErt.mount(c);
    });
  }

  function render() {
    const bauds = '<datalist id="ser-bauds">' + BAUD_RATES.map(b => '<option value="' + b + '">').join('') + '</datalist>';
    let banner = '';
    const usb = typeof navigator !== 'undefined' && 'usb' in navigator;
    if (!supported) {
      banner = '<div class="panel ser-warn"><h3>Web Serial isn’t available in this browser</h3>'
        + '<p>The Serial Monitor uses the <a href="https://developer.mozilla.org/docs/Web/API/Web_Serial_API" target="_blank" rel="noopener">Web Serial API</a>, '
        + 'which needs a Chromium-based browser — <strong>Chrome, Edge or Opera</strong> — served over <strong>https</strong> or from <strong>localhost</strong>. '
        + 'It is not supported in Firefox or Safari, or when this page is opened directly from a <code>file://</code> path.'
        + (usb ? '' : ' The RTL-SDR card needs WebUSB, which has the same requirement.') + ' The demos below work anywhere, and so does '
        + '<strong>following a log file</strong> a terminal such as PuTTY is writing: add a card and drop the log on it.</p></div>';
    } else if (typeof location !== 'undefined' && !window.isSecureContext) {
      banner = '<div class="panel ser-warn"><h3>Not a secure context</h3>'
        + '<p>Web Serial only works over <strong>https</strong> or <strong>localhost</strong>. This page appears to be served insecurely, '
        + 'so opening a COM port will be blocked by the browser.</p></div>';
    }
    return '<div class="serial" ondragover="Serial.guardDragOver(event)" ondrop="Serial.dropAnywhere(event)">' + bauds
      + '<div class="panel">'
      + '  <div class="panel-header"><h2>Serial Monitor '
      + '<span class="small ser-build">build ' + SERIAL_BUILD + '</span></h2>'
      + '    <div class="ser-add">'
      + '    <button class="primary" onclick="Serial.addConnection()">+ Serial device</button>'
      + '    <button class="primary" onclick="Serial.addConnection(\'quansheng\')">+ Quansheng radio</button>'
      + '    <button class="primary" onclick="Serial.addConnection(\'ert\')">+ ERT-A2</button>'
      + '    <button class="primary" onclick="Serial.addConnection(\'sdr\')"' + (usb ? '' : ' disabled') + '>+ RTL-SDR</button>'
      + '    </div>'
      + '  </div>'
      + '  <p class="sub">Connect physical devices and watch them live — several at once, each its own card. '
      + '     A <strong>serial device</strong> streams as plain <strong>ASCII text</strong>, a raw <strong>hex dump</strong>, or live '
      + '     <strong>ALERT</strong> binary decoding (ABF/BCC/EAF/EIF) cross-referenced to the station database. '
      + '     A <strong>Quansheng ALERT radio</strong> (UV-K5 V3 / UV-K1 on the ALERT receiver firmware) becomes a dashboard: its readings, '
      + '     bursts, noise floor and battery, and its own controls — clock, settings, flash log, station table, screen. '
      + '     An <strong>ELPRO ERT-A2</strong> decodes as it arrives — RS232 ASCII or USB binary with RSSI — every reading matched to its station. '
      + '     An <strong>RTL-SDR</strong> (Blog V2, V3 or V4, over USB) decodes ALERT off the air itself, with a live spectrum, waterfall and audio. '
      + '     Where the browser will not open a COM port, a card can <strong>follow the log file PuTTY writes</strong> instead — drop it anywhere on this tab.</p>'
      + '</div>'
      + banner
      + '<div id="serial-conns"></div>'
      + '</div>';
  }

  // A file dropped anywhere on the page while this tab is up — outside the
  // tab's own area, say on the nav — is caught too: left alone, the browser
  // would navigate away to show it and every connection would go with it.
  // Added on the way in, taken off on the way out.
  function stopDocDrops() {
    document.removeEventListener('dragover', guardDragOver);
    document.removeEventListener('drop', dropAnywhere);
  }

  function init() {
    hookDisconnect();
    stopDocDrops();
    document.addEventListener('dragover', guardDragOver);
    document.addEventListener('drop', dropAnywhere);
    registerTabTeardown('Serial', stopDocDrops);
    renderList();
    // Fill in the "Previously allowed" ports once the browser answers; keeps the
    // first paint instant and non-blocking.
    refreshKnownPorts().then(renderList);
  }

  return {
    render, init, addConnection, addDemo, choosePort, useKnownPort, openConn, closeConn, removeConn, reopenConn,
    togglePause, clearLog, saveLog, toggleFlag, togglePlot, sendData, resync, openInPackets,
    setName, setSetting, setMode, setKind, renderList,
    // following a log file instead of a port
    setSource, setFromStart, chooseLog, readOnce, onFile, dragOver, dragLeave, drop, dropAnywhere, guardDragOver,
    stopFollow, followAgain, readNow, sniffKind,
    // for serial-radio.js, serial-ert.js and serial-sdr.js
    findConn: byId, list: () => conns.slice(), writeText, toggleDtr, logLine, toolbarButtons, statsHtml, logHtml, followHtml,
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

