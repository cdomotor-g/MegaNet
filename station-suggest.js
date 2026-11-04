// MegaNet — station-suggest.js
//
// "Did you mean …?" for a station's name — the spelling somebody can say but
// not write. A good half of the names on file came from a language with no
// English spelling of its own (Mooloolah, Eumundi, Goondiwindi, Thargomindah),
// and the other half from a surveyor's ear (Caboolture, Proserpine, Wivenhoe),
// so the name somebody hears on the phone or reads off a gauge board is often
// not the one they can type. The Stations filter's matcher (app.js:
// stationMatchesSearch) wants the letters: "jimpy" finds nothing, and the only
// way on was trying the letters in every order until one stuck.
//
// So when a name finds nothing, the boxes that look stations up ask this for
// the names that *sound* like what was typed, or that are one slip of the
// fingers from it, and offer them:
//
//   · Ctrl/Cmd+K (palette.js) lists the stations under "Did you mean?".
//   · The Stations card's match note offers the spellings — "Gympie · 6" —
//     and picking one puts it in the search box in place of what was typed.
//   · The station pickers elsewhere (Map Generator, Link Budget, the field
//     photos and camera, ARRO Launcher) list the stations in place of
//     "nothing matches".
//
// Nothing here filters. It only ever runs after the real matcher has come up
// empty for a term, and what it offers is a station name taken from the file,
// so picking one is a search that finds something.
//
// How it hears a word (soundKey) — written for how Australian English says a
// place name, not for how a dictionary spells it:
//
//   · One letter for each consonant sound: c/k/ck/q are k, ph is f, soft c is
//     s, soft g and dg and dj are j, tch and ch are one sound, sh another,
//     x is ks, z is s, kn/gn/wr/wh lose the letter nobody says, th is t.
//   · The vowels by the sound they make: oo, ou, u, ue → u; ee, ea, ie, i,
//     y → i; ai, ay → e; oa, oe, au, aw → o. Eu at the start is "yu".
//   · Non-rhotic: an r nobody sounds — after a vowel and not before one — is
//     dropped, and a final -er, -ar or -ah is the a it is said as. So
//     "Bundaburg" is Bundaberg, "Gaynder" is Gayndah and "Kabooltcher" is
//     Caboolture (-ture is said "cha").
//   · A silent final e, a final h, and a doubled letter count for nothing.
//
// Two keys are then compared letter by letter (wordScore), with the cheap
// mistakes cheap: one vowel for another costs less than one consonant for
// another, a near consonant (t/d, k/g, m/n, s/sh) less than a far one, and a
// dropped vowel or a dropped h less than a dropped consonant. The letters as
// typed are compared too, plainly, which catches the slip a key would hide —
// "Gmypie" — and whichever is closer counts. A word still being typed is
// compared with the start of each name's word as well, so "mulu" offers
// Mooloolah before the word is finished.
//
// A word of the query is matched to its nearest word in a name; a query of
// several words scores the average, by length, of each word's best — so
// "mount kilkoy" is "Mt Kilcoy" (the abbreviation table, app.js
// abbrevExpansions, is asked for "mount"'s other spellings). What a name
// offers as the spelling is the run of its own words the query landed on,
// written as the name writes them.
//
// Exposes: key (soundKey), suggest, phrases, stations, leadHtml, reset.
// Requires: nothing at load. core.js's esc at call time; asks app.js's
//           abbrevExpansions when it is there.

