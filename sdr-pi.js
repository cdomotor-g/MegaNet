// MegaNet — sdr-pi.js
//
//   SdrPi   the text link between an RTL-SDR on a Raspberry Pi and the Serial
//           Monitor's RTL-SDR card — both ends of it. The Pi (sdr-pi/relay.js)
//           runs MegaNet's own driver (rtlsdr.js) and decoder (alert-dsp.js) and
//           prints what they find on a serial port; PuTTY logs that port; the
//           card follows the log. This file is how the Pi says it, and how the
//           card reads it back.
//
// After core.js, before serial-sdr.js — index.html holds the order and the
// reasons. Reaches for nothing: no DOM, no state, no other module. The relay
// requires this same file under Node — the guarded module.exports at the foot
// is the door — so the two ends cannot drift: test/sdrpi.mjs runs the relay and
// reads what it wrote with this file's Reader.
//
// ── Why a Pi ────────────────────────────────────────────────────────────────
//
// A managed Windows PC whose browser has no WebUSB cannot drive the stick, and
// cannot give the stick the WinUSB driver it needs without an administrator
// either. What it can do is what the Quansheng radio already relies on: PuTTY
// opens a COM port and logs it, and the Serial Monitor follows the log. So the
// stick goes on a computer that can drive it, and that computer is made to look
// like the radio — a serial port that prints readings. docs/sdr-pi.md is the
// person-facing guide; docs/sdr-pi-serial.md states this protocol for people
// and for agents.
//
// ── The rules ───────────────────────────────────────────────────────────────
//
// The radio's (quansheng_alert_v3's docs/ALERT_SERIAL.md), kept on purpose so
// the two receivers read alike:
//
//   * ASCII lines ending CR LF, fields split by commas, the record type first,
//     an empty field meaning unknown.
//   * Fields mapped by name from the FIELDS lines — the built-in lists below
//     until those arrive — and only ever appended within a schema.
//   * One console command at a time, each ending in exactly one OK or ERR.
//
// And one the link adds. A person watching PuTTY wants a scanner's window —
// readings and bursts — not the level twice a second or a spectrum every few.
// Those records go inside an escape sequence terminals do not print, OSC 7355
// (ESC ] 7355 ; record BEL): PuTTY swallows it, while its log — set to keep
// "All session output", the raw bytes — has every one. The Reader below takes
// both, strips the CSI sequences the Pi uses to redraw a half-typed command,
// and applies backspaces, so an echo of typing never reads as a record.

