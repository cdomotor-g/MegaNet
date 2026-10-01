// MegaNet — serial-sdr.js
//
//   SerialSdr   the Serial Monitor's RTL-SDR card: an RTL-SDR Blog V2, V3 or V4
//               on USB, tuned to an ALERT channel and decoding it off the air —
//               with the band drawn as it arrives: spectrum and noise floor,
//               waterfall, the channel's power and bursts over time, the FM
//               audio as a waveform and as a spectrum where the two AFSK tones
//               light up, the symbols of the last decode with its frames
//               boxed, and the ADC's histogram (gain is headroom, not SNR).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, announce and state; across to rtlsdr.js
// (the USB driver), alert-dsp.js (the decoder, run in a Worker built from its
// own source), serial-viz.js (the drawing), packets.js (MegaNet's station
// names) and serial.js (the card list) — all from inside functions, none at
// load.
//
// The card is not a serial port. It sits in serial.js's list so the tab has
// one place to add, show and remove a device, and everything else about it
// is here. Its pipeline:
//
//   dongle ──USB bulk──▶ this file ──postMessage (transferred)──▶ Worker
//     Worker: AlertDsp.Pipeline — channelise to 240 ksps, gate on the
//     channel's power, decode each burst; post spectrum, level, scope,
//     audio, burst and decode messages back ──▶ this file paints them.
//
// The demo is the same pipeline with the dongle replaced by AlertDsp's demo
// band (three real station addresses at three strengths, two interferers),
// generated and looped inside the worker; a loaded IQ file (u8, as rtl_sdr
// and this card's own Capture write it) replaces the dongle the same way.
// docs/serial-sdr.md is the person-facing guide, the hardware notes included.

