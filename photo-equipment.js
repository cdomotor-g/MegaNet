// MegaNet — photo-equipment.js
//
//   PhotoEquipment   what the labels in a field photo say is fitted at the
//                    station: the make, the model and the serial number of
//                    each piece of equipment the OCR could read, and which
//                    kind of equipment the register files it under.
//
// After core.js, before field-photos.js and photo-review.js, which call it —
// index.html holds the order and the reasons. Pure: text in, candidates out.
// No page, no `state`, no network, and no OCR of its own — the text comes
// from PhotoMeta.ocrLabels(), which reads the whole frame for it. The IIFE
// body only declares, so its position among the modules is free
// (`npm run toplevel`), and test/photoreview.mjs require()s this same file
// under Node through the `module.exports` at the foot — as a sync or an agent
// reading photos on a server one day will, so that a label is read by one set
// of rules whichever door the photo came in by.
//
// ── What it is for, and what it is not ───────────────────────────────────────
//
// Every candidate this returns is a *suggestion*. The tab sends it to
// meganet.propose_equipment() and an administrator approves or corrects it
// before the station's register believes it (0036's head says why). So the
// job here is to be useful to that person — right often enough to save typing,
// and honest about how sure it is — not to be right on its own. A candidate
// carries the lines it was read from, so the person deciding sees what the
// OCR saw.
//
// ── How a label is read ──────────────────────────────────────────────────────
//
//   * A dictionary of what this network actually fits (digital-twin.js's
//     "station as built" has the same list): ELPRO's ERRTS ERT-A2 and the
//     115E / 215U / 415U / 905U radios, Campbell Scientific's CR300 family,
//     Beam's Iridium SBD modems, Kisters' HS40 bubblers, Victron's SmartSolar
//     and BlueSolar MPPT regulators, Hydrological Services' TB3/TB4 tipping
//     buckets, and the level sensors — OTT, VEGA, Druck, WaterLOG. A model
//     code implies its make; a make with no model is weaker evidence.
//   * The OCR's usual confusions undone the way photo-meta.js undoes them on
//     an overlay, but from the other side: rather than rewriting the text,
//     each model code is matched with every character allowed its lookalikes
//     — 0/O/Q/D, 1/I/L/|, 5/S, 8/B, 2/Z, 6/G, U/V, E/F — so `CR3OO` is a
//     CR300 and `9O5U` a 905U. A match that needed a lookalike is trusted
//     less, and one that needed more than one stands only with its make, or
//     a word saying what it is, on the label beside it: a string of lookalikes
//     alone is as likely to be bark.
//   * A serial number is what follows a label — `S/N`, `SN`, `Serial No`,
//     `SER NO`, `Serial Number`, `IMEI` — on the same line or the next, with
//     the OCR's `S|N`, `SIN` and `5/N` read as `S/N` too. Where a make's
//     serials have a known shape (Campbell's and ELPRO's are digits, Victron's
//     `HQ` and four digits and five more, an Iridium modem's IMEI fifteen
//     digits) the lookalike letters in it are put back to digits, and a serial
//     of that shape counts for more.
//   * Each serial goes with the nearest model or make, from a line above to
//     three below — a label prints the serial under the model — and a serial
//     beside nothing but a word like `TIPPING BUCKET` or `CHARGE CONTROLLER`
//     is filed under that kind, with no make or model and a low confidence.
//   * Several readings (a whole-frame pass and four tiles) are pooled: the
//     same unit read twice is one candidate that counts for more; one read
//     with its model in one tile and only its make in another is one unit;
//     the same model read with two serials a character or two apart is one
//     unit whose serial the majority chose, the other named in the evidence.
//     Two of one model with serials further apart than that are two units.
//
// Confidence is a number from 0 to 1 that ranks candidates against each other
// — a model code read cleanly, with its make on the same label and a serial of
// the right shape under it, is about 0.9; a serial beside a generic word is
// about 0.35. It is not a probability, and nothing is decided by it: the
// administrator decides.