const SdrPi = (function () {
  const SCHEMA = 1;
  const OSC_ID = '7355';
  const VERSION = '1.0.0';

  // The record types. SDRPI and CFG are key,value lists; FIELDS names the
  // fields of another type; the rest are mapped by name.
  const RECORDS = ['SDRPI', 'FIELDS', 'CFG', 'RX', 'BURST', 'STAT', 'NOTE', 'LVL', 'SPEC', 'TRACE'];

  // What a reader uses until the Pi's FIELDS lines arrive (and what the relay
  // writes them from). Append only, within schema 1.
  const DEFAULT_FIELDS = {
    RX: 'seq,run,up,epoch_ms,id,value,fmt,votes,pol,crc,hex,carrier_hz,burst,peak_dbfs,nf_dbfs,burst_ms,freq_hz,name,kind'.split(','),
    BURST: 'seq,run,up,epoch_ms,ms,peak_dbfs,nf_dbfs,freq_hz'.split(','),
    STAT: ('run,up,epoch_ms,clock,state,freq_hz,offset_hz,rate,in_rate,gain,agc,ppm,fmt,gate,squelch,nf_dbfs,ch_dbfs,open,'
      + 'dbfs,clip_pct,bursts,readings,drops,cpu_pct,temp_c,model,tuner,source').split(','),
    NOTE: 'run,up,epoch_ms,level,text'.split(','),
    LVL: 'run,up,ch_dbfs,nf_dbfs,open,dbfs,clip_pct,hist'.split(','),
    SPEC: 'run,up,rate,freq_hz,offset_hz,lo_dbfs,step_db,agg,bins'.split(','),
    TRACE: 'run,up,burst,ms,combos,seconds,all,carrier_hz,start,frames,shadows,symbols'.split(','),
  };
  // The type whose last field takes the rest of the line, commas and all.
  const TAIL = { NOTE: 'text' };

  const NUMERIC = new Set(['seq', 'up', 'epoch_ms', 'id', 'value', 'votes', 'crc', 'carrier_hz', 'burst', 'peak_dbfs',
    'nf_dbfs', 'burst_ms', 'freq_hz', 'ms', 'offset_hz', 'rate', 'in_rate', 'agc', 'ppm', 'gate', 'squelch', 'ch_dbfs',
    'open', 'dbfs', 'clip_pct', 'bursts', 'readings', 'drops', 'cpu_pct', 'temp_c', 'lo_dbfs', 'step_db', 'combos',
    'seconds', 'all', 'start']);

  // ── frame formats: the decoder's keys and the short codes on the wire ─────────
  //
  // ABF and EIF are the radio's codes for the same two formats. Never accept
  // "IFLOWS" for EIF: NSW's network is called iFLOWS and sends ALERT Binary
  // (alert-dsp.js's header, HANDOVER §5's trap).
  const FMT_KEY = { ABF: 'BINARY', EIF: 'ENHANCED_IFLOWS', ASC: 'ASCII' };
  const FMT_CODE = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASC' };
  const FMT_ALIAS = { ABF: 'ABF', BINARY: 'ABF', EIF: 'EIF', ENHANCED: 'EIF', ENHANCED_IFLOWS: 'EIF', ASC: 'ASC', ASCII: 'ASC' };
  const FMT_LABEL = { ABF: 'ALERT Binary', EIF: 'Enhanced iFLOWS', ASC: 'ALERT ASCII' };

  // ── settings: what the Pi keeps, the console sets, and CFG reports ────────────
  //
  // The CFG record and the CFG command use the same keys in the same units, so
  // a CFG line from the Pi, turned into `CFG key=value …`, sets the same state
  // back. freq is MHz and offset kHz there — the units the card's boxes use.
  const RATES = [240000, 960000, 1200000, 1920000, 2400000];      // AlertDsp.DEVICE_RATES
  const MODELS = ['auto', 'v2', 'v3', 'v4', 'r820t', 'r828d', 'fc0013', 'fc0012'];
  const DIRECT = ['auto', 'off', 'i', 'q'];
  const SETTING_KEYS = ['freq', 'rate', 'gain', 'agc', 'ppm', 'fmt', 'gate', 'squelch', 'offset', 'bias', 'direct', 'model', 'spec', 'lvl'];
  // What `CFG` with the card's settings sends: the radio state. spec and lvl
  // are the link's own pacing, left where the Pi has them.
  const CARD_KEYS = ['freq', 'rate', 'gain', 'agc', 'ppm', 'fmt', 'gate', 'squelch', 'offset', 'bias', 'direct', 'model'];

  function defaults() {
    return { freq: 151500000, rate: 240000, gain: 29.7, agc: false, ppm: 0, fmt: 'ABF', gate: true, squelch: 8,
      offset: 0, bias: false, direct: 'auto', model: 'auto', spec: 5, lvl: 2 };
  }

  const ok = value => ({ ok: true, value });
  const bad = error => ({ ok: false, error });

  function onOff(raw) {
    const s = String(raw).trim().toLowerCase();
    if (['1', 'on', 'yes', 'true', 'y'].indexOf(s) >= 0) return ok(true);
    if (['0', 'off', 'no', 'false', 'n'].indexOf(s) >= 0) return ok(false);
    return bad('say on or off');
  }

  // A frequency as people write one: 151.5, 151.5M, 151.5MHz, 151500k,
  // 151500000. A bare number up to 2000 is MHz, from 100000 up is Hz, and the
  // gap between is refused rather than guessed.
  function parseFreq(raw) {
    const m = /^\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*(g|ghz|m|mhz|k|khz|hz)?\s*$/i.exec(String(raw));
    if (!m) return bad('a frequency, e.g. 151.5 (MHz)');
    const v = parseFloat(m[1]), u = (m[2] || '').toLowerCase();
    let hz;
    if (u === 'g' || u === 'ghz') hz = v * 1e9;
    else if (u === 'm' || u === 'mhz') hz = v * 1e6;
    else if (u === 'k' || u === 'khz') hz = v * 1e3;
    else if (u === 'hz') hz = v;
    else if (v <= 2000) hz = v * 1e6;
    else if (v >= 100000) hz = v;
    else return bad('say MHz (151.5) or Hz (151500000)');
    hz = Math.round(hz);
    if (hz < 500000 || hz > 1766000000) return bad('0.5 to 1766 MHz');
    return ok(hz);
  }

  function parseRate(raw) {
    const m = /^\s*([0-9]+(?:\.[0-9]*)?)\s*(m|msps|k|ksps|sps)?\s*$/i.exec(String(raw));
    if (!m) return bad('one of ' + RATES.join(', '));
    const u = (m[2] || '').toLowerCase();
    const v = Math.round(parseFloat(m[1]) * (u[0] === 'm' ? 1e6 : u[0] === 'k' ? 1e3 : 1));
    return RATES.indexOf(v) >= 0 ? ok(v) : bad('one of ' + RATES.join(', '));
  }

  function num(raw, lo, hi, dp, what) {
    const s = String(raw).trim();
    if (!/^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/.test(s)) return bad(what);
    const v = Number(s);
    if (!(v >= lo && v <= hi)) return bad(what);
    const f = Math.pow(10, dp || 0);
    return ok(Math.round(v * f) / f);
  }

  // One setting from text, in the command's units. { ok, value } or { ok: false, error }.
  function parseSetting(key, raw) {
    if (raw == null || String(raw).trim() === '') return bad('no value');
    const s = String(raw).trim();
    switch (key) {
      case 'freq': return parseFreq(s);
      case 'rate': return parseRate(s);
      case 'gain': return /^auto$/i.test(s) ? ok(null) : num(s.replace(/db$/i, ''), -10, 50, 1, 'dB from -10 to 50, or auto');
      case 'agc': case 'gate': case 'bias': return onOff(s);
      case 'ppm': return num(s, -200, 200, 0, 'whole ppm from -200 to 200');
      case 'fmt': { const f = FMT_ALIAS[s.toUpperCase()]; return f ? ok(f) : bad('ABF, EIF or ASC'); }
      case 'squelch': return num(s.replace(/db$/i, ''), 2, 40, 0, 'whole dB from 2 to 40');
      case 'offset': {
        const r = num(s.replace(/khz$/i, ''), -1200, 1200, 3, 'kHz from -1200 to 1200');
        return r.ok ? ok(Math.round(r.value * 1000)) : r;
      }
      case 'direct': { const d = s.toLowerCase(); return DIRECT.indexOf(d) >= 0 ? ok(d) : bad(DIRECT.join(', ')); }
      case 'model': { const m = s.toLowerCase(); return MODELS.indexOf(m) >= 0 ? ok(m) : bad(MODELS.join(', ')); }
      case 'spec': case 'lvl': return num(s.replace(/s$/i, ''), 0, 600, 0, 'whole seconds, 0 for off');
      default: return bad('no setting called ' + key);
    }
  }

  // A setting as text, in the command's units — what CFG lines carry.
  function formatSetting(key, v) {
    switch (key) {
      case 'freq': return (v / 1e6).toFixed(6);
      case 'gain': return v == null ? 'auto' : (Math.round(v * 10) / 10).toFixed(1);
      case 'agc': case 'gate': case 'bias': return v ? '1' : '0';
      case 'offset': return String(Math.round(v) / 1000);
      default: return String(v);
    }
  }

  // The offset the decoder's channel may sit at: inside the band, clear of
  // its edge by a channel's width (serial-sdr.js's rule).
  function offsetLimit(rate) { return rate / 2 - 12000; }

  // ── console commands ───────────────────────────────────────────────────────
  //
  // `VERB args…`, case-insensitive. CFG takes key=value pairs; SET takes a key
  // and a value; the setting verbs are shorthand for SET. Parsed here so the
  // card can build what the relay will accept, and the test can hold both.
  const VERB_KEY = { FREQ: 'freq', RATE: 'rate', GAIN: 'gain', AGC: 'agc', PPM: 'ppm', FORMAT: 'fmt', FMT: 'fmt',
    GATE: 'gate', SQUELCH: 'squelch', SQ: 'squelch', OFFSET: 'offset', DIRECT: 'direct', MODEL: 'model', SPEC: 'spec',
    LVL: 'lvl', LEVEL: 'lvl', BIAS: 'bias' };
  const VERBS = ['HELP', 'HELLO', 'INFO', 'STATUS', 'CFG', 'SET', 'TIME', 'DECODE', 'RESTART', 'DEFAULTS'].concat(Object.keys(VERB_KEY));

  // { verb, args, set: {key: value} } — `set` already parsed and checked — or
  // { verb, error } naming what was wrong. An empty line is { verb: '' }.
  function parseCommand(line) {
    const words = String(line || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { verb: '', args: [] };
    const verb = words[0].toUpperCase(), args = words.slice(1);
    if (VERBS.indexOf(verb) < 0) return { verb, args, error: 'UNKNOWN' };
    const take = (key, raw, into) => {
      const r = parseSetting(key, raw);
      if (!r.ok) return key + ': ' + r.error;
      into[key] = r.value;
      return null;
    };
    if (verb === 'CFG') {
      const set = {};
      for (const a of args) {
        const i = a.indexOf('=');
        if (i <= 0) return { verb, args, error: 'ARG ' + a + ' is not key=value' };
        const key = a.slice(0, i).toLowerCase();
        if (SETTING_KEYS.indexOf(key) < 0) return { verb, args, error: 'ARG no setting called ' + key };
        const e = take(key, a.slice(i + 1), set);
        if (e) return { verb, args, error: 'ARG ' + e };
      }
      return { verb, args, set };
    }
    if (verb === 'SET') {
      const key = (args[0] || '').toLowerCase();
      if (SETTING_KEYS.indexOf(key) < 0) return { verb, args, error: 'ARG SET <setting> <value>' };
      const set = {};
      const e = take(key, args.slice(1).join(' '), set);
      return e ? { verb, args, error: 'ARG ' + e } : { verb, args, set };
    }
    if (VERB_KEY[verb]) {
      const key = VERB_KEY[verb];
      if (!args.length) return { verb, args, show: key };
      // The bias tee puts 4.5 V on the antenna socket: typed by hand it takes
      // a YES. The card asks in the browser first and sends `BIAS ON YES`.
      if (key === 'bias') {
        const r = onOff(args[0]);
        if (!r.ok) return { verb, args, error: 'ARG bias: say on or off' };
        if (r.value && (args[1] || '').toUpperCase() !== 'YES') return { verb, args, error: 'CONFIRM BIAS ON YES puts 4.5 V on the antenna socket' };
        return { verb, args, set: { bias: r.value } };
      }
      const set = {};
      const e = take(key, args.join(' '), set);
      return e ? { verb, args, error: 'ARG ' + e } : { verb, args, set };
    }
    if (verb === 'TIME') {
      if (!args.length) return { verb, args };
      const t = Number(args[0]);
      if (!/^[0-9]{9,11}(\.[0-9]+)?$/.test(args[0]) || !(t > 1.5e9 && t < 4.2e9)) return { verb, args, error: 'ARG TIME <Unix seconds, UTC>' };
      return { verb, args, epoch: t };
    }
    if (verb === 'DECODE') {
      const s = args.length ? Number(args[0]) : 3;
      if (!(s >= 1 && s <= 8)) return { verb, args, error: 'ARG DECODE <1 to 8 seconds>' };
      return { verb, args, seconds: s };
    }
    if (verb === 'DEFAULTS' && (args[0] || '').toUpperCase() !== 'YES') return { verb, args, error: 'CONFIRM DEFAULTS YES puts every setting back' };
    return { verb, args };
  }

  // `CFG freq=151.500000 rate=240000 …` — one line that sets the Pi to `s`.
  function cfgCommand(s, keys) {
    return 'CFG ' + (keys || CARD_KEYS).filter(k => k in s).map(k => k + '=' + formatSetting(k, s[k])).join(' ');
  }

  // The one-setting command a control sends: `FREQ 151.512500`, `GAIN AUTO`.
  function setCommand(key, v) {
    switch (key) {
      case 'freq': return 'FREQ ' + formatSetting('freq', v);
      case 'gain': return 'GAIN ' + formatSetting('gain', v).toUpperCase();
      case 'bias': return v ? 'BIAS ON YES' : 'BIAS OFF';
      case 'agc': case 'gate': return key.toUpperCase() + (v ? ' ON' : ' OFF');
      case 'fmt': return 'FORMAT ' + v;
      case 'direct': return 'DIRECT ' + String(v).toUpperCase();
      case 'model': return 'MODEL ' + String(v).toUpperCase();
      default: return key.toUpperCase() + ' ' + formatSetting(key, v);
    }
  }

  // What the console answers to HELP, one `HELP,` line each, then OK.
  const HELP = [
    'MegaNet SDR Pi - type a command and press Enter. Each ends in OK or ERR.',
    'CFG                          every setting, as one line',
    'CFG freq=151.5 gain=29.7 ... set several at once (MegaNet\'s card copies this for you)',
    'FREQ 151.5                   tune, MHz (or 151500000 in Hz)',
    'OFFSET 12.5                  the decoder\'s channel, kHz from the centre',
    'RATE 240000                  240000 960000 1200000 1920000 2400000',
    'GAIN 29.7 | GAIN AUTO        tuner gain, dB',
    'PPM -3                       the stick\'s frequency error',
    'FORMAT ABF | EIF | ASC       ALERT Binary, Enhanced iFLOWS, ALERT ASCII - one at a time',
    'GATE ON | OFF  SQUELCH 8     decode bursts only, and how far over the floor one is',
    'AGC ON | OFF                 the RTL2832U\'s own AGC',
    'BIAS ON YES | BIAS OFF       4.5 V on the antenna socket (V2, V3, V4)',
    'DIRECT AUTO|OFF|I|Q  MODEL AUTO|V2|V3|V4|R820T|R828D|FC0013|FC0012',
    'SPEC 5  LVL 2                seconds between spectrum / level records, 0 for none',
    'TIME 1790843760              set the clock (Unix seconds, UTC) - MegaNet\'s card copies this too',
    'STATUS  INFO  DECODE 3  RESTART  DEFAULTS YES',
    'Settings are kept on the Pi and survive a restart.',
  ];

  // ── writing records (the relay) ──────────────────────────────────────────────

  // Text safe for a field: printable ASCII, no commas, no line breaks.
  function clean(v, max) {
    const s = String(v == null ? '' : v).replace(/[^\x20-\x7e]/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max) : s;
  }

  // A value as a field: null/undefined/NaN → empty; numbers as given (the
  // caller rounds); booleans 1/0; text cleaned.
  function field(v) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') return String(v);
    return clean(v);
  }

  // A record from an object, in the order `fields` (or the built-in list) says.
  function record(type, obj, fields) {
    const names = fields || DEFAULT_FIELDS[type];
    const vals = names.map(n => field(obj[n]));
    if (TAIL[type]) vals[vals.length - 1] = clean(obj[TAIL[type]], 400);
    return type + ',' + vals.join(',');
  }

  // A key,value record: SDRPI and CFG.
  function kvRecord(type, pairs) {
    const out = [type];
    Object.keys(pairs).forEach(k => { if (pairs[k] != null) out.push(clean(k), field(pairs[k])); });
    return out.join(',');
  }

  function cfgRecord(s) {
    const p = {};
    SETTING_KEYS.forEach(k => { if (k in s) p[k] = formatSetting(k, s[k]); });
    return kvRecord('CFG', p);
  }

  function fieldsRecords() {
    return Object.keys(DEFAULT_FIELDS).map(t => 'FIELDS,' + t + ',' + DEFAULT_FIELDS[t].join(','));
  }

  // A record a terminal does not show. BEL ends it: shorter than ESC \, and
  // PuTTY, xterm and Windows Terminal all take it.
  function hide(line) { return '\x1b]' + OSC_ID + ';' + line + '\x07'; }

  // ── packing: 64 levels a character ──────────────────────────────────────────
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_INDEX = B64.split('').reduce((m, ch, i) => { m[ch] = i; return m; }, {});
  const q6 = v => B64[Math.max(0, Math.min(63, Math.round(v)))];

  // A spectrum (dB, negative frequencies first) as `bins` characters: the
  // strongest of each group of FFT bins, so a narrow carrier survives, on a
  // 64-step scale from `lo` in steps of `step` dB (at least 1).
  function packSpectrum(db, bins) {
    const n = db.length, nb = Math.max(1, Math.min(bins || 256, n)), per = n / nb;
    const pooled = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let m = -Infinity;
      for (let k = Math.floor(b * per), e = Math.floor((b + 1) * per); k < e; k++) if (db[k] > m) m = db[k];
      pooled[b] = m;
    }
    const sorted = Float32Array.from(pooled).sort();
    const lo = Math.floor(sorted[Math.floor(nb * 0.05)]) - 3;
    const step = Math.max(1, Math.ceil((sorted[nb - 1] - lo) / 63));
    let s = '';
    for (let b = 0; b < nb; b++) s += q6((pooled[b] - lo) / step);
    return { lo, step, bins: s };
  }
  function unpackSpectrum(lo, step, bins) {
    const out = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) out[i] = lo + (B64_INDEX[bins[i]] || 0) * step;
    return out;
  }

  // The ADC histogram's 32 counts, as the card draws them: on a square-root
  // scale against the fullest bin, and never rounding a count that is there to
  // nothing — an end bin with anything in it is clipping, and is drawn red.
  function packHist(hist) {
    let mx = 0;
    for (let i = 0; i < hist.length; i++) if (hist[i] > mx) mx = hist[i];
    let s = '';
    for (let i = 0; i < hist.length; i++) s += hist[i] > 0 ? q6(Math.max(1, 63 * Math.sqrt(hist[i] / mx))) : 'A';
    return s;
  }
  function unpackHist(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) { const v = (B64_INDEX[s[i]] || 0) / 63; out.push(v * v); }
    return out;
  }

  // Soft symbols, clamped to ±3 as the card draws them.
  function packSymbols(sym, from, to) {
    let s = '';
    for (let i = from; i < to; i++) s += q6((Math.max(-3, Math.min(3, sym[i])) + 3) / 6 * 63);
    return s;
  }
  function unpackSymbols(s) {
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = (B64_INDEX[s[i]] || 0) / 63 * 6 - 3;
    return out;
  }

  // A decode's trace — the symbols the card draws, and the frames boxed on
  // them — cut to the part the card shows: thirty symbols before the first
  // frame to seventy after the last, or the first `cap` when none was found.
  function packTrace(trace, cap) {
    const sym = trace.symbols, frames = trace.frames || [];
    let a = 0, b = Math.min(sym.length, cap || 1200);
    if (frames.length) {
      a = Math.max(0, Math.min.apply(null, frames.map(f => f.pos)) - 30);
      b = Math.min(sym.length, Math.max.apply(null, frames.map(f => f.pos)) + 70);
    }
    return {
      start: a,
      frames: frames.map(f => f.pos + ':' + f.sensorId + ':' + f.value + ':' + (f.inv ? 1 : 0)).join(';'),
      symbols: packSymbols(sym, a, b),
    };
  }
  function unpackFrames(s, start) {
    if (!s) return [];
    return String(s).split(';').map(x => x.split(':')).filter(p => p.length >= 3).map(p => ({
      pos: Number(p[0]) - (start || 0), sensorId: Number(p[1]), value: Number(p[2]), inv: p[3] === '1',
    }));
  }
  function packShadows(shadows) {
    return (shadows || []).map(s => {
      const of = String(s.of || '').split('=');
      return s.sensorId + ':' + s.value + ':' + s.votes + ':' + (of[0] || '') + ':' + (of[1] || '');
    }).join(';');
  }
  function unpackShadows(s) {
    if (!s) return [];
    return String(s).split(';').map(x => x.split(':')).filter(p => p.length >= 3).map(p => ({
      sensorId: Number(p[0]), value: Number(p[1]), votes: Number(p[2]), of: p[3] ? p[3] + '=' + p[4] : '',
    }));
  }

  // ── reading what the Pi wrote (the card) ────────────────────────────────────

  function createSchema() {
    const fields = {};
    Object.keys(DEFAULT_FIELDS).forEach(k => { fields[k] = DEFAULT_FIELDS[k].slice(); });
    return { version: null, schema: null, fields };
  }

  function typed(rec) {
    const out = {};
    Object.keys(rec).forEach(k => {
      const v = rec[k];
      if (NUMERIC.has(k)) {
        if (v === '' || v == null) out[k] = null;
        else { const n = Number(v); out[k] = Number.isFinite(n) ? n : null; }
      } else out[k] = v == null ? '' : v;
    });
    return out;
  }

  function pairs(parts) {
    const o = {};
    for (let i = 1; i + 1 < parts.length; i += 2) o[parts[i]] = parts[i + 1];
    return o;
  }

  // CFG's raw pairs as settings, each parsed the way the console parses it;
  // a pair that does not parse is left out rather than guessed.
  function settingsFrom(raw) {
    const s = {};
    Object.keys(raw).forEach(k => {
      if (SETTING_KEYS.indexOf(k) < 0) return;
      const r = parseSetting(k, raw[k]);
      if (r.ok) s[k] = r.value;
    });
    return s;
  }

  // One line: { kind: 'record', type, rec | info | settings, hidden },
  // { kind: 'final', ok, detail, reason }, or { kind: 'text', text }.
  function parseLine(schema, line, hidden) {
    const comma = line.indexOf(',');
    const first = comma < 0 ? line : line.slice(0, comma);
    if (first === 'OK' || first === 'ERR') {
      const rest = comma < 0 ? '' : line.slice(comma + 1);
      return { kind: 'final', ok: first === 'OK', detail: first === 'OK' ? rest : '', reason: first === 'ERR' ? rest : '', hidden };
    }
    if (comma < 0 || RECORDS.indexOf(first) < 0) return { kind: 'text', text: line, hidden };
    const parts = line.split(',');
    if (first === 'SDRPI') {
      const info = pairs(parts);
      if (info.version) schema.version = info.version;
      if (info.schema) schema.schema = Number(info.schema);
      return { kind: 'record', type: first, info, raw: line, hidden };
    }
    if (first === 'FIELDS') {
      if (parts.length > 2 && /^[A-Z]+$/.test(parts[1])) schema.fields[parts[1]] = parts.slice(2);
      return { kind: 'record', type: first, of: parts[1], fields: parts.slice(2), raw: line, hidden };
    }
    if (first === 'CFG') {
      const raw = pairs(parts);
      return { kind: 'record', type: first, raw: line, cfg: raw, settings: settingsFrom(raw), hidden };
    }
    const names = schema.fields[first];
    let vals = parts.slice(1);
    if (TAIL[first] && vals.length > names.length) vals = vals.slice(0, names.length - 1).concat([vals.slice(names.length - 1).join(',')]);
    const rec = {};
    names.forEach((n, i) => { rec[n] = vals[i] != null ? vals[i] : ''; });
    for (let i = names.length; i < vals.length; i++) rec['_' + (i + 1)] = vals[i];
    return { kind: 'record', type: first, rec: typed(rec), raw: line, hidden };
  }

  // Bytes (or text) in, in whatever pieces they arrive; items out. Keeps the
  // half of a line or an escape sequence a piece ends in for the next piece.
  class Reader {
    constructor() {
      this.schema = createSchema();
      this.decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;
      this.line = '';
      this.state = 'text';
      this.osc = '';
    }

    feed(chunk) {
      const text = typeof chunk === 'string' ? chunk
        : this.decoder ? this.decoder.decode(chunk, { stream: true }) : String.fromCharCode.apply(null, Array.from(chunk));
      const out = [];
      for (let i = 0; i < text.length; i++) this.step(text[i], out);
      return out;
    }

    // The end of the stream: a last line with no line break after it.
    flush() {
      const out = [];
      this.endLine(out);
      return out;
    }

    endLine(out) {
      const line = this.line.trim();
      this.line = '';
      if (line) out.push(parseLine(this.schema, line, false));
    }

    endOsc(out) {
      const s = this.osc;
      this.osc = '';
      const semi = s.indexOf(';');
      const id = semi < 0 ? s : s.slice(0, semi), body = semi < 0 ? '' : s.slice(semi + 1);
      if (id === OSC_ID && body) out.push(parseLine(this.schema, body.trim(), true));
      else if ((id === '0' || id === '2') && body) out.push({ kind: 'title', text: body, hidden: true });
    }

    step(ch, out) {
      const c = ch.charCodeAt(0);
      switch (this.state) {
        case 'text':
          if (c === 0x0d || c === 0x0a) this.endLine(out);
          else if (c === 0x1b) this.state = 'esc';
          else if (c === 0x08) this.line = this.line.slice(0, -1);
          else if (c >= 0x20 && c !== 0x7f) { if (this.line.length < 8192) this.line += ch; }
          return;
        case 'esc':
          if (ch === '[') this.state = 'csi';
          else if (ch === ']') { this.state = 'osc'; this.osc = ''; }
          else this.state = 'text';
          return;
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) this.state = 'text';
          return;
        case 'osc':
          if (c === 0x07) { this.endOsc(out); this.state = 'text'; }
          else if (c === 0x1b) this.state = 'oscEsc';
          else if (c === 0x0d || c === 0x0a) { this.osc = ''; this.state = 'text'; this.endLine(out); }   // a cut-off sequence
          else if (this.osc.length < 65536) this.osc += ch;
          return;
        case 'oscEsc':
          // ESC \ ends the sequence. ESC and anything else ends it too, and
          // starts the next escape sequence.
          this.endOsc(out);
          this.state = 'text';
          if (ch !== '\\') { this.step('\x1b', out); this.step(ch, out); }
          return;
        default:
          this.state = 'text';
      }
    }
  }

  // Is this (the first part of) a Pi's log? Its hello, its field lists, or a
  // hidden record — any one is enough; nothing else writes them.
  function sniff(text) {
    const t = String(text || '');
    return /(^|[\r\n\x07])SDRPI,version,/.test(t) || /(^|[\r\n\x07])FIELDS,RX,seq,run,/.test(t)
      || t.indexOf('\x1b]' + OSC_ID + ';STAT,') >= 0 || t.indexOf('\x1b]' + OSC_ID + ';LVL,') >= 0;
  }

  // ── the card's settings and the Pi's ───────────────────────────────────────
  //
  // serial-sdr.js keeps gain in tenths of a dB with a separate tuner-AGC flag,
  // frame formats by the decoder's keys, and the channel offset in Hz; the Pi
  // keeps the console's units. These two are the only place that differs.

  function fromCard(cfg) {
    return {
      freq: Math.round(cfg.freq), rate: RATES.indexOf(+cfg.rate) >= 0 ? +cfg.rate : 240000,
      gain: cfg.autoGain ? null : Math.round(cfg.gain) / 10, agc: !!cfg.agc, ppm: Math.round(cfg.ppm || 0),
      fmt: FMT_CODE[cfg.format] || 'ABF', gate: cfg.gate !== false, squelch: Math.round(cfg.squelch || 8),
      offset: Math.round(cfg.offsetHz || 0), bias: !!cfg.bias, direct: cfg.direct || 'auto', model: cfg.model || 'auto',
    };
  }

  function toCard(s) {
    const c = {};
    if (s.freq != null) c.freq = s.freq;
    if (s.rate != null) c.rate = s.rate;
    if ('gain' in s) { c.autoGain = s.gain == null; if (s.gain != null) c.gain = Math.round(s.gain * 10); }
    if (s.agc != null) c.agc = !!s.agc;
    if (s.ppm != null) c.ppm = s.ppm;
    if (s.fmt) c.format = FMT_KEY[s.fmt] || 'BINARY';
    if (s.gate != null) c.gate = !!s.gate;
    if (s.squelch != null) c.squelch = s.squelch;
    if (s.offset != null) c.offsetHz = s.offset;
    if (s.bias != null) c.bias = !!s.bias;
    if (s.direct) c.direct = s.direct;
    if (s.model) c.model = s.model;
    return c;
  }

  return {
    SCHEMA, VERSION, OSC_ID, RECORDS, DEFAULT_FIELDS, NUMERIC, RATES, MODELS, DIRECT, SETTING_KEYS, CARD_KEYS,
    FMT_KEY, FMT_CODE, FMT_LABEL, HELP,
    defaults, parseSetting, formatSetting, offsetLimit, parseCommand, cfgCommand, setCommand,
    clean, record, kvRecord, cfgRecord, fieldsRecords, hide,
    packSpectrum, unpackSpectrum, packHist, unpackHist, packSymbols, unpackSymbols, packTrace, unpackFrames,
    packShadows, unpackShadows,
    createSchema, parseLine, Reader, sniff, fromCard, toCard,
  };
})();

// sdr-pi/relay.js requires this same file to write what the card reads, and
// test/sdrpi.mjs to read what the relay wrote. Guarded so the browser, where
// `module` is undefined, never runs it. Constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = SdrPi;