const StationSuggest = (() => {
  // A word closer than this, as a share of its length, is offered. Tuned
  // against every name on file (test/suggest.mjs): far enough to reach
  // "Kabooltcher" for Caboolture, near enough that "Bowen" does not offer
  // every name with a b and an n in it.
  const MAX_SCORE = 0.3;
  // What is offered beside the nearest: nothing further from what was typed
  // than this past it. "jimpy" offers Gympie, and Jimbour — but not, past
  // those, every name with a j, an m and a p in it.
  const SPREAD = 0.2;
  // A word still being typed matched to the start of a longer one costs this
  // much more than the same word matched whole, so a finished word wins a tie.
  const PREFIX_COST = 0.1;
  // A start shorter than this is a start of too much: "mke" (McKay) is the
  // start of McKell as well.
  const MIN_PREFIX = 4;
  // Fewer letters than this and anything is "close" to anything — so a word
  // this short, typed or on file, counts only when it is the same word.
  const MIN_LETTERS = 3;

  const VOWELS = 'aeiou';
  const isVowel = c => VOWELS.includes(c);

  // Vowel spellings, two letters at a time, by the sound they make in a
  // place name said in Australian English.
  const VOWEL_PAIRS = {
    oo: 'u', ou: 'u', ue: 'u', ui: 'u', eu: 'u', uu: 'u',
    ee: 'i', ea: 'i', ie: 'i', ei: 'i', ii: 'i',
    ai: 'e', ae: 'e',
    oa: 'o', oe: 'o', au: 'o',
  };

  function vowelRun(run) {
    let out = '';
    for (let i = 0; i < run.length;) {
      const two = VOWEL_PAIRS[run.slice(i, i + 2)];
      if (two) { out += two; i += 2; } else { out += run[i]; i += 1; }
    }
    return out;
  }

  // The word as it is said, one letter per sound. Upper case marks a sound
  // English writes with two letters: C is ch, S is sh, Y is a y said as a
  // consonant.
  const _keys = new Map();
  function soundKey(word) {
    const src = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (_keys.has(src)) return _keys.get(src);
    let s = src;
    if (!s) return '';
    s = s
      .replace(/^(?:kn|gn|pn)/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/^wh/, 'w')
      .replace(/^x/, 's').replace(/^eu/, 'yu')
      .replace(/mb$/, 'm')
      .replace(/ture$/, 'Ca')                       // Caboolture: "-cha"
      .replace(/(?:er|ar|ah)$/, 'a')               // said as an a
      .replace(/t?ch/g, 'C').replace(/sh|ti(?=[ao])/g, 'S')
      .replace(/ph/g, 'f')
      .replace(/gh(?=[aeiouy])/g, 'g').replace(/gh/g, '')
      .replace(/qu/g, 'kw').replace(/q/g, 'k')
      .replace(/x/g, 'ks')
      .replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
      .replace(/d[gj]/g, 'j').replace(/g(?=[eiy])/g, 'j')
      .replace(/z/g, 's')
      .replace(/wh/g, 'w').replace(/th/g, 't').replace(/kh/g, 'k')
      .replace(/^y(?=[aeiou])/, 'Y').replace(/y/g, 'i');
    // A silent e, after the consonants have settled: Proserpine, Injune.
    if (s.length > 3) s = s.replace(/([^aeiouCSY])e$/, '$1');
    s = s
      .replace(/([aeiou])r(?![aeiou])/g, '$1')       // non-rhotic
      .replace(/h(?![aeiou])/g, '')                  // a final h, an h before a consonant
      .replace(/[ao]w(?![aeiou])/g, 'o').replace(/ew(?![aeiou])/g, 'u')
      .replace(/[aeiou]+/g, vowelRun)
      .replace(/(.)\1+/g, '$1');
    if (_keys.size > 20000) _keys.clear();
    _keys.set(src, s);
    return s;
  }

  // ── Distance ──────────────────────────────────────────────────────────────

  // Consonants a hearing mixes up: one for another costs half.
  const NEAR = ['bp', 'dt', 'gk', 'fv', 'mn', 'sS', 'SC', 'Cj', 'sj', 'iY', 'wv'];
  const WEAK = 'hwyrY';

  // A key's letters as numbers, and what each step between two of them costs,
  // worked out once: this runs a few thousand times a keystroke.
  const SYMBOLS = 'abcdefghijklmnopqrstuvwxyzCSY';
  const N_SYM = SYMBOLS.length;
  const symOf = c => SYMBOLS.indexOf(c);
  // Built on the first ask, not at load (test/toplevel.mjs).
  let GAP = null, SUB = null;
  function costs() {
    GAP = new Float64Array(N_SYM);
    SUB = new Float64Array(N_SYM * N_SYM);
    for (let x = 0; x < N_SYM; x++) {
      const cx = SYMBOLS[x];
      GAP[x] = isVowel(cx) ? 0.6 : WEAK.includes(cx) ? 0.7 : 1;
      for (let y = 0; y < N_SYM; y++) {
        const cy = SYMBOLS[y];
        SUB[x * N_SYM + y] = x === y ? 0
          : isVowel(cx) && isVowel(cy) ? 0.4
          : NEAR.includes(cx + cy) || NEAR.includes(cy + cx) ? 0.5 : 1;
      }
    }
  }
  // Every key is turned into codes before it is compared, so this is where
  // the tables are made sure of.
  function codes(key) {
    if (!GAP) costs();
    const out = new Uint8Array(key.length);
    for (let i = 0; i < key.length; i++) out[i] = Math.max(0, symOf(key[i]));
    return out;
  }

  // Three rows, kept between calls.
  let R0 = new Float64Array(32), R1 = new Float64Array(32), R2 = new Float64Array(32);
  function rows(m) {
    if (R0.length <= m) { R0 = new Float64Array(m + 1); R1 = new Float64Array(m + 1); R2 = new Float64Array(m + 1); }
  }

  // Weighted Damerau–Levenshtein between two keys, as codes. `m` is how much
  // of `b` to use; `start` true asks for the cheapest cost of the whole of `a`
  // against any start of that (the word still being typed) instead of against
  // the whole of it.
  function keyDist(a, b, m, start) {
    const n = a.length;
    rows(m);
    let prev2 = R2, prev = R0, cur = R1;
    prev[0] = 0;
    for (let j = 1; j <= m; j++) prev[j] = prev[j - 1] + GAP[b[j - 1]];
    for (let i = 1; i <= n; i++) {
      const ai = a[i - 1], ga = GAP[ai], row = ai * N_SYM;
      cur[0] = prev[0] + ga;
      for (let j = 1; j <= m; j++) {
        const bj = b[j - 1];
        let v = prev[j] + ga;
        const ins = cur[j - 1] + GAP[bj];
        if (ins < v) v = ins;
        const sub = prev[j - 1] + SUB[row + bj];
        if (sub < v) v = sub;
        if (i > 1 && j > 1 && ai === b[j - 2] && a[i - 2] === bj) {
          const tr = prev2[j - 2] + 0.8;
          if (tr < v) v = tr;
        }
        cur[j] = v;
      }
      const t = prev2; prev2 = prev; prev = cur; cur = t;
    }
    if (!start) return prev[m];
    let best = prev[m];
    for (let j = Math.max(1, n - 1); j < m; j++) if (prev[j] < best) best = prev[j];
    return best;
  }

  // Plain Damerau–Levenshtein between the letters as typed.
  function letterDist(a, b, m = b.length) {
    const n = a.length;
    rows(m);
    let prev2 = R2, prev = R0, cur = R1;
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      const ai = a.charCodeAt(i - 1);
      cur[0] = i;
      for (let j = 1; j <= m; j++) {
        const bj = b.charCodeAt(j - 1);
        let v = prev[j] + 1;
        if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
        const sub = prev[j - 1] + (ai === bj ? 0 : 1);
        if (sub < v) v = sub;
        if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj && prev2[j - 2] + 1 < v) v = prev2[j - 2] + 1;
        cur[j] = v;
      }
      const t = prev2; prev2 = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  // One word, ready to compare: the letters, the key, the key as codes.
  const _words = new Map();
  function wordOf(w) {
    let it = _words.get(w);
    if (!it) {
      const k = soundKey(w);
      it = { w, k, c: codes(k) };
      if (_words.size > 20000) _words.clear();
      _words.set(w, it);
    }
    return it;
  }

  // How far a typed word is from a word of a name: 0 is the same word, and
  // anything past `limit` is not worth working out exactly. Both come as
  // wordOf() gives them.
  function scorePair(Q, W, limit = 1) {
    const q = Q.w, w = W.w, kq = Q.k, kw = W.k;
    if (q === w) return 0;
    if (q.length < MIN_LETTERS || w.length < MIN_LETTERS) return 1;
    if (kq === kw) return 0.02;   // said the same, spelt otherwise
    // A short word on file is mostly letters for something (SCS, STP, DPI):
    // it is offered for what sounds the same and nothing else — "Air" is Ayr,
    // but "Sksw" is not SCS.
    if (w.length <= MIN_LETTERS) return 1;
    const kmax = Math.max(kq.length, kw.length);
    // A short sound is near too many others to allow more than one vowel's
    // difference: "Mckay" is Mackay, "Kans" is Cairns.
    if (Math.min(kq.length, kw.length) <= 3) {
      const d = keyDist(Q.c, W.c, kw.length, false);
      return d <= 0.6 ? d / kmax : 1;
    }
    let best = 1;
    // The whole word — unless the lengths alone put it out of reach: every
    // letter one key has over the other costs at least a vowel's gap.
    if (Math.abs(kq.length - kw.length) * 0.6 / kmax <= limit) best = keyDist(Q.c, W.c, kw.length, false) / kmax;
    // The start of a longer word, for a word still being typed.
    if (kw.length > kq.length && kq.length >= MIN_PREFIX && PREFIX_COST < best) {
      const v = keyDist(Q.c, W.c, Math.min(kw.length, kq.length + 2), true) / kq.length + PREFIX_COST;
      if (v < best) best = v;
    }
    // A slip of the fingers: the letters themselves.
    const lm = w.length > q.length + 1 ? q.length + 1 : w.length;
    const lmax = Math.max(q.length, lm);
    const extra = (lm === w.length ? 0 : PREFIX_COST) + 0.02;
    if (Math.abs(q.length - lm) / lmax + extra < best) {
      const v = letterDist(q, w, lm) / lmax + extra;
      if (v < best) best = v;
    }
    return best;
  }
  const wordScore = (q, w) => scorePair(wordOf(q), wordOf(w));

  // ── The names, indexed ───────────────────────────────────────────────────
  // Each station's words, with where each sits in the name, built once per
  // list of stations. Thousands of names hold a few thousand distinct words,
  // so a typed word is scored once against each distinct word, not once per
  // station that uses it.
  let _idx = { list: null, n: -1, rows: null, words: null };
  function index(stations) {
    if (_idx.list === stations && _idx.n === stations.length) return _idx;
    const words = new Set();
    const rows = stations.map(s => {
      const name = String((s && s.name) || '');
      const toks = [];
      for (const m of name.matchAll(/[A-Za-z]+/g)) {
        const w = m[0].toLowerCase();
        toks.push({ w, start: m.index, end: m.index + m[0].length });
        words.add(w);
      }
      return { s, name, toks };
    });
    _idx = { list: stations, n: stations.length, rows, words: [...words].map(wordOf) };
    return _idx;
  }

  // The words of a query worth hearing: letters only — a number is an ALERT
  // address or a station number, and has a matcher of its own.
  function queryWords(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => /[a-z]/.test(w)).map(w => w.replace(/[^a-z]/g, ''));
  }

  function alternatives(w) {
    const alts = typeof abbrevExpansions === 'function' ? abbrevExpansions(w) : null;
    return alts && alts.length ? alts : [w];
  }

  // Every distinct word on file, scored against one typed word.
  function scoresFor(q, words) {
    const alts = alternatives(q).map(wordOf);
    const out = new Map();
    // Kept a little past the line, for a query of several words: one close
    // word can carry a word just past it into the average.
    const keep = MAX_SCORE + 0.2;
    for (const W of words) {
      let best = 1;
      for (const A of alts) {
        const v = scorePair(A, W, keep);
        if (v < best) best = v;
      }
      if (best <= keep) out.set(W.w, best);
    }
    return out;
  }

  // The stations whose names sound like `text`, nearest first:
  // [{ station, score, phrase }]. `filter(station)` leaves out what the box
  // asking could not use (a station with no position, say). Empty when the
  // text has too few letters to hear.
  function suggest(text, stations, { limit = 5, filter = null } = {}) {
    const qs = queryWords(text);
    const letters = qs.join('').length;
    if (!Array.isArray(stations) || !stations.length || letters < MIN_LETTERS) return [];
    const { rows, words } = index(stations);
    const perWord = qs.map(q => scoresFor(q, words));
    const weights = qs.map(q => Math.max(q.length, 2));
    const total = weights.reduce((a, b) => a + b, 0);
    // Two words typed for one written as one ("beer burrum"), or one for two.
    const joined = qs.length > 1 ? scoresFor(qs.join(''), words) : null;
    const out = [];
    for (const row of rows) {
      if (!row.toks.length) continue;
      if (filter && !filter(row.s)) continue;
      let sum = 0, lo = Infinity, hi = -1, ok = true;
      for (let k = 0; k < qs.length; k++) {
        let best = 1, at = -1;
        row.toks.forEach((t, i) => {
          const v = perWord[k].get(t.w);
          if (v != null && v < best) { best = v; at = i; }
        });
        if (at < 0) { ok = false; break; }
        sum += best * weights[k];
        lo = Math.min(lo, at); hi = Math.max(hi, at);
      }
      let score = ok ? sum / total : 1;
      if (joined) {
        row.toks.forEach((t, i) => {
          const v = joined.get(t.w);
          if (v != null && v + 0.02 < score) { score = v + 0.02; lo = hi = i; }
        });
      }
      if (score > MAX_SCORE || hi < 0) continue;
      const phrase = row.name.slice(row.toks[lo].start, row.toks[hi].end);
      out.push({ station: row.s, score, phrase, at: lo, len: row.name.length });
    }
    // Nearest first; then the name the word starts, then the shorter name —
    // "Gympie" before "Old Gympie Rd AL" — then the alphabet, so the list
    // holds still between two keystrokes that leave the scores alone.
    out.sort((a, b) => a.score - b.score || a.at - b.at || a.len - b.len || a.station.name.localeCompare(b.station.name));
    const cut = out.length ? out[0].score + SPREAD : 0;
    return out.filter(h => h.score <= cut).slice(0, limit).map(({ station, score, phrase }) => ({ station, score, phrase }));
  }

  // The spellings to offer a search box: each distinct phrase the nearest
  // stations landed on, with how many stations a search for it would find.
  // [{ phrase, count, score }], nearest first.
  function phrases(text, stations, { limit = 4 } = {}) {
    const near = suggest(text, stations, { limit: 60 });
    const seen = new Map();
    for (const h of near) {
      const k = h.phrase.toLowerCase();
      if (!seen.has(k)) seen.set(k, { phrase: h.phrase, score: h.score });
    }
    const names = index(stations).rows.map(r => r.name.toLowerCase());
    return [...seen.entries()].slice(0, limit).map(([k, v]) => ({
      phrase: v.phrase, score: v.score, count: names.filter(n => n.includes(k)).length,
    }));
  }

  // For a box that lists stations to pick: the stations alone, nearest first,
  // and the line that goes over them in place of "nothing matches".
  function stations(text, list, opts) {
    return suggest(text, list, opts).map(h => h.station);
  }
  function leadHtml(text) {
    return `Nothing is spelt “${esc(String(text || '').trim())}” — did you mean one of these?`;
  }

  // The names again on the next ask — a station renamed or removed under the
  // same list (app.js refreshFilterOptions).
  function reset() { _idx = { list: null, n: -1, rows: null, words: null }; }

  return { key: soundKey, suggest, phrases, stations, leadHtml, reset, _wordScore: wordScore };
})();
