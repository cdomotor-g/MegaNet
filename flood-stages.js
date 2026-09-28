// MegaNet — flood-stages.js
//
//   FloodStages   the heights a station's river is known to reach — the
//                 Bureau's flood classes, the modelled AEP flood levels and,
//                 where there are any, the peaks it has actually reached —
//                 put on one ladder in metres AHD, with the colour the water
//                 takes as it passes each, for the Digital Twin's flood water.
//
// After core.js and flood-velocity.js, before init.js — index.html holds the
// order and the reasons. Pure: it reads a station record and returns numbers
// and words; digital-twin.js draws them. It reaches across to flood-velocity.js
// for FloodVelocity.pickRow and LEVELS (which AEP row, and what its four levels
// are called) at call time, so one rule picks the row the card and the twin
// both read. The IIFE body only declares (`npm run toplevel`).
//
// ── One ladder, two datums ───────────────────────────────────────────────────
// The flood classes (0031, Section 4) are heights *on the gauge*: metres above
// the gauge's zero. The AEP levels (0033) are metres AHD. The twin's ground is
// AHD, so a class is placed by adding the gauge zero in force (Section 6) —
// and only a zero surveyed in AHD: 254 of the 1,254 gauges with a survey are
// on an assumed, a State or an unknown datum, and a class hung from one of
// those would be drawn as confidently as it was wrong. Such a station's
// classes are named and left off the ladder, and the notes say why; its AEP
// levels, being AHD already, still stand.
//
// ── The colours ──────────────────────────────────────────────────────────────
// Below the first class the water is a clear blue; past minor it is green,
// moderate yellow, major red, and past the AEP levels magenta through to a
// dark blue at the rarest — magenta and dark blue when a station has two, the
// ramp between them shared out when it has three or four (446 of the 538
// stations with AEP levels have all four). Tokens, in styles.css.
//
// The colour is that of the *furthest* level passed in that order — the
// classes, then the AEP floods from the most frequent to the rarest — not of
// the last one passed by height. They interleave more often than not: of the
// 115 stations with a major class, an AHD gauge zero and a 1% AEP level, 44
// have their major class above the 1% AEP level. There the water turns magenta
// before it reaches major and stays magenta past it, rather than going back to
// red — the colour says how rare a flood the water has passed, and it never
// says less as the water rises.
//
// A peak the river has reached is a level on the ladder and a mark on the
// twin's staff, but it does not colour the water: it is history, not a class.
// They are HDB's (0037, tools/ingest/flood_peaks.py): the station carries its
// five largest floods as `flood_peaks`, { date, height_m, level_m_ahd } — the
// height on the gauge as it then stood, and the level it reached in m AHD
// through the zero in force *on that day*. The database works that level out,
// from the dated gauge survey, and leaves it off where it cannot honestly be
// had: a zero then on the assumed datum, none surveyed, or a height that would
// put the water 20 m over the gauge's own flood levels (HDB holds a few peaks
// written in m AHD). A peak with no level is named in the notes and not drawn
// — never hung from today's zero, which for 129 of these gauges is not the one
// the height was read against.
//
// ── The cycle ────────────────────────────────────────────────────────────────
// From 0 m on the gauge — the zero, where it is AHD and where it sits at the
// channel the ground model shows — to the highest level, held there, and let
// out again quickly: one rise every ~20 s whatever the range, so a creek that
// floods 3 m and a river that floods 16 m both take the same time to watch.

