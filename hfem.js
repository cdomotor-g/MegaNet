// MegaNet — hfem.js
//
//   HFEM   decoder and encoder for the BoM Hydro Field Event Message format —
//          `archive/BoM HFEM v1.0.pdf` (R. Thompson, Bureau of Meteorology,
//          August 2010, v1.0), message type HS version 1. #153, EPIC #152.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to nothing: this file is a pure codec — a string in, a structure
// out, a structure back to the same string. No state, no DOM, no datastore, so
// its position among the modules is free (`npm run toplevel` checks that).
//
// One module, two consumers, on purpose (#153's design decision): the HFEM tab
// (#154) reads the `HFEM` global this classic script declares, and the bridge
// (#155, CommonJS under bridge/) `require()`s this same file — the guarded
// `module.exports` at the foot is that registration, and bridge/Dockerfile
// copies this file into the image so it is actually there. One decoder, so
// there is never a second opinion about what `T3` means — a second opinion is
// exactly the drift bridge/src/messages.js says it was built to avoid.
//
// ── What HFEM is, in one paragraph ───────────────────────────────────────────
//
// An ASCII name-value-pair line a logger pushes when a sensor trips or an
// inactivity timer expires. `:` at both ends, `|` between sections:
//
//   :HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-10=139|NN:
//
// Header (type=version), optional M=1 maintenance flag, a site identifier, an
// optional observation timestamp, one or more sensor measurements, and the NN
// footer. Parameters are order-independent by specification (§2.1); this
// decoder accepts them in any order and the encoder emits them in spec order
// (§2.4 warns implementations may enforce one). Spaces are insignificant and
// stripped before parsing (§2 note 3); leading zeros are insignificant unless
// a format mandates width (§2 note 2).
//
// HFEM has **no checksum**. The `|NN:` footer is the only integrity check the
// format has, so this decoder is the last line of defence: a structural fault
// is a rejection with a reason naming the offending token, never a partial
// decode — a truncated line with three of five sensors intact must not land
// three readings (#152's acceptance criteria say why).
//
// ── Stated vs derived ────────────────────────────────────────────────────────
//
// A decoded message mixes what was on the wire with what the spec's tables
// imply, and a consumer storing readings must know which is which. The split
// is fixed for every field except the UTC instant, and FIELD_PROVENANCE below
// states it; the one that varies is time.utcIsStated — true for T1/T2 (the
// stamp *is* UTC) and false for T3 (UTC is computed as stamp + offset).
//
// ── The timestamp trap (#152 trap 1) ─────────────────────────────────────────
//
// Table 3, exactly — the obvious ISO-8601 reading is wrong twice over:
//
//   T1  20100727030000     UTC, no zone            → UTC as written
//   T2  20100727030000+10  UTC; offset appended so → UTC as written —
//                          a reader can compute      IGNORE the suffix
//                          local time
//   T3  20100727130000-10  LOCAL standard time;    → UTC = stamp + offset
//                          offset appended so a
//                          reader can compute UTC
//
// Spec examples g) and h) are the same observation written both ways:
// `T2=20100727030000+10` and `T3=20100727130000-10` both mean 03:00 UTC.
// T3's sign is inverted relative to every offset convention Date knows —
// Victoria (UTC+10) writes `-10` — so nothing here goes near an ISO parser.
// Every example in the spec is a whole-hour offset; what a +9:30 site emits is
// #152's open question 3, and until it is answered a non-integer offset is a
// rejection naming the token rather than a guess at its meaning.