const PhotoEquipment = (function () {

  // What OCR writes for each character of a model code.
  const LOOKS = {
    '0': '0OQD', O: 'O0QD', Q: 'Q0O', D: 'D0O',
    '1': '1IL|!', I: 'I1L|!', L: 'L1I|',
    '5': '5S$', S: 'S5$', '8': '8B', B: 'B8', '2': '2Z', Z: 'Z2', '6': '6G', G: 'G6',
    U: 'UV', V: 'VU', E: 'EF', F: 'FE', C: 'C(',
  };
  // …and what each lookalike stands for in a serial that has to be digits.
  const DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '!': '1', S: '5', $: '5', B: '8', Z: '2', G: '6', T: '7' };

  const esc = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const bare = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // A model code as a pattern: each letter and digit with its lookalikes, a
  // space as an optional space, a hyphen as an optional hyphen or space, a
  // slash as whatever OCR makes of one. Bounded before by anything but a
  // letter or a digit, and after too unless `open` — so CR1000 is not found
  // inside CR1000X, and HS40 can go on to be an HS40 Compact.
  function fuzzy(canon, open) {
    let src = '';
    for (const ch of canon.toUpperCase()) {
      if (ch === ' ') src += '\\s?';
      else if (ch === '-') src += '[-\\s]?';
      else if (ch === '/') src += '\\s?[\\/|IL1]\\s?';
      else if (LOOKS[ch]) src += `[${esc(LOOKS[ch])}]`;
      else src += esc(ch);
    }
    return `(?<![A-Z0-9])${src}${open ? '' : '(?![A-Z0-9])'}`;
  }
  // How many characters of what was read are lookalikes of the code rather
  // than the code — and Infinity for a reading of another length.
  function lookalikes(read, canon) {
    const a = bare(read), b = bare(canon);
    if (a.length !== b.length) return Infinity;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  // ── The dictionary ─────────────────────────────────────────────────────────
  // `kind` is a meganet.equipment_kind key (0009); a model's own kind wins over
  // its make's. `re` is a pattern of its own where the canonical code is not
  // the whole story (a Victron MPPT's rating, a tipping bucket's tip size),
  // and `name(m)` says what to call what it matched. `needs: true` is a code
  // too short or too common to trust without its make on the label;
  // `needs: 'rain'` settles for a word about rain.
  const SOLAR = 'S[O0Q]LAR';
  const MAKES = [
    {
      make: 'ELPRO', kind: 'modem', re: '(?<![A-Z])(?:[E3F]LPR[O0Q]|ERRTS)(?![A-Z])',
      serial: 'digits',
      models: [
        { model: 'ERT-A2', kind: 'ert_a2' },
        { model: '105U' }, { model: '115E' }, { model: '215U' }, { model: '225U' },
        { model: '415U' }, { model: '505U' }, { model: '805U' }, { model: '905U' },
      ],
    },
    {
      make: 'Campbell Scientific', kind: 'logger', re: 'CAMPB[E3]LL(?:\\s*SCI[E3]NTIFIC)?',
      serial: 'digits',
      models: [
        { model: 'CR1000X' }, { model: 'CR1000' }, { model: 'CR3000' }, { model: 'CR200X' },
        { model: 'CR300' }, { model: 'CR310' }, { model: 'CR350' }, { model: 'CR800' }, { model: 'CR850' },
        { model: 'CR6', needs: true },
      ],
    },
    {
      make: 'Beam', kind: 'modem', re: '(?<![A-Z])B[E3]AM(?:\\s*COMMUNICATIONS)?(?![A-Z])',
      serial: 'imei',
      // A Beam modem's label names the network more often than a model code:
      // with no RST number on it, it is an Iridium SBD modem.
      bareModel: t => (/IRIDIUM|\bSBD\b/.test(t) ? 'Iridium SBD' : ''),
      models: [
        { re: '(?<![A-Z0-9])RST\\s?(\\d{3}[A-Z]?)(?![A-Z0-9])', name: m => `RST${m[1]}` },
      ],
    },
    {
      make: 'Kisters', kind: 'bubble_unit', re: 'KI[S5]T[E3]R[S5]',
      models: [
        { re: `${fuzzy('HS40', true)}\\s*C(?:OMPACT)?(?![A-Z0-9])`, name: () => 'HS40 Compact', canon: 'HS40C' },
        { model: 'HS40' },
      ],
    },
    {
      make: 'Victron Energy', kind: 'solar_regulator', re: 'VICTR[O0]N(?:\\s*[E3]N[E3]RGY)?',
      serial: 'victron',
      models: [
        { re: `(SMART|BLUE)\\s*${SOLAR}(?:\\s*CHARGE\\s*CONTROLL?ER)?\\s*MPPT\\s*(\\d{2,3})\\s*[\\/|IL1]\\s*(\\d{2,3})`,
          name: m => `${m[1] === 'SMART' ? 'SmartSolar' : 'BlueSolar'} MPPT ${m[2]}/${m[3]}` },
        { re: `(SMART|BLUE)\\s*${SOLAR}\\s*PWM`, name: m => `${m[1] === 'SMART' ? 'SmartSolar' : 'BlueSolar'} PWM` },
        { re: 'BLUE\\s*SMART\\s*(?:IP\\d{2}\\s*)?CHARGER', name: () => 'Blue Smart charger', kind: 'power_supply' },
        { re: 'PH[O0]ENIX\\s*(?:INVERTER|CHARGER)', name: () => 'Phoenix', kind: 'power_supply' },
      ],
    },
    {
      make: 'Hydrological Services', kind: 'tbrg', re: 'HYDR[O0]L[O0]GICAL\\s*S[E3]RVIC[E3]S',
      models: [
        { re: '(?<![A-Z0-9])TB\\s?([345])(?:\\s*[\\/-]?\\s*(0?[.,]\\d{1,2}|1(?:[.,]0)?)\\s*MM)?(?![A-Z0-9])',
          name: m => `TB${m[1]}${m[2] ? ` ${m[2].replace(',', '.').replace(/^\./, '0.')} mm` : ''}`, needs: 'rain' },
      ],
    },
    {
      make: 'OTT HydroMet', kind: 'water_level_sensor', re: '(?<![A-Z])[O0]TT(?:\\s*HYDR[O0]\\s*MET)?(?![A-Z])',
      models: [
        { model: 'PLS-C', kind: 'pressure_transmitter', needs: true },
        { model: 'PLS-L', kind: 'pressure_transmitter', needs: true },
        { model: 'PLS', kind: 'pressure_transmitter', needs: true },
        { model: 'RLS', kind: 'water_level_sensor', needs: true },
        { model: 'CBS', kind: 'bubble_unit', needs: true },
        { model: 'SVR', kind: 'river_sensor', needs: true },
        { re: '[E3]C[O0]\\s*L[O0]G\\s*(\\d{3,4})?', name: m => `ecoLog${m[1] ? ` ${m[1]}` : ''}`, kind: 'logger' },
        { re: 'N[E3]TDL', name: () => 'netDL', kind: 'logger' },
        { re: 'THALIM[E3]D[E3]S', name: () => 'Thalimedes', kind: 'shaft_encoder' },
      ],
    },
    {
      make: 'VEGA', kind: 'water_level_sensor', re: '(?<![A-Z])V[E3]GA(?=\\s?PULS|\\s?BAR|\\s|$)',
      models: [
        { re: 'V[E3]GA\\s?PULS\\s*((?:WL\\s*|C\\s*)?\\d{2})', name: m => `VEGAPULS ${m[1].replace(/\s+/g, ' ')}` },
        { re: 'V[E3]GA\\s?BAR\\s*(\\d{2})', name: m => `VEGABAR ${m[1]}`, kind: 'pressure_transmitter' },
      ],
    },
    {
      make: 'Druck', kind: 'pressure_transmitter', re: '(?:GE\\s*)?DRUCK|BAKER\\s*HUGHES',
      models: [
        { re: '(?<![A-Z0-9])(PTX|PDCR|PMP)\\s?-?\\s?(\\d{4})(?![0-9])', name: m => `${m[1]} ${m[2]}` },
        { re: 'UNIK\\s*5000', name: () => 'UNIK 5000' },
      ],
    },
    {
      make: 'WaterLOG', kind: 'water_level_sensor', re: 'WAT[E3]R\\s?L[O0]G',
      models: [
        { re: '(?<![A-Z0-9])H\\s?-\\s?(\\d{3,4}[A-Z]?)(?![A-Z0-9])', name: m => `H-${m[1]}`, needs: true, byWord: true },
      ],
    },
  ];

  // Words that say what a thing is when no make or model does.
  const KINDS = [
    { kind: 'tbrg',                 re: /TIPPING\s*BUCKET|RAIN\s*GAUGE|RAINGAUGE|PLUVIOMETER/g },
    { kind: 'bubble_unit',          re: /BUBBLER|GAS\s*PURGE/g },
    { kind: 'pressure_transmitter', re: /PRESSURE\s*(?:TRANSMITTER|TRANSDUCER|SENSOR)/g },
    { kind: 'shaft_encoder',        re: /SHAFT\s*ENCODER/g },
    { kind: 'water_level_sensor',   re: /RADAR\s*(?:LEVEL|SENSOR)|LEVEL\s*SENSOR|WATER\s*LEVEL/g },
    { kind: 'solar_regulator',      re: /CHARGE\s*CONTROLL?ER|SOLAR\s*REGULATOR|\bMPPT\b/g },
    { kind: 'solar_panel',          re: /SOLAR\s*(?:PANEL|MODULE)|PV\s*MODULE|PHOTOVOLTAIC/g },
    { kind: 'power_supply',         re: /POWER\s*SUPPLY|BATTERY\s*CHARGER|\bBATTERY\b|\b12\s?V\s*\d{2,3}\s?AH\b/g },
    { kind: 'antenna',              re: /\bANTENNA\b|\bYAGI\b/g },
    { kind: 'modem',                re: /\bMODEM\b|\bIRIDIUM\b|\bSBD\b/g },
    { kind: 'logger',               re: /DATA\s*LOGGER|DATALOGGER/g },
  ];
  // The words a WaterLOG H-number is filed by.
  const WATERLOG_BY_WORD = [
    [/BUBBLER|GAS\s*(?:PURGE|SYSTEM)/, 'bubble_unit'], [/ENCODER/, 'shaft_encoder'], [/RADAR/, 'water_level_sensor'],
  ];
  const RAIN_WORDS = /RAIN|GAUGE|TIPPING|BUCKET/;

  // A serial's label, then the serial: letters and digits, with the hyphens
  // and slashes some makes put in them, four to twenty-six long.
  const SERIAL_RE = new RegExp(
    '(?<![A-Z0-9])(IMEI|ESN|S\\s?[\\/|\\\\]\\s?N|5\\s?\\/\\s?N|S[I1L]N(?=\\s?[:.#])|SN(?=[\\s:.#-])'
    + '|SER(?:IAL)?\\.?\\s*(?:NUMBER|NUM|N[O0]|#)\\.?|SERIAL(?=[\\s:.#-]))'
    + '\\s*[:#.=\\-]?\\s*([A-Z0-9][A-Z0-9\\-\\/.]{2,24}[A-Z0-9])', 'g');
  // A Victron serial needs no label: nothing else looks like HQ and four
  // digits and five more.
  const VICTRON_SERIAL = /(?<![A-Z0-9])(H[Q0O][0-9OQDILSBZG]{4}[A-Z0-9]{5})(?![A-Z0-9])/g;

  // ── The text ───────────────────────────────────────────────────────────────

  // Upper case, one kind of dash, no trademark signs, runs of spaces as one,
  // and the lines kept — which line a serial is on is half of whose it is.
  function normalise(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .toUpperCase()
      .replace(/[−‒–—‐‑﹣－]/g, '-')
      .replace(/[®™©]/g, '')
      .replace(/Ø/g, '0')
      .replace(/[ \t]+/g, ' ');
  }

  // ── Serials ────────────────────────────────────────────────────────────────

  const toDigits = x => x.split('').map(c => DIGIT[c] || c).join('');

  // A serial as it should read, for a make whose serials have a known shape,
  // and whether it had to be put right to get there. Null when it cannot be
  // one of that make's at all.
  function shapeSerial(raw, shape) {
    const s = raw.replace(/[.\-\/]+$/, '');
    if (shape === 'digits' || shape === 'imei') {
      const d = toDigits(s.replace(/-/g, ''));
      const ok = shape === 'digits' ? /^\d{3,10}$/.test(d) : /^\d{15}$/.test(d);
      return ok ? { serial: d, fixed: d !== s, shaped: true } : null;
    }
    if (shape === 'victron') {
      const m = /^H[Q0O]([0-9OQDILSBZG|]{4})([A-Z0-9]{5})$/.exec(s.replace(/-/g, ''));
      if (!m) return null;
      const out = `HQ${toDigits(m[1])}${m[2]}`;
      return { serial: out, fixed: out !== s, shaped: true };
    }
    return null;
  }
  // No shape to go by: a lookalike letter with a digit on either side of it
  // (12O45) is a digit the OCR misread; one at either end is kept, because
  // plenty of serials start or end with a letter (B2106-0042), and a serial
  // put wrong is worse than one left as read.
  function plainSerial(raw) {
    const s = raw.replace(/[.\-\/]+$/, '');
    const out = s.split('').map((c, i) => (DIGIT[c] && /\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? DIGIT[c] : c)).join('');
    return { serial: out, fixed: out !== s, shaped: false };
  }
  function serialFor(raw, shape) {
    return (shape && shapeSerial(raw, shape)) || plainSerial(raw);
  }

  // ── One reading ────────────────────────────────────────────────────────────

  function scan(text) {
    const t = normalise(text);
    const lines = t.split('\n');
    const starts = [0];
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) starts.push(i + 1);
    const lineAt = index => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const evidence = (a, b) => lines.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)
      .map(l => l.trim()).filter(Boolean).join(' / ').slice(0, 300);

    const makes = [], models = [], serials = [], kinds = [];
    let m;
    for (const mk of MAKES) {
      const re = new RegExp(mk.re, 'g');
      while ((m = re.exec(t))) makes.push({ mk, at: m.index, line: lineAt(m.index) });
    }
    for (const k of KINDS) {
      k.re.lastIndex = 0;
      while ((m = k.re.exec(t))) kinds.push({ kind: k.kind, at: m.index, line: lineAt(m.index) });
    }

    // Models, longest first, and a stretch of text taken by one is taken: a
    // CR1000X is not also a CR1000.
    const taken = [];
    const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
    const order = [];
    for (const mk of MAKES) for (const md of mk.models) order.push({ mk, md, len: (md.canon || md.model || md.re).length });
    order.sort((a, b) => b.len - a.len);
    for (const { mk, md } of order) {
      const re = new RegExp(md.re || fuzzy(md.model), 'g');
      while ((m = re.exec(t))) {
        if (!m[0].trim() || !free(m.index, m.index + m[0].length)) continue;
        const line = lineAt(m.index);
        const subs = md.re ? 0 : lookalikes(m[0], md.model);
        const makeHere = makes.some(x => x.mk === mk);
        const wordHere = kinds.some(k => Math.abs(k.line - line) <= 2);
        if (md.needs === true && !makeHere) continue;
        if (md.needs === 'rain' && !makeHere && !RAIN_WORDS.test(t)) continue;
        // A code read with one lookalike in it, or with three of its own
        // characters as they are (the CR3 of CR3OO), stands alone; one that is
        // mostly lookalikes needs its make, or a word saying what the thing
        // is, beside it — IOSU is a 105U only on an ELPRO label.
        const exact = md.re ? Infinity : bare(md.model).length - subs;
        if (subs > 1 && exact < 3 && !makeHere && !wordHere) continue;
        if (subs === 1 && bare(md.model).length < 4 && !makeHere) continue;
        taken.push([m.index, m.index + m[0].length]);
        models.push({ mk, md, name: md.name ? md.name(m) : md.model, subs, makeHere, at: m.index, line });
      }
    }

    SERIAL_RE.lastIndex = 0;
    while ((m = SERIAL_RE.exec(t))) {
      if (!/\d/.test(m[2])) continue;                     // a serial has a digit in it; a word does not
      const label = m[1].replace(/\s+/g, '');
      serials.push({ raw: m[2], imei: /^(IMEI|ESN)$/.test(label), at: m.index, end: m.index + m[0].length, line: lineAt(m.index + m[0].length - m[2].length) });
    }
    VICTRON_SERIAL.lastIndex = 0;
    while ((m = VICTRON_SERIAL.exec(t))) {
      if (!serials.some(s => s.at <= m.index && m.index < s.end)) {
        serials.push({ raw: m[1], bareHQ: true, at: m.index, end: m.index + m[1].length, line: lineAt(m.index) });
      }
    }

    // Whose serial is this: the nearest model from a line above to three
    // below, and on its own line the one before it.
    const used = new Set();
    const nearestSerial = (line, at, shape) => {
      let best = null, bd = Infinity;
      serials.forEach((s, i) => {
        if (used.has(i)) return;
        const dl = s.line - line;
        if (dl < -1 || dl > 3) return;
        if (s.bareHQ && shape !== 'victron') return;
        const d = Math.abs(dl) * 1000 + (dl === 0 && s.at < at ? 500 : 0) + Math.abs(s.at - at) / 1000;
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };

    const found = [];
    for (const md of models) {
      let kind = md.md.kind || md.mk.kind;
      if (md.md.byWord) {
        const w = WATERLOG_BY_WORD.find(([re]) => re.test(t));
        if (w) kind = w[1];
      }
      let serial = '', serialLine = md.line, fixed = false, shaped = false;
      const si = nearestSerial(md.line, md.at, md.mk.serial);
      if (si != null) {
        const got = serialFor(serials[si].raw, md.mk.serial);
        if (bare(got.serial) !== bare(md.name)) {
          used.add(si);
          ({ serial, fixed, shaped } = got);
          serialLine = serials[si].line;
        }
      }
      let c = md.subs ? 0.4 : 0.55;
      if (md.makeHere) c += 0.2;
      if (serial) c += shaped ? 0.25 : 0.2;
      if (fixed) c -= 0.05;
      found.push({ equipment_key: kind, make: md.mk.make, model: md.name, serial_no: serial,
                   confidence: c, evidence: evidence(md.line, serialLine) });
    }

    // A make with no model on its label, and a serial beside it.
    for (const mk of makes) {
      if (models.some(x => x.mk === mk.mk)) continue;
      const si = nearestSerial(mk.line, mk.at, mk.mk.serial);
      if (si == null) continue;
      const got = serialFor(serials[si].raw, mk.mk.serial);
      used.add(si);
      found.push({ equipment_key: mk.mk.kind, make: mk.mk.make, model: mk.mk.bareModel ? mk.mk.bareModel(t) : '', serial_no: got.serial,
                   confidence: 0.35 + (got.shaped ? 0.15 : 0.1) - (got.fixed ? 0.05 : 0),
                   evidence: evidence(mk.line, serials[si].line) });
    }

    // A serial beside nothing but a word that says what the thing is — or an
    // IMEI, which only a modem has.
    serials.forEach((s, i) => {
      if (used.has(i)) return;
      let best = null, bd = Infinity;
      for (const k of kinds) {
        const dl = s.line - k.line;
        if (dl < -1 || dl > 3) continue;
        const d = Math.abs(dl) * 1000 + Math.abs(s.at - k.at) / 1000;
        if (d < bd) { bd = d; best = k; }
      }
      if (!best && s.imei) best = { kind: 'modem', line: s.line };
      if (!best) return;
      const got = serialFor(s.raw, s.imei ? 'imei' : null);
      used.add(i);
      found.push({ equipment_key: best.kind, make: '', model: '', serial_no: got.serial,
                   confidence: 0.3 + (got.shaped ? 0.1 : 0.05) - (got.fixed ? 0.05 : 0),
                   evidence: evidence(best.line, s.line) });
    });
    return found;
  }

  // ── Every reading, pooled ──────────────────────────────────────────────────

  // Two serials one character apart — two, in one of six or more — are one
  // serial misread.
  function near(a, b) {
    a = bare(a); b = bare(b);
    if (!a || !b) return false;
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length] <= (Math.min(a.length, b.length) >= 6 ? 2 : 1);
  }

  // The serial more readings agree on, then the surer reading of it.
  function bestRead(reads) {
    const tally = new Map();
    for (const r of reads) {
      if (!r.serial_no) continue;
      const k = bare(r.serial_no);
      const e = tally.get(k) || { n: new Set(), r };
      e.n.add(r.reading);
      if (r.confidence > e.r.confidence) e.r = r;
      tally.set(k, e);
    }
    const ranked = [...tally.values()].sort((a, b) => b.n.size - a.n.size || b.r.confidence - a.r.confidence);
    return ranked.length ? ranked[0].r : reads.slice().sort((a, b) => b.confidence - a.confidence)[0];
  }

  // `texts`: a string, an array of strings, or PhotoMeta.ocrLabels()'s
  // readings ({ text, … }). → candidates, most confident first:
  //   [{ equipment_key, make, model, serial_no, confidence, evidence, votes }]
  // `opts.minConfidence` (0.3) drops what is not worth an administrator's look.
  function parse(texts, opts = {}) {
    const list = (Array.isArray(texts) ? texts : [texts])
      .map(x => (typeof x === 'string' ? x : String((x && x.text) || '')))
      .filter(x => x.trim());
    const same = (a, b) => !bare(a) || !bare(b) || bare(a) === bare(b);
    const groups = [];
    list.forEach((text, reading) => {
      for (const c of scan(text)) {
        c.reading = reading;
        const g = groups.find(x => x.equipment_key === c.equipment_key && same(x.make, c.make) && same(x.model, c.model)
          && (() => { const s = bestRead(x.reads).serial_no; return !s || !c.serial_no || near(s, c.serial_no); })());
        if (!g) { groups.push({ equipment_key: c.equipment_key, make: c.make, model: c.model, reads: [c] }); continue; }
        g.reads.push(c);
        if (!g.make && c.make) g.make = c.make;
        if (!g.model && c.model) g.model = c.model;
      }
    });

    const out = groups.map(g => {
      const best = bestRead(g.reads);
      const readings = new Set(g.reads.map(r => r.reading)).size;
      const agree = new Set(g.reads.filter(r => bare(r.serial_no) === bare(best.serial_no)).map(r => r.reading)).size;
      const rivals = [...new Set(g.reads.map(r => r.serial_no).filter(s => s && bare(s) !== bare(best.serial_no)))];
      let confidence = best.confidence + (agree >= 2 ? 0.1 : 0) - (rivals.length ? 0.05 : 0)
                     + (g.model && !best.model ? 0.1 : 0) + (g.make && !best.make ? 0.05 : 0);
      confidence = Math.round(Math.max(0.05, Math.min(0.95, confidence)) * 100) / 100;
      let evidence = best.evidence;
      if (rivals.length) evidence += ` (also read as ${rivals.join(', ')})`;
      if (list.length > 1) evidence += ` — in ${readings} of ${list.length} readings`;
      return { equipment_key: g.equipment_key, make: g.make, model: g.model, serial_no: best.serial_no,
               confidence, evidence: evidence.slice(0, 600), votes: readings };
    });
    const min = opts.minConfidence == null ? 0.3 : opts.minConfidence;
    return out.filter(c => c.confidence >= min).sort((a, b) => b.confidence - a.confidence);
  }

  return { parse, normalise, _fuzzy: fuzzy, _near: near };
})();

if (typeof window !== 'undefined') window.PhotoEquipment = PhotoEquipment;
// test/photoreview.mjs require()s this same file under Node, and so will a
// sync or an agent reading labels off photos on a server — one set of rules
// whichever door the photo came in by. Guarded so the browser, where `module`
// is undefined, never runs it; constrains nothing below.
if (typeof module !== 'undefined' && module.exports) module.exports = PhotoEquipment;
