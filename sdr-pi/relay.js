#!/usr/bin/env node
// MegaNet — sdr-pi/relay.js
//
//   The Raspberry Pi end of the SDR link (docs/sdr-pi.md). An RTL-SDR on this
//   computer, driven by MegaNet's own driver (rtlsdr.js) through node-usb's
//   WebUSB — the browser card's code, unchanged — decoded by MegaNet's own
//   decoder (alert-dsp.js) in a worker thread, one for each channel the stick
//   decodes at once (CHANNELS: every channel in the slice it hears, all from
//   the one stream), and what it finds printed on a serial port in the text
//   ../sdr-pi.js defines. PuTTY, on the PC at the other
//   end of the cable, logs that port; the Serial Monitor's RTL-SDR card follows
//   the log. Commands typed or pasted into PuTTY come back up the same cable and
//   set the stick.
//
// The serial port is the USB-C port of a Pi 4 or 5 made into a USB serial
// device (/dev/ttyGS0, usb-gadget.sh), or the GPIO UART with a USB-serial cable
// (/dev/serial0). Either way the PC sees a COM port and PuTTY opens it; the PC
// installs nothing and its browser needs neither Web Serial nor WebUSB.
//
// Run by systemd — install.sh puts meganet-sdr.service in place — or by hand:
//
//   node relay.js --stdio                           this terminal is the port
//   node relay.js --serial /dev/ttyGS0 --tcp 7355   PuTTY on Serial, or on Raw/Telnet
//   node relay.js --file rig_240k.iq8 --stdio --set fmt=EIF
//   node relay.js --stdio --set freq=151.85 --set rate=1920000 --set offset=-350 --set 'more=151.525;151.95/EIF;152.4'
//
// `node relay.js --help` lists the rest. Settings changed from the console are
// kept (--state) and survive a restart.

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const tty = require('tty');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const SdrPi = require(path.join(ROOT, 'sdr-pi.js'));
const RtlSdr = require(path.join(ROOT, 'rtlsdr.js'));

const STAT_MS = 10000;                // a hidden STAT, and the window title
const STAT_SHOWN_MS = 5 * 60000;      // a visible one, so PuTTY's window shows the Pi is alive
const HELLO_MS = 10 * 60000;          // SDRPI and FIELDS again, hidden, for a log joined late
const RETRY_MS = 3000;                // looking for a stick, or a serial port, again
const LAG_STOP_MS = 3000;             // the decoder this far behind: stop sending it samples…
const LAG_GO_MS = 1000;               // …until it is back within this
const AUTO_SERIAL = ['/dev/ttyGS0', '/dev/serial0'];
const BURSTS_KEPT = 64;

const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r3 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);

// ── options ──────────────────────────────────────────────────────────────────

const USAGE = `Flood-Net SDR Pi — an RTL-SDR decoding ALERT, on a serial port for PuTTY.

  --serial PATH|auto  talk on this serial port (repeatable). auto: ${AUTO_SERIAL.join(' and ')}
                      when present — the USB-C gadget and the GPIO UART
  --baud N            the UART's speed (default 115200; a USB gadget ignores it)
  --tcp PORT          also listen on TCP, for PuTTY's Raw or Telnet connection
  --tcp-host ADDR     address to listen on (default 0.0.0.0)
  --stdio             talk on this process's stdin and stdout
  --source usb|rtl_sdr|file
                      usb (default): rtlsdr.js through node-usb; rtl_sdr: the
                      librtlsdr tool's output; file: an IQ recording (--file)
  --file PATH         an 8-bit IQ recording to play instead of a stick
  --file-rate N       its sample rate (default: from a name like _960k, else 240000)
  --speed X           play it X times real time (0: as fast as it decodes)
  --loop              play it again and again
  --exit-after-file   stop once it has played and been decoded
  --set KEY=VALUE     a setting at start (repeatable), as the console's CFG takes it
  --state PATH        where settings are kept (default $STATE_DIRECTORY/settings.json,
                      else ~/.config/meganet-sdr/settings.json); "none" to keep nothing
  --stations PATH     Flood-Net's stations.json, to name stations (default ../stations.json)
  --rtl-sdr PATH      the rtl_sdr program for --source rtl_sdr (default rtl_sdr)
  --no-title          do not set the terminal's window title
  --help              this
`;

function parseArgs(argv) {
  const o = { serial: [], baud: 115200, tcp: null, tcpHost: '0.0.0.0', stdio: false, source: 'usb', file: null,
    fileRate: null, speed: 1, loop: false, exitAfterFile: false, set: {}, state: null, stations: null,
    rtlSdr: 'rtl_sdr', title: true, help: false };
  const want = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(flag + ' needs a value');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--serial': o.serial.push(want(i, a)); i++; break;
      case '--baud': o.baud = Number(want(i, a)); i++; break;
      case '--tcp': o.tcp = Number(want(i, a)); i++; break;
      case '--tcp-host': o.tcpHost = want(i, a); i++; break;
      case '--stdio': o.stdio = true; break;
      case '--source': o.source = want(i, a); i++; break;
      case '--file': o.file = want(i, a); o.source = 'file'; i++; break;
      case '--file-rate': o.fileRate = Number(want(i, a)); i++; break;
      case '--speed': o.speed = Number(want(i, a)); i++; break;
      case '--loop': o.loop = true; break;
      case '--exit-after-file': o.exitAfterFile = true; break;
      case '--set': {
        const kv = want(i, a); i++;
        const eq = kv.indexOf('=');
        const key = eq > 0 ? kv.slice(0, eq).toLowerCase() : '';
        const r = SdrPi.parseSetting(key, kv.slice(eq + 1));
        if (!r.ok) throw new Error('--set ' + kv + ': ' + r.error);
        o.set[key] = r.value;
        break;
      }
      case '--state': o.state = want(i, a); i++; break;
      case '--stations': o.stations = want(i, a); i++; break;
      case '--rtl-sdr': o.rtlSdr = want(i, a); i++; break;
      case '--no-title': o.title = false; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Unknown option ' + a + ' (--help lists them)');
    }
  }
  if (['usb', 'rtl_sdr', 'file'].indexOf(o.source) < 0) throw new Error('--source is usb, rtl_sdr or file');
  if (o.source === 'file' && !o.file) throw new Error('--source file needs --file PATH');
  if (!(o.baud > 0)) throw new Error('--baud needs a number');
  if (o.tcp != null && !(o.tcp >= 0 && o.tcp < 65536)) throw new Error('--tcp needs a port number');
  return o;
}

function defaultStatePath() {
  if (process.env.STATE_DIRECTORY) return path.join(process.env.STATE_DIRECTORY.split(':')[0], 'settings.json');
  return path.join(os.homedir(), '.config', 'meganet-sdr', 'settings.json');
}

// ── a connection: a serial port, a TCP client, or stdio ──────────────────────
//
// `io` is { write(text), pending() → bytes queued, echo, tcp, interrupt? }.
// Echo is the far end's: PuTTY on a serial line echoes nothing itself, so this
// echoes what it is sent and redraws a half-typed command under anything it
// prints meanwhile. A Raw TCP connection does its own (PuTTY's local echo is on
// for Raw); a Telnet one is asked to leave it to us.

