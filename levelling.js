// MegaNet — levelling.js
//
//   Levelling   the arithmetic of a level survey and a two-peg test: a run
//               booked by rise and fall reduced to reduced levels, the three
//               closure checks and the misclose, the levels put into each
//               datum the site has (assumed, local gauge height, AHD), the
//               gauge boards against their face values, the water check, what
//               a survey still lacks before it is handed in, what it would
//               change at the station, and the rows every export is written
//               from (CSV, the workbook's sheets).
//
// Pure: a document in, numbers and sentences out. No page, no `state`, no
// network — level-survey.js, two-peg.js, survey-guide.js and level-store.js
// call it, and test/levels.mjs require()s this same file under Node through
// the `module.exports` at the foot, so the sums a phone shows in the field are
// the sums the check holds. The IIFE body only declares (`npm run toplevel`).
//
// ── Why integers ─────────────────────────────────────────────────────────────
// A run's three checks — ΣBS − ΣFS, ΣRise − ΣFall, last RL − first RL — are
// the same number by algebra, and a sheet that shows 0.001 against 0.000999…
// because of binary fractions teaches people to distrust it. So every reading
// is turned into whole hundredths of a millimetre (10 µm, finer than any level
// reads) the moment it is parsed, every sum and difference is done on those,
// and metres come back only for display. The three checks are then equal
// exactly whenever the run is booked properly, and when they are not, the
// booking is what is wrong — which is what the checks are for.
//
// ── How a run is booked ──────────────────────────────────────────────────────
// One point a row, in the order observed. The first row is the backsight on
// the opening benchmark, at the RL the survey declares for it. Each later row
// is an intermediate sight (IS), or a foresight (FS) — and a foresight with a
// backsight on the same row is a change point: the instrument moved and read
// back to the point it had just read forward to. A foresight with no
// backsight ends the run, which should be on the benchmark it opened on.
// Rise and fall are worked between each sight and the one before it from the
// same set-up — the backsight that began the set-up, or the last intermediate.
//
// ── Datums ───────────────────────────────────────────────────────────────────
// A survey declares one: AHD (the benchmark's RL is in AHD), ASSUMED (no
// established datum, so the benchmark is given 100.000 and everything is
// relative to it), or LGH (the benchmark's level is known on the gauge itself).
// Local gauge height is RL less gauge zero, so it needs a gauge zero in the
// same datum: given (from the station's records or the site pack), or found
// from a gauge board the survey nominates — the board's surveyed top less its
// face value. AHD is never made up: an assumed survey has no AHD column, and
// an LGH survey has one only where gauge zero's AHD level is known.