const FloodStages = (function () {

  // The three classes that decide a warning, in the order they are reached.
  // (The first-report, crops-and-grazing and towns heights some lists give
  // are on the card; they are not classes, and the water is not coloured by
  // them.)
  const CLASSES = [
    { key: 'minor_m',    kind: 'minor',    label: 'Minor',    rank: 1 },
    { key: 'moderate_m', kind: 'moderate', label: 'Moderate', rank: 2 },
    { key: 'major_m',    kind: 'major',    label: 'Major',    rank: 3 },
  ];

  // The colours, as the tokens that hold them and what to draw without a
  // stylesheet (the Node checks, a page with no CSS yet).
  const COLOURS = {
    below:    { token: '--flood-water-below',     hex: '#3d8bfd' },
    minor:    { token: '--flood-water-minor',     hex: '#1fa64a' },
    moderate: { token: '--flood-water-moderate',  hex: '#f2c200' },
    major:    { token: '--flood-water-major',     hex: '#e03131' },
    aepFirst: { token: '--flood-water-aep-first', hex: '#e020e0' },
    aepLast:  { token: '--flood-water-aep-last',  hex: '#15227a' },
    peak:     { token: '--flood-water-peak',      hex: '#ffffff' },
  };

  // The cycle, in seconds: the rise, the hold at the top, the drain.
  const RISE_S = 16, HOLD_S = 3, DRAIN_S = 1.5;

  // A gauge zero further below the channel than this is no bed — a dam's
  // headwater gauge often reads AHD straight off a zero of 0 (FloodVelocity's
  // rule, and its number) — and one further above it is not at the channel.
  const ZERO_MAX_BELOW = 30;
  const ZERO_MAX_ABOVE = 10;
  const STORAGE_RE = /\b(dam|hw|headwater|storage|spillway)\b/i;

  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  // Newest first by a date field; undated last; stable otherwise.
  function newest(rows, field) {
    return rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const x = a.r[field] || '', y = b.r[field] || '';
      if (x !== y) return x ? (y ? (x < y ? 1 : -1) : -1) : 1;
      return a.i - b.i;
    }).map(o => o.r);
  }

  // The gauge zero in force — one still open, newest first; failing that, the
  // one that ended last — with its datum, whatever the datum is. The card's
  // rule (RiverDetails.currentSurvey), restated for a pure module.
  function zeroOf(s) {
    const rows = ((s && s.gauge_survey) || []).filter(r => num(r.gauge_zero_m) != null);
    if (!rows.length) return null;
    const open = newest(rows.filter(r => !r.valid_to), 'valid_from');
    const r = open[0] || newest(rows, 'valid_to')[0];
    return { m: num(r.gauge_zero_m), datum: r.datum || null, from: r.valid_from || null };
  }

  function aepRow(s) {
    if (typeof FloodVelocity !== 'undefined' && FloodVelocity.pickRow) return FloodVelocity.pickRow(s);
    const rows = (s && Array.isArray(s.aep_levels)) ? s.aep_levels : [];
    return rows.length ? newest(rows, 'as_at')[0] : null;
  }
  function aepLevels() {
    return typeof FloodVelocity !== 'undefined' && FloodVelocity.LEVELS ? FloodVelocity.LEVELS : [
      { key: 'aep_1_m', label: '1%', oneIn: 100 }, { key: 'aep_0_5_m', label: '0.5%', oneIn: 200 },
      { key: 'aep_0_2_m', label: '0.2%', oneIn: 500 }, { key: 'aep_0_066_m', label: '0.066%', oneIn: 1500 },
    ];
  }

  // Everything the twin draws the water from.
  //
  //   { levels: [{ key, kind, label, ahd, gauge, rank, oneIn?, date? }] by height,
  //     zero, storage, classesAsAt, aepAsAt, aepSource, top, notes }
  //
  // `rank` orders the colours (null for a peak, which colours nothing);
  // `gauge` is the height on the gauge where the zero is AHD, else null.
  function ladder(s) {
    const notes = [];
    const levels = [];
    const zero = zeroOf(s);
    const ahdZero = zero && zero.datum === 'AHD' ? zero.m : null;
    const storage = STORAGE_RE.test((s && s.name) || '');
    const onGauge = h => (ahdZero == null ? null : ahdZero + h);

    const classes = newest(((s && s.flood_classes) || []).filter(r => r), 'as_at')[0] || null;
    if (classes) {
      const given = CLASSES.filter(c => num(classes[c.key]) != null);
      if (given.length && ahdZero == null) {
        notes.push(zero
          ? `The flood classes are heights on the gauge, and its zero is on ${zero.datum ? `the ${datumWord(zero.datum)}` : 'no stated datum'} rather than AHD, so they cannot be put on the ground: ${given.map(c => `${c.label.toLowerCase()} ${num(classes[c.key])} m`).join(', ')}.`
          : `The flood classes are heights on the gauge, and the gauge has no surveyed zero, so they cannot be put on the ground: ${given.map(c => `${c.label.toLowerCase()} ${num(classes[c.key])} m`).join(', ')}.`);
      }
      for (const c of given) {
        const h = num(classes[c.key]);
        const ahd = onGauge(h);
        if (ahd == null) continue;
        levels.push({ key: c.key, kind: c.kind, label: c.label, ahd, gauge: h, rank: c.rank });
      }
    }

    const row = aepRow(s);
    const defs = aepLevels();
    const aeps = row ? defs.filter(d => num(row[d.key]) != null) : [];
    aeps.forEach((d, i) => {
      const ahd = num(row[d.key]);
      levels.push({ key: d.key, kind: 'aep', label: `${d.label} AEP`, short: d.label, ahd,
                    gauge: ahdZero == null ? null : ahd - ahdZero, rank: 4 + i, oneIn: d.oneIn, aepIndex: i, aepCount: aeps.length });
    });

    // The peaks the river has reached, where the station carries them: each at
    // the level the database says it reached (see the head of this file), and
    // only there.
    const given = ((s && s.flood_peaks) || []).filter(p => p && (num(p.level_m_ahd) != null || num(p.height_m) != null));
    const peaks = given.filter(p => num(p.level_m_ahd) != null).map(p => {
      const ahd = num(p.level_m_ahd);
      const date = p.date ? String(p.date).slice(0, 10) : null;
      return { key: `peak ${date || ''}`.trim(), kind: 'peak', label: `Peak${date ? ` ${date}` : ''}`, short: peakWhen(date),
               ahd, gauge: ahdZero == null ? null : ahd - ahdZero, recorded: num(p.height_m), rank: null, date };
    });
    const unplaced = given.filter(p => num(p.level_m_ahd) == null);
    if (unplaced.length) {
      const said = unplaced.map(p => `${num(p.height_m)} m${p.date ? ` (${String(p.date).slice(0, 10)})` : ''}`).join(', ');
      notes.push(peaks.length
        ? `${unplaced.length === 1 ? 'One of the floods' : `${unplaced.length} of the floods`} HDB records here cannot be put on the ground — the gauge's zero on the day is not known in AHD, or the height disagrees with its flood levels: ${said} on the gauge.`
        : `HDB records floods here, but none can be put on the ground — the gauge's zero on the day is not known in AHD, or the heights disagree with its flood levels: ${said} on the gauge.`);
    }
    if (peaks.length) {
      const high = peaks.reduce((a, b) => (b.ahd > a.ahd ? b : a));
      high.label = `Highest recorded${high.date ? ` (${high.date})` : ''}`;
      high.highest = true;
      levels.push(...peaks);
    }

    levels.sort((a, b) => a.ahd - b.ahd || (a.rank ?? 99) - (b.rank ?? 99));
    const top = levels.length ? levels[levels.length - 1].ahd : null;
    return {
      levels, zero, ahdZero, storage, top,
      classesAsAt: classes ? classes.as_at || null : null,
      aepAsAt: row ? row.as_at || null : null,
      aepSource: row ? row.source || null : null,
      notes,
    };
  }

  // ── Borrowed levels ──────────────────────────────────────────────────────
  // 3,710 stations have no heights at all to draw water from, and many of
  // them are a few kilometres up or down a river from one that has. The twin
  // offers to borrow the nearest such station's levels — only when asked, and
  // saying so everywhere it draws them — and this is the arithmetic, pure
  // like the rest of this file.
  //
  // Two ways to carry a height from there to here, and the operator picks:
  //
  //   'gauge'  (the default) — each level as a height *on the other station's
  //            gauge*, laid over this station's channel: 0 m is the lowest
  //            ground by this gauge, and minor at 3.0 m is 3.0 m over it. A
  //            class is already a gauge height; an AEP level is brought down
  //            to one through the other gauge's AHD zero, and left out where
  //            that gauge has none. The better guide across a river's fall,
  //            which is a metre a kilometre on a creek.
  //   'ahd'    — the other station's own ladder in metres AHD, unchanged: the
  //            right thing only a short way along the same reach, where the
  //            water surface is nearly level.
  //
  // Peaks the other river reached are not carried: they are that river's
  // history, not a class.

  // What a station has that could be borrowed, or null: its newest classes
  // (as gauge heights, whatever its datum) and its AEP levels (AHD), and its
  // gauge zero where that is AHD.
  function borrowable(s) {
    const classes = newest(((s && s.flood_classes) || []).filter(r => r), 'as_at')[0] || null;
    const cls = classes ? CLASSES.filter(c => num(classes[c.key]) != null).map(c => ({ ...c, h: num(classes[c.key]) })) : [];
    const row = aepRow(s);
    const aeps = row ? aepLevels().filter(d => num(row[d.key]) != null).map(d => ({ ...d, ahd: num(row[d.key]) })) : [];
    if (!cls.length && !aeps.length) return null;
    const zero = zeroOf(s);
    return { classes: cls, classesAsAt: classes ? classes.as_at || null : null, aeps, aepAsAt: row ? row.as_at || null : null,
             ahdZero: zero && zero.datum === 'AHD' ? zero.m : null, zero };
  }

  // The ladder the twin draws from a borrowed station's levels, for a
  // channel here at `channel` m AHD. The shape ladder() returns, with
  // `borrowed` saying from whom and how.
  function borrowed(donor, mode, channel, info = {}) {
    const b = borrowable(donor);
    const notes = [];
    const levels = [];
    const ch = num(channel);
    const name = (donor && donor.name) || 'the other station';
    if (!b) return { levels, zero: null, ahdZero: null, storage: false, top: null, classesAsAt: null, aepAsAt: null, aepSource: null,
                     notes: [`${name} has no flood levels to borrow.`], borrowed: { id: donor && donor.id, name, mode, ...info } };
    if (mode === 'ahd') {
      const lad = ladder(donor);
      return { ...lad, notes: lad.notes.slice(), borrowed: { id: donor.id, name, mode, ...info } };
    }
    if (ch == null) {
      return { levels, zero: null, ahdZero: null, storage: false, top: null, classesAsAt: null, aepAsAt: null, aepSource: null,
               notes: ['There is no channel in this patch to lay borrowed gauge heights over.'], borrowed: { id: donor.id, name, mode, ...info } };
    }
    for (const c of b.classes) levels.push({ key: c.key, kind: c.kind, label: c.label, ahd: ch + c.h, gauge: c.h, rank: c.rank });
    if (b.aeps.length && b.ahdZero == null) {
      notes.push(`${name}'s AEP levels are in metres AHD and its gauge has no zero in AHD to bring them down to heights on the gauge, so they are left out.`);
    } else if (b.aeps.length) {
      b.aeps.forEach((d, i) => {
        const g = d.ahd - b.ahdZero;
        levels.push({ key: d.key, kind: 'aep', label: `${d.label} AEP`, short: d.label, ahd: ch + g, gauge: g,
                      rank: 4 + i, oneIn: d.oneIn, aepIndex: i, aepCount: b.aeps.length });
      });
    }
    levels.sort((x, y) => x.ahd - y.ahd || (x.rank ?? 99) - (y.rank ?? 99));
    return {
      levels, zero: null, ahdZero: ch, storage: false, top: levels.length ? levels[levels.length - 1].ahd : null,
      classesAsAt: b.classesAsAt, aepAsAt: b.aepAsAt, aepSource: null, notes,
      borrowed: { id: donor.id, name, mode, ...info },
    };
  }

  // "Feb 1893", "Jan 1947", "1887": when a flood was, as the scale says it.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function peakWhen(date) {
    const m = /^(\d{4})(?:-(\d\d))?/.exec(String(date || ''));
    if (!m) return 'Flood';
    return m[2] && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
  }

  function datumWord(code) {
    return { ASSUM: 'assumed datum', STATE: 'State datum', UNKNOWN: 'datum it does not know', AHD: 'Australian Height Datum' }[code] || `${code} datum`;
  }

  // Where 0 m on the gauge is, for the twin's cycle: the zero, where it is AHD,
  // the station is not a storage, and the zero sits at the channel the ground
  // model shows (`channel`: the lowest ground by the gauge, m AHD). Otherwise
  // the channel itself, and the reason. Never above the top.
  function start(lad, channel) {
    const ch = num(channel);
    const z = lad.ahdZero;
    let at = null, basis = '';
    if (z != null && !lad.storage && (ch == null || (z >= ch - ZERO_MAX_BELOW && z <= ch + ZERO_MAX_ABOVE))) {
      at = z; basis = 'the gauge zero';
    } else if (ch != null) {
      at = ch;
      basis = z == null ? 'the lowest ground by the gauge (no gauge zero in AHD)'
            : lad.storage ? 'the lowest ground by the gauge (a storage’s zero is not its bed)'
            : `the lowest ground by the gauge (the zero, ${z.toFixed(2)} m AHD, is not at the channel the ground shows)`;
    } else if (z != null) {
      at = z; basis = 'the gauge zero';
    }
    if (at != null && lad.top != null && at >= lad.top) { at = lad.top - 1; basis += ', a metre under the top level — every level is below it'; }
    return { m: at, basis };
  }

  // The level the water colour comes from at a height: the furthest passed,
  // by rank — or null below the first.
  function passed(lad, ahd) {
    let best = null;
    for (const l of lad.levels) {
      if (l.rank == null || !(ahd >= l.ahd - 1e-9)) continue;
      if (!best || l.rank > best.rank) best = l;
    }
    return best;
  }

  // The colour a level stands for, from the colours given (hex strings, keyed
  // as COLOURS): a class its own; the k-th of n AEP levels shared out along
  // the ramp from the first colour to the last; below, the clear blue.
  function colourOf(level, palette = null) {
    const p = palette || Object.fromEntries(Object.entries(COLOURS).map(([k, v]) => [k, v.hex]));
    if (!level) return p.below;
    if (level.kind === 'minor' || level.kind === 'moderate' || level.kind === 'major') return p[level.kind];
    if (level.kind === 'peak') return p.peak;
    const n = level.aepCount || 1;
    const t = n <= 1 ? 0 : level.aepIndex / (n - 1);
    return mix(p.aepFirst, p.aepLast, t);
  }

  function mix(a, b, t) {
    const pa = hexRgb(a), pb = hexRgb(b);
    if (!pa || !pb) return a;
    const c = pa.map((x, i) => Math.round(x + (pb[i] - x) * t));
    return `#${c.map(x => x.toString(16).padStart(2, '0')).join('')}`;
  }
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }

  // Where in its cycle the water is, `t` seconds in: 0 at 0 m, 1 at the top.
  function cycle(t, { rise = RISE_S, hold = HOLD_S, drain = DRAIN_S } = {}) {
    const total = rise + hold + drain;
    const u = ((t % total) + total) % total;
    if (u < rise) return u / rise;
    if (u < rise + hold) return 1;
    return Math.max(0, 1 - (u - rise - hold) / drain);
  }

  // ── The scale beside the water ─────────────────────────────────────────────
  // The twin stands the levels up the left of its stage, to scale: each
  // level's mark at its height between 0 m on the gauge (`lo`, the foot of a
  // track `px` tall) and the top (`hi`, its head), and its label beside it —
  // moved off the mark only as far as it must be not to sit on another, a
  // crowd of labels spread evenly about where their marks are. Where there are
  // more labels than the track has room for, the least of them give way and
  // keep only their mark: the classes first, then the highest flood recorded,
  // the AEP floods from the 1%, then the other floods, largest first.
  //
  //   scale(levels, { lo, hi, px, gap }) → [{ key, mark, at, shown }]
  //
  // in the levels' own order; `mark` and `at` are px down from the head of the
  // track, and `at` is null for a label that gave way. `gap` is the height of
  // a label: no two labels' middles are nearer than that.
  function scale(levels, { lo, hi, px, gap }) {
    const span = hi - lo;
    const markOf = a => (span > 0 ? Math.max(0, Math.min(px, px * (hi - a) / span)) : px);
    const out = levels.map(l => ({ key: l.key, mark: markOf(l.ahd), at: null, shown: false }));
    const room = gap > 0 ? Math.max(0, Math.floor(px / gap) + 1) : levels.length;
    const wanted = levels.map((l, i) => i)
      .sort((a, b) => labelRank(levels[a]) - labelRank(levels[b]) || levels[b].ahd - levels[a].ahd || a - b)
      .slice(0, room);
    const down = wanted.sort((a, b) => out[a].mark - out[b].mark || b - a);
    const at = spread(down.map(i => out[i].mark), gap, 0, px);
    down.forEach((i, k) => { out[i].at = at[k]; out[i].shown = true; });
    return out;
  }

  function labelRank(l) {
    const cls = { major: 0, moderate: 1, minor: 2 }[l.kind];
    if (cls != null) return cls;
    if (l.kind === 'peak') return l.highest ? 3 : 5;
    return 4 + (l.aepIndex || 0) / 10;
  }

  // Positions for labels wanted at `ys` (ascending), none nearer than `gap`,
  // all within [lo, hi]. Labels that would overlap are gathered into a run and
  // the run centred on the middle of the marks it stands for — the placement
  // that moves them least — and runs that then overlap are gathered again.
  function spread(ys, gap, lo, hi) {
    const top = c => Math.max(lo, Math.min(hi - (c.n - 1) * gap, c.sum / c.n - (c.n - 1) * gap / 2));
    const runs = [];
    for (const y of ys) {
      runs.push({ n: 1, sum: y });
      while (runs.length > 1) {
        const b = runs[runs.length - 1], a = runs[runs.length - 2];
        if (top(a) + a.n * gap <= top(b) + 1e-9) break;
        a.n += b.n; a.sum += b.sum; runs.pop();
      }
    }
    const out = [];
    for (const r of runs) { const t = top(r); for (let j = 0; j < r.n; j++) out.push(t + j * gap); }
    return out;
  }

  // A level on the scale, in a few words: its name — a flood by its month and
  // year, the highest with a star — and its height, on the gauge where every
  // level has one, else in m AHD. The label's title says it in full.
  function scaleText(l, onGauge) {
    const name = l.kind === 'peak' ? `${l.short || 'Flood'}${l.highest ? ' ★' : ''}` : l.label;
    return `${name} ${onGauge && l.gauge != null ? `${Number(l.gauge).toFixed(1)} m` : `${Number(l.ahd).toFixed(2)} m`}`;
  }

  // "7.0 m on the gauge", "102.69 m AHD" — how a level is said.
  function gaugeText(m) { return num(m) == null ? '' : `${Number(m).toFixed(1)} m on the gauge`; }
  function ahdText(m) { return num(m) == null ? '' : `${Number(m).toFixed(2)} m AHD`; }
  function levelText(l) {
    if (!l) return '';
    if (l.kind === 'aep') return `${l.label} ${ahdText(l.ahd)}`;
    return `${l.label} ${l.gauge != null ? `${Number(l.gauge).toFixed(1)} m` : ahdText(l.ahd)}`;
  }

  return {
    CLASSES, COLOURS, RISE_S, HOLD_S, DRAIN_S, ZERO_MAX_BELOW, ZERO_MAX_ABOVE,
    ladder, start, passed, colourOf, mix, cycle, gaugeText, ahdText, levelText,
    borrowable, borrowed, scale, spread, scaleText, peakWhen,
  };
})();
if (typeof window !== 'undefined') window.FloodStages = FloodStages;