class Link {
  constructor(relay, name, io) {
    this.relay = relay;
    this.name = name;
    this.io = io;
    this.echo = !!io.echo;
    this.inp = '';
    this.lastCr = false;
    this.esc = 0;
    this.iac = 0;
    this.telnet = false;
    this.dropped = 0;
  }

  // Nobody reading — a COM port PuTTY has not opened, a stalled client — must
  // not grow this process: hidden records go first, then everything.
  write(text, hidden) {
    const q = this.io.pending();
    if (q > 1048576 || (hidden && q > 65536)) { this.dropped += text.length; return; }
    this.io.write(text);
  }

  line(text) {
    if (this.echo && this.inp) this.write('\r\x1b[K' + text + '\r\n' + this.inp);
    else this.write(text + '\r\n');
  }

  // Telnet: IAC sequences are not input. The first one says the far end is a
  // Telnet client, which is asked to let this end echo, a character at a time.
  telnetByte(b) {
    if (this.iac === 0) {
      if (b !== 255) return false;
      this.iac = 1;
      if (!this.telnet) {
        this.telnet = true;
        this.echo = true;
        this.io.write('\xff\xfb\x01\xff\xfb\x03');     // IAC WILL ECHO, IAC WILL SUPPRESS-GO-AHEAD
      }
      return true;
    }
    if (this.iac === 1) {
      if (b === 255) { this.iac = 0; return false; }   // IAC IAC: a literal 0xff
      this.iac = b === 250 ? 3 : b >= 251 && b <= 254 ? 2 : 0;
      return true;
    }
    if (this.iac === 2) { this.iac = 0; return true; } // the option byte
    if (this.iac === 3) { if (b === 255) this.iac = 4; return true; }   // inside SB …
    if (this.iac === 4) { this.iac = b === 240 ? 0 : 3; return true; }  // … to IAC SE
    return false;
  }

  input(buf) {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (this.io.tcp && this.telnetByte(b)) continue;
      if (this.esc) {                                     // arrow keys and the like: not ours
        if (this.esc === 1) this.esc = b === 0x5b || b === 0x4f ? 2 : 0;
        else if (b >= 0x40 && b <= 0x7e) this.esc = 0;
        continue;
      }
      if (b === 0x0d || b === 0x0a) {
        if (b === 0x0a && this.lastCr) { this.lastCr = false; continue; }
        this.lastCr = b === 0x0d;
        const line = this.inp;
        this.inp = '';
        if (this.echo) this.io.write('\r\n');
        this.relay.command(this, line);
        continue;
      }
      this.lastCr = false;
      if (b === 0x00) continue;                           // Telnet's CR NUL
      if (b === 0x08 || b === 0x7f) {
        if (this.inp) { this.inp = this.inp.slice(0, -1); if (this.echo) this.io.write('\b \b'); }
        continue;
      }
      if (b === 0x03 && this.io.interrupt) { this.io.interrupt(); continue; }
      if (b === 0x03 || b === 0x15) {                     // Ctrl-C, Ctrl-U: start the line again
        if (this.inp && this.echo) this.io.write(b === 0x03 ? '^C\r\n' : '\r\x1b[K');
        this.inp = '';
        continue;
      }
      if (b === 0x1b) { this.esc = 1; continue; }
      if (b >= 0x20 && b < 0x7f && this.inp.length < 512) {
        this.inp += String.fromCharCode(b);
        if (this.echo) this.io.write(String.fromCharCode(b));
      }
    }
  }
}

