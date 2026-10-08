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
// string literal at line 1229, used as a compound-key separator (#129).
// Any tool that round-trips this file as text and normalises control characters
// destroys that key silently. `npm run concat` in test/ is what catches it.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── ALERT2 / ERT-A2 tab ─────────────────────────────────────────────────────────
//
// Decoder for what an ELPRO ERT-A2 writes to its RS232 port: the NHWC ALERT2
// IND API's MANT PDU string (IND API v1.1 §5.2, the "N" string) — one
// comma-separated line per received ALERT2 frame, 24 fixed fields of receiver
// and MANT header followed by the frame's payload as hex bytes.
//
//   ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00
//   └ tag  │ │    │     │ │ └─ arrival time ─────┘ └─ MANT header ──┘ │  │    └── payload ──────┘
//          │ │    │     │ └ time quality (1 = receiver clock locked)  │  └ source address
//          │ │    │     └ string type: N, the MANT PDU               └ payload length, bytes
//          │ │    └ agency id
//          │ └ IND source address (this ERT-A2)
//          └ API version
//
// The fields were first named from a 444-frame capture, because no spec was to
// hand, and four of those names were wrong in ways that lost data (#209). They
// are the spec's now: IND API v1.1 §5.2 for the line, MANT v1.2 Fig 2-2 for the
// header bits, Application Layer v1.3 §2–3 for the payload.
//
// Two things in the header decide how the rest is read. **Field 18 is the MANT
// port**: 1 is ALERT concentration — a repeater's bundle of legacy ALERT
// readings, each a 13-bit address and an 11-bit value, the same pair the ALERT
// Packets tab decodes, which is why both tabs agree on a reading — and 0 is a
// self-report, an ALERT2 gauge's own report of its sensors. Neither says the
// frame is clean or dirty; the line carries no such verdict. And fields 14, 16
// and 17 say whether a PDU ID, a list of the repeaters the frame came through
// and a destination address sit between field 24 and the payload.
//
// The payload opens with an application control byte (version, whether a time
// stamp follows, a test flag, an optional PDU id) and, usually, a 16-bit time
// stamp counting seconds from the most recent 00:00 or 12:00 — see placeStamp.
//
// Live capture is the destination, not the starting point. Web Serial is closed
// off on managed machines, so this ingests what an operator can get today: text
// pasted out of PuTTY, or a PuTTY session log picked off disk — and the log can
// be watched as it grows (log-follow.js): picked, where the browser's File
// System Access picker is allowed, or dragged onto the tab, which still works
// where a policy has switched that picker off. The Serial Monitor's ERT-A2 card
// is the same decoder fed live, from a port or from the same followed log.