const Levelling = (function () {

  // ── Vocabularies ───────────────────────────────────────────────────────────

  // Hundredths of a millimetre per metre — see "Why integers".
  const U = 100000;

  const DATUMS = {
    AHD:     { label: 'AHD',                 long: 'Australian Height Datum',
               hint: 'The benchmark has an AHD level you can trust. Levels come out in AHD, and on the gauge once gauge zero is known.' },
    ASSUMED: { label: 'Assumed',             long: 'Assumed datum (benchmark 100.000)',
               hint: 'No trusted AHD connection. The primary benchmark is given 100.000 and everything is relative to it; gauge zero comes from a nominated gauge board.' },
    LGH:     { label: 'Local gauge height',  long: 'Local gauge datum (gauge zero = 0.000)',
               hint: 'The benchmark\'s level is known on the gauge itself. Levels come out on the gauge, and in AHD only where gauge zero\'s AHD level is known.' },
  };

  // What a point in the run is. `required` marks the kinds every survey has to
  // either survey or say are not there; `photo` the ones its photo set covers.
  const KINDS = {
    bm:    { label: 'Benchmark',              short: 'BM',    icon: '📍', photo: true },
    cp:    { label: 'Change point',           short: 'CP',    icon: '🔁' },
    board: { label: 'Gauge board',            short: 'Board', icon: '📏', photo: true, required: true },
    ctr:   { label: 'Sensor reference (CTR)', short: 'CTR',   icon: '🎯', photo: true, required: true },
    ctf:   { label: 'Cease to flow',          short: 'CTF',   icon: '🪨', photo: true, required: true },
    water: { label: 'Water surface',          short: 'Water', icon: '🌊', required: true },
    road:  { label: 'Road or crossing',       short: 'Road',  icon: '🛣️', photo: true },
    slab:  { label: 'Slab or tower base',     short: 'Slab',  icon: '🧱' },
    pit:   { label: 'Junction pit',           short: 'Pit',   icon: '🕳️' },
    other: { label: 'Other point',            short: 'Point', icon: '•' },
  };
  const KIND_ORDER = ['bm', 'cp', 'board', 'ctr', 'ctf', 'water', 'road', 'slab', 'pit', 'other'];

  const PURPOSES = {
    install:    'New installation',
    alteration: 'Alteration (orifice line, board or sensor replaced)',
    routine:    'Routine or inspection survey',
    event:      'Check after a flood or an impact',
    other:      'Other',
  };

  // The limits a survey is held to. Each is the survey's own (doc.tol) and
  // editable on the sheet, because a site pack can name a different figure;
  // these are what a new survey starts with.
  const TOL = {
    misclose: 0.003,   // |misclose| on closing back onto the opening benchmark, m
    board:    0.006,   // a gauge board further than this from its face value is adjusted, m
    pegtest:  0.003,   // a two-peg test's error, m
    sight:    30,      // a sight longer than this is flagged, m
    balance:  5,       // one set-up's backsight and foresight lengths further apart than this, m
    timeGap:  15,      // the water check's three readings further apart than this, minutes
    pegAge:   30,      // a two-peg test older than this many days before the survey is flagged
  };

  // ── Small parts ────────────────────────────────────────────────────────────

  // A reading as typed or read: "1.245", "1,245", " 1.2450 m", 1.245. Null for
  // anything that is not a number — never zero, which is a reading.
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s+/g, '').replace(/m$/i, '');
    if (!s) return null;
    if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const toU = v => { const n = num(v); return n == null ? null : Math.round(n * U); };
  const toM = u => (u == null ? null : u / U);

  // Metres to a fixed number of places, with the minus sign a negative zero
  // would otherwise lose (and a -0.000 it should not have).
  function fmt(v, dp = 3) {
    const n = typeof v === 'number' ? v : num(v);
    if (n == null) return '';
    const s = n.toFixed(dp);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  }
  function signed(v, dp = 3) {
    const n = typeof v === 'number' ? v : num(v);
    if (n == null) return '';
    const s = fmt(n, dp);
    return n > 0 && Number(s) !== 0 ? `+${s}` : s;
  }
  // A difference in millimetres, signed, for a sentence: "+2 mm", "−0.4 mm".
  function mm(v) {
    if (v == null) return '';
    const x = Math.round(v * 10000) / 10;
    const a = Math.abs(x);
    const t = Number.isInteger(a) ? String(a) : a.toFixed(1);
    return x === 0 ? '0 mm' : `${x > 0 ? '+' : '−'}${t} mm`;
  }

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const isUuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

  function today(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function clock(d = new Date()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  // "10:35" → minutes past midnight; null for anything else.
  function minutes(t) {
    const m = String(t || '').trim().match(/^(\d{1,2})[:.h](\d{2})/);
    if (!m) return null;
    const h = +m[1], n = +m[2];
    return h < 24 && n < 60 ? h * 60 + n : null;
  }
  // "2026-07-12" → "12/07/2026", the way the people reading the sheet write it.
  function dmy(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
  }
  function daysBetween(a, b) {
    const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`);
    return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null;
  }

  // The benchmark name a station's surveys use: BM<number>_<n>.
  function bmName(number, n = 1) {
    const s = String(number || '').trim().replace(/\s+/g, '');
    return s ? `BM${s}_${n}` : `BM_${n}`;
  }

  // An equipment line as people say it: "Leica LS15 · 701234".
  function kitLabel(k) {
    if (!k) return '';
    const name = [k.make, k.model].map(s => String(s || '').trim()).filter(Boolean).join(' ');
    const serial = String(k.serial || '').trim();
    return [name || (k.kind === 'staff' ? 'Staff' : 'Level'), serial].filter(Boolean).join(' · ');
  }

  // ── New documents ──────────────────────────────────────────────────────────

  function blankRow(kind = 'other', extra = {}) {
    return Object.assign({
      id: newId(), kind, name: '', bs: null, is: null, fs: null, bs_d: null, is_d: null, fs_d: null,
      face: null, state: '', scheduled: null, approx: false, time: '', desc: '', photos: [],
      lat: null, lon: null, acc: null,
    }, extra);
  }

  function blankSurvey(o = {}) {
    const st = o.station || {};
    const number = String(st.number || '').trim();
    const now = new Date().toISOString();
    return {
      id: newId(), type: 'level-survey', v: 1, practice: !!o.practice,
      created_at: now, updated_at: now,
      station: { id: st.id || null, number, name: st.name || '' },
      date: o.date || today(), purpose: o.purpose || '', notes: '',
      where: o.where || null,
      operator: o.operator || '', staff_holder: o.staff_holder || '', organisation: o.organisation || '',
      instrument: o.instrument || { id: null, make: '', model: '', serial: '', service_date: '' },
      staff: o.staff || null,
      peg_test: o.peg_test || null,
      datum: o.datum || 'AHD',
      bm: { name: bmName(number, 1), rl: o.datum === 'ASSUMED' ? 100 : null, source: '', description: '',
            lat: null, lon: null, acc: null },
      gauge_zero: { rl: null, source: '', from_row: null },
      rows: [],
      absent: {},
      water: { state: '', row: null, board: { value: null, time: '' }, logger: { value: null, time: '', source: '' }, note: '' },
      tol: { misclose: TOL.misclose, board: TOL.board, sight: TOL.sight, balance: TOL.balance },
      outcome_note: '',
      sync: { state: 'draft' },
    };
  }

  function blankTest(o = {}) {
    const now = new Date().toISOString();
    return {
      id: newId(), type: 'two-peg', v: 1, practice: !!o.practice,
      created_at: now, updated_at: now,
      date: o.date || today(), tester: o.tester || '', organisation: o.organisation || '',
      instrument: o.instrument || { id: null, make: '', model: '', serial: '', service_date: '' },
      spacing: o.spacing != null ? o.spacing : 50, near: o.near != null ? o.near : 5, location: '',
      a1: null, b1: null, a2: null, b2: null,
      tol: TOL.pegtest, action: '', photos: [], where: o.where || null,
      sync: { state: 'draft' },
    };
  }

  // ── The run ────────────────────────────────────────────────────────────────

  // The gauge zero a survey works to, in its own datum, and where it came from.
  // For an LGH survey, gauge zero *is* the datum (0), and `ahd` is its AHD
  // level where known.
  function gaugeZero(doc, rlByRow) {
    const g = doc.gauge_zero || {};
    const source = String(g.source || '').trim();
    if (doc.datum === 'LGH') {
      return { u: 0, how: 'datum', source, ahdU: toU(g.rl), from_row: null };
    }
    if (g.from_row) {
      const r = (doc.rows || []).find(x => x.id === g.from_row);
      const rl = rlByRow.get(g.from_row);
      const face = r ? toU(r.face) : null;
      if (r && rl != null && face != null) return { u: rl - face, how: 'board', source, from_row: r.id, ahdU: null };
      return { u: null, how: 'board', source, from_row: g.from_row, ahdU: null, pending: true };
    }
    const u = toU(g.rl);
    return { u, how: u == null ? '' : 'given', source, from_row: null, ahdU: null };
  }

  // Every column of one level, in metres: assumed, on the gauge, AHD.
  function columns(doc, rlU, gz) {
    if (rlU == null) return { ass: null, lgh: null, ahd: null };
    if (doc.datum === 'AHD') {
      return { ass: null, ahd: toM(rlU), lgh: gz.u != null ? toM(rlU - gz.u) : null };
    }
    if (doc.datum === 'ASSUMED') {
      return { ass: toM(rlU), ahd: null, lgh: gz.u != null ? toM(rlU - gz.u) : null };
    }
    return { ass: null, lgh: toM(rlU), ahd: gz.ahdU != null ? toM(rlU + gz.ahdU) : null };
  }

  // Reduce a run. Everything a sheet shows about the levels comes out of here:
  //
  //   rows[]    per row: role (open, is, cp, fs, close), set-up, rise, fall,
  //             RL in the declared datum and every column, and the problems
  //             found on that row
  //   sums      ΣBS, ΣFS, ΣRise, ΣFall, and the three checks
  //   misclose  closing RL less the opening benchmark's (signed), with the
  //             tolerance and whether it is within it
  //   setups    each set-up's sight lengths and how far out of balance
  //   boards    each gauge board's level on the gauge, its error against its
  //             face value, and the gauge zero it implies
  //   problems  [{ level: 'error'|'warn'|'info', code, row, text }]
  //
  // It never throws: a half-booked run reduces as far as it goes, and says
  // where it stopped.
  function reduce(doc) {
    const rows = Array.isArray(doc && doc.rows) ? doc.rows : [];
    const tol = Object.assign({}, TOL, (doc && doc.tol) || {});
    const problems = [];
    const say = (level, code, text, row = null) => problems.push({ level, code, text, row });
    const out = [];
    const rlByRow = new Map();
    const S = { bs: 0, fs: 0, rise: 0, fall: 0 };
    const setups = [];
    let prev = null;       // the last reading taken from the current set-up (U)
    let rl = null;         // the RL of the point it was taken on (U)
    let setup = 0;
    let ended = -1;        // the row a foresight with no backsight ended the run on
    let cps = 0;
    const bmU = toU(doc && doc.bm && doc.bm.rl);

    rows.forEach((r, i) => {
      const n = i + 1;
      const bs = toU(r.bs), is = toU(r.is), fs = toU(r.fs);
      const o = {
        id: r.id, n, kind: KINDS[r.kind] ? r.kind : 'other', name: r.name || '',
        bs: toM(bs), is: toM(is), fs: toM(fs), rise: null, fall: null, rl: null,
        ass: null, lgh: null, ahd: null, setup: null, role: '', problems: [],
      };
      const flag = (level, code, text) => { o.problems.push({ level, code, text }); say(level, code, `Row ${n}: ${text}`, r.id); };
      for (const [k, v] of [['bs', bs], ['is', is], ['fs', fs]]) {
        if (v == null) continue;
        if (v < 0) flag('warn', 'negative', `a negative ${k.toUpperCase()} (${fmt(toM(v))}) — an inverted staff? Check it.`);
        else if (v > 6 * U) flag('warn', 'long', `${k.toUpperCase()} ${fmt(toM(v))} m is longer than most staffs — check it.`);
      }

      if (i === 0) {
        o.role = 'open';
        if (bs == null) flag('error', 'open-bs', 'the run opens with a backsight on the primary benchmark — enter it.');
        if (is != null || fs != null) flag('error', 'open-only-bs', 'the first row takes a backsight only.');
        if (bmU == null) say('error', 'bm-rl', 'Give the primary benchmark its RL (Datum and control).');
        rl = bmU; prev = bs; setup = 1;
        o.rl = toM(rl); o.setup = 1;
        if (bs != null) { S.bs += bs; setups.push({ n: 1, from: r.id, bs_d: num(r.bs_d), fs_d: null, sights: [] }); }
        if (rl != null) rlByRow.set(r.id, rl);
        out.push(o);
        return;
      }

      if (ended >= 0) {
        flag('error', 'after-close',
          `follows row ${ended + 1}, a foresight with no backsight — the instrument has nothing to read from. `
          + `If row ${ended + 1} is a change point, add its backsight; otherwise this row is after the run closed.`);
        out.push(o);
        return;
      }

      if (is != null && fs != null) flag('error', 'is-and-fs', 'an intermediate and a foresight on one row — one point, one sight.');
      if (is != null && bs != null) flag('error', 'is-and-bs', 'a backsight belongs on a change point\'s row, with its foresight.');
      // A row carrying an intermediate as well is read as the intermediate, so
      // one mistyped row is one error rather than every row after it.
      const sight = is != null ? is : fs;
      if (sight == null) {
        if (bs != null) flag('error', 'bs-alone', 'a backsight with no foresight — a change point takes the foresight to it and the backsight from it on one row.');
        else o.role = 'pending';
        out.push(o);
        return;
      }
      if (prev == null) {
        flag('error', 'no-setup', 'no backsight to work from — the row before has none.');
        out.push(o);
        return;
      }
      const diff = prev - sight;
      o.rise = diff > 0 ? toM(diff) : null;
      o.fall = diff < 0 ? toM(-diff) : null;
      if (diff > 0) S.rise += diff; else S.fall -= diff;
      rl = rl != null ? rl + diff : null;
      o.rl = toM(rl); o.setup = setup;
      if (rl != null) rlByRow.set(r.id, rl);
      const cur = setups[setups.length - 1];
      if (cur) cur.sights.push({ row: r.id, d: num(is == null ? r.fs_d : r.is_d) });

      if (is == null && fs != null) {
        S.fs += fs;
        if (cur) cur.fs_d = num(r.fs_d);
        if (bs != null) {
          o.role = 'cp';
          S.bs += bs; prev = bs; setup++; cps++;
          setups.push({ n: setup, from: r.id, bs_d: num(r.bs_d), fs_d: null, sights: [] });
          if (o.kind === 'board') flag('warn', 'board-cp', 'a gauge board makes a poor change point — pick something solid that cannot move between set-ups.');
        } else {
          o.role = 'fs';
          ended = i;
        }
      } else {
        o.role = 'is';
        prev = is;
      }
      out.push(o);
    });

    // The last foresight closes the run.
    const last = ended >= 0 ? out[ended] : null;
    if (last) last.role = 'close';

    // ── Datums ──
    const gz = gaugeZero(doc || {}, rlByRow);
    for (const o of out) {
      const u = rlByRow.get(o.id);
      Object.assign(o, columns(doc || {}, u == null ? null : u, gz));
    }

    // ── The three checks and the misclose ──
    const firstU = rlByRow.get(rows[0] && rows[0].id);
    const lastRowWithRl = [...out].reverse().find(o => rlByRow.has(o.id) && o.role !== 'open');
    const lastU = lastRowWithRl ? rlByRow.get(lastRowWithRl.id) : null;
    const checks = {
      bsfs: S.bs - S.fs,
      risefall: S.rise - S.fall,
      lastfirst: firstU != null && lastU != null ? lastU - firstU : null,
    };
    const agree = checks.lastfirst != null && checks.bsfs === checks.risefall && checks.risefall === checks.lastfirst;

    let misclose = null, closesOnBm = false, closedOn = '';
    if (last) {
      const open = rows[0] || {};
      const lr = rows[ended] || {};
      const sameName = (lr.name || '').trim() && (lr.name || '').trim().toLowerCase() === (open.name || ((doc && doc.bm) || {}).name || '').trim().toLowerCase();
      closesOnBm = lr.kind === 'bm' && (sameName || !(lr.name || '').trim());
      const closeU = rlByRow.get(lr.id);
      if (closesOnBm && closeU != null && firstU != null) {
        misclose = toM(closeU - firstU);
        closedOn = 'opening';
      } else if (lr.kind === 'bm' && toU(lr.scheduled) != null && closeU != null) {
        misclose = toM(closeU - toU(lr.scheduled));
        closedOn = 'other';
        say('warn', 'closed-elsewhere', `The run closes on ${lr.name || 'another benchmark'}, not on the one it opened on — close back onto the opening benchmark.`);
      } else {
        say('error', 'not-on-bm', `The run's last foresight (row ${ended + 1}) is not on the primary benchmark — close back onto ${((doc && doc.bm) || {}).name || 'it'}.`);
      }
    } else if (rows.length > 1) {
      say('info', 'open', 'The run is still open — it closes with a foresight back onto the primary benchmark.');
    }
    const misU = misclose == null ? null : Math.round(misclose * U);
    const within = misclose == null ? null : Math.abs(misU) <= Math.round(tol.misclose * U);
    if (misclose != null && !within) {
      say('error', 'misclose', `Misclose ${signed(misclose)} m (${mm(misclose)}) is outside ±${fmt(tol.misclose)} m. `
        + 'Look for a booking slip, then re-read the run set-up by set-up before leaving.');
    }
    if (last && !agree && checks.lastfirst != null) {
      say('error', 'checks', 'The three checks do not agree — a booking error. Look for a row that is not a single sight.');
    }
    if (last && cps === 0) say('error', 'no-cp', 'No change point — every survey carries the level through at least one.');

    // ── Sight lengths ──
    for (const s of setups) {
      if (s.bs_d != null && s.fs_d != null && Math.abs(s.bs_d - s.fs_d) > tol.balance) {
        s.unbalanced = true;
        say('warn', 'balance', `Set-up ${s.n}: backsight ${fmt(s.bs_d, 1)} m against foresight ${fmt(s.fs_d, 1)} m — balance them so the line of sight's error cancels.`);
      }
      const longest = Math.max(s.bs_d || 0, s.fs_d || 0, ...s.sights.map(x => x.d || 0));
      s.longest = longest || null;
      if (longest > tol.sight) say('warn', 'sight', `Set-up ${s.n} has a ${fmt(longest, 1)} m sight — keep them to about ${tol.sight} m.`);
    }

    // ── Gauge boards ──
    const boards = [];
    for (const r of rows) {
      if (r.kind !== 'board') continue;
      const u = rlByRow.get(r.id);
      const face = toU(r.face);
      const o = out.find(x => x.id === r.id);
      const b = { id: r.id, n: o ? o.n : null, name: r.name || '', state: r.state || '', face: toM(face),
                  rl: toM(u), lgh: o ? o.lgh : null, error: null, implied: null, adjust: false, nominated: gz.from_row === r.id };
      if (face == null) {
        say('warn', 'face', `Row ${b.n}: give the gauge board its face value (the graduation at the point surveyed).`, r.id);
      } else if (u != null) {
        b.implied = doc.datum === 'LGH' ? null : toM(u - face);
        if (b.lgh != null) {
          b.error = toM(Math.round(b.lgh * U) - face);
          // Gauge zero found from this very board makes its own error nil by
          // construction; it is the others that say whether they agree.
          const established = gz.how !== 'board';
          if (!b.nominated && Math.abs(Math.round(b.error * U)) > Math.round(tol.board * U)) {
            b.adjust = established && b.state !== 'left';
            const what = established
              ? (b.state === 'left' ? 'still outside the limit as left' : 'outside the limit — adjust it, and survey it again as left')
              : 'does not agree with the nominated board — book both and raise it rather than splitting the difference';
            say('warn', 'board', `Row ${b.n}: ${b.name || 'gauge board'} reads ${signed(b.error)} m against its face value — ${what}.`, r.id);
          }
        }
      }
      boards.push(b);
    }

    // ── Benchmarks against their schedule ──
    for (const r of rows) {
      if (r.kind !== 'bm') continue;
      const sched = toU(r.scheduled), u = rlByRow.get(r.id);
      if (sched == null || u == null || r === rows[0]) continue;
      const d = u - sched;
      if (Math.abs(d) > Math.round(tol.misclose * U)) {
        say('warn', 'bm-schedule', `Row ${rows.indexOf(r) + 1}: ${r.name || 'benchmark'} comes out ${mm(toM(d))} from its listed level — note it and raise it; do not adopt the new figure on your own.`, r.id);
      }
    }

    if (gz.pending) say('warn', 'gz-board', 'Gauge zero is to come from a gauge board that has no level or face value yet.');
    if (gz.u == null && doc && doc.datum !== 'LGH') {
      say('info', 'gz', 'No gauge zero yet — levels on the gauge (LGH) appear once it is given or found from a nominated board.');
    }

    return {
      rows: out, problems,
      sums: { bs: toM(S.bs), fs: toM(S.fs), rise: toM(S.rise), fall: toM(S.fall) },
      checks: { bsfs: toM(checks.bsfs), risefall: toM(checks.risefall), lastfirst: toM(checks.lastfirst), agree },
      closed: !!last, closesOnBm, closedOn, misclose, within, tolerance: tol.misclose,
      setups, cps, boards,
      gaugeZero: { rl: toM(gz.u), ahd: toM(gz.ahdU), how: gz.how, source: gz.source, from_row: gz.from_row || null },
      errors: problems.filter(p => p.level === 'error').length,
      warnings: problems.filter(p => p.level === 'warn').length,
    };
  }

  // ── The water check ────────────────────────────────────────────────────────
  // The surveyed water surface, the gauge board read by eye and the logger, at
  // as near one clock time as the crew can manage. Differences are recorded
  // and flagged; nothing here passes or fails them — what the logger's offset
  // should be is decided afterwards, from all of it.
  function waterCheck(doc, red) {
    const w = doc.water || {};
    const state = w.state || '';
    const rows = doc.rows || [];
    const wr = (w.row && rows.find(r => r.id === w.row)) || [...rows].reverse().find(r => r.kind === 'water') || null;
    const wo = wr ? red.rows.find(o => o.id === wr.id) : null;
    const surveyed = wo ? (wo.lgh != null ? wo.lgh : null) : null;
    const board = num(w.board && w.board.value), logger = num(w.logger && w.logger.value);
    const times = [wr && wr.time, w.board && w.board.time, w.logger && w.logger.time].map(minutes);
    const known = times.filter(t => t != null);
    const spread = known.length > 1 ? Math.max(...known) - Math.min(...known) : null;
    const d = (a, b) => (a == null || b == null ? null : toM(Math.round(a * U) - Math.round(b * U)));
    const ctr = rows.find(r => r.kind === 'ctr');
    const ctrO = ctr ? red.rows.find(o => o.id === ctr.id) : null;
    const belowCtr = surveyed != null && ctrO && ctrO.lgh != null && surveyed <= ctrO.lgh;
    const out = {
      state, row: wr ? wr.id : null, surveyed, surveyedRl: wo ? wo.rl : null, surveyedTime: wr ? wr.time || '' : '',
      board, boardTime: (w.board && w.board.time) || '', logger, loggerTime: (w.logger && w.logger.time) || '',
      loggerSource: (w.logger && w.logger.source) || '',
      boardLessSurveyed: d(board, surveyed), loggerLessSurveyed: d(logger, surveyed), loggerLessBoard: d(logger, board),
      spread, belowCtr, notes: [],
    };
    if (state === 'dry' || state === 'below') {
      out.done = !!String(w.note || '').trim();
      if (!out.done) out.notes.push(state === 'dry' ? 'Say the site was dry in the comments.' : 'Say the water was below the sensor reference in the comments.');
      return out;
    }
    if (!wr) out.notes.push('Survey the water surface (a row of kind Water surface, with its time) — or say the site is dry.');
    else if (!wr.time) out.notes.push('Give the water-surface row its clock time.');
    if (wr && surveyed == null) out.notes.push('The water surface has no level on the gauge yet — it needs gauge zero.');
    if (board == null) out.notes.push('Read the gauge board, and note the time.');
    if (logger == null) out.notes.push('Note the logger\'s reading at the same time.');
    if (spread != null && spread > TOL.timeGap) out.notes.push(`The three readings are ${spread} minutes apart — take them as close to one time as you can.`);
    if (belowCtr) out.notes.push('The water is at or below the sensor reference: the logger cannot see it — say so and leave its reading out.');
    out.done = !!wr && surveyed != null && board != null && logger != null;
    return out;
  }

  // ── What the survey still lacks ────────────────────────────────────────────

  // The points every survey covers, each surveyed or said not to be there.
  function coverage(doc, red) {
    const rows = doc.rows || [];
    const has = k => rows.some(r => r.kind === k && (r.bs != null || r.is != null || r.fs != null));
    const absent = doc.absent || {};
    const why = k => String(absent[k] || '').trim();
    const water = doc.water || {};
    const items = [];
    const bmRows = rows.filter(r => r.kind === 'bm');
    items.push({ key: 'bm', label: 'The main benchmark, opened and closed on', ok: red.closed && red.closesOnBm && bmRows.length >= 2 });
    const boards = rows.filter(r => r.kind === 'board');
    items.push({ key: 'board', label: 'Each gauge board at its reference point, with the value printed there',
                 ok: (boards.length > 0 && boards.every(b => num(b.face) != null)) || !!why('board'), absent: why('board') });
    items.push({ key: 'ctr', label: 'The sensor reference (CTR) or orifice end', ok: has('ctr') || !!why('ctr'), absent: why('ctr') });
    items.push({ key: 'ctf', label: 'Cease to flow (an estimate is fine — say so)', ok: has('ctf') || !!why('ctf'), absent: why('ctf') });
    const wet = water.state !== 'dry' && water.state !== 'below';
    items.push({ key: 'water', label: 'Water surface with its time — or why there is none',
                 ok: wet ? rows.some(r => r.kind === 'water' && r.time && (r.is != null || r.fs != null)) : !!String(water.note || '').trim() });
    const bmPos = doc.bm && num(doc.bm.lat) != null && num(doc.bm.lon) != null;
    const ctrRow = rows.find(r => r.kind === 'ctr');
    const ctrPos = !ctrRow || (num(ctrRow.lat) != null && num(ctrRow.lon) != null) || !!why('ctr');
    items.push({ key: 'gps', label: 'GPS position of the benchmark and the CTR', ok: !!bmPos && ctrPos });
    return items;
  }

  // The final field check: everything a survey is handed in with, each item
  // ok (true), not yet (false), or not applicable (null), with what to do.
  function review(doc, red, test) {
    const items = [];
    const add = (key, label, ok, detail = '') => items.push({ key, label, ok, detail });
    add('closes', 'Starts and finishes on the main benchmark', red.closed && red.closesOnBm,
        red.closed ? (red.closesOnBm ? '' : 'The last foresight is not on the opening benchmark.') : 'The run is still open.');
    add('cp', 'At least one change point', red.cps > 0, red.cps ? `${red.cps} change point${red.cps === 1 ? '' : 's'}` : 'Carry the level through a change point.');
    const gzSaid = red.gaugeZero.rl != null || doc.datum === 'LGH' || !!String((doc.gauge_zero || {}).source || '').trim();
    add('datum', 'Datum, benchmark level and gauge-zero link all given',
        !!doc.datum && num(doc.bm && doc.bm.rl) != null && gzSaid && !!String((doc.bm || {}).source || '').trim(),
        num(doc.bm && doc.bm.rl) == null ? 'Give the benchmark its RL.'
          : !String((doc.bm || {}).source || '').trim() ? 'Say where the benchmark\'s RL came from.'
          : !gzSaid ? 'Give gauge zero, nominate a board, or say there is no relationship yet.' : '');
    const cov = coverage(doc, red);
    const missing = cov.filter(c => !c.ok);
    add('points', 'Each required point levelled, or noted as absent', missing.length === 0,
        missing.map(c => c.label).join('; '));
    const thin = (doc.rows || []).map((r, i) => ({ r, i })).filter(({ r }) => String(r.desc || '').trim().length < 15 || !String(r.name || '').trim());
    add('descriptions', 'Descriptions good enough to find each point again', thin.length === 0 && (doc.rows || []).length > 0,
        thin.length ? `Rows ${thin.slice(0, 8).map(x => x.i + 1).join(', ')}${thin.length > 8 ? '…' : ''} need a name and a fuller description.` : '');
    add('closure', 'The three totals match and the misclose is inside the limit', red.misclose != null && red.within && red.checks.agree,
        red.misclose == null ? 'No misclose until the run closes on the benchmark.'
          : `Misclose ${signed(red.misclose)} m against ±${fmt(red.tolerance)} m${red.checks.agree ? '' : '; the checks disagree'}.`);
    const wc = waterCheck(doc, red);
    add('water', 'Water check done, or why not said', !!wc.done, wc.notes.join(' '));
    const ins = doc.instrument || {};
    const kitOk = !!(String(ins.model || ins.make || '').trim() && String(ins.serial || '').trim() && String(ins.service_date || '').trim());
    add('kit', 'Instrument model, serial number and service date', kitOk,
        kitOk ? kitLabel(ins) : 'Pick the level from your equipment, or add it — with its serial number and service date.');
    let pegOk = false, pegDetail = 'Link the two-peg test done before this trip.';
    const pt = doc.peg_test;
    if (pt && pt.date) {
      const age = daysBetween(pt.date, doc.date);
      pegOk = pt.passed !== false && age != null && age >= 0 && age <= TOL.pegAge;
      pegDetail = pt.passed === false ? `The linked test failed (error ${fmt(pt.error_m)} m).`
        : age == null ? '' : age < 0 ? 'The linked test is dated after the survey.'
        : age > TOL.pegAge ? `The linked test is ${age} days old — test again before a trip, and after any knock.` : `${dmy(pt.date)}, error ${fmt(pt.error_m)} m`;
    }
    if (test) {
      const t = twoPeg(test);
      pegOk = pegOk && t.pass !== false;
    }
    add('pegtest', 'Two-peg test passed before the survey', pegOk, pegDetail);
    const teamOk = !!(String(doc.operator || '').trim() && String(doc.staff_holder || '').trim() && String(doc.organisation || '').trim());
    add('team', 'Level operator, staff holder and organisation', teamOk, teamOk ? '' : 'Name both of the crew and the organisation.');
    const ph = photoNeeds(doc);
    add('photos', 'Photos of each benchmark, gauge board, the CTR, the CTF and the site', ph.missing.length === 0,
        ph.missing.length ? `Still to take: ${ph.missing.join('; ')}.` : `${ph.count} photo${ph.count === 1 ? '' : 's'} attached.`);
    return items;
  }

  // The photo set: each benchmark close-up and in context, each gauge board,
  // the CTR, the CTF and a crossing where surveyed, and a site overview. A
  // photo attached to a row counts for that row — the same point booked twice
  // (a benchmark opened and closed on) is one point — and the overview is the
  // survey's own (doc.photos). A reading's picture of the level's display is
  // evidence for the number, not a photo of the point, and does not count.
  // `doc.photos_elsewhere` says the set was taken another way.
  function photoNeeds(doc) {
    const isShot = p => p && p.kind !== 'reading';
    let count = (doc.photos || []).filter(isShot).length;
    const groups = new Map();
    // The primary benchmark's own photos, taken with its details, count for it.
    const bm = doc.bm || {};
    if (String(bm.name || '').trim()) {
      const shots = (bm.photos || []).filter(isShot).length;
      count += shots;
      groups.set(`bm:${String(bm.name).trim().toLowerCase()}`, { kind: 'bm', name: String(bm.name).trim(), have: shots });
    }
    for (const r of doc.rows || []) {
      const shots = (r.photos || []).filter(isShot).length;
      count += shots;
      if (!KINDS[r.kind] || !KINDS[r.kind].photo) continue;
      const key = `${r.kind}:${String(r.name || '').trim().toLowerCase() || r.id}`;
      const g = groups.get(key) || { kind: r.kind, name: String(r.name || '').trim(), have: 0 };
      g.have += shots;
      groups.set(key, g);
    }
    if (doc.photos_elsewhere) return { count, missing: [] };
    const missing = [];
    for (const g of groups.values()) {
      const need = g.kind === 'bm' ? 2 : 1;
      if (g.have < need) missing.push(`${KINDS[g.kind].short}${g.name ? ` ${g.name}` : ''}${g.kind === 'bm' ? ' (close-up and in context)' : ''}`);
    }
    if (!(doc.photos || []).filter(isShot).length) missing.push('a site overview');
    return { count, missing };
  }

  // ── The two-peg test ───────────────────────────────────────────────────────
  // Set-up 1 midway between the pegs gives their true difference, because a
  // tilted line of sight errs equally over equal sights. Set-up 2 near peg A
  // reads the same difference through unequal sights; what is left over is the
  // tilt. With the instrument `near` metres from A and the pegs `spacing`
  // apart, the long sight to B is spacing − near, and
  //
  //   tilt (m per m) = (d1 − d2) / (spacing − 2·near)
  //
  // since the two sights differ by spacing − 2·near. From it, the reading B
  // should have given at set-up 2 — what an adjusted instrument reads — and the
  // error over a 30 m sight, which is the one people can picture.
  function twoPeg(t) {
    const a1 = toU(t.a1), b1 = toU(t.b1), a2 = toU(t.a2), b2 = toU(t.b2);
    const tol = num(t.tol) != null ? num(t.tol) : TOL.pegtest;
    const out = { d1: null, d2: null, error: null, pass: null, tilt: null, per30: null, bShould: null, ready: false, tol };
    if (a1 != null && b1 != null) out.d1 = toM(a1 - b1);
    if (a2 != null && b2 != null) out.d2 = toM(a2 - b2);
    if (out.d1 == null || out.d2 == null) return out;
    const e = Math.abs((a1 - b1) - (a2 - b2));
    out.error = toM(e);
    out.pass = e <= Math.round(tol * U);
    out.ready = true;
    const spacing = num(t.spacing), near = num(t.near);
    const span = spacing != null && near != null ? spacing - 2 * near : null;
    if (span && span > 0) {
      const tilt = ((a1 - b1) - (a2 - b2)) / U / span;            // + : the line of sight rises with distance
      out.tilt = tilt;
      out.per30 = tilt * 30;
      out.bShould = toM(b2) - tilt * (spacing - near);
    }
    return out;
  }

  // ── What a survey would change at the station ──────────────────────────────
  // For an administrator deciding: each thing the survey established, beside
  // what the station holds now, ticked by default only where it is new, the
  // survey closed within tolerance and the figure is the survey's own. Nothing
  // here writes anything — meganet.level_survey_apply() does, and only for an
  // administrator.
  //
  // `current` is what the station holds: { gauge_survey: [...] (stations.json's
  // rows), points: [station_level_point rows], offset: latest offset row }.
  function stationChanges(doc, red, current = {}) {
    const out = [];
    const good = red.closed && red.within && red.checks.agree;
    const gsRows = (current.gauge_survey || []).filter(g => !g.valid_to);
    const gsNow = gsRows.length ? gsRows[gsRows.length - 1] : null;
    const datumCode = doc.datum === 'AHD' ? 'AHD' : doc.datum === 'ASSUMED' ? 'ASSUM' : null;
    // Gauge zero: an AHD or assumed survey's own, or an LGH survey's AHD level
    // of gauge zero where it was given.
    let gz = null, gzDatum = null;
    if (doc.datum === 'LGH') { gz = red.gaugeZero.ahd; gzDatum = gz != null ? 'AHD' : null; }
    else { gz = red.gaugeZero.rl; gzDatum = datumCode; }
    if (gz != null && gzDatum) {
      const same = gsNow && num(gsNow.gauge_zero_m) != null && Math.abs(num(gsNow.gauge_zero_m) - gz) < 0.0005 && gsNow.datum === gzDatum;
      out.push({
        key: 'gauge_zero', group: 'Gauge zero', label: `Gauge zero ${fmt(gz)} m ${gzDatum === 'ASSUM' ? 'assumed' : gzDatum}`,
        from: gsNow ? `${fmt(num(gsNow.gauge_zero_m))} m ${gsNow.datum || ''} since ${dmy(gsNow.valid_from) || '—'}` : 'none recorded',
        value: { gauge_zero_m: Number(fmt(gz)), datum: gzDatum, valid_from: doc.date,
                 note: `Level survey ${dmy(doc.date)}${red.gaugeZero.how === 'board' ? ' (from the nominated gauge board)' : ''}` },
        on: good && !same && red.gaugeZero.how === 'board', same,
        why: red.gaugeZero.how === 'board' ? '' : 'The survey worked to this gauge zero rather than finding it — tick it only to record it.',
      });
    }
    // Benchmarks: the primary as declared, and any other surveyed with a level.
    const pts = current.points || [];
    const cur = (kind, name) => pts.find(p => p.kind === kind && !p.superseded_at && String(p.name || '').toLowerCase() === String(name || '').toLowerCase());
    const bm = doc.bm || {};
    if (String(bm.name || '').trim() && num(bm.rl) != null) {
      const now = cur('bm', bm.name);
      const same = now && num(now.rl) != null && Math.abs(num(now.rl) - num(bm.rl)) < 0.0005 && (now.description || '') === (bm.description || '');
      out.push({
        key: `bm:${bm.name}`, group: 'Benchmarks', label: `${bm.name} (primary) — RL ${fmt(num(bm.rl))} m ${DATUMS[doc.datum] ? DATUMS[doc.datum].label : doc.datum}`,
        from: now ? `RL ${fmt(num(now.rl))} m ${now.datum || ''}` : 'not recorded',
        value: { kind: 'bm', name: bm.name.trim(), primary: true, rl: num(bm.rl), datum: datumCode || 'LGH',
                 rl_lgh: red.rows[0] ? red.rows[0].lgh : null, description: bm.description || '', source: bm.source || '',
                 lat: num(bm.lat), lon: num(bm.lon) },
        on: good && !same, same,
      });
    }
    const seen = new Set([String(bm.name || '').toLowerCase()]);
    const pointKinds = { bm: 'Benchmarks', ctr: 'Sensor reference', ctf: 'Cease to flow', board: 'Gauge boards', slab: 'Other points', road: 'Other points', pit: 'Other points' };
    for (const o of red.rows) {
      const r = (doc.rows || []).find(x => x.id === o.id);
      if (!r || !pointKinds[r.kind] || o.rl == null) continue;
      if (r.kind === 'board' && r.state === 'found' && (doc.rows || []).some(x => x.kind === 'board' && x.state === 'left' && x.name === r.name)) continue;
      const name = String(r.name || '').trim() || (r.kind === 'board' && num(r.face) != null ? `Gauge board ${fmt(num(r.face))}` : KINDS[r.kind].label);
      const k = `${r.kind}:${name.toLowerCase()}`;
      if (seen.has(k) || (r.kind === 'bm' && seen.has(name.toLowerCase()))) continue;
      seen.add(k);
      const now = cur(r.kind, name);
      const lgh = o.lgh;
      const same = now && ((lgh != null && num(now.rl_lgh) != null && Math.abs(num(now.rl_lgh) - lgh) < 0.0005)
                        || (lgh == null && num(now.rl) != null && Math.abs(num(now.rl) - o.rl) < 0.0005));
      out.push({
        key: `${r.kind}:${name}`, group: pointKinds[r.kind],
        label: `${name} — ${lgh != null ? `${fmt(lgh)} m on the gauge` : `RL ${fmt(o.rl)} m`}${r.kind === 'ctf' && r.approx ? ' (approximate)' : ''}`,
        from: now ? (num(now.rl_lgh) != null ? `${fmt(num(now.rl_lgh))} m on the gauge` : `RL ${fmt(num(now.rl))} m`) : 'not recorded',
        value: { kind: r.kind, name, primary: false, rl: o.rl, datum: datumCode || 'LGH', rl_lgh: lgh, rl_ahd: o.ahd,
                 face_value: num(r.face), approx: !!r.approx, description: r.desc || '', lat: num(r.lat), lon: num(r.lon) },
        on: good && !same && r.kind !== 'bm', same,
      });
    }
    // The telemetry offset: what the water check says the logger is out by.
    const wc = waterCheck(doc, red);
    if (wc.loggerLessSurveyed != null && !wc.belowCtr) {
      const corr = -wc.loggerLessSurveyed;
      out.push({
        key: 'offset', group: 'Telemetry offset',
        label: `Correct the logger by ${signed(corr)} m (it read ${signed(wc.loggerLessSurveyed)} m against the surveyed water surface)`,
        from: current.offset ? `last changed ${dmy(current.offset.valid_from)} (${signed(num(current.offset.correction_m))} m)` : 'no change recorded',
        value: { correction_m: Number(fmt(corr)), valid_from: doc.date, logger_m: wc.logger, surveyed_m: wc.surveyed, board_m: wc.board,
                 note: `Water check ${dmy(doc.date)} ${wc.surveyedTime || ''}`.trim() },
        on: false, same: Math.abs(corr) < 0.0005,
        why: 'Decided in the office: the offset is changed in the logger and recorded here.',
      });
    }
    return out;
  }

  // ── Stations near a point ──────────────────────────────────────────────────
  // The few nearest, within `km`, each with how far — for "which station am I
  // at?" when a survey is started. Equirectangular, which is metres-good at
  // these distances.
  function nearest(list, lat, lon, o = {}) {
    const n = o.n || 5, km = o.km || 10;
    if (!Array.isArray(list) || num(lat) == null || num(lon) == null) return [];
    const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.574;
    const dLat = km / ky, dLon = km / Math.max(1e-6, kx);
    const out = [];
    for (const s of list) {
      if (!s || s.lat == null || s.lon == null || s.proposed) continue;
      if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLon) continue;
      const d = Math.hypot((s.lat - lat) * ky, (s.lon - lon) * kx);
      if (d <= km) out.push({ s, km: d });
    }
    return out.sort((a, b) => a.km - b.km).slice(0, n);
  }

  // ── Words for descriptions ─────────────────────────────────────────────────
  // A point described so another crew finds the same spot: what it is (the
  // identifier), what was read (the construction or reference point), where
  // (unambiguously), then anything useful (the time, a photo). These are
  // starting points the sheet offers as taps; the crew finishes the sentence.
  const HINT = {
    bm:    'Name — what the mark is (pin in concrete, bolt in rock), exactly where. Primary? RL and datum.',
    cp:    'CP number — the stable thing it is (rock, concrete edge, bolt), which bank, how far from the boards.',
    board: 'Which board (its range), the face value at the point read, which bank.',
    ctr:   'CTR — the exact fitting and the point on it (top of the brass cap), where the line ends.',
    ctf:   'CTF — the feature that controls flow (rock bar, causeway crest); say if it is approximate.',
    water: 'Water surface — the time, and where the staff stood.',
    road:  'Crown of the road or crossing — its name, how far up or downstream.',
    slab:  'Slab or tower base — which corner or edge.',
    pit:   'Junction pit — which pit along the line, where the staff stood.',
    other: 'What it is, the exact point read, and where it is.',
  };
  function suggestDesc(kind, r = {}, doc = {}) {
    const face = num(r.face);
    switch (kind) {
      case 'bm':    return `${r.name || bmName(doc.station && doc.station.number)} — survey pin in concrete, `;
      case 'cp':    return `${r.name || 'CP1'} — `;
      case 'board': return face != null ? `Top of the ${fmt(face - 1, 0)}–${fmt(face, 0)} m gauge board, face value ${fmt(face)} m, ` : 'Top of the gauge board, face value ';
      case 'ctr':   return 'CTR — top of the fitting at the end of the orifice line, ';
      case 'ctf':   return `${r.approx ? 'Approximate CTF' : 'CTF'} — crown of the control, `;
      case 'water': return `Water surface at ${r.time || clock()}, beside the gauge boards`;
      case 'road':  return 'Crown of the crossing, ';
      case 'slab':  return 'Instrument slab, ';
      case 'pit':   return 'Junction pit on the orifice line, ';
      default:      return '';
    }
  }

  // ── Exports: the rows ──────────────────────────────────────────────────────

  function title(doc) {
    const st = doc.station || {};
    const who = [st.number, st.name].filter(s => String(s || '').trim()).join(' · ') || 'Unnamed site';
    return `${who} — ${dmy(doc.date)}`;
  }
  // floodnet-level-survey-143001C-2026-07-12
  function fileStem(doc, kind = 'level-survey') {
    const st = doc.station || {};
    const tag = String(st.number || st.id || st.name || 'site').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
    return `floodnet-${kind}-${tag}-${doc.date || today()}${doc.practice ? '-practice' : ''}`;
  }

  // A CSV cell as Excel opens it: quoted where it must be, and a text cell that
  // starts like a formula given a leading apostrophe so a spreadsheet shows it
  // rather than runs it. Numbers are written as numbers.
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function csvText(rows) { return `﻿${rows.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`; }
  const n3 = v => (v == null ? null : Number(fmt(v)));

  // One row a sight, every column the sheet has, each row carrying its
  // station and date so files from many surveys can be stacked.
  function surveyCsv(doc, red) {
    const st = doc.station || {};
    const head = ['Station number', 'Station name', 'Survey date', 'Datum', 'Row', 'Point', 'Kind',
                  'BS (m)', 'IS (m)', 'FS (m)', 'Rise (m)', 'Fall (m)', 'RL assumed (m)', 'RL LGH (m)', 'RL AHD (m)',
                  'Face value (m)', 'Board error (m)', 'BS distance (m)', 'IS distance (m)', 'FS distance (m)',
                  'Time', 'Description', 'Photos'];
    const out = [head];
    (doc.rows || []).forEach((r, i) => {
      const o = red.rows[i] || {};
      const b = red.boards.find(x => x.id === r.id);
      out.push([st.number || '', st.name || '', doc.date || '', DATUMS[doc.datum] ? DATUMS[doc.datum].label : doc.datum, i + 1,
                r.name || '', KINDS[r.kind] ? KINDS[r.kind].label : r.kind,
                n3(num(r.bs)), n3(num(r.is)), n3(num(r.fs)), n3(o.rise), n3(o.fall), n3(o.ass), n3(o.lgh), n3(o.ahd),
                n3(num(r.face)), b ? n3(b.error) : null, num(r.bs_d), num(r.is_d), num(r.fs_d),
                r.time || '', r.desc || '', (r.photos || []).length || null]);
    });
    out.push(['', '', '', '', 'Σ', '', '', n3(red.sums.bs), null, n3(red.sums.fs), n3(red.sums.rise), n3(red.sums.fall)]);
    out.push(['', '', '', '', 'Misclose', red.misclose == null ? '' : n3(red.misclose), `tolerance ±${fmt(red.tolerance)}`,
              red.misclose == null ? 'open' : red.within ? 'PASS' : 'FAIL']);
    return csvText(out);
  }

  function testCsv(t) {
    const r = twoPeg(t);
    const ins = t.instrument || {};
    return csvText([
      ['Test date', 'Tester', 'Organisation', 'Instrument', 'Serial', 'Service date', 'Peg spacing (m)', 'Near distance (m)',
       'Setup 1 A (m)', 'Setup 1 B (m)', 'Difference 1 (m)', 'Setup 2 A (m)', 'Setup 2 B (m)', 'Difference 2 (m)',
       'Error (m)', 'Tolerance (m)', 'Result', 'Error per 30 m (m)', 'B should read (m)', 'Location', 'Action if failed'],
      [t.date || '', t.tester || '', t.organisation || '', [ins.make, ins.model].filter(Boolean).join(' '), ins.serial || '',
       ins.service_date || '', num(t.spacing), num(t.near), n3(num(t.a1)), n3(num(t.b1)), n3(r.d1), n3(num(t.a2)), n3(num(t.b2)),
       n3(r.d2), n3(r.error), r.tol, r.ready ? (r.pass ? 'PASS' : 'FAIL') : 'incomplete',
       r.per30 == null ? null : Number(r.per30.toFixed(4)), r.bShould == null ? null : n3(r.bShould), t.location || '', t.action || ''],
    ]);
  }

  // ── Exports: the workbook's sheets ─────────────────────────────────────────
  // Cells for xlsx-write.js: a value, or { v, s } with a style it names, or
  // { f, v, s } for a formula with its answer cached. Laid out the way a level
  // book reads: the site and its control first, the water check, then the
  // run, its sums and the closure.
  function workbook(doc, red, opts = {}) {
    const st = doc.station || {};
    const T = (v, s) => ({ v: v == null ? '' : v, s });
    const N = (v, s = 'num3') => (v == null ? '' : { v: Number(fmt(v)), s });
    const L = v => T(v, 'label');
    const ins = doc.instrument || {}, staff = doc.staff || null, pt = doc.peg_test || null;
    const wc = waterCheck(doc, red);
    const datumLabel = DATUMS[doc.datum] ? DATUMS[doc.datum].long : doc.datum;
    const rows = [];
    const merges = [];
    const push = r => { rows.push(r); return rows.length; };
    const section = text => { const n = push([T(text, 'section'), ...Array(12).fill(T('', 'section'))]); merges.push(`A${n}:M${n}`); };

    let n = push([T('Level survey — rise and fall', 'title')]); merges.push(`A${n}:M${n}`);
    n = push([T(`${[st.number, st.name].filter(Boolean).join(' · ') || 'Unnamed site'} · ${dmy(doc.date)} · ${datumLabel}${doc.practice ? ' · PRACTICE — not a record' : ''}`, 'sub')]);
    merges.push(`A${n}:M${n}`);
    push([]);
    section('SITE AND SURVEY');
    push([L('Survey date'), T(dmy(doc.date)), '', L('Station number'), T(st.number || ''), '', L('Station name'), T(st.name || '', 'text')]);
    n = push([L('Purpose'), T(PURPOSES[doc.purpose] || doc.purpose || '', 'text')]); merges.push(`B${n}:M${n}`);
    n = push([L('Field notes'), T(doc.notes || '', 'text')]); merges.push(`B${n}:M${n}`);
    push([]);
    section('DATUM AND CONTROL');
    push([L('Datum'), T(datumLabel), '', L('Benchmark'), T((doc.bm || {}).name || ''), '', L('Benchmark RL (m)'), N(num((doc.bm || {}).rl))]);
    push([L('RL source'), T((doc.bm || {}).source || '', 'text'), '', L('Gauge zero RL (m)'),
          doc.datum === 'LGH' ? T('0.000 (datum)') : N(red.gaugeZero.rl), '', L('Gauge zero from'),
          T(red.gaugeZero.how === 'board' ? 'the nominated gauge board' : ((doc.gauge_zero || {}).source || ''), 'text')]);
    if (doc.datum === 'LGH') push([L('Gauge zero AHD (m)'), N(red.gaugeZero.ahd)]);
    n = push([L('Benchmark details'), T((doc.bm || {}).description || '', 'text')]); merges.push(`B${n}:M${n}`);
    const bmPos = doc.bm && num(doc.bm.lat) != null ? `${num(doc.bm.lat).toFixed(6)}, ${num(doc.bm.lon).toFixed(6)}${num(doc.bm.acc) != null ? ` (±${Math.round(num(doc.bm.acc))} m)` : ''}` : '';
    push([L('Benchmark position'), T(bmPos)]);
    push([]);
    section('INSTRUMENT, TWO-PEG TEST AND TEAM');
    push([L('Level'), T([ins.make, ins.model].filter(Boolean).join(' '), 'text'), '', L('Serial number'), T(ins.serial || ''), '', L('Service date'), T(dmy(ins.service_date || ''))]);
    if (staff) push([L('Staff'), T([staff.make, staff.model].filter(Boolean).join(' '), 'text'), '', L('Serial number'), T(staff.serial || '')]);
    push([L('Two-peg test'), T(pt ? dmy(pt.date) : 'not linked'), '', L('Error (m)'), pt ? N(num(pt.error_m)) : '', '', L('Result'),
          pt ? T(pt.passed === false ? 'FAIL' : 'PASS', pt.passed === false ? 'bad' : 'ok') : '']);
    push([L('Level operator'), T(doc.operator || ''), '', L('Staff holder'), T(doc.staff_holder || ''), '', L('Organisation'), T(doc.organisation || '', 'text')]);
    push([]);
    section('SIMULTANEOUS WATER CHECK');
    push([T('Reading', 'head'), T('Value (m)', 'head'), T('Time', 'head'), T('Comments', 'head')]);
    if (wc.state === 'dry' || wc.state === 'below') {
      n = push([T(wc.state === 'dry' ? 'Site dry' : 'Water below the sensor reference'), '', '', T((doc.water || {}).note || '', 'text')]);
      merges.push(`D${n}:M${n}`);
    } else {
      n = push([T('Surveyed water surface (LGH)'), N(wc.surveyed), T(wc.surveyedTime), T((doc.water || {}).note || '', 'text')]); merges.push(`D${n}:M${n}`);
      n = push([T('Gauge board reading'), N(wc.board), T(wc.boardTime), T(wc.boardLessSurveyed == null ? '' : `${mm(wc.boardLessSurveyed)} from the surveyed level`, 'text')]); merges.push(`D${n}:M${n}`);
      n = push([T('Logger reading'), N(wc.logger), T(wc.loggerTime), T(wc.loggerLessSurveyed == null ? '' : `${mm(wc.loggerLessSurveyed)} from the surveyed level${wc.loggerSource ? ` (${wc.loggerSource})` : ''}`, 'text')]); merges.push(`D${n}:M${n}`);
    }
    push([]);
    section('LEVEL RUN — RISE AND FALL');
    const head = push(['No.', 'BS (m)', 'IS (m)', 'FS (m)', 'Rise (m)', 'Fall (m)', 'RL Ass (m)', 'RL LGH (m)', 'RL AHD (m)', 'Point', 'Description', 'Time', 'Photos'].map(h => T(h, 'head')));
    const first = head + 1;
    (doc.rows || []).forEach((r, i) => {
      const o = red.rows[i] || {};
      push([{ v: i + 1, s: 'int' }, N(num(r.bs)), N(num(r.is)), N(num(r.fs)), N(o.rise), N(o.fall), N(o.ass), N(o.lgh), N(o.ahd),
            T(r.name || (KINDS[r.kind] ? KINDS[r.kind].short : ''), 'text'), T(r.desc || '', 'text'), T(r.time || ''),
            (r.photos || []).length ? { v: (r.photos || []).length, s: 'int' } : '']);
    });
    const lastRow = rows.length;
    const sum = (col, v) => (lastRow >= first ? { f: `SUM(${col}${first}:${col}${lastRow})`, v: Number(fmt(v)), s: 'num3b' } : N(v, 'num3b'));
    push([T('Σ', 'sum'), sum('B', red.sums.bs), T('', 'sum'), sum('D', red.sums.fs), sum('E', red.sums.rise), sum('F', red.sums.fall),
          T('', 'sum'), T('', 'sum'), T('', 'sum'),
          T(`ΣBS−ΣFS ${signed(red.checks.bsfs)} · ΣRise−ΣFall ${signed(red.checks.risefall)} · Last−First ${signed(red.checks.lastfirst)}${red.checks.agree ? ' ✓' : ''}`, 'sum')]);
    push([]);
    const verdict = red.misclose == null ? T('OPEN', 'warn') : red.within ? T('PASS', 'ok') : T('FAIL', 'bad');
    push([T('Closure', 'label'), T('Misclose (m)', 'label'), red.misclose == null ? '' : { v: Number(fmt(red.misclose)), s: 'num3s' },
          T('Tolerance (m)', 'label'), { v: red.tolerance, s: 'num3' }, verdict]);
    if (doc.outcome_note) { n = push([L('Action taken'), T(doc.outcome_note, 'text')]); merges.push(`B${n}:M${n}`); }

    const sheets = [{
      name: 'Survey', rows, merges,
      cols: [7, 9, 9, 9, 9, 9, 10, 10, 10, 18, 48, 7, 7],
      freeze: null, landscape: true, fitWidth: true,
    }];

    // Gauge boards, and checks.
    if (red.boards.length) {
      const b = [[T('Gauge boards', 'title')], [],
        ['Row', 'Board', 'State', 'Face value (m)', 'RL (m)', 'LGH (m)', 'Error (m)', 'Implied gauge zero (m)', 'Note'].map(h => T(h, 'head'))];
      for (const x of red.boards) {
        b.push([{ v: x.n, s: 'int' }, T(x.name || '', 'text'), T(x.state === 'found' ? 'as found' : x.state === 'left' ? 'as left' : ''),
                N(x.face), N(x.rl), N(x.lgh), x.error == null ? '' : { v: Number(fmt(x.error)), s: x.adjust ? 'num3bad' : 'num3s' },
                N(x.implied), T(x.nominated ? 'nominated: gauge zero found from this board' : x.adjust ? 'outside the limit — adjust' : '', 'text')]);
      }
      sheets.push({ name: 'Gauge boards', rows: b, cols: [6, 22, 10, 12, 10, 10, 10, 18, 40] });
    }
    const checks = review(doc, red, opts.test || null);
    const c = [[T('Final field check', 'title')], [], ['Check', 'Result', 'Detail'].map(h => T(h, 'head'))];
    for (const x of checks) c.push([T(x.label, 'text'), x.ok ? T('✓ done', 'ok') : T('✗ not yet', 'bad'), T(x.detail || '', 'text')]);
    c.push([]);
    c.push([T('Problems found in the run', 'label')]);
    for (const p of red.problems) c.push([T(p.level === 'error' ? 'Error' : p.level === 'warn' ? 'Check' : 'Note', p.level === 'error' ? 'bad' : p.level === 'warn' ? 'warn' : 'text'), '', T(p.text, 'text')]);
    sheets.push({ name: 'Checks', rows: c, cols: [46, 12, 80] });

    if (opts.test) sheets.push(testSheet(opts.test));
    if (opts.photos && opts.photos.length) {
      const p = [[T('Photos and readings', 'title')], [],
        ['File', 'Row', 'Point', 'What', 'Value (m)', 'Read by OCR', 'Taken', 'Latitude', 'Longitude'].map(h => T(h, 'head'))];
      for (const x of opts.photos) {
        p.push([T(x.file || ''), x.row ? { v: x.row, s: 'int' } : '', T(x.point || '', 'text'), T(x.what || '', 'text'),
                x.value == null ? '' : N(x.value), T(x.ocr || '', 'text'), T(x.taken || ''),
                x.lat == null ? '' : { v: x.lat, s: 'deg' }, x.lon == null ? '' : { v: x.lon, s: 'deg' }]);
      }
      sheets.push({ name: 'Photos', rows: p, cols: [34, 6, 18, 18, 10, 24, 18, 12, 12] });
    }
    return sheets;
  }

  function testSheet(t) {
    const r = twoPeg(t);
    const T = (v, s) => ({ v: v == null ? '' : v, s });
    const N = (v, s = 'num3') => (v == null ? '' : { v: Number(fmt(v)), s });
    const L = v => T(v, 'label');
    const ins = t.instrument || {};
    const rows = [
      [T('Two-peg test — instrument collimation check', 'title')],
      [T(`${[ins.make, ins.model].filter(Boolean).join(' ')}${ins.serial ? ` · ${ins.serial}` : ''} · ${dmy(t.date)}${t.practice ? ' · PRACTICE — not a record' : ''}`, 'sub')],
      [],
      [L('Test date'), T(dmy(t.date)), L('Tester'), T(t.tester || ''), L('Organisation'), T(t.organisation || '', 'text')],
      [L('Level'), T([ins.make, ins.model].filter(Boolean).join(' ')), L('Serial number'), T(ins.serial || ''), L('Service date'), T(dmy(ins.service_date || ''))],
      [L('Peg spacing (m)'), N(num(t.spacing), 'num1'), L('Set-up 2 from A (m)'), N(num(t.near), 'num1'), L('Location'), T(t.location || '', 'text')],
      [],
      ['Set-up', 'Instrument position', 'Reading A (m)', 'Reading B (m)', 'Difference A − B (m)'].map(h => T(h, 'head')),
      [T('Set-up 1'), T('Midway between the pegs'), N(num(t.a1)), N(num(t.b1)), N(r.d1, 'num3s')],
      [T('Set-up 2'), T(`About ${fmt(num(t.near), 0) || '5'} m from peg A`), N(num(t.a2)), N(num(t.b2)), N(r.d2, 'num3s')],
      [],
      [L('Error (m)'), r.error == null ? '' : { v: Number(fmt(r.error)), s: r.pass ? 'num3' : 'num3bad' }, L('Tolerance (m)'), { v: r.tol, s: 'num3' },
       L('Result'), r.ready ? T(r.pass ? 'PASS' : 'FAIL', r.pass ? 'ok' : 'bad') : T('incomplete', 'warn')],
      [L('Error over 30 m (m)'), r.per30 == null ? '' : N(r.per30, 'num4s'), L('B should read (m)'), N(r.bShould)],
      [L('Action if failed'), T(t.action || '', 'text')],
    ];
    return { name: 'Two-peg test', rows, cols: [20, 26, 16, 16, 18, 30], merges: ['A1:F1', 'A2:F2', 'B14:F14'] };
  }

  // ── A worked example ───────────────────────────────────────────────────────
  // A fictional site, for practice and for the guide: AHD control, gauge zero
  // given, four boards, the water above the CTR, two change points, and a run
  // that closes 1 mm high. Never a record — `practice` keeps it off the
  // database and marks every export.
  function practice() {
    const survey = blankSurvey({ practice: true, datum: 'AHD', date: today(),
      station: { id: null, number: '999001', name: 'Example Creek at Training Weir (practice)' },
      purpose: 'routine', operator: 'A. Leveller', staff_holder: 'B. Staffholder', organisation: 'Practice crew' });
    survey.instrument = { id: null, make: 'Example', model: 'Digital level', serial: 'PRACTICE-01', service_date: survey.date };
    survey.bm = { name: 'BM999001_1', rl: 31.25, source: 'Practice site pack', lat: -27.5, lon: 152.9, acc: 4,
                  description: 'BM999001_1 — stainless survey pin set in the concrete headwall, left bank, 3 m upstream of the instrument hut. Primary, RL 31.250 m AHD.' };
    survey.gauge_zero = { rl: 26.8, source: 'Station records', from_row: null };
    const R = (kind, name, s, extra = {}) => blankRow(kind, Object.assign({ name }, s, extra));
    survey.rows = [
      R('bm', 'BM999001_1', { bs: 1.412, bs_d: 18.2 }, { desc: 'BM999001_1 — survey pin in the headwall, left bank. Primary, opening sight.' }),
      R('board', '3–4 m board', { is: 1.866, is_d: 12.0 }, { face: 4, desc: 'Top of the 3–4 m gauge board, face value 4.000 m, left bank.' }),
      R('board', '2–3 m board', { is: 2.861, is_d: 10.5 }, { face: 3, desc: 'Top of the 2–3 m gauge board, face value 3.000 m, left bank.' }),
      R('cp', 'CP1', { fs: 3.02, fs_d: 17.8, bs: 0.774, bs_d: 14.9 }, { desc: 'CP1 — high point of the rock outcrop, left bank, 8 m downstream of the boards.' }),
      R('board', '1–2 m board', { is: 1.617, is_d: 9.6 }, { face: 2, desc: 'Top of the 1–2 m gauge board, face value 2.000 m, left bank at the water.' }),
      R('board', '0–1 m board', { is: 2.612, is_d: 11.2 }, { face: 1, desc: 'Top of the 0–1 m gauge board, face value 1.000 m, in the channel.' }),
      R('water', 'Water', { is: 2.981, is_d: 11.4 }, { time: '09:42', desc: 'Water surface at 09:42, staff beside the 0–1 m board.' }),
      R('ctr', 'CTR', { is: 3.329, is_d: 13.0 }, { lat: -27.50005, lon: 152.90003, acc: 4,
        desc: 'CTR — top of the brass cap on the orifice termination, end of the line, left bank.' }),
      R('ctf', 'CTF', { is: 3.402, is_d: 22.5 }, { approx: true, desc: 'Approximate CTF — crown of the rock bar, 25 m downstream of the boards.' }),
      R('cp', 'CP2', { fs: 1.105, fs_d: 15.1, bs: 3.488, bs_d: 16.4 }, { desc: 'CP2 — top of the concrete footing of the footbridge, right bank.' }),
      R('bm', 'BM999001_1', { fs: 1.548, fs_d: 16.0 }, { desc: 'BM999001_1 — closing sight on the primary benchmark.' }),
    ];
    survey.water = { state: 'wet', row: survey.rows[6].id, board: { value: 0.64, time: '09:43' },
                     logger: { value: 0.631, time: '09:45', source: 'logger display' }, note: 'Practice values.' };
    const test = blankTest({ practice: true, date: survey.date, tester: 'A. Leveller', organisation: 'Practice crew',
                             instrument: survey.instrument, spacing: 50, near: 5 });
    Object.assign(test, { a1: 1.384, b1: 1.517, a2: 1.553, b2: 1.687, location: 'Practice: the depot yard, firm level ground.' });
    survey.peg_test = { id: test.id, date: test.date, error_m: twoPeg(test).error, passed: twoPeg(test).pass };
    return { survey, test };
  }

  return {
    U, DATUMS, KINDS, KIND_ORDER, PURPOSES, TOL, HINT,
    num, fmt, signed, mm, newId, isUuid, today, clock, minutes, dmy, daysBetween, bmName, kitLabel,
    blankRow, blankSurvey, blankTest,
    reduce, waterCheck, coverage, review, photoNeeds, twoPeg, stationChanges, nearest, suggestDesc,
    title, fileStem, csvCell, surveyCsv, testCsv, workbook, testSheet, practice,
  };
})();

// test/levels.mjs require()s this same file — see the header. Guarded so the
// browser, where `module` is undefined, never runs it.
if (typeof module !== 'undefined' && module.exports) module.exports = Levelling;
