// MegaNet — alert2.js
//
//   Alert2   the ALERT2 / ERT-A2 tab: decodes ELPRO ERT-A2 output, ASCII or
//            binary, pasted in or read off a PuTTY session log.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// The most connected of the ten modules M2 moved. It reaches back to core.js for
// state, esc, escAttr, csvEscape, dlText, stationSensors, bucketSizeMm and —
// since #142, so the stop-list is not a name in someone else's file —
// registerTabTeardown and registerLiveMap, plus removeMap (#143 — which now
// carries the try/catch stopMap() used to spell out, and the half of that
// hazard a try/catch could never have caught);
// across to app.js for renderMain, addBaseLayers, MAP_HOME and stationAlertIds,
// plus switchTab and goToStation from inline handlers; and sideways to Packets
// for the shared codec. All of it from inside functions this module exports —
// the IIFE body declares 28 tables, regexes and constants and calls nothing — so
// packets.js is free to load after this file. #133 flagged the
// Alert2/Serial/Packets ordering as something to check; checked, it does not
// bind, and it does not bind because init.js is still the only file that
// executes at load.
//
// ⚠ This file carries one of the app's 4 literal NUL bytes — U+0000 inside a
// string literal at line 859, used as a compound-key separator (#129).
// Any tool that round-trips this file as text and normalises control characters
// destroys that key silently. `npm run concat` in test/ is what catches it.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── ALERT2 / ERT-A2 tab ─────────────────────────────────────────────────────────
//
// Decoder for the "ALERT2 ASCII Protocol" an ELPRO ERT-A2 writes to its RS232
// port: one comma-separated line per received ALERT2 frame, 24 fixed fields of
// receiver metadata followed by the frame's payload as hex bytes.
//
//   ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00
//   └ tag  │ │    │     │ │ └──── ERT-A2 clock ──┘ └── status ──┘ │  │  │    └── payload ──────┘
//          │ │    │     │ └ constant                              │  │  └ source address
//          │ │    │     └ frame type                              │  └ payload length, bytes
//          │ │    └ agency id                                     └ reception quality
//          │ └ decoder address (this ERT-A2)
//          └ interface version
//
// The payload is an ALERT2 "ALERT concentration" element — IND type 0x74, two
// bytes of seconds-since-midnight, then any number of four-byte records each
// carrying one legacy 13-bit ALERT address and its 11-bit value. So the modern
// frame is a wrapper: what comes out the other end is the same ID-and-value pair
// the ALERT Packets tab has always decoded, which is why both tabs agree on a
// reading and why station lookup is shared between them.
//
// Nothing here is guesswork about the payload: the field meanings below were
// derived by decoding a 444-frame capture from a test ERT-A2 and checking every
// address, value and timestamp against the same traffic decoded by ELPRO's own
// Ranger software. Where a field's meaning could not be established that way it
// says so rather than inventing one — see REFERENCE at the bottom of the tab.
//
// Live capture is the destination, not the starting point. Web Serial is closed
// off on managed machines, so this ingests what an operator can get today: text
// pasted out of PuTTY, or a PuTTY session log picked off disk. Where the browser
// offers the File System Access API the picked log can also be re-read on a
// timer, which is as close to live as this gets without a serial port.

