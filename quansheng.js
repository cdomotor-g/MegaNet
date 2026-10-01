// MegaNet — quansheng.js
//
//   Quansheng   the codec for the ALERT receiver firmware on a Quansheng UV-K5
//               V3 / UV-K1 (cdomotor-g/quansheng_alert_v3, schema 2): what the
//               radio sends on its USB serial port, what it accepts, and the
//               station table it keeps in SPI flash. Text in, structures out;
//               commands and table bytes back.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches for nothing: no DOM, no state, no other module. serial-radio.js is
// the dashboard that drives a radio with it, and test/quansheng.mjs requires
// this same file and holds it against every example line in the firmware's
// own interface document — the guarded module.exports at the foot is how.
//
// ── The source of truth ──────────────────────────────────────────────────────
//
// docs/ALERT_SERIAL.md in that repository, "written for people and for
// software agents. A client built from this page alone should work." Section
// numbers below (§n) are its sections. The parts a client gets wrong:
//
//   * DTR. The radio sends only while the host holds DTR, and a send the host
//     does not collect clears its flag: silence until DTR is asserted again
//     (§2). The dashboard toggles it on open and after 25 s of nothing.
//   * Four classes of line, classified in order: final (OK/ERR), record
//     (HDR DEC BST STA EVT), debug (no comma, a space), data (§3). Records
//     arrive in the middle of a command's reply, and belong to the stream.
//   * Fields are mapped by name from the latest HDR line, never by position;
//     fields are only ever appended within schema 2 (§4).
//   * One console command at a time, each ending in exactly one OK or ERR
//     (§7.1). The radio's receive ring is 256 bytes.
//   * EVT's detail runs to the end of the line and may hold commas (§5.5).
//   * Binary 0xABCD frames share the port and are cut out by their length
//     field before any of the above sees a byte (§10).

