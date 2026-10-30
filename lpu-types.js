// MegaNet — lpu-types.js
//
//   LpuTypes   what a typed LPU (logger) type means: the type on the list it
//              spells, or the ones it is close to and how — so the station
//              editor can ask "did you mean the CR300?" before a type is added,
//              and never "correct" a digit that is really a different logger.
//
// Before station-lpu.js, its one caller in the browser — index.html holds the
// order and the reasons. Pure: text and the list in, matches out. No page, no
// `state`, no network. The IIFE body only declares, so its position among the
// modules is free (`npm run toplevel`), and test/lputypes.mjs require()s this
// same file under Node through the `module.exports` at the foot — and holds
// matchKey() to the database's meganet.lpu_match_key() (0090) on the inputs
// tools/check_station_lpu.sql gives it, so the browser and the database cannot
// disagree about which spellings are one type.
//
// ── How close is close, and what a difference means ──────────────────────────
//
// Spacing, case, punctuation and the make's name never count: `cr-300`,
// `CR 300` and `Campbell Scientific CR300` are the CR300 (matchKey). Past that,
// a typed type that is not on the list is held against each one that is, and
// each near one comes back with how it is near — because how is what tells a
// slip of the finger from a different unit:
//
//   lookalike  a letter where a digit that looks like it belongs (O for 0, I
//              or l for 1, S for 5, B for 8, Z for 2, G for 6), or the other
//              way round — `CR3OO`. Almost always a slip.
//   swapped    two neighbouring characters the other way round — `CR030`.
//   letter     one letter different, or one too many or too few — `ERX-A2`.
//   contains   what was typed has a listed model in it (`LPRO ERT A2` has
//              ERT-A2), or is a part of one (`A2`).
//   digit      one digit different, or one too many or too few. Sometimes a
//              slip, and often a different logger: Campbell makes a CR300, a
//              CR310, a CR350 and a CR3000. So a digit is never offered as the
//              correction — the editor is shown the models the list has that
//              differ the same way, and asked to check the unit's label.
//   suffix     a letter more or fewer on the end — the same caution, for the
//              same reason: a CR1000X is not a CR1000, and a CR1000Xe is not a
//              CR1000X.
//   close      two edits apart, for codes long enough that two edits still
//              leave most of them.
//
// The score ranks them — a lookalike above a swap above a letter above a
// contains above a digit or a suffix — and decides nothing: a person picks
// one, or says the type is new, and the database adds a new one only then
// (0090). Where the near ones differ by a digit or a suffix, resolve() also
// says so once (`caution`), naming the models on the list that differ that
// way, rather than repeating it under each.