const Alert2 = (function () {

  // ── protocol ──────────────────────────────────────────────────────────────────

  const TAG = 'ALERT2A';
  const PORT_SELF = 0;             // MANT port: Application Layer self-reporting protocol
  const PORT_CONC = 1;             // MANT port: ALERT concentration
  const REC_BYTES = 4;             // one concentration record
  const HALF_DAY = 43200;          // seconds the payload's time stamp counts up to
  const STAMP_TOL_MS = 10 * 60000; // how far a placed stamp may sit from its reference

  // The 24 fixed fields of the MANT PDU string, in order (IND API v1.1 §5.2).
  // `role` drives the colour of the chip in the frame anatomy; `sure` is true
  // where the meaning is established — by the spec, for every field here now.
  const FIELDS = [
    { k: 'tag',      label: 'Protocol tag',      role: 'ident', sure: true,
      note: 'Always ALERT2A — the ALERT2 IND API\'s ASCII output. ELPRO calls it the ALERT2 ASCII Protocol; the binary protocol on the USB port is a different, longer framing (method 2).' },
    { k: 'version',  label: 'API version',       role: 'ident', sure: true,
      note: 'The IND API version the line follows. 1 on every frame observed.' },
    { k: 'decoder',  label: 'IND source address', role: 'addr', sure: true,
      note: 'The receiver — the ERT-A2 this serial cable is plugged into. Configured on the unit itself.' },
    { k: 'agency',   label: 'Agency ID',         role: 'ident', sure: true,
      note: 'The receiver\'s agency string. ELPRO here.' },
    { k: 'frameType', label: 'String type',      role: 'ident', sure: true,
      note: 'N — the MANT PDU string, the one this tab reads. The API also defines P (the AirLink PDU), C and A (concentration already decoded) and S (status).' },
    { k: 'timeLock', label: 'Time quality',      role: 'time',  sure: true, num: true,
      note: '1 when the receiver\'s clock is locked (NTP), 0 when it is not — fields 7–12 are worth comparing with the frame\'s own stamp only on a 1.' },
    { k: 'year',     label: 'Year',              role: 'time',  sure: true, num: true },
    { k: 'month',    label: 'Month',             role: 'time',  sure: true, num: true },
    { k: 'day',      label: 'Day',               role: 'time',  sure: true, num: true },
    { k: 'hour',     label: 'Hour',              role: 'time',  sure: true, num: true },
    { k: 'minute',   label: 'Minute',            role: 'time',  sure: true, num: true },
    { k: 'second',   label: 'Second',            role: 'time',  sure: true, num: true,
      note: 'Fractional, to milliseconds. Fields 7–12 are when the frame arrived at the receiver, by the receiver\'s own clock — zeros if it has none. The transmitter\'s time is the stamp in the payload.' },
    { k: 'mantVer',  label: 'MANT version',      role: 'status', sure: true, num: true,
      note: 'Two bits. 0 is the only version defined.' },
    { k: 'protoId',  label: 'Protocol ID',       role: 'status', sure: true, num: true,
      note: '0 best efforts; 1 the end-to-end reliable datagram service, which puts a MANT PDU ID after the source address.' },
    { k: 'tsReq',    label: 'Time-stamp request', role: 'status', sure: true, num: true,
      note: '1 asks the first IND with good time to stamp the payload on its way.' },
    { k: 'pathReq',  label: 'Add-path request',  role: 'status', sure: true, num: true,
      note: '1 asks every repeater to add its address: a count and the addresses then follow the source address — which repeaters this copy came through.' },
    { k: 'daInHdr',  label: 'Destination in header', role: 'status', sure: true, num: true,
      note: '1 puts a destination address straight after the source address.' },
    { k: 'port',     label: 'Port',              role: 'ident', sure: true, num: true,
      note: 'Which application protocol the payload is: 0 a self-report (an ALERT2 gauge\'s own report), 1 ALERT concentration (legacy ALERT readings a repeater gathered). It decides how the payload is read, and says nothing about whether the frame is clean.' },
    { k: 'reserved', label: 'Reserved bits',     role: 'status', sure: true, num: true,
      note: 'Three bits, 0. MANT 1.2 (2025) takes the top one as an encrypted-payload flag.' },
    { k: 'ack',      label: 'EERDS ACK',         role: 'status', sure: true, num: true,
      note: 'Acknowledges a reliable-datagram PDU.' },
    { k: 'addedHdr', label: 'Added header',      role: 'status', sure: true, num: true,
      note: 'Kept for extensions; 0 means the payload follows the header directly.' },
    { k: 'hopLimit', label: 'Hop limit',         role: 'status', sure: true, num: true,
      note: 'How many more repeats the frame may take; 7 means no limit. It is not a reception quality — no field of this line is a signal level or a verdict.' },
    { k: 'payLen',   label: 'Payload length',    role: 'len',   sure: true, num: true,
      note: 'Payload size in bytes — which is what tells a wrapped or truncated line from a complete one.' },
    { k: 'source',   label: 'Source address',    role: 'addr',  sure: true, num: true,
      note: 'The IND that originated the frame: for a self-report, the gauge; for ALERT concentration, the repeater that gathered the legacy readings — whose own identities are the ALERT ids inside. A unit concentrating what it hears itself carries its own address here, the same as field 3.' },
  ];
  const N_FIELDS = FIELDS.length;   // 24

  // The recommended sensor IDs (Application Layer §2.2.2, Fig 2-5). Recommended,
  // not mandatory: a site may number its sensors otherwise, so a station's own
  // record wins where it has one (resolve).
  const SENSOR_NAMES = {
    0: 'Rain', 1: 'Air temperature', 2: 'Relative humidity', 3: 'Barometric pressure',
    4: 'Wind speed', 5: 'Wind direction', 6: 'Peak wind speed', 7: 'Stage', 8: 'Battery voltage',
    201: 'Clock status', 202: 'IND temperature', 203: 'Messages received', 204: 'Messages sent', 205: 'Status bits',
    255: 'Time stamp',
  };
  const REPORT_TYPES = {
    1: 'General Sensor Report', 2: 'Tipping Bucket Rain Gauge Report',
    3: 'Multi-Sensor Report (US units)', 4: 'Multi-Sensor Report (metric)', 5: 'Multi-Sensor Report (IND)',
    7: 'Time Series Data Report', 250: 'SET command', 251: 'GET command',
  };

  // ── one four-byte concentration record ────────────────────────────────────────
  //
  //   byte 0   AAAAAAAA   address bits 7–0
  //   byte 1   DDDAAAAA   data bits 10–8, then address bits 12–8
  //   byte 2   DDDDDDDD   data bits 7–0
  //   byte 3   TTTTTTTT   time offset: seconds the reading was held before the
  //                       frame was exported (Application Layer §3.3.2)
  //
  // Same 13-bit address and 11-bit value as ABF/EIF, packed into bytes instead of
  // async words. FORMATS.a2c on the ALERT Packets tab draws this same layout.
  // There is no status in it: whether a record is good is the frame's to say
  // (readPayload), and its fourth byte only says when the reading was taken.
  function decodeRecord(b, off) {
    return {
      off,
      bytes:   [b[0], b[1], b[2], b[3]],
      alertId: ((b[1] & 0x1f) << 8) | b[0],
      value:   ((b[1] >> 5) << 8) | b[2],
      offset:  b[3],
      ok:      true,
    };
  }

  const FULL_SCALE = 2047;          // 11 bits all set: over-range or a dead sensor

  // ── the frame's own time ──────────────────────────────────────────────────────
  //
  // The payload's time stamp counts seconds from the most recent 00:00 or 12:00
  // (Application Layer §2.1.2 and §3.2.2): sixteen bits cannot hold a day, so it
  // is a half-day count, and read as seconds since midnight every frame stamped
  // after noon lands twelve hours early. The spec says the half-days are UTC's.
  // Whether this network's devices keep UTC or local time is #157 Part 5's open
  // question, so neither is assumed: the stamp is put on the half-day nearest a
  // reference — when the frame arrived — once counting from UTC's 00:00 and
  // 12:00 and once from local time's, and whichever lands within ten minutes of
  // the reference is the frame's time, with which of the two it was. Both is a
  // computer on UTC (or twelve hours from it), where the two are one; neither is
  // a clock more than ten minutes out, and the caller decides what that means —
  // `utc` and `local` are the two placements either way.
  function placeStamp(stamp, refMs, tolMs) {
    if (stamp == null || refMs == null || !isFinite(refMs)) return null;
    const tol = tolMs == null ? STAMP_TOL_MS : tolMs;
    const ms = stamp * 1000, h = HALF_DAY * 1000;
    // The epoch is a UTC midnight, so UTC's half-days are whole multiples of 12 h.
    const u0 = Math.floor(refMs / h) * h;
    const utc = nearest([u0 - h, u0, u0 + h].map(t => t + ms), refMs);
    // Local half-days from the calendar, so a day a clock change makes 23 or 25
    // hours long still starts at its own 00:00 and turns at its own 12:00.
    const d = new Date(refMs);
    const local = nearest([-1, 0, 1].flatMap(k => [0, 12].map(hr =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, hr).getTime() + ms)), refMs);
    const okU = Math.abs(utc - refMs) <= tol, okL = Math.abs(local - refMs) <= tol;
    const base = okU && okL ? (utc === local ? 'either' : Math.abs(utc - refMs) <= Math.abs(local - refMs) ? 'utc' : 'local')
               : okU ? 'utc' : okL ? 'local' : null;
    return { ms: base === 'local' ? local : base ? utc : null, base, utc, local };
  }
  function nearest(ts, ref) { return ts.reduce((a, b) => Math.abs(b - ref) < Math.abs(a - ref) ? b : a); }

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

  // The fields between field 24 and the payload, there only when the header's
  // flags say so (§5.2 items 15–18), in this order: the destination address
  // (field 17 = 1), the MANT PDU ID (field 14, the protocol ID, = 1), and the
  // number of repeater addresses appended followed by the addresses (field
  // 16 = 1). How many there are, or null while the line is too short to say.
  function optionalCount(v) {
    if (v.length < N_FIELDS) return null;
    const on = i => Number(v[i]) === 1;
    let n = 0;
    if (on(16)) n++;
    if (on(13)) n++;
    if (on(15)) {
      if (v.length <= N_FIELDS + n) return null;
      const c = Number(v[N_FIELDS + n]);
      if (!Number.isInteger(c) || c < 0) return null;
      n += 1 + c;
    }
    return n;
  }

  // How many payload bytes a frame is still waiting for. This is what stops the
  // tail-gluing from being a guess: a complete frame never adopts the next line,
  // however much that line looks like hex. The reference capture has a PuTTY
  // banner landing mid-line and leaving a stray "A" behind — a perfectly good
  // hex byte, which without this check gets welded onto the frame above it.
  function shortfall(text) {
    const f = text.split(',');
    if (f.length <= N_FIELDS) return Infinity;          // header itself is incomplete
    const opt = optionalCount(f);
    if (opt == null) return Infinity;                   // still inside the optional fields
    const want = Number(f[N_FIELDS - 2]);               // field 23, the payload length
    return Number.isFinite(want) ? want - (f.length - N_FIELDS - opt) : 0;
  }

  // Split a capture into frame texts. Returns the pieces in file order along with
  // everything deliberately dropped, so the summary can account for every line
  // rather than quietly losing some.
  function splitCapture(text) {
    const frames = [];              // { text, lineNo, prefix, wrapped }
    const banners = [];             // { lineNo, ms }
    const junk = [];                // { lineNo, text, why }

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

  function blankFrame(o) {
    return Object.assign({ warn: [], error: null, damaged: null, hdr: {}, payload: null,
                           records: [], reports: [], sensors: [] }, o);
  }

  // Something about the frame's structure does not add up — a payload shorter or
  // longer than its header says, bytes left over after the last whole record, a
  // report running off the end. Its readings are kept and shown, and are not
  // vouched for: they are `ok: false`, and nothing sends them.
  function damage(f, why) {
    (f.damaged || (f.damaged = [])).push(why);
    f.warn.push(why);
  }

  function parseFrame(src, seq) {
    const f = blankFrame({
      seq, lineNo: src.lineNo, raw: src.text, wrapped: src.wrapped, prefix: src.prefix,
      fields: src.text.split(',').map(s => s.trim()),
    });
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

    // When the frame arrived, by the receiver's own clock. Built as local time
    // because that is how an operator reading the log will think about it —
    // which is why placeStamp's answer here is about the stamp *against this
    // clock*, and the Serial Monitor's, against the computer's, is the one that
    // can say UTC or local outright.
    if ([h.year, h.month, h.day, h.hour, h.minute, h.second].every(x => x !== null) && h.year > 0) {
      const s = Math.floor(h.second);
      h.clockMs = new Date(h.year, h.month - 1, h.day, h.hour, h.minute, s,
                           Math.round((h.second - s) * 1000)).getTime();
      h.clockSod = h.hour * 3600 + h.minute * 60 + h.second;
    } else {
      h.clockMs = null; h.clockSod = null;
      if (h.year !== 0) f.warn.push('the date/time fields did not parse as numbers');
    }

    // The optional fields, then the payload.
    let at = N_FIELDS;
    if (h.daInHdr === 1) h.dest = num(at++);
    if (h.protoId === 1) h.pduId = num(at++);
    if (h.pathReq === 1) {
      const n = num(at);
      if (n == null || !Number.isInteger(n) || n < 0 || at + 1 + n > v.length) {
        f.error = 'field ' + (at + 1) + ' should count the repeater addresses the add-path service appended, and reads ' + v[at];
        return f;
      }
      h.path = v.slice(at + 1, at + 1 + n).map(Number);
      at += 1 + n;
      if (h.path.some(x => !Number.isInteger(x))) { f.error = 'an appended repeater address is not a number'; return f; }
    }
    f.payAt = at;

    const hex = v.slice(at);
    const bad = hex.findIndex(x => !/^[0-9A-Fa-f]{1,2}$/.test(x));
    if (bad >= 0) { f.error = 'payload field ' + (at + bad + 1) + ' is not a hex byte (' + v[at + bad] + ')'; return f; }
    const bytes = hex.map(x => parseInt(x, 16));

    if (h.payLen !== bytes.length) {
      damage(f, 'payload length says ' + h.payLen + ' byte' + (h.payLen === 1 ? '' : 's')
              + ' but ' + bytes.length + ' arrived — the line is ' + (bytes.length < h.payLen ? 'cut short' : 'over-long'));
    }
    readPayload(f, bytes);
    return f;
  }

  // The application-layer payload, and the readings inside it. Identical on
  // both wire formats — the ASCII line spells these bytes out one hex field at
  // a time and the binary frame carries them whole — so both paths decode it
  // here, routed by the port the MANT header named.
  //
  //   control   bits 0–1 version (0), bit 2 a time stamp follows, bit 3 test
  //             data, bits 4–6 an application PDU id (7 = off), bit 7 a second
  //             control byte follows — §2.1.1, the same for both protocols
  //   [stamp]   16 bits, seconds since the most recent 00:00 or 12:00
  //   then      four-byte concentration records (port 1), or self-report
  //             reports, each type / length / value (port 0)
  function readPayload(f, bytes) {
    if (!bytes.length) { f.error = 'no payload bytes'; return f; }
    const c = bytes[0];
    const ctl = { byte: c, version: c & 3, ts: !!(c & 4), test: !!(c & 8), apdu: (c >> 4) & 7, ext: !!(c & 0x80) };
    f.payload = { bytes, ctl, stamp: null, hdrLen: 1, body: [] };
    if (ctl.version !== 0) {
      f.error = 'the control byte 0x' + hx(c) + ' says application layer version ' + ctl.version + '; only version 0 is defined';
      return f;
    }
    let at = 1;
    if (ctl.ext) {
      if (bytes.length < 2) { f.error = 'the control byte promises a second one, and the payload ends'; return f; }
      ctl.byte2 = bytes[at++];
    }
    if (ctl.ts) {
      if (bytes.length < at + 2) { f.error = 'the payload ends before the time stamp its control byte promises'; return f; }
      f.payload.stamp = (bytes[at] << 8) | bytes[at + 1];
      at += 2;
      if (f.payload.stamp >= HALF_DAY) f.warn.push('the time stamp reads ' + f.payload.stamp + ' s, past the 43,199 a half-day count can reach');
    }
    f.payload.hdrLen = at;
    f.payload.body = bytes.slice(at);

    const port = f.hdr.port;
    if (port === PORT_SELF) readSelfReport(f);
    else if (port === PORT_CONC || port == null) {
      if (port == null) f.warn.push('no MANT header to name the port — read as ALERT concentration');
      readConcentration(f);
    } else {
      f.warn.push('port ' + port + ' is not one this decoder reads (0 self-report, 1 ALERT concentration) — its bytes are shown raw');
    }
    if (f.damaged) {
      f.records.forEach(r => { r.ok = false; });
      f.sensors.forEach(s => { s.ok = false; });
    }
    return f;
  }

  function readConcentration(f) {
    const p = f.payload, body = p.body;
    const whole = Math.floor(body.length / REC_BYTES);
    if (body.length % REC_BYTES) damage(f, (body.length % REC_BYTES) + ' byte(s) left over after the last complete reading');
    for (let i = 0; i < whole; i++) {
      const r = decodeRecord(body.slice(i * REC_BYTES, i * REC_BYTES + REC_BYTES), p.hdrLen + i * REC_BYTES);
      r.frame = f; r.idx = i;
      f.records.push(r);
    }
  }

  // Self-reports (§2.1): one or more reports, each a type, an extensible length
  // (one byte to 127; above that the top bit is set and the next fifteen bits
  // are the length) and that many bytes. The General Sensor Report and the
  // tipping bucket report are read into sensor values; every other type is kept
  // as its bytes, named, and is not an error — the spec adds types as it goes.
  function readSelfReport(f) {
    const p = f.payload, b = p.body;
    let at = 0;
    while (at < b.length) {
      const start = at, type = b[at++];
      if (at >= b.length) { damage(f, 'the report at payload byte ' + (p.hdrLen + start) + ' has a type and no length'); break; }
      let len = b[at++];
      if (len & 0x80) {
        if (at >= b.length) { damage(f, 'the report at payload byte ' + (p.hdrLen + start) + ' is cut short inside its length'); break; }
        len = ((len & 0x7f) << 8) | b[at++];
      }
      if (at + len > b.length) {
        damage(f, 'the report at payload byte ' + (p.hdrLen + start) + ' claims ' + len + ' bytes and ' + (b.length - at) + ' remain');
        break;
      }
      const rep = { off: p.hdrLen + start, valOff: p.hdrLen + at, type, len,
                    name: REPORT_TYPES[type] || 'report type ' + type, bytes: b.slice(start, at + len), sensors: [] };
      const val = b.slice(at, at + len);
      if (type === 1) readGsr(f, rep, val);
      else if (type === 2) readTbrg(f, rep, val);
      else rep.kept = true;
      f.reports.push(rep);
      at += len;
    }
    f.reports.forEach(rep => rep.sensors.forEach(s => f.sensors.push(s)));
  }

  function sensorValue(f, rep, id, fl, bytes, off) {
    return Object.assign({ frame: f, report: rep, source: f.hdr.source, sensor: id,
                           name: SENSOR_NAMES[id] || null, fl, bytes, off, ok: true }, flValue(fl, bytes));
  }

  // General Sensor Report (§2.2): sensor id, value format/length, value — again
  // and again to the end of the report.
  function readGsr(f, rep, v) {
    let at = 0;
    while (at < v.length) {
      if (at + 2 > v.length) { damage(f, 'a sensor in the General Sensor Report at payload byte ' + (rep.valOff + at) + ' is cut short'); return; }
      const id = v[at], fl = v[at + 1], n = fl & 0x0f;
      if (at + 2 + n > v.length) { damage(f, 'sensor ' + id + ' claims ' + n + ' value bytes and ' + (v.length - at - 2) + ' remain'); return; }
      rep.sensors.push(sensorValue(f, rep, id, fl, v.slice(at + 2, at + 2 + n), rep.valOff + at));
      at += 2 + n;
    }
  }

  // Tipping bucket (§2.3): sensor id, format/length, the bucket's running count,
  // then one byte per tip in the report period — seconds before the report.
  function readTbrg(f, rep, v) {
    if (v.length < 2) { damage(f, 'the tipping bucket report is cut short'); return; }
    const id = v[0], fl = v[1], n = fl & 0x0f;
    if (2 + n > v.length) { damage(f, 'the tipping bucket count claims ' + n + ' bytes and ' + (v.length - 2) + ' remain'); return; }
    const s = sensorValue(f, rep, id, fl, v.slice(2, 2 + n), rep.valOff);
    s.tips = v.slice(2 + n);
    rep.sensors.push(s);
  }

  // A value's format and length byte (§2.2.3): the high nibble the format, the
  // low nibble the length in bytes. A combination the spec does not define is
  // skipped by its length, as §2.2.4 says, rather than failing the report.
  function flValue(fl, b) {
    const fmt = fl >> 4, n = fl & 0x0f;
    const uint = () => b.reduce((a, x) => a * 256 + x, 0);
    const sized = [1, 2, 3, 4, 8].includes(n);
    if (fmt === 0x1 && sized) return { value: uint(), type: n + '-byte unsigned' };
    if (fmt === 0x2 && sized) {
      const u = uint(), span = Math.pow(2, 8 * n);
      return { value: u >= span / 2 ? u - span : u, type: n + '-byte signed' };
    }
    if (fmt === 0x3 && n === 2) return fp2(b);
    if (fmt === 0x3 && (n === 4 || n === 8)) {
      const dv = new DataView(Uint8Array.from(b).buffer);
      return { value: n === 4 ? dv.getFloat32(0) : dv.getFloat64(0), type: n === 4 ? 'float32' : 'float64', float: true };
    }
    if (fmt === 0x4 && n >= 1) {
      let text;
      try { text = new TextDecoder('utf-8').decode(Uint8Array.from(b)); } catch (_) { text = b.map(hx).join(' '); }
      return { value: null, text, type: 'text' };
    }
    if (fl === 0xD1) return { value: b[0], type: 'seconds before transmission', time: true };
    if (fl === 0xE2) return { value: uint(), type: 'half-day time stamp', time: true };
    if (fl === 0xF4) return { value: uint(), type: 'POSIX time', time: true };
    return { value: null, type: 'format/length 0x' + hx(fl) + ', which the spec does not define — skipped by its length' };
  }

  // FP2 (Application Layer appendix 3): sign, a two-bit negative decimal
  // exponent, a thirteen-bit mantissa to 7,999 — so every value it holds is
  // exact in decimal, which is why it is rounded back to that here.
  function fp2(b) {
    const w = (b[0] << 8) | b[1], s = w >> 15, e = (w >> 13) & 3, m = w & 0x1fff;
    if (e === 0 && m === 8191) return { value: s ? -Infinity : Infinity, type: 'FP2', float: true };
    if (s && e === 0 && m === 8190) return { value: NaN, type: 'FP2', float: true };
    if (m > 7999) return { value: null, type: 'FP2 with mantissa ' + m + ', past the 7,999 it allows' };
    return { value: (s ? -1 : 1) * Number((m / Math.pow(10, e)).toFixed(e)), type: 'FP2', float: true };
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
    '8400': { label: 'MANT header', role: 'time', kind: 'mant', sure: true,
              note: 'The MANT header (MANT v1.2 Fig 2-2), the same bits the ASCII line spells out as fields 13–24: version, protocol ID and the three request flags; the port and the reserved and ACK bits; the added-header bit, the hop limit and the top of the payload length; the rest of the length; the source address — then a destination address, a PDU ID and the appended repeater addresses, when their flags are set. 00 10 70 on every frame captured so far: port 1, ALERT concentration, hop limit 7.' },
    '8401': { label: 'Payload', role: 'ident', kind: 'payload', sure: true,
              note: 'The application-layer payload — the same bytes the ASCII line spells out one hex field at a time, read by the port the header names.' },
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

  // The MANT header's bits (MANT v1.2 Fig 2-2), most significant first — the
  // same fields the ASCII line gives one at a time as 13–24 and after:
  //
  //   byte 0   VV PPP T A D   version, protocol ID, time-stamp request,
  //                           add-path request, destination address in header
  //   byte 1   OOOO RRR K     port, reserved (MANT 1.2: encrypted + two), ACK
  //   byte 2   H LLL NNNN     added header, hop limit, payload length 11–8
  //   byte 3   NNNNNNNN       payload length 7–0
  //   4–5      source address
  //   then     [destination address, 2] [PDU ID, 1] [count, 1 + addresses, 2 each]
  function readMant(v, f) {
    const fields = {
      mantVer: v[0] >> 6, protoId: (v[0] >> 3) & 7, tsReq: (v[0] >> 2) & 1, pathReq: (v[0] >> 1) & 1, daInHdr: v[0] & 1,
      port: v[1] >> 4, reserved: (v[1] >> 1) & 7, ack: v[1] & 1,
      addedHdr: v[2] >> 7, hopLimit: (v[2] >> 4) & 7,
    };
    const out = { fields, payLen: ((v[2] & 0x0f) << 8) | v[3], addr: u16(v, 4), len: v.length };
    let at = 6;
    const need = (n, what) => {
      if (at + n <= v.length) return true;
      f.warn.push('the MANT header\'s flags promise ' + what + ', and the header ends');
      return false;
    };
    if (fields.daInHdr && need(2, 'a destination address')) { fields.dest = u16(v, at); at += 2; }
    if (fields.protoId === 1 && need(1, 'a PDU ID')) { fields.pduId = v[at]; at += 1; }
    if (fields.pathReq && need(1, 'a count of repeater addresses')) {
      const n = v[at]; at += 1;
      if (need(2 * n, n + ' repeater address' + (n === 1 ? '' : 'es'))) {
        fields.path = [];
        for (let k = 0; k < n; k++, at += 2) fields.path.push(u16(v, at));
      }
    }
    return out;
  }

  // One binary frame, from the sync byte to the end of its declared length.
  function parseBinFrame(bytes, at, lineNo, seq) {
    const len   = bytes[at + 6];
    const end   = at + 7 + len;
    const raw   = bytes.slice(at, end);
    const f = blankFrame({
      seq, lineNo, kind: 'bin', byteOff: at, bytes: raw,
      raw: raw.map(hx).join(' '),
      wrapped: false, prefix: null, fields: [], tlv: [],
    });
    const h = f.hdr;
    // Nothing in the binary frame is the receiver's own clock — the ASCII line's
    // date and time fields have no counterpart here, and Ranger's own display
    // stamps its rows from the PC. So the only time a binary capture has is the
    // one inside the payload, and the skew check has nothing to compare.
    h.clockMs = null; h.clockSod = null; h.port = null;
    h.decoder = null; h.hopLimit = null; h.rssi = null;

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
      h.mant = readMant(mant.val, f);
      Object.assign(h, h.mant.fields);
      h.payLen = h.mant.payLen;
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
    const n = bytes.length;
    const scan = scanBinary(bytes, at => lineAt(marks, at));
    let { at, stray } = scan, tail = null;
    if (at + 7 <= n) {
      // The log stops part-way through a frame. Reported, not decoded: half a
      // frame decodes to readings that were never sent.
      tail = { at, want: bytes[at + 6] + 7, got: n - at, lineNo: lineAt(marks, at) };
      at = n;
    }
    stray += Math.max(0, n - at);
    return { frames: scan.frames, stats, stray, tail, total: n };
  }

  // The frames in a byte array, whole ones only. Stops at the first frame the
  // bytes run out in the middle of, or where too few are left to hold a sync,
  // and says where (`at`) — the rest is a pasted capture's tail, or a live
  // feed's next frame still arriving. "ALERT2A," is the RS232 port's ASCII line
  // and never a binary frame (whose first element is 0x75, never a comma), so
  // a feed carrying both does not read its text lines as frames.
  function scanBinary(bytes, lineOf) {
    const frames = [];
    const n = bytes.length;
    let at = 0, stray = 0;
    while (at + 7 <= n) {
      let sync = true;
      for (let k = 0; k < 6; k++) if (bytes[at + k] !== BIN_MAGIC[k]) { sync = false; break; }
      if (sync && bytes[at + 6] === 0x41 && bytes[at + 7] === 0x2C) sync = false;
      if (!sync) { at++; stray++; continue; }
      const len = bytes[at + 6];
      if (at + 7 + len > n) break;
      frames.push(parseBinFrame(bytes, at, lineOf ? lineOf(at) : 0, frames.length));
      at += 7 + len;
    }
    return { frames, at, stray };
  }

  // A live feed's raw bytes (a port, or a log PuTTY wrote "All session
  // output" into), as against hex text: the whole frames, and how many bytes
  // were used — the caller keeps the rest for the next chunk. Bytes that cannot
  // start a sync any more are counted as stray and used up too.
  function parseBinBytes(bytes) {
    const scan = scanBinary(bytes, null);
    let used = scan.at, stray = scan.stray;
    if (used + 7 > bytes.length) {
      // No frame can start before the last six bytes unless they open with
      // part of the sync, so everything ahead of that is spent.
      let keep = bytes.length;
      for (let k = Math.max(used, bytes.length - 6); k < bytes.length; k++) {
        let ok = true;
        for (let j = 0; k + j < bytes.length && j < 6; j++) if (bytes[k + j] !== BIN_MAGIC[j]) { ok = false; break; }
        if (ok) { keep = k; break; }
      }
      stray += keep - used;
      used = keep;
    }
    return { frames: scan.frames, used, stray };
  }

  function parseBin(text) {
    const split = splitBinary(text);
    const frames = split.frames;
    const good = frames.filter(f => !f.error);
    const recs = [], sensors = [];
    good.forEach(f => { f.records.forEach(r => recs.push(r)); f.sensors.forEach(x => sensors.push(x)); });
    const s = split.stats;

    const ingest = [];
    if (s.hexLines) ingest.push(s.hexLines + ' line' + (s.hexLines === 1 ? '' : 's') + ' of hex read as one byte stream');
    if (s.prefixes) ingest.push(s.prefixes + ' bracketed prefix' + (s.prefixes === 1 ? '' : 'es') + ' stripped before the hex');
    if (s.dumps)    ingest.push(s.dumps + ' hex-dump offset column' + (s.dumps === 1 ? '' : 's') + ' stripped');
    if (s.oddTokens) ingest.push(s.oddTokens + ' token' + (s.oddTokens === 1 ? '' : 's') + ' with an odd number of digits dropped — they cannot be split into bytes');
    if (split.stray) ingest.push(split.stray + ' byte' + (split.stray === 1 ? '' : 's') + ' outside any frame skipped');
    if (split.tail)  ingest.push('the capture stops ' + (split.tail.want - split.tail.got) + ' byte(s) into a frame at line ' + split.tail.lineNo);

    return {
      text, mode: 'bin', frames, records: recs, sensors,
      stats: {
        mode: 'bin',
        frames: frames.length,
        wrapped: 0, prefixed: s.prefixes,
        errors: frames.filter(f => f.error).length,
        warned: good.filter(f => f.warn.length).length,
        records: recs.length,
        sensors: sensors.length,
        selfReports: good.filter(f => f.hdr.port === PORT_SELF).length,
        tests: good.filter(f => f.payload && f.payload.ctl.test).length,
        badRecords: recs.filter(r => !r.ok).length + sensors.filter(x => !x.ok).length,
        banners: 0, junk: s.junk,
        bytes: split.total, stray: split.stray, ingest,
        decoders: [], agencies: [...new Set(good.map(f => f.hdr.agency).filter(Boolean))],
        sources: [...new Set(good.map(f => f.hdr.source).filter(x => x != null))],
        firstMs: null, lastMs: null,
        skew: null, skewN: 0, skewSpread: null, bases: null,
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
    const recs = [], sensors = [];
    good.forEach(f => { f.records.forEach(r => recs.push(r)); f.sensors.forEach(x => sensors.push(x)); });

    // Each frame's stamp, put on the half-day nearest when the receiver says it
    // arrived (placeStamp), and how far the receiver's clock sits from it.
    // Measured on frames whose structure adds up, from a receiver whose clock
    // is set: a damaged frame's stamp may itself be nonsense.
    const bases = { local: 0, utc: 0, either: 0, none: 0 };
    const skews = [];
    good.forEach(f => {
      if (!f.payload || f.payload.stamp == null || !f.hdr.clockMs) return;
      f.time = placeStamp(f.payload.stamp, f.hdr.clockMs);
      if (f.damaged) return;
      bases[f.time.base || 'none']++;
      // Against the placement that matched — or, where neither did, against the
      // half-day the receiver's own clock is counting, which is the reading the
      // old seconds-since-midnight one was trying to be, less its twelve hours.
      skews.push((f.hdr.clockMs - (f.time.ms != null ? f.time.ms : f.time.local)) / 1000);
    });
    const skew = median(skews);

    const clocks = good.map(f => f.hdr.clockMs).filter(x => x);
    return {
      text, mode: 'ascii', frames, records: recs, sensors,
      stats: {
        mode:      'ascii',
        frames:    frames.length,
        wrapped:   frames.filter(f => f.wrapped).length,
        prefixed:  frames.filter(f => f.prefix).length,
        errors:    frames.filter(f => f.error).length,
        warned:    good.filter(f => f.warn.length).length,
        records:   recs.length,
        sensors:   sensors.length,
        selfReports: good.filter(f => f.hdr.port === PORT_SELF).length,
        tests:     good.filter(f => f.payload && f.payload.ctl.test).length,
        badRecords: recs.filter(r => !r.ok).length + sensors.filter(x => !x.ok).length,
        banners:   split.banners.length,
        junk:      split.junk,
        decoders:  [...new Set(good.map(f => f.hdr.decoder))],
        sources:   [...new Set(good.map(f => f.hdr.source))],
        agencies:  [...new Set(good.map(f => f.hdr.agency))],
        firstMs:   clocks.length ? Math.min(...clocks) : null,
        lastMs:    clocks.length ? Math.max(...clocks) : null,
        skew, skewN: skews.length,
        skewSpread: skews.length ? Math.max(...skews) - Math.min(...skews) : null,
        bases,
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

  const idx = { src: null, byId: null, byA2: null };
  function alertIndex() {
    if (!state.data || !Array.isArray(state.data.stations)) return new Map();
    if (idx.src !== state.data) {
      idx.src = state.data;
      idx.byId = new Map();
      // An ALERT2 gauge is named by its own address — the station's
      // alert2_station_id — and a sensor by its slot on it (0024).
      idx.byA2 = new Map();
      state.data.stations.forEach(s => {
        if (s.alert2_station_id == null) return;
        const k = Number(s.alert2_station_id);
        if (!idx.byA2.has(k)) idx.byA2.set(k, []);
        idx.byA2.get(k).push(s);
      });
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
    // Self-report values, by gauge and sensor slot. No geography to settle:
    // an ALERT2 address is the gauge's own, set when it was commissioned, so it
    // matches one station or none — two is a database to fix, and says so.
    const byA2 = new Map();
    (parsed.sensors || []).forEach(x => {
      const key = a2Key(x.source, x.sensor);
      const e = byA2.get(key);
      if (e) { e.count++; return; }
      const sts = (idx.byA2 && x.source != null ? idx.byA2.get(Number(x.source)) : null) || [];
      const st = sts.length === 1 ? sts[0] : null;
      const se = st ? stationSensors(st).find(z => z && z.alert2_sensor_id != null && Number(z.alert2_sensor_id) === x.sensor) : null;
      const types = se && se.type ? [se.type] : [];
      byA2.set(key, { key, count: 1, cands: sts.map(z => ({ station: z, types: [] })),
                      chosen: st ? { station: st, types } : null,
                      conf: !sts.length ? 'unknown' : st ? 'sole' : 'ambiguous',
                      kind: kindOf(types.length ? types : [SENSOR_NAMES[x.sensor] || '']), fileName: null, a2: true });
    });
    return { byAlertId: out, byA2, centre, anchors: anchors.length,
             ambiguous: [...out.values()].filter(r => r.conf === 'ambiguous' || r.conf === 'likely').length,
             unknown: [...out.values()].filter(r => r.conf === 'unknown').length
                    + [...byA2.values()].filter(r => r.conf === 'unknown').length };
  }

  // The identity a self-report value is stored under (0024): a2:<gauge>/<sensor>.
  function a2Key(source, sensor) { return source + '/' + sensor; }

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

  // One row per reading: a concentration record's ALERT id and value, or a
  // self-report's gauge, sensor and value — in capture order, so a frame's
  // readings stay together whichever kind it carried.
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
      f.sensors.forEach(x => {
        const info = res.byA2 ? res.byA2.get(a2Key(x.source, x.sensor)) : null;
        const st = info && info.chosen ? info.chosen.station : null;
        const kind = info ? info.kind : null;
        if (a.onlyErrors && x.ok && !f.warn.length) return;
        if (a.hideUnknown && !st) return;
        rows.push({ x, r: x, f, info, st, kind, key: selKey(st, 'a2:' + a2Key(x.source, x.sensor)),
                    eng: a2Eng(x, kind, st) });
      });
    });
    return rows;
  }

  // A self-report value carries its own units — the gauge's, whatever it was
  // set up to send — so the counts-to-units scales are offered only where the
  // value is a whole count, the way the concentration records' always are.
  function a2Eng(x, kind, st) {
    return x.value != null && !x.float && !x.time && Number.isInteger(x.value) ? engValue(kind, x.value, st) : null;
  }

  // How a self-report value reads, with its format where that is not obvious.
  function a2ValueText(x) {
    if (x.text != null) return '"' + x.text + '"';
    if (x.value == null) return '—';
    return String(x.value);
  }

  // When a reading was taken, as one shows it: the clock time the frame's
  // stamp was placed at (placeStamp), less the seconds a repeater held it — or,
  // with nothing to place it against (the USB framing carries no clock), the
  // half-day count read both ways, since it cannot say which half it is. `sort`
  // orders readings either way.
  function readingWhen(f, offset) {
    const t = f.payload && f.payload.stamp;
    if (t == null) return f.hdr.clockMs ? { text: clockText(f.hdr.clockMs).slice(11), sort: f.hdr.clockMs } : { text: '—', sort: null };
    if (f.time) {
      const ms = (f.time.ms != null ? f.time.ms : f.time.local) - (offset || 0) * 1000;
      return { text: clockText(ms).slice(11), sort: ms, iso: isoText(ms) };
    }
    const h = (((t - (offset || 0)) % HALF_DAY) + HALF_DAY) % HALF_DAY;
    return { text: hms(h) + ' or ' + hms(h + HALF_DAY), sort: h };
  }

  // A concentration record's own time in the half-day: the frame's stamp less
  // the seconds the repeater held the reading (its fourth byte). Null for a
  // frame that carries no stamp.
  function recStamp(f, r) {
    const t = f.payload && f.payload.stamp;
    if (t == null) return null;
    return (((t - ((r && r.offset) || 0)) % HALF_DAY) + HALF_DAY) % HALF_DAY;
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
        const w = readingWhen(f, r.offset);
        if (w.sort != null && (e.first === null || w.sort < e.first.sort)) e.first = w;
        if (w.sort == null || e.last === null || w.sort >= e.last.sort) { e.last = w; e.lastVal = r.value; }
        e.min = Math.min(e.min, r.value);
        e.max = Math.max(e.max, r.value);
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    p.frames.forEach(f => {
      if (f.error) return;
      f.sensors.forEach(x => {
        if (!x.ok || x.value == null || !Number.isFinite(x.value)) return;
        const aid = 'a2:' + a2Key(x.source, x.sensor);
        let e = by.get(aid);
        if (!e) by.set(aid, e = { aid, a2: x, n: 0, first: null, last: null, min: Infinity, max: -Infinity, lastVal: null, rssi: [] });
        e.n++;
        const w = readingWhen(f, 0);
        if (w.sort != null && (e.first === null || w.sort < e.first.sort)) e.first = w;
        if (w.sort == null || e.last === null || w.sort >= e.last.sort) { e.last = w; e.lastVal = x.value; }
        e.min = Math.min(e.min, x.value);
        e.max = Math.max(e.max, x.value);
        if (f.hdr.rssi != null) e.rssi.push(f.hdr.rssi);
      });
    });
    return [...by.values()].map(e => {
      const info = e.a2 ? (res.byA2 ? res.byA2.get(a2Key(e.a2.source, e.a2.sensor)) : null) : res.byAlertId.get(e.aid);
      const st = info && info.chosen ? info.chosen.station : null;
      return Object.assign(e, { info, st, key: selKey(st, e.aid),
                                kind: info ? info.kind : null, eng: engValue(info ? info.kind : null, e.lastVal, st),
                                rssiMed: median(e.rssi), rssiBest: e.rssi.length ? Math.max(...e.rssi) : null,
                                rssiWorst: e.rssi.length ? Math.min(...e.rssi) : null });
    }).sort((x, y) => (typeof x.aid === 'number' ? 0 : 1) - (typeof y.aid === 'number' ? 0 : 1)
                    || (typeof x.aid === 'number' ? x.aid - y.aid : String(x.aid).localeCompare(String(y.aid), undefined, { numeric: true })));
  }

  // ── RSSI ──────────────────────────────────────────────────────────────────────
  //
  // The whole reason the binary format is worth reading. The bands are indicative
  // rather than a specification: the reference capture runs −81 to −114 dBm and
  // an ERT-A2 is usable to about −115, so the scale is laid out over the range a
  // real network actually occupies. It colours the map pins and the table cells,
  // and it is deliberately the same scale in both.
  //
  // The colours are tokens, not literals (#140). These are drawn on the page's
  // own ground — a bar beside a number, a legend dot, a map pin — so unlike the
  // bit cells, which paint their own ground, they have to clear 3:1 against
  // whichever theme is up, and measured they did not: "weak" was 2.46:1 on the
  // dark panel. `token` is what the CSS reads; `color` stays as the light
  // theme's literal, and is the fallback for the one consumer that cannot take
  // a var() — Leaflet, which needs a resolved colour for the pin fill.
  const RSSI_BANDS = [
    { max: Infinity, min: -90,      token: '--rssi-strong',   color: '#137a3b', label: 'strong',   note: 'above −90 dBm' },
    { max: -90,      min: -100,     token: '--rssi-good',     color: '#5a9e18', label: 'good',     note: '−90 to −100 dBm' },
    { max: -100,     min: -107,     token: '--rssi-fair',     color: '#b98511', label: 'fair',     note: '−100 to −107 dBm' },
    { max: -107,     min: -112,     token: '--rssi-marginal', color: '#d4691f', label: 'marginal', note: '−107 to −112 dBm' },
    { max: -112,     min: -Infinity, token: '--rssi-weak',    color: '#b3261e', label: 'weak',    note: 'below −112 dBm' },
  ];

  // In CSS, the token itself — so a theme change repaints the bar and the dot
  // without this tab re-rendering. Resolved to a literal only for Leaflet.
  const bandVar   = b => 'var(' + b.token + ')';
  const bandColor = b => cssVar(b.token, b.color);
  function rssiBand(v) {
    if (v == null) return null;
    return RSSI_BANDS.find(b => v > b.min && v <= b.max) || RSSI_BANDS[RSSI_BANDS.length - 1];
  }
  function rssiCell(v) {
    if (v == null) return '<span class="spec">—</span>';
    const b = rssiBand(v);
    return '<span class="a2-rssi" style="--rssi:' + bandVar(b) + '" title="' + esc(b.label + ' — ' + b.note) + '">'
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
  //
  // A button, not an href-less anchor (#140): the action is in-page, and an
  // anchor without a real href is invisible to the keyboard.
  function stationLink(st) {
    return '<button type="button" class="link-btn stn a2-stlink" onclick="event.stopPropagation();goToStation(\''
         + escAttr(st.id) + '\')" title="Open ' + escAttr(st.name) + ' on the Stations tab">'
         + esc(st.name) + '</button>';
  }

  function valueCell(row) {
    if (row.x) {
      const eng = row.eng ? '<div class="spec a2-follow" title="' + esc(row.eng.rule) + '">' + esc(row.eng.text) + '</div>' : '';
      return '<span class="val">' + esc(a2ValueText(row.x)) + '</span> <span class="spec">' + esc(row.x.type) + '</span>' + eng;
    }
    const full = row.r.value === FULL_SCALE
      ? ' <span class="badge warn" title="11 bits all set — over-range, or a sensor reading nothing">full scale</span>' : '';
    const eng = row.eng ? '<div class="spec a2-follow" title="' + esc(row.eng.rule) + '">' + esc(row.eng.text) + '</div>' : '';
    return '<span class="val">' + row.r.value + '</span>' + full + eng;
  }

  function typeCell(info, x) {
    if (x && (!info || !info.chosen || !info.chosen.types.length))
      return '<span class="spec">' + esc(x.name ? x.name + (x.sensor <= 8 ? ' (usual ID)' : '') : 'sensor ' + x.sensor) + '</span>';
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
      html += '<div class="a2-tlvrow" style="--depth:' + e.depth + '">'
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
    if (kind === 'mant' && e.len >= 6) {
      const m = readMant(e.val, { warn: [] }), x = m.fields;
      return 'port <b>' + x.port + '</b> <span class="spec">(' + (x.port === PORT_SELF ? 'self-report' : x.port === PORT_CONC ? 'ALERT concentration' : 'unknown') + ')</span> · '
           + 'hop limit <b>' + x.hopLimit + '</b> · '
           + '<b>' + m.payLen + '</b> <span class="spec">payload bytes</span> · '
           + '<b>' + m.addr + '</b> <span class="spec">source</span>'
           + (x.dest != null ? ' · destination <b>' + x.dest + '</b>' : '')
           + (x.pduId != null ? ' · PDU ID <b>' + x.pduId + '</b>' : '')
           + (x.path ? ' · via <b>' + (x.path.join(' → ') || 'none yet') + '</b>' : '') + ' ' + raw;
    }
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
    html += '<span class="a2-bgroup">' + cell(hx(p.bytes[0]), 'control', 'r-ident');
    let at = 1;
    if (p.ctl.ext) html += cell(hx(p.bytes[at++]), 'control 2', 'r-ident');
    if (p.ctl.ts) { html += cell(hx(p.bytes[at]), 'time hi', 'r-time') + cell(hx(p.bytes[at + 1]), 'time lo', 'r-time'); }
    html += '</span>';
    f.records.forEach((r, i) => {
      const at = ' data-rec="' + i + '"';
      html += '<span class="a2-bgroup" data-rec="' + i + '">'
            + cell(hx(r.bytes[0]), 'id lo', 'r-addr', at)
            + cell(hx(r.bytes[1]), 'val hi + id hi', 'r-pack', at)
            + cell(hx(r.bytes[2]), 'val lo', 'r-data', at)
            + cell(hx(r.bytes[3]), 'offset', r.ok ? 'r-status' : 'r-status bad', at)
            + '</span>';
    });
    f.reports.forEach((rep, i) => {
      const at = ' data-rec="r' + i + '"';
      const hdr = rep.bytes.length - rep.len;
      html += '<span class="a2-bgroup" data-rec="r' + i + '">'
            + cell(hx(rep.bytes[0]), 'type', 'r-ident', at)
            + rep.bytes.slice(1, hdr).map(b => cell(hx(b), 'length', 'r-len', at)).join('');
      if (rep.sensors.length && !rep.kept) {
        rep.sensors.forEach(x => {
          const k = x.off - rep.valOff;
          const v = rep.bytes.slice(hdr + k, hdr + k + 2 + x.bytes.length);
          html += cell(hx(v[0]), 'sensor', 'r-addr', at) + cell(hx(v[1]), 'format', 'r-len', at)
                + v.slice(2).map(b => cell(hx(b), 'value', x.ok ? 'r-data' : 'r-bad', at)).join('');
          (x.tips || []).forEach(t => { html += cell(hx(t), 'tip', 'r-time', at); });
        });
      } else {
        html += rep.bytes.slice(hdr).map(b => cell(hx(b), 'kept', 'r-status', at)).join('');
      }
      html += '</span>';
    });
    const used = p.hdrLen + f.records.length * REC_BYTES + f.reports.reduce((a, r) => a + r.bytes.length, 0);
    if (used < p.bytes.length && (f.records.length || f.reports.length || f.damaged)) {
      html += '<span class="a2-bgroup">';
      p.bytes.slice(used).forEach(b => { html += cell(hx(b), 'spare', 'r-bad'); });
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
      +     '<div><span class="swatch" style="--dot:var(--c-addr)"></span>ALERT id'
      +       ' <code>(0x' + hx(b1) + ' &amp; 0x1F) &lt;&lt; 8 | 0x' + hx(b0) + '</code> = <span class="val">' + r.alertId + '</span>'
      +       ' &nbsp;' + stationCell(info) + typeCellInline(info) + '</div>'
      +     '<div><span class="swatch" style="--dot:var(--c-data)"></span>Value'
      +       ' <code>(0x' + hx(b1) + ' &gt;&gt; 5) &lt;&lt; 8 | 0x' + hx(b2) + '</code> = <span class="val">' + r.value + '</span>'
      +       (eng ? ' &nbsp;<b>' + esc(eng.text) + '</b> <span class="spec">(' + esc(eng.rule) + ')</span>' : '')
      +       (r.value === FULL_SCALE ? ' <span class="badge warn">full scale</span>' : '') + '</div>'
      +     '<div><span class="swatch" style="--dot:var(--c-status)"></span>Time offset <code>0x' + hx(b3) + '</code> = '
      +       '<span class="val">' + b3 + ' s</span> — held ' + b3 + ' s before the frame was exported'
      +       (recStamp(r.frame, r) != null ? ', so it was taken at <b>' + esc(readingWhen(r.frame, r.offset).text) + '</b>' : '')
      +       (r.ok ? '' : ' · <span class="txt-bad">the frame around it does not add up, so the reading is not vouched for</span>') + '</div>'
      +   '</div>'
      + '</div></div>';
  }

  // A self-report's report: its readings by sensor, or — for a type this tab
  // does not read — its name and its bytes, kept.
  function reportBlock(f, rep, i, res) {
    let html = '<div class="a2-rec" data-rec="r' + i + '">'
      + '<div class="a2-rec-head">' + esc(rep.name) + ' <span class="spec">type ' + rep.type + ', ' + rep.len
      + ' byte' + (rep.len === 1 ? '' : 's') + ' at payload byte ' + rep.off + ' · <code>' + rep.bytes.map(hx).join(' ') + '</code></span></div>'
      + '<div class="a2-rec-body"><div class="a2-rec-maths">';
    if (rep.kept) html += '<div class="spec">Kept as its bytes — not a report type this tab reads, and not an error.</div>';
    rep.sensors.forEach(x => {
      const info = res.byA2 ? res.byA2.get(a2Key(x.source, x.sensor)) : null;
      const st = info && info.chosen ? info.chosen.station : null;
      const eng = a2Eng(x, info ? info.kind : null, st);
      html += '<div><span class="swatch" style="--dot:var(--c-addr)"></span>Sensor <b>' + x.sensor + '</b>'
        + (x.name ? ' <span class="spec">(' + esc(x.name) + (x.sensor <= 8 ? ', the spec\'s usual ID' : '') + ')</span>' : '')
        + ' · format <code>0x' + hx(x.fl) + '</code> ' + esc(x.type)
        + ' = <span class="val">' + esc(a2ValueText(x)) + '</span>'
        + (eng ? ' &nbsp;<b>' + esc(eng.text) + '</b> <span class="spec">(' + esc(eng.rule) + ')</span>' : '')
        + (x.tips ? ' <span class="spec">· ' + x.tips.length + ' tip' + (x.tips.length === 1 ? '' : 's') + ' this period'
            + (x.tips.length ? ', ' + x.tips.join(', ') + ' s before the report' : '') + '</span>' : '')
        + ' &nbsp;' + (info ? stationCell(info) : '') + typeCellInline(info)
        + ' <span class="spec">· stored as <code>a2:' + esc(a2Key(x.source, x.sensor)) + '</code></span>' + '</div>';
    });
    return html + '</div></div></div>';
  }

  function typeCellInline(info) {
    if (!info || !info.chosen || !info.chosen.types.length) return '';
    return ' <span class="spec">' + esc(info.chosen.types.join(', ')) + '</span>';
  }

  // The frame's time, as short as it can be said: the clock time it was placed
  // at, or the half-day count alone where there is nothing to place it against.
  function frameTimeText(f) {
    if (!f.payload || f.payload.stamp == null) return 'no stamp';
    if (f.time && f.time.ms != null) return clockText(f.time.ms).slice(11);
    return hms(f.payload.stamp) + ' into the half-day';
  }

  function controlText(c) {
    return 'Control byte <code>0x' + hx(c.byte) + '</code>: version ' + c.version + ', '
      + (c.ts ? 'a time stamp follows' : 'no time stamp') + ', '
      + (c.test ? '<b>test data</b> (sent while the site was set up or serviced)' : 'not test data') + ', '
      + (c.apdu === 7 ? 'PDU id off' : 'PDU id ' + c.apdu)
      + (c.ext ? ', a second control byte <code>0x' + hx(c.byte2) + '</code> follows' : '') + '.';
  }

  // The stamp, and where it lands against the receiver's clock (placeStamp).
  function stampText(f) {
    const t = f.payload.stamp;
    if (t == null) return 'The frame carries no time stamp of its own'
      + (f.hdr.clockMs ? ', so it is timed by when the receiver says it arrived, <b>' + clockText(f.hdr.clockMs) + '</b>.' : '.');
    let out = 'Time stamp <b>' + hms(t) + '</b> into the half-day (' + t + ' s since the most recent 00:00 or 12:00).';
    if (!f.hdr.clockMs) return out;
    const p = f.time;
    out += ' The receiver says it arrived at <b>' + clockText(f.hdr.clockMs) + '</b>';
    if (p && p.base === 'local')       out += ', which puts it at <b>' + clockText(p.ms) + '</b>, counting from the same 00:00 and 12:00 as the receiver\'s clock.';
    else if (p && p.base === 'utc')    out += ', which puts it at <b>' + clockText(p.ms) + '</b> — counting from UTC\'s 00:00 and 12:00, this computer\'s UTC offset away from the receiver\'s clock.';
    else if (p && p.base === 'either') out += ', which puts it at <b>' + clockText(p.ms) + '</b>. This computer is on UTC (or twelve hours from it), so the frame cannot say whether the stamp is UTC or local time.';
    else out += ' — more than ten minutes from where the stamp lands on either UTC\'s half-days or local time\'s, so one of the two clocks is wrong.';
    return out;
  }

  // What the header says beyond the fixed fields: a destination, a PDU id, the
  // repeaters a copy came through.
  function headerText(f) {
    const h = f.hdr, bits = [];
    if (h.hopLimit != null) bits.push('hop limit ' + h.hopLimit + (h.hopLimit === 7 ? ' (no limit)' : ''));
    if (h.dest != null) bits.push('destination ' + h.dest);
    if (h.pduId != null) bits.push('PDU ID ' + h.pduId);
    if (h.path) bits.push(h.path.length ? 'came through ' + h.path.join(' → ') : 'add-path asked, no repeater yet');
    return bits.length ? ' Header: ' + bits.join(' · ') + '.' : '';
  }

  function frameCard(f, res, open) {
    const badges = [];
    if (f.error)             badges.push('<span class="badge bad">error</span>');
    else if (f.warn.length)  badges.push('<span class="badge warn">' + f.warn.length + ' warning' + (f.warn.length > 1 ? 's' : '') + '</span>');
    else                     badges.push('<span class="badge ok">clean</span>');
    if (f.wrapped) badges.push('<span class="badge warn">re-joined</span>');

    const bin = f.kind === 'bin';
    if (bin) badges.push('<span class="badge ok" title="Read from the binary framing the USB port emits">USB</span>');
    const self = f.hdr.port === PORT_SELF;
    if (self) badges.push('<span class="badge" title="Port 0 — an ALERT2 gauge\'s own report">self-report</span>');
    if (f.payload && f.payload.ctl.test)
      badges.push('<span class="badge warn" title="The control byte\'s test flag: sent while the site was being set up or serviced">test</span>');

    const n = f.records.length + f.sensors.length;
    const summary = f.error
      ? esc(f.error)
      : frameTimeText(f) + ' · ' + n + ' reading' + (n === 1 ? '' : 's')
        + (f.hdr.rssi != null ? ' · ' + f.hdr.rssi + ' dBm' : '')
        + ' · ' + f.records.map(r => r.alertId + ':' + r.value)
                   .concat(f.sensors.map(x => 'a2:' + a2Key(x.source, x.sensor) + '=' + a2ValueText(x))).join('  ');

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
        body += '<h5 class="a2-h">Frame elements</h5>' + tlvChips(f);
        body += '<div class="spec">Tag, length, value — nesting shown by indent. Faded chips are elements that were '
              + 'constant across every frame cross-checked against Ranger, so their meaning is recorded but not established.</div>';
      } else {
        body += '<h5 class="a2-h">Header fields</h5>' + fieldChips(f);
        body += '<div class="spec">Every field named from the ALERT2 IND API v1.1 §5.2 — hover a chip for what it says.</div>';
      }
      const what = self ? 'self-report' : f.hdr.port === PORT_CONC || f.hdr.port == null ? 'ALERT concentration' : 'port ' + f.hdr.port;
      body += '<h5 class="a2-h">Payload — ' + what + ', ' + f.payload.bytes.length + ' bytes</h5>' + payloadStrip(f);
      body += '<div class="spec">' + controlText(f.payload.ctl) + ' ' + stampText(f)
            + (bin
                ? ' Received at <b>' + (f.hdr.rssi != null ? f.hdr.rssi + ' dBm' : 'an unreported level')
                  + '</b>. This framing carries no receiver clock, so the payload\'s stamp is the only time in it.'
                : '')
            + headerText(f) + '</div>';
      body += f.records.map((r, i) => recordBlock(r, i, res)).join('');
      body += f.reports.map((rep, i) => reportBlock(f, rep, i, res)).join('');
      if (!f.records.length && !f.reports.length) body += '<p class="spec">No complete readings in this payload.</p>';
    }
    // A <details>, not a div with a click handler (#140): same reasoning as the
    // ALERT Packets cards — a div's onclick is a mouse-only affordance, where
    // the summary is a disclosure a keyboard and a screen reader get for free.
    return '<details class="fmtcard"' + (open ? ' open' : '') + '>'
      + '<summary class="fmthead">'
      + '<h4>' + (bin ? 'Frame ' + (f.seq + 1) : 'Line ' + f.lineNo) + '</h4>' + badges.join(' ')
      + '<span class="caret">' + esc(summary.slice(0, 400)) + ' ▾</span></summary>'
      + '<div class="fmtbody">' + body + '</div></details>';
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
      + statChip(s.records + (s.sensors || 0), 'readings')
      + statChip(res.byAlertId.size, 'ALERT addresses')
      + (s.selfReports ? statChip(s.selfReports, 'self-reports') : '')
      + (s.tests ? statChip(s.tests, 'test frames', 'warn') : '')
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
      clock = '<div class="note compact pkt-block">'
        + (Math.abs(s.skew) < 2
            ? 'The ERT-A2 clock <b>agrees</b> with the ALERT2 frame time to within a couple of seconds across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + '.'
            : 'The ERT-A2 header clock reads <b>' + durText(s.skew) + ' '
              + (s.skew > 0 ? 'ahead of' : 'behind') + '</b> the ALERT2 frame time across '
              + s.skewN + ' frame' + (s.skewN === 1 ? '' : 's') + spread + '. '
              + 'The frame time comes from the transmitting network and the header time from the receiver\'s own RTC, '
              + 'so it is the unit\'s clock that needs setting — not the readings.')
        + ' ' + basesText(s.bases)
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
        ${ingest.length ? '<div class="spec pkt-block">' + ingest.join(' · ') + '.</div>' : ''}
        ${rssiNote}
        ${span}
        ${anchors}
        ${clock}
      </div>`;
  }

  // Which half-days the frame stamps count from, against the receiver's clock
  // (placeStamp). The receiver's clock is read as this computer's local time,
  // so "the same half-days" is the stamp agreeing with that clock, and "UTC's"
  // is the two being this computer's UTC offset apart. The Serial Monitor,
  // which holds the stamps against this computer's own clock, can say UTC or
  // local outright — #157 Part 5 is that question.
  function basesText(b) {
    if (!b) return '';
    const n = b.local + b.utc + b.either;
    if (!n) return '';
    const fr = k => k + ' frame' + (k === 1 ? '' : 's');
    if (b.either && !b.local && !b.utc)
      return 'This computer is on UTC (or twelve hours from it), so this capture cannot say whether the stamps are UTC or local time.';
    const parts = [];
    if (b.local) parts.push('<b>' + fr(b.local) + '</b> count from the same 00:00 and 12:00 as the receiver\'s clock');
    if (b.utc) parts.push('<b>' + fr(b.utc) + '</b> from UTC\'s, this computer\'s UTC offset away from it — so one of the two keeps UTC and the other local time, and the spec says the stamps are UTC');
    if (b.none) parts.push(fr(b.none) + ' land more than ten minutes from both');
    return 'Frame stamps count seconds from the most recent 00:00 or 12:00: ' + parts.join('; ') + '.';
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

  // The keyboard's way onto a clickable row (#140, pattern 7b): the ALERT id
  // cell is a .row-open button doing what a click anywhere on the row does.
  // A station link is not enough — an unmatched address has no station link,
  // and that row would be reachable by mouse only.
  function rowOpenBtn(key, label) {
    return '<button type="button" class="row-open" onclick="event.stopPropagation();Alert2.select(\''
         + escAttr(key) + '\')" title="Select — highlight this address in the table and on the map">'
         + label + '</button>';
  }

  function readingsView(p, res) {
    const a = state.a2;
    const c = cols(p);
    const rows = rowsFor(p, res);
    const shown = rows.slice(0, a.limit);
    let html = '<div class="table-wrap a2-tablewrap"><table class="fields a2-table">'
      + '<caption class="sr-only">Decoded readings — one row per reading, in capture order</caption>'
      + '<thead><tr>'
      + '<th scope="col">FRAME TIME</th>' + (c.clock ? '<th scope="col">ERT-A2 CLOCK</th>' : '')
      + '<th scope="col">ID</th><th scope="col">STATION</th><th scope="col">SENSOR</th><th scope="col">VALUE</th>'
      + (c.rssi ? '<th scope="col">RSSI</th>' : '') + '<th scope="col">' + (p.stats.mode === 'bin' ? 'FRAME' : 'LINE') + '</th>'
      + '</tr></thead><tbody>';
    shown.forEach(row => {
      const w = readingWhen(row.f, row.x ? 0 : row.r.offset);
      const id = row.x ? 'a2:' + a2Key(row.x.source, row.x.sensor) : row.r.alertId;
      html += '<tr' + rowAttrs(row.key, row.r.ok ? '' : 'a2-badrow') + '>'
        + '<td><code>' + esc(w.text) + '</code>'
        + (row.f.payload.ctl.test ? ' <span class="badge warn" title="Sent as test data">test</span>' : '') + '</td>'
        + (c.clock ? '<td><span class="spec">' + esc(clockText(row.f.hdr.clockMs)) + '</span></td>' : '')
        + '<td>' + rowOpenBtn(row.key, '<b>' + esc(String(id)) + '</b>') + '</td>'
        + '<td>' + stationCell(row.info) + '</td>'
        + '<td>' + typeCell(row.info, row.x) + '</td>'
        + '<td>' + valueCell(row) + '</td>'
        + (c.rssi ? '<td>' + rssiCell(row.f.hdr.rssi) + '</td>' : '')
        + '<td><button type="button" class="link-btn a2-link" onclick="event.stopPropagation();Alert2.openFrame(' + row.f.seq + ')" '
        + 'title="Open this frame in the anatomy view">'
        + (p.stats.mode === 'bin' ? row.f.seq + 1 : row.f.lineNo) + ' ▸</button></td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
    if (!rows.length) html += '<p class="spec">No readings match the current filters.</p>';
    if (rows.length > shown.length)
      html += '<div class="pkt-block"><button class="ghost" onclick="Alert2.more()">Show '
            + Math.min(ROW_STEP, rows.length - shown.length) + ' more</button> '
            + '<span class="spec">showing ' + shown.length + ' of ' + rows.length + ' readings</span></div>';
    return html;
  }

  function stationsView(p, res) {
    const c = cols(p);
    const roll = stationRollup(p, res);
    let html = '<p class="sub">One row per ALERT address or ALERT2 sensor heard, newest value last. This is the view that answers '
             + '“is that station still reporting, and what is it saying”'
             + (c.rssi ? ' — and, from the USB capture, how well it is being heard.' : '.') + '</p>'
             + '<div class="table-wrap a2-tablewrap"><table class="fields a2-table">'
             + '<caption class="sr-only">Stations heard — one row per ALERT address, newest value last</caption>'
             + '<thead><tr>'
             + '<th scope="col">ID</th><th scope="col">STATION</th><th scope="col">SENSOR</th><th scope="col">HEARD</th>'
             + '<th scope="col">FIRST → LAST</th><th scope="col">RANGE</th><th scope="col">LATEST</th>'
             + (c.rssi ? '<th scope="col">RSSI MEDIAN</th><th scope="col">BEST / WORST</th>' : '')
             + '</tr></thead><tbody>';
    roll.forEach(e => {
      html += '<tr' + rowAttrs(e.key) + '>'
        + '<td>' + rowOpenBtn(e.key, '<b>' + esc(String(e.aid)) + '</b>') + '</td>'
        + '<td>' + stationCell(e.info) + '</td>'
        + '<td>' + typeCell(e.info, e.a2) + '</td>'
        + '<td>' + e.n + '</td>'
        + '<td><code>' + esc(e.first ? e.first.text : '—') + '</code> → <code>' + esc(e.last ? e.last.text : '—') + '</code></td>'
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
      html += '<div class="pkt-block"><button class="ghost" onclick="Alert2.more()">Show more</button> '
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
      html += '<div class="pkt-block"><button class="ghost" onclick="Alert2.clearPicks()">Clear all pinned choices</button></div>';
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
      f.sensors.forEach(x => {
        if (!x.ok) return;
        const info = res.byA2 ? res.byA2.get(a2Key(x.source, x.sensor)) : null;
        const st = info && info.chosen ? info.chosen.station : null;
        if (!st || st.lat == null || st.lon == null) return;
        const id = 'a2:' + a2Key(x.source, x.sensor);
        let e = by.get(st.id);
        if (!e) by.set(st.id, e = { st, key: selKey(st, id), aids: new Set(), n: 0, rssi: [], conf: info.conf });
        e.aids.add(id);
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
        + RSSI_BANDS.map(b => '<span class="a2-lkey" title="' + esc(b.note) + '"><i style="--dot:' + bandVar(b) + '"></i>' + esc(b.label) + '</span>').join('')
        + '<span class="spec">bands are indicative; pin size is how many readings the station sent</span></div>'
      : '<div class="a2-legend"><span class="spec">Pin size is how many readings the station sent. '
        + 'Paste a USB capture instead and the pins colour by RSSI.</span></div>';

    return `
      <div class="panel">
        <div class="panel-header"><h3>Where these packets came from <span class="badge ok">${pts.length} station${pts.length === 1 ? '' : 's'}</span></h3></div>
        <p class="sub">Every station this receiver heard in the capture. Click a pin to light up its readings in the
          table below; click a reading and its pin lights up here. The station name in either place opens it on the
          <button type="button" class="link-btn" onclick="switchTab('stations')">Stations</button> tab.</p>
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
    // Leaflet's keyboard handler makes the container a tab stop, so it needs a
    // name — and the name carries the counts, parts 1–2 of the graphic pattern
    // (design-system §3); part 3, the data itself, is the table below the map.
    const withRssi = pts.filter(e => e.rssiMed != null).length;
    el.setAttribute('aria-label',
      'Coverage map — ' + pts.length + ' station' + (pts.length === 1 ? '' : 's')
      + ' this receiver heard, pin size by readings sent'
      + (withRssi ? ', pin colour by signal strength' : ''));
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
        fillColor: band ? bandColor(band) : cssVar('--muted', '#5a6b7d'), fillOpacity: .85,
      });
      m.a2Key = e.key;
      m.a2Base = { fill: band ? bandColor(band) : cssVar('--muted', '#5a6b7d') };
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
    const ids = [...e.aids].sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true })).join(', ');
    return '<b>' + esc(e.st.name) + '</b>'
      + (e.st.station_number ? '<br><span class="spec">' + esc(e.st.station_number) + '</span>' : '')
      + '<br>' + e.n + ' reading' + (e.n === 1 ? '' : 's') + ' on address' + (e.aids.size === 1 ? ' ' : 'es ') + ids
      + (e.rssiMed != null
          ? '<br>RSSI <b>' + e.rssiMed + ' dBm</b> median, ' + e.rssiBest + ' best / ' + e.rssiWorst + ' worst'
          : '')
      + '<br><button type="button" class="link-btn" onclick="goToStation(\'' + escAttr(e.st.id) + '\')">Open on the Stations tab →</button>';
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
      + '<td><span class="swatch" style="--dot:var(--c-' + ROLE_VAR[spec.role] + ')"></span>' + esc(spec.label) + '</td>'
      + '<td>' + (spec.sure ? '<span class="badge ok">established</span>' : '<span class="badge warn">constant only</span>') + '</td>'
      + '<td class="spec">' + esc(spec.note || '') + '</td></tr>').join('');
    const binRows = BIN_ORDER.map(([tag, depth]) => {
      const spec = BIN_TAGS[tag];
      return '<tr>'
        + '<td class="a2-el-tag" style="--depth:' + depth + '"><code>' + tag + '</code></td>'
        + '<td><span class="swatch" style="--dot:' + (spec.role === 'rssi' ? 'var(--ok)' : 'var(--c-' + ROLE_VAR[spec.role] + ')') + '"></span>' + esc(spec.label) + '</td>'
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
              <li><b>Does not give you RSSI.</b> None of the 24 fields is a signal level, and none is a verdict on the
                frame: field 18 is the MANT port and field 22 the hop limit (ALERT2 IND API v1.1 §5.2).</li>
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
                own time stamp, seconds into the half-day.</li>
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

          <p class="spec">Every line is the IND API's MANT PDU string (ALERT2 IND API v1.1 §5.2): <code>ALERT2A</code>,
            23 more fixed fields, then — only when fields 17, 14 and 16 say so — a destination address, a MANT PDU ID
            and a count of repeater addresses followed by the addresses, and then the frame payload as hex bytes, one
            field per byte. Field 23 gives the payload length, which is what distinguishes a complete line from one
            the terminal wrapped or cut short.</p>

          <div class="table-wrap a2-tablewrap"><table class="fields a2-table">
            <caption class="sr-only">The 24 fields of an ALERT2 ASCII line, in order, with how well each meaning is established</caption>
            <thead><tr>
            <th scope="col">#</th><th scope="col">FIELD</th><th scope="col">CONFIDENCE</th><th scope="col">NOTES</th>
          </tr></thead><tbody>${rows}</tbody></table></div>
        </details>

        <details>
          <summary class="pkt-summary">Method 2 — ELPRO binary framing, element reference</summary>

          <p class="spec">Six ASCII bytes <code>41 4C 45 52 54 32</code> (“ALERT2”) sync the frame, one byte gives
            the length of everything that follows, and the rest is tag / length / value. A tag byte with its top
            bit set is the first of a two-byte tag; otherwise the tag is that single byte. Length is always one
            byte. Two elements are containers whose value is more elements — shown indented below.</p>

          <div class="table-wrap a2-tablewrap"><table class="fields a2-table">
            <caption class="sr-only">The elements of the ELPRO binary framing, in wire order, nesting shown by indent</caption>
            <thead><tr>
            <th scope="col">TAG</th><th scope="col">ELEMENT</th><th scope="col">CONFIDENCE</th><th scope="col">NOTES</th>
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

          <h4 class="a2-h">Payload — the control byte and the time stamp</h4>
          <ul class="pkt-cheat">
            <li>Byte 1 — the <b>application control byte</b> (Application Layer v1.3 §2.1.1, §3.2.1): bits 0–1 the
              version (0), bit 2 a time stamp follows, bit 3 <b>test data</b> — sent while a site is set up or
              serviced — bits 4–6 an optional PDU id (7 is off), bit 7 a second control byte follows.
              <code>0x74</code>, on almost every frame, is version 0 with a stamp, not test, PDU id off;
              <code>0x7C</code> is the same flagged as test; <code>0x70</code> carries no stamp.</li>
            <li>Then, when bit 2 says so, the <b>time stamp</b>: sixteen bits of seconds since the most recent 00:00
              or 12:00 — a half-day count, because sixteen bits cannot hold a day. The spec says UTC. Whether this
              network keeps UTC or local time is the open question in #157, so the tab puts the stamp on the
              half-day nearest when the receiver says the frame arrived, in both, and says which one fits.</li>
            <li>Then, by the port the header names: <b>ALERT concentration</b> records (port 1), or the
              <b>self-report</b> a gauge sends of its own sensors (port 0).</li>
          </ul>

          <h4 class="a2-h">ALERT concentration — one reading, four bytes</h4>
          <ul class="pkt-cheat">
            <li><code>byte 0</code> — ALERT address, low 8 bits.</li>
            <li><code>byte 1</code> — <code>DDDAAAAA</code>: value bits 10–8 on top, address bits 12–8 below.
              This is the only part of the encoding that is not obvious by eye — a byte that looks like part of
              the address is carrying the top of the value as well.</li>
            <li><code>byte 2</code> — value, low 8 bits.</li>
            <li><code>byte 3</code> — <b>time offset</b>: the seconds the repeater held the reading before it
              exported the frame (§3.3.2), so the reading's own time is the stamp less this. Not a status — no part
              of a record says whether it is good.</li>
            <li>So address is 13 bits (0–8191) and value 11 bits (0–2047) — the same widths a legacy ALERT
              sensor transmits, which is why the ALERT Packets tab decodes one of these records to the same
              id and value under its <b>A2C</b> layout. A frame carries one reading or many, repeated to the end
              of the payload, usually the rainfall, water level and battery of one field station.</li>
          </ul>

          <h4 class="a2-h">Self-reports — an ALERT2 gauge's own readings</h4>
          <ul class="pkt-cheat">
            <li>One or more reports, each a type, a length (one byte to 127; above that the top bit is set and the
              length is the next fifteen bits) and that many bytes (§2.1).</li>
            <li><b>Type 1, the General Sensor Report</b> (§2.2): sensor id, a format/length byte, the value — again and
              again. The format is the high nibble: 1 unsigned, 2 signed, 3 floating point (FP2, IEEE single or
              double), 4 text; the low nibble is how many bytes. Sensor ids 0–8 are usually rain, air temperature,
              humidity, pressure, wind speed, direction and gust, stage and battery voltage — recommended by the spec,
              not required, so a station's own record of its sensors wins.</li>
            <li><b>Type 2, the tipping bucket</b> (§2.3): sensor id, format/length, the bucket's running count, then a
              byte per tip in the period — seconds before the report.</li>
            <li>Any other type is shown as its bytes, named, and is not an error. Each value is stored under the
              gauge's own ALERT2 address and its sensor id, <code>a2:&lt;gauge&gt;/&lt;sensor&gt;</code> — the
              identity Flood-Net keeps relayed ALERT2 readings under (0024).</li>
          </ul>

          <h4 class="a2-h">How this was established</h4>
          <p class="spec">From the NHWC specifications: ALERT2 IND API v1.1 §5.2 (Feb 2016) for the line, MANT v1.2
            Fig 2-2 (Jan 2025) for the header bits, and Application Layer v1.3 §2–3 (Nov 2019) for the payload. They
            were checked against a 444-frame capture from a test ERT-A2 and the same traffic decoded by ELPRO's Ranger
            software: addresses, values and times matched Ranger's record for record. The one frame of the 444 the
            first decoder called corrupt is the test rig's own General Sensor Report — port 0, hop limit 1: battery
            129, stage −1247, rain 8 — byte for byte. 339 of the 348 addresses heard matched a station in Flood-Net.
            The engineering scales below are interpretations, not part of the protocol.</p>

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
            frequently</em> on by default, so the file is not held back until the session closes), and a watched log
            is re-read as it grows, so the decode keeps up with the unit without a serial port being involved.
            <b>Drag the log onto this tab</b> from File Explorer — or the folder PuTTY logs into, to watch whichever
            log in it is newest. That works in every browser, and it still works on a managed machine whose policy
            has switched the browser's file picker off (<code>DefaultFileSystemReadGuardSetting</code>), because a
            dropped file is read through a different API that the policy does not cover. Where the picker is
            allowed, <b>Watch a log file…</b> does the same from a dialog. A file picked with <b>Choose log file…</b>
            cannot be watched: the browser refuses to read it again once it has changed, which is what made the
            first attempt at this fail. The Serial Monitor's ERT-A2 card follows a log the same way, as a live
            dashboard.</p>
        </details>
      </div>`;
  }

  const ROLE_VAR = { ident: 'ident', addr: 'addr', time: 'time', status: 'status', len: 'hd' };

  // ── sample ────────────────────────────────────────────────────────────────────
  // Real lines from a test ERT-A2, chosen to exercise every ingest path: plain
  // frames, a multi-reading frame, a line the terminal wrapped, a PuTTY banner
  // dropped mid-capture, a line carrying a terminal timestamp, the rig's own
  // self-report, and a line cut off at the end of the log. Every one was
  // received after noon, so every stamp counts from 12:00.
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
    // The one frame in 444 the first decoder called corrupt, and it is not: port
    // 0 (field 18), hop limit 1 (field 22), and a General Sensor Report — the
    // test rig's battery 129, stage −1247 and rain 8 (#209).
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
                  aria-label="Capture — paste an ALERT2 ASCII log or USB hex here"
                  placeholder="ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00&#10;41 4C 45 52 54 32 4D 75 01 01 18 02 27 0F 77 05 45 4C 50 52 4F …"
                  oninput="state.a2.text=this.value">${esc(a.text)}</textarea>
        <div class="row pkt-block">
          <div class="fit"><button class="primary" onclick="Alert2.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.chooseFile()">Choose log file…</button></div>
          ${w ? '<div class="fit"><button class="ghost" onclick="Alert2.stopWatching()">Stop watching ' + esc(w.name) + '</button></div>'
              : LogFollow.canPick() ? '<div class="fit"><button class="ghost" onclick="Alert2.watchFile()">Watch a log file…</button></div>' : ''}
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('ascii')">Sample — RS232 ASCII</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.loadSample('bin')">Sample — USB hex</button></div>
          <div class="fit"><button class="ghost" onclick="Alert2.clear()">Clear</button></div>
        </div>
        <input type="file" id="a2-file" accept=".txt,.log,.csv,.hex,.dat,text/plain" hidden onchange="Alert2.onFile(this)">
        <div id="a2-status" class="note compact pkt-block"${a.source ? '' : ' hidden'}>${esc(a.source)}</div>
        ${a.watchErr ? '<div class="note compact warn pkt-block">' + a.watchErr + '</div>' : ''}
        ${w ? '' : '<div class="spec a2-drop-hint">To <b>watch a log as PuTTY writes it</b>, drag the file — or the folder it logs into — onto this tab from File Explorer. It is re-read as it grows, and that works even where IT has switched the browser\'s file picker off.</div>'}
      </div>`;
  }

  // aria-pressed, because .on is a colour: the pressed state has to reach a
  // reader that never sees the accent background (#140).
  function modeBtn(id, label, title) {
    const on = state.a2.mode === id;
    return '<button class="a2-vtab' + (on ? ' on' : '') + '" aria-pressed="' + on + '" title="' + esc(title)
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
      // Labels, not spans: the caption beside a number box has to *be* its name,
      // or the box announces as an unlabelled spinbutton (#140).
      + '<label class="a2-num" title="Fallback only — a station carrying a recorded TBRGbucketSize uses that instead">'
      + 'mm per tip (fallback) <input type="number" step="0.1" min="0" value="' + a.mmPerTip
      + '" oninput="Alert2.setOpt(\'mmPerTip\',this.value)"></label>'
      + '<label class="a2-num">battery ÷ <input type="number" step="1" min="1" value="' + a.battDiv
      + '" oninput="Alert2.setOpt(\'battDiv\',this.value)"></label>'
      + '</div>';
  }

  function viewPanel(p, res) {
    const a = state.a2;
    const tab = (id, label) => '<button class="a2-vtab' + (a.view === id ? ' on' : '') + '" aria-pressed="' + (a.view === id) + '" onclick="Alert2.setView(\'' + id + '\')">' + esc(label) + '</button>';
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
    <div class="pkt a2 page" style="--page-max:1280px" ondragover="Alert2.dragOver(event)" ondrop="Alert2.dropFile(event)">

      <div class="panel">
        <div class="panel-header"><h2>ALERT2 / ERT-A2 Serial Decoder</h2></div>
        <p class="sub">Decodes what an ELPRO ERT-A2 puts on its serial ports: receiver metadata, the frame's own
          timestamp, the signal level it came in at, and the ALERT readings packed into its payload — each one
          matched back to a station in the Flood-Net database and put on the map. The readings inside are ordinary
          13-bit ALERT addresses and 11-bit values, the same ones the
          <button type="button" class="link-btn" onclick="switchTab('packets')">ALERT Packets</button> tab decodes one at a time.</p>
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
      const card = document.querySelector('#a2-view details.fmtcard[open]');
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

  // Watching a log as it grows. How the file is re-read — and why a dropped
  // file can be watched where the picker is blocked by policy, and a chosen
  // one never can — is log-follow.js's header. A refusal used to end in a bare
  // `return`, which is exactly what a managed machine looks like: the button
  // there, pressing it doing nothing. Every refusal is said now, with the way
  // round it (LogFollow.refusal).
  async function watchFile() {
    const a = state.a2;
    a.watchErr = '';
    const r = await LogFollow.pick();
    if (!r) return;                                   // dismissed: not a fault
    if (r.error) { a.watchErr = LogFollow.refusal(r.error); refresh(); return; }
    beginWatch(r.src);
  }

  function dragOver(e) {
    if (!LogFollow.isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  // A drop anywhere on the tab, or anywhere on the page while it is up (the
  // document guard in init) — a file let fall beside the target must not make
  // the browser navigate away to show it.
  function dropFile(e) {
    if (e.defaultPrevented || !LogFollow.isFileDrag(e)) return;
    e.preventDefault();
    if (state.activeTab !== 'alert2') return;
    const r = LogFollow.fromDrop(e.dataTransfer);    // synchronously: the items die with the event
    if (r.error) { state.a2.watchErr = esc(r.error.message); refresh(); return; }
    beginWatch(r.src);
  }

  // PuTTY writes bytes as they came off the port, which is ASCII; a log saved
  // as UTF-16 carries a byte-order mark, read here as onFile reads it.
  function decoderFor(u8, from) {
    if (from === 0 && u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le');
    if (from === 0 && u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be');
    return new TextDecoder('utf-8');
  }

  function beginWatch(src) {
    const a = state.a2;
    stopWatch();
    a.watchErr = '';
    a.text = '';
    a.limit = ROW_STEP;
    a.sel = null;
    a.mapView = null;
    const w = a.watch = { src, name: src.name, follower: null, dec: null, changed: false };
    const label = () => src.via === 'folder' ? w.name + ' (newest in ' + src.folder + ')' : w.name;
    w.follower = LogFollow.start(src, {
      fromStart: true,
      intervalMs: src.live ? a.watchMs : undefined,
      onData: (u8, m) => {
        if (a.watch !== w) return;
        if (!w.dec) w.dec = decoderFor(u8, m.from);
        a.text += w.dec.decode(u8, { stream: true });
        w.name = m.name || w.name;
        w.changed = true;
      },
      onReset: (why, name) => {
        if (a.watch !== w) return;
        a.text = ''; w.dec = null; w.name = name || w.name; w.changed = true;
      },
      onError: (e, fatal) => {
        if (a.watch !== w) return;
        if (fatal) {
          stopWatch();
          a.watchErr = '<b>Stopped watching ' + esc(label()) + '.</b> ' + esc(LogFollow.trouble(e, src, true));
          announce('Stopped watching ' + w.name);
          if (state.activeTab === 'alert2') refresh();
        } else status(LogFollow.trouble(e, src, false));
      },
      onTick: f => {
        if (a.watch !== w) return;
        const changed = w.changed;
        w.changed = false;
        if (changed && state.activeTab === 'alert2') refresh();
        status(src.live
          ? 'Watching ' + label() + ' — re-read every ' + (a.watchMs / 1000) + ' s, last at ' + clockText(Date.now())
            + ' (' + (f.bytes / 1024).toFixed(1) + ' kB read' + (f.trimmed ? ', its last ' + (LogFollow.FIRST_MAX / 1048576) + ' MB only' : '') + ').'
          : 'Read ' + w.name + ' once — this browser cannot keep reading a dropped file; drop it again for what has been added.');
      },
    });
    // The live-surface policy (design-system §4): a stream announces when it
    // starts and stops, never per re-read — the status line under the box
    // updates every tick and is read on demand.
    announce('Watching ' + src.name + ' — decoding as the log grows');
    refresh();
  }

  function stopWatch() {
    const w = state.a2.watch;
    if (!w) return;
    if (w.follower) w.follower.stop();
    state.a2.watch = null;
  }

  // The button's own handler. stopWatch alone left the button still reading
  // "Stop watching …" until something else happened to re-render.
  function stopWatching() {
    const w = state.a2.watch;
    stopWatch();
    state.a2.watchErr = '';
    if (w) announce('Stopped watching ' + w.name);
    refresh();
  }

  // ── export ────────────────────────────────────────────────────────────────────

  function exportRows() {
    const p = current();
    if (!p) return [];
    const res = resolve(p);
    const out = [];
    // The stamp put on the half-day the receiver's clock says it arrived in
    // (placeStamp) — or, where it lands more than ten minutes from that clock
    // on both UTC's half-days and local time's, on the receiver's own half-day,
    // so a clock that is out still dates the readings, and stamp_base says so.
    const when = (f, offset) => {
      if (!f.time) return '';
      const ms = f.time.ms != null ? f.time.ms : f.time.local;
      return isoText(ms - (offset || 0) * 1000);
    };
    const common = f => ({
      format: f.kind === 'bin' ? 'usb-binary' : 'rs232-ascii',
      line: f.lineNo,
      ert_a2_clock: isoText(f.hdr.clockMs),
      stamp_base: f.time ? (f.time.base || 'none') : '',
      decoder: f.hdr.decoder == null ? '' : f.hdr.decoder,
      source: f.hdr.source == null ? '' : f.hdr.source,
      port: f.hdr.port == null ? '' : f.hdr.port,
      hop_limit: f.hdr.hopLimit == null ? '' : f.hdr.hopLimit,
      path: f.hdr.path ? f.hdr.path.join(' ') : '',
      test: f.payload && f.payload.ctl.test ? 'yes' : '',
      rssi_dbm: f.hdr.rssi == null ? '' : f.hdr.rssi,
    });
    const place = (info, st) => ({
      station: st ? st.name : (info && info.fileName && !info.fileName.none ? info.fileName.text : ''),
      station_number: st ? (st.station_number || '') : '',
      lat: st && st.lat != null ? st.lat : '',
      lon: st && st.lon != null ? st.lon : '',
      match: info ? info.conf : 'unknown',
      sensor: info && info.chosen ? info.chosen.types.join(' / ') : '',
    });
    p.frames.forEach(f => {
      if (f.error) return;
      f.records.forEach(r => {
        const info = res.byAlertId.get(r.alertId);
        const st = info && info.chosen ? info.chosen.station : null;
        const eng = engValue(info ? info.kind : null, r.value, st);
        const t = recStamp(f, r);
        out.push(Object.assign({ frame_time: t == null ? '' : readingWhen(f, r.offset).text, stamp_s: t == null ? '' : t,
                                 alert2_datetime: when(f, r.offset) }, common(f), {
          alert_id: r.alertId, a2_sensor: '',
        }, place(info, st), {
          value: r.value,
          engineering: eng ? eng.text : '',
          time_offset_s: r.offset,
          ok: r.ok ? 'yes' : 'no',
          bytes: r.bytes.map(hx).join(' '),
        }));
      });
      f.sensors.forEach(x => {
        const info = res.byA2 ? res.byA2.get(a2Key(x.source, x.sensor)) : null;
        const st = info && info.chosen ? info.chosen.station : null;
        const eng = a2Eng(x, info ? info.kind : null, st);
        const pl = place(info, st);
        if (!pl.sensor && x.name) pl.sensor = x.name;
        out.push(Object.assign({ frame_time: f.payload.stamp == null ? '' : readingWhen(f, 0).text,
                                 stamp_s: f.payload.stamp == null ? '' : f.payload.stamp,
                                 alert2_datetime: when(f, 0) }, common(f), {
          alert_id: '', a2_sensor: x.sensor,
        }, pl, {
          value: x.text != null ? x.text : x.value == null ? '' : x.value,
          engineering: eng ? eng.text : '',
          time_offset_s: '',
          ok: x.ok ? 'yes' : 'no',
          bytes: x.bytes.map(hx).join(' '),
        }));
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
                 frames: p.stats.frames, records: p.stats.records, self_report_values: p.stats.sensors || 0,
                 errors: p.stats.errors,
                 clock_skew_seconds: p.stats.skew, stamp_bases: p.stats.bases,
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
    document.removeEventListener('dragover', dragOver);
    document.removeEventListener('drop', dropFile);
    document.addEventListener('dragover', dragOver);
    document.addEventListener('drop', dropFile);
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
  // The watch, like the capture, carries on — only the page-wide drop guard goes.
  function stop() {
    stopMap();
    document.removeEventListener('dragover', dragOver);
    document.removeEventListener('drop', dropFile);
  }

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
           chooseFile, onFile, watchFile, stopWatch, stopWatching, dragOver, dropFile, exportCsv, exportJson,
           parse, parseAscii, parseBin, decodeRecord,
           // for the Serial Monitor's ERT-A2 card (serial-ert.js), which decodes
           // the same two wire formats as they arrive rather than pasted whole
           parseBinBytes, hexStream, resolve, engValue, stationCell, rssiCell,
           placeStamp, a2Key, a2Eng, a2ValueText, PORT_SELF, PORT_CONC,
           samples: () => ({ ascii: SAMPLE, bin: SAMPLE_BIN }) };
})();