// A serial port, read and written through Node's own TTY handle — non-blocking
// both ways, so a USB gadget whose PC is not reading can never stall this
// process (its writes queue, and Link.write stops adding to the queue). raw:
// no echo or CR/LF translation by the kernel; clocal: no waiting for a carrier.
function openSerial(devPath, baud, onData, onGone) {
  const fd = fs.openSync(devPath, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  // Set while this process holds the port open, so the settings stay put.
  try {
    execFileSync('stty', ['-F', devPath, String(baud), 'raw', '-echo', 'clocal', 'cread', '-crtscts', '-hupcl', 'cs8', '-cstopb', '-parenb'],
      { stdio: 'ignore' });
  } catch (e) {
    fs.closeSync(fd);
    throw new Error('stty could not set ' + devPath + ' up (' + e.message + ') - is it a serial port?');
  }
  const s = new tty.ReadStream(fd);
  let gone = false;
  const bye = e => { if (gone) return; gone = true; try { s.destroy(); } catch (_) {} onGone(e); };
  s.on('data', onData);
  s.on('error', bye);
  s.on('end', () => bye(null));
  return { write: t => s.write(t, 'latin1'), pending: () => s.writableLength || 0, echo: true, close: () => bye(null) };
}

// ── a channel's decoder ───────────────────────────────────────────────────────
//
// The stick hands over a slice of the band as wide as its sample rate, and each
// channel in it — the stick's own (freq + offset), then each of `more` — is
// decoded by alert-dsp.js's Pipeline in a thread of its own (dsp-worker.js),
// fed every sample the stick sends and set to that channel's offset. One
// stick, one stream, as many decoders as channels; a decode on one channel
// never holds up another. Each answers `ping` after everything sent before
// it, so each is held to its own lag: one falling behind has its samples
// dropped, not the rest.

class Decoder {
  constructor(relay, index) {
    this.relay = relay;
    this.index = index;               // 0: the stick's own channel
    this.ch = null;                   // { hz, fmt, offset }
    this.lag = { ms: 0, stopped: false };
    this.bursts = new Map();          // the decoder's burst time → the BURST it was sent as
    this.st = relay.blankLevel();     // since the last STAT
    this.last = null;                 // its last level
    this.counts = { bursts: 0, readings: 0 };
    this.start();
  }

  label() { return this.relay.decoders.length > 1 && this.ch ? ' for ' + SdrPi.mhzText(this.ch.hz) + ' MHz' : ''; }

  start() {
    const w = new Worker(path.join(__dirname, 'dsp-worker.js'), { workerData: { dsp: path.join(ROOT, 'alert-dsp.js') } });
    this.worker = w;
    w.on('message', m => this.relay.onDsp(this, m));
    w.on('error', e => {
      if (this.worker !== w) return;
      this.relay.note('bad', 'The decoder' + this.label() + ' stopped (' + e.message + ') - starting it again');
      this.worker = null;
      setTimeout(() => { if (!this.relay.stopping && !this.ended) { this.start(); this.configure(true); } }, 1000);
    });
  }

  // Tell it its channel and the settings. A channel moved under it starts
  // afresh: what it holds is another frequency's.
  configure(reset) {
    if (!this.worker || !this.ch) return;
    const s = this.relay.settings;
    if (reset) this.worker.postMessage({ type: 'reset' });
    // specHz 2: four FFTs averaged a post, eight a second — enough that a burst
    // never falls between them; SPEC sends the strongest of each bin, from the
    // stick's own channel's decoder (the slice is the same for every one).
    // scopeHz: the FM audio picture is not sent, so it is drawn as rarely as it can be.
    this.worker.postMessage({ type: 'config', cfg: {
      deviceRate: this.relay.deviceRate(), channelOffsetHz: this.ch.offset, format: SdrPi.FMT_KEY[this.ch.fmt],
      gate: s.gate, squelchDb: s.squelch, fftSize: 2048, specHz: this.index === 0 ? 2 : 0, scopeHz: 0.1, audio: false, minVotes: 4, minVotesCrc: 4,
    } });
  }

  // Samples — unless a live stick's are coming faster than it can take them,
  // when they are dropped (and counted) rather than queued without end. A
  // recording waits for it instead: it is not going anywhere.
  feed(u8) {
    if (!this.worker) return;
    if (this.lag.stopped && this.relay.opts.source !== 'file') { this.relay.counts.drops++; return; }
    const buf = u8.slice().buffer;                // a copy: a USB library's buffer is not ours to hand away
    this.worker.postMessage({ type: 'iq', buf }, [buf]);
  }

  ping(id) { if (this.worker) this.worker.postMessage({ type: 'ping', id, sent: performance.now() }); }

  // Resolves once it has decoded everything sent before.
  drained() {
    if (!this.worker) return Promise.resolve();
    return new Promise(resolve => {
      this.waits = (this.waits || []).concat([{ id: ++this.relay.lagId, resolve }]);
      this.ping(this.relay.lagId);
    });
  }

  pong(m) {
    this.lag.ms = performance.now() - m.sent;
    if (!this.lag.stopped && this.lag.ms > LAG_STOP_MS) {
      this.lag.stopped = true;
      this.relay.note('warn', 'The decoder' + this.label() + ' is ' + (this.lag.ms / 1000).toFixed(1) + ' s behind - dropping samples until it catches up. '
        + (this.relay.decoders.length > 1 ? 'Fewer channels, or a lower RATE, need less of the Pi.' : 'A lower RATE needs less of the Pi.'));
    } else if (this.lag.stopped && this.lag.ms < LAG_GO_MS) {
      this.lag.stopped = false;
      this.relay.note('info', 'The decoder' + this.label() + ' has caught up');
    }
    const w = (this.waits || []).find(x => x.id === m.id);
    if (w) { this.waits = this.waits.filter(x => x !== w); w.resolve(); }
  }

  end() {
    this.ended = true;
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate();
    (this.waits || []).forEach(x => x.resolve());
    this.waits = [];
  }
}

// ── the relay ─────────────────────────────────────────────────────────────────

class Relay {
  // deps (for the tests): { usb: { getDevices() }, out(line) }.
  constructor(opts, deps) {
    this.opts = opts;
    this.deps = deps || {};
    this.run = crypto.randomBytes(4).toString('hex');
    this.perf0 = performance.now();
    this.host = os.hostname();
    this.statePath = opts.state === 'none' ? null : opts.state || defaultStatePath();
    this.settings = Object.assign(SdrPi.defaults(), this.loadState(), opts.set || {});
    this.links = new Set();
    this.serials = new Map();
    this.clock = { mode: '', epoch0: 0, perf0: 0 };
    this.seq = { rx: 0, burst: 0 };
    this.counts = { bursts: 0, readings: 0, drops: 0 };
    this.lvl = this.blankLevel();
    this.stat = this.blankLevel();
    this.specMax = null;
    this.lastLevel = null;
    this.decoders = [];                   // one per channel, the stick's own first
    this.leftOut = '';                    // channels set that get no decoder (syncDecoders)
    this.lagId = 0;
    this.state = 'starting';
    this.info = null;
    this.stickLabel = '';
    this.tune = null;
    this.dev = null;
    this.proc = null;
    this.rx = { bytes: 0, lastBytes: 0, lastT: performance.now(), rate: 0 };
    this.cpu = { last: process.cpuUsage(), t: performance.now(), pct: null };
    this.timers = [];
    this.queue = Promise.resolve();
    this.names = new Map();
    this.stopping = false;
  }

  up() { return Math.round(performance.now() - this.perf0); }

  // The time, when there is one to stand behind: NTP has synchronised the
  // system clock, or TIME set it — counted on from then by the monotonic clock,
  // so an NTP step afterwards cannot move it. A Pi has no clock of its own
  // battery, and at work no network: neither, very often, until TIME.
  epoch() {
    if (this.clock.mode === 'ntp') return Date.now();
    if (this.clock.mode === 'set') return Math.round(this.clock.epoch0 + (performance.now() - this.clock.perf0));
    return null;
  }

  checkClock() {
    const synced = fs.existsSync('/run/systemd/timesync/synchronized');
    if (synced) this.clock = { mode: 'ntp', epoch0: 0, perf0: 0 };
    else if (this.clock.mode === 'ntp') this.clock = { mode: '', epoch0: 0, perf0: 0 };
  }

  // ── settings kept between runs ─────────────────────────────────────────────

  loadState() {
    if (!this.statePath) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const s = {};
      SdrPi.SETTING_KEYS.forEach(k => {
        if (!(k in raw)) return;
        const r = SdrPi.parseSetting(k, SdrPi.formatSetting(k, raw[k]));
        if (r.ok) s[k] = r.value;
      });
      return s;
    } catch (_) { return {}; }
  }

  saveState() {
    if (!this.statePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const tmp = this.statePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2) + '\n');
        fs.renameSync(tmp, this.statePath);
      } catch (e) { this.log('Could not keep the settings in ' + this.statePath + ': ' + e.message); }
    }, 300);
  }

  // MegaNet's station names, as the Quansheng radio's table has them: the same
  // rules, from the same file (quansheng.js), so the two receivers agree.
  loadNames() {
    const file = this.opts.stations || path.join(ROOT, 'stations.json');
    try {
      const Q = require(path.join(ROOT, 'quansheng.js'));
      const db = JSON.parse(fs.readFileSync(file, 'utf8'));
      const recs = Q.dedupe(Q.recordsFromStations(db.stations || [])).records;
      recs.forEach(r => this.names.set(r.aid, { name: r.name, kind: Q.KIND_CODE_LABEL[r.kind] || '' }));
    } catch (e) {
      this.log('No station names (' + file + ': ' + e.message + ')');
    }
  }

  log(text) { if (!this.deps.quiet) process.stderr.write('[meganet-sdr] ' + text + '\n'); }

  // ── output ──────────────────────────────────────────────────────────────────

  send(line) {
    for (const l of this.links) l.line(line);
    if (this.deps.out) this.deps.out(line, false);
  }
  sendHidden(line) {
    const s = SdrPi.hide(line);
    for (const l of this.links) l.write(s, true);
    if (this.deps.out) this.deps.out(line, true);
  }
  final(ok, detail) { this.send(ok ? (detail ? 'OK,' + SdrPi.clean(detail, 160) : 'OK') : 'ERR,' + SdrPi.clean(detail || 'FAILED', 160)); }

  note(level, text) {
    this.log(text);
    this.send(SdrPi.record('NOTE', { run: this.run, up: this.up(), epoch_ms: this.epoch(), level, text }));
  }

  channelHz() { return this.settings.freq + this.settings.offset; }

  // The channels the stick decodes: its own (freq + offset), then each of
  // `more`, with its offset from where the stick is tuned. A recording of one
  // channel is taken centred on it, so its offset is 0 there; one with more
  // channels is a slice of the band, and every offset counts.
  channelList(s) {
    s = s || this.settings;
    const file = this.opts.source === 'file', more = s.more || [];
    return [{ hz: s.freq + s.offset, fmt: s.fmt, offset: file && !more.length ? 0 : s.offset }]
      .concat(more.map(m => ({ hz: m.hz, fmt: m.fmt || s.fmt, offset: m.hz - s.freq })));
  }

  // "151.5000 MHz ALERT Binary", or "4 channels: 151.500 ABF; 151.525 ABF; …"
  // — no commas: a NOTE's text loses them. The channels decoded, once there
  // are decoders.
  channelsText() {
    const s = this.settings, list = this.decoders.length ? this.decoders.map(d => d.ch) : this.channelList();
    if (list.length === 1) return (s.freq / 1e6).toFixed(4) + ' MHz ' + SdrPi.FMT_LABEL[s.fmt];
    return list.length + ' channels: ' + list.map(ch => SdrPi.mhzText(ch.hz) + ' ' + ch.fmt).join('; ') + ' MHz';
  }

  banner() {
    return 'Flood-Net SDR Pi ' + SdrPi.VERSION + ' on ' + SdrPi.clean(this.host) + ' - '
      + (this.info ? SdrPi.clean(this.info.modelLabel) + ' ' + SdrPi.clean(this.info.tuner) : 'looking for a stick') + ' - '
      + this.channelsText() + ' - type HELP and press Enter';
  }

  helloRecords() {
    const i = this.info || {};
    return [SdrPi.kvRecord('SDRPI', {
      version: SdrPi.VERSION, schema: SdrPi.SCHEMA, run: this.run, host: this.host, source: this.opts.source,
      stick: this.stickLabel || null, model: i.modelLabel || null, tuner: i.tuner || null,
      min_hz: i.minHz || null, max_hz: i.maxHz || null, gains: i.gains ? i.gains.join(';') : null,
      bias_tee: i.biasTee != null ? !!i.biasTee : null, direct: i.directSampling != null ? !!i.directSampling : null,
      upconverter: i.upconverter != null ? !!i.upconverter : null, node: process.version,
    })].concat(SdrPi.fieldsRecords());
  }

  // To one link (a TCP client that just connected) or to all; shown or hidden.
  hello(link, hidden) {
    const lines = this.helloRecords().concat([SdrPi.cfgRecord(this.settings)]);
    if (hidden) { lines.forEach(l => this.sendHidden(l)); return; }
    if (link) { link.line(this.banner()); lines.forEach(l => link.line(l)); return; }
    this.greeted = true;
    this.send(this.banner());
    lines.forEach(l => this.send(l));
  }

  // A link opened after start-up is greeted on its own. One opened at start-up
  // waits for the first look for a stick, so the greeting it gets names it.
  greet(link) { if (this.started) this.hello(link, false); }

  statRecord() {
    const s = this.settings, i = this.info || {}, st = this.stat;
    const lv = this.lastLevel;
    return SdrPi.record('STAT', {
      run: this.run, up: this.up(), epoch_ms: this.epoch(), clock: this.clock.mode, state: this.state,
      freq_hz: s.freq, offset_hz: s.offset, rate: this.deviceRate(), in_rate: Math.round(this.rx.rate),
      gain: SdrPi.formatSetting('gain', s.gain), agc: s.agc, ppm: s.ppm, fmt: s.fmt, gate: s.gate, squelch: s.squelch,
      nf_dbfs: r1(lv && lv.nfDb), ch_dbfs: r1(st.n ? st.chMax : lv && lv.chDb), open: lv ? !!lv.open : null,
      dbfs: r1(st.n ? st.dbfs / st.n : null), clip_pct: r3(st.n ? st.clip / st.n : null),
      bursts: this.counts.bursts, readings: this.counts.readings, drops: this.counts.drops + (this.dev ? this.dev.stats.errors : 0),
      cpu_pct: this.cpu.pct, temp_c: this.temperature(), model: i.modelLabel || null, tuner: i.tuner || null, source: this.opts.source,
      chans: this.decoders.length > 1 ? SdrPi.packChans(this.decoders.map(d => this.chanStat(d))) : null,
    });
  }

  // One channel in STAT's chans (SdrPi.packChans): its level over the last
  // STAT's interval, as STAT's own fields are, and what it has heard.
  chanStat(d) {
    const a = d.st, lv = d.last;
    return { hz: d.ch ? d.ch.hz : '', fmt: d.ch ? d.ch.fmt : '', chDb: a.n ? a.chMax : lv && lv.chDb, nfDb: lv && lv.nfDb, open: !!(lv && lv.open),
      bursts: d.counts.bursts, readings: d.counts.readings };
  }

  temperature() {
    try { return r1(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000); } catch (_) { return null; }
  }

  title() {
    if (!this.opts.title) return;
    const s = this.settings, lv = this.lastLevel, n = this.decoders.length;
    const t = 'Flood-Net SDR Pi - ' + (s.freq / 1e6).toFixed(4) + ' MHz ' + s.fmt + (n > 1 ? ' + ' + (n - 1) + ' more' : '') + ' - ' + this.state
      + (lv && lv.nfDb != null ? ' - floor ' + lv.nfDb.toFixed(1) + ' dBFS' : '')
      + ' - ' + this.counts.bursts + ' bursts ' + this.counts.readings + ' readings';
    for (const l of this.links) if (l.io.terminal) l.write('\x1b]0;' + t + '\x07', true);
  }

  // ── the console ────────────────────────────────────────────────────────────

  // One command at a time, in the order they came: a paste of several lines
  // runs them in turn, each ending in its OK or ERR before the next starts.
  command(link, line) {
    this.queue = this.queue.then(() => this.exec(link, line)).catch(e => this.final(false, 'FAILED ' + e.message));
  }

  async exec(link, line) {
    const c = SdrPi.parseCommand(line);
    if (!c.verb) { link.line(this.statusText()); return; }    // Enter on its own: is anyone there?
    if (c.error) { this.final(false, c.error); return; }
    switch (c.verb) {
      case 'HELP': SdrPi.HELP.forEach(h => this.send('HELP,' + h)); this.final(true); return;
      case 'HELLO': case 'INFO': this.hello(null, false); this.send(this.statRecord()); this.final(true); return;
      case 'STATUS': this.send(this.statRecord()); this.final(true); return;
      case 'TIME': {
        if (c.epoch == null) { const e = this.epoch(); this.send('TIME,' + (e == null ? '' : Math.floor(e / 1000))); this.final(true, this.clock.mode || 'unset'); return; }
        if (this.clock.mode === 'ntp') { this.final(true, 'ntp - the clock is kept by NTP'); return; }
        const before = this.epoch();
        this.clock = { mode: 'set', epoch0: c.epoch * 1000, perf0: performance.now() };
        this.note('info', before == null ? 'Clock set' : 'Clock stepped ' + ((this.epoch() - before) / 1000).toFixed(1) + ' s');
        this.final(true);
        return;
      }
      case 'DECODE':
        if (!this.decoders.some(d => d.worker)) { this.final(false, 'NODECODER'); return; }
        this.decoders.forEach(d => { if (d.worker) d.worker.postMessage({ type: 'decodeNow', seconds: c.seconds }); });
        this.final(true);
        return;
      case 'CHANNELS': {
        const s = this.settings;
        if (!c.set) {
          this.send(SdrPi.kvRecord('CFG', ['freq', 'rate', 'offset', 'fmt', 'more'].reduce((o, k) => { o[k] = SdrPi.formatSetting(k, s[k]); return o; }, {})));
          this.final(true);
          return;
        }
        const r = await this.apply(c.set);
        if (r.ok) {
          const p = c.plan, n = 1 + p.more.length;
          this.note('info', n === 1 ? 'One channel: ' + this.channelsText()
            : 'Decoding ' + this.channelsText() + ' - tuned to ' + (p.freq / 1e6).toFixed(4) + ' MHz at ' + p.rate + ' sps - the nearest channel '
              + Math.round(p.dcHz / 1000) + ' kHz from the DC spike and ' + Math.round(p.mirrorHz / 1000) + ' kHz from any mirror image');
        }
        this.final(r.ok, r.ok ? r.detail : r.error);
        return;
      }
      case 'RESTART':
        this.final(true);
        await this.reopen('restart asked for');
        return;
      case 'DEFAULTS': {
        const r = await this.apply(SdrPi.defaults());
        this.final(r.ok, r.ok ? r.detail : r.error);
        return;
      }
      default: break;
    }
    if (c.show) { this.send(SdrPi.kvRecord('CFG', { [c.show]: SdrPi.formatSetting(c.show, this.settings[c.show]) })); this.final(true); return; }
    if (c.set && Object.keys(c.set).length) {
      const r = await this.apply(c.set);
      this.final(r.ok, r.ok ? r.detail : r.error);
      return;
    }
    // CFG with nothing after it: every setting.
    this.send(SdrPi.cfgRecord(this.settings));
    this.final(true);
  }

  statusText() {
    const s = this.settings, lv = this.lastLevel, u = Math.round(this.up() / 60000), n = this.decoders.length;
    return 'Flood-Net SDR Pi - ' + this.state + ' - ' + (s.freq / 1e6).toFixed(4) + ' MHz ' + s.fmt + (n > 1 ? ' + ' + (n - 1) + ' more channels' : '')
      + (lv && lv.nfDb != null ? ' - floor ' + lv.nfDb.toFixed(1) + ' dBFS' : '')
      + ' - ' + this.counts.bursts + ' bursts ' + this.counts.readings + ' readings - up ' + Math.floor(u / 60) + 'h ' + (u % 60) + 'm - type HELP';
  }

  // Settings checked against the stick, kept, sent to the stick and the
  // decoder, and reported back as a CFG line. { ok, detail } or { ok, error }.
  async apply(set) {
    const s = Object.assign({}, this.settings, set), i = this.info;
    const rate = this.opts.source === 'file' ? this.deviceRate() : s.rate;
    // Every channel inside the band the stick is tuned to, and none twice.
    const bad = SdrPi.checkChannels(s, rate);
    if (bad) return { ok: false, error: bad.error };
    if (i && i.minHz && (s.freq < i.minHz || s.freq > i.maxHz)) {
      return { ok: false, error: 'RANGE this stick tunes ' + (i.minHz / 1e6) + ' to ' + (i.maxHz / 1e6) + ' MHz' };
    }
    if (set.bias && i && i.biasTee === false) return { ok: false, error: 'NOSUPPORT this stick has no bias tee (set MODEL if it is a V2 V3 or V4)' };
    const before = this.settings;
    this.settings = s;
    this.saveState();
    let detail = '';
    const changed = k => k in set && (k === 'more' ? SdrPi.formatSetting(k, set[k]) !== SdrPi.formatSetting(k, before[k]) : set[k] !== before[k]);
    try {
      if (this.dev) {
        if (changed('model')) await this.reopen('model changed');
        else {
          if (changed('rate')) {
            await this.dev.stop();
            await this.dev.setSampleRate(s.rate);
            this.syncDecoders(true);
            this.startStream();
          }
          if ('ppm' in set) this.tune = (await this.dev.setPpm(s.ppm)) || this.tune;
          if ('direct' in set && this.info.directSampling) { this.dev.directMode = s.direct; this.tune = (await this.dev.setDirectSampling(s.direct)) || this.tune; }
          if ('freq' in set) this.tune = await this.dev.setFrequency(s.freq);
          if ('gain' in set) await this.dev.setGain(s.gain == null ? null : Math.round(s.gain * 10));
          if ('agc' in set) await this.dev.setAgc(s.agc);
          if ('bias' in set && this.info.biasTee) await this.dev.setBiasTee(s.bias || this.info.forceBiasTee);
        }
      } else if (this.proc) {
        if (['freq', 'rate', 'gain', 'ppm'].some(changed)) await this.reopen('settings changed');
      } else if (this.opts.source !== 'file') detail = 'kept - no stick yet';
    } catch (e) {
      this.note('bad', 'The stick refused: ' + e.message);
      this.send(SdrPi.cfgRecord(this.settings));
      return { ok: false, error: 'USB ' + e.message };
    }
    if (['fmt', 'gate', 'squelch', 'offset', 'rate', 'more', 'freq'].some(changed)) this.syncDecoders(changed('rate'));
    if (changed('more')) this.log('Decoding ' + this.channelsText());
    if (changed('spec') || changed('lvl')) this.pace();
    this.send(SdrPi.cfgRecord(this.settings));
    return { ok: true, detail };
  }

  // ── the decoders ───────────────────────────────────────────────────────────

  deviceRate() {
    if (this.opts.source === 'file') return this.fileRate || 240000;
    return this.dev && this.dev.rate ? Math.round(this.dev.rate) : this.settings.rate;
  }

  // A decoder for each channel, made or ended to match the settings, each told
  // its channel; one whose channel moved in the band starts afresh. reset: the
  // stream itself changed (a new rate, a new source), so all do.
  syncDecoders(reset) {
    // A channel outside the band the stick hears at this rate, or listed
    // twice — kept from before, given with --set, or a recording's rate at
    // odds with the settings — gets no decoder: it would hear another
    // frequency and name it this one. Said once, when there is someone to
    // tell (the journal has it regardless).
    const all = this.channelList(), lim = SdrPi.offsetLimit(this.deviceRate());
    const chans = all.filter((ch, k) => k === 0 || (Math.abs(ch.offset) <= lim && all.findIndex(o => o.hz === ch.hz) === k));
    const left = all.filter(ch => chans.indexOf(ch) < 0).map(ch => SdrPi.mhzText(ch.hz)).join(' ');
    if (left !== this.leftOut && (this.links.size || !left)) {
      this.leftOut = left;
      if (left) {
        this.note('warn', 'Not decoding ' + left + ' MHz: outside the band the stick hears at ' + this.deviceRate()
          + ' sps or listed twice - CHANNELS works out a tuning that holds them all');
      }
    }
    while (this.decoders.length > chans.length) this.decoders.pop().end();
    chans.forEach((ch, k) => {
      let d = this.decoders[k], fresh = false;
      if (!d) { d = this.decoders[k] = new Decoder(this, k); fresh = true; }
      const moved = !fresh && d.ch && (d.ch.offset !== ch.offset || d.ch.hz !== ch.hz);
      if (moved) { d.counts = { bursts: 0, readings: 0 }; d.bursts.clear(); d.last = null; d.st = this.blankLevel(); }
      d.ch = ch;
      d.configure(reset || moved);
    });
    if (reset) { this.specMax = null; this.lvl = this.blankLevel(); }
  }

  // The stick's samples, to every channel's decoder.
  feed(u8) {
    this.rx.bytes += u8.length;
    for (const d of this.decoders) d.feed(u8);
  }

  blankLevel() { return { n: 0, chMax: -Infinity, nf: null, open: false, dbfs: 0, clip: 0, hist: new Array(32).fill(0) }; }

  addLevel(a, m) {
    a.n++;
    if (m.chDb > a.chMax) a.chMax = m.chDb;
    a.nf = m.nfDb;
    a.open = a.open || !!m.open;
    a.dbfs += m.dbfs;
    a.clip += m.clipPct;
    for (let i = 0; i < 32 && i < m.hist.length; i++) a.hist[i] += m.hist[i];
  }

  // From one channel's decoder. The level and spectrum the card draws are the
  // stick's own channel's; every channel's level goes into STAT's chans.
  onDsp(d, m) {
    switch (m.type) {
      case 'level':
        d.last = m;
        this.addLevel(d.st, m);
        if (d.index === 0) {
          this.lastLevel = m;
          this.addLevel(this.lvl, m);
          this.addLevel(this.stat, m);
        }
        break;
      case 'spectrum':
        if (d.index !== 0) break;
        if (!this.specMax || this.specMax.length !== m.db.length) this.specMax = Float32Array.from(m.db);
        else for (let i = 0; i < m.db.length; i++) if (m.db[i] > this.specMax[i]) this.specMax[i] = m.db[i];
        break;
      case 'burst': this.onBurst(d, m); break;
      case 'decode': this.onDecode(d, m); break;
      case 'pong': d.pong(m); break;
      case 'error': this.note('bad', 'Decoder' + d.label() + ': ' + m.message); break;
      default: break;
    }
  }

  // Stamped when the gate closes, here, by this thread's clock — the decoder's
  // own Date.now() would move with an NTP step — and kept for the decode that
  // follows it, which names the burst by its `t`. Each channel's own.
  onBurst(d, m) {
    const seq = ++this.seq.burst;
    this.counts.bursts++;
    d.counts.bursts++;
    const b = { seq, up: this.up(), epoch: this.epoch() };
    d.bursts.set(m.t, b);
    if (d.bursts.size > BURSTS_KEPT) d.bursts.delete(d.bursts.keys().next().value);
    this.send(SdrPi.record('BURST', {
      seq, run: this.run, up: b.up, epoch_ms: b.epoch, ms: m.ms, peak_dbfs: r1(m.peakDb), nf_dbfs: r1(m.nfDb), freq_hz: d.ch.hz,
    }));
  }

  onDecode(d, m) {
    const b = m.burst ? d.bursts.get(m.burst.t) : null;
    const up = b ? b.up : this.up(), epoch = b ? b.epoch : this.epoch();
    m.readings.forEach(r => {
      this.counts.readings++;
      d.counts.readings++;
      const n = this.names.get(r.sensorId);
      this.send(SdrPi.record('RX', {
        seq: ++this.seq.rx, run: this.run, up, epoch_ms: epoch, id: r.sensorId, value: r.value, fmt: SdrPi.FMT_CODE[r.format] || r.format,
        votes: r.votes, pol: r.polarity, crc: r.crcOk == null ? null : r.crcOk, hex: String(r.hex || '').replace(/\s+/g, ''),
        carrier_hz: r.carrierHz, burst: b ? b.seq : null, peak_dbfs: m.burst ? r1(m.burst.peakDb) : null,
        nf_dbfs: m.burst ? r1(m.burst.nfDb) : null, burst_ms: m.burst ? m.burst.ms : null, freq_hz: d.ch.hz,
        name: n ? n.name : null, kind: n ? n.kind : null,
      }));
    });
    const t = m.trace ? SdrPi.packTrace(m.trace) : { start: 0, frames: '', symbols: '' };
    this.sendHidden(SdrPi.record('TRACE', {
      run: this.run, up: this.up(), burst: b ? b.seq : null, ms: m.ms, combos: m.combos, seconds: r3(m.seconds), all: m.all,
      carrier_hz: m.trace ? m.trace.carrierHz : null, start: t.start, frames: t.frames, shadows: SdrPi.packShadows(m.shadows), symbols: t.symbols,
      freq_hz: d.ch.hz,
    }));
  }

  // The level and spectrum records, at the pace the settings ask for.
  pace() {
    clearInterval(this.lvlTimer);
    clearInterval(this.specTimer);
    const s = this.settings;
    if (s.lvl > 0) this.lvlTimer = setInterval(() => this.sendLevel(), s.lvl * 1000);
    if (s.spec > 0) this.specTimer = setInterval(() => this.sendSpectrum(), s.spec * 1000);
  }

  sendLevel() {
    const a = this.lvl;
    if (!a.n) return;
    this.lvl = this.blankLevel();
    this.sendHidden(SdrPi.record('LVL', {
      run: this.run, up: this.up(), ch_dbfs: r1(a.chMax), nf_dbfs: r1(a.nf), open: a.open, dbfs: r1(a.dbfs / a.n),
      clip_pct: r3(a.clip / a.n), hist: SdrPi.packHist(a.hist),
    }));
  }

  sendSpectrum() {
    if (!this.specMax) return;
    const p = SdrPi.packSpectrum(this.specMax, 256);
    this.specMax = null;
    this.sendHidden(SdrPi.record('SPEC', {
      run: this.run, up: this.up(), rate: this.deviceRate(), freq_hz: this.settings.freq,
      offset_hz: this.channelList()[0].offset, lo_dbfs: p.lo, step_db: p.step, agg: 'max', bins: p.bins,
    }));
  }

  tick() {
    const now = performance.now();
    this.rx.rate = (this.rx.bytes - this.rx.lastBytes) / 2 / ((now - this.rx.lastT) / 1000);
    this.rx.lastBytes = this.rx.bytes;
    this.rx.lastT = now;
    const c = process.cpuUsage();
    this.cpu.pct = Math.round(((c.user - this.cpu.last.user) + (c.system - this.cpu.last.system)) / 1000 / (now - this.cpu.t) * 100);
    this.cpu.last = c;
    this.cpu.t = now;
    const id = ++this.lagId;
    for (const d of this.decoders) d.ping(id);
  }

  // ── the stick ──────────────────────────────────────────────────────────────

  setState(st) { this.state = st; }

  async openSource() {
    if (this.stopping) return;
    try {
      if (this.opts.source === 'file') return this.openFile();
      if (this.opts.source === 'rtl_sdr') return this.openRtlSdr();
      return await this.openUsb();
    } catch (e) {
      this.dev = null;
      this.setState('no-stick');
      const msg = this.describe(e);
      if (msg !== this.lastOpenError) this.note('warn', msg);
      this.lastOpenError = msg;
      this.retry();
    }
  }

  retry() {
    clearTimeout(this.retryTimer);
    if (!this.stopping) this.retryTimer = setTimeout(() => this.openSource(), RETRY_MS);
  }

  describe(e) {
    const m = (e && e.message) || String(e);
    if (/LIBUSB_ERROR_ACCESS|EACCES|permission/i.test(m)) return 'The stick is there but this user may not open it (' + m + '). install.sh adds the udev rule that allows it; re-plug the stick after installing.';
    if (/LIBUSB_ERROR_BUSY|claim/i.test(m)) return 'Something else has the stick (' + m + '): the DVB-T driver (install.sh blacklists it), or rtl_tcp, or another copy of this.';
    if (/usb package/i.test(m)) return m;
    return 'Could not open the stick: ' + m;
  }

  usbApi() {
    if (this.deps.usb) return this.deps.usb;
    if (!this.webusb) {
      let usb;
      try { usb = require('usb'); } catch (_) {
        throw new Error('The usb package is not installed - run `npm install` in ' + __dirname + ' (install.sh does), or use --source rtl_sdr');
      }
      this.webusb = new usb.WebUSB({ allowAllDevices: true });
    }
    return this.webusb;
  }

  async openUsb() {
    const all = await this.usbApi().getDevices();
    const sticks = all.filter(d => RtlSdr.FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId));
    if (!sticks.length) {
      if (this.state !== 'no-stick') this.note('warn', 'No RTL-SDR stick found - plug one in; looking every few seconds');
      this.setState('no-stick');
      this.lastOpenError = null;
      this.retry();
      return;
    }
    const u = sticks[0], s = this.settings;
    const dev = new RtlSdr.Device(u, msg => this.log(msg));
    let info;
    // The browser card's own sequence (serial-sdr.js open()), so the stick ends
    // up exactly as it would there.
    try {
      info = await dev.open({ model: s.model, ppm: s.ppm });
      if (s.freq < info.minHz || s.freq > info.maxHz) {
        this.note('warn', (s.freq / 1e6) + ' MHz is outside this stick\'s range - back to 151.5');
        s.freq = 151500000;
        this.saveState();
      }
      await dev.setSampleRate(s.rate);
      dev.directMode = info.directSampling ? s.direct : 'off';
      this.tune = await dev.setFrequency(s.freq);
      await dev.setGain(s.gain == null ? null : Math.round(s.gain * 10));
      await dev.setAgc(s.agc);
      if (info.biasTee) await dev.setBiasTee(s.bias || info.forceBiasTee);
    } catch (e) {
      try { await dev.close(); } catch (_) {}     // let go of it, or the next try finds it claimed
      throw e;
    }
    this.dev = dev;
    this.info = info;
    this.stickLabel = RtlSdr.label(u);
    this.lastOpenError = null;
    this.syncDecoders(true);
    this.startStream();
    this.setState('streaming');
    this.note('info', 'Opened ' + this.stickLabel + ' - ' + info.modelLabel + ', tuner ' + info.tuner + ' - '
      + (s.freq / 1e6).toFixed(4) + ' MHz at ' + this.deviceRate() + ' sps' + (this.tune && this.tune.mode !== 'tuner' ? ' (' + this.tune.mode + ')' : '')
      + (this.decoders.length > 1 ? ' - ' + this.channelsText() : ''));
    this.hello(null, false);
  }

  startStream() {
    const dev = this.dev;
    dev.start(u8 => this.feed(u8), {
      onError: e => {
        if (this.dev !== dev || this.stopping) return;
        this.note('bad', 'The stick stopped streaming (' + ((e && e.message) || e) + ') - unplugged? Looking for it again');
        this.closeStick();
        this.setState('no-stick');
        this.retry();
      },
    }).catch(e => this.note('bad', 'Could not start the stream: ' + e.message));
  }

  closeStick() {
    const d = this.dev;
    this.dev = null;
    if (d) d.close().catch(() => {});
    if (this.proc) { const p = this.proc; this.proc = null; try { p.kill(); } catch (_) {} }
    clearTimeout(this.fileTimer);
  }

  async reopen(why) {
    this.log('Reopening the stick: ' + why);
    clearTimeout(this.retryTimer);
    const d = this.dev;
    this.dev = null;
    if (d) { try { await d.close(); } catch (_) {} }
    this.closeStick();
    this.info = this.opts.source === 'file' ? this.info : null;
    this.setState('starting');
    await this.openSource();
  }

  // librtlsdr's own tool, for a stick this driver does not know or a Pi
  // without the usb package: its 8-bit IQ on stdout is what the stick sends.
  // It is restarted for every change; FORMAT, GATE and the like need no restart.
  openRtlSdr() {
    const s = this.settings;
    const args = ['-f', String(s.freq), '-s', String(s.rate), '-p', String(s.ppm), '-g', s.gain == null ? '0' : String(s.gain), '-'];
    const p = spawn(this.opts.rtlSdr, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.info = { modelLabel: 'rtl_sdr', tuner: '', minHz: 24000000, maxHz: 1766000000, gains: RtlSdr.GAINS.slice(), biasTee: false, directSampling: false };
    this.stickLabel = 'via rtl_sdr';
    let err = '';
    p.stderr.on('data', d => {
      err = (err + d.toString()).slice(-2000);
      const t = /Found (.+?) tuner/.exec(err);
      if (t && !this.info.tuner) this.info.tuner = t[1];
    });
    p.stdout.on('data', d => this.feed(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    p.on('error', e => { if (this.proc === p) { this.proc = null; this.setState('no-stick'); this.note('bad', 'rtl_sdr: ' + e.message); this.retry(); } });
    p.on('exit', code => {
      if (this.proc !== p || this.stopping) return;
      this.proc = null;
      this.setState('no-stick');
      this.note('warn', 'rtl_sdr stopped (' + code + '): ' + SdrPi.clean(err.split('\n').filter(Boolean).slice(-1)[0] || '', 160));
      this.retry();
    });
    this.syncDecoders(true);
    this.setState('streaming');
    this.note('info', 'Streaming through rtl_sdr - ' + (s.freq / 1e6).toFixed(4) + ' MHz at ' + s.rate + ' sps' + (this.decoders.length > 1 ? ' - ' + this.channelsText() : ''));
    this.hello(null, false);
  }

  // A recording instead of a stick: played in real time (or --speed times it),
  // then a second of near silence, so a burst at the very end still has the
  // margin after it that the gate waits for before it decodes.
  openFile() {
    const file = this.opts.file;
    const buf = fs.readFileSync(file);
    const m = /(\d{3,4})k/i.exec(path.basename(file));
    this.fileRate = this.opts.fileRate || (m && SdrPi.RATES.indexOf(+m[1] * 1000) >= 0 ? +m[1] * 1000 : 240000);
    this.info = { modelLabel: 'IQ file', tuner: path.basename(file), minHz: 500000, maxHz: 1766000000, gains: RtlSdr.GAINS.slice(), biasTee: false, directSampling: false };
    this.stickLabel = 'IQ file ' + path.basename(file);
    this.syncDecoders(true);
    this.setState('streaming');
    this.note('info', 'Playing ' + path.basename(file) + ' - ' + (buf.length / 2 / this.fileRate).toFixed(1) + ' s at ' + this.fileRate + ' sps'
      + (this.decoders.length > 1 ? ' - ' + this.channelsText() : ''));
    this.hello(null, false);
    const chunk = Math.round(this.fileRate / 10) * 2;
    const quiet = new Uint8Array(this.fileRate * 2).map((_, i) => 127 + (i & 1));
    let pos = 0, tail = false;
    const step = () => {
      if (this.stopping) return;
      if (!tail) {
        const end = Math.min(buf.length, pos + chunk);
        this.feed(new Uint8Array(buf.buffer, buf.byteOffset + pos, end - pos));
        pos = end;
        if (pos >= buf.length) {
          if (this.opts.loop) pos = 0;
          else tail = true;
        }
      } else {
        this.feed(quiet);
        this.fileDone();
        return;
      }
      this.fileTimer = setTimeout(step, this.opts.speed > 0 ? 100 / this.opts.speed : 0);
    };
    step();
  }

  // The decoder answers a ping only after everything sent before it, so the
  // pong says the file is decoded.
  fileDone() {
    this.setState('stopped');
    Promise.all(this.decoders.map(d => d.drained())).then(() => {
      this.sendLevel();
      this.sendSpectrum();
      this.note('info', 'End of ' + path.basename(this.opts.file));
      this.send(this.statRecord());
      if (this.opts.exitAfterFile) this.stop(0);
    });
  }

  // ── serial ports, TCP, stdio ─────────────────────────────────────────────────

  addLink(name, io) {
    const link = new Link(this, name, io);
    this.links.add(link);
    return link;
  }

  serialPaths() {
    const out = [];
    this.opts.serial.forEach(p => {
      if (p !== 'auto') { out.push(p); return; }
      AUTO_SERIAL.forEach(a => { if (fs.existsSync(a) && !this.isConsole(a)) out.push(a); });
    });
    return [...new Set(out)];
  }

  // A UART still carrying the Linux login console is the console's: writing
  // records into a login prompt helps nobody. install.sh moves the console off.
  isConsole(p) {
    if (p !== '/dev/serial0') return false;
    try { return /console=(serial0|ttyS0|ttyAMA0)/.test(fs.readFileSync('/proc/cmdline', 'utf8')); } catch (_) { return false; }
  }

  // Open each port not already open; one that fails, or goes (a USB gadget
  // whose PC went away), is tried again a few seconds later.
  openSerials() {
    for (const p of this.serialPaths()) {
      if (this.serials.has(p)) continue;
      let link = null;
      try {
        const io = openSerial(p, this.opts.baud, d => link && link.input(d), e => {
          this.links.delete(link);
          this.serials.delete(p);
          this.log(p + ' closed' + (e ? ' (' + e.message + ')' : '') + ' - opening it again shortly');
        });
        io.terminal = true;
        link = this.addLink(p, io);
        this.serials.set(p, link);
        this.log('Talking on ' + p);
        this.greet(link);
      } catch (e) {
        if (!this.serialFailed || this.serialFailed[p] !== e.message) this.log('Cannot open ' + p + ': ' + e.message);
        this.serialFailed = Object.assign(this.serialFailed || {}, { [p]: e.message });
      }
    }
  }

  listen() {
    const srv = net.createServer(sock => {
      sock.setNoDelay(true);
      const link = this.addLink('tcp ' + sock.remoteAddress, { write: t => sock.write(t, 'latin1'), pending: () => sock.writableLength, echo: false, tcp: true, terminal: true });
      sock.on('data', d => link.input(d));
      sock.on('error', () => {});
      sock.on('close', () => this.links.delete(link));
      this.greet(link);
    });
    srv.on('error', e => this.log('TCP: ' + e.message));
    srv.listen(this.opts.tcp, this.opts.tcpHost, () => {
      this.tcpPort = srv.address().port;
      this.log('Listening on TCP ' + this.opts.tcpHost + ':' + this.tcpPort);
      if (this.deps.onListening) this.deps.onListening(this.tcpPort);
    });
    this.server = srv;
  }

  stdio() {
    const term = !!process.stdin.isTTY;
    const io = { write: t => process.stdout.write(t, 'latin1'), pending: () => process.stdout.writableLength || 0, echo: term, terminal: !!process.stdout.isTTY };
    if (term) { process.stdin.setRawMode(true); io.interrupt = () => this.stop(0); }
    const link = this.addLink('stdio', io);
    process.stdin.on('data', d => link.input(d));
    process.stdin.on('end', () => { if (!this.opts.exitAfterFile) this.stop(0); });
    this.greet(link);
  }

  // ── start and stop ───────────────────────────────────────────────────────────

  async start() {
    this.loadNames();
    this.checkClock();
    this.syncDecoders(true);
    if (this.opts.stdio) this.stdio();
    if (this.opts.tcp != null) this.listen();
    if (this.opts.serial.length) this.openSerials();
    this.pace();
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    every(1000, () => this.tick());
    every(STAT_MS, () => {
      this.sendHidden(this.statRecord());
      this.title();
      this.stat = this.blankLevel();
      this.decoders.forEach(d => { d.st = this.blankLevel(); });
    });
    every(STAT_SHOWN_MS, () => this.send(this.statRecord()));
    every(HELLO_MS, () => this.hello(null, true));
    every(60000, () => this.checkClock());
    if (this.opts.serial.length) every(RETRY_MS, () => this.openSerials());
    await this.openSource();
    if (!this.greeted) this.hello(null, false);     // no stick yet: say who is here anyway
    this.started = true;
  }

  stop(code) {
    if (this.stopping) return;
    this.stopping = true;
    this.timers.forEach(clearInterval);
    clearInterval(this.lvlTimer);
    clearInterval(this.specTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.fileTimer);
    const d = this.dev;
    this.dev = null;
    if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; }
    if (this.server) this.server.close();
    const done = () => {
      this.decoders.forEach(d => d.end());
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      if (this.deps.onStop) { this.deps.onStop(code); return; }
      // stdout drained before going: a pipe still holding records would lose them
      if (process.stdout.writableLength) process.stdout.once('drain', () => process.exit(code || 0));
      else process.exit(code || 0);
    };
    if (d) d.close().catch(() => {}).then(done); else done();
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(e.message + '\n\n' + USAGE); process.exit(2); }
  if (opts.help) { process.stdout.write(USAGE); return; }
  if (!opts.serial.length && opts.tcp == null && !opts.stdio) { process.stderr.write('Nowhere to talk: give --serial, --tcp or --stdio.\n\n' + USAGE); process.exit(2); }
  const relay = new Relay(opts);
  process.on('SIGTERM', () => relay.stop(0));
  process.on('SIGINT', () => relay.stop(0));
  await relay.start();
}

if (require.main === module) main().catch(e => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });

module.exports = { Relay, Link, parseArgs, USAGE };