const LpuTypes = (function () {

  // The makes this network fits, as their labels and the inspection sheets
  // write them. 0090's lpu_match_key() takes the same words out, by the same
  // pattern: \b here is its \m and \M.
  const MAKES = /\b(CAMPBELL(?:'?S)?(?:\s*SCI(?:ENTIFIC)?)?|CSI|ELPRO(?:\s*TECHNOLOGIES)?|ERRTS)\b/g;
  const MAKES_ANY_CASE = /\b(campbell(?:'?s)?(?:\s*sci(?:entific)?)?|csi|elpro(?:\s*technologies)?|errts)\b/gi;

  // Which version fields a unit of each family has (0090's lpu_type.family),
  // in the order the editor shows them.
  const FIELDS = Object.freeze({
    ert_a2:   Object.freeze(['firmware_version', 'bootloader_version', 'radio_firmware_version']),
    campbell: Object.freeze(['os_version', 'program']),
    other:    Object.freeze(['firmware_version', 'program']),
  });
  const VERSION_FIELDS = Object.freeze(['firmware_version', 'bootloader_version', 'radio_firmware_version', 'os_version', 'program']);

  // A letter OCR and fingers make of a digit, and the digit it stands for.
  const LOOK = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
  const isDigit = c => c >= '0' && c <= '9';
  const lookalike = (a, b) => LOOK[a] === b || LOOK[b] === a;

  const SCORE = { lookalike: 0.95, swapped: 0.9, letter: 0.8, contains: 0.7, digit: 0.6, suffix: 0.58, within: 0.55, close: 0.45 };

  // A type as the list compares it: upper case, the make's name out, letters
  // and digits only.
  function matchKey(text) {
    return String(text == null ? '' : text).toUpperCase().replace(MAKES, '').replace(/[^A-Z0-9]/g, '');
  }

  // Edits from a to b, a swap of neighbours counting as one (optimal string
  // alignment). Only ever asked of two short codes.
  function edits(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  // How the typed key q is near the listed key t, or null when it is not.
  function relation(q, t) {
    if (!q || !t || q === t) return null;
    if (q.length === t.length) {
      const diff = [];
      for (let i = 0; i < q.length; i++) if (q[i] !== t[i]) diff.push(i);
      if (diff.length <= 2 && diff.every(i => lookalike(q[i], t[i]))) {
        return { kind: 'lookalike', typed: diff.map(i => q[i]).join(''), listed: diff.map(i => t[i]).join('') };
      }
      if (diff.length === 2 && diff[1] === diff[0] + 1 && q[diff[0]] === t[diff[1]] && q[diff[1]] === t[diff[0]]) {
        return { kind: 'swapped', typed: q.slice(diff[0], diff[1] + 1), listed: t.slice(diff[0], diff[1] + 1) };
      }
      if (diff.length === 1) {
        const a = q[diff[0]], b = t[diff[0]];
        return { kind: isDigit(a) && isDigit(b) ? 'digit' : 'letter', typed: a, listed: b, at: diff[0] };
      }
    }
    if (Math.abs(q.length - t.length) === 1) {
      const more = q.length > t.length;
      const long = more ? q : t, short = more ? t : q;
      for (let i = 0; i < long.length; i++) {
        if (long.slice(0, i) + long.slice(i + 1) === short) {
          const kind = isDigit(long[i]) ? 'digit' : i === long.length - 1 ? 'suffix' : 'letter';
          return { kind, more, ch: long[i] };
        }
      }
    }
    if (t.length >= 3 && q.includes(t)) return { kind: 'contains' };
    if (q.length >= 2 && t.includes(q)) return { kind: 'within' };
    if (Math.min(q.length, t.length) >= 5 && edits(q, t) <= 2) return { kind: 'close' };
    return null;
  }

  // The other types on the list that differ from t only in the digit at `at`:
  // CR300, CR310 and CR350 for a typed CR320.
  function siblings(t, at, list) {
    if (at == null) return [];
    return list.filter(x => {
      const k = matchKey(x.model);
      return k.length === t.length && isDigit(k[at])
        && k.slice(0, at) === t.slice(0, at) && k.slice(at + 1) === t.slice(at + 1);
    });
  }

  function andList(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  // The reason, in words, beside each near one.
  function why(r, type) {
    switch (r.kind) {
      case 'lookalike':
        return `“${r.typed}” typed where ${type.model} has “${r.listed}” — a letter and a digit that look alike`;
      case 'swapped':
        return `“${r.typed}” typed where ${type.model} has “${r.listed}” — two characters the other way round`;
      case 'letter':
        return r.typed ? `one letter different — “${r.typed}” where ${type.model} has “${r.listed}”`
          : `one letter ${r.more ? 'more' : 'fewer'} than ${type.model}`;
      case 'digit':
        return r.typed ? `one digit different — ${r.typed} where ${type.model} has ${r.listed}`
          : `one digit ${r.more ? 'more' : 'fewer'} than ${type.model}`;
      case 'suffix':   return `“${r.ch}” ${r.more ? 'added on the end of' : 'missing from the end of'} ${type.model}`;
      case 'contains': return `what was typed has ${type.model} in it`;
      case 'within':   return `what was typed is part of ${type.model}`;
      default:         return `a few characters different from ${type.model}`;
    }
  }

  // Said once above the near ones when any differ by a digit or a suffix: the
  // difference may be the unit, so the label decides, not the list.
  function caution(near, list, text) {
    const digit = near.filter(n => n.kind === 'digit'), suffix = near.filter(n => n.kind === 'suffix');
    if (!digit.length && !suffix.length) return '';
    const typed = String(text).replace(/\s+/g, ' ').trim();
    const named = new Map();
    for (const n of digit) {
      if (n.at == null) continue;
      for (const x of siblings(matchKey(n.type.model), n.at, list)) named.set(x.key, x.model);
    }
    if (named.size >= 2) {
      return `The list has ${andList([...named.values()])} — a digit apart, and each a different logger — so a digit different may be a different unit, not a slip. Check the unit's label before picking one.`;
    }
    if (digit.length) return `A digit different may be a different unit, not a slip: ${typed} and ${digit[0].type.model} may be two different loggers. Check the unit's label before picking one.`;
    return `A letter on the end is often a different model, not a slip (a CR1000X is not a CR1000): ${typed} and ${suffix[0].type.model} may be two different loggers. Check the unit's label before picking one.`;
  }

  // A typed type against the list: the one it spells (`exact`), or the near
  // ones, best first, at most four, and the caution above them. `slip` says
  // the best is likely a slip of the finger — a lookalike, a swap or a letter —
  // so the editor leads with "Did you mean"; otherwise it asks whether it is
  // one of these or a new one.
  function resolve(text, types) {
    const list = Array.isArray(types) ? types : [];
    const q = matchKey(text);
    if (!q) return { key: q, exact: null, near: [], caution: '', slip: false };
    const exact = list.find(t => matchKey(t.model) === q || matchKey(t.label) === q) || null;
    if (exact) return { key: q, exact, near: [], caution: '', slip: false };
    const near = [];
    for (const t of list) {
      let best = null;
      for (const k of new Set([matchKey(t.model), matchKey(t.label)])) {
        const r = relation(q, k);
        if (r && (!best || SCORE[r.kind] > SCORE[best.kind])) best = r;
      }
      if (best) near.push({ type: t, kind: best.kind, at: best.at, score: SCORE[best.kind], why: why(best, t) });
    }
    near.sort((a, b) => b.score - a.score || (a.type.ord ?? 1000) - (b.type.ord ?? 1000)
      || String(a.type.label).localeCompare(String(b.type.label)));
    // Two edits away is only worth saying when nothing nearer was found.
    const top = (near.length && near[0].kind !== 'close' ? near.filter(n => n.kind !== 'close') : near).slice(0, 4);
    return { key: q, exact: null, near: top, caution: caution(top, list, text),
             slip: !!top.length && top[0].score >= SCORE.letter };
  }

  // What a type typed as new would be: its make when it names one of the two
  // (or is a Campbell CR number), its model without the make, the label to
  // show, and the family the editor offers first.
  function parseNew(text) {
    const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const up = raw.toUpperCase();
    const model = raw.replace(MAKES_ANY_CASE, ' ').replace(/\s+/g, ' ').trim() || raw;
    const key = matchKey(model);
    let make = '';
    if (/\b(CAMPBELL|CSI)/.test(up) || /^CR\d/.test(key)) make = 'Campbell Scientific';
    else if (/\b(ELPRO|ERRTS)\b/.test(up)) make = 'ELPRO';
    const family = make === 'Campbell Scientific' ? 'campbell' : /^ERT/.test(key) ? 'ert_a2' : 'other';
    return { make, model, label: make ? `${make} ${model}` : model, family };
  }

  function fieldsFor(type) {
    return FIELDS[(type && type.family) || 'other'] || FIELDS.other;
  }

  return { matchKey, resolve, parseNew, fieldsFor, edits, FIELDS, VERSION_FIELDS, SCORE };
})();
if (typeof window !== 'undefined') window.LpuTypes = LpuTypes;
if (typeof module !== 'undefined' && module.exports) module.exports = LpuTypes;
