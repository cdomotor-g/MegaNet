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
// A peak the river has reached (the HDB extract's, when it lands: a
// `flood_peaks` list on the station of { date, height_m on the gauge, or
// level_m_ahd }) is a level on the ladder and a mark on the twin's staff, but
// it does not colour the water: it is history, not a class.
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

    // The peaks the river has reached, when the station carries them.
    const peaks = ((s && s.flood_peaks) || []).map(p => {
      const lvl = num(p.level_m_ahd);
      const h = num(p.height_m);
      const ahd = lvl != null ? lvl : (h != null ? onGauge(h) : null);
      return ahd == null ? null : { key: `peak ${p.date || ''}`.trim(), kind: 'peak', label: `Peak${p.date ? ` ${String(p.date).slice(0, 10)}` : ''}`,
                                     ahd, gauge: ahdZero == null ? (lvl == null ? h : null) : ahd - ahdZero, rank: null, date: p.date || null };
    }).filter(Boolean);
    if (((s && s.flood_peaks) || []).length && !peaks.length) {
      notes.push('The peaks the river has reached are heights on the gauge, and its zero is not in AHD, so they cannot be put on the ground.');
    }
    if (peaks.length) {
      const high = peaks.reduce((a, b) => (b.ahd > a.ahd ? b : a));
      high.label = `Highest recorded${high.date ? ` (${String(high.date).slice(0, 10)})` : ''}`;
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
  };
})();
if (typeof window !== 'undefined') window.FloodStages = FloodStages;