const Alert2 = (function () {

  // ── protocol ──────────────────────────────────────────────────────────────────

  const TAG = 'ALERT2A';
  const IND_ALERT_CONC = 0x74;     // payload byte 0 on every frame in the capture
  const HDR_BYTES = 3;             // IND + 2 bytes of seconds-since-midnight
  const REC_BYTES = 4;

  // The 24 fixed fields, in order. `role` drives the colour of the chip in the
  // frame anatomy; `sure` marks what the Ranger cross-check actually established
  // as against what was merely constant across every frame observed.
  const FIELDS = [
    { k: 'tag',      label: 'Protocol tag',      role: 'ident', sure: true,
      note: 'Always ALERT2A. ELPRO calls this the ALERT2 ASCII Protocol; the binary protocol is a different, longer framing this tab does not read.' },
    { k: 'version',  label: 'Interface version', role: 'ident', sure: false,
      note: '1 on every frame observed.' },
    { k: 'decoder',  label: 'Decoder address',   role: 'addr',  sure: true,
      note: 'The ERT-A2 doing the receiving — the unit this serial cable is plugged into. Configured on the unit itself.' },
    { k: 'agency',   label: 'Agency ID',         role: 'ident', sure: true,
      note: 'ALERT2 agency string carried in the frame. ELPRO here.' },
    { k: 'frameType', label: 'Frame type',       role: 'ident', sure: false,
      note: 'N on every frame observed.' },
    { k: 'const6',   label: 'Field 6',           role: 'ident', sure: false,
      note: '1 on every frame observed; meaning not established.' },
    { k: 'year',     label: 'Year',              role: 'time',  sure: true, num: true },
    { k: 'month',    label: 'Month',             role: 'time',  sure: true, num: true },
    { k: 'day',      label: 'Day',               role: 'time',  sure: true, num: true },
    { k: 'hour',     label: 'Hour',              role: 'time',  sure: true, num: true },
    { k: 'minute',   label: 'Minute',            role: 'time',  sure: true, num: true },
    { k: 'second',   label: 'Second',            role: 'time',  sure: true, num: true,
      note: 'Fractional, to milliseconds. Fields 7–12 are the ERT-A2\'s own real-time clock, which is not necessarily right — compare it with the ALERT2 time in the payload.' },
    { k: 'st13',     label: 'Status 13',         role: 'status', sure: false },
    { k: 'st14',     label: 'Status 14',         role: 'status', sure: false },
    { k: 'st15',     label: 'Status 15',         role: 'status', sure: false },
    { k: 'st16',     label: 'Status 16',         role: 'status', sure: false },
    { k: 'st17',     label: 'Status 17',         role: 'status', sure: false },
    { k: 'frameOk',  label: 'Frame valid',       role: 'status', sure: true, num: true,
      note: '1 on all 443 good frames in the reference capture and 0 on the single corrupt one, whose records also carried non-zero status bytes and addresses matching no station. Read as a frame-valid flag.' },
    { k: 'st19',     label: 'Status 19',         role: 'status', sure: false },
    { k: 'st20',     label: 'Status 20',         role: 'status', sure: false },
    { k: 'st21',     label: 'Status 21',         role: 'status', sure: false },
    { k: 'quality',  label: 'Reception quality', role: 'status', sure: false, num: true,
      note: '7 on every good frame and 1 on the corrupt one. Tracks frame health; the scale is not established, and it is not RSSI — no field in the ASCII line carries the dBm figure Ranger reports.' },
    { k: 'payLen',   label: 'Payload length',    role: 'len',   sure: true, num: true,
      note: 'Payload size in bytes. Matched the number of trailing hex fields on all 444 frames, so it is what tells a wrapped or truncated line from a complete one.' },
    { k: 'source',   label: 'Source address',    role: 'addr',  sure: true, num: true,
      note: 'The ALERT2 node that transmitted the frame. On a unit configured as a repeater this is the repeater\'s own address, so it equals the decoder address and says nothing about which field station the readings came from — that identity is in the payload, as the ALERT id of each record.' },
  ];
  const N_FIELDS = FIELDS.length;   // 24

  // ── one four-byte concentration record ────────────────────────────────────────
  //
  //   byte 0   AAAAAAAA   address bits 7–0
  //   byte 1   DDDAAAAA   data bits 10–8, then address bits 12–8
  //   byte 2   DDDDDDDD   data bits 7–0
  //   byte 3   SSSSSSSS   status; 0 on every valid record observed
  //
  // Same 13-bit address and 11-bit value as ABF/EIF, packed into bytes instead of
  // async words. FORMATS.a2c on the ALERT Packets tab draws this same layout.
  function decodeRecord(b, off) {
    return {
      off,
      bytes:   [b[0], b[1], b[2], b[3]],
      alertId: ((b[1] & 0x1f) << 8) | b[0],
      value:   ((b[1] >> 5) << 8) | b[2],
      status:  b[3],
      ok:      b[3] === 0,
    };
  }

  const FULL_SCALE = 2047;          // 11 bits all set: over-range or a dead sensor

  // ── capture ingest ────────────────────────────────────────────────────────────

  // PuTTY stamps this line into the log every time a session starts, so a log
  // reused across sessions has them scattered through the middle of the data —
  // and, as in the reference capture, one can land mid-line and cut a frame in
  // half. Both halves have to be recognised for what they are rather than
  // silently mangling the frames either side.
  // Both runs of "=~" are matched greedily so the whole banner is one match. A
  // lazier pattern chops the same line into three, which inflates the count and
  // leaves the text between the pieces looking like data.
  const BANNER = /(?:=~){3,}=?[^\n]*?(?:=~){3,}=?/g;
  const BANNER_TS = /PuTTY log (\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)/;

  // Some operators configure their terminal to stamp each line. There is no one
  // format, so rather than matching a list this takes whatever sits in front of
  // the ALERT2A tag, strips the brackets and tries to read a time out of it —
  // and if it can't, keeps it as an opaque label rather than throwing the line
  // away. The ERT-A2's own clock is in the frame regardless, so a prefix that
  // won't parse costs nothing.
  function parsePrefix(s) {
    const text = String(s || '').trim().replace(/^[[(<]\s*|\s*[\])>]$|[-–—:\s]+$/g, '').trim();
    if (!text) return null;
    let m = text.match(/(\d{4})[-/.](\d\d?)[-/.](\d\d?)[ T](\d\d?):(\d\d)(?::(\d\d)(?:[.,](\d{1,3}))?)?/);
    if (m) return { text, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))), dated: true };
    m = text.match(/(\d\d?)[-/.](\d\d?)[-/.](\d{4})[ T](\d\d?):(\d\d)(?::(\d\d)(?:[.,](\d{1,3}))?)?/);
    if (m) return { text, ms: Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0'))), dated: true };
    m = text.match(/^(\d\d?):(\d\d):(\d\d)(?:[.,](\d{1,3}))?$/);
    if (m) return { text, sod: +m[1] * 3600 + +m[2] * 60 + +m[3], dated: false };
    return { text, dated: false };
  }

  // A hex payload field, and nothing else: this is what says a stray line is the
  // tail of a wrapped frame rather than noise. Frames wrap when the receiving
  // terminal folds a long line, which puts the break at a comma — so the tail
  // starts with one, or is bare hex pairs.
  const HEX_TAIL = /^,?(?:[0-9A-Fa-f]{1,2})(?:\s*,\s*[0-9A-Fa-f]{1,2})*,?$/;

  // How many payload bytes a frame is still waiting for. This is what stops the
  // tail-gluing from being a guess: a complete frame never adopts the next line,
  // however much that line looks like hex. The reference capture has a PuTTY
  // banner landing mid-line and leaving a stray "A" behind — a perfectly good
  // hex byte, which without this check gets welded onto the frame above it.
  function shortfall(text) {
    const f = text.split(',');
    if (f.length <= N_FIELDS) return Infinity;          // header itself is incomplete
    const want = Number(f[N_FIELDS - 2]);               // field 23, the payload length
    return Number.isFinite(want) ? want - (f.length - N_FIELDS) : 0;
  }

  // Split a capture into frame texts. Returns the pieces in file order along with
  // everything deliberately dropped, so the summary can account for every line
  // rather than quietly losing some.
  function splitCapture(text) {
    const frames = [];              // { text, lineNo, prefix, wrapped }
    const banners = [];             // { lineNo, ms }
    const junk = [];                // { lineNo, text, why }
    let blank = 0;

    String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
      const lineNo = i + 1;
      // A banner can sit anywhere in the line, so cut around it and treat the
      // remains as separate pieces rather than testing the line as a whole.
      const pieces = [];
      let last = 0;
      BANNER.lastIndex = 0;
      let m;
      while ((m = BANNER.exec(rawLine)) !== null) {
        if (m.index > last) pieces.push(rawLine.slice(last, m.index));
        const b = m[0].match(BANNER_TS);
        banners.push({ lineNo, ms: b ? Date.UTC(+b[1], +b[2] - 1, +b[3], +b[4], +b[5], +b[6]) : null });
        last = m.index + m[0].length;
      }
      if (last < rawLine.length) pieces.push(rawLine.slice(last));
      if (!pieces.length) return;

      pieces.forEach(piece => {
        const line = piece.trim();
        if (!line) return;
        const at = line.indexOf(TAG);
        if (at >= 0) {
          frames.push({ text: line.slice(at), lineNo, prefix: parsePrefix(line.slice(0, at)), wrapped: false });
          return;
        }
        // No tag: either the tail of the frame above, or something else entirely.
        const prev = frames.length ? frames[frames.length - 1] : null;
        if (prev && HEX_TAIL.test(line) && shortfall(prev.text) > 0) {
          prev.text = prev.text.replace(/,\s*$/, '') + ',' + line.replace(/^,\s*/, '');
          prev.wrapped = true;
          return;
        }
        junk.push({ lineNo, text: line, why: frames.length ? 'not an ALERT2A line' : 'before the first ALERT2A line' });
      });
    });
    return { frames, banners, junk };
  }

  // ── frame parse ───────────────────────────────────────────────────────────────

  function parseFrame(src, seq) {
    const f = {
      seq, lineNo: src.lineNo, raw: src.text, wrapped: src.wrapped, prefix: src.prefix,
      fields: src.text.split(',').map(s => s.trim()),
      warn: [], error: null, hdr: {}, payload: null, records: [],
    };
    const v = f.fields;

    if (v[0] !== TAG) { f.error = 'does not start with ' + TAG; return f; }
    if (v.length < N_FIELDS + 1) {
      f.error = 'truncated — ' + v.length + ' fields, at least ' + (N_FIELDS + 1) + ' expected'
              + (v.length < N_FIELDS ? '' : ' (header complete, payload missing)');
      return f;
    }

    const num = i => { const n = Number(v[i]); return Number.isFinite(n) ? n : null; };
    const h = f.hdr;
    FIELDS.forEach((spec, i) => { h[spec.k] = spec.num ? num(i) : v[i]; });

    // The ERT-A2's own clock. Built as local time because that is how the unit
    // reports it and how an operator reading the log will think about it.
    if ([h.year, h.month, h.day, h.hour, h.minute, h.second].every(x => x !== null)) {
      const s = Math.floor(h.second);
      h.clockMs = new Date(h.year, h.month - 1, h.day, h.hour, h.minute, s,
                           Math.round((h.second - s) * 1000)).getTime();
      h.clockSod = h.hour * 3600 + h.minute * 60 + h.second;
    } else {
      h.clockMs = null; h.clockSod = null;
      f.warn.push('the date/time fields did not parse as numbers');
    }
    if (h.frameOk !== 1) f.warn.push('frame-valid flag (field 18) is ' + v[17] + ', not 1 — the receiver did not consider this frame clean');

    // Payload.
    const hex = v.slice(N_FIELDS);
    const bad = hex.findIndex(x => !/^[0-9A-Fa-f]{1,2}$/.test(x));
    if (bad >= 0) { f.error = 'payload field ' + (N_FIELDS + bad + 1) + ' is not a hex byte (' + v[N_FIELDS + bad] + ')'; return f; }
    const bytes = hex.map(x => parseInt(x, 16));

    if (h.payLen !== bytes.length) {
      f.warn.push('payload length says ' + h.payLen + ' byte' + (h.payLen === 1 ? '' : 's')
                + ' but ' + bytes.length + ' arrived — the line is ' + (bytes.length < h.payLen ? 'cut short' : 'over-long'));
    }
    readPayload(f, bytes);
    return f;
  }

  // The IND payload, and the readings inside it. Identical on both wire formats
  // — the ASCII line spells these bytes out one hex field at a time and the
  // binary frame carries them whole, but from `0x74` on it is the same element,
  // so both paths decode it here.
  function readPayload(f, bytes) {
    if (bytes.length < HDR_BYTES) { f.error = 'payload is only ' + bytes.length + ' byte(s); ' + HDR_BYTES + ' are needed before any reading'; return f; }

    const ind = bytes[0];
    const sod = (bytes[1] << 8) | bytes[2];
    f.payload = { bytes, ind, sod, body: bytes.slice(HDR_BYTES) };

    if (ind !== IND_ALERT_CONC) {
      f.error = 'payload type 0x' + ind.toString(16).toUpperCase().padStart(2, '0')
              + ' is not the ALERT concentration type (0x74) this decoder knows';
      return f;
    }

    const body = f.payload.body;
    const whole = Math.floor(body.length / REC_BYTES);
    if (body.length % REC_BYTES) f.warn.push((body.length % REC_BYTES) + ' byte(s) left over after the last complete reading');
    for (let i = 0; i < whole; i++) {
      const r = decodeRecord(body.slice(i * REC_BYTES, i * REC_BYTES + REC_BYTES), HDR_BYTES + i * REC_BYTES);
      r.frame = f; r.idx = i;
      if (!r.ok) f.warn.push('reading ' + (i + 1) + ' has status byte 0x'
                           + r.status.toString(16).toUpperCase().padStart(2, '0') + ', not 0 — treat it as corrupt');
      f.records.push(r);
    }
    return f;
  }

  // ── the second wire format: ELPRO's binary framing (USB) ──────────────────────
  //
  // The ASCII protocol above is what the ERT-A2 writes to its secondary RS232
  // port, and it has no RSSI in it — 24 fixed fields, none of which is a signal
  // level. ELPRO's own Ranger software reports RSSI for every packet, and its
  // "Serial Data" pane shows why: over the USB port the unit speaks a different,
  // binary framing, and that one carries the number.
  //
  // Nothing here is a command sent to the unit. This decodes what the USB port
  // emits; whether Ranger has to ask for it first is not something a receive-only
  // capture can answer, and the reference material says so rather than guessing.
  //
  //   "ALERT2"  <len>  <TLV> <TLV> ...
  //   \_ 6 ASCII bytes, the frame sync
  //             \_ one byte: how many bytes of TLV follow
  //
  // Every element is tag / length / value. A tag byte with the top bit set is
  // the first of a two-byte tag; otherwise the tag is that one byte. Length is
  // always a single byte, so an element carries at most 255 bytes — which is why
  // the fixed receive buffer below is 24 and not something larger.
  const BIN_MAGIC = [0x41, 0x4C, 0x45, 0x52, 0x54, 0x32];   // "ALERT2"
  const BIN_FILL  = 0xA1;    // what the fixed receive buffer is padded out with
  const BIN_BUF   = 24;      // that buffer's size, constant across the capture

  // `sure` carries the same meaning as it does for the ASCII fields: established
  // by cross-checking against Ranger's own decode of the same traffic, as against
  // merely constant on every frame seen.
  const BIN_TAGS = {
    '75':   { label: 'Interface version', role: 'ident', kind: 'u8', sure: false,
              note: '1 on every frame observed — the same value the ASCII line carries as field 2.' },
    '18':   { label: 'Source address', role: 'addr', kind: 'u16', sure: true,
              note: 'Matched Ranger\'s Source column on every frame. On a unit configured as a repeater the source and decoder addresses are the same number, so this capture cannot say which of the two it is.' },
    '77':   { label: 'Agency ID', role: 'ident', kind: 'ascii', sure: true,
              note: 'ASCII, length-delimited. ELPRO here, matching Ranger\'s Agency ID column.' },
    '15':   { label: 'As received', role: 'len', kind: 'container', sure: true,
              note: 'The air-link PDU exactly as it landed in the receive buffer, length and fill included.' },
    '14':   { label: 'Decoded', role: 'len', kind: 'container', sure: true,
              note: 'The same PDU split into header and payload, with the receive measurements appended. This is the element the RSSI lives in.' },
    '8410': { label: 'PDU length', role: 'len', kind: 'u16', sure: true,
              note: 'Bytes of air-link PDU in the buffer below. Equalled header + payload on every frame.' },
    '8411': { label: 'Receive buffer', role: 'status', kind: 'buf', sure: true,
              note: 'Fixed ' + BIN_BUF + '-byte buffer: a two-byte length, the PDU, then 0xA1 fill to the end. The PDU here was byte-identical to the split copy in the decoded element on every frame.' },
    '8412': { label: 'Field 8412', role: 'status', kind: 'u8', sure: false,
              note: '0 on every frame observed; meaning not established.' },
    '8400': { label: 'MANT header', role: 'time', kind: 'mant', sure: false,
              note: 'The six bytes in front of the payload: three constant (00 10 70), then the payload length, then the source address. The constant three are where the ASCII line\'s status and quality fields must sit, but nothing in this capture varies enough to separate them.' },
    '8401': { label: 'Payload', role: 'ident', kind: 'payload', sure: true,
              note: 'The ALERT2 IND element — the same 0x74 concentration payload the ASCII line spells out one hex field at a time.' },
    '9C2F': { label: 'RSSI', role: 'rssi', kind: 'i8', sure: true,
              note: 'Signed 8-bit, dBm. Equalled Ranger\'s RSSI column exactly on all 44 cross-checked frames — no scaling, no offset. This is the field the ASCII protocol has no equivalent of.' },
  };

  // Wire order, with nesting depth, for the reference table. Not derivable from
  // the object above: JS orders integer-like keys numerically, and every tag but
  // 9C2F is one, so iterating BIN_TAGS gives a sequence no frame is ever in.
  const BIN_ORDER = [
    ['75', 0], ['18', 0], ['77', 0],
    ['15', 0], ['8410', 1], ['8411', 1], ['8412', 1],
    ['14', 0], ['8400', 1], ['8401', 1], ['9C2F', 1],
  ];

  // Hex out of whatever the operator pasted. Ranger's Serial Data pane wraps
  // mid-frame at whatever width the window happens to be, so line breaks mean
  // nothing here and the bytes are treated as one stream — the "ALERT2" sync
  // below is what finds the frame boundaries, not the newlines.
  //
  // Two prefixes do have to come off first, because their digits are hex too and
  // would otherwise be read as data: a bracketed terminal timestamp, and the
  // offset column of a hex dump. Both are stripped per line, before anything is
  // treated as a byte.
  const HEXDUMP_OFF   = /^\s*[0-9A-Fa-f]{4,8}h?\s*:\s*/;      // "0000C0:" / "0000c0h:"
  const HEXDUMP_ASCII = /\|[^|]*\|\s*$/;                      // hexdump -C's right-hand pane
  const LINE_PREFIX   = /^\s*[[(<][^\])>]*[\])>]\s*[-–—:]?\s*/;

  function hexStream(text) {
    const bytes = [];
    const marks = [];       // { at, lineNo } — byte index each line's data starts at
    const stats = { lines: 0, hexLines: 0, prefixes: 0, dumps: 0, oddTokens: 0, junk: [] };

    String(text || '').split(/\r?\n/).forEach((rawLine, i) => {
      const lineNo = i + 1;
      if (!rawLine.trim()) return;
      stats.lines++;
      let line = rawLine;
      if (LINE_PREFIX.test(line))   { line = line.replace(LINE_PREFIX, '');   stats.prefixes++; }
      if (HEXDUMP_OFF.test(line))   { line = line.replace(HEXDUMP_OFF, '');   stats.dumps++; }
      if (HEXDUMP_ASCII.test(line)) { line = line.replace(HEXDUMP_ASCII, ''); }
      const toks = line.replace(/0[xX]/g, ' ').split(/[^0-9A-Fa-f]+/).filter(Boolean);
      if (!toks.length) { stats.junk.push({ lineNo, text: rawLine.trim().slice(0, 80), why: 'no hex on the line' }); return; }

      const at = bytes.length;
      let took = 0;
      toks.forEach(t => {
        // A single digit is a byte written without its leading zero, which is
        // what a "%X" dump does — pad it. Any other odd length is genuinely
        // ambiguous, and guessing where the missing nibble goes would shift
        // every byte after it, so it is dropped and counted instead.
        if (t.length === 1) t = '0' + t;
        else if (t.length % 2) { stats.oddTokens++; return; }
        for (let k = 0; k < t.length; k += 2) bytes.push(parseInt(t.slice(k, k + 2), 16));
        took += t.length / 2;
      });
      if (took) { marks.push({ at, lineNo }); stats.hexLines++; }
    });
    return { bytes, marks, stats };
  }

  // Which source line a byte offset came from. Binary search, because a long
  // capture is tens of thousands of lines and every frame asks this once.
  function lineAt(marks, at) {
    let lo = 0, hi = marks.length - 1, best = marks.length ? marks[0].lineNo : 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].at <= at) { best = marks[mid].lineNo; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  // Tag / length / value, flat. Returns what it managed to read plus whatever
  // went wrong, rather than throwing — a capture cut off mid-frame is normal and
  // should produce one reported bad frame, not a dead panel.
  function tlvRead(bytes, from, to, depth, out) {
    let at = from;
    while (at < to) {
      const t0 = bytes[at];
      const wide = (t0 & 0x80) !== 0;
      if (wide && at + 1 >= to) return 'tag at byte ' + at + ' runs off the end of the element';
      const tag = wide ? ((t0 << 8) | bytes[at + 1]) : t0;
      const hex = wide ? hx(t0) + hx(bytes[at + 1]) : hx(t0);
      at += wide ? 2 : 1;
      if (at >= to) return 'element ' + hex + ' has no length byte';
      const len = bytes[at]; at++;
      if (at + len > to) return 'element ' + hex + ' claims ' + len + ' bytes but only ' + (to - at) + ' remain';
      out.push({ tag: hex, len, depth, off: at, val: bytes.slice(at, at + len), spec: BIN_TAGS[hex] || null });
      at += len;
    }
    return null;
  }

  function u16(v, i) { return (v[i] << 8) | v[i + 1]; }
  function i8(b)     { return b > 127 ? b - 256 : b; }

  // One binary frame, from the sync byte to the end of its declared length.
  function parseBinFrame(bytes, at, lineNo, seq) {
    const len   = bytes[at + 6];
    const end   = at + 7 + len;
    const raw   = bytes.slice(at, end);
    const f = {
      seq, lineNo, kind: 'bin', byteOff: at, bytes: raw,
      raw: raw.map(hx).join(' '),
      wrapped: false, prefix: null, fields: [],
      warn: [], error: null, hdr: {}, payload: null, records: [], tlv: [],
    };
    const h = f.hdr;
    // Nothing in the binary frame is the receiver's own clock — the ASCII line's
    // date and time fields have no counterpart here, and Ranger's own display
    // stamps its rows from the PC. So the only time a binary capture has is the
    // one inside the payload, and the skew check has nothing to compare.
    h.clockMs = null; h.clockSod = null; h.frameOk = null;
    h.decoder = null; h.quality = null; h.rssi = null;

    const err = tlvRead(raw, 7, raw.length, 0, f.tlv);
    if (err) { f.error = err; return f; }

    const top = {};
    f.tlv.forEach(e => { top[e.tag] = e; });
    // The two containers hold the elements that matter, so they are unpacked in
    // place: the flat list stays in wire order with `depth` marking the nesting,
    // which is what the anatomy view draws.
    ['15', '14'].forEach(tagHex => {
      const c = top[tagHex];
      if (!c) return;
      const kids = [];
      const kerr = tlvRead(c.val, 0, c.val.length, 1, kids);
      if (kerr) { f.warn.push('inside element ' + tagHex + ': ' + kerr); return; }
      kids.forEach(k => { k.off += c.off; top[k.tag] = k; });
      const i = f.tlv.indexOf(c);
      f.tlv.splice(i + 1, 0, ...kids);
    });

    if (top['75']) h.version = top['75'].val[0];
    if (top['18'] && top['18'].len >= 2) h.source = u16(top['18'].val, 0);
    if (top['77']) h.agency = String.fromCharCode.apply(null, top['77'].val);
    if (top['9C2F'] && top['9C2F'].len >= 1) h.rssi = i8(top['9C2F'].val[0]);
    else f.warn.push('no RSSI element (9C2F) in this frame');

    const mant = top['8400'];
    if (mant && mant.len >= 6) {
      h.mant = { flags: mant.val.slice(0, 3), payLen: mant.val[3], addr: u16(mant.val, 4) };
      h.payLen = mant.val[3];
      if (h.source == null) h.source = h.mant.addr;
      else if (h.mant.addr !== h.source)
        f.warn.push('the MANT header address (' + h.mant.addr + ') and the frame\'s source address (' + h.source + ') disagree');
    }

    const pay = top['8401'];
    if (!pay) { f.error = 'no payload element (8401) — nothing to decode'; return f; }
    if (h.payLen != null && h.payLen !== pay.len)
      f.warn.push('the MANT header says ' + h.payLen + ' payload bytes but the payload element carries ' + pay.len);
    h.payLen = pay.len;

    // The received copy and the decoded copy are the same PDU twice over. When
    // they disagree the frame is damaged in a way neither copy admits to on its
    // own, so it is worth saying rather than picking one.
    const buf = top['8411'];
    if (buf && buf.len >= 2 && mant) {
      const pdu = u16(buf.val, 0);
      if (pdu !== mant.len + pay.len)
        f.warn.push('the receive buffer says ' + pdu + ' PDU bytes, but the header and payload add up to ' + (mant.len + pay.len));
      const copy = buf.val.slice(2, 2 + Math.min(pdu, buf.len - 2));
      const split = mant.val.concat(pay.val);
      if (copy.length === split.length && copy.some((b, i) => b !== split[i]))
        f.warn.push('the received copy of the PDU and the decoded copy are not the same bytes');
    }
    if (top['8410'] && top['8410'].len >= 2 && mant) {
      const n = u16(top['8410'].val, 0);
      if (n !== mant.len + pay.len) f.warn.push('the PDU length element says ' + n + ', not ' + (mant.len + pay.len));
    }

    readPayload(f, pay.val);
    return f;
  }

  // Split a hex capture into frames. Frame sync is the "ALERT2" magic and the
  // length byte behind it: anything between one frame's end and the next sync is
  // counted and skipped, which is what makes a wrapped pane, a stray timestamp
  // or a log that starts mid-frame all harmless.
  function splitBinary(text) {
    const { bytes, marks, stats } = hexStream(text);
    const frames = [];
    const n = bytes.length;
    let at = 0, stray = 0, tail = null;

    while (at + 7 <= n) {
      let sync = true;
      for (let k = 0; k < 6; k++) if (bytes[at + k] !== BIN_MAGIC[k]) { sync = false; break; }
      if (!sync) { at++; stray++; continue; }
      const len = bytes[at + 6];
      if (at + 7 + len > n) {
        // The log stops part-way through a frame. Reported, not decoded: half a
        // frame decodes to readings that were never sent.
        tail = { at, want: len + 7, got: n - at, lineNo: lineAt(marks, at) };
        at = n;
        break;
      }
      frames.push(parseBinFrame(bytes, at, lineAt(marks, at), frames.length));
      at += 7 + len;
    }
    stray += Math.max(0, n - at);
    return { frames, stats, stray, tail, total: n };
  }

  function parseBin(text) {
    const split = splitBinary(text);
    const frames = split.frames;
    const good = frames.filter(f => !f.error);
    const recs = [];
    good.forEach(f => f.records.forEach(r => recs.push(r)));
    const s = split.stats;

    const ingest = [];
    if (s.hexLines) ingest.push(s.hexLines + ' line' + (s.hexLines === 1 ? '' : 's') + ' of hex read as one byte stream');
    if (s.prefixes) ingest.push(s.prefixes + ' bracketed prefix' + (s.prefixes === 1 ? '' : 'es') + ' stripped before the hex');
    if (s.dumps)    ingest.push(s.dumps + ' hex-dump offset column' + (s.dumps === 1 ? '' : 's') + ' stripped');
    if (s.oddTokens) ingest.push(s.oddTokens + ' token' + (s.oddTokens === 1 ? '' : 's') + ' with an odd number of digits dropped — they cannot be split into bytes');
    if (split.stray) ingest.push(split.stray + ' byte' + (split.stray === 1 ? '' : 's') + ' outside any frame skipped');
    if (split.tail)  ingest.push('the capture stops ' + (split.tail.want - split.tail.got) + ' byte(s) into a frame at line ' + split.tail.lineNo);

    return {
      text, mode: 'bin', frames, records: recs,
      stats: {
        mode: 'bin',
        frames: frames.length,
        wrapped: 0, prefixed: s.prefixes,
        errors: frames.filter(f => f.error).length,
        warned: good.filter(f => f.warn.length).length,
        records: recs.length,
        badRecords: recs.filter(r => !r.ok).length,
        banners: 0, junk: s.junk,
        bytes: split.total, stray: split.stray, ingest,
        decoders: [], agencies: [...new Set(good.map(f => f.hdr.agency).filter(Boolean))],
        sources: [...new Set(good.map(f => f.hdr.source).filter(x => x != null))],
        firstMs: null, lastMs: null,
        skew: null, skewN: 0, skewSpread: null,
      },
    };
  }

  // ── capture-level parse ───────────────────────────────────────────────────────

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function parseAscii(text) {
    const split = splitCapture(text);
    const frames = split.frames.map((src, i) => parseFrame(src, i));

    const good = frames.filter(f => !f.error);
    const recs = [];
    good.forEach(f => f.records.forEach(r => recs.push(r)));

    // How far the ERT-A2's clock sits from the ALERT2 frame time. Measured on
    // frames the receiver flagged clean, since the corrupt ones carry a payload
    // time that may itself be nonsense.
    const skews = good.filter(f => f.hdr.frameOk === 1 && f.hdr.clockSod !== null && f.payload)
                      .map(f => f.hdr.clockSod - f.payload.sod);
    const skew = median(skews);

    const clocks = good.map(f => f.hdr.clockMs).filter(x => x);
    return {
      text, mode: 'ascii', frames, records: recs,
      stats: {
        mode:      'ascii',
        frames:    frames.length,
        wrapped:   frames.filter(f => f.wrapped).length,
        prefixed:  frames.filter(f => f.prefix).length,
        errors:    frames.filter(f => f.error).length,
        warned:    good.filter(f => f.warn.length).length,
        records:   recs.length,
        badRecords: recs.filter(r => !r.ok).length,
        banners:   split.banners.length,
        junk:      split.junk,
        decoders:  [...new Set(good.map(f => f.hdr.decoder))],
        sources:   [...new Set(good.map(f => f.hdr.source))],
        agencies:  [...new Set(good.map(f => f.hdr.agency))],
        firstMs:   clocks.length ? Math.min(...clocks) : null,
        lastMs:    clocks.length ? Math.max(...clocks) : null,
        skew, skewN: skews.length,
        skewSpread: skews.length ? Math.max(...skews) - Math.min(...skews) : null,
      },
    };
  }

  // Which format a capture is in. The two are unmistakable from a few bytes —
  // one starts every line with the literal word ALERT2A, the other carries the
  // same word as hex — so sniffing beats making the operator classify a paste
  // they may not have looked at. A file holding both (an operator logging one
  // port after the other into the same file) reads as whichever yields more
  // frames, and the summary says which was chosen.
  const BIN_MAGIC_HEX = /4\s*1\W*4\s*C\W*4\s*5\W*5\s*2\W*5\s*4\W*3\s*2/i;

  function parse(text, mode) {
    const src = String(text || '');
    if (mode === 'ascii') return parseAscii(src);
    if (mode === 'bin')   return parseBin(src);

    const hasAscii = src.indexOf(TAG) >= 0;
    const hasBin   = BIN_MAGIC_HEX.test(src);
    if (hasAscii && !hasBin) return mark(parseAscii(src), 'auto');
    if (hasBin && !hasAscii) return mark(parseBin(src), 'auto');
    if (!hasAscii && !hasBin) return mark(parseAscii(src), 'auto');   // nothing recognisable; the ASCII path reports why
    const a = parseAscii(src), b = parseBin(src);
    const aN = a.stats.frames - a.stats.errors, bN = b.stats.frames - b.stats.errors;
    return mark(bN > aN ? b : a, 'auto');
  }

  function mark(p, how) { p.detected = how; return p; }

  // ── station resolution ────────────────────────────────────────────────────────
  //
  // An ALERT address is only unique within a region. MegaNet's database is
  // national, so ids get reused — 604 of its 5122 addresses belong to more than
  // one station, and a Queensland reading whose id is also a Victorian station's
  // will match both. The capture itself settles most of them: every frame in a
  // file came through one receiver, so the readings are all from one corner of
  // the country. Addresses that match exactly one station fix where that corner
  // is, and an ambiguous address then resolves to whichever candidate is near it.
  //
  // What this deliberately does not do is force a winner. Two stations 6 km apart
  // sharing the same ids (Wamuran McClintock Rd and Wamuran Eureka Ct do) cannot
  // be told apart by anything in the frame, and guessing between them would be
  // worse than saying so — those are reported as ambiguous, with a pin so an
  // operator who knows the answer can record it for the rest of the capture.

  const GAP_KM = 100;   // how much closer the winner must be before it is called resolved

  const idx = { src: null, byId: null };
  function alertIndex() {
    if (!state.data || !Array.isArray(state.data.stations)) return new Map();
    if (idx.src !== state.data) {
      idx.src = state.data;
      idx.byId = new Map();
      state.data.stations.forEach(s => {
        const types = new Map();
        stationSensors(s).forEach(se => {
          if (!se || se.alert_id == null) return;
          if (!types.has(se.alert_id)) types.set(se.alert_id, new Set());
          if (se.type) types.get(se.alert_id).add(se.type);
        });
        types.forEach((tset, aid) => {
          if (!idx.byId.has(aid)) idx.byId.set(aid, []);
          idx.byId.get(aid).push({ station: s, types: [...tset] });
        });
      });
    }
    return idx.byId;
  }

  function kmApart(aLat, aLon, bLat, bLon) {
    const dLat = (aLat - bLat) * 111.32;
    const dLon = (aLon - bLon) * 111.32 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function resolve(parsed) {
    const byId = alertIndex();
    const seen = new Map();
    parsed.records.forEach(r => { if (r.ok) seen.set(r.alertId, (seen.get(r.alertId) || 0) + 1); });

    const anchors = [];
    seen.forEach((n, aid) => {
      const c = byId.get(aid);
      if (c && c.length === 1 && c[0].station.lat != null && c[0].station.lon != null) anchors.push(c[0].station);
    });
    // Median, not mean: one station on the far side of the country would drag a
    // mean far enough to start picking the wrong candidates for everything else.
    const centre = anchors.length
      ? { lat: median(anchors.map(s => s.lat)), lon: median(anchors.map(s => s.lon)), n: anchors.length }
      : null;

    const out = new Map();
    seen.forEach((count, aid) => {
      const cands = (byId.get(aid) || []).map(c => {
        const st = c.station;
        const others = stationAlertIds(st).filter(x => x !== aid);
        return {
          station: st, types: c.types,
          distKm: (centre && st.lat != null && st.lon != null) ? kmApart(centre.lat, centre.lon, st.lat, st.lon) : null,
          siblings: others.filter(x => seen.has(x)).length,
          siblingsTotal: others.length,
        };
      });
      cands.sort((a, b) => ((a.distKm == null ? Infinity : a.distKm) - (b.distKm == null ? Infinity : b.distKm))
                        || (b.siblings - a.siblings));

      const pin = state.a2.picks[aid];
      let conf, chosen = null;
      if (!cands.length) conf = 'unknown';
      else if (pin != null && cands.some(c => c.station.id === pin)) { chosen = cands.find(c => c.station.id === pin); conf = 'pinned'; }
      else if (cands.length === 1) { chosen = cands[0]; conf = 'sole'; }
      else {
        chosen = cands[0];
        const a = cands[0], b = cands[1];
        if (a.distKm != null && b.distKm != null && b.distKm - a.distKm >= GAP_KM) conf = 'resolved';
        else if (a.siblings > b.siblings) conf = 'likely';
        else conf = 'ambiguous';
      }
      out.set(aid, { aid, count, cands, chosen, conf,
                     kind: chosen ? kindOf(chosen.types) : null,
                     // Only worth asking the bundled national address file about
                     // ids MegaNet has never heard of.
                     fileName: cands.length ? null : Packets.stationName(aid) });
    });
    return { byAlertId: out, centre, anchors: anchors.length,
             ambiguous: [...out.values()].filter(r => r.conf === 'ambiguous' || r.conf === 'likely').length,
             unknown: [...out.values()].filter(r => r.conf === 'unknown').length };
  }

  function kindOf(types) {
    const t = (types || []).join(' ').toLowerCase();
    if (/batt/.test(t)) return 'battery';
    if (/rain/.test(t)) return 'rain';
    if (/level|stage|ahd|height/.test(t)) return 'level';
    return null;
  }

  // Engineering values are an interpretation laid over the reading, not part of
  // it, so only the two that the reference capture actually supports are offered.
  // Battery values cluster at 130–142 across 213 readings, which is 13.0–14.2 V
  // and nothing else; rainfall counts step up one at a time, which is a tipping
  // bucket. Water level is left as raw counts because its scale is set per site
  // and the capture gives no way to tell which — a number invented here would
  // read like a measurement.
  //
  // `st` is the station the address resolved to, if any (see rowsFor /
  // stationRollup). When it carries a recorded TBRGbucketSize that wins; the
  // per-capture "mm per tip" box (a.mmPerTip, default 0.2) is a fallback for
  // everything else, not the only source any more. Either way the rule text
  // says which one was used — a converted millimetre value that doesn't say
  // that is exactly the kind of number that ends up in a report.
  function engValue(kind, raw, st) {
    const a = state.a2;
    if (!a.eng) return null;
    if (kind === 'battery' && a.battDiv > 0) return { text: (raw / a.battDiv).toFixed(1) + ' V',  rule: 'raw ÷ ' + a.battDiv };
    if (kind === 'rain') {
      const bucket = bucketSizeMm(st);
      const mmPerTip = bucket.recorded ? bucket.mm : a.mmPerTip;
      if (!(mmPerTip > 0)) return null;
      const mm = raw * mmPerTip;
      const source = bucket.recorded ? `recorded for ${st.name}`
                   : st ? `assumed — not recorded for ${st.name}`
                        : 'assumed — no station resolved';
      return { text: (Math.round(mm * 100) / 100) + ' mm',
               rule: 'raw × ' + mmPerTip + ' mm per tip (' + source + '), cumulative' };
    }
    return null;
  }

  // ── formatting helpers ────────────────────────────────────────────────────────

  function hx(b)   { return b.toString(16).toUpperCase().padStart(2, '0'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function hms(sod) {
    if (sod == null) return '—';
    const s = Math.floor(sod);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
  }
  function clockText(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function isoText(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  // "12 h 00 m 01 s", for the clock-skew note. Signed, because which way the
  // clock is wrong is the whole point.
  function durText(sec) {
    const neg = sec < 0; let s = Math.round(Math.abs(sec));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);   s -= m * 60;
    const bits = [];
    if (h) bits.push(h + ' h');
    if (m) bits.push(m + ' m');
    if (s || !bits.length) bits.push(s + ' s');
    return (neg ? '−' : '') + bits.join(' ');
  }

  const CONF = {
    sole:      { badge: 'ok',   text: 'unique',    note: 'only one station in the database carries this address' },
    pinned:    { badge: 'ok',   text: 'pinned',    note: 'you chose this station for this address' },
    resolved:  { badge: 'ok',   text: 'resolved',  note: 'several stations share this address; the others are far outside this capture\'s area' },
    likely:    { badge: 'warn', text: 'likely',    note: 'several nearby candidates — this one has more of its other addresses in the capture' },
    ambiguous: { badge: 'bad',  text: 'ambiguous', note: 'candidates too close together to choose between — pin one below' },
    unknown:   { badge: 'bad',  text: 'no match',  note: 'no station in the database carries this address' },
  };

  // ── derived views over the parse ──────────────────────────────────────────────

  // The parse is cached against the exact text it came from, so switching views,
  // toggling a scale or pinning a station re-renders without re-reading the
  // capture — but pasting one character does re-read it.
  function current() {
    const a = state.a2;
    const key = a.mode + ' ' + a.text;
    if (!a.parsed || a.parsedKey !== key) {
      a.parsed = a.text.trim() ? parse(a.text, a.mode) : null;
      a.parsedKey = key;
    }
    return a.parsed;
  }

  function rowsFor(p, res) {
    const a = state.a2;
    const rows = [];
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        const kind = info ? info.kind : null;
        if (a.onlyErrors && r.ok && !f.warn.length) return;
        if (a.hideUnknown && !st) return;
        rows.push({ r, f, info, st, kind, key: selKey(st, r.alertId), eng: engValue(kind, r.value, st) });
      });
    });
    return rows;
  }

  // What the table and the map agree to call one thing. A station carries three
  // or four ALERT addresses — rain, level, battery — and is one pin, so clicking
  // it has to light up every row it sent, not just the address that happens to
  // be under the cursor. Addresses that match no station keep their own key so
  // they still select as a unit, they just have nowhere to be drawn.
  function selKey(st, aid) { return st ? 'S' + st.id : 'A' + aid; }

  function stationRollup(p, res) {
    const by = new Map();
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        if (!r.ok) return;
        let e = by.get(r.alertId);
        if (!e) by.set(r.alertId, e = { aid: r.alertId, n: 0, first: null, last: null, min: Infinity, max: -Infinity, lastVal: null, rssi: [] });
        e.n++;
        const sod = f.payload.sod;
        if (e.first === null || sod < e.first) e.first = sod;
        if (e.last === null || sod >= e.last) { e.last = sod; e.lastVal = r.value; }
        e.min = Math.min(e.min, r.value);
        e.max = Math.max(e.max, r.value);
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    return [...by.values()].map(e => {
      const info = res.byAlertId.get(e.aid);
      const st = info && info.chosen ? info.chosen.station : null;
      return Object.assign(e, { info, st, key: selKey(st, e.aid),
                                kind: info ? info.kind : null, eng: engValue(info ? info.kind : null, e.lastVal, st),
                                rssiMed: median(e.rssi), rssiBest: e.rssi.length ? Math.max(...e.rssi) : null,
                                rssiWorst: e.rssi.length ? Math.min(...e.rssi) : null });
    }).sort((x, y) => x.aid - y.aid);
  }

  // ── RSSI ──────────────────────────────────────────────────────────────────────
  //
  // The whole reason the binary format is worth reading. The bands are indicative
  // rather than a specification: the reference capture runs −81 to −114 dBm and
  // an ERT-A2 is usable to about −115, so the scale is laid out over the range a
  // real network actually occupies. It colours the map pins and the table cells,
  // and it is deliberately the same scale in both.
  const RSSI_BANDS = [
    { max: Infinity, min: -90,      color: '#137a3b', label: 'strong',   note: 'above −90 dBm' },
    { max: -90,      min: -100,     color: '#5a9e18', label: 'good',     note: '−90 to −100 dBm' },
    { max: -100,     min: -107,     color: '#c08a12', label: 'fair',     note: '−100 to −107 dBm' },
    { max: -107,     min: -112,     color: '#d4691f', label: 'marginal', note: '−107 to −112 dBm' },
    { max: -112,     min: -Infinity, color: '#b3261e', label: 'weak',    note: 'below −112 dBm' },
  ];
  function rssiBand(v) {
    if (v == null) return null;
    return RSSI_BANDS.find(b => v > b.min && v <= b.max) || RSSI_BANDS[RSSI_BANDS.length - 1];
  }
  function rssiCell(v) {
    if (v == null) return '<span class="spec">—</span>';
    const b = rssiBand(v);
    return '<span class="a2-rssi" style="--rssi:' + b.color + '" title="' + esc(b.label + ' — ' + b.note) + '">'
         + v + '<i>dBm</i></span>';
  }

  // ── rendering: shared bits ────────────────────────────────────────────────────

  function stationCell(info) {
    if (!info) return '<span class="stn none">—</span>';
    if (info.conf === 'unknown') {
      const f = info.fileName;
      return f && !f.none
        ? '<span class="stn">' + esc(f.text) + '</span> <span class="badge warn">address file</span>'
        : '<span class="stn none">no match</span>';
    }
    const c = CONF[info.conf];
    return stationLink(info.chosen.station)
         + (info.conf === 'sole' ? '' : ' <span class="badge ' + c.badge + '" title="' + esc(c.note) + '">' + c.text + '</span>');
  }

  // A named station is a station the operator will want to look at in full —
  // its sensors, its network, its position — and all of that already exists one
  // tab across. goToStation selects the row there, scrolls it into view and
  // pans that map to it, so the name is the shortest path to the rest of what
  // MegaNet knows about the site the reading came from.
  //
  // stopPropagation because these rows are themselves clickable: without it,
  // following the link would also fire the row's own map selection on the way
  // out of a tab that is about to be replaced.
  function stationLink(st) {
    return '<a class="stn a2-stlink" href="javascript:void 0" onclick="event.stopPropagation();goToStation(\''
         + escAttr(st.id) + '\')" title="Open ' + escAttr(st.name) + ' on the Stations tab">'
         + esc(st.name) + '</a>';
  }

  function valueCell(row) {
    const full = row.r.value === FULL_SCALE
      ? ' <span class="badge warn" title="11 bits all set — over-range, or a sensor reading nothing">full scale</span>' : '';
    const eng = row.eng ? '<div class="spec" style="margin-top:2px" title="' + esc(row.eng.rule) + '">' + esc(row.eng.text) + '</div>' : '';
    return '<span class="val">' + row.r.value + '</span>' + full + eng;
  }

  function typeCell(info) {
    if (!info || !info.chosen) return '<span class="spec">—</span>';
    return '<span class="spec">' + esc(info.chosen.types.join(', ') || '—') + '</span>';
  }

  // ── rendering: frame anatomy ──────────────────────────────────────────────────
  //
  // The point of this view: every byte on the wire, coloured by what it means,
  // sitting directly above the reading it produced. The packed byte gets its own
  // bit row because that is the one place the encoding stops being obvious —
  // three bits of data value living in the top of an address byte.

  function fieldChips(f) {
    let html = '<div class="a2-chips">';
    FIELDS.forEach((spec, i) => {
      const v = f.fields[i];
      if (v === undefined) return;
      html += '<span class="a2-chip r-' + spec.role + (spec.sure ? '' : ' unsure') + '" title="'
            + esc(spec.label + (spec.note ? ' — ' + spec.note : '')) + '">'
            + '<b>' + esc(v) + '</b><i>' + esc(spec.label) + '</i></span>';
    });
    html += '</div>';
    return html;
  }

  // The binary frame's equivalent. A TLV stream has no fixed field list to lay
  // out, so this draws what the frame actually contained, in wire order, with
  // the two containers' children indented under them — and the value rendered
  // as whatever its tag says it is rather than as bare hex.
  function tlvChips(f) {
    let html = '<div class="a2-tlv">';
    f.tlv.forEach(e => {
      const spec = e.spec;
      const role = spec ? spec.role : 'bad';
      const label = spec ? spec.label : 'unknown element';
      const note = spec ? spec.note : 'Not an element this decoder has seen; its bytes are shown raw.';
      html += '<div class="a2-tlvrow" style="margin-left:' + (e.depth * 22) + 'px">'
            + '<span class="a2-chip r-' + role + (spec && spec.sure ? '' : ' unsure')
            + '" title="' + esc(label + ' — ' + note) + '"><b>' + e.tag + '</b><i>' + esc(label) + '</i></span>'
            + '<code class="a2-tlvlen">' + e.len + ' B</code>'
            + '<span class="a2-tlvval">' + tlvValue(e) + '</span>'
            + '</div>';
    });
    html += '</div>';
    return html;
  }

  function tlvValue(e) {
    const raw = '<code>' + e.val.map(hx).join(' ') + '</code>';
    const kind = e.spec ? e.spec.kind : null;
    if (kind === 'container') return '<span class="spec">' + e.len + ' bytes of nested elements, below</span>';
    if (kind === 'u8'  && e.len >= 1) return '<b>' + e.val[0] + '</b> ' + raw;
    if (kind === 'u16' && e.len >= 2) return '<b>' + u16(e.val, 0) + '</b> ' + raw;
    if (kind === 'i8'  && e.len >= 1) return rssiCell(i8(e.val[0])) + ' ' + raw;
    if (kind === 'ascii') return '<b>' + esc(String.fromCharCode.apply(null, e.val)) + '</b> ' + raw;
    if (kind === 'mant' && e.len >= 6)
      return '<code>' + e.val.slice(0, 3).map(hx).join(' ') + '</code> <span class="spec">constant</span> · '
           + '<b>' + e.val[3] + '</b> <span class="spec">payload bytes</span> · '
           + '<b>' + u16(e.val, 4) + '</b> <span class="spec">source</span>';
    if (kind === 'buf' && e.len >= 2) {
      const n = u16(e.val, 0);
      const pad = Math.max(0, e.len - 2 - n);
      return '<code>' + e.val.slice(2, 2 + n).map(hx).join(' ') + '</code>'
           + (pad ? ' <span class="spec">+ ' + pad + ' × ' + hx(BIN_FILL) + ' fill</span>' : '');
    }
    if (kind === 'payload') return '<span class="spec">decoded below</span> ' + raw;
    return raw;
  }

  function payloadStrip(f) {
    const p = f.payload;
    const cell = (txt, lbl, cls, attrs) =>
      '<span class="a2-byte ' + cls + '"' + (attrs || '') + '><b>' + esc(txt) + '</b><i>' + esc(lbl) + '</i></span>';
    let html = '<div class="a2-bytes">';
    html += '<span class="a2-bgroup">'
          + cell(hx(p.bytes[0]), 'type', 'r-ident')
          + cell(hx(p.bytes[1]), 'time hi', 'r-time')
          + cell(hx(p.bytes[2]), 'time lo', 'r-time')
          + '</span>';
    f.records.forEach((r, i) => {
      const at = ' data-rec="' + i + '"';
      html += '<span class="a2-bgroup" data-rec="' + i + '">'
            + cell(hx(r.bytes[0]), 'id lo', 'r-addr', at)
            + cell(hx(r.bytes[1]), 'val hi + id hi', 'r-pack', at)
            + cell(hx(r.bytes[2]), 'val lo', 'r-data', at)
            + cell(hx(r.bytes[3]), 'status', r.ok ? 'r-status' : 'r-status bad', at)
            + '</span>';
    });
    const spare = p.body.length % REC_BYTES;
    if (spare) {
      html += '<span class="a2-bgroup">';
      p.bytes.slice(p.bytes.length - spare).forEach(b => { html += cell(hx(b), 'spare', 'r-bad'); });
      html += '</span>';
    }
    html += '</div>';
    return html;
  }

  // byte 1, bit by bit: DDD AAAAA. Reuses the ALERT Packets bit cells so the two
  // tabs draw a packed field the same way.
  function packedBits(b1) {
    let cells = '', labels = '';
    for (let i = 7; i >= 0; i--) {
      const isData = i >= 5;
      cells  += '<div class="bit ' + (isData ? 'f-D' : 'f-A') + '">' + ((b1 >> i) & 1) + '</div>';
      labels += '<span>' + (isData ? 'D' + (i + 3) : 'A' + (i + 8)) + '</span>';
    }
    return '<div class="bitword"><div class="bitrow">' + cells + '</div><div class="lblrow">' + labels + '</div></div>';
  }

  function recordBlock(r, i, res) {
    const info = res.byAlertId.get(r.alertId);
    const st   = info && info.chosen ? info.chosen.station : null;
    const eng = engValue(info ? info.kind : null, r.value, st);
    const [b0, b1, b2, b3] = r.bytes;
    return '<div class="a2-rec' + (r.ok ? '' : ' bad') + '" data-rec="' + i + '">'
      + '<div class="a2-rec-head">Reading ' + (i + 1) + ' <span class="spec">payload bytes ' + r.off + '–' + (r.off + 3)
      + ' · <code>' + r.bytes.map(hx).join(' ') + '</code></span></div>'
      + '<div class="a2-rec-body">'
      +   '<div class="a2-rec-bits">' + packedBits(b1) + '<div class="spec">the packed byte</div></div>'
      +   '<div class="a2-rec-maths">'
      +     '<div><span class="swatch" style="background:var(--c-addr)"></span>ALERT id'
      +       ' <code>(0x' + hx(b1) + ' &amp; 0x1F) &lt;&lt; 8 | 0x' + hx(b0) + '</code> = <span class="val">' + r.alertId + '</span>'
      +       ' &nbsp;' + stationCell(info) + typeCellInline(info) + '</div>'
      +     '<div><span class="swatch" style="background:var(--c-data)"></span>Value'
      +       ' <code>(0x' + hx(b1) + ' &gt;&gt; 5) &lt;&lt; 8 | 0x' + hx(b2) + '</code> = <span class="val">' + r.value + '</span>'
      +       (eng ? ' &nbsp;<b>' + esc(eng.text) + '</b> <span class="spec">(' + esc(eng.rule) + ')</span>' : '')
      +       (r.value === FULL_SCALE ? ' <span class="badge warn">full scale</span>' : '') + '</div>'
      +     '<div><span class="swatch" style="background:var(--c-status)"></span>Status <code>0x' + hx(b3) + '</code> — '
      +       (r.ok ? '<span style="color:var(--ok)">valid</span>' : '<span style="color:var(--bad)">non-zero, treat the reading as corrupt</span>') + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  function typeCellInline(info) {
    if (!info || !info.chosen || !info.chosen.types.length) return '';
    return ' <span class="spec">' + esc(info.chosen.types.join(', ')) + '</span>';
  }

  function frameCard(f, res, open) {
    const badges = [];
    if (f.error)             badges.push('<span class="badge bad">error</span>');
    else if (f.warn.length)  badges.push('<span class="badge warn">' + f.warn.length + ' warning' + (f.warn.length > 1 ? 's' : '') + '</span>');
    else                     badges.push('<span class="badge ok">clean</span>');
    if (f.wrapped) badges.push('<span class="badge warn">re-joined</span>');

    const bin = f.kind === 'bin';
    if (bin) badges.push('<span class="badge ok" title="Read from the binary framing the USB port emits">USB</span>');

    const summary = f.error
      ? esc(f.error)
      : hms(f.payload.sod) + ' · ' + f.records.length + ' reading' + (f.records.length === 1 ? '' : 's')
        + (f.hdr.rssi != null ? ' · ' + f.hdr.rssi + ' dBm' : '')
        + ' · ' + f.records.map(r => r.alertId + ':' + r.value).join('  ');

    let body = '<div class="a2-raw"><code>' + esc(f.raw) + '</code></div>';
    if (f.prefix) {
      // What the terminal put in front of the frame. Shown rather than silently
      // dropped, so it is obvious the line was stripped and not mis-parsed.
      const when = f.prefix.dated ? new Date(f.prefix.ms).toISOString().replace('T', ' ').replace('.000Z', '')
                 : f.prefix.sod != null ? hms(f.prefix.sod) : null;
      body += '<div class="spec">Terminal stamped this line <code>' + esc(f.prefix.text) + '</code>'
            + (when ? ' — read as ' + esc(when) : ' — not recognised as a time, so it was set aside') + '.</div>';
    }
    if (f.warn.length) body += '<ul class="a2-warn">' + f.warn.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
    if (!f.error) {
      if (bin) {
        body += '<h4 class="a2-h">Frame elements</h4>' + tlvChips(f);
        body += '<div class="spec">Tag, length, value — nesting shown by indent. Faded chips are elements that were '
              + 'constant across every frame cross-checked against Ranger, so their meaning is recorded but not established.</div>';
      } else {
        body += '<h4 class="a2-h">Header fields</h4>' + fieldChips(f);
        body += '<div class="spec">Faded chips are fields that were constant across every frame in the reference capture, so their meaning is recorded but not established.</div>';
      }
      body += '<h4 class="a2-h">Payload — ALERT concentration, ' + f.payload.bytes.length + ' bytes</h4>' + payloadStrip(f);
      body += '<div class="spec">Frame time <b>' + hms(f.payload.sod) + '</b> (' + f.payload.sod
            + ' s since midnight, from the two time bytes). '
            + (bin
                ? 'Received at <b>' + (f.hdr.rssi != null ? f.hdr.rssi + ' dBm' : 'an unreported level')
                  + '</b>. This framing carries no receiver clock, so the payload time is the only time in it.'
                : 'ERT-A2 clock <b>' + clockText(f.hdr.clockMs) + '</b>.')
            + '</div>';
      body += f.records.map((r, i) => recordBlock(r, i, res)).join('');
      if (!f.records.length) body += '<p class="spec">No complete readings in this payload.</p>';
    }
    return '<div class="fmtcard' + (open ? ' open' : '') + '">'
      + '<div class="fmthead" onclick="this.parentElement.classList.toggle(\'open\')">'
      + '<h3>' + (bin ? 'Frame ' + (f.seq + 1) : 'Line ' + f.lineNo) + '</h3>' + badges.join(' ')
      + '<span class="caret">' + esc(summary.slice(0, 400)) + ' ▾</span></div>'
      + '<div class="fmtbody">' + body + '</div></div>';
  }

  // ── rendering: panels ─────────────────────────────────────────────────────────

  function statChip(n, label, kind) {
    return '<div class="a2-stat' + (kind ? ' ' + kind : '') + '"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>';
  }

  function summaryPanel(p, res) {
    const s = p.stats;
    const rssis = p.frames.filter(f => !f.error && f.hdr.rssi != null).map(f => f.hdr.rssi);
    const chips =
        statChip(s.frames - s.errors, 'frames decoded')
      + statChip(s.records, 'readings')
      + statChip(res.byAlertId.size, 'ALERT addresses')
      + (rssis.length ? statChip(median(rssis) + ' dBm', 'median RSSI') : '')
      + statChip(res.unknown, 'unmatched addresses', res.unknown ? 'warn' : '')
      + statChip(res.ambiguous, 'need a choice', res.ambiguous ? 'warn' : '')
      + statChip(s.errors + s.badRecords, 'errors', (s.errors + s.badRecords) ? 'bad' : '');

    const ingest = [];
    ingest.push(s.mode === 'bin'
      ? 'Read as the <b>binary framing</b> the ERT-A2 emits on USB'
      : 'Read as the <b>ALERT2 ASCII protocol</b> the ERT-A2 writes to its RS232 port');
    if (p.detected === 'auto') ingest.push('detected automatically');
    if (s.banners) ingest.push(s.banners + ' PuTTY session banner' + (s.banners === 1 ? '' : 's') + ' skipped');
    if (s.wrapped) ingest.push(s.wrapped + ' wrapped line' + (s.wrapped === 1 ? '' : 's') + ' re-joined');
    if (s.mode !== 'bin' && s.prefixed) ingest.push(s.prefixed + ' line' + (s.prefixed === 1 ? '' : 's') + ' had a terminal timestamp in front, stripped');
    if (s.ingest) s.ingest.forEach(x => ingest.push(x));
    if (s.junk.length) ingest.push(s.junk.length + ' line' + (s.junk.length === 1 ? '' : 's') + ' ignored (line '
      + s.junk.slice(0, 3).map(j => j.lineNo).join(', ') + (s.junk.length > 3 ? ', …' : '') + ')');
    if (s.errors) ingest.push(s.errors + ' frame' + (s.errors === 1 ? '' : 's') + ' could not be decoded');

    const rssiNote = rssis.length
      ? '<div class="spec">RSSI ranges ' + Math.min(...rssis) + ' to ' + Math.max(...rssis)
        + ' dBm across ' + rssis.length + ' frame' + (rssis.length === 1 ? '' : 's') + '.</div>'
      : (s.mode === 'bin' ? '' : '<div class="spec">This format carries no signal level. To get RSSI against each packet, '
        + 'capture the USB port instead and paste the hex — see the protocol reference above.</div>');

    let clock = '';
    if (s.skew !== null) {
      // A few seconds of scatter is the gap between transmission and the receiver
      // getting the frame out of the port. Anything wider is the clock itself
      // moving, which is a different fault and must not be called latency.
      const steady = s.skewSpread == null || s.skewSpread <= 5;
      const spread = steady
        ? (s.skewSpread ? ' (spread ' + Math.round(s.skewSpread) + ' s, which is receive latency)' : '')
        : ', though it ranges over ' + durText(s.skewSpread) + ' — the offset is not constant, so the clock drifted or was reset part-way through this capture';
      clock = '<div class="note compact" style="margin-top:.8rem">'
        + (Math.abs(s.skew) < 2
            ? 'The ERT-A2 clock <b>agrees</b> with the ALERT2 frame time to within a couple of seconds across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + '.'
            : 'The ERT-A2 header clock reads <b>' + durText(s.skew) + ' '
              + (s.skew > 0 ? 'ahead of' : 'behind') + '</b> the ALERT2 frame time across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + spread + '. '
              + 'The frame time comes from the transmitting network and the header time from the receiver\'s own RTC, '
              + 'so it is the unit\'s clock that needs setting — not the readings.')
        + '</div>';
    }

    const idents = [
      s.decoders.length ? 'decoder address ' + esc(s.decoders.join(', ')) : '',
      s.sources.length  ? 'source address '  + esc(s.sources.join(', '))  : '',
      s.agencies.length ? 'agency '          + esc(s.agencies.join(', ')) : '',
    ].filter(Boolean).join(' · ');
    const span = (s.firstMs && s.lastMs)
      ? '<div class="spec">ERT-A2 clock spans ' + esc(clockText(s.firstMs)) + ' → ' + esc(clockText(s.lastMs)) + '.'
        + (idents ? ' ' + idents.charAt(0).toUpperCase() + idents.slice(1) : '') + '</div>'
      : (idents ? '<div class="spec">' + idents.charAt(0).toUpperCase() + idents.slice(1) + '.</div>' : '');

    const anchors = res.centre
      ? '<div class="spec">Ambiguous addresses were judged against the middle of this capture ('
        + res.centre.lat.toFixed(3) + ', ' + res.centre.lon.toFixed(3) + '), fixed by '
        + res.anchors + ' address' + (res.anchors === 1 ? '' : 'es') + ' that match exactly one station.</div>'
      : (state.data ? '<div class="spec">No address in this capture matches exactly one station, so there is nothing to place it geographically — shared addresses are all reported as ambiguous.</div>' : '');

    return `
      <div class="panel">
        <div class="panel-header"><h3>Capture summary</h3></div>
        <div class="a2-stats">${chips}</div>
        ${ingest.length ? '<div class="spec" style="margin-top:.6rem">' + ingest.join(' · ') + '.</div>' : ''}
        ${rssiNote}
        ${span}
        ${anchors}
        ${clock}
      </div>`;
  }

  // Columns only one of the two formats can fill are dropped when the capture is
  // the other one, rather than drawn as a column of dashes: the ASCII lines have
  // a receiver clock and no RSSI, the binary frames the reverse.
  function cols(p) {
    return {
      clock: p.frames.some(f => !f.error && f.hdr.clockMs),
      rssi:  p.frames.some(f => !f.error && f.hdr.rssi != null),
    };
  }

  // data-key is what ties a row to its pin. Clicking anywhere in the row selects
  // the station — except the station name itself, which is a link out to the
  // Stations tab and stops the event.
  function rowAttrs(key, extra) {
    return ' class="a2-row' + (state.a2.sel === key ? ' sel' : '') + (extra ? ' ' + extra : '') + '"'
         + ' data-key="' + escAttr(key) + '" onclick="Alert2.select(\'' + escAttr(key) + '\')"';
  }

  function readingsView(p, res) {
    const a = state.a2;
    const c = cols(p);
    const rows = rowsFor(p, res);
    const shown = rows.slice(0, a.limit);
    let html = '<div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>'
      + '<th>FRAME TIME</th>' + (c.clock ? '<th>ERT-A2 CLOCK</th>' : '')
      + '<th>ALERT ID</th><th>STATION</th><th>SENSOR</th><th>VALUE</th>'
      + (c.rssi ? '<th>RSSI</th>' : '') + '<th>' + (p.stats.mode === 'bin' ? 'FRAME' : 'LINE') + '</th>'
      + '</tr></thead><tbody>';
    shown.forEach(row => {
      html += '<tr' + rowAttrs(row.key, row.r.ok ? '' : 'a2-badrow') + '>'
        + '<td><code>' + hms(row.f.payload.sod) + '</code></td>'
        + (c.clock ? '<td><span class="spec">' + esc(clockText(row.f.hdr.clockMs)) + '</span></td>' : '')
        + '<td><b>' + row.r.alertId + '</b></td>'
        + '<td>' + stationCell(row.info) + '</td>'
        + '<td>' + typeCell(row.info) + '</td>'
        + '<td>' + valueCell(row) + '</td>'
        + (c.rssi ? '<td>' + rssiCell(row.f.hdr.rssi) + '</td>' : '')
        + '<td><a class="a2-link" onclick="event.stopPropagation();Alert2.openFrame(' + row.f.seq + ')">'
        + (p.stats.mode === 'bin' ? row.f.seq + 1 : row.f.lineNo) + ' ▸</a></td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (!rows.length) html += '<p class="spec">No readings match the current filters.</p>';
    if (rows.length > shown.length)
      html += '<div style="margin-top:12px"><button class="ghost" onclick="Alert2.more()">Show '
            + Math.min(ROW_STEP, rows.length - shown.length) + ' more</button> '
            + '<span class="spec">showing ' + shown.length + ' of ' + rows.length + ' readings</span></div>';
    return html;
  }

  function stationsView(p, res) {
    const c = cols(p);
    const roll = stationRollup(p, res);
    let html = '<p class="sub">One row per ALERT address heard, newest value last. This is the view that answers '
             + '“is that station still reporting, and what is it saying”'
             + (c.rssi ? ' — and, from the USB capture, how well it is being heard.' : '.') + '</p>'
             + '<div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>'
             + '<th>ALERT ID</th><th>STATION</th><th>SENSOR</th><th>HEARD</th><th>FIRST → LAST</th><th>RANGE</th><th>LATEST</th>'
             + (c.rssi ? '<th>RSSI MEDIAN</th><th>BEST / WORST</th>' : '')
             + '</tr></thead><tbody>';
    roll.forEach(e => {
      html += '<tr' + rowAttrs(e.key) + '>'
        + '<td><b>' + e.aid + '</b></td>'
        + '<td>' + stationCell(e.info) + '</td>'
        + '<td>' + typeCell(e.info) + '</td>'
        + '<td>' + e.n + '</td>'
        + '<td><code>' + hms(e.first) + '</code> → <code>' + hms(e.last) + '</code></td>'
        + '<td><span class="spec">' + e.min + ' – ' + e.max + '</span></td>'
        + '<td><span class="val">' + e.lastVal + '</span>'
        + (e.eng ? ' <span class="spec">' + esc(e.eng.text) + '</span>' : '') + '</td>'
        + (c.rssi ? '<td>' + rssiCell(e.rssiMed) + '</td>'
                  + '<td><span class="spec">' + (e.rssiBest == null ? '—' : e.rssiBest + ' / ' + e.rssiWorst) + '</span></td>' : '')
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (!roll.length) html += '<p class="spec">No valid readings in this capture.</p>';
    return html;
  }

  function framesView(p, res) {
    const a = state.a2;
    const list = a.onlyErrors ? p.frames.filter(f => f.error || f.warn.length) : p.frames;
    const shown = list.slice(0, Math.max(1, Math.floor(a.limit / 4)));
    let html = '<p class="sub">Every byte of a frame, coloured by meaning, above the readings it produced. '
             + 'Click a line to open it.</p>';
    html += shown.map(f => frameCard(f, res, f.seq === a.frameIdx)).join('');
    if (!list.length) html += '<p class="spec">No frames match the current filter.</p>';
    if (list.length > shown.length)
      html += '<div style="margin-top:12px"><button class="ghost" onclick="Alert2.more()">Show more</button> '
            + '<span class="spec">showing ' + shown.length + ' of ' + list.length + ' frames</span></div>';
    return html;
  }

  function ambiguityPanel(res) {
    const rows = [...res.byAlertId.values()].filter(r => r.conf === 'ambiguous' || r.conf === 'likely');
    if (!rows.length) return '';
    let html = `
      <div class="panel">
        <div class="panel-header"><h3>Addresses that need a choice <span class="badge warn">${rows.length}</span></h3></div>
        <p class="sub">These ALERT addresses belong to more than one station in the database, and the candidates are
          close enough together that the capture cannot separate them. Pick the right one and it applies to every
          reading on this address for the rest of the capture.</p>`;
    rows.forEach(r => {
      html += '<div class="a2-ambig"><div class="a2-ambig-id">' + r.aid
            + ' <span class="spec">' + r.count + ' reading' + (r.count === 1 ? '' : 's') + '</span></div><div>';
      // Candidates can share a name as well as an address — the database holds
      // more than one pair of same-named records — so the station number goes on
      // the button too. Two identical buttons would be no choice at all.
      const sameName = new Set(r.cands.map(c => c.station.name)).size < r.cands.length;
      r.cands.forEach(c => {
        const on = r.chosen === c;
        const num = c.station.station_number;
        html += '<button class="ghost' + (on ? ' on' : '') + '" onclick="Alert2.pick(' + r.aid + ',\'' + escAttr(c.station.id) + '\')">'
          + esc(c.station.name) + (sameName && num ? ' <small>· ' + esc(num) + '</small>' : '') + '</button>'
          + '<span class="spec"> ' + (c.distKm == null ? 'no coordinates' : Math.round(c.distKm) + ' km from this capture')
          + (!sameName && num ? ' · ' + esc(num) : '')
          + ' · ' + c.siblings + '/' + c.siblingsTotal + ' of its other addresses heard'
          + (c.types.length ? ' · ' + esc(c.types.join(', ')) : '') + '</span><br>';
      });
      html += '</div></div>';
    });
    if (Object.keys(state.a2.picks).length)
      html += '<div style="margin-top:10px"><button class="ghost" onclick="Alert2.clearPicks()">Clear all pinned choices</button></div>';
    html += '</div>';
    return html;
  }

  // ── rendering: coverage map ───────────────────────────────────────────────────
  //
  // What a capture is really telling you is who this receiver can hear, and that
  // is a geographic question. One pin per station heard, sized by how much it
  // sent and — on a USB capture — coloured by how well it came in, which turns a
  // list of readings into a picture of the receiver's coverage.
  //
  // The pins and the table are one selection, not two: clicking a pin lights up
  // every row that station sent, and clicking a row lights up its pin. A station
  // carries several ALERT addresses, so the two only line up if they agree on
  // the station being the unit — which is what selKey settles.

  function mapPoints(p, res) {
    const by = new Map();
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        if (!r.ok) return;
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        if (!st || st.lat == null || st.lon == null) return;
        let e = by.get(st.id);
        if (!e) by.set(st.id, e = { st, key: selKey(st, r.alertId), aids: new Set(), n: 0, rssi: [], conf: info.conf });
        e.aids.add(r.alertId);
        e.n++;
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    return [...by.values()].map(e => Object.assign(e, {
      rssiMed:   median(e.rssi),
      rssiBest:  e.rssi.length ? Math.max(...e.rssi) : null,
      rssiWorst: e.rssi.length ? Math.min(...e.rssi) : null,
    }));
  }

  function mapPanel(p, res) {
    if (!state.data) return `
      <div class="panel">
        <div class="panel-header"><h3>Where these packets came from</h3></div>
        <div class="note compact">No station file loaded, so there is nothing to put on a map. Load <b>stations.json</b> from the header.</div>
      </div>`;
    const pts = mapPoints(p, res);
    const withRssi = pts.filter(e => e.rssiMed != null).length;
    // Addresses, not stations. A station carries three or four of them, so
    // counting pins against addresses reports the difference as missing.
    const unplaced = [...res.byAlertId.values()]
      .filter(r => !r.chosen || r.chosen.station.lat == null || r.chosen.station.lon == null).length;

    const legend = withRssi
      ? '<div class="a2-legend"><span class="spec">Pin colour — RSSI</span>'
        + RSSI_BANDS.map(b => '<span class="a2-lkey" title="' + esc(b.note) + '"><i style="background:' + b.color + '"></i>' + esc(b.label) + '</span>').join('')
        + '<span class="spec">bands are indicative; pin size is how many readings the station sent</span></div>'
      : '<div class="a2-legend"><span class="spec">Pin size is how many readings the station sent. '
        + 'Paste a USB capture instead and the pins colour by RSSI.</span></div>';

    return `
      <div class="panel">
        <div class="panel-header"><h3>Where these packets came from <span class="badge ok">${pts.length} station${pts.length === 1 ? '' : 's'}</span></h3></div>
        <p class="sub">Every station this receiver heard in the capture. Click a pin to light up its readings in the
          table below; click a reading and its pin lights up here. The station name in either place opens it on the
          <a href="javascript:void 0" onclick="switchTab('stations')">Stations</a> tab.</p>
        <div id="a2-map" class="a2-map"></div>
        ${legend}
        ${pts.length ? '' : '<div class="note compact">None of the addresses in this capture resolved to a station with coordinates, so there is nothing to draw yet.</div>'}
        ${unplaced > 0 && pts.length ? '<div class="spec">' + unplaced + ' address' + (unplaced === 1 ? '' : 'es') + ' in this capture could not be placed — unmatched, ambiguous, or a station with no coordinates on file.</div>' : ''}
      </div>`;
  }

  function initCoverageMap(p, res) {
    stopMap();
    const el = document.getElementById('a2-map');
    if (!el || !state.data || typeof L === 'undefined' || !p || !res) return;
    const a = state.a2;
    const pts = mapPoints(p, res);

    // SVG, not canvas. The big Stations map needs the canvas renderer for its
    // 3,000-odd pins; a capture holds tens, and SVG gives each one a real DOM
    // node — which is what makes bringToFront on a selection safe. The canvas
    // renderer defers that to an animation frame, and a frame that lands after
    // the tab has been left is drawing into a context the removed map took with
    // it.
    const map = a.map = L.map('a2-map');
    // The getter, not the map: stopMap() sets this back to null on the way out
    // of the tab, and the shell has to see that (#142).
    registerLiveMap('Alert2', () => state.a2.map);
    // A view before any layer is added: Leaflet defers layer adds until the map
    // has one, and a deferred add can otherwise run against a renderer that has
    // not been set up. Replaced by the fit below on the same tick.
    map.setView(MAP_HOME, 4);
    addBaseLayers(map);
    a.mapLayer = L.layerGroup().addTo(map);
    a.mapMarks = new Map();

    const most = Math.max(1, ...pts.map(e => e.n));
    pts.forEach(e => {
      const band = rssiBand(e.rssiMed);
      const m = L.circleMarker([e.st.lat, e.st.lon], {
        radius: 5 + 5 * Math.sqrt(e.n / most),
        color: '#fff', weight: 1.5,
        fillColor: band ? band.color : '#5a6b7d', fillOpacity: .85,
      });
      m.a2Key = e.key;
      m.a2Base = { fill: band ? band.color : '#5a6b7d' };
      m.bindPopup(mapPopup(e));
      m.on('click', () => select(e.key, 'map'));
      m.addTo(a.mapLayer);
      a.mapMarks.set(e.key, m);
    });

    if (pts.length) {
      const b = L.latLngBounds(pts.map(e => [e.st.lat, e.st.lon]));
      // A single pin has no extent to fit, and fitBounds on a degenerate box
      // zooms to the tile server's limit.
      if (pts.length === 1) map.setView(b.getCenter(), 11);
      else map.fitBounds(b.pad(0.15));
    }
    // A filter or a scale change re-renders the tab, which throws the map away
    // and builds this one. Restoring the last view means the operator does not
    // lose their pan every time they tick a box.
    if (a.mapView) map.setView(a.mapView.center, a.mapView.zoom);
    map.on('moveend zoomend', () => { a.mapView = { center: map.getCenter(), zoom: map.getZoom() }; });
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 0);
    applySelection();
  }

  function mapPopup(e) {
    const ids = [...e.aids].sort((x, y) => x - y).join(', ');
    return '<b>' + esc(e.st.name) + '</b>'
      + (e.st.station_number ? '<br><span class="spec">' + esc(e.st.station_number) + '</span>' : '')
      + '<br>' + e.n + ' reading' + (e.n === 1 ? '' : 's') + ' on address' + (e.aids.size === 1 ? ' ' : 'es ') + ids
      + (e.rssiMed != null
          ? '<br>RSSI <b>' + e.rssiMed + ' dBm</b> median, ' + e.rssiBest + ' best / ' + e.rssiWorst + ' worst'
          : '')
      + '<br><a href="javascript:void 0" onclick="goToStation(\'' + escAttr(e.st.id) + '\')">Open on the Stations tab →</a>';
  }

  function stopMap() {
    const a = state.a2;
    a.map = removeMap(a.map);
    a.mapLayer = null; a.mapMarks = null;
  }

  // Selection is a highlight, not a filter, so it never re-renders: the rows and
  // the markers already exist and only their styling changes. Re-rendering here
  // would rebuild the map — and lose the pan, the popup and the click that
  // caused it — for something CSS can do.
  function applySelection() {
    const a = state.a2;
    document.querySelectorAll('#a2-view tr.a2-row').forEach(tr => {
      tr.classList.toggle('sel', a.sel != null && tr.dataset.key === a.sel);
    });
    if (a.mapMarks) a.mapMarks.forEach((m, key) => {
      const on = key === a.sel;
      m.setStyle({ color: on ? '#111' : '#fff', weight: on ? 3 : 1.5, fillOpacity: on ? 1 : .85 });
      if (on) m.bringToFront();
    });
  }

  function select(key, from) {
    const a = state.a2;
    a.sel = (a.sel === key) ? null : key;
    applySelection();
    if (a.sel == null) return;
    if (from === 'map') {
      const row = document.querySelector('#a2-view tr.a2-row.sel');
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const m = a.mapMarks && a.mapMarks.get(a.sel);
      if (m && a.map) {
        // Pan only if the pin is off-screen, and never change the zoom. The map
        // opens fitted to the whole capture, which is the view worth keeping —
        // zooming to a pin every time a row is clicked throws that away and
        // leaves the operator re-orienting after each click.
        if (a.map.panInside) a.map.panInside(m.getLatLng(), { padding: [40, 40] });
        else a.map.panTo(m.getLatLng());
        m.openPopup();
      }
    }
  }

  // ── reference ─────────────────────────────────────────────────────────────────

  function referencePanel() {
    const rows = FIELDS.map((spec, i) => '<tr>'
      + '<td><b>' + (i + 1) + '</b></td>'
      + '<td><span class="swatch" style="background:var(--c-' + ROLE_VAR[spec.role] + ')"></span>' + esc(spec.label) + '</td>'
      + '<td>' + (spec.sure ? '<span class="badge ok">established</span>' : '<span class="badge warn">constant only</span>') + '</td>'
      + '<td class="spec">' + esc(spec.note || '') + '</td></tr>').join('');
    const binRows = BIN_ORDER.map(([tag, depth]) => {
      const spec = BIN_TAGS[tag];
      return '<tr>'
        + '<td style="padding-left:' + (6 + depth * 18) + 'px"><code>' + tag + '</code></td>'
        + '<td><span class="swatch" style="background:' + (spec.role === 'rssi' ? 'var(--ok)' : 'var(--c-' + ROLE_VAR[spec.role] + ')') + '"></span>' + esc(spec.label) + '</td>'
        + '<td>' + (spec.sure ? '<span class="badge ok">established</span>' : '<span class="badge warn">constant only</span>') + '</td>'
        + '<td class="spec">' + esc(spec.note || '') + '</td></tr>';
    }).join('');

    return `
      <div class="panel">
        <div class="panel-header"><h3>Two ways in — and which one has the RSSI</h3></div>
        <p class="sub">An ERT-A2 emits two different things on two different ports, and they do not carry the same
          information. This tab reads both; paste either and it works out which it is looking at.</p>

        <div class="a2-methods">
          <div class="a2-method">
            <h4>1 · ALERT2 ASCII protocol <span class="badge">secondary RS232 port</span></h4>
            <p class="spec">One comma-delimited line per received frame: the tag <code>ALERT2A</code>, 23 more
              fixed fields of receiver metadata — including the unit's own real-time clock — then the frame payload
              as hex bytes, one field per byte.</p>
            <div class="a2-raw"><code>ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00</code></div>
            <ul class="pkt-cheat">
              <li><b>Gives you</b> the receiver's clock, so a frame can be dated as well as timed, and a line that
                reads as text in any terminal.</li>
              <li><b>Does not give you RSSI.</b> None of the 24 fields is a signal level; field 22 is a reception
                quality that read 7 on every good frame in a 444-frame capture and 1 on the bad one, which is a
                health flag, not a measurement in dBm.</li>
              <li><b>Capture it with</b> PuTTY or any terminal on the RS232 port, and paste or load the log.</li>
            </ul>
          </div>
          <div class="a2-method">
            <h4>2 · ELPRO binary framing <span class="badge ok">USB port</span></h4>
            <p class="spec">What Ranger's own <em>Serial Data</em> pane shows when it is connected over USB: the
              ASCII word <code>ALERT2</code> as six bytes, a length, then tag/length/value elements — and one of
              those elements is the RSSI.</p>
            <div class="a2-raw"><code>41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …  9C 2F 01 94</code></div>
            <ul class="pkt-cheat">
              <li><b>Gives you RSSI</b> — element <code>9C2F</code>, one signed byte, dBm. <code>94</code> above is
                −108 dBm.</li>
              <li><b>Does not give you the receiver's clock.</b> There is no date or time of day in the framing at
                all; Ranger stamps its own display from the PC. The only time in a binary capture is the payload's
                own seconds-since-midnight.</li>
              <li><b>Capture it with</b> a terminal on the USB port, or by copying the hex straight out of Ranger's
                Serial Data pane. Paste it here — space-delimited, run together, wrapped mid-frame, it does not
                matter, because the frames are found by the <code>ALERT2</code> sync rather than by the line breaks.</li>
            </ul>
          </div>
        </div>

        <div class="note compact">
          <b>Is Ranger asking for this?</b> The capture is receive-only, so it shows what the USB port emits and
          not what, if anything, Ranger sent to turn it on. Nothing was needed to read it back — a terminal on the
          USB port produces these frames — so the working answer is that the two ports simply speak different
          protocols, and the USB one is the richer of the two. If a unit is ever found emitting nothing on USB
          until spoken to, that is the thing to revisit.
        </div>

        <details>
          <summary class="pkt-summary">Method 1 — ALERT2 ASCII protocol, field reference</summary>

          <p class="spec">Every line is <code>ALERT2A</code>, 23 more fixed fields, then the frame payload as
            hex bytes — one field per byte. Field 23 gives the payload length, which is what distinguishes a
            complete line from one the terminal wrapped or cut short.</p>

          <div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>
            <th>#</th><th>FIELD</th><th>CONFIDENCE</th><th>NOTES</th>
          </tr></thead><tbody>${rows}</tbody></table></div>
        </details>

        <details>
          <summary class="pkt-summary">Method 2 — ELPRO binary framing, element reference</summary>

          <p class="spec">Six ASCII bytes <code>41 4C 45 52 54 32</code> (“ALERT2”) sync the frame, one byte gives
            the length of everything that follows, and the rest is tag / length / value. A tag byte with its top
            bit set is the first of a two-byte tag; otherwise the tag is that single byte. Length is always one
            byte. Two elements are containers whose value is more elements — shown indented below.</p>

          <div class="a2-tablewrap"><table class="fields a2-table"><thead><tr>
            <th>TAG</th><th>ELEMENT</th><th>CONFIDENCE</th><th>NOTES</th>
          </tr></thead><tbody>${binRows}</tbody></table></div>

          <h4 class="a2-h">The same PDU, twice</h4>
          <p class="spec">Element <code>15</code> holds the air-link PDU as it landed — a two-byte length, the PDU,
            then <code>A1</code> fill out to a fixed 24-byte buffer. Element <code>14</code> holds the same bytes
            split into a six-byte MANT header and the payload, with the RSSI appended. Both copies were
            byte-identical on every frame checked, so the decoder reads the split one and reports it when they
            disagree, rather than silently preferring one.</p>

          <h4 class="a2-h">Reading the RSSI by hand</h4>
          <p class="spec">The last four bytes of a frame are almost always <code>9C 2F 01 xx</code>: tag
            <code>9C2F</code>, length 1, then the value. Read <code>xx</code> as a signed byte —
            <code>94</code> → −108, <code>8E</code> → −114, <code>A8</code> → −88. Every value in the two reference
            captures fell between −81 and −114 dBm, which is the range a VHF receiver at the edge of its
            sensitivity actually works over.</p>

          <h4 class="a2-h">How this was established</h4>
          <p class="spec">44 binary frames from Ranger's Serial Data pane were decoded here and compared line for
            line against Ranger's own decode of the same 44 packets. Source address, agency, frame time, every
            ALERT address, every value and every RSSI matched on all 44 — including the multi-reading frames,
            where Ranger lists the readings in a different order. A second capture of 78 frames then parsed to the
            same structure with every byte accounted for: no leftover bytes between frames, no element the decoder
            did not recognise, and nothing it had to warn about. Elements that were constant across all of them are
            marked “constant only” rather than guessed at.</p>
        </details>

        <details>
          <summary class="pkt-summary">Shared by both — the payload, and what the readings mean</summary>

          <h4 class="a2-h">Payload — ALERT concentration</h4>
          <ul class="pkt-cheat">
            <li>Byte 1 — <b>0x74</b>, the element type. Every frame observed carried this one; ELPRO's Ranger
              labels the same traffic <em>ALERT (Conc)</em>. Any other value is reported rather than guessed at.</li>
            <li>Bytes 2–3 — <b>seconds since midnight</b>, big-endian, of the originating ALERT2 frame. Checked
              against Ranger's own “Received:” column, which matched to the second on every frame compared.
              Sixteen bits only reach 18:12:15, so a frame later in the day must carry the time some other way;
              the reference capture ends before that and cannot say how.</li>
            <li>Bytes 4 on — <b>four bytes per reading</b>, repeated to the end of the payload. A frame carries
              one to four readings, usually the rainfall, water level and battery of one field station.</li>
          </ul>

          <h4 class="a2-h">One reading, four bytes</h4>
          <ul class="pkt-cheat">
            <li><code>byte 0</code> — ALERT address, low 8 bits.</li>
            <li><code>byte 1</code> — <code>DDDAAAAA</code>: value bits 10–8 on top, address bits 12–8 below.
              This is the only part of the encoding that is not obvious by eye — a byte that looks like part of
              the address is carrying the top of the value as well.</li>
            <li><code>byte 2</code> — value, low 8 bits.</li>
            <li><code>byte 3</code> — status. 0 on all 541 valid readings in the reference capture; the four
              non-zero ones sat in the single frame the receiver had already flagged bad, and decoded to
              addresses no station has.</li>
            <li>So address is 13 bits (0–8191) and value 11 bits (0–2047) — the same widths a legacy ALERT
              sensor transmits, which is why the ALERT Packets tab decodes one of these records to the same
              id and value under its <b>A2C</b> layout.</li>
          </ul>

          <h4 class="a2-h">How this was established</h4>
          <p class="spec">A 444-frame capture from a test ERT-A2 was decoded and compared against the same
            traffic decoded by ELPRO's Ranger software. All 444 payload lengths matched the field count; every
            payload after the three-byte header was a whole number of four-byte records; addresses and values
            matched Ranger's decoded output record for record, including multi-reading frames; and the payload
            times matched Ranger's received times exactly. 339 of the 348 addresses heard matched a station in
            MegaNet. Fields with no such evidence behind them are marked “constant only” above, and the
            engineering scales below are interpretations, not part of the protocol.</p>

          <h4 class="a2-h">Engineering values</h4>

          <ul class="pkt-cheat">
            <li><b>Battery</b> — raw ÷ 10 volts. 213 battery readings in the reference capture fell between 130
              and 142, which is 13.0–14.2 V and nothing else plausible.</li>
            <li><b>Rainfall</b> — a cumulative tip count, ×&nbsp;mm per tip. Counts step up one at a time
              in the capture, which is a tipping bucket; the millimetres per tip is a site configuration
              (<code>TBRGbucketSize</code>) and wins when the address resolves to a station that carries
              one. Otherwise it falls back to the input below, 0.2&nbsp;mm by default — either way the
              value shown says whether it was recorded for that site or assumed.</li>
            <li><b>Water level</b> — left as raw counts. The scale is set per site and nothing in the capture
              reveals it, so no conversion is offered.</li>
            <li><b>2047</b> on any sensor is all eleven bits set: over-range, or a sensor reading nothing.</li>
          </ul>
        </details>

        <details>
          <summary class="pkt-summary">Getting the capture out of the ERT-A2</summary>

          <p class="spec">Web Serial would let this page read the unit directly, and is the point this tool is
            building towards — everything below is the interim, and the traffic it decodes is the argument for
            opening that up.</p>

          <h4 class="a2-h">Pasting</h4>
          <p class="spec">Either format goes straight into the box: an ASCII log as it comes out of PuTTY, or hex
            copied out of Ranger's Serial Data pane. The hex ingest strips a bracketed timestamp or a hex-dump
            offset column off the front of each line first — their digits are hex too, and would otherwise be read
            as data — then treats everything left as one byte stream and finds the frames by their sync word. That
            is what makes Ranger's pane usable directly: it wraps at whatever width the window happens to be, and
            here that does not matter.</p>

          <h4 class="a2-h">Loading a file</h4>
          <p class="spec"><b>Choose log file…</b> works in every browser and reads the file once, as it stood at
            that moment. UTF-16 logs are detected by their byte-order mark rather than assumed away.</p>

          <h4 class="a2-h">Watching a file</h4>
          <p class="spec">PuTTY writes its session log continuously (Session → Logging has <em>Flush log file
            frequently</em> on by default, so the file is not held back until the session closes). On a Chromium
            browser the <b>Watch</b> button uses the File System Access API to re-open that same file on a timer,
            which gives a log that keeps up with the unit without a serial port being involved. It needs Chrome or
            Edge over https or localhost, and it is a common thing for a managed machine to have switched off by
            policy — if that is what has happened the button now says so instead of doing nothing.</p>
        </details>
      </div>`;
  }

  const ROLE_VAR = { ident: 'ident', addr: 'addr', time: 'time', status: 'status', len: 'hd' };

  // ── sample ────────────────────────────────────────────────────────────────────
  // Real lines from a test ERT-A2, chosen to exercise every ingest path: plain
  // frames, a multi-reading frame, a line the terminal wrapped, a PuTTY banner
  // dropped mid-capture, a line carrying a terminal timestamp, the one corrupt
  // frame from the reference capture, and a line cut off at the end of the log.
  const SAMPLE = [
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00',
    // The same 15-byte frame a narrow terminal window folds in two. Nothing in
    // the protocol wraps: this is the terminal, and the tail has to be sewn back
    // on or the frame reads as one truncated line and one line of noise.
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,29,46.068,0,0,0,0,0,1,0,0,0,7,15,9999,74,69,69,1F,08,89,00,1D,08,39,00',
    ',1E,08,02,00',
    '[2026-06-08 19:39:43.586] ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,39,43.586,0,0,0,0,0,1,0,0,0,7,15,9999,74,6B,BE,65,08,86,00,66,C8,2F,00,69,08,00,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,19,13.761,0,0,0,0,0,1,0,0,0,7,11,9999,74,75,00,B5,08,84,00,24,08,08,00',
    // The one frame in 444 the receiver flagged bad: field 18 reads 0, field 22
    // drops to 1, and every reading in it carries a non-zero status byte.
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,51,10.161,0,0,0,0,0,0,0,0,0,1,19,9999,74,7C,7E,01,0E,08,11,81,07,23,FF,FB,21,00,14,00,00,00,08',
    'A=~=~=~=~=~=~=~=~=~=~=~= PuTTY log 2026.08.10 14:35:06 =~=~=~=~=~=~=~=~=~=~=~=',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,21,14,57.981,0,0,0,0,0,1,0,0,0,7,7,9999,74,86,1C,0E,10,0A,00',
    'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,22,15,20.039,0,0,0,0,0,1,0,0,0,7,7,9',
  ].join('\n');

  // The same unit's USB port, in the binary framing — real frames from the
  // Ranger capture these were decoded against, so the RSSI figures are the ones
  // Ranger reported for them. Chosen to exercise the hex ingest as well: one,
  // two and three-reading frames, a frame the pane wrapped mid-way, a line
  // carrying a terminal timestamp in front of the hex, and a capture that stops
  // part-way through a frame.
  const SAMPLE_BIN = [
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 1C 0E 10 0A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 1C 0E 10 0A 00 9C 2F 01 94',
    '41 4C 45 52 54 32 51 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 11 84 11 18 00 11 00 10 70 0B 27 0F 74 86 6F DF 92 41 00 CE 12 00 00 A1 A1 A1 A1 A1 84 12 01 00 14 1B 84 00 06 00 10 70 0B 27 0F 84 01 0B 74 86 6F DF 92 41 00 CE 12 00 00 9C 2F 01 8E',
    '41 4C 45 52 54 32 51 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 11 84 11 18 00 11 00 10 70 0B 27 0F 74 86 AF 87 09 8C 00 86 29 5B 00 A1 A1 A1 A1 A1 84 12 01 00 14 1B 84 00 06 00 10 70 0B 27 0F 84 01 0B 74 86 AF 87 09 8C 00 86 29 5B 00 9C 2F 01 93',
    // Ranger's Serial Data pane wraps at the width of the window, so a frame is
    // routinely cut in half like this. Nothing has to sew it back together: the
    // sync word and the length byte find the frame, and the line break is noise.
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 86 E8',
    '9A 15 06 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 86 E8 9A 15 06 00 9C 2F 01 98',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 87 17 98 88 5A 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 87 17 98 88 5A 00 9C 2F 01 97',
    '41 4C 45 52 54 32 55 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 15 84 11 18 00 15 00 10 70 0F 27 0F 74 87 DF 65 08 8B 00 66 C8 2F 00 69 08 00 00 A1 84 12 01 00 14 1F 84 00 06 00 10 70 0F 27 0F 84 01 0F 74 87 DF 65 08 8B 00 66 C8 2F 00 69 08 00 00 9C 2F 01 95',
    // The digits in that timestamp are all valid hex. Stripped as a prefix, not
    // read as bytes — which is the whole reason the ingest looks at lines at all.
    '[2026-08-10 14:45:09] 41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 88 08 25 10 0B 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 88 08 25 10 0B 00 9C 2F 01 93',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F 15 24 84 10 02 00 0D 84 11 18 00 0D 00 10 70 07 27 0F 74 89 34 CD 14 8C 00 A1 A1 A1 A1 A1 A1 A1 A1 A1 84 12 01 00 14 17 84 00 06 00 10 70 07 27 0F 84 01 07 74 89 34 CD 14 8C 00 9C 2F 01 95',
    '41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52',
  ].join('\n');

  // ── rendering: the tab ────────────────────────────────────────────────────────

  const ROW_STEP = 400;
  const canWatch = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

  function inputPanel() {
    const a = state.a2;
    const w = a.watch;
    return `
      <div class="panel">
        <div class="panel-header"><h3>Capture</h3></div>
        <p class="sub">Two things can go in here. Paste an <b>ALERT2 ASCII log</b> from the RS232 port —
          session banners, wrapped lines and terminal timestamps are all handled, so paste it as it comes. Or paste
          the <b>hex from the USB port</b>, straight out of Ranger's Serial Data pane or any terminal: that one
          carries the RSSI. Either way, pick a file instead if that is easier.</p>
        <div class="a2-modes">
          <span class="spec">Read as</span>
          ${modeBtn('auto', 'Auto-detect', 'Look at the capture and decide — right for anything pasted whole')}
          ${modeBtn('ascii', 'ALERT2A ASCII', 'The comma-delimited protocol on the secondary RS232 port')}
          ${modeBtn('bin', 'USB hex', 'The binary framing the USB port emits — the one with RSSI in it')}
        </div>
        <textarea id="a2-text" class="a2-input" spellcheck="false" rows="7"
                  placeholder="ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00&#10;41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …"
                  oninput="state.a2.text=this.value">${esc(a.text)}</textarea>
        <div class="row" style="margin-top:12px">
          <div class="fit"><button class="primary" onclick="Alert2.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.chooseFile()">Choose log file…</button></div>
          ${canWatch ? '<div class="fit"><button class="ghost" onclick="Alert2.' + (w ? 'stopWatching()">Stop watching ' + esc(w.name) : 'watchFile()">Watch a log file…') + '</button></div>' : ''}
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('ascii')">Sample — RS232 ASCII</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('bin')">Sample — USB hex</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.clear()">Clear</button></div>
        </div>
        <input type="file" id="a2-file" accept=".txt,.log,.csv,.hex,.dat,text/plain" hidden onchange="Alert2.onFile(this)">
        <div id="a2-status" class="note compact" style="margin-top:.75rem"${a.source ? '' : ' hidden'}>${esc(a.source)}</div>
        ${a.watchErr ? '<div class="note compact warn" style="margin-top:.75rem">' + a.watchErr + '</div>' : ''}
        ${!canWatch ? '<div class="spec">Watching a log file as it grows needs the File System Access API — a Chromium browser (Chrome, Edge) over https or localhost. Choosing a file still works everywhere; it reads the file once, as it stands.</div>' : ''}
      </div>`;
  }

  function modeBtn(id, label, title) {
    return '<button class="a2-vtab' + (state.a2.mode === id ? ' on' : '') + '" title="' + esc(title)
         + '" onclick="Alert2.setMode(\'' + id + '\')">' + esc(label) + '</button>';
  }

  function optionsRow() {
    const a = state.a2;
    const cb = (key, label, title) => '<label class="a2-cb" title="' + esc(title || '') + '">'
      + '<input type="checkbox" ' + (a[key] ? 'checked' : '') + ' onchange="Alert2.setOpt(\'' + key + '\',this.checked)"> ' + esc(label) + '</label>';
    return '<div class="a2-opts">'
      + cb('onlyErrors', 'Only problems', 'Show just the frames and readings something is wrong with')
      + cb('hideUnknown', 'Hide unmatched addresses', 'Drop readings whose ALERT address matches no station in the database')
      + cb('eng', 'Engineering values', 'Convert battery and rainfall counts, using the scales below')
      + '<span class="a2-num" title="Fallback only — a station carrying a recorded TBRGbucketSize uses that instead">'
      + 'mm per tip (fallback) <input type="number" step="0.1" min="0" value="' + a.mmPerTip
      + '" oninput="Alert2.setOpt(\'mmPerTip\',this.value)"></span>'
      + '<span class="a2-num">battery ÷ <input type="number" step="1" min="1" value="' + a.battDiv
      + '" oninput="Alert2.setOpt(\'battDiv\',this.value)"></span>'
      + '</div>';
  }

  function viewPanel(p, res) {
    const a = state.a2;
    const tab = (id, label) => '<button class="a2-vtab' + (a.view === id ? ' on' : '') + '" onclick="Alert2.setView(\'' + id + '\')">' + esc(label) + '</button>';
    let body;
    if (a.view === 'frames')        body = framesView(p, res);
    else if (a.view === 'stations') body = stationsView(p, res);
    else                            body = readingsView(p, res);
    return `
      <div class="panel">
        <div class="panel-header"><h3>Decoded</h3></div>
        <div class="a2-vtabs">${tab('readings', 'Readings')}${tab('stations', 'By station')}${tab('frames', 'Frame anatomy')}
          <span class="a2-vspacer"></span>
          <button class="ghost" onclick="Alert2.exportCsv()">Export CSV</button>
          <button class="ghost" onclick="Alert2.exportJson()">Export JSON</button>
        </div>
        ${optionsRow()}
        <div id="a2-view">${body}</div>
      </div>`;
  }

  function render() {
    const p = current();
    const res = p ? resolve(p) : null;
    return `
    <div class="pkt a2" style="max-width:1280px;margin:auto;padding:1rem;display:grid;gap:1rem">

      <div class="panel">
        <div class="panel-header"><h2>ALERT2 / ERT-A2 Serial Decoder</h2></div>
        <p class="sub">Decodes what an ELPRO ERT-A2 puts on its serial ports: receiver metadata, the frame's own
          timestamp, the signal level it came in at, and the ALERT readings packed into its payload — each one
          matched back to a station in the MegaNet database and put on the map. The readings inside are ordinary
          13-bit ALERT addresses and 11-bit values, the same ones the
          <a href="javascript:void 0" onclick="switchTab('packets')">ALERT Packets</a> tab decodes one at a time.</p>
        ${state.data ? '' : '<div class="note compact">No station file loaded — addresses will decode but nothing will be named or mapped. Load <b>stations.json</b> from the header to see station names.</div>'}
      </div>

      ${inputPanel()}
      ${referencePanel()}
      ${p ? summaryPanel(p, res) : ''}
      ${p && res ? ambiguityPanel(res) : ''}
      ${p && res ? mapPanel(p, res) : ''}
      ${p ? viewPanel(p, res) : ''}

    </div>`;
  }

  // ── event handlers ────────────────────────────────────────────────────────────

  function refresh() { renderMain(); }

  function readBox() {
    const el = document.getElementById('a2-text');
    if (el) state.a2.text = el.value;
  }
  function decode()     { readBox(); state.a2.limit = ROW_STEP; refresh(); }
  function clear()      { state.a2.text = ''; state.a2.parsed = null; state.a2.parsedKey = ''; state.a2.source = ''; state.a2.sel = null; state.a2.mapView = null; stopWatch(); refresh(); }
  function more()       { state.a2.limit += ROW_STEP; refresh(); }
  function setView(v)   { state.a2.view = v; refresh(); }
  // Changing format changes which capture is on screen, so the selection and the
  // map's remembered view belong to the old one and go with it.
  function setMode(m)   { state.a2.mode = m; state.a2.sel = null; state.a2.mapView = null; refresh(); }

  function loadSample(which) {
    const bin = which === 'bin';
    state.a2.text = bin ? SAMPLE_BIN : SAMPLE;
    state.a2.mode = 'auto';
    state.a2.sel = null; state.a2.mapView = null;
    state.a2.source = bin
      ? 'Sample capture — real binary frames off a test ERT-A2\'s USB port, the ones this decoder was checked against Ranger with.'
      : 'Sample capture — real ALERT2 ASCII lines from a test ERT-A2\'s RS232 port.';
    state.a2.limit = ROW_STEP;
    refresh();
  }

  function setOpt(key, val) {
    const a = state.a2;
    if (key === 'mmPerTip' || key === 'battDiv') {
      const n = Number(val);
      a[key] = Number.isFinite(n) ? n : a[key];
      // Typing in a number box must not re-render the field out from under the
      // cursor, so only the parts that read the scale are redrawn.
      const view = document.getElementById('a2-view');
      const p = current(); const res = p ? resolve(p) : null;
      if (view && p && res) {
        view.innerHTML = a.view === 'frames' ? framesView(p, res)
                       : a.view === 'stations' ? stationsView(p, res) : readingsView(p, res);
        attachRecHover(view);
      }
      return;
    }
    a[key] = val;
    refresh();
  }

  function openFrame(seq) {
    state.a2.view = 'frames';
    state.a2.frameIdx = seq;
    refresh();
    setTimeout(() => {
      const card = document.querySelector('#a2-view .fmtcard.open');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  function pick(aid, stationId) {
    if (state.a2.picks[aid] === stationId) delete state.a2.picks[aid];
    else state.a2.picks[aid] = stationId;
    refresh();
  }
  function clearPicks() { state.a2.picks = {}; refresh(); }

  // ── file ingest ───────────────────────────────────────────────────────────────

  function status(msg) {
    const el = document.getElementById('a2-status');
    if (el) { el.textContent = msg; el.hidden = !msg; }
    state.a2.source = msg;
  }

  function chooseFile() {
    const el = document.getElementById('a2-file');
    if (el) { el.value = ''; el.click(); }
  }

  // PuTTY writes its log in whatever the terminal's character set is, so a UTF-16
  // BOM is possible even though ANSI is usual. Sniff it rather than assuming.
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
  }

  function onFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.a2.text = decodeBuffer(reader.result);
      state.a2.limit = ROW_STEP;
      state.a2.source = 'Loaded ' + f.name + ' (' + (f.size / 1024).toFixed(1) + ' kB), read once at '
                      + clockText(Date.now()) + '.';
      refresh();
    };
    reader.onerror = () => status('Could not read ' + f.name + ': ' + (reader.error && reader.error.message));
    reader.readAsArrayBuffer(f);
  }

  // Why the picker refused. Every path out of showOpenFilePicker except a
  // dismissal used to end up in the same bare `return`, which is exactly what a
  // managed machine looks like: the button is present, because the API exists,
  // and pressing it does nothing at all, because policy blocks the call and the
  // rejection was being swallowed. The failure has to be visible and it has to
  // name the likely cause — an operator cannot ask IT to unblock something the
  // page never admitted was blocked.
  function pickerRefusal(e) {
    const name = (e && e.name) || '';
    const msg  = esc((e && e.message) || String(e));
    if (name === 'SecurityError') return '<b>Watching was refused by the browser.</b> This usually means the page '
      + 'is not in a secure context (needs https or localhost), or it is embedded in a frame that is not allowed '
      + 'to open a file picker. <span class="spec">' + msg + '</span>';
    if (name === 'NotAllowedError') return '<b>Watching is blocked on this machine.</b> Chrome and Edge let an '
      + 'administrator turn the File System Access API off by policy (<code>DefaultFileSystemReadGuardSetting</code>, '
      + 'or a site on <code>FileSystemReadBlockedForUrls</code>) and a blocked call fails exactly like this — with '
      + 'no prompt. Ask for this site to be allowed, or use <b>Choose log file…</b>, which reads the file once and '
      + 'is not affected. <span class="spec">' + msg + '</span>';
    if (name === 'TypeError') return '<b>This browser would not accept the file picker\'s options.</b> Use '
      + '<b>Choose log file…</b> instead. <span class="spec">' + msg + '</span>';
    return '<b>Could not start watching.</b> Use <b>Choose log file…</b> instead — it reads the file once and works '
      + 'everywhere. <span class="spec">' + esc(name ? name + ': ' : '') + msg + '</span>';
  }

  // The nearest thing to a live feed available without Web Serial: keep the file
  // handle the picker returned and re-open it on a timer. PuTTY flushes its log
  // as it writes, so each re-read picks up whatever has arrived since.
  async function watchFile() {
    const a = state.a2;
    a.watchErr = '';
    if (!canWatch) {
      a.watchErr = '<b>This browser has no File System Access API.</b> Watching needs Chrome or Edge over https or '
                 + 'localhost. <b>Choose log file…</b> works everywhere.';
      refresh();
      return;
    }
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ multiple: false,
        types: [{ description: 'Terminal or hex log', accept: { 'text/plain': ['.txt', '.log', '.csv', '.hex', '.dat'] } }] });
    } catch (e) {
      // A dismissed picker is not a fault and must stay silent. Everything else
      // is a fault, and used to be silent too — that was the bug.
      if (e && (e.name === 'AbortError' || e.name === 'NotFoundError')) return;
      a.watchErr = pickerRefusal(e);
      refresh();
      return;
    }
    if (!handle) { a.watchErr = 'The file picker returned nothing to watch.'; refresh(); return; }
    stopWatch();
    a.watch = { handle, name: handle.name, timer: null, reads: 0 };
    const tick = async () => {
      // The watch outlives re-renders, so check the handle is still the one this
      // closure was started for — a second Watch replaces it, and the old timer
      // must not keep writing over the new one's text.
      if (!a.watch || a.watch.handle !== handle) return;
      try {
        const file = await handle.getFile();
        const text = decodeBuffer(await file.arrayBuffer());
        a.watch.reads++;
        if (text !== a.text) {
          a.text = text;
          if (state.activeTab === 'alert2') refresh();
        }
        status('Watching ' + a.watch.name + ' — re-read every ' + (a.watchMs / 1000)
             + ' s, last at ' + clockText(Date.now()) + ' (' + a.watch.reads + ' reads).');
      } catch (e) {
        // Permission can be revoked mid-watch (the file moves, the tab loses
        // its grant), and a timer failing quietly every five seconds is worse
        // than one that stops and says why.
        const name = a.watch ? a.watch.name : 'the file';
        stopWatch();
        a.watchErr = '<b>Stopped watching ' + esc(name) + '.</b> <span class="spec">'
                   + esc((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) + '</span>';
        if (state.activeTab === 'alert2') refresh();
      }
    };
    await tick();
    if (a.watch) a.watch.timer = setInterval(tick, a.watchMs);
    refresh();
  }

  function stopWatch() {
    const w = state.a2.watch;
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    state.a2.watch = null;
  }

  // The button's own handler. stopWatch alone left the button still reading
  // "Stop watching …" until something else happened to re-render.
  function stopWatching() { stopWatch(); state.a2.watchErr = ''; refresh(); }

  // ── export ────────────────────────────────────────────────────────────────────

  function exportRows() {
    const p = current();
    if (!p) return [];
    const res = resolve(p);
    const out = [];
    // The frame carries a time of day but no date, and the receiver carries a
    // date but a clock that may be hours out. Pairing the receiver's date with
    // the frame's time of day is exact for the time and right for the date on
    // any frame whose clock error does not straddle midnight — which beats
    // correcting everything by one capture-wide offset when that offset drifts.
    const stamp = f => {
      if (!f.hdr.clockMs || !f.payload) return '';
      const d = new Date(f.hdr.clockMs);
      d.setHours(0, 0, 0, 0);
      return isoText(d.getTime() + f.payload.sod * 1000);
    };
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        const eng = engValue(info ? info.kind : null, r.value, st);
        out.push({
          format: f.kind === 'bin' ? 'usb-binary' : 'rs232-ascii',
          line: f.lineNo,
          frame_time: hms(f.payload.sod),
          ert_a2_clock: isoText(f.hdr.clockMs),
          alert2_datetime: stamp(f),
          decoder: f.hdr.decoder == null ? '' : f.hdr.decoder,
          source: f.hdr.source == null ? '' : f.hdr.source,
          quality: f.hdr.quality == null ? '' : f.hdr.quality,
          rssi_dbm: f.hdr.rssi == null ? '' : f.hdr.rssi,
          alert_id: r.alertId,
          station: st ? st.name : (info && info.fileName && !info.fileName.none ? info.fileName.text : ''),
          station_number: st ? (st.station_number || '') : '',
          lat: st && st.lat != null ? st.lat : '',
          lon: st && st.lon != null ? st.lon : '',
          match: info ? info.conf : 'unknown',
          sensor: info && info.chosen ? info.chosen.types.join(' / ') : '',
          value: r.value,
          engineering: eng ? eng.text : '',
          status: '0x' + hx(r.status),
          bytes: r.bytes.map(hx).join(' '),
        });
      });
    });
    return out;
  }

  function exportCsv() {
    const rows = exportRows();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => csvEscape(r[c])).join(','))).join('\n');
    dlText('alert2-readings.csv', csv);
  }

  function exportJson() {
    const p = current();
    if (!p) return;
    const rssis = p.frames.filter(f => !f.error && f.hdr.rssi != null).map(f => f.hdr.rssi);
    dlText('alert2-readings.json', JSON.stringify({
      generated: new Date().toISOString(),
      capture: { format: p.stats.mode === 'bin' ? 'usb-binary' : 'rs232-ascii',
                 frames: p.stats.frames, records: p.stats.records, errors: p.stats.errors,
                 clock_skew_seconds: p.stats.skew,
                 rssi_dbm: rssis.length
                   ? { n: rssis.length, median: median(rssis), best: Math.max(...rssis), worst: Math.min(...rssis) }
                   : null },
      readings: exportRows(),
    }, null, 2));
  }

  // ── init ──────────────────────────────────────────────────────────────────────

  function init() {
    // The coverage map is built on a div the next tab throws away, so leaving
    // has to take it down. Named in app.js's stop-list until #142; it says so
    // here now, and the registry is keyed by name so re-running init() is free.
    registerTabTeardown('Alert2', stop);
    // Station names come from the same two sources as the ALERT Packets tab, and
    // the national address file is the fallback for addresses MegaNet has never
    // seen. It loads once for both tabs.
    Packets.loadStationsFile();
    const view = document.getElementById('a2-view');
    if (view) attachRecHover(view);
    const p = current();
    initCoverageMap(p, p ? resolve(p) : null);
  }

  // Leaving the tab: the div this map was built on is about to be replaced.
  function stop() { stopMap(); }

  // Hovering a reading lights up the four bytes it came out of, and vice versa.
  function attachRecHover(root) {
    root.querySelectorAll('.fmtbody').forEach(card => {
      const mark = (i, on) => card.querySelectorAll('[data-rec="' + i + '"]').forEach(el => el.classList.toggle('hl', on));
      card.querySelectorAll('[data-rec]').forEach(el => {
        const i = el.dataset.rec;
        el.addEventListener('mouseenter', () => mark(i, true));
        el.addEventListener('mouseleave', () => mark(i, false));
      });
    });
  }

  // parse/decodeRecord are the codec on its own, with no DOM behind it — the
  // form a live feed would call, and the form this is testable in. parse takes
  // the mode, so both wire formats are reachable without a page.
  return { render, init, stop, decode, clear, loadSample, more, setView, setMode, setOpt,
           openFrame, pick, clearPicks, select,
           chooseFile, onFile, watchFile, stopWatch, stopWatching, exportCsv, exportJson,
           parse, parseAscii, parseBin, decodeRecord };
})();