const HFEM = (function () {

  // ── Table 4 — the seventeen sensor classes ─────────────────────────────────
  //
  // `unit` is the *translated* engineering unit, spelled with meganet.unit's
  // keys (0006) so #155's mapping is a lookup rather than a rename. Raw
  // schemes have no engineering unit — they decode with unit 'count'.
  // `decimals` is the table's "Decimal Accuracy" read as a maximum ("Up to");
  // a value with more precision is accepted and noted, never rejected — a
  // logger sending 3 decimals where the table says 1 is over-reporting, not
  // lying, and dropping the reading is the worse error.
  //
  // Four cells of Table 4 contradict their own description (#152 trap 3).
  // Per the epic: transcribe the spec, implement the description, record each
  // divergence — a table that silently disagrees with a published spec is
  // worse than one that disagrees loudly.
  const SENSOR_CLASSES = {
    AT: { name: 'Air Temperature',     unit: 'degC',  decimals: 1 },
    BP: { name: 'Barometric Pressure', unit: 'hPa',   decimals: 1 },
    B:  { name: 'Battery',             unit: 'V',     decimals: 2 },
    // Table 4 cell says 'uS/cm'; its *description* says "micro seconds/cm" —
    // seconds for siemens. The cell is right; the unit is microsiemens/cm.
    C:  { name: 'Conductivity',        unit: 'uS/cm', decimals: 1 },
    Q:  { name: 'Discharge',           unit: 'm3/s',  decimals: 1 },
    // 'ppm' as the spec states it. meganet.unit carries mg/L, numerically
    // equivalent in fresh water — mapping ppm → mg/L is #155's decision to
    // make in the migration, not this table's to pre-empt (#152 trap 4).
    DO: { name: 'Dissolved Oxygen',    unit: 'ppm',   decimals: 1 },
    // Table 4 cell says 'mPa' (millipascals); the description says "mega
    // Pascals". A gas-purge line runs at megapascal order — MPa implemented.
    GP: { name: 'Gas Pressure',        unit: 'MPa',   decimals: 2 },
    PH: { name: 'pH',                  unit: 'pH',    decimals: 1 },
    R:  { name: 'Rainfall',            unit: 'mm',    decimals: 1 },
    RH: { name: 'Relative Humidity',   unit: '%',     decimals: 1 },
    // Table 4 cell says 'w/m2' — casing only; watts per square metre.
    SR: { name: 'Solar Radiation',     unit: 'W/m2',  decimals: 1 },
    // Table 4 cell says 'ntu' — casing only.
    TU: { name: 'Turbidity',           unit: 'NTU',   decimals: 1 },
    H:  { name: 'Water Level',         unit: 'm',     decimals: 3 },
    WT: { name: 'Water Temperature',   unit: 'degC',  decimals: 1 },
    // Table 4 cell says 'metres'; the description says degrees. Degrees.
    WD: { name: 'Wind Direction',      unit: 'deg',   decimals: 1 },
    WG: { name: 'Wind Gust',           unit: 'km/h',  decimals: 1 },
    // Table 4 cell *and* description say 'km/hr', but wind run is a distance
    // — the kilometres of wind that passed, not a speed (#152 trap 3). 0006's
    // unit vocabulary already carries 'km — wind run' for exactly this.
    WR: { name: 'Wind Run',            unit: 'km',    decimals: 1 },
  };

  // ── Table 5 — measurement schemes ──────────────────────────────────────────
  //
  // Raw schemes are integer counters with a declared rollover ceiling, carried
  // on the decode because "the counter rolled" and "the sensor jumped" are the
  // same two numbers otherwise. Scheme 0's 2047 exists to emulate a legacy
  // ALERT accumulator — the same 11-bit ceiling packets.js knows about.
  // Translated schemes (6/16/26) are engineering values: max precision eight
  // significant digits, up to three decimal places (the '99999999' in scheme
  // 26's format cell is the same rule minus a typo'd decimal point).
  //
  // 5, 7, 8, 9, 15, 17, 18, 19 and 25 are NOT defined by the spec. They are
  // rejected by name below — never inferred from the tens digit.
  const SCHEMES = {
    0:  { sampling: 'cumulative',    representation: 'raw',        rollover: 2047 },
    1:  { sampling: 'cumulative',    representation: 'raw',        rollover: 9999 },
    2:  { sampling: 'cumulative',    representation: 'raw',        rollover: 99999 },
    3:  { sampling: 'cumulative',    representation: 'raw',        rollover: 999999 },
    4:  { sampling: 'cumulative',    representation: 'raw',        rollover: 9999999 },
    6:  { sampling: 'cumulative',    representation: 'translated', rollover: null },
    10: { sampling: 'instantaneous', representation: 'raw',        rollover: 2047 },
    11: { sampling: 'instantaneous', representation: 'raw',        rollover: 9999 },
    12: { sampling: 'instantaneous', representation: 'raw',        rollover: 99999 },
    13: { sampling: 'instantaneous', representation: 'raw',        rollover: 999999 },
    14: { sampling: 'instantaneous', representation: 'raw',        rollover: 9999999 },
    16: { sampling: 'instantaneous', representation: 'translated', rollover: null },
    20: { sampling: 'sampled',       representation: 'raw',        rollover: 2047 },
    21: { sampling: 'sampled',       representation: 'raw',        rollover: 9999 },
    22: { sampling: 'sampled',       representation: 'raw',        rollover: 99999 },
    23: { sampling: 'sampled',       representation: 'raw',        rollover: 999999 },
    24: { sampling: 'sampled',       representation: 'raw',        rollover: 9999999 },
    26: { sampling: 'sampled',       representation: 'translated', rollover: null },
  };

  // Which decoded fields were on the wire and which came out of the tables
  // above. Fixed for everything except the UTC instant — see time.utcIsStated.
  const FIELD_PROVENANCE = {
    stated:  ['type', 'version', 'maintenance', 'site.scheme', 'site.id',
              'site.agency', 'time.scheme', 'time.raw', 'time.offsetHours',
              'sensor.cls', 'sensor.instance', 'sensor.scheme', 'sensor.value'],
    derived: ['sensor.className', 'sensor.sampling', 'sensor.representation',
              'sensor.rollover', 'sensor.unit', 'sensor.decimals',
              'time.localIso', 'time.utc (T3 only — stated for T1/T2)'],
  };

  const MAX_OFFSET_HOURS = 14;       // the real zoo of zones ends at UTC±14
  const MAX_SIGNIFICANT  = 8;        // Table 5: translated max precision

  function fail(reason) { return { ok: false, error: reason }; }

  // ── Timestamps ─────────────────────────────────────────────────────────────

  function two(n) { return String(n).padStart(2, '0'); }

  // CCYYMMDDHHMISS → epoch ms, read as UTC digits. Rejects an impossible
  // calendar date (a 31st of June, a 25th hour) by round-tripping through
  // Date.UTC, which would silently normalise it otherwise.
  function parseStamp(s) {
    const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
    const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
    const ms = Date.UTC(y, mo - 1, d, h, mi, se);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1
        || back.getUTCDate() !== d || back.getUTCHours() !== h
        || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== se) return null;
    return ms;
  }

  function isoZ(ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); }

  function isoLocal(ms) {
    const d = new Date(ms);   // built from shifted epoch ms, read back as UTC digits
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
         + `T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  }

  // One timestamp parameter → the time object, or a rejection string.
  function decodeTime(name, value) {
    if (name === 'T1') {
      if (!/^\d{14}$/.test(value)) {
        return { error: `${name}=${value}: T1 is CCYYMMDDHHMISS, fourteen digits, no zone` };
      }
      const ms = parseStamp(value);
      if (ms == null) return { error: `${name}=${value}: not a real calendar instant` };
      return { time: { scheme: 'T1', raw: value, utc: isoZ(ms), offsetHours: null,
                       utcIsStated: true, localIso: null } };
    }
    // T2 / T3: CCYYMMDDHHMISS{+/-}TZ. Every spec example is a whole-hour
    // offset; '+9.5' or '+0930' has no defined reading (#152 open question 3),
    // and a guess of +930 hours corrupts the instant far worse than a refusal.
    const m = /^(\d{14})([+-]\d{1,2})$/.exec(value);
    if (!m) {
      return { error: `${name}=${value}: expected CCYYMMDDHHMISS{+/-}TZ with a whole-hour `
                    + `offset — half-hour zones are undefined in HFEM v1.0 (see #152)` };
    }
    const ms = parseStamp(m[1]);
    if (ms == null) return { error: `${name}=${value}: not a real calendar instant` };
    const off = parseInt(m[2], 10);
    if (Math.abs(off) > MAX_OFFSET_HOURS) {
      return { error: `${name}=${value}: offset ${m[2]} is beyond UTC±${MAX_OFFSET_HOURS}` };
    }
    const offMs = off * 3600 * 1000;
    if (name === 'T2') {
      // The stamp IS UTC; the suffix exists so a reader can compute local.
      return { time: { scheme: 'T2', raw: value, utc: isoZ(ms), offsetHours: off,
                       utcIsStated: true, localIso: isoLocal(ms + offMs) } };
    }
    // T3: the stamp is local standard time; UTC = stamp + offset as written.
    // Victoria (UTC+10) writes -10 — the sign is inverted relative to ISO.
    return { time: { scheme: 'T3', raw: value, utc: isoZ(ms + offMs), offsetHours: off,
                     utcIsStated: false, localIso: isoLocal(ms) } };
  }

  // ── Sensor measurements ────────────────────────────────────────────────────

  // `R_1-0=1055` → the sensor object, or a rejection string. Leading zeros on
  // instance and scheme are insignificant (§2 note 2); on a raw value they are
  // parsed but the written text is kept for the round trip.
  function decodeSensor(name, value, notes) {
    const m = /^([A-Z]+)_([0-9]+)-([0-9]+)$/.exec(name);
    if (!m) return { error: `${name}: not a {Class}_{Instance}-{Scheme} sensor tag` };
    const cls = m[1];
    const clsDef = SENSOR_CLASSES[cls];
    if (!clsDef) return { error: `${name}: unknown sensor class "${cls}"` };
    const instance = parseInt(m[2], 10);
    if (instance < 1) return { error: `${name}: sensor instances start at 1 — instance 0 is malformed` };
    const scheme = parseInt(m[3], 10);
    const schemeDef = SCHEMES[scheme];
    if (!schemeDef) {
      return { error: `${name}: measurement scheme ${scheme} is not defined by HFEM v1.0 `
                    + `(defined: 0-4, 6 cumulative; 10-14, 16 instantaneous; 20-24, 26 sampled)` };
    }

    const raw = schemeDef.representation === 'raw';
    if (raw) {
      if (!/^\d+$/.test(value)) {
        return { error: `${name}=${value}: scheme ${scheme} is a raw integer counter` };
      }
      const n = parseInt(value, 10);
      if (n > schemeDef.rollover) {
        // Above the declared ceiling. Data, not structure — the value was
        // transmitted and a mis-declared scheme is likelier than corruption a
        // rejection would catch, so it is kept and said out loud.
        notes.push(`${name}=${value}: exceeds scheme ${scheme}'s declared ceiling of ${schemeDef.rollover}`);
      }
      return { sensor: { tag: `${cls}_${instance}-${scheme}`, cls, className: clsDef.name,
                         instance, scheme, sampling: schemeDef.sampling,
                         representation: 'raw', rollover: schemeDef.rollover,
                         unit: 'count', decimals: null, value: n, valueText: value } };
    }

    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      return { error: `${name}=${value}: scheme ${scheme} is a translated engineering value` };
    }
    const n = parseFloat(value);
    const dp = value.includes('.') ? value.split('.')[1].length : 0;
    if (dp > clsDef.decimals) {
      // Over-reporting, not lying (#153): accepted, noted, never dropped.
      notes.push(`${name}=${value}: ${dp} decimal places where ${clsDef.name}'s `
               + `stated accuracy is ${clsDef.decimals}`);
    }
    const sig = value.replace(/^-/, '').replace('.', '').replace(/^0+(?=\d)/, '').length;
    if (sig > MAX_SIGNIFICANT) {
      notes.push(`${name}=${value}: ${sig} significant digits where Table 5's maximum precision is ${MAX_SIGNIFICANT}`);
    }
    return { sensor: { tag: `${cls}_${instance}-${scheme}`, cls, className: clsDef.name,
                       instance, scheme, sampling: schemeDef.sampling,
                       representation: 'translated', rollover: null,
                       unit: clsDef.unit, decimals: clsDef.decimals,
                       value: n, valueText: value } };
  }

  // ── Decode ─────────────────────────────────────────────────────────────────
  //
  // A string in; { ok: true, message } out, or { ok: false, error } naming the
  // offending token. Never a partial decode.
  function decode(input) {
    if (typeof input !== 'string') return fail('not a string');
    // §2 note 3: spaces are white space with no significance. Stripped first,
    // together with the line endings a serial capture or a POST body adds.
    const line = input.replace(/\s+/g, '');
    if (line === '') return fail('empty message');
    if (!line.startsWith(':')) return fail('no start-of-message ":"');
    if (line.length < 2 || !line.endsWith(':')) {
      return fail('no end-of-message ":" — message truncated');
    }
    const inner = line.slice(1, -1);
    if (inner.includes(':')) {
      return fail('":" inside the message — start/end-of-message only');
    }

    const sections = inner.split('|');
    if (sections.length < 2) return fail('nothing between start and end of message');

    // Header first, always (§2.1): {XX=nn}.
    const head = /^([A-Z]+)=(\d+)$/.exec(sections[0]);
    if (!head) return fail(`"${sections[0]}": not a message header ({XX=nn})`);
    const type = head[1], version = parseInt(head[2], 10);
    if (type !== 'HS' || version !== 1) {
      // Dispatch on XX=nn (#152 open question 4): a second type or a version
      // bump changes only the body, and lands here until it is implemented.
      return fail(`unsupported message type "${type}" version ${version} — only HS version 1 is defined`);
    }

    // Footer last, always (§2.5): NN, the only parameter with no value, is how
    // you know the message is whole — HFEM's entire integrity story.
    if (sections[sections.length - 1] !== 'NN') {
      return fail('no NN footer before the end-of-message — message truncated');
    }

    const msg = { type, version, maintenance: false, site: null, time: null,
                  sensors: [], notes: [] };
    const seen = new Set();

    // Body parameters, in any order (§2.1) — emitted back in spec order.
    for (const part of sections.slice(1, -1)) {
      if (part === 'NN') return fail('NN before the end of the message');
      if (part === '') return fail('empty parameter ("||") in the message');
      const eq = part.indexOf('=');
      if (eq < 1) return fail(`"${part}": not a name-value pair`);
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (value === '') return fail(`"${part}": no value`);
      if (value.includes('=')) return fail(`"${part}": more than one "=" in a name-value pair`);
      if (seen.has(name)) return fail(`duplicate parameter "${name}"`);
      seen.add(name);

      if (name === 'M') {
        if (value !== '1') return fail(`M=${value}: only M=1 is defined (maintenance mode)`);
        msg.maintenance = true;
      } else if (name === 'I1') {
        if (msg.site) return fail('two site identifiers in one message');
        if (!/^[A-Za-z0-9]{1,8}$/.test(value)) {
          return fail(`I1=${value}: up to eight alphanumerics (Table 2)`);
        }
        msg.site = { scheme: 'I1', id: value, agency: null };
      } else if (name === 'I2') {
        if (msg.site) return fail('two site identifiers in one message');
        const m2 = /^([A-Za-z0-9]{6})-([A-Za-z0-9]{8})$/.exec(value);
        if (!m2) {
          return fail(`I2=${value}: six alphanumerics, a hyphen, eight alphanumerics (Table 2)`);
        }
        msg.site = { scheme: 'I2', id: m2[2], agency: m2[1] };
      } else if (name === 'T1' || name === 'T2' || name === 'T3') {
        if (msg.time) return fail('two observation timestamps in one message — different times must be separate messages (§4.2)');
        const t = decodeTime(name, value);
        if (t.error) return fail(t.error);
        msg.time = t.time;
      } else if (/^[A-Z]+_/.test(name)) {
        const s = decodeSensor(name, value, msg.notes);
        if (s.error) return fail(s.error);
        msg.sensors.push(s.sensor);
      } else {
        return fail(`"${part}": unknown parameter "${name}"`);
      }
    }

    if (!msg.site) return fail('no site identifier (I1 or I2)');
    if (!msg.sensors.length) return fail('no sensor measurements');

    return { ok: true, message: msg };
  }

  // ── Encode ─────────────────────────────────────────────────────────────────
  //
  // The decode structure back to a line, in spec order: header, M, site, time,
  // sensors, NN. Byte-identical for anything decode() produced from a
  // canonical line (valueText and time.raw carry the wire text through), and
  // a validator for a structure built by hand — #154's "build a test message".
  function encode(msg) {
    if (!msg || typeof msg !== 'object') return fail('not a message object');
    if (msg.type !== 'HS' || msg.version !== 1) {
      return fail(`unsupported message type "${msg.type}" version ${msg.version} — only HS version 1 is defined`);
    }
    const parts = [`HS=1`];
    if (msg.maintenance) parts.push('M=1');

    const site = msg.site;
    if (!site || !site.scheme) return fail('no site identifier');
    if (site.scheme === 'I1') {
      if (!/^[A-Za-z0-9]{1,8}$/.test(site.id || '')) {
        return fail(`site id "${site.id}": up to eight alphanumerics (Table 2)`);
      }
      parts.push(`I1=${site.id}`);
    } else if (site.scheme === 'I2') {
      if (!/^[A-Za-z0-9]{6}$/.test(site.agency || '') || !/^[A-Za-z0-9]{8}$/.test(site.id || '')) {
        return fail(`site "${site.agency}-${site.id}": six alphanumerics, a hyphen, eight alphanumerics (Table 2)`);
      }
      parts.push(`I2=${site.agency}-${site.id}`);
    } else {
      return fail(`unknown site scheme "${site.scheme}"`);
    }

    if (msg.time) {
      const t = msg.time;
      let raw = t.raw;
      if (!raw) {
        // Built by hand: derive the wire text from the scheme and the instant.
        if (t.scheme === 'T1' || t.scheme === 'T2') {
          if (!t.utc) return fail(`${t.scheme}: no utc instant to encode`);
          raw = t.utc.replace(/[-T:Z]/g, '');
          if (t.scheme === 'T2') {
            if (t.offsetHours == null) return fail('T2: no offsetHours to encode');
            raw += (t.offsetHours < 0 ? '-' : '+') + Math.abs(t.offsetHours);
          }
        } else if (t.scheme === 'T3') {
          if (!t.localIso || t.offsetHours == null) {
            return fail('T3: needs localIso and offsetHours to encode');
          }
          raw = t.localIso.replace(/[-T:]/g, '')
              + (t.offsetHours < 0 ? '-' : '+') + Math.abs(t.offsetHours);
        } else {
          return fail(`unknown timestamp scheme "${t.scheme}"`);
        }
      }
      const check = decodeTime(t.scheme, raw);
      if (check.error) return fail(check.error);
      parts.push(`${t.scheme}=${raw}`);
    }

    if (!Array.isArray(msg.sensors) || !msg.sensors.length) {
      return fail('no sensor measurements');
    }
    const seen = new Set();
    for (const s of msg.sensors) {
      const cls = s.cls, clsDef = SENSOR_CLASSES[cls];
      if (!clsDef) return fail(`unknown sensor class "${cls}"`);
      if (!Number.isInteger(s.instance) || s.instance < 1) {
        return fail(`${cls}: sensor instances start at 1`);
      }
      const schemeDef = SCHEMES[s.scheme];
      if (!schemeDef) return fail(`${cls}_${s.instance}: measurement scheme ${s.scheme} is not defined by HFEM v1.0`);
      const tag = `${cls}_${s.instance}-${s.scheme}`;
      if (seen.has(tag)) return fail(`duplicate parameter "${tag}"`);
      seen.add(tag);
      const text = s.valueText != null ? s.valueText : String(s.value);
      if (schemeDef.representation === 'raw' ? !/^\d+$/.test(text)
                                             : !/^-?\d+(\.\d+)?$/.test(text)) {
        return fail(`${tag}=${text}: not a valid ${schemeDef.representation} value`);
      }
      parts.push(`${tag}=${text}`);
    }

    parts.push('NN');
    return { ok: true, line: `:${parts.join('|')}:` };
  }

  return { decode, encode, SENSOR_CLASSES, SCHEMES, FIELD_PROVENANCE };
})();

// The bridge is CommonJS and require()s this same file — see the header, and
// bridge/Dockerfile, which copies it into the image. Guarded so the browser,
// where `module` is undefined, never runs it; constrains nothing below it.
if (typeof module !== 'undefined' && module.exports) module.exports = HFEM;