const Quansheng = (function () {
  const USB_VID = 0x36B7;          // §2: find the port by VID, not by name
  const USB_PID = 0xFFFF;
  const SCHEMA = 2;
  const RECORDS = ['HDR', 'DEC', 'BST', 'STA', 'EVT'];

  // §5's field lists: what a client uses until the radio's own HDR block
  // arrives. Every one is replaced by name when it does.
  const DEFAULT_FIELDS = {
    DEC: 'seq,epoch,uptime_ms,boot,id,name,kind,value,eng,unit,fmt,pol,inv,frame,rssi,nf,sens,fade,burst_ms,payload_hex,payload_bin'.split(','),
    BST: 'seq,epoch,uptime_ms,peak,nf,burst_ms,nframes,nbits,bits_hex'.split(','),
    STA: 'epoch,uptime_ms,nf,rssi,sq,batt_mv,batt_pct,bursts,decodes,min_ok,log_state,log_count,log_cap,stn_src'.split(','),
    EVT: 'epoch,uptime_ms,code,detail'.split(','),
  };

  // Fields that are numbers. An empty field is "unknown" (null), and an epoch
  // of 0 is treated as empty (§5.2).
  const NUMERIC = new Set(['seq', 'epoch', 'uptime_ms', 'boot', 'id', 'value', 'inv', 'frame', 'rssi', 'nf',
    'sens', 'fade', 'burst_ms', 'peak', 'nframes', 'nbits', 'sq', 'batt_mv', 'batt_pct', 'bursts', 'decodes',
    'min_ok', 'log_count', 'log_cap']);

  function createSchema() {
    const fields = {};
    Object.keys(DEFAULT_FIELDS).forEach(k => { fields[k] = DEFAULT_FIELDS[k].slice(); });
    return { fw: null, schema: null, fields, fromRadio: {} };
  }

  // §3: final, record, debug or data — in that order.
  function classify(line) {
    const first = line.split(',', 1)[0];
    if (first === 'OK' || first === 'ERR') return 'final';
    if (line.indexOf(',') >= 0 && (RECORDS.indexOf(first) >= 0 || first === 'ALERT')) return 'record';
    if (line.indexOf(',') < 0 && line.indexOf(' ') >= 0) return 'debug';
    return 'data';
  }

  // HDR,fw,<hash>,schema,2 — or HDR,<TYPE>,<field>,… (§5.1). Mutates the schema.
  function applyHeader(schema, parts) {
    if (parts[1] === 'fw') {
      schema.fw = parts[2] || null;
      const i = parts.indexOf('schema');
      schema.schema = i >= 0 ? Number(parts[i + 1]) : null;
      return { kind: 'fw', fw: schema.fw, schema: schema.schema };
    }
    if (parts.length > 2) {
      schema.fields[parts[1]] = parts.slice(2);
      schema.fromRadio[parts[1]] = true;
      return { kind: 'fields', type: parts[1], fields: parts.slice(2) };
    }
    return null;
  }

  function typed(rec) {
    const out = {};
    Object.keys(rec).forEach(k => {
      const v = rec[k];
      if (NUMERIC.has(k)) {
        if (v === '' || v == null) out[k] = null;
        else {
          const n = Number(v);
          out[k] = Number.isFinite(n) ? n : null;
          if (k === 'epoch' && out[k] === 0) out[k] = null;
        }
      } else out[k] = v == null ? '' : v;
    });
    return out;
  }

  // Map a record line's fields by name. Unknown trailing fields are kept under
  // their position, so nothing the radio adds is lost; EVT's detail swallows
  // the rest of the line, commas and all.
  function parseRecord(schema, line) {
    const parts = line.split(',');
    const type = parts[0];
    if (type === 'HDR') return { type, header: applyHeader(schema, parts) };
    if (type === 'ALERT') return { type, legacy: true, raw: line };   // pre-V2 line (§3): a record, ignored
    const names = schema.fields[type];
    if (!names) return { type, unknown: true, raw: line };
    let vals = parts.slice(1);
    if (type === 'EVT' && vals.length > names.length) {
      vals = vals.slice(0, names.length - 1).concat([vals.slice(names.length - 1).join(',')]);
    }
    const rec = {};
    names.forEach((n, i) => { rec[n] = vals[i] != null ? vals[i] : ''; });
    for (let i = names.length; i < vals.length; i++) rec['_' + (i + 1)] = vals[i];   // §5's 1-based field numbers
    return { type, rec: typed(rec), raw: line };
  }

  // ── console replies (§7.3) ───────────────────────────────────────────────────

  function parseFinal(line) {
    const i = line.indexOf(',');
    const head = i < 0 ? line : line.slice(0, i);
    const detail = i < 0 ? '' : line.slice(i + 1);
    return { ok: head === 'OK', reason: head === 'ERR' ? detail : '', detail: head === 'OK' ? detail : '' };
  }

  // A reply data line, shaped by what its first field says it is.
  function parseData(schema, line) {
    const p = line.split(',');
    const t = p[0];
    switch (t) {
      case 'GET':  return { type: t, name: p[1], value: p.slice(2).join(',') };
      case 'INFO': return { type: t, key: p[1], values: p.slice(2) };
      case 'TIME': return { type: t, epoch: p[1] ? Number(p[1]) || null : null };
      case 'HELP': return { type: t, text: p.slice(1).join(',') };
      case 'SCR':  return { type: t, row: Number(p[1]), hex: p[2] || '' };
      case 'SPI':  return { type: t, addr: parseInt(p[1], 16), hex: p[2] || '' };
      case 'LOG': {
        if (p.length === 6) {           // LOG STAT: count, capacity, oldest, newest, state
          return { type: t, stat: true, count: Number(p[1]) || 0, cap: Number(p[2]) || 0,
            oldest: p[3] ? Number(p[3]) : null, newest: p[4] ? Number(p[4]) : null, state: p[5] };
        }
        const names = schema.fields.DEC;  // LOG DUMP: the 21 DEC fields
        const rec = {};
        names.forEach((n, i) => { rec[n] = p[i + 1] != null ? p[i + 1] : ''; });
        return { type: t, record: typed(rec) };
      }
      case 'STN': {
        if (/^\d+$/.test(p[1] || '') && p.length <= 4) {   // STN GET: id, name, kind
          return { type: t, lookup: true, id: Number(p[1]), name: p[2] || '', kind: p[3] || '' };
        }
        return { type: t, info: true, source: p[1] || '', count: Number(p[2]) || 0, crc: p[3] || '', state: p[4] || '' };
      }
      default: return { type: t, raw: line };
    }
  }

  // ── the 32 payload bits (alert_decode.c, via alertmon.py) ────────────────────
  //
  // Bit 31 − (8k + i) of the payload is bit i of the frame's k-th word, bits
  // LSB first on air (§5.2). P(p) below is the p-th bit as transmitted.

  function crc6Msb(bits, nbits) {
    let reg = 0;
    for (let i = nbits - 1; i >= 0; i--) {
      const b = Math.floor(bits / Math.pow(2, i)) & 1;
      const fb = ((reg >> 5) & 1) ^ b;
      reg = (reg << 1) & 0x3f;
      if (fb) reg ^= 0x19;
    }
    return reg;
  }

  function decodePayload32(payload) {
    const v = typeof payload === 'string' ? parseInt(payload, 16) >>> 0 : payload >>> 0;
    const P = p => (v >>> (31 - p)) & 1;
    const lsb = (p, n) => { let s = 0; for (let i = 0; i < n; i++) s |= P(p + i) << i; return s; };
    const msb = (p, n) => { let s = 0; for (let i = 0; i < n; i++) s = (s << 1) | P(p + i); return s; };
    const k1 = (P(6) << 1) | P(7), k2 = (P(14) << 1) | P(15);
    if (k1 === 2 && k2 === 2) {
      if (P(22) && P(23) && P(30) && P(31)) {
        return { fmt: 'ABF', id: lsb(0, 6) | (lsb(8, 6) << 6) | (lsb(16, 1) << 12), value: lsb(17, 5) | (lsb(24, 6) << 5) };
      }
      return null;
    }
    if (k1 === 3) {
      const a = lsb(0, 6) | (lsb(8, 7) << 6);
      const d = lsb(15, 1) | (lsb(16, 8) << 1) | (lsb(24, 2) << 9);
      if (crc6Msb(a * 2048 + d, 24) === msb(26, 6)) return { fmt: 'EIF', id: a, value: d };
    }
    return null;
  }

  // What each of the 32 transmitted bits is, for drawing: A address, D data,
  // K marker, R CRC. Same letters as the ALERT Packets tab's bit cells.
  function payloadRoles(fmt) {
    const r = new Array(32).fill('K');
    const set = (from, n, c) => { for (let i = 0; i < n; i++) r[from + i] = c; };
    if (fmt === 'ABF') {
      set(0, 6, 'A'); set(8, 6, 'A'); set(16, 1, 'A'); set(17, 5, 'D'); set(24, 6, 'D');
    } else if (fmt === 'EIF') {
      set(0, 6, 'A'); set(8, 7, 'A'); set(15, 1, 'D'); set(16, 8, 'D'); set(24, 2, 'D'); set(26, 6, 'R');
    }
    return r;
  }

  // The 32 bits of a payload as transmitted, P(0) first.
  function payloadBits(hex) {
    const v = parseInt(hex, 16) >>> 0;
    const out = [];
    for (let p = 0; p < 32; p++) out.push((v >>> (31 - p)) & 1);
    return out;
  }

  // BST bits_hex: MSB first, the first bit of the burst is the top bit of the
  // first byte; bits past nbits mean nothing (§5.3).
  function burstBits(hex, nbits) {
    const n = Math.min(nbits == null ? hex.length * 4 : nbits, hex.length * 4);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const byte = parseInt(hex.substr((i >> 3) * 2, 2), 16) || 0;
      out[i] = (byte >> (7 - (i & 7))) & 1;
    }
    return out;
  }

  // UART emulation over a BST line's one-bit-per-baud bits: alertmon.py's
  // scan_polarity, run in both senses and both framings as that tool runs it.
  // Lets the dashboard mark where in a burst the radio's frames sit, and say
  // when a burst it heard holds a frame it did not report.
  function scanBurst(bits) {
    const out = [];
    const n = bits.length;
    for (let inv = 0; inv < 2; inv++) {
      const b = inv ? Array.from(bits, x => x ^ 1) : bits;
      for (const pol of ['NEG', 'STD']) {
        const idle = pol === 'NEG' ? 0 : 1, start = idle ^ 1;
        let words = [], wpos = [], pos = 0, found = 0;
        while (pos + 10 <= n && found < 8) {
          if (b[pos] !== start || (pos > 0 && b[pos - 1] !== idle)) { pos++; continue; }
          if (b[pos + 9] !== idle) { pos++; words = []; wpos = []; continue; }
          let w = 0;
          for (let i = 0; i < 8; i++) w |= b[pos + 1 + i] << i;
          if (words.length && pos - (wpos[wpos.length - 1] + 10) > 20) { words = []; wpos = []; }
          if (words.length === 4) { words.shift(); wpos.shift(); }
          words.push(w); wpos.push(pos);
          pos += 10;
          if (words.length === 4) {
            let payload = 0;
            for (let k = 0; k < 4; k++) for (let i = 0; i < 8; i++) if ((words[k] >> i) & 1) payload += Math.pow(2, 31 - (8 * k + i));
            const r = decodePayload32(payload);
            if (r) {
              out.push({ fmt: r.fmt, id: r.id, value: r.value, pos: wpos[0], pol, inv, hex: hex8(payload) });
              found++;
              words = []; wpos = [];
            }
          }
        }
      }
    }
    return out;
  }

  // SCREEN: 8 rows of 128 bytes; pixel(x, y) = (row[y >> 3][x] >> (y & 7)) & 1,
  // a set bit lit (§9). Row 0 is the status line. Returns 128 × 64 bytes, 1 lit.
  function decodeScreen(rows) {
    const px = new Uint8Array(128 * 64);
    for (let r = 0; r < 8; r++) {
      const hex = rows[r] || '';
      for (let x = 0; x < 128; x++) {
        const b = parseInt(hex.substr(x * 2, 2), 16) || 0;
        for (let bit = 0; bit < 8; bit++) px[(r * 8 + bit) * 128 + x] = (b >> bit) & 1;
      }
    }
    return px;
  }

  // ── binary 0xABCD frames (§10) ───────────────────────────────────────────────

  const OBFUS = [0x16, 0x6C, 0x14, 0xE6, 0x2E, 0x91, 0x0D, 0x40, 0x21, 0x35, 0xD5, 0x40, 0x13, 0x03, 0xE9, 0x80];
  const BOOTLOADER_IDS = [0x0518, 0x0530];   // the stock bootloader's beacons: the radio is in DFU
  const FRAME = { HELLO: 0x0514, HELLO_REPLY: 0x0515, REBOOT: 0x05DD, DFU_CHECK: 0x05E1 };

  function crc16xmodem(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = ((crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)) & 0xffff;
    }
    return crc;
  }

  // AB CD | len | obfuscated(ID, data_len, data, CRC-16/XMODEM) | DC BA —
  // byte for byte what the firmware's own tools build.
  function makeFrame(id, body) {
    body = body ? Array.from(body) : [];
    const m = [id & 0xff, id >> 8, body.length & 0xff, body.length >> 8].concat(body);
    if (m.length & 1) m.push(0);
    const crc = crc16xmodem(m);
    const payload = m.concat([crc & 0xff, crc >> 8]).map((b, i) => b ^ OBFUS[i % 16]);
    return new Uint8Array([0xAB, 0xCD, m.length & 0xff, m.length >> 8].concat(payload, [0xDC, 0xBA]));
  }

  // A frame's message, de-obfuscated: { id, data }. Radio frames carry FF FF
  // where a CRC would be — not checked (§10).
  function readFrame(raw) {
    const size = raw[2] | (raw[3] << 8);
    const m = [];
    for (let i = 0; i < size; i++) m.push(raw[4 + i] ^ OBFUS[i % 16]);
    const id = m[0] | (m[1] << 8);
    const len = m[2] | (m[3] << 8);
    return { id, data: m.slice(4, 4 + len) };
  }

  // Bytes in, text lines and binary frames out. Frames are cut out whole by
  // their length field; the firmware sends each line and each frame as one
  // write, so a frame never lands inside a line, and 0xAB never appears in its
  // text. alertterm.py's LineReader, in JavaScript.
  class LineReader {
    constructor() { this.buf = []; this.bootloader = false; }
    feed(u8) {
      for (let i = 0; i < u8.length; i++) this.buf.push(u8[i]);
      const lines = [], frames = [];
      const buf = this.buf;
      while (buf.length) {
        const i = buf.indexOf(0xAB);
        if (i < 0) {
          let cut = -1;
          for (let k = buf.length - 1; k >= 0; k--) if (buf[k] === 10 || buf[k] === 13) { cut = k; break; }
          this.text(buf.splice(0, cut + 1), lines);
          if (buf.length > 1024) buf.length = 0;    // no line end in 1 KB: noise, not a line
          break;
        }
        if (i) { this.text(buf.splice(0, i).concat([10]), lines); continue; }
        if (buf.length < 4) break;
        if (buf[1] !== 0xCD) { buf.splice(0, 1); continue; }
        const size = buf[2] | (buf[3] << 8);
        if (size > 512) { buf.splice(0, 2); continue; }
        if (buf.length < size + 8) break;
        if (buf[size + 6] !== 0xDC || buf[size + 7] !== 0xBA) { buf.splice(0, 2); continue; }
        const raw = buf.splice(0, size + 8);
        if (size >= 2) {
          const f = readFrame(raw);
          f.raw = raw;
          if (BOOTLOADER_IDS.indexOf(f.id) >= 0) this.bootloader = true;
          frames.push(f);
        }
      }
      return { lines, frames };
    }
    // Control bytes and non-ASCII are never part of a line: dropping them keeps
    // connect-time garbage from gluing onto the next one.
    text(bytes, out) {
      let cur = '';
      for (const b of bytes) {
        if (b === 10 || b === 13) { const t = cur.trim(); if (t) out.push(t); cur = ''; }
        else if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
      }
      const t = cur.trim();
      if (t) out.push(t);
    }
  }

  // ── settings (§7.4) ─────────────────────────────────────────────────────────

  const SETTINGS = [
    { name: 'VOICE', values: ['OFF', 'ON'], def: 'OFF', note: 'Read new readings out loud' },
    { name: 'SPEAKER', values: ['OFF', 'SQL', 'ON'], def: 'SQL', note: 'SQL: speaker on only while the squelch is open' },
    { name: 'CSV_OUT', values: ['OFF', 'ON'], def: 'ON', note: 'The DEC/BST/STA/EVT stream this dashboard draws. The console answers either way.' },
    { name: 'LOG', values: ['OFF', 'ON'], def: 'ON', note: 'Append each reading to the radio\'s flash log' },
    { name: 'UNKNOWN', values: ['SHOW', 'HIDE'], def: 'SHOW', note: 'HIDE keeps addresses not in the station table off the screen and out of the voice. The stream and the log still carry them.' },
    { name: 'CONFIRM', values: ['OFF', '2 COPIES'], def: 'OFF', note: 'Require the same reading twice in one burst' },
    { name: 'SQ_GATE', values: ['OFF', 'ON'], def: 'ON', note: 'A burst must peak 15 dB over the noise floor to count' },
    { name: 'SNR_REQ', min: 6, max: 20, step: 1, def: '12', unit: 'dB', note: 'dB over the floor assumed needed to decode; sets the sensitivity estimate and fade margin' },
    { name: 'DEBUG', values: ['OFF', 'ON'], def: 'OFF', note: 'Adds the D heartbeat and raw A lines' },
    { name: 'FREQ_MHZ', min: 130, max: 174, step: 0.0125, def: '', unit: 'MHz', inApp: true, note: 'Receive frequency, to the nearest 12.5 kHz channel. Only while the ALERT app runs.' },
    { name: 'SQL_LEVEL', min: 0, max: 9, step: 0.5, def: '', inApp: true, note: 'Squelch level. Only while the ALERT app runs.' },
    { name: 'CENSUS', rerun: true, inApp: true, note: 'The audio route the app chose. "+" re-runs the census. Only while the ALERT app runs.' },
    { name: 'MDM_MODE', readOnly: true, note: 'Modem mode — read-only' },
  ];

  // SET name value, with `_` for a space in either (§7.4).
  function setCommand(name, value) {
    return 'SET ' + String(name).replace(/ /g, '_') + ' ' + String(value).trim().replace(/ /g, '_');
  }

  // §7.4: a value is checked whole before anything changes; this says up front
  // what the radio would answer ERR,ARGS or ERR,RANGE to.
  function checkSetting(name, value) {
    const s = SETTINGS.find(x => x.name === name);
    if (!s) return 'No setting by that name';
    if (s.readOnly) return name + ' is read-only';
    const v = String(value).trim();
    if (v === '+' || v === '-') return null;
    if (s.rerun) return 'Only "+" re-runs the census';
    if (s.values) return s.values.indexOf(v.replace(/_/g, ' ')) >= 0 ? null : 'One of ' + s.values.join(', ');
    if (!/^\d+(\.\d+)?$/.test(v)) return 'Plain digits, at most one "."';
    const n = Number(v);
    if (n < s.min || n > s.max) return 'Between ' + s.min + ' and ' + s.max;
    return null;
  }

  // Idle timeouts, restarted on every reply line (§6).
  function timeoutFor(cmd) {
    const c = String(cmd).trim().toUpperCase();
    if (/^LOG DUMP/.test(c)) return 15000;
    if (/^(LOG CLEAR YES|LOG FORMAT FORCE|STN BEGIN|STN CLEAR YES|STN FORMAT FORCE|STN END)/.test(c)) return 30000;
    if (/^STN W /.test(c)) return 5000;
    if (/^SCREEN/.test(c)) return 5000;
    return 3000;
  }

  const ERRORS = {
    UNKNOWN: 'No such command in this firmware build',
    ARGS: 'An argument is missing or malformed',
    TOOLONG: 'The line was over the limit and was discarded',
    NAME: 'No setting by that name',
    RANGE: 'The value is outside what the setting allows',
    READONLY: 'That setting cannot be changed',
    NOTINAPP: 'That setting acts on the receiver — only while the ALERT app runs',
    FOREIGN: 'The flash region holds data that is not this firmware\'s — FORMAT FORCE takes it over',
    CONFIRM: 'A destructive command without its YES / FORCE',
    NOLOG: 'The log is not usable (OFF, FOREIGN or ERR)',
    STATE: 'Out of sequence (an STN W or END without BEGIN, or out of order)',
    CRC: 'The uploaded bytes do not match the CRC — nothing was activated',
    FLASH: 'An SPI flash erase, program or verify failed',
  };

  const EVENTS = {
    BOOT: 'The app started after a reset', CENSUS: 'The audio route', SET: 'A setting changed',
    LOG: 'The log\'s state', STN: 'The station table in use', CLOCK: 'The clock was set',
  };

  const KIND_LABEL = { RAIN: 'Rain', LVL: 'Level', BATT: 'Battery', REP: 'Repeater', SNSR: 'Sensor', CHK: 'Check' };

  // ── the station table blob (§8; gen_stations.py --blob) ──────────────────────
  //
  // The radio names stations from a table. The firmware build bakes one in,
  // cut to 13-character names; a fuller one — names to 40 characters, all of
  // MegaNet — can be uploaded into SPI flash with the console's STN commands.
  // gen_stations.py builds it from MegaNet in that repository; this builds the
  // same structure from the station database already loaded in the app, by
  // the same rules: stations.json first, the legacy address file as fallback,
  // a site per run of up to five consecutive addresses of one station.

  const KIND = { NONE: 0, RAIN: 1, LEVEL: 2, BATT: 3, REP: 4, OTHER: 5, CHECK: 6 };
  const KIND_CODE_LABEL = ['', 'RAIN', 'LVL', 'BATT', 'REP', 'SNSR', 'CHK'];
  const SITE_SPAN = 5;
  const NAME_MAX = 40;
  const BLOB_MAX = 0x10000 - 32;     // the region's last 32 bytes are the radio's own mark
  const HEADER = 32;

  // Ordered: battery first because "Batt" never means anything else; rain
  // before repeater so "RN/Rep" lands on RAIN.
  const KIND_RULES = [
    [/batt|volt/i, KIND.BATT], [/rain/i, KIND.RAIN], [/level|stage|ahd|height|river|\bRV\b/i, KIND.LEVEL],
    [/repeat|\bRep\b/i, KIND.REP], [/check|chk/i, KIND.CHECK],
  ];
  const SUFFIX_TOKEN = /^(batt(ery)?|rn|rain|rv|river|rep(eater)?[0-9]?|rptr|r\/rep|rn\/rep|rain\/rep|chk|check|v|volts?|temp|rh|lvl|stage|ahd|al|alert)$/i;
  const SUFFIX_KIND = {
    rn: KIND.RAIN, rain: KIND.RAIN, 'rn/rep': KIND.RAIN, 'rain/rep': KIND.RAIN, 'r/rep': KIND.RAIN,
    rv: KIND.LEVEL, river: KIND.LEVEL, lvl: KIND.LEVEL, stage: KIND.LEVEL, ahd: KIND.LEVEL,
    batt: KIND.BATT, battery: KIND.BATT, v: KIND.BATT, volt: KIND.BATT, volts: KIND.BATT,
    rep: KIND.REP, rep1: KIND.REP, rep2: KIND.REP, repeater: KIND.REP, rptr: KIND.REP,
    chk: KIND.CHECK, check: KIND.CHECK, temp: KIND.OTHER, rh: KIND.OTHER,
  };
  const KIND_NEUTRAL = ['al', 'alert'];   // "AL"/"ALERT" says nothing about the sensor

  function kindOf(text) {
    if (!text) return KIND.OTHER;
    for (const [rx, k] of KIND_RULES) if (rx.test(text)) return k;
    return KIND.OTHER;
  }

  function splitSuffix(name) {
    const parts = String(name).split(/\s+/).filter(Boolean);
    const tail = [];
    while (parts.length > 1 && SUFFIX_TOKEN.test(parts[parts.length - 1])) tail.unshift(parts.pop());
    return [parts.join(' '), tail];
  }

  function suffixKind(tokens, whole) {
    for (const t of tokens) {
      const low = t.toLowerCase();
      if (KIND_NEUTRAL.indexOf(low) >= 0) continue;
      if (low in SUFFIX_KIND) return SUFFIX_KIND[low];
    }
    const meaningful = tokens.filter(t => KIND_NEUTRAL.indexOf(t.toLowerCase()) < 0);
    return kindOf(meaningful.length ? meaningful.join(' ') : whole);
  }

  // Uppercase ASCII from a restricted set, the kind suffix and any "AL" token
  // dropped, whitespace collapsed, cut to `limit`. Commas are outside the set:
  // the radio puts names into CSV fields.
  function cleanName(name, limit) {
    limit = limit || NAME_MAX;
    let s = splitSuffix(name)[0].toUpperCase();
    s = s.replace(/[^\x00-\x7f]/g, ' ').replace(/[^A-Z0-9 /.\-&']/g, ' ');
    let words = s.split(/\s+/).filter(Boolean);
    const kept = words.filter(w => w !== 'AL' && w !== 'ALERT');
    if (kept.length) words = kept;
    return words.join(' ').slice(0, limit).replace(/\s+$/, '');
  }

  const ALERT_IDS_KIND = [['rainfall', KIND.RAIN], ['water_level', KIND.LEVEL], ['battery', KIND.BATT]];

  // One record per (station, address) from MegaNet's stations — priority 0.
  function recordsFromStations(stations) {
    const out = [];
    (stations || []).forEach((st, order) => {
      const raw = String(st.name || st.id || '').trim();
      if (!raw) return;
      const kinds = new Map();
      const claim = (aid, k) => {
        if (!Number.isInteger(aid)) return;
        if (!kinds.has(aid) || (kinds.get(aid) === KIND.OTHER && k !== KIND.OTHER)) kinds.set(aid, k);
      };
      (st.sensors || []).forEach(s => claim(s.alert_id, kindOf(s.type || '')));
      ALERT_IDS_KIND.forEach(([key, k]) => claim((st.alert_ids || {})[key], k));
      const name = cleanName(raw);
      if (!name) return;
      [...kinds.keys()].sort((a, b) => a - b).forEach(aid => {
        if (aid > 0 && aid <= 8191) out.push({ aid, kind: kinds.get(aid) || KIND.OTHER, name, group: 'S:' + (st.id || raw) + ':' + order, pri: 0, order });
      });
    });
    return out;
  }

  // The legacy address file, as Packets loads it (a Map id → raw text) — priority 1.
  function recordsFromAddressFile(map) {
    const rows = [...(map || new Map()).entries()].filter(([aid]) => aid > 0 && aid <= 8191).sort((a, b) => a[0] - b[0]);
    const out = [];
    let prev = null, g = 0;
    rows.forEach(([aid, raw], order) => {
      const name = cleanName(raw);
      if (!name) return;
      if (name !== prev) { g++; prev = name; }
      out.push({ aid, kind: suffixKind(splitSuffix(raw)[1], raw), name, group: 'A:' + name + ':' + g, pri: 1, order });
    });
    return out;
  }

  // ALERT addresses are unique only per region: the first claimant wins, by
  // (source priority, source order, address).
  function dedupe(records) {
    const ordered = records.slice().sort((a, b) => a.pri - b.pri || a.order - b.order || a.aid - b.aid);
    const winner = new Map();
    let collisions = 0;
    ordered.forEach(r => {
      if (winner.has(r.aid)) {
        const w = winner.get(r.aid).name;
        if (r.name !== w && !(r.name.startsWith(w) || w.startsWith(r.name))) collisions++;
        return;
      }
      winner.set(r.aid, r);
    });
    return { records: [...winner.keys()].sort((a, b) => a - b).map(a => winner.get(a)), collisions };
  }

  // Sites of up to five consecutive addresses (base…base+4), walked over the
  // globally sorted address list so a site can never claim an address at or
  // beyond the next site's base: the firmware binary-searches for the greatest
  // base ≤ id, and a window straddling another base hides addresses.
  function buildSites(records) {
    const recs = records.slice().sort((a, b) => a.aid - b.aid || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
    const sites = [];
    let cur = null, curGroup = null;
    recs.forEach(r => {
      if (!cur || r.group !== curGroup || r.aid >= cur.base + SITE_SPAN) {
        cur = { base: r.aid, name: r.name, kinds: 0, members: [] };
        curGroup = r.group;
        sites.push(cur);
      }
      cur.kinds |= (r.kind & 7) << (3 * (r.aid - cur.base));
      cur.members.push([r.aid, r.kind]);
    });
    return sites;
  }

  // Built on first use, not at load (`npm run toplevel`).
  let crcTable = null;
  // zlib's CRC-32.
  function crc32(bytes, from, to) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = from || 0, n = to == null ? bytes.length : to; i < n; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function hex8(n) { return (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

  // A short tag for the table's contents, shown by the radio as the source.
  function fingerprint(sites) {
    const enc = [];
    sites.forEach(s => { for (const ch of s.base + ',' + s.kinds + ',' + s.name + ';') enc.push(ch.charCodeAt(0) & 0xff); });
    return crc32(enc).toString(16).padStart(8, '0').slice(0, 7);
  }

  //   header  "ASTB", u16 version 1, u16 count, u32 names_len,
  //           u32 CRC-32 of everything after the header, char source[16]
  //   sites   count × {u16 base_id, u16 kinds, u32 name_off}, sorted by base_id
  //   names   NUL-terminated, de-duplicated
  // All little-endian.
  function buildBlob(sites, source) {
    const offsets = new Map(), pool = [];
    let poolLen = 0;
    sites.forEach(s => { if (!offsets.has(s.name)) { offsets.set(s.name, poolLen); pool.push(s.name); poolLen += s.name.length + 1; } });
    const size = HEADER + 8 * sites.length + poolLen;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    out.set([0x41, 0x53, 0x54, 0x42], 0);                  // ASTB
    dv.setUint16(4, 1, true);
    dv.setUint16(6, sites.length, true);
    dv.setUint32(8, poolLen, true);
    const src = String(source || '').slice(0, 15);
    for (let i = 0; i < src.length; i++) out[16 + i] = src.charCodeAt(i) & 0x7f;
    let o = HEADER;
    sites.forEach(s => {
      dv.setUint16(o, s.base, true); dv.setUint16(o + 2, s.kinds, true); dv.setUint32(o + 4, offsets.get(s.name), true);
      o += 8;
    });
    pool.forEach(name => { for (let i = 0; i < name.length; i++) out[o++] = name.charCodeAt(i); out[o++] = 0; });
    dv.setUint32(12, crc32(out, HEADER), true);
    return out;
  }

  // alert_stn.c's lookup: the site with the greatest base ≤ id, then the kind
  // at the offset. { name, kind } or null.
  function blobLookup(blob, aid) {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const count = dv.getUint16(6, true);
    const namesAt = HEADER + 8 * count;
    let lo = 0, hi = count - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const base = dv.getUint16(HEADER + 8 * mid, true);
      if (base <= aid) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit == null) return null;
    const at = HEADER + 8 * hit;
    const base = dv.getUint16(at, true);
    if (aid - base >= SITE_SPAN) return null;
    const kind = (dv.getUint16(at + 2, true) >> (3 * (aid - base))) & 7;
    if (!kind) return null;
    let p = namesAt + dv.getUint32(at + 4, true), name = '';
    while (p < blob.length && blob[p] && name.length <= NAME_MAX) name += String.fromCharCode(blob[p++]);
    return { name, kind };
  }

  // Every rule the firmware relies on; [] when the blob is sound.
  function checkBlob(blob) {
    const problems = [];
    if (blob.length < HEADER + 8) return ['only ' + blob.length + ' bytes'];
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const magic = String.fromCharCode(blob[0], blob[1], blob[2], blob[3]);
    const count = dv.getUint16(6, true), namesLen = dv.getUint32(8, true);
    if (magic !== 'ASTB') problems.push('magic ' + magic);
    if (dv.getUint16(4, true) !== 1) problems.push('version ' + dv.getUint16(4, true));
    if (!(count > 0 && count < 0xffff)) problems.push('count ' + count);
    if (blob.length > BLOB_MAX) problems.push(blob.length + ' bytes, over the ' + BLOB_MAX + '-byte region');
    if (HEADER + 8 * count + namesLen !== blob.length) problems.push('header says ' + (HEADER + 8 * count + namesLen) + ' bytes, blob has ' + blob.length);
    if (problems.length) return problems;
    if (crc32(blob, HEADER) !== dv.getUint32(12, true)) problems.push('body CRC-32 does not match the header');
    let prev = -1;
    for (let i = 0; i < count; i++) {
      const base = dv.getUint16(HEADER + 8 * i, true);
      if (base <= prev) problems.push('site ' + i + ' (base ' + base + ') not sorted');
      if (base > 8191) problems.push('site ' + i + ': base over 13 bits');
      prev = base;
    }
    return problems;
  }

  // The whole build, from what the app has loaded. `addressFile` is optional.
  function buildStationTable(stations, addressFile) {
    const all = recordsFromStations(stations).concat(recordsFromAddressFile(addressFile));
    const d = dedupe(all);
    const sites = buildSites(d.records);
    const source = 'MegaNet:' + fingerprint(sites);
    const blob = buildBlob(sites, source);
    return {
      blob, sites, source, crc: crc32(blob), addresses: d.records.length, collisions: d.collisions,
      problems: checkBlob(blob), fromStations: all.filter(r => r.pri === 0).length,
    };
  }

  // The console lines that put a blob on the radio (§8): BEGIN, a W per
  // chunk in increasing offset order, END. 64-byte chunks; 32 on a retry.
  function uploadCommands(blob, chunk) {
    chunk = chunk || 64;
    const lines = ['STN BEGIN ' + blob.length + ' ' + hex8(crc32(blob))];
    for (let off = 0; off < blob.length; off += chunk) {
      let hex = '';
      for (let i = off; i < Math.min(blob.length, off + chunk); i++) hex += (blob[i] < 16 ? '0' : '') + blob[i].toString(16).toUpperCase();
      lines.push('STN W ' + off + ' ' + hex);
    }
    lines.push('STN END');
    return lines;
  }

  // Rows of LOG DUMP / DEC records as CSV, header row from the DEC field names.
  function toCsv(fields, records) {
    const q = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [fields.join(',')].concat(records.map(r => fields.map(f => q(r[f])).join(','))).join('\n') + '\n';
  }

  return {
    USB_VID, USB_PID, SCHEMA, RECORDS, DEFAULT_FIELDS, SETTINGS, ERRORS, EVENTS, KIND_LABEL, KIND_CODE_LABEL,
    FRAME, BOOTLOADER_IDS,
    createSchema, classify, applyHeader, parseRecord, parseFinal, parseData,
    decodePayload32, payloadRoles, payloadBits, burstBits, scanBurst, decodeScreen,
    crc16xmodem, makeFrame, readFrame, LineReader,
    setCommand, checkSetting, timeoutFor,
    cleanName, kindOf, recordsFromStations, recordsFromAddressFile, dedupe, buildSites, buildBlob,
    blobLookup, checkBlob, crc32, buildStationTable, uploadCommands, toCsv, hex8,
  };
})();

// test/quansheng.mjs requires this same file and holds it against every
// example line in the firmware's interface document. Guarded so the browser,
// where `module` is undefined, never runs it. Constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = Quansheng;