const SerialSdr = (function () {
  const CFG_KEY = 'mn-sdr-defaults';
  const PRESETS = [[151.5, '151.500 MHz — ALERT (NSW, Qld)'], [151.125, '151.125 MHz'], [151.425, '151.425 MHz'], [169.4, '169.400 MHz']];
  const STEPS = [[-100000, '−100 k'], [-12500, '−12.5 k'], [12500, '+12.5 k'], [100000, '+100 k']];
  const FFTS = [1024, 2048, 4096];
  const MAX_READ = 300, MAX_BURST = 120, TIMELINE_S = 600;
  let usbHooked = false;

  function loadCfg() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) {}
    return Object.assign({
      model: 'auto', freq: 151500000, rate: 960000, gain: 296, autoGain: false, agc: false, ppm: 0, bias: false,
      direct: 'auto', format: 'BINARY', gate: true, squelch: 8, offsetHz: 0, audio: false, volume: 0.6, audioGate: true,
      fftSize: 2048, peakHold: true,
    }, d, { audio: false });
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign({}, c.cfg, { audio: false }))); } catch (_) {}
  }

  function create(id, name) {
    hookUsb();
    return {
      id, kind: 'sdr', name, phase: 'setup', usb: null, label: '', dev: null, info: null, tune: null, err: null,
      cfg: loadCfg(), worker: null, post: null, source: null, streaming: false, paused: false,
      spec: null, peak: null, floorDb: null, wf: null, wfLo: null, wfHi: null,
      scope: null, level: null, readings: [], bursts: [], power: [], trace: null, lastDecode: null,
      notes: [], rx: { bytes: 0, t0: 0, rate: 0, lastBytes: 0, lastT: 0 }, audio: null,
      paintPending: {}, raf: 0, knownList: [], replay: null, helpOpen: false,
    };
  }

  function conn(id) { const c = Serial.findConn(id); return c && c.kind === 'sdr' ? c : null; }

  function hookUsb() {
    if (usbHooked || typeof navigator === 'undefined' || !navigator.usb) return;
    usbHooked = true;
    navigator.usb.addEventListener('disconnect', e => {
      if (typeof Serial === 'undefined') return;
      Serial.list().filter(c => c.kind === 'sdr' && c.usb === e.device).forEach(c => {
        stopAll(c);
        c.phase = 'error';
        c.err = 'The stick was unplugged';
        note(c, 'The stick was unplugged. Re-plug it, then Reopen.', 'bad');
        announce(c.name + ' — RTL-SDR unplugged, stream stopped');
        Serial.renderList();
      });
    });
  }

  function note(c, text, kind) {
    c.notes = c.notes.filter(n => n.text !== text);    // the same note again is one note, newer
    c.notes.push({ t: Date.now(), text, kind: kind || '' });
    if (c.notes.length > 5) c.notes.shift();
    mark(c, 'notes');
  }

  // ── the worker ─────────────────────────────────────────────────────────────

  function startWorker(c) {
    stopWorker(c);
    const handle = m => onMsg(c, m);
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined') throw new Error('no Worker');
      const url = URL.createObjectURL(new Blob([AlertDsp.workerSource()], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = e => { if (e.data && e.data.type === 'ready') URL.revokeObjectURL(url); handle(e.data); };
      w.onerror = e => {
        note(c, 'The decoder worker failed (' + (e.message || 'error') + ') — decoding on the page instead.', 'warn');
        mainThread(c, handle);
      };
      c.worker = w;
      c.post = (m, tr) => w.postMessage(m, tr || []);
    } catch (_) {
      mainThread(c, handle);
    }
    configure(c);
  }

  // No Worker (a locked-down browser): the same pipeline on the page. Slower
  // to draw while a burst decodes, and otherwise the same.
  function mainThread(c, handle) {
    if (c.worker) { try { c.worker.terminate(); } catch (_) {} c.worker = null; }
    const p = new AlertDsp.Pipeline(m => handle(m));
    c.pipe = p;
    c.post = m => {
      if (m.type === 'iq') p.feed(new Uint8Array(m.buf));
      else if (m.type === 'config') p.configure(m.cfg);
      else if (m.type === 'reset') p.reset();
      else if (m.type === 'capture') p.capture(m.seconds);
      else if (m.type === 'decodeNow') p.decodeNow(m.seconds);
      else if (m.type === 'demo') p.demo(m.on);
    };
    configure(c);
  }

  function stopWorker(c) {
    if (c.pipe) { c.pipe.demo(false); c.pipe = null; }
    if (c.worker) { try { c.worker.terminate(); } catch (_) {} c.worker = null; }
    c.post = null;
  }

  function deviceRate(c) {
    if (c.source === 'demo') return AlertDsp.FS_IN;
    if (c.source === 'file') return c.replay ? c.replay.rate : AlertDsp.FS_IN;
    return c.dev && c.dev.rate ? Math.round(c.dev.rate) : c.cfg.rate;
  }

  function configure(c) {
    if (!c.post) return;
    const f = c.cfg;
    c.post({ type: 'config', cfg: {
      deviceRate: deviceRate(c), channelOffsetHz: c.source === 'demo' ? 0 : f.offsetHz, format: f.format,
      gate: f.gate, squelchDb: f.squelch, fftSize: f.fftSize, audio: !!f.audio,
    } });
  }

  function onMsg(c, m) {
    if (!m) return;
    switch (m.type) {
      case 'spectrum': onSpectrum(c, m); break;
      case 'level':
        c.level = m;
        c.power.push({ t: Date.now(), db: m.chDb, nf: m.nfDb, open: m.open });
        while (c.power.length && c.power[0].t < Date.now() - TIMELINE_S * 1000) c.power.shift();
        mark(c, 'chips', 'hist', 'timeline');
        break;
      case 'scope': c.scope = m; mark(c, 'scope'); break;
      case 'audio': if (c.audio && (!c.cfg.audioGate || (c.level && c.level.open))) playPcm(c, m.pcm, m.rate); break;
      case 'burst':
        c.bursts.push(Object.assign({ decoded: null }, m));
        if (c.bursts.length > MAX_BURST) c.bursts.shift();
        mark(c, 'timeline', 'chips');
        break;
      case 'decode': onDecode(c, m); break;
      case 'capture': saveCapture(c, m); break;
      case 'error': note(c, 'Decoder: ' + m.message, 'bad'); break;
      default: break;
    }
  }

  function onSpectrum(c, m) {
    if (c.paused) return;
    const now = Date.now();
    if (c.specAt) c.rowMs = c.rowMs ? c.rowMs + (now - c.specAt - c.rowMs) * 0.1 : now - c.specAt;
    c.specAt = now;
    c.spec = m.db;
    c.specRate = m.rate;
    c.floorDb = m.floorDb;
    if (!c.peak || c.peak.length !== m.db.length) c.peak = Float32Array.from(m.db);
    else for (let i = 0; i < m.db.length; i++) c.peak[i] = Math.max(c.peak[i] - 0.25, m.db[i]);
    pushWaterfall(c, m.db, m.floorDb);
    mark(c, 'spectrum', 'waterfall');
  }

  function stationName(id) {
    if (typeof Packets === 'undefined') return '';
    try { const s = Packets.stationName(id); return s && !s.none ? s.text : ''; } catch (_) { return ''; }
  }

  function onDecode(c, m) {
    c.lastDecode = { t: Date.now(), ms: m.ms, combos: m.combos, seconds: m.seconds, candidates: m.candidates || [], all: m.all, shadows: m.shadows || [] };
    if (m.trace && m.trace.frames && (m.trace.frames.length || !c.trace || !c.trace.frames.length)) c.trace = Object.assign({ t: Date.now() }, m.trace);
    const b = m.burst && c.bursts.slice().reverse().find(x => x.t === m.burst.t);
    if (b) b.decoded = m.readings.length > 0 || m.all > 0;
    const t = Date.now();
    m.readings.forEach(r => {
      c.readings.push(Object.assign({ t, name: stationName(r.sensorId), burst: m.burst }, r));
    });
    if (c.readings.length > MAX_READ) c.readings.splice(0, c.readings.length - MAX_READ);
    // To MegaNet, when the card is set to send (serial-ingest.js): timed by
    // arrival, and never from the demo band or a replayed capture.
    if (typeof SerialIngest !== 'undefined' && m.readings.length) {
      const ts = SerialIngest.arrival(c);
      SerialIngest.add(c, m.readings.map(r => ({ alert_id: r.sensorId, value_raw: r.value, ts, protocol: 'alert' })));
    }
    (m.shadows || []).forEach(s => note(c, 'Ignored ' + s.sensorId + ' = ' + s.value + ' (' + s.votes + ' votes): a bit-flip shadow of ' + s.of + '.', ''));
    mark(c, 'readings', 'trace', 'chips', 'timeline');
  }

  function saveCapture(c, m) {
    const mhz = (c.cfg.freq / 1e6).toFixed(4).replace('.', 'p');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([m.buf], { type: 'application/octet-stream' })),
      download: 'alert-' + mhz + 'MHz-' + (m.rate / 1000) + 'k-' + stamp + '.iq8',
    });
    a.click();
    URL.revokeObjectURL(a.href);
    announce('Saved ' + m.seconds.toFixed(1) + ' s of IQ at ' + (m.rate / 1000) + ' ksps');
  }

  // ── audio ──────────────────────────────────────────────────────────────────

  function audioOn(c) {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) { note(c, 'This browser has no Web Audio — nothing to listen with.', 'warn'); return false; }
    const ac = new Ctx();
    const gain = ac.createGain();
    gain.gain.value = c.cfg.volume;
    gain.connect(ac.destination);
    c.audio = { ac, gain, t: 0 };
    return true;
  }
  function audioOff(c) {
    if (c.audio) { try { c.audio.ac.close(); } catch (_) {} }
    c.audio = null;
  }
  function playPcm(c, pcm, rate) {
    const a = c.audio;
    if (!a) return;
    const buf = a.ac.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm, 0);
    const src = a.ac.createBufferSource();
    src.buffer = buf;
    src.connect(a.gain);
    const now = a.ac.currentTime;
    if (a.t < now + 0.03 || a.t > now + 0.8) a.t = now + 0.15;
    src.start(a.t);
    a.t += buf.duration;
  }

  // ── the dongle ─────────────────────────────────────────────────────────────

  // Windows is where a stick most often never reaches the chooser: one with no
  // WinUSB driver is not offered to the browser at all.
  function onWindows() {
    if (typeof navigator === 'undefined') return false;
    return /Windows/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent || '');
  }

  async function choose(id) {
    const c = conn(id);
    if (!c) return;
    if (!RtlSdr.supported()) { alert('WebUSB is not available in this browser. Use Chrome or Edge, over https or from localhost.'); return; }
    try {
      c.usb = await RtlSdr.request();
      c.label = RtlSdr.label(c.usb);
      c.err = null;
      c.helpOpen = false;
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        c.err = onWindows()
          ? 'No stick chosen. If the list was empty, or your stick was not in it, Windows is not offering it to the browser: '
            + 'it needs the WinUSB driver first. "Getting the stick to the browser" below has a one-click installer.'
          : 'No stick chosen. If the list was empty, the computer is not offering the stick to the browser — see "Getting the stick to the browser" below.';
        c.helpOpen = true;
      } else c.err = RtlSdr.describeOpenError(e);
    }
    Serial.renderList();
  }

  async function refreshKnown(c) {
    try { c.knownList = await RtlSdr.known(); } catch (_) { c.knownList = []; }
  }
  function useKnown(id, i) {
    const c = conn(id);
    if (!c || !c.knownList[i]) return;
    c.usb = c.knownList[i];
    c.label = RtlSdr.label(c.usb);
    c.err = null;
    Serial.renderList();
  }

  function setModel(id, v) { const c = conn(id); if (c) { c.cfg.model = v; saveCfg(c); Serial.renderList(); } }
  function setName(id, v) { const c = conn(id); if (c) c.name = v; }

  async function open(id) {
    const c = conn(id);
    if (!c || !c.usb) return;
    c.err = null;
    try {
      if (c.dev) { try { await c.dev.close(); } catch (_) {} }
      c.dev = new RtlSdr.Device(c.usb, msg => note(c, msg));
      c.info = await c.dev.open({ model: c.cfg.model, ppm: c.cfg.ppm });
      if (c.cfg.freq < c.info.minHz) c.cfg.freq = 151500000;
      await c.dev.setSampleRate(c.cfg.rate);
      c.dev.directMode = c.info.directSampling ? c.cfg.direct : 'off';
      c.tune = await c.dev.setFrequency(c.cfg.freq);
      await c.dev.setGain(c.cfg.autoGain ? null : c.cfg.gain);
      await c.dev.setAgc(c.cfg.agc);
      if (c.info.biasTee) await c.dev.setBiasTee(c.cfg.bias || c.info.forceBiasTee);
      c.source = 'usb';
      c.phase = 'open';
      resetDisplay(c);
      startWorker(c);
      await startStream(c);
      announce(c.name + ' — RTL-SDR open, streaming at ' + (c.cfg.freq / 1e6).toFixed(4) + ' MHz');
    } catch (e) {
      console.warn('[SerialSdr] open failed:', e);
      c.err = RtlSdr.describeOpenError(e);
      c.phase = c.phase === 'open' ? 'error' : 'setup';
      try { if (c.dev) await c.dev.close(); } catch (_) {}
      c.dev = null;
      stopWorker(c);
    }
    saveCfg(c);
    Serial.renderList();
  }

  async function startStream(c) {
    if (!c.dev) return;
    c.rx = { bytes: 0, t0: Date.now(), rate: 0, lastBytes: 0, lastT: Date.now() };
    await c.dev.start(u8 => {
      c.rx.bytes += u8.length;
      if (!c.post) return;
      const buf = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8.buffer : u8.slice().buffer;
      c.post({ type: 'iq', buf }, [buf]);
    }, {
      onError: e => {
        c.streaming = false;
        note(c, 'The USB stream stopped: ' + ((e && e.message) || e), 'bad');
        mark(c, 'chips');
      },
    });
    c.streaming = true;
    clearInterval(c.rxTimer);
    c.rxTimer = setInterval(() => {
      const now = Date.now();
      c.rx.rate = (c.rx.bytes - c.rx.lastBytes) / 2 / ((now - c.rx.lastT) / 1000);
      c.rx.lastBytes = c.rx.bytes; c.rx.lastT = now;
      mark(c, 'chips');
    }, 1000);
  }

  async function stream(id, on) {
    const c = conn(id);
    if (!c) return;
    try {
      if (c.source === 'usb' && c.dev) {
        if (on) await startStream(c); else { await c.dev.stop(); c.streaming = false; clearInterval(c.rxTimer); }
      } else if (c.source === 'demo') {
        c.streaming = !!on;
        if (c.post) c.post({ type: 'demo', on: !!on });
      } else if (c.source === 'file') {
        if (on) startReplay(c); else stopReplay(c);
      }
    } catch (e) { note(c, e.message, 'bad'); }
    Serial.renderList();
  }

  function stopAll(c) {
    clearInterval(c.rxTimer);
    stopReplay(c);
    audioOff(c);
    c.cfg.audio = false;
    if (c.dev) { const d = c.dev; c.dev = null; d.close().catch(() => {}); }
    stopWorker(c);
    c.streaming = false;
  }

  async function close(id) {
    const c = conn(id);
    if (!c) return;
    stopAll(c);
    c.phase = c.usb ? 'closed' : 'setup';
    announce(c.name + ' — RTL-SDR closed');
    Serial.renderList();
  }
  async function reopen(id) { const c = conn(id); if (c && c.usb) return open(id); }

  async function remove(c) { stopAll(c); }

  // ── controls ────────────────────────────────────────────────────────────────

  async function act(c, fn) {
    try { return await fn(); } catch (e) { note(c, e.message || String(e), 'bad'); return null; }
    finally { saveCfg(c); mark(c, 'chips', 'controls'); }
  }

  function setFreq(id) {
    const c = conn(id);
    const el = document.getElementById('sdr-freq-' + id);
    if (!c || !el) return;
    const mhz = parseFloat(el.value);
    if (!(mhz > 0)) { note(c, 'Frequency is a number in MHz, e.g. 151.5', 'warn'); return; }
    return tuneTo(c, Math.round(mhz * 1e6));
  }
  function nudge(id, hz) { const c = conn(id); if (c) return tuneTo(c, c.cfg.freq + hz); }
  function preset(id, v) { const c = conn(id); if (c && v) return tuneTo(c, Math.round(parseFloat(v) * 1e6)); }

  function tuneTo(c, hz) {
    const min = c.info ? c.info.minHz : 500000, max = c.info ? c.info.maxHz : 1766000000;
    if (hz < min || hz > max) { note(c, 'Out of this stick\'s range (' + (min / 1e6) + '–' + (max / 1e6) + ' MHz).', 'warn'); mark(c, 'controls'); return; }
    c.cfg.freq = hz;
    if (c.peak) c.peak = null;
    if (c.dev && c.source === 'usb') return act(c, async () => { c.tune = await c.dev.setFrequency(hz); });
    saveCfg(c); mark(c, 'chips', 'controls', 'spectrum');
  }

  function setRate(id, v) {
    const c = conn(id);
    if (!c) return;
    c.cfg.rate = +v;
    c.peak = null;
    if (c.dev && c.source === 'usb') {
      return act(c, async () => {
        const was = c.streaming;
        if (was) await c.dev.stop();
        await c.dev.setSampleRate(c.cfg.rate);
        resetDisplay(c);
        configure(c);
        if (was) await startStream(c);
      });
    }
    saveCfg(c);
  }

  function setGain(id, idx) {
    const c = conn(id);
    if (!c) return;
    c.cfg.gain = RtlSdr.GAINS[Math.max(0, Math.min(RtlSdr.GAINS.length - 1, +idx))];
    const ro = document.getElementById('sdr-gain-v-' + id);
    if (ro) ro.textContent = (c.cfg.gain / 10).toFixed(1) + ' dB';
    if (c.dev && !c.cfg.autoGain) return act(c, () => c.dev.setGain(c.cfg.gain));
    saveCfg(c);
  }
  function setAutoGain(id, on) {
    const c = conn(id);
    if (!c) return;
    c.cfg.autoGain = !!on;
    const sl = document.getElementById('sdr-gain-' + id);
    if (sl) sl.disabled = !!on;
    if (c.dev) return act(c, () => c.dev.setGain(on ? null : c.cfg.gain));
    saveCfg(c);
  }
  function setAgc(id, on) { const c = conn(id); if (!c) return; c.cfg.agc = !!on; if (c.dev) return act(c, () => c.dev.setAgc(!!on)); saveCfg(c); }
  function setPpm(id) {
    const c = conn(id), el = document.getElementById('sdr-ppm-' + id);
    if (!c || !el) return;
    c.cfg.ppm = Math.max(-200, Math.min(200, Math.round(+el.value || 0)));
    if (c.dev) return act(c, async () => { c.tune = await c.dev.setPpm(c.cfg.ppm) || c.tune; });
    saveCfg(c);
  }
  function setBias(id, on) {
    const c = conn(id);
    if (!c) return;
    if (on && !confirm('Turn the bias tee on? It puts 4.5 V on the antenna socket — for a powered LNA or active antenna. '
      + 'Never with an antenna or filter that shorts DC to ground.')) { mark(c, 'controls'); Serial.renderList(); return; }
    c.cfg.bias = !!on;
    if (c.dev) return act(c, async () => { await c.dev.setBiasTee(!!on); });
    saveCfg(c);
  }
  function setDirect(id, v) {
    const c = conn(id);
    if (!c) return;
    c.cfg.direct = v;
    if (c.dev) return act(c, async () => { c.tune = await c.dev.setDirectSampling(v) || c.tune; });
    saveCfg(c);
  }
  function setFormat(id, v) { const c = conn(id); if (!c) return; c.cfg.format = v; configure(c); saveCfg(c); mark(c, 'controls'); }
  function setGate(id, on) { const c = conn(id); if (!c) return; c.cfg.gate = !!on; configure(c); saveCfg(c); }
  function setSquelch(id, v) { const c = conn(id); if (!c) return; c.cfg.squelch = Math.max(2, Math.min(40, +v || 8)); configure(c); saveCfg(c); }
  function setOffsetKhz(id) {
    const c = conn(id), el = document.getElementById('sdr-off-' + id);
    if (!c || !el) return;
    setOffset(c, Math.round((+el.value || 0) * 1000));
  }
  function setOffset(c, hz) {
    const half = deviceRate(c) / 2 - 12000;
    c.cfg.offsetHz = c.source === 'demo' ? 0 : Math.max(-half, Math.min(half, hz));
    configure(c);
    saveCfg(c);
    mark(c, 'controls', 'spectrum', 'waterfall', 'chips');
  }
  // The spectrum is a shortcut for the channel-offset box and the frequency
  // box beside it (pattern 8): a click puts the decoder's channel there, a
  // shift-click retunes the dongle to centre on it.
  function clickSpectrum(id, ev) {
    const c = conn(id);
    const cv = document.getElementById('sdr-spec-' + id);
    if (!c || !cv || !ev) return;
    const rect = cv.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    const rate = deviceRate(c);
    const off = Math.round(((fx - 0.5) * rate) / 500) * 500;
    if (ev.shiftKey) tuneTo(c, Math.round((c.cfg.freq + off) / 500) * 500);
    else setOffset(c, off);
  }
  function setFft(id, v) { const c = conn(id); if (!c) return; c.cfg.fftSize = +v; c.peak = null; c.wf = null; configure(c); saveCfg(c); }
  function setPeak(id, on) { const c = conn(id); if (!c) return; c.cfg.peakHold = !!on; c.peak = null; saveCfg(c); }
  function setAudio(id, on) {
    const c = conn(id);
    if (!c) return;
    if (on && !audioOn(c)) on = false;
    if (!on) audioOff(c);
    c.cfg.audio = !!on;
    configure(c);
  }
  function setAudioGate(id, on) { const c = conn(id); if (c) { c.cfg.audioGate = !!on; saveCfg(c); } }
  function setVolume(id, v) {
    const c = conn(id);
    if (!c) return;
    c.cfg.volume = Math.max(0, Math.min(1, +v));
    if (c.audio) c.audio.gain.gain.value = c.cfg.volume;
    saveCfg(c);
  }
  function pause(id) { const c = conn(id); if (c) { c.paused = !c.paused; Serial.renderList(); } }
  function capture(id, secs) { const c = conn(id); if (c && c.post) c.post({ type: 'capture', seconds: secs || 3 }); }
  function decodeNow(id) { const c = conn(id); if (c && c.post) { c.post({ type: 'decodeNow', seconds: 3 }); note(c, 'Decoding the last 3 s…', ''); } }
  function clearReadings(id) { const c = conn(id); if (c) { c.readings = []; c.bursts = []; c.trace = null; mark(c, 'readings', 'trace', 'timeline', 'chips'); } }
  function exportReadings(id) {
    const c = conn(id);
    if (!c) return;
    const rows = ['time,sensor_id,value,station,votes,format,polarity,bytes,carrier_hz,burst_ms,burst_peak_dbfs'];
    c.readings.forEach(r => rows.push([new Date(r.t).toISOString(), r.sensorId, r.value, '"' + String(r.name || '').replace(/"/g, '""') + '"', r.votes, r.format,
      r.polarity, r.hex, r.carrierHz, r.burst ? r.burst.ms : '', r.burst ? r.burst.peakDb.toFixed(1) : ''].join(',')));
    dlText('sdr-readings-' + new Date().toISOString().slice(0, 10) + '.csv', rows.join('\n') + '\n');
  }

  // ── sources with no dongle: the demo band, an IQ file ──────────────────────

  function demo(c) {
    c.phase = 'demo';
    c.source = 'demo';
    c.label = 'Demo band — synthesised, no stick attached';
    c.info = { modelLabel: 'Demo', tuner: '—', minHz: 500000, maxHz: 1766000000, gains: RtlSdr.GAINS, biasTee: false, directSampling: false };
    c.cfg = Object.assign({}, c.cfg, { freq: 151500000, offsetHz: 0, format: 'BINARY', fftSize: 2048 });
    resetDisplay(c);
    startWorker(c);
    c.post({ type: 'demo', on: true });
    c.streaming = true;
    note(c, 'Demo: three ALERT stations (the Quansheng firmware\'s example addresses) at three strengths, and two other signals, looped every 12 s through the real decoder.', '');
    Serial.renderList();
  }

  // A recorded IQ file — u8 interleaved, as rtl_sdr writes it and as this
  // card's Capture saves it — played through the pipeline in real time.
  function loadFile(id, input) {
    const c = conn(id);
    const f = input && input.files && input.files[0];
    if (!c || !f) return;
    const rateEl = document.getElementById('sdr-file-rate-' + id);
    let rate = rateEl ? +rateEl.value : AlertDsp.FS_IN;
    const m = /(\d{3,4})k/i.exec(f.name);
    if (m && AlertDsp.DEVICE_RATES.indexOf(+m[1] * 1000) >= 0) rate = +m[1] * 1000;
    f.arrayBuffer().then(buf => {
      stopAll(c);
      c.replay = { buf: new Uint8Array(buf), pos: 0, rate, name: f.name };
      c.source = 'file';
      c.phase = 'demo';
      c.label = 'IQ file ' + f.name + ' · ' + (rate / 1000) + ' ksps';
      c.info = c.info || { modelLabel: 'IQ file', tuner: '—', minHz: 500000, maxHz: 1766000000, gains: RtlSdr.GAINS };
      resetDisplay(c);
      startWorker(c);
      startReplay(c);
      note(c, 'Playing ' + f.name + ' (' + (buf.byteLength / 2 / rate).toFixed(1) + ' s at ' + (rate / 1000) + ' ksps), looped.', '');
      Serial.renderList();
    }).catch(e => note(c, 'Could not read the file: ' + e.message, 'bad'));
  }
  function startReplay(c) {
    stopReplay(c);
    const r = c.replay;
    if (!r) return;
    configure(c);
    const chunk = Math.round(r.rate / 10) * 2;
    r.timer = setInterval(() => {
      if (!c.post) return;
      const end = Math.min(r.buf.length, r.pos + chunk);
      const part = r.buf.slice(r.pos, end);
      c.post({ type: 'iq', buf: part.buffer }, [part.buffer]);
      r.pos = end >= r.buf.length ? 0 : end;
    }, 100);
    c.streaming = true;
  }
  function stopReplay(c) { if (c.replay && c.replay.timer) { clearInterval(c.replay.timer); c.replay.timer = null; } c.streaming = false; }

  // ── painting ────────────────────────────────────────────────────────────────

  function resetDisplay(c) { c.spec = null; c.peak = null; c.wf = null; c.scope = null; c.level = null; c.power = []; }

  function mark(c) {
    for (let i = 1; i < arguments.length; i++) c.paintPending[arguments[i]] = true;
    if (c.raf) return;
    const run = () => { c.raf = 0; paint(c); };
    c.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  function paint(c) {
    const p = c.paintPending;
    c.paintPending = {};
    if (!document.getElementById('sdr-dash-' + c.id)) return;
    if (p.chips) paintChips(c);
    if (p.notes) paintNotes(c);
    if (p.controls) syncControls(c);
    if (p.spectrum) paintSpectrum(c);
    if (p.waterfall) paintWaterfall(c);
    if (p.timeline) paintTimeline(c);
    if (p.scope) { paintScope(c); paintTones(c); }
    if (p.trace) paintTrace(c);
    if (p.hist) paintHist(c);
    if (p.readings) paintReadings(c);
  }

  function mount(c) {
    ['chips', 'notes', 'controls', 'spectrum', 'waterfall', 'timeline', 'scope', 'trace', 'hist', 'readings'].forEach(k => { c.paintPending[k] = true; });
    if (c.phase === 'setup') {
      // re-render only when the list of allowed sticks actually changed, or
      // this would call itself for ever
      const before = c.knownList.length;
      refreshKnown(c).then(() => { if (c.knownList.length !== before && !c.usb) Serial.renderList(); });
      return;
    }
    paint(c);
    if (typeof SerialIngest !== 'undefined') SerialIngest.mount(c);
  }

  function fmtMHz(hz, dp) { return (hz / 1e6).toFixed(dp == null ? 4 : dp); }

  function chip(label, value, cls) {
    return '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(label) + '</span><span class="qs-chip-v">' + value + '</span></div>';
  }

  function paintChips(c) {
    const el = document.getElementById('sdr-chips-' + c.id);
    if (!el) return;
    const i = c.info || {}, lv = c.level, chips = [];
    chips.push(chip('Device', esc(i.modelLabel || '—') + (i.tuner && i.tuner !== '—' ? ' · ' + esc(i.tuner) : '')));
    const chan = c.cfg.freq + (c.source === 'demo' ? 0 : c.cfg.offsetHz);
    chips.push(chip('Channel', fmtMHz(chan) + ' MHz' + (c.cfg.offsetHz && c.source !== 'demo' ? ' (' + (c.cfg.offsetHz > 0 ? '+' : '') + (c.cfg.offsetHz / 1000) + ' kHz)' : '')));
    if (c.tune) chips.push(chip('Tuned', esc(c.tune.mode) + (c.tune.errorHz ? ' · ' + (c.tune.errorHz > 0 ? '+' : '') + c.tune.errorHz + ' Hz' : ''), Math.abs(c.tune.errorHz || 0) > 2000 ? 'warn' : ''));
    const rate = deviceRate(c);
    const got = c.source === 'usb' && c.rx.rate ? ' · ' + (c.rx.rate / 1000).toFixed(0) + 'k/s in' : '';
    const short = c.source === 'usb' && c.rx.rate && c.rx.rate < rate * 0.95;
    chips.push(chip('Rate', (rate / 1000) + ' ksps' + got, short ? 'warn' : ''));
    if (lv) {
      chips.push(chip('ADC', lv.dbfs.toFixed(1) + ' dBFS · clip ' + lv.clipPct.toFixed(2) + '%', lv.clipPct > 0.5 ? 'bad' : lv.clipPct > 0.05 ? 'warn' : ''));
      chips.push(chip('Channel power', (lv.chDb > -150 ? lv.chDb.toFixed(1) : '—') + (lv.nfDb != null ? ' · floor ' + lv.nfDb.toFixed(1) : '') + ' dBFS'));
      chips.push(chip('Gate', '<span class="qs-led' + (lv.open ? ' on' : '') + '" aria-hidden="true"></span>' + (lv.open ? 'open' : 'closed') + ' · ' + c.cfg.squelch + ' dB'));
    }
    const nd = c.readings.length, nb = c.bursts.length;
    chips.push(chip('Heard', nb + ' burst' + (nb === 1 ? '' : 's') + ' · ' + nd + ' reading' + (nd === 1 ? '' : 's')));
    if (c.lastDecode) chips.push(chip('Last decode', c.lastDecode.ms + ' ms · ' + c.lastDecode.combos + ' combos · ' + c.lastDecode.seconds.toFixed(1) + ' s window'));
    chips.push(chip('Stream', c.streaming ? (c.paused ? 'paused display' : 'running') : 'stopped', c.streaming ? '' : 'warn'));
    el.innerHTML = chips.join('');
  }

  function paintNotes(c) {
    const el = document.getElementById('sdr-notes-' + c.id);
    if (!el) return;
    el.innerHTML = c.notes.map(n => '<p class="qs-note ' + (n.kind === 'bad' ? 'txt-bad' : n.kind === 'warn' ? 'txt-warn' : '') + '"><span class="ser-ts">'
      + SerialViz.hhmm(n.t, true) + '</span> ' + esc(n.text) + '</p>').join('');
  }

  function syncControls(c) {
    const f = c.cfg, id = c.id;
    const set = (k, v) => { const el = document.getElementById(k); if (el && document.activeElement !== el) el.value = v; };
    set('sdr-freq-' + id, fmtMHz(f.freq, 4));
    set('sdr-off-' + id, String(f.offsetHz / 1000));
    const hint = document.getElementById('sdr-fmt-hint-' + id);
    const fmt = AlertDsp.FORMATS.find(x => x.key === f.format);
    if (hint && fmt) hint.textContent = fmt.hint;
  }

  // dB range for the spectrum: a little below the floor to a little above the
  // strongest thing seen, at least 50 dB tall.
  function range(c) {
    const fl = c.floorDb != null ? c.floorDb : -60;
    let mx = fl + 40;
    const src = c.peak || c.spec;
    if (src) for (let i = 0; i < src.length; i++) if (src[i] > mx) mx = src[i];
    const lo = Math.floor((fl - 8) / 10) * 10, hi = Math.max(lo + 50, Math.ceil((mx + 6) / 10) * 10);
    return [lo, Math.min(10, hi)];
  }

  function freqTicks(ctx, c, x0, w, y, dpr, col) {
    const rate = deviceRate(c), f0 = c.cfg.freq - rate / 2;
    const step = rate <= 300000 ? 50000 : rate <= 1000000 ? 100000 : rate <= 2000000 ? 250000 : 500000;
    ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    for (let f = Math.ceil(f0 / step) * step; f <= f0 + rate; f += step) {
      const x = x0 + (f - f0) / rate * w;
      ctx.strokeStyle = SerialViz.alpha(col.border, 0.8); ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillText(fmtMHz(f, step < 100000 ? 3 : 2), x, y + 2 * dpr);
    }
  }

  function channelBand(ctx, c, x0, w, h, dpr, col, label) {
    const rate = deviceRate(c);
    const off = c.source === 'demo' ? 0 : c.cfg.offsetHz;
    const xc = x0 + (0.5 + off / rate) * w, hw = 6000 / rate * w;
    ctx.fillStyle = SerialViz.alpha(col.ok, 0.12);
    ctx.fillRect(xc - hw, 0, Math.max(2 * dpr, 2 * hw), h);
    ctx.strokeStyle = SerialViz.alpha(col.ok, 0.9); ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(xc, 0); ctx.lineTo(xc, h); ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = col.ok; ctx.textAlign = xc > x0 + w - 80 * dpr ? 'right' : 'left'; ctx.textBaseline = 'top';
      ctx.fillText('ALERT channel', xc + (ctx.textAlign === 'left' ? 4 : -4) * dpr, 4 * dpr);
    }
  }

  function paintSpectrum(c) {
    const cv = document.getElementById('sdr-spec-' + c.id);
    const f = SerialViz.fit(cv, 200);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    const gx = 40 * dpr, ax = 16 * dpr, pw = w - gx - 4 * dpr, ph = h - ax - 4 * dpr;
    const [lo, hi] = range(c);
    SerialViz.dbGrid(ctx, gx, 4 * dpr, pw, ph, lo, hi, 10, dpr, col);
    ctx.save(); ctx.translate(gx, 0);
    freqTicks(ctx, c, 0, pw, ph + 4 * dpr, dpr, col);
    channelBand(ctx, c, 0, pw, ph + 4 * dpr, dpr, col, true);
    ctx.restore();
    const spec = c.spec;
    if (!spec) {
      ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.streaming ? 'Waiting for samples…' : 'Stream stopped', gx + pw / 2, ph / 2);
      cv.setAttribute('aria-label', 'Spectrum: no samples yet.');
      return;
    }
    const n = spec.length;
    const Y = v => 4 * dpr + ph - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * ph;
    const cols = Math.max(1, Math.floor(pw / dpr));
    const colMax = (arr, k) => {
      const a = Math.floor(k * n / cols), b = Math.max(a + 1, Math.floor((k + 1) * n / cols));
      let m = -999;
      for (let i = a; i < b; i++) if (arr[i] > m) m = arr[i];
      return m;
    };
    // filled trace
    const grad = ctx.createLinearGradient(0, 4 * dpr, 0, 4 * dpr + ph);
    grad.addColorStop(0, SerialViz.alpha(col.accent, 0.45));
    grad.addColorStop(1, SerialViz.alpha(col.accent, 0.04));
    ctx.beginPath();
    ctx.moveTo(gx, 4 * dpr + ph);
    for (let k = 0; k < cols; k++) ctx.lineTo(gx + k * pw / cols, Y(colMax(spec, k)));
    ctx.lineTo(gx + pw, 4 * dpr + ph);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < cols; k++) { const x = gx + k * pw / cols, y = Y(colMax(spec, k)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = col.accent; ctx.lineWidth = 1.2 * dpr; ctx.stroke();
    // peak hold
    if (c.cfg.peakHold && c.peak) {
      ctx.beginPath();
      for (let k = 0; k < cols; k++) { const x = gx + k * pw / cols, y = Y(colMax(c.peak, k)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = SerialViz.alpha(col.warn, 0.7); ctx.lineWidth = dpr; ctx.stroke();
    }
    // noise floor
    if (c.floorDb != null) {
      const y = Y(c.floorDb);
      ctx.strokeStyle = col.muted; ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + pw, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('floor ' + c.floorDb.toFixed(1) + ' dB', gx + pw - 4 * dpr, y - 2 * dpr);
    }
    let pk = -999, pki = 0;
    for (let i = 0; i < n; i++) if (spec[i] > pk) { pk = spec[i]; pki = i; }
    const pkHz = c.cfg.freq + (pki / n - 0.5) * deviceRate(c);
    cv.setAttribute('aria-label', 'Spectrum, ' + fmtMHz(c.cfg.freq) + ' MHz ± ' + (deviceRate(c) / 2000) + ' kHz: noise floor '
      + (c.floorDb != null ? c.floorDb.toFixed(0) : '?') + ' dB, strongest signal ' + pk.toFixed(0) + ' dB at ' + fmtMHz(pkHz) + ' MHz. '
      + 'Click to put the decoder\'s channel there (the Channel offset box does the same).');
  }

  function pushWaterfall(c, db, floorDb) {
    const W = Math.min(1024, db.length), H = 180;
    if (typeof document === 'undefined') return;
    if (!c.wf || c.wf.width !== W) {
      c.wf = document.createElement('canvas');
      c.wf.width = W; c.wf.height = H;
      const x = c.wf.getContext('2d');
      x.fillStyle = '#060a20'; x.fillRect(0, 0, W, H);
      c.wfRow = x.createImageData(W, 1);
    }
    // the colour range follows the floor slowly, so the picture does not flicker
    const lo = floorDb - 4, hi = floorDb + 46;
    c.wfLo = c.wfLo == null ? lo : c.wfLo + (lo - c.wfLo) * 0.05;
    c.wfHi = c.wfHi == null ? hi : c.wfHi + (hi - c.wfHi) * 0.05;
    const ctx = c.wf.getContext('2d');
    ctx.drawImage(c.wf, 0, 0, W, H - 1, 0, 1, W, H - 1);
    const lut = SerialViz.heat(), row = new Uint32Array(c.wfRow.data.buffer), n = db.length, span = c.wfHi - c.wfLo;
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x * n / W), b = Math.max(a + 1, Math.floor((x + 1) * n / W));
      let m = -999;
      for (let i = a; i < b; i++) if (db[i] > m) m = db[i];
      row[x] = lut[Math.max(0, Math.min(255, Math.round((m - c.wfLo) / span * 255)))];
    }
    ctx.putImageData(c.wfRow, 0, 0);
  }

  function paintWaterfall(c) {
    const cv = document.getElementById('sdr-wf-' + c.id);
    const f = SerialViz.fit(cv, 180);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    const gx = 40 * dpr, pw = w - gx - 4 * dpr;
    ctx.fillStyle = col.subtle; ctx.fillRect(0, 0, w, h);
    if (c.wf) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c.wf, 0, 0, c.wf.width, c.wf.height, gx, 0, pw, h);
    }
    ctx.save(); ctx.translate(gx, 0);
    channelBand(ctx, c, 0, pw, h, dpr, col, false);
    ctx.restore();
    ctx.fillStyle = col.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('now', gx - 4 * dpr, 2 * dpr);
    ctx.textBaseline = 'bottom';
    const span = Math.round(180 * (c.rowMs || 50) / 1000);
    ctx.fillText('−' + span + ' s', gx - 4 * dpr, h - 2 * dpr);
    cv.setAttribute('aria-label', 'Waterfall: the spectrum over the last ' + span + ' seconds, newest at the top; '
      + 'bright is strong. ALERT bursts show as short bright blocks on the channel line.');
  }

  // Channel power and every burst over the last ten minutes — the radio
  // card's Signal chart, for the dongle.
  function paintTimeline(c) {
    const cv = document.getElementById('sdr-time-' + c.id);
    const f = SerialViz.fit(cv, 130);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    const now = Date.now(), t0 = now - TIMELINE_S * 1000;
    const top = 16 * dpr, gx = 40 * dpr, gy = 14 * dpr, pw = w - gx - 6 * dpr, ph = h - gy - top;
    const pts = c.power.filter(p => p.db > -150);
    let lo = -70, hi = -10;
    if (pts.length) {
      const vals = pts.map(p => p.db).concat(c.bursts.map(b => b.peakDb));
      lo = Math.floor((Math.min.apply(null, vals) - 5) / 10) * 10;
      hi = Math.max(lo + 30, Math.ceil((Math.max.apply(null, vals) + 3) / 10) * 10);
    }
    const X = t => gx + (t - t0) / (now - t0) * pw, Y = v => top + ph - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * ph;
    SerialViz.dbGrid(ctx, gx, top, pw, ph, lo, hi, 10, dpr, col);
    ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = Math.ceil(t0 / 120000) * 120000; t <= now; t += 120000) ctx.fillText(SerialViz.hhmm(t), X(t), h - gy + 2 * dpr);
    if (pts.length > 1) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.db)) : ctx.moveTo(X(p.t), Y(p.db))));
      ctx.strokeStyle = SerialViz.alpha(col.text, 0.35); ctx.lineWidth = dpr; ctx.stroke();
      ctx.beginPath();
      pts.filter(p => p.nf != null).forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.nf)) : ctx.moveTo(X(p.t), Y(p.nf))));
      ctx.strokeStyle = col.muted; ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
    c.bursts.filter(b => b.t >= t0).forEach(b => {
      const x = X(b.t), color = b.decoded ? col.ok : b.decoded === false ? col.warn : col.accent;
      ctx.strokeStyle = SerialViz.alpha(color, 0.7); ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x, Y(b.nfDb)); ctx.lineTo(x, Y(b.peakDb)); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, Y(b.peakDb), 3 * dpr, 0, 7); ctx.fill();
    });
    ctx.fillStyle = col.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('dBFS', 4 * dpr, 0);
    const dec = c.bursts.filter(b => b.t >= t0 && b.decoded).length;
    cv.setAttribute('aria-label', 'Channel power over the last ten minutes, with ' + c.bursts.filter(b => b.t >= t0).length + ' bursts, ' + dec + ' decoded.');
  }

  // The FM discriminator's output: audio, in Hz of deviation. A burst shows
  // as the two AFSK tones; between bursts it is FM noise.
  function paintScope(c) {
    const cv = document.getElementById('sdr-scope-' + c.id);
    const f = SerialViz.fit(cv, 120);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = col.border; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    const s = c.scope;
    if (!s || !s.audio) { cv.setAttribute('aria-label', 'FM audio: none yet.'); return; }
    const a = s.audio, n = a.length, full = 6000;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * w, y = h / 2 - Math.max(-1, Math.min(1, a[i] / full)) * (h / 2 - 3 * dpr);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = s.open ? col.ok : SerialViz.alpha(col.text, 0.45); ctx.lineWidth = 1.2 * dpr; ctx.stroke();
    ctx.fillStyle = col.muted; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('±6 kHz · ' + Math.round(n / s.rate * 1000) + ' ms', 4 * dpr, 2 * dpr);
    cv.setAttribute('aria-label', 'FM audio waveform, the last ' + Math.round(n / s.rate * 1000) + ' ms' + (s.open ? ', during a burst.' : ', no burst.'));
  }

  // The audio's spectrum, 0–6 kHz, with the mark and space tones marked, and
  // how far each stands above a reference bin where neither is.
  function paintTones(c) {
    const cv = document.getElementById('sdr-tones-' + c.id);
    const f = SerialViz.fit(cv, 120);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    const s = c.scope;
    const out = document.getElementById('sdr-tones-v-' + c.id);
    if (!s || !s.aspec) { cv.setAttribute('aria-label', 'Audio spectrum: none yet.'); if (out) out.textContent = ''; return; }
    const a = s.aspec, n = a.length;
    let lo = 999, hi = -999;
    for (let i = 1; i < n; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    lo = Math.max(lo, hi - 60);
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, (a[i] - lo) / Math.max(1, hi - lo));
      ctx.fillStyle = SerialViz.alpha(col.accent, 0.35 + 0.5 * v);
      ctx.fillRect(i * bw, h - v * (h - 14 * dpr), Math.max(1, bw - 0.5), v * (h - 14 * dpr));
    }
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    [[AlertDsp.AFSK_F1, 'mark', col.ok, 'right'], [AlertDsp.AFSK_F2, 'space', col.warn, 'left']].forEach(([hz, lab, color, align]) => {
      const x = hz / 6000 * w;
      ctx.strokeStyle = color; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, 12 * dpr); ctx.lineTo(x, h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(lab, x + (align === 'left' ? 3 : -3) * dpr, 0);
    });
    const dbr = (p, r) => 10 * Math.log10((p + 1e-12) / (r + 1e-12));
    const m = dbr(s.mark, s.ref), sp = dbr(s.space, s.ref);
    if (out) out.textContent = 'mark ' + (m > 0 ? '+' : '') + m.toFixed(0) + ' dB · space ' + (sp > 0 ? '+' : '') + sp.toFixed(0) + ' dB over the 3.6 kHz reference';
    cv.setAttribute('aria-label', 'Audio spectrum 0 to 6 kHz: mark tone ' + m.toFixed(0) + ' dB and space tone ' + sp.toFixed(0) + ' dB over a reference.');
  }

  // The symbol stream the last decode read its frames from: one bar a symbol,
  // up for mark, down for space, each decoded frame boxed with its reading.
  function paintTrace(c) {
    const cv = document.getElementById('sdr-trace-' + c.id);
    const f = SerialViz.fit(cv, 110);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    const t = c.trace;
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    if (!t || !t.symbols || !t.symbols.length) {
      ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No decode yet — the next burst\'s symbols appear here.', w / 2, h / 2);
      cv.setAttribute('aria-label', 'Decoded symbols: none yet.');
      return;
    }
    let a = 0, b = t.symbols.length;
    if (t.frames.length) {
      a = Math.max(0, Math.min.apply(null, t.frames.map(x => x.pos)) - 30);
      b = Math.min(t.symbols.length, Math.max.apply(null, t.frames.map(x => x.pos)) + 70);
    }
    const n = b - a, bw = w / n, mid = h / 2 + 6 * dpr, amp = h / 2 - 16 * dpr;
    for (let i = 0; i < n; i++) {
      const v = Math.max(-3, Math.min(3, t.symbols[a + i])) / 3;
      ctx.fillStyle = v > 0 ? SerialViz.alpha(col.accent, 0.85) : SerialViz.alpha(col.muted, 0.6);
      ctx.fillRect(i * bw, v > 0 ? mid - v * amp : mid, Math.max(1, bw - 0.6 * dpr), Math.abs(v) * amp);
    }
    ctx.strokeStyle = col.border; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    t.frames.forEach(fr => {
      const x = (fr.pos - a) * bw;
      ctx.strokeStyle = col.ok; ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x, 14 * dpr, 40 * bw, h - 16 * dpr);
      for (let k = 1; k < 4; k++) {
        ctx.strokeStyle = SerialViz.alpha(col.ok, 0.4); ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(x + k * 10 * bw, 14 * dpr); ctx.lineTo(x + k * 10 * bw, h - 2 * dpr); ctx.stroke();
      }
      ctx.fillStyle = col.ok; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(fr.sensorId + ' = ' + fr.value + (fr.inv ? ' (inv)' : ''), x + 2 * dpr, 1 * dpr);
    });
    cv.setAttribute('aria-label', 'Decoded symbols of the last burst, ' + n + ' symbols' + (t.frames.length ? ', frames '
      + t.frames.map(x => x.sensorId + ' = ' + x.value).join(', ') : ', no frame') + '. Up is mark, down is space; each frame is four 10-bit bytes.');
  }

  // Where the ADC's samples fall. A healthy picture is a hump in the middle;
  // samples piling into the end bins are clipping — turn the gain down. Gain
  // here buys headroom, not SNR (HANDOVER §4: 40, 44.5 and 49.6 dB of gain
  // gave 17.5, 16.7 and 17.8 dB of SNR on the same signal).
  function paintHist(c) {
    const cv = document.getElementById('sdr-hist-' + c.id);
    const f = SerialViz.fit(cv, 120);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    const lv = c.level;
    if (!lv) { cv.setAttribute('aria-label', 'ADC histogram: no samples yet.'); return; }
    const hist = lv.hist, n = hist.length;
    let mx = 1;
    hist.forEach(v => { if (v > mx) mx = v; });
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.sqrt(hist[i] / mx);
      const edge = i === 0 || i === n - 1;
      ctx.fillStyle = edge && hist[i] ? col.bad : SerialViz.alpha(col.accent, 0.7);
      ctx.fillRect(i * bw + 0.5, h - 12 * dpr - v * (h - 16 * dpr), bw - 1, v * (h - 16 * dpr));
    }
    ctx.fillStyle = col.muted; ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left'; ctx.fillText('0', 2 * dpr, h);
    ctx.textAlign = 'right'; ctx.fillText('255', w - 2 * dpr, h);
    ctx.textAlign = 'center'; ctx.fillText(lv.dbfs.toFixed(1) + ' dBFS', w / 2, h);
    cv.setAttribute('aria-label', 'ADC sample histogram: level ' + lv.dbfs.toFixed(1) + ' dBFS, ' + lv.clipPct.toFixed(2) + '% of samples clipping.');
  }

  function paintReadings(c) {
    const tb = document.getElementById('sdr-read-' + c.id);
    if (!tb) return;
    const rows = c.readings.slice(-150).reverse();
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="qs-dim">No readings yet. Each frame the decoder accepts appears here.</td></tr>'; return; }
    tb.innerHTML = rows.map(r => '<tr><td>' + SerialViz.hhmm(r.t, true) + '</td>'
      + '<td class="qs-num">' + r.sensorId + '</td>'
      + '<td>' + (r.name ? esc(r.name) : '<span class="qs-dim">not in MegaNet</span>') + '</td>'
      + '<td class="qs-num">' + r.value + '</td>'
      + '<td class="qs-num">' + r.votes + '</td>'
      + '<td class="col-optional">' + esc((AlertDsp.FORMATS.find(x => x.key === r.format) || {}).label || r.format) + (r.polarity === 'NEG' ? ' · inverted' : '') + '</td>'
      + '<td class="qs-mono col-optional">' + esc(r.hex) + '</td>'
      + '<td class="qs-num col-optional">' + (r.burst ? r.burst.peakDb.toFixed(0) + ' dBFS' : '') + '</td></tr>').join('');
  }

  // ── the card ────────────────────────────────────────────────────────────────

  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  function statusBadge(c) {
    if (c.phase === 'demo') return '<span class="ser-badge ok">● ' + (c.source === 'file' ? 'file' : 'demo') + '</span>';
    if (c.phase === 'open') return '<span class="ser-badge ok">● live</span>';
    if (c.phase === 'closed') return '<span class="ser-badge">closed</span>';
    if (c.phase === 'error') return '<span class="ser-badge bad">● ' + esc(c.err || 'error') + '</span>';
    return '<span class="ser-badge warn">not opened</span>';
  }

  function setupBody(c) {
    const id = c.id, f = c.cfg;
    const M = RtlSdr.MODELS;
    const known = (!c.usb && c.knownList.length)
      ? '<div class="ser-known"><span class="ser-known-label">Previously allowed:</span> '
        + c.knownList.map((d, i) => '<button class="ghost" onclick="SerialSdr.useKnown(\'' + id + '\',' + i + ')">' + esc(RtlSdr.label(d)) + '</button>').join(' ') + '</div>'
      : '';
    const stick = c.usb
      ? '<span class="ser-port-ok">✓ ' + esc(c.label) + '</span> <button class="ghost" onclick="SerialSdr.choose(\'' + id + '\')">Change…</button>'
      : '<button class="ghost" onclick="SerialSdr.choose(\'' + id + '\')">Choose USB stick…</button>';
    return '<div class="ser-form">'
      + '<label class="ser-f-name">Name <input type="text" value="' + esc(c.name) + '" oninput="SerialSdr.setName(\'' + id + '\',this.value)"></label>'
      + '<div class="ser-f-port"><label>RTL-SDR stick</label><div class="ser-port-row">' + stick + '</div>' + known + '</div>'
      + '<label>Model <select onchange="SerialSdr.setModel(\'' + id + '\',this.value)">'
      + Object.keys(M).map(k => opt(k, M[k].label, f.model)).join('') + '</select></label>'
      + '</div>'
      + '<p class="ser-mode-note">' + esc(f.model !== 'auto' && M[f.model] ? M[f.model].note : 'The stick says what it is: a Blog V4 names itself "RTLSDRBlog / Blog V4" and has an R828D; '
        + 'a V3 has an R820T2. Pick a model only if detection gets it wrong.') + '</p>'
      + (c.err ? '<p class="ser-err">' + esc(c.err) + '</p>' : '')
      + '<details class="qs-ctl"' + (c.helpOpen ? ' open' : '') + '><summary>Getting the stick to the browser</summary>'
      + '<p class="qs-hint">The browser talks to the stick over WebUSB (Chrome or Edge, https or localhost), so the computer has to let go of it first — exactly as for rtl_sdr or SDR#:</p>'
      + '<ul class="qs-hint"><li><strong>Windows</strong>: a stick is in the browser\'s list only once it has the WinUSB driver (the step SDR# and rtl_tcp need too). '
      + '<a href="' + esc(RtlSdr.WINDOWS_INSTALLER) + '" download>Download the driver installer</a>, double-click it and say Yes to the admin prompt: '
      + 'it lists the sticks plugged in and gives WinUSB to any that lack it, with Windows\' own driver. It is a plain-text script, so the browser may ask '
      + 'you to keep it, and SmartScreen to choose <em>More info → Run anyway</em>. Then press <em>Choose USB stick…</em> again. '
      + 'By hand instead: Zadig, <em>Options → List All Devices</em>, WinUSB — a V3 or V4 is "Bulk-In, Interface (Interface 0)", '
      + 'a one-interface V2-era stick is "RTL2832U".</li>'
      + '<li><strong>Linux</strong>: the DVB-T TV driver grabs it — <code>sudo rmmod dvb_usb_rtl28xxu</code>, or blacklist it; and give your user access (a udev rule for 0bda:2838 and 0bda:2832).</li>'
      + '<li><strong>macOS</strong>: nothing to install.</li>'
      + '<li>Close anything else using the stick: rtl_tcp, SDR#, SDR++, GQRX, or this card in another tab.</li></ul>'
      + '<p class="qs-hint"><a href="docs/serial-sdr.md" target="_blank" rel="noopener">The RTL-SDR guide</a> has the details, and what the card does with each model.</p></details>'
      + '<div class="ser-actions">'
      + '<button class="primary" onclick="SerialSdr.open(\'' + id + '\')"' + (c.usb ? '' : ' disabled') + '>Open / Connect</button>'
      + '<button class="ghost" onclick="Serial.removeConn(\'' + id + '\')">Remove</button></div>';
  }

  function controlsHtml(c) {
    const id = c.id, f = c.cfg, i = c.info || {}, usb = c.source === 'usb';
    const dis = usb ? '' : ' disabled';
    const gIdx = Math.max(0, RtlSdr.GAINS.indexOf(f.gain));
    const btn = (label, fn, extra) => '<button type="button" class="ghost" onclick="SerialSdr.' + fn + '"' + (extra || '') + '>' + label + '</button>';
    return '<div class="sdr-ctl-grid">'
      // tuning
      + '<fieldset class="sdr-fs"><legend>Tuning</legend>'
      + '<div class="sdr-row"><label class="sdr-l">Frequency <span class="sdr-freq"><input type="number" step="0.0005" id="sdr-freq-' + id + '" value="' + fmtMHz(f.freq) + '"'
      + ' aria-label="Centre frequency in MHz" onkeydown="if(event.key===\'Enter\')SerialSdr.setFreq(\'' + id + '\')"' + dis + '> MHz</span></label>'
      + btn('Tune', 'setFreq(\'' + id + '\')', dis) + '</div>'
      + '<div class="sdr-row sdr-steps">' + STEPS.map(([hz, l]) => btn(l, 'nudge(\'' + id + '\',' + hz + ')', dis + ' aria-label="Tune ' + l + 'Hz"')).join('')
      + '<select aria-label="Frequency presets" onchange="SerialSdr.preset(\'' + id + '\',this.value);this.value=\'\'"' + dis + '><option value="">Presets…</option>'
      + PRESETS.map(([m, l]) => '<option value="' + m + '">' + esc(l) + '</option>').join('') + '</select></div>'
      + '<div class="sdr-row"><label class="sdr-l">Sample rate <select onchange="SerialSdr.setRate(\'' + id + '\',this.value)"' + dis + '>'
      + AlertDsp.DEVICE_RATES.map(r => opt(r, (r >= 1e6 ? (r / 1e6) + ' Msps' : (r / 1000) + ' ksps'), f.rate)).join('') + '</select></label></div>'
      + '<div class="sdr-row"><label class="sdr-l">PPM <input type="number" min="-200" max="200" step="1" id="sdr-ppm-' + id + '" value="' + f.ppm + '"'
      + ' onkeydown="if(event.key===\'Enter\')SerialSdr.setPpm(\'' + id + '\')"' + dis + '></label>' + btn('Set', 'setPpm(\'' + id + '\')', dis + ' aria-label="Set PPM correction"') + '</div>'
      + (i.directSampling ? '<div class="sdr-row"><label class="sdr-l">HF direct sampling <select onchange="SerialSdr.setDirect(\'' + id + '\',this.value)"' + dis + '>'
        + opt('auto', 'Auto (Q-branch below 24 MHz)', f.direct) + opt('off', 'Off', f.direct) + opt('q', 'Q-branch', f.direct) + opt('i', 'I-branch', f.direct) + '</select></label></div>' : '')
      + (i.upconverter ? '<p class="qs-hint">Below 28.8 MHz this V4 tunes through its built-in upconverter, on its HF input, automatically.</p>' : '')
      + '</fieldset>'
      // gain
      + '<fieldset class="sdr-fs"><legend>Gain</legend>'
      + '<div class="sdr-row"><label class="sdr-l">Tuner gain <input type="range" min="0" max="' + (RtlSdr.GAINS.length - 1) + '" step="1" value="' + gIdx + '" id="sdr-gain-' + id + '"'
      + ' oninput="SerialSdr.setGain(\'' + id + '\',this.value)"' + (f.autoGain || !usb ? ' disabled' : '') + '></label>'
      + '<span class="qs-readout" id="sdr-gain-v-' + id + '">' + (f.gain / 10).toFixed(1) + ' dB</span></div>'
      + '<div class="sdr-row"><label class="ser-check"><input type="checkbox"' + (f.autoGain ? ' checked' : '') + dis + ' onchange="SerialSdr.setAutoGain(\'' + id + '\',this.checked)"> tuner AGC</label>'
      + '<label class="ser-check"><input type="checkbox"' + (f.agc ? ' checked' : '') + dis + ' onchange="SerialSdr.setAgc(\'' + id + '\',this.checked)"> RTL AGC</label></div>'
      + (i.biasTee ? '<div class="sdr-row"><label class="ser-check"><input type="checkbox"' + ((c.dev && c.dev.biasTee) || f.bias ? ' checked' : '') + dis
        + (i.forceBiasTee ? ' disabled' : '') + ' onchange="SerialSdr.setBias(\'' + id + '\',this.checked)"> bias tee (4.5 V on the antenna)</label>'
        + (i.forceBiasTee ? '<span class="qs-small txt-warn">forced on by the stick\'s EEPROM</span>' : '') + '</div>' : '')
      + '<p class="qs-hint">Gain buys ADC headroom, not SNR: set it so the histogram\'s end bins stay empty.</p>'
      + '</fieldset>'
      // decoder
      + '<fieldset class="sdr-fs"><legend>Decoder</legend>'
      + '<div class="sdr-row"><label class="sdr-l">Frame format <select onchange="SerialSdr.setFormat(\'' + id + '\',this.value)">'
      + AlertDsp.FORMATS.map(x => opt(x.key, x.label, f.format)).join('') + '</select></label></div>'
      + '<p class="qs-hint" id="sdr-fmt-hint-' + id + '"></p>'
      + '<div class="sdr-row"><label class="sdr-l">Channel offset <span class="sdr-freq"><input type="number" step="0.5" id="sdr-off-' + id + '" value="' + (f.offsetHz / 1000) + '"'
      + ' aria-label="Decoder channel offset from the centre, kHz" onkeydown="if(event.key===\'Enter\')SerialSdr.setOffsetKhz(\'' + id + '\')"' + (c.source === 'demo' ? ' disabled' : '') + '> kHz</span></label>'
      + btn('Set', 'setOffsetKhz(\'' + id + '\')', (c.source === 'demo' ? ' disabled' : '') + ' aria-label="Set channel offset"') + '</div>'
      + '<div class="sdr-row"><label class="ser-check"><input type="checkbox"' + (f.gate ? ' checked' : '') + ' onchange="SerialSdr.setGate(\'' + id + '\',this.checked)"> decode bursts only</label>'
      + '<label class="sdr-l sdr-inline">gate <input type="number" min="2" max="40" step="1" value="' + f.squelch + '" aria-label="Gate threshold, dB over the channel floor"'
      + ' onchange="SerialSdr.setSquelch(\'' + id + '\',this.value)"> dB</label></div>'
      + '<p class="qs-hint">One format at a time, on purpose: Enhanced iFLOWS read from a strong Binary burst makes CRC-valid ghosts.</p>'
      + '</fieldset>'
      // listen & display
      + '<fieldset class="sdr-fs"><legend>Listen and display</legend>'
      + '<div class="sdr-row"><label class="ser-check"><input type="checkbox"' + (f.audio ? ' checked' : '') + ' onchange="SerialSdr.setAudio(\'' + id + '\',this.checked)"> listen</label>'
      + '<label class="ser-check"><input type="checkbox"' + (f.audioGate ? ' checked' : '') + ' onchange="SerialSdr.setAudioGate(\'' + id + '\',this.checked)"> only while the gate is open</label></div>'
      + '<div class="sdr-row"><label class="sdr-l">Volume <input type="range" min="0" max="1" step="0.05" value="' + f.volume + '" oninput="SerialSdr.setVolume(\'' + id + '\',this.value)"></label></div>'
      + '<div class="sdr-row"><label class="sdr-l">FFT <select onchange="SerialSdr.setFft(\'' + id + '\',this.value)">' + FFTS.map(n => opt(n, n + ' points', f.fftSize)).join('') + '</select></label>'
      + '<label class="ser-check"><input type="checkbox"' + (f.peakHold ? ' checked' : '') + ' onchange="SerialSdr.setPeak(\'' + id + '\',this.checked)"> peak hold</label></div>'
      + '</fieldset>'
      // a recording instead of the stick
      + '<fieldset class="sdr-fs"><legend>Replay a recording</legend>'
      + '<p class="qs-hint">8-bit unsigned I/Q, as rtl_sdr writes it and as Capture saves it. A rate in the name (e.g. "_960k") is used; otherwise the one below.</p>'
      + '<div class="sdr-row"><label class="sdr-l">Recorded at <select id="sdr-file-rate-' + id + '">'
      + AlertDsp.DEVICE_RATES.map(r => opt(r, (r >= 1e6 ? (r / 1e6) + ' Msps' : (r / 1000) + ' ksps'), AlertDsp.FS_IN)).join('') + '</select></label></div>'
      + '<div class="sdr-row sdr-file"><input type="file" accept=".iq8,.cu8,.bin,.raw,.iq" aria-label="IQ file to replay (8-bit unsigned I/Q)" onchange="SerialSdr.loadFile(\'' + id + '\',this)"></div>'
      + (c.source === 'file' && c.replay ? '<p class="qs-hint">Playing ' + esc(c.replay.name) + '.</p>' : '')
      + '</fieldset>'
      + '</div>';
  }

  function liveBody(c) {
    const id = c.id;
    const btn = (label, fn, extra) => '<button type="button" class="ghost" onclick="SerialSdr.' + fn + '"' + (extra || '') + '>' + label + '</button>';
    let tb = '<div class="ser-toolbar">';
    if (c.phase === 'open' || c.phase === 'demo') {
      tb += btn(c.streaming ? 'Stop stream' : 'Start stream', 'stream(\'' + id + '\',' + !c.streaming + ')');
      tb += btn(c.paused ? 'Resume display' : 'Pause display', 'pause(\'' + id + '\')');
      tb += btn('Decode last 3 s', 'decodeNow(\'' + id + '\')') + btn('Capture 3 s IQ', 'capture(\'' + id + '\',3)') + btn('Capture 10 s', 'capture(\'' + id + '\',10)');
      if (c.phase === 'open') tb += btn('Close', 'close(\'' + id + '\')');
    } else if (c.usb) tb += '<button class="primary" onclick="SerialSdr.reopen(\'' + id + '\')">Reopen</button>';
    tb += '<button class="ghost" onclick="Serial.removeConn(\'' + id + '\')">Remove</button>';
    tb += '</div>';
    return '<div class="sdr-dash" id="sdr-dash-' + id + '">' + tb
      + '<div class="qs-status" id="sdr-chips-' + id + '"></div>'
      + '<div class="qs-notes" id="sdr-notes-' + id + '"></div>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-spec-' + id + '"><div class="qs-panel-head"><h3 id="sdr-h-spec-' + id + '">Spectrum and waterfall</h3>'
      + '<span class="qs-small qs-dim">click to move the decoder\'s channel · shift-click to tune there</span></div>'
      + '<canvas class="qs-canvas sdr-spec" id="sdr-spec-' + id + '" role="img" aria-label="Spectrum" onclick="SerialSdr.clickSpectrum(\'' + id + '\',event)"></canvas>'
      + '<canvas class="qs-canvas sdr-wf" id="sdr-wf-' + id + '" role="img" aria-label="Waterfall"></canvas>'
      + '<div class="qs-legend"><span><i class="qs-sw sw-accent"></i>spectrum</span><span><i class="qs-sw sw-warn"></i>peak hold</span>'
      + '<span><i class="qs-sw sw-dash"></i>noise floor</span><span><i class="qs-sw sw-ok"></i>decoder channel (±6 kHz)</span></div></section>'
      + '<details class="qs-ctl sdr-controls" open><summary>Controls</summary>' + controlsHtml(c) + '</details>'
      + (typeof SerialIngest !== 'undefined' ? SerialIngest.panel(c) : '')
      + '<div class="sdr-mini">'
      + '<section class="qs-panel" aria-labelledby="sdr-h-time-' + id + '"><h3 id="sdr-h-time-' + id + '">Channel and bursts</h3>'
      + '<canvas class="qs-canvas" id="sdr-time-' + id + '" role="img" aria-label="Channel power"></canvas></section>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-scope-' + id + '"><h3 id="sdr-h-scope-' + id + '">FM audio</h3>'
      + '<canvas class="qs-canvas" id="sdr-scope-' + id + '" role="img" aria-label="FM audio waveform"></canvas></section>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-tones-' + id + '"><h3 id="sdr-h-tones-' + id + '">AFSK tones</h3>'
      + '<canvas class="qs-canvas" id="sdr-tones-' + id + '" role="img" aria-label="Audio spectrum"></canvas><p class="qs-small qs-dim" id="sdr-tones-v-' + id + '"></p></section>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-hist-' + id + '"><h3 id="sdr-h-hist-' + id + '">ADC</h3>'
      + '<canvas class="qs-canvas" id="sdr-hist-' + id + '" role="img" aria-label="ADC histogram"></canvas></section>'
      + '</div>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-trace-' + id + '"><h3 id="sdr-h-trace-' + id + '">Symbols of the last decode</h3>'
      + '<canvas class="qs-canvas" id="sdr-trace-' + id + '" role="img" aria-label="Decoded symbols"></canvas></section>'
      + '<section class="qs-panel" aria-labelledby="sdr-h-read-' + id + '"><div class="qs-panel-head"><h3 id="sdr-h-read-' + id + '">Readings</h3>'
      + '<span class="qs-head-actions">' + btn('Export CSV', 'exportReadings(\'' + id + '\')') + btn('Clear', 'clearReadings(\'' + id + '\')') + '</span></div>'
      + '<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="sdr-h-read-' + id + '"><table class="qs-table">'
      + '<caption class="sr-only">Readings decoded off the air, newest first</caption>'
      + '<colgroup><col style="width: 11%"><col style="width: 8%"><col style="width: 27%"><col style="width: 9%"><col style="width: 8%">'
      + '<col class="col-optional" style="width: 13%"><col class="col-optional" style="width: 14%"><col class="col-optional" style="width: 10%"></colgroup><thead><tr>'
      + '<th scope="col">Time</th><th scope="col">ID</th><th scope="col">Station</th><th scope="col">Value</th><th scope="col">Votes</th>'
      + '<th scope="col" class="col-optional">Format</th><th scope="col" class="col-optional">Bytes</th><th scope="col" class="col-optional">Peak</th></tr></thead>'
      + '<tbody id="sdr-read-' + id + '"></tbody></table></div>'
      + '<p class="qs-hint">Votes: in how many of the decoder\'s 45 carrier/timing combinations the frame turned up (4 is the bar). '
      + 'ALERT Binary has no checksum — a value is only as good as its votes; check the agency\'s own feed before acting on one.</p></section>'
      + '</div>';
  }

  function cardHtml(c) {
    return '<div class="panel ser-conn ser-sdr ser-' + (c.phase === 'demo' ? 'open' : c.phase) + '" id="ser-card-' + c.id + '">'
      + '<div class="ser-conn-head"><span class="ser-conn-name">' + esc(c.name) + '</span> ' + statusBadge(c)
      + ' <span class="ser-conn-port small">' + esc(c.label || 'RTL-SDR (USB)') + '</span></div>'
      + (c.phase === 'setup' ? setupBody(c) : liveBody(c))
      + '</div>';
  }

  return {
    create, cardHtml, mount, remove, demo,
    choose, useKnown, setModel, setName, open, close, reopen, stream,
    setFreq, nudge, preset, setRate, setGain, setAutoGain, setAgc, setPpm, setBias, setDirect,
    setFormat, setGate, setSquelch, setOffsetKhz, clickSpectrum, setFft, setPeak, setAudio, setAudioGate, setVolume,
    pause, capture, decodeNow, clearReadings, exportReadings, loadFile,
  };
})();
