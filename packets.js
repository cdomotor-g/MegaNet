// MegaNet — packets.js
//
//   Packets   the ALERT / ERTS decoder and encoder behind the ALERT Packets
//             tab, and the shared codec serial.js and alert2.js both call into.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state and esc, and across to app.js for
// stationAlertIds and — from an inline onclick, so at click time — switchTab.
// The IIFE body builds its format tables and calls nothing, so this file's
// position among the modules is free: serial.js and alert2.js hold references to
// Packets, but neither dereferences one until a tab renders, so either may load
// before this file.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── ALERT Packets tab ────────────────────────────────────────────────────────────
// Decoder / encoder for ALERT / ERTS radio telemetry messages, per the Bureau of
// Meteorology "ERTS Data Formats" specification (July 2003). Ported from the
// standalone ALERT_PACKETS tool and integrated as a MegaNet tab. Decoded ALERT
// addresses are cross-referenced against the loaded MegaNet station database first,
// then against the bundled national address file "All 2021 Working 2.txt".

const Packets = (function () {

  // ── core codec ────────────────────────────────────────────────────────────────
  const CRC_POLY = 0x19; // x^6 + x^4 + x^3 + 1

  function bitsMsb(v, n) { const r = []; for (let i = n - 1; i >= 0; i--) r.push((v >> i) & 1); return r; }
  function crc6(bits) {
    let reg = 0;
    for (const b of bits) { const fb = ((reg >> 5) & 1) ^ b; reg = (reg << 1) & 0x3f; if (fb) reg ^= CRC_POLY; }
    return reg;
  }
  function eifCrc(a, d)    { return crc6(bitsMsb(a, 13).concat(bitsMsb(d, 11))); }
  function eafCrc(a, d, b) { return crc6(bitsMsb(a, 12).concat(bitsMsb(d, 11), [b & 1])); }

  function A(i)  { return { f: 'A', i }; }  function D(i) { return { f: 'D', i }; }
  function K(e)  { return { f: 'K', expect: e }; }
  function HD(i) { return { f: 'HD', i }; } function BS(i) { return { f: 'BS', i }; }
  function C(i)  { return { f: 'C', i }; }  function R(i) { return { f: 'R', i }; }
  function S(i)  { return { f: 'S', i }; }
  const B0 = { f: 'B', i: 0 }, VCO = { f: 'VCO', i: 0 }, DE = { f: 'DE', i: 0 };

  const FIELD_META = {
    A:   { label: 'Address (sensor ID)',       cls: 'f-A' },
    D:   { label: 'Data value',                cls: 'f-D' },
    K:   { label: 'Format ID / check bits',    cls: 'f-K' },
    R:   { label: 'FCS (CRC-6)',               cls: 'f-R' },
    C:   { label: 'CRC / wind-gust bits',      cls: 'f-C' },
    B:   { label: 'Battery status bit',        cls: 'f-B' },
    BS:  { label: 'Battery status',            cls: 'f-BS' },
    VCO: { label: 'VCO error flag',            cls: 'f-VCO' },
    DE:  { label: 'Data error flag',           cls: 'f-DE' },
    HD:  { label: 'High data bits (D11–D15)',  cls: 'f-HD' },
    S:   { label: 'Record status byte',        cls: 'f-S' },
    frame: { label: 'Start / stop bits',       cls: 'f-frame' },
  };

  const FORMATS = {
    abf: { key: 'abf', name: 'ALERT Binary Format (ABF)', short: 'ABF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), D(0), D(1), D(2), D(3), D(4), K(1), K(1),
            D(5), D(6), D(7), D(8), D(9), D(10), K(1), K(1)],
      abits: 13, note: 'The standard format used in Australia. No CRC — validity rests on the fixed check bits alone.' },
    bcc: { key: 'bcc', name: 'BCC Extended Check Format', short: 'BCC',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), HD(0), HD(1), HD(2), HD(3), HD(4), K(0), K(1),
            BS(0), BS(1), BS(2), BS(3), VCO, DE, K(0), K(1)],
      abits: 13, note: 'Health/check message sent after a binary check signal. HD carries bits 11–15 of the full 16-bit stored value; BS is battery status; VCO and DE are error flags.' },
    eaf: { key: 'eaf', name: 'Enhanced ALERT Binary Format (EAF)', short: 'EAF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), D(0), D(1),
            D(2), D(3), D(4), D(5), D(6), D(7), D(8), D(9),
            D(10), B0, C(5), C(4), C(3), C(2), C(1), C(0)],
      abits: 12, note: '12-bit address (0–4095), battery bit B, 6 CRC bits. Wind sensors substitute gust data for the CRC. The BoM document does not define the EAF CRC algorithm — the check shown here assumes the same x⁶+x⁴+x³+1 CRC as EIF, computed over address, data and B.' },
    eif: { key: 'eif', name: 'Enhanced IFLOWS Format (EIF)', short: 'EIF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), A(12), D(0),
            D(1), D(2), D(3), D(4), D(5), D(6), D(7), D(8),
            D(9), D(10), R(5), R(4), R(3), R(2), R(1), R(0)],
      abits: 13, note: '13-bit address, 11-bit data, 6-bit FCS (CRC, generator polynomial x⁶+x⁴+x³+1 over address then data, MSB first).' },
    // The one modern format here, and the odd one out. ABF/BCC/EAF/EIF are what a
    // legacy ALERT sensor puts on the air as four 10-bit async words; A2C is how
    // that same 13-bit address and 11-bit value are re-packed as four plain bytes
    // inside an ALERT2 concentration frame, which is what an ELPRO ERT-A2 hands
    // out over RS232. No start/stop bits and no CRC — the ALERT2 MANT layer below
    // it has already checked the frame, so all this carries is a status byte that
    // reads 0 on every good record. Layout mirrors Alert2.decodeRecord(); the two
    // are the same three lines of arithmetic written declaratively and directly.
    a2c: { key: 'a2c', name: 'ALERT2 concentration record (A2C)', short: 'A2C', bytesOnly: true,
      map: [A(7), A(6), A(5), A(4), A(3), A(2), A(1), A(0),
            D(10), D(9), D(8), A(12), A(11), A(10), A(9), A(8),
            D(7), D(6), D(5), D(4), D(3), D(2), D(1), D(0),
            S(7), S(6), S(5), S(4), S(3), S(2), S(1), S(0)],
      validate: v => v.S === 0,
      abits: 13, note: 'One sensor reading inside an ALERT2 “ALERT concentration” payload, as delivered by an ELPRO ERT-A2. Four bytes: address low byte, then a packed byte holding the top 3 data bits and the top 5 address bits, then the data low byte, then a status byte (0 on every valid record observed). Address and data are the same 13 + 11 bits as the legacy formats, so a reading decodes to the same ID and value either way. See the ALERT2 / ERT-A2 tab to decode whole serial lines.' },
  };

  function normaliseInput(raw) {
    let s = String(raw || '').trim().replace(/[\s,_.\-]+/g, '');
    if (/^0x[0-9a-f]+$/i.test(s)) {
      const hex = s.slice(2);
      if (hex.length !== 8) return { ok: false, error: 'Hex input must be exactly 8 hex digits (32 bits).' };
      s = [...hex].map(h => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
    }
    if (!/^[01]+$/.test(s)) return { ok: false, error: 'Input must be a binary string of 0s and 1s (spaces allowed), or hex like 0x07D5F8FE.' };
    if (s.length === 32) return { ok: true, bits32: s, framing: { present: false } };
    if (s.length !== 40) return { ok: false, error: 'Expected 40 bits (framed, 4 × 10-bit words) or 32 bits (payload only) — got ' + s.length + ' bits.' };
    const words = [0, 10, 20, 30].map(i => s.slice(i, i + 10));
    const test = (st, sp) => words.every(w => w[0] === st && w[9] === sp);
    let polarity = null, valid = false;
    if (test('1', '0'))      { polarity = 'negative'; valid = true; }
    else if (test('0', '1')) { polarity = 'standard'; valid = true; }
    const bits32 = words.map(w => w.slice(1, 9)).join('');
    return { ok: true, bits32, bits40: s, framing: { present: true, polarity, valid,
      detail: valid ? (polarity === 'negative' ? 'start = 1, stop = 0 (ALERT negative logic)' : 'start = 0, stop = 1 (standard async)')
                    : 'start/stop bits are inconsistent across the four words — framing ignored, middle 8 bits of each word taken as payload.' } };
  }

  function decodeFormat(fmtKey, bits32) {
    const fmt = FORMATS[fmtKey];
    const vals = {}; let identOk = true; const identErrors = [];
    fmt.map.forEach((cell, pos) => {
      const bit = bits32[pos] === '1' ? 1 : 0;
      if (cell.f === 'K') { if (bit !== cell.expect) { identOk = false; identErrors.push(pos); } }
      else (vals[cell.f] = vals[cell.f] || [])[cell.i] = bit;
    });
    const num = {};
    for (const [f, arr] of Object.entries(vals)) num[f] = arr.reduce((a, b, i) => a + (b << i), 0);
    const out = { format: fmtKey, name: fmt.name, identOk, identErrors, values: num };
    if (fmtKey === 'eif') { out.crcExpected = eifCrc(num.A, num.D);         out.crcOk = out.crcExpected === num.R; }
    if (fmtKey === 'eaf') { out.crcExpected = eafCrc(num.A, num.D, num.B);  out.crcOk = out.crcExpected === num.C; out.crcAssumed = true; }
    if (fmt.validate) out.extraOk = !!fmt.validate(num);
    out.valid = identOk && (out.crcOk !== false) && (out.extraOk !== false);
    return out;
  }

  // A2C is four raw bytes lifted out of an ALERT2 payload, not four async words
  // off the air, so it is only a candidate when the input arrived without
  // start/stop bits — and only when the caller asked for it. The Serial Monitor's
  // alert mode slices the byte stream into fours from wherever reading started,
  // which is the one place an extra always-plausible format would do harm: those
  // groups are not aligned to ALERT2 record boundaries, so any A2C it "found"
  // would be an artefact of where the read began.
  function decodeAll(bits32, opts) {
    const o = opts || {};
    return Object.keys(FORMATS)
      .filter(k => !FORMATS[k].bytesOnly || (o.bytes && !o.framed))
      .map(k => decodeFormat(k, bits32));
  }

  // Public decode helper shared with the Serial Monitor tab. Accepts the same
  // inputs as the decode box (40-bit framed / 32-bit payload binary, or 8-digit
  // hex) and returns the normalised framing, every format's decode and the single
  // unambiguous "best" format (null when zero or several formats pass all checks).
  // Pass { bytes: true } to also consider A2C — for callers that know their four
  // bytes are a record boundary, not an arbitrary slice of a stream.
  function decodeMessage(raw, opts) {
    const n = normaliseInput(raw);
    if (!n.ok) return { ok: false, error: n.error };
    const results = decodeAll(n.bits32, { framed: n.framing.present, bytes: opts && opts.bytes });
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    return { ok: true, framing: n.framing, bits32: n.bits32, results, best };
  }

  function encodeFormat(fmtKey, values, polarity) {
    const fmt = FORMATS[fmtKey];
    const v = Object.assign({}, values);
    const lim = (name, val, bits) => {
      if (val == null || isNaN(val)) throw new Error('Missing value for ' + name + '.');
      if (val < 0 || val > (1 << bits) - 1) throw new Error(name + ' must be 0–' + ((1 << bits) - 1) + ' for this format (got ' + val + ').');
    };
    lim('Sensor ID', v.A, fmt.abits);
    if (fmtKey === 'abf') { lim('Data value', v.D, 11); }
    if (fmtKey === 'bcc') { v.HD = v.HD || 0; v.BS = v.BS || 0; v.VCO = v.VCO ? 1 : 0; v.DE = v.DE ? 1 : 0;
      lim('HD (high data bits)', v.HD, 5); lim('BS (battery status)', v.BS, 4); }
    if (fmtKey === 'eaf') { lim('Data value', v.D, 11); v.B = v.B ? 1 : 0; v.C = eafCrc(v.A, v.D, v.B); }
    if (fmtKey === 'eif') { lim('Data value', v.D, 11); v.R = eifCrc(v.A, v.D); }
    let bits32 = '';
    fmt.map.forEach(cell => { bits32 += cell.f === 'K' ? cell.expect : ((v[cell.f] >> cell.i) & 1); });
    const st = polarity === 'standard' ? '0' : '1', sp = polarity === 'standard' ? '1' : '0';
    let bits40 = '';
    for (let w = 0; w < 4; w++) bits40 += st + bits32.slice(w * 8, w * 8 + 8) + sp;
    const hex = '0x' + parseInt(bits32, 2).toString(16).toUpperCase().padStart(8, '0');
    return { format: fmtKey, values: v, bits32, bits40, hex, polarity: polarity === 'standard' ? 'standard' : 'negative' };
  }

  // ── station name lookup ───────────────────────────────────────────────────────
  // Two sources: the loaded MegaNet database (state.data) takes priority, then the
  // bundled national address file. MegaNet index is cached and rebuilt when the
  // underlying data object changes.
  let fileStations = null;      // Map id -> name from the address file (null until loaded)
  let fileLoading  = false;
  const mnIndex = { src: null, map: null };

  function megaNetName(id) {
    if (!state.data || !Array.isArray(state.data.stations)) return null;
    if (mnIndex.src !== state.data) {
      mnIndex.src = state.data;
      mnIndex.map = new Map();
      state.data.stations.forEach(s => stationAlertIds(s).forEach(aid => {
        if (!mnIndex.map.has(aid)) mnIndex.map.set(aid, s.name);
      }));
    }
    return mnIndex.map.get(id) || null;
  }

  function stationName(id) {
    const mn = megaNetName(id);
    if (mn) return { text: mn, none: false, source: 'meganet' };
    if (fileStations) { const n = fileStations.get(id); if (n) return { text: n, none: false, source: 'file' }; }
    if (fileStations === null && fileLoading) return { text: 'loading…', none: true };
    return { text: 'not found in address file', none: true };
  }

  async function loadStationsFile() {
    if (fileStations !== null || fileLoading) return;
    fileLoading = true;
    try {
      const res = await fetch(encodeURI('data/All 2021 Working 2.txt'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let text;
      if (u8[0] === 0xFF && u8[1] === 0xFE)      text = new TextDecoder('utf-16le').decode(buf);
      else if (u8[0] === 0xFE && u8[1] === 0xFF) text = new TextDecoder('utf-16be').decode(buf);
      else                                        text = new TextDecoder('utf-8').decode(buf);
      text = text.replace(/^﻿/, '');
      fileStations = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(' ')) continue;             // address file rule: data lines start with a space
        const m = line.match(/^\s*(\d+)\s+(.*\S)/);
        if (m && !fileStations.has(+m[1])) fileStations.set(+m[1], m[2]);
      }
    } catch (e) {
      fileStations = new Map();
      fileStations.loadError = e.message;
    } finally {
      fileLoading = false;
      updateStnStatus();
      if (state.activeTab === 'packets') replay();       // re-render results now names are available
    }
  }

  function updateStnStatus() {
    const el = document.getElementById('pkt-stnStatus');
    if (!el) return;
    if (fileStations === null) { el.textContent = fileLoading ? ' Loading ALERT address file…' : ''; return; }
    if (fileStations.loadError)
      el.textContent = ' ALERT address file could not be loaded (' + fileStations.loadError + ') — decoding still works; names come from the MegaNet database only.';
    else
      el.textContent = ' Loaded ' + fileStations.size + ' addresses from the ALERT address file.';
  }

  // ── rendering helpers ─────────────────────────────────────────────────────────
  function bitCells(fmtKey, bits, framed) {
    const map = FORMATS[fmtKey].map;
    const cells = [];
    if (framed) {
      for (let w = 0; w < 4; w++) {
        cells.push({ bit: bits[w * 10], f: 'frame', lbl: 'S' });
        for (let i = 0; i < 8; i++) {
          const cell = map[w * 8 + i];
          cells.push({ bit: bits[w * 10 + 1 + i], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
        }
        cells.push({ bit: bits[w * 10 + 9], f: 'frame', lbl: 'E' });
      }
    } else {
      for (let p = 0; p < 32; p++) {
        const cell = map[p];
        cells.push({ bit: bits[p], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
      }
    }
    return cells;
  }

  function renderBitMap(fmtKey, bits, framed, identErrors, uid) {
    const cells = bitCells(fmtKey, bits, framed);
    const per = framed ? 10 : 8;
    const unit = FORMATS[fmtKey].bytesOnly ? 'Byte ' : 'Word ';
    let html = '<div class="bitwords" data-uid="' + uid + '">';
    for (let w = 0; w < 4; w++) {
      html += '<div class="bitword"><div class="wlabel">' + unit + (w + 1) + '</div><div class="bitrow">';
      let lbls = '';
      for (let i = 0; i < per; i++) {
        const c = cells[w * per + i];
        const payloadPos = framed ? (w * 8 + i - 1) : (w * 8 + i);
        const bad = c.f === 'K' && identErrors && identErrors.includes(payloadPos);
        html += '<div class="bit ' + FIELD_META[c.f].cls + (bad ? ' kbad' : '') + '" data-f="' + c.f + '" title="' + esc(FIELD_META[c.f].label + (c.cell && c.cell.i !== undefined ? ' — bit ' + c.cell.i : '')) + '">' + c.bit + '</div>';
        lbls += '<span>' + c.lbl + '</span>';
      }
      html += '</div><div class="lblrow">' + lbls + '</div></div>';
    }
    html += '</div>';
    return html;
  }

  const SWATCH = { A: 'addr', D: 'data', K: 'ident', R: 'crc', C: 'crc', B: 'batt', BS: 'batt', VCO: 'batt', DE: 'batt', HD: 'hd', S: 'status', frame: 'frame' };

  function legendHtml(fields) {
    return '<div class="legend">' + fields.map(f => '<span><i style="background:var(--c-' + SWATCH[f] + ')"></i>' + esc(FIELD_META[f].label) + '</span>').join('') + '</div>';
  }

  function fieldRows(fmtKey, dec) {
    const fmt = FORMATS[fmtKey];
    const rows = [];
    const positions = {};
    fmt.map.forEach((c, p) => { if (c.f !== 'K') { (positions[c.f] = positions[c.f] || []).push(p); } });
    const order = ['A', 'D', 'HD', 'BS', 'B', 'VCO', 'DE', 'R', 'C', 'S'];
    for (const f of order) {
      if (!(f in dec.values)) continue;
      const nbits = positions[f].length;
      const v = dec.values[f];
      const binMsb = v.toString(2).padStart(nbits, '0');
      let extra = '';
      if (f === 'A') {
        const s = stationName(v);
        extra = '<div>Station name: <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
              + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '') + '</div>';
      }
      if (f === 'HD') extra = '<div class="spec">Full 16-bit value = HD × 2048 + last transmitted 11-bit data value = ' + (v * 2048) + ' + data.</div>';
      if (f === 'S') extra = '<div class="spec">' + (v === 0
        ? '<span style="color:var(--ok)">0 — the value every valid record carries ✓</span>'
        : '<span style="color:var(--bad)">non-zero ✗</span> — records with a non-zero status byte in the reference capture also carried addresses matching no station, so treat the reading as corrupt.') + '</div>';
      if ((f === 'R' || f === 'C') && dec.crcExpected !== undefined) {
        extra = '<div class="spec">Computed ' + (f === 'R' ? 'FCS' : 'CRC') + ': ' + dec.crcExpected + ' — '
          + (dec.crcOk ? '<span style="color:var(--ok)">matches ✓</span>' : '<span style="color:var(--bad)">mismatch ✗</span>')
          + (dec.crcAssumed ? ' (algorithm assumed, see note below; for wind sensors these bits are gust data instead)' : '') + '</div>';
      }
      rows.push('<tr class="frow" data-f="' + f + '">'
        + '<td><span class="swatch" style="background:var(--c-' + SWATCH[f] + ')"></span>' + esc(FIELD_META[f].label) + '</td>'
        + '<td><code>' + binMsb + '</code><div class="spec">' + nbits + ' bit' + (nbits > 1 ? 's' : '') + ', sent ' + ((f === 'R' || f === 'C') ? 'MSB' : 'LSB') + ' first</div></td>'
        + '<td><span class="val">' + v + '</span>' + extra + '</td></tr>');
    }
    return '<table class="fields"><thead><tr><th>FIELD</th><th>BITS (MSB→LSB)</th><th>VALUE</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function attachHover(container) {
    container.querySelectorAll('tr.frow').forEach(tr => {
      const f = tr.dataset.f;
      const card = tr.closest('.fmtbody, .encout') || container;
      tr.addEventListener('mouseenter', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.add('hl')));
      tr.addEventListener('mouseleave', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.remove('hl')));
    });
  }

  // ── decoder ───────────────────────────────────────────────────────────────────
  function doDecode(input, scroll) {
    const errEl = document.getElementById('pkt-decError');
    const frEl  = document.getElementById('pkt-decFraming');
    const resEl = document.getElementById('pkt-decResults');
    if (!resEl) return;
    state.pkt.decInput = input;
    state.pkt.lastDecode = input;
    errEl.hidden = true; frEl.hidden = true; resEl.innerHTML = '';
    const n = normaliseInput(input);
    if (!n.ok) { errEl.textContent = n.error; errEl.hidden = false; return; }
    if (n.framing.present) {
      frEl.innerHTML = 'Framing: ' + (n.framing.valid ? '<b style="color:var(--ok)">valid</b> — ' : '<b style="color:var(--warn)">inconsistent</b> — ') + esc(n.framing.detail)
        + '. Payload (32 bits): <code>' + n.bits32 + '</code>';
    } else {
      frEl.innerHTML = '32-bit payload supplied (no start/stop bits).';
    }
    frEl.hidden = false;
    const results = decodeAll(n.bits32, { framed: n.framing.present, bytes: true });
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    const ordered = [...results].sort((a, b) => (b.valid ? 1 : 0) - (a.valid ? 1 : 0));
    ordered.forEach(r => {
      const fmt = FORMATS[r.format];
      const badges = [];
      // A2C has no check bits to pass or fail — its integrity claim is the status
      // byte, so it says that instead of a "check bits ✓" it never earned.
      if (r.extraOk !== undefined)
        badges.push(r.extraOk ? '<span class="badge ok">status byte 0 ✓</span>' : '<span class="badge bad">status byte non-zero ✗</span>');
      else
        badges.push(r.identOk ? '<span class="badge ok">check bits ✓</span>' : '<span class="badge bad">check bits ✗</span>');
      if (r.crcOk !== undefined) badges.push(r.crcOk ? '<span class="badge ok">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✓</span>'
                                                     : '<span class="badge ' + (r.crcAssumed ? 'warn' : 'bad') + '">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✗</span>');
      if (r.format === best) badges.unshift('<span class="badge ok">BEST MATCH</span>');
      const open = r.valid || validOnes.length === 0;
      const s = stationName(r.values.A);
      const summary = r.valid
        ? 'ID ' + r.values.A + (r.values.D !== undefined ? ' · value ' + r.values.D : '') + ' · ' + esc(s.text)
        : 'not a valid ' + fmt.short + ' message';
      let body = '';
      body += renderBitMap(r.format, n.framing.present ? n.bits40 : n.bits32, n.framing.present, r.identErrors, 'dec-' + r.format);
      const legendFields = [...new Set(fmt.map.map(c => c.f))]; if (n.framing.present) legendFields.push('frame');
      body += legendHtml(legendFields);
      body += fieldRows(r.format, r);
      body += '<p class="spec">' + esc(fmt.note) + '</p>';
      if (r.format !== 'bcc' && !fmt.bytesOnly && r.values.A !== undefined && r.values.D !== undefined)
        body += '<button class="ghost" onclick="Packets.prefillEncoder(\'' + r.format + '\',' + r.values.A + ',' + r.values.D + ')">Open in encoder</button>';
      if (fmt.bytesOnly)
        body += '<button class="ghost" onclick="switchTab(\'alert2\')">Decode a whole ERT-A2 line ▸</button>';
      resEl.insertAdjacentHTML('beforeend',
        '<div class="fmtcard' + (r.format === best ? ' best' : '') + (open ? ' open' : '') + '" id="pkt-card-' + r.format + '">'
        + '<div class="fmthead" onclick="this.parentElement.classList.toggle(\'open\')">'
        + '<h3>' + esc(fmt.name) + '</h3>' + badges.join(' ')
        + '<span class="caret">' + esc(summary) + ' ▾</span></div>'
        + '<div class="fmtbody">' + body + '</div></div>');
    });
    attachHover(resEl);
    if (scroll) resEl.scrollIntoView({ behavior: 'smooth' });
  }

  // ── encoder ───────────────────────────────────────────────────────────────────
  const ENC_EXTRAS = {
    abf: [], eif: [],
    eaf: [{ id: 'pkt-encB', key: 'b', label: 'Battery bit B (0 = good)', type: 'select01' }],
    bcc: [{ id: 'pkt-encHD', key: 'hd', label: 'HD — high data bits (0–31)', type: 'num', max: 31 },
          { id: 'pkt-encBS', key: 'bs', label: 'BS — battery status (0–15)', type: 'num', max: 15 },
          { id: 'pkt-encVCO', key: 'vco', label: 'VCO error flag', type: 'select01' },
          { id: 'pkt-encDE',  key: 'de',  label: 'DE data error flag', type: 'select01' }],
  };

  function encExtrasHtml(fmt) {
    const e = state.pkt.enc;
    return ENC_EXTRAS[fmt].map(x => {
      if (x.type === 'num')
        return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
          + '<input type="number" id="' + x.id + '" min="0" max="' + x.max + '" value="' + (e[x.key] || 0) + '"'
          + ' oninput="Packets.setEnc(\'' + x.key + '\',this.value)"></div>';
      const v = e[x.key] ? 1 : 0;
      return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
        + '<select id="' + x.id + '" onchange="Packets.setEnc(\'' + x.key + '\',this.value)">'
        + '<option value="0"' + (v === 0 ? ' selected' : '') + '>0</option>'
        + '<option value="1"' + (v === 1 ? ' selected' : '') + '>1</option></select></div>';
    }).join('');
  }

  function refreshStation() {
    const el = document.getElementById('pkt-encStation');
    if (!el) return;
    const id = parseInt(state.pkt.enc.id, 10);
    if (isNaN(id)) { el.textContent = ''; return; }
    const s = stationName(id);
    el.innerHTML = 'Station name for ID ' + id + ': <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
      + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '');
  }

  function onFormatChange(fmt) {
    state.pkt.enc.format = fmt;
    const wrap = document.getElementById('pkt-encExtras');
    if (wrap) wrap.innerHTML = encExtrasHtml(fmt);
    const dataWrap = document.getElementById('pkt-encDataWrap');
    if (dataWrap) dataWrap.style.display = fmt === 'bcc' ? 'none' : '';
    const idInput = document.getElementById('pkt-encId');
    if (idInput) idInput.max = (1 << FORMATS[fmt].abits) - 1;
    refreshStation();
  }

  function setEnc(key, val) {
    const num = ['id', 'data', 'hd', 'bs', 'vco', 'de', 'b'];
    state.pkt.enc[key] = num.includes(key) ? (parseInt(val, 10) || 0) : val;
    if (key === 'id') refreshStation();
  }

  function doEncode() {
    const errEl = document.getElementById('pkt-encError');
    const resEl = document.getElementById('pkt-encResult');
    if (!resEl) return;
    state.pkt.lastEncode = true;
    errEl.hidden = true; resEl.innerHTML = '';
    const e = state.pkt.enc;
    const fmt = e.format, polarity = e.polarity;
    const values = { A: parseInt(e.id, 10) };
    if (fmt !== 'bcc') values.D = parseInt(e.data, 10);
    if (fmt === 'eaf') values.B = e.b || 0;
    if (fmt === 'bcc') { values.HD = e.hd || 0; values.BS = e.bs || 0; values.VCO = e.vco || 0; values.DE = e.de || 0; }
    let enc;
    try { enc = encodeFormat(fmt, values, polarity); }
    catch (err) { errEl.textContent = err.message; errEl.hidden = false; return; }
    const dec = decodeFormat(fmt, enc.bits32);
    let html = '<div class="encout">';
    html += '<div class="outbits">40-bit framed:&nbsp; <b id="pkt-enc40">' + enc.bits40 + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc40\',this)">copy</button></div>';
    html += '<div class="outbits">32-bit payload: <b id="pkt-enc32">' + enc.bits32 + '</b> &nbsp;·&nbsp; hex <b>' + enc.hex + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc32\',this)">copy</button></div>';
    html += renderBitMap(fmt, enc.bits40, true, [], 'enc');
    const legendFields = [...new Set(FORMATS[fmt].map.map(c => c.f))]; legendFields.push('frame');
    html += legendHtml(legendFields);
    html += fieldRows(fmt, dec);
    html += '<p class="spec">' + esc(FORMATS[fmt].note) + '</p></div>';
    resEl.innerHTML = html;
    attachHover(resEl);
  }

  function copyTxt(id, btn) {
    const el = document.getElementById(id);
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      btn.textContent = 'copied ✓'; setTimeout(() => btn.textContent = 'copy', 1200);
    });
  }

  function prefillEncoder(fmt, idv, dv) {
    state.pkt.enc.format = fmt;
    state.pkt.enc.id = idv;
    state.pkt.enc.data = dv;
    const fmtEl = document.getElementById('pkt-encFormat'); if (fmtEl) fmtEl.value = fmt;
    const idEl = document.getElementById('pkt-encId');   if (idEl) idEl.value = idv;
    onFormatChange(fmt);
    const dEl = document.getElementById('pkt-encData');  if (dEl) dEl.value = dv;
    doEncode();
    const sec = document.getElementById('pkt-encodeSection');
    if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  }

  // ── public: read the decode input box and decode / example ────────────────────
  const EXAMPLE = '1000001110111010101011111100001111111100';
  function decode()      { const el = document.getElementById('pkt-decInput'); if (el) doDecode(el.value, false); }
  function loadExample() { const el = document.getElementById('pkt-decInput'); if (el) { el.value = EXAMPLE; doDecode(EXAMPLE, false); } }
  function encode()      { doEncode(); }

  function replay() {
    if (state.pkt.lastDecode != null) doDecode(state.pkt.lastDecode, false);
    if (state.pkt.lastEncode)         doEncode();
  }

  // ── tab render + init ─────────────────────────────────────────────────────────
  function render() {
    const e = state.pkt.enc;
    const fmt = e.format;
    const abits = FORMATS[fmt].abits;
    return `
    <div class="pkt" style="max-width:1280px;margin:auto;padding:1rem;display:grid;gap:1rem">

      <div class="panel">
        <div class="panel-header"><h2>ALERT / ERTS Packet Tool</h2></div>
        <p class="sub">Decode and encode event-reporting radio telemetry (ALERT) messages per the Bureau of
          Meteorology <em>ERTS Data Formats</em> specification (July 2003) — ALERT Binary (ABF), BCC Extended
          Check, Enhanced ALERT Binary (EAF) and Enhanced IFLOWS (EIF). Decoded addresses are matched against
          the loaded MegaNet station database first, then the bundled national address file.</p>
        <p class="sub" style="margin-top:-.4rem">A fifth layout, <b>A2C</b>, joins them for 32-bit input: the
          four-byte form the same address and value take inside an ALERT2 “ALERT concentration” payload, which
          is what an ELPRO ERT-A2 puts on RS232. Paste whole serial lines on the
          <a href="javascript:void 0" onclick="switchTab('alert2')">ALERT2 / ERT-A2</a> tab instead — this page
          decodes one reading at a time.</p>
      </div>

      <div class="panel" id="pkt-decodeSection">
        <div class="panel-header"><h3>Decode a message</h3></div>
        <p class="sub">Paste a binary string — 40 bits (four 10-bit words including start/stop bits) or 32 bits
          (payload only). Hex like <code>0x07D5F8FE</code> also works. The message is decoded against every
          known format; the one that passes all checks is highlighted.</p>
        <div class="row">
          <div class="grow2">
            <label for="pkt-decInput">Binary message</label>
            <input type="text" id="pkt-decInput" spellcheck="false" value="${esc(state.pkt.decInput)}"
                   oninput="state.pkt.decInput=this.value"
                   onkeydown="if(event.key==='Enter')Packets.decode()"
                   placeholder="e.g. 1000001110111010101011111100001111111100">
          </div>
          <div class="fit"><button class="primary" onclick="Packets.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Packets.loadExample()">Load example</button></div>
        </div>
        <div id="pkt-decError" class="err" hidden></div>
        <div id="pkt-decFraming" class="framing-note" hidden></div>
        <div id="pkt-decResults"></div>
      </div>

      <div class="panel" id="pkt-encodeSection">
        <div class="panel-header"><h3>Encode a message</h3></div>
        <p class="sub">Pick a format, enter the sensor ID and raw value(s), and get the binary message back.
          CRC / FCS bits are computed automatically. The bit map shows exactly where each value lands.</p>
        <div class="row">
          <div>
            <label for="pkt-encFormat">Format</label>
            <select id="pkt-encFormat" onchange="Packets.onFormatChange(this.value)">
              <option value="abf"${fmt === 'abf' ? ' selected' : ''}>ABF — ALERT Binary</option>
              <option value="bcc"${fmt === 'bcc' ? ' selected' : ''}>BCC — Extended Check</option>
              <option value="eaf"${fmt === 'eaf' ? ' selected' : ''}>EAF — Enhanced ALERT Binary</option>
              <option value="eif"${fmt === 'eif' ? ' selected' : ''}>EIF — Enhanced IFLOWS</option>
            </select>
          </div>
          <div>
            <label for="pkt-encId">Sensor ID (address)</label>
            <input type="number" id="pkt-encId" min="0" max="${(1 << abits) - 1}" value="${esc(e.id)}"
                   oninput="Packets.setEnc('id',this.value)">
          </div>
          <div id="pkt-encDataWrap" style="display:${fmt === 'bcc' ? 'none' : ''}">
            <label for="pkt-encData">Data value</label>
            <input type="number" id="pkt-encData" min="0" max="2047" value="${esc(e.data)}"
                   oninput="Packets.setEnc('data',this.value)">
          </div>
          <div>
            <label for="pkt-encPolarity">Framing (start/stop bits)</label>
            <select id="pkt-encPolarity" onchange="Packets.setEnc('polarity',this.value)">
              <option value="negative"${e.polarity !== 'standard' ? ' selected' : ''}>ALERT negative logic — start=1, stop=0</option>
              <option value="standard"${e.polarity === 'standard' ? ' selected' : ''}>Standard async — start=0, stop=1</option>
            </select>
          </div>
        </div>
        <div class="row" id="pkt-encExtras" style="margin-top:10px">${encExtrasHtml(fmt)}</div>
        <div class="note compact" id="pkt-encStation" style="margin-top:.75rem"></div>
        <div class="row" style="margin-top:14px">
          <div class="fit"><button class="primary" onclick="Packets.encode()">Encode</button></div>
        </div>
        <div id="pkt-encError" class="err" hidden></div>
        <div id="pkt-encResult"></div>
      </div>

      <div class="panel">
        <details>
          <summary class="pkt-summary">Format cheat-sheet</summary>
          <ul class="pkt-cheat">
            <li><b>ABF</b> — 13-bit address, 11-bit data. Words 1–2 carry check bits <code>10</code>, words 3–4 carry <code>11</code>.</li>
            <li><b>BCC Extended Check</b> — follow-up health message: 13-bit address, 5 high data bits (HD), 4 battery status bits (BS), VCO and DE error flags. Words 3–4 carry check bits <code>01</code>.</li>
            <li><b>EAF</b> — 12-bit address, 11-bit data, battery bit B, 6 CRC bits (wind sensors substitute gust data for the CRC). Abandoned in practice.</li>
            <li><b>EIF</b> — 13-bit address, 11-bit data, 6-bit FCS. FCS is a CRC with generator polynomial x⁶+x⁴+x³+1 over the 24 address+data bits (address then data, MSB first).</li>
            <li>All fields are transmitted least-significant bit first; each 10-bit word is start bit + 8 payload bits + stop bit.</li>
            <li><b>A2C</b> — ALERT2 concentration record, the modern carrier for the same reading. Four bytes,
              no framing and no CRC: address low byte, a packed byte of <code>DDD AAAAA</code> (data bits 10–8,
              address bits 12–8), the data low byte, then a status byte that is 0 on every valid record. Offered
              only for 32-bit input, since these bytes come out of an ALERT2 payload rather than off the air as
              async words. An ERT-A2 concatenates several of them behind a three-byte header —
              see the <a href="javascript:void 0" onclick="switchTab('alert2')">ALERT2 / ERT-A2</a> tab.</li>
          </ul>
        </details>
        <p class="spec" style="margin-top:.75rem">
          Bit-field layouts from BoM <em>ERTS Data Formats</em> v1.0 (July 2003) —
          <a href="${encodeURI('docs/BOM spec erts_data_formats_doc.pdf')}" target="_blank" rel="noopener">specification PDF</a>.
          Station names from <a href="${encodeURI('data/All 2021 Working 2.txt')}" target="_blank" rel="noopener">All 2021 Working 2.txt</a>.
          <span id="pkt-stnStatus" class="small"></span>
        </p>
      </div>

    </div>`;
  }

  function init() {
    refreshStation();
    updateStnStatus();
    loadStationsFile();   // no-op if already loaded/loading
    replay();             // restore any previous decode/encode results
  }

  return { render, init, decode, encode, loadExample, onFormatChange, setEnc, copyTxt, prefillEncoder,
           decodeMessage, stationName, loadStationsFile };
})();

