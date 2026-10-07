// MegaNet — flood-stages.js
//
//   FloodStages   the heights a station's river is known to reach — the
//                 Bureau's flood classes, the modelled AEP flood levels and,
//                 where there are any, the peaks it has actually reached —
//                 put on one ladder in metres AHD, with the colour the water
//                 takes as it passes each, for the Digital Twin's flood water;
//                 and the same classes and AEP levels as lines across a
//                 level series on the ARRO Data and Field Data charts, each
//                 in that series' own datum (see "Lines on a chart").
//
// After core.js and flood-velocity.js, before init.js — index.html holds the
// order and the reasons. Pure: it reads a station record and returns numbers
// and words; digital-twin.js and arro-data.js draw them. It reaches across to
// flood-velocity.js for FloodVelocity.pickRow and LEVELS (which AEP row, and
// what its four levels are called) at call time, so one rule picks the row the
// card, the twin and the chart all read. The IIFE body only declares (`npm run
// toplevel`).
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
// Every `ahd` on a ladder is AHD — a station's own, and one borrowed from
// another station either way it is carried (below) — and a ladder is only
// stood on a ground in AHD (onGround). digital-twin.js puts the ~30 m tiles
// into AHD through geoid.js before anything is measured against them; where
// that cannot be done the water is not drawn, and the notes say why, rather
// than a level being drawn up to 2 m from where it belongs.
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
    // Another station's floods (0041): a station with no gauge of its own that
    // takes its flood history from one nearby says whose they are.
    if (given.length && s.flood_peaks_gauge) {
      const from = typeof state !== 'undefined' && state.data && s.flood_peaks_from
        ? (state.data.stations || []).find(x => x.id === s.flood_peaks_from) : null;
      notes.push(`The floods are the Bureau's record at ${from ? `${from.name} (${s.flood_peaks_gauge})` : `gauge ${s.flood_peaks_gauge}`}, which this station takes its flood history from until it has a gauge of its own.`);
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
      levels, zero, ahdZero, storage, top, datum: 'AHD',
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
  //            water surface is nearly level. Its gauge is not here, so no
  //            level is called a height on the gauge — each keeps what it was
  //            on the other gauge (`lent`) for the words only — and 0 m is
  //            this station's channel, not the other gauge's zero.
  //
  // Either way the ladder is in AHD, as long as this ground is (the channel
  // is a height on it): 'gauge' needs no datum of the other gauge's zero —
  // only heights over it cross — but its AEP levels and floods come down to
  // gauge heights through that zero, so only an AHD one; 'ahd' needs the
  // other gauge's zero in AHD for its classes, and nothing for the rest.
  // `borrowed.datums` keeps what the words saying so are made from
  // (datumWords).
  //
  // The floods the other river has reached (`flood_peaks`) are carried too,
  // as marks on the staff and the tower and never as colour: laid on as
  // heights on the other gauge in 'gauge' mode, at their own AHD level in
  // 'ahd' mode. Only those the database could place (see the head of this
  // file); the rest are named in the notes.

  // What a station has that could be borrowed, or null: its newest classes
  // (as gauge heights, whatever its datum) and its AEP levels (AHD), and its
  // gauge zero where that is AHD.
  function borrowable(s) {
    const classes = newest(((s && s.flood_classes) || []).filter(r => r), 'as_at')[0] || null;
    const cls = classes ? CLASSES.filter(c => num(classes[c.key]) != null).map(c => ({ ...c, h: num(classes[c.key]) })) : [];
    const row = aepRow(s);
    const aeps = row ? aepLevels().filter(d => num(row[d.key]) != null).map(d => ({ ...d, ahd: num(row[d.key]) })) : [];
    const peaks = ((s && s.flood_peaks) || []).filter(p => p && num(p.level_m_ahd) != null);
    if (!cls.length && !aeps.length && !peaks.length) return null;
    const zero = zeroOf(s);
    return { classes: cls, classesAsAt: classes ? classes.as_at || null : null, aeps, peaks, aepAsAt: row ? row.as_at || null : null,
             ahdZero: zero && zero.datum === 'AHD' ? zero.m : null, zero };
  }

  // The ladder the twin draws from a borrowed station's levels, for a
  // channel here at `channel` m AHD. The shape ladder() returns, with
  // `borrowed` saying from whom and how, and in which datums.
  function borrowed(donor, mode, channel, info = {}) {
    const b = borrowable(donor);
    const notes = [];
    const levels = [];
    const ch = num(channel);
    const name = (donor && donor.name) || 'the other station';
    const datums = {
      zero: b && b.zero ? { m: b.zero.m, datum: b.zero.datum, from: b.zero.from } : null,
      classes: !!(b && b.classes.length), aeps: !!(b && b.aeps.length), peaks: !!(b && b.peaks.length),
      channel: ch,
    };
    const tag = { id: donor && donor.id, name, mode, ...info, datums };
    if (!b) return { levels, zero: null, ahdZero: null, storage: false, top: null, datum: 'AHD', classesAsAt: null, aepAsAt: null, aepSource: null,
                     notes: [`${name} has no flood levels to borrow.`], borrowed: tag };
    if (mode === 'ahd') {
      // Its levels where they are in AHD; heights on its gauge kept only to
      // be said ("7.0 m on Gatton's gauge"), since that gauge is not here.
      const lad = ladder(donor);
      return { ...lad, zero: null, ahdZero: null, storage: false,
               levels: lad.levels.map(l => ({ ...l, gauge: null, lent: l.gauge })),
               notes: lad.notes.map(n => `From ${name}'s record: ${n}`), borrowed: tag };
    }
    if (ch == null) {
      return { levels, zero: null, ahdZero: null, storage: false, top: null, datum: 'AHD', classesAsAt: null, aepAsAt: null, aepSource: null,
               notes: ['There is no channel in this patch to lay borrowed gauge heights over.'], borrowed: tag };
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
    if (b.peaks.length) {
      const mine = b.peaks.map(p => {
        const at = num(p.level_m_ahd);
        const date = p.date ? String(p.date).slice(0, 10) : null;
        const g = b.ahdZero != null ? at - b.ahdZero : (num(p.height_m) != null ? num(p.height_m) : null);
        return g == null ? null : { key: `peak ${date || ''}`.trim(), kind: 'peak', label: `Peak${date ? ` ${date}` : ''}`, short: peakWhen(date),
                                    ahd: ch + g, gauge: g, recorded: num(p.height_m), rank: null, date };
      }).filter(Boolean);
      if (mine.length) {
        const high = mine.reduce((a, c) => (c.ahd > a.ahd ? c : a));
        high.label = `Highest recorded${high.date ? ` (${high.date})` : ''}`;
        high.highest = true;
        levels.push(...mine);
      }
    }
    levels.sort((x, y) => x.ahd - y.ahd || (x.rank ?? 99) - (y.rank ?? 99));
    return {
      levels, zero: null, ahdZero: ch, storage: false, top: levels.length ? levels[levels.length - 1].ahd : null, datum: 'AHD',
      classesAsAt: b.classesAsAt, aepAsAt: b.aepAsAt, aepSource: null, notes,
      borrowed: tag,
    };
  }

  // A ladder stood on a ground in `datum`: unchanged on AHD, and on anything
  // else no levels at all, with the reason — a level in AHD on a ground in
  // EGM96 is up to 2 m out over Australia, and one laid over its channel
  // would be named in a datum the ground is not in.
  function onGround(lad, datum) {
    if (!lad || datum === 'AHD' || !lad.levels.length) return lad;
    return { ...lad, levels: [], top: null, offGround: datum,
             notes: [...lad.notes, `The ground here is in ${datum === 'EGM96' ? 'EGM96, the terrain tiles\' datum,' : datum} and could not be put into AHD, so no flood level is stood on it: every one is in AHD, and over Australia the two are up to 2 m apart.`] };
  }

  // The datums a borrowed ladder crosses, in words, for the twin to say
  // wherever it draws one: what the other station's heights are measured
  // from, how they were carried, and what they are in here.
  //
  //   datumWords(lad, { ground }) → { from, carried, here, brief } | null
  //
  // `ground` is how this ground's datum is said ("Queensland's LiDAR, in AHD").
  // Null for a ladder that is not borrowed.
  function datumWords(lad, { ground = 'this station\'s ground, in AHD' } = {}) {
    const b = lad && lad.borrowed;
    if (!b) return null;
    const d = b.datums || {};
    const who = b.self ? 'its own' : `${b.name}'s`;
    const zero = d.zero;
    const zeroWords = !zero ? 'a gauge with no surveyed zero'
      : zero.datum === 'AHD' ? `a gauge zero of ${zero.m.toFixed(2)} m AHD${zero.from ? ` (since ${String(zero.from).slice(0, 10)})` : ''}`
      : `a gauge zero of ${zero.m.toFixed(2)} m on ${zero.datum ? `the ${datumWord(zero.datum)}` : 'no stated datum'} — not AHD`;
    const parts = [];
    if (d.classes) parts.push(`its flood classes are metres on its gauge, over ${zeroWords}`);
    else parts.push(`it has ${zeroWords}`);
    if (d.aeps) parts.push('its AEP levels are metres AHD');
    if (d.peaks) parts.push(`the floods it has recorded are metres AHD`);
    const from = `${b.self ? 'This station' : b.name}: ${parts.join('; ')}.`;
    const zeroAhd = !!(zero && zero.datum === 'AHD');
    const ch = num(d.channel);
    let carried;
    if (b.mode === 'ahd') {
      carried = `Carried as the same heights in metres AHD, unchanged — ${d.classes ? (zeroAhd ? `its classes through its zero (${zero.m.toFixed(2)} m AHD)` : 'its classes left out, its zero not being AHD') : 'no classes'}`
              + `${d.aeps || d.peaks ? `, its ${[d.aeps && 'AEP levels', d.peaks && 'floods'].filter(Boolean).join(' and ')} as they stand` : ''}. Its gauge is not here: 0 m is this channel, and no level is called a height on the gauge.`;
    } else {
      const inAhd = [d.aeps && 'AEP levels', d.peaks && 'floods'].filter(Boolean).join(' and ');
      const notAhd = [d.aeps && 'its AEP levels are left out', d.peaks && 'its floods are taken at the gauge heights recorded'].filter(Boolean).join(' and ');
      carried = `Carried as heights on ${who} gauge, 0 m laid on this station's channel${ch != null ? ` at ${ch.toFixed(2)} m AHD` : ''}: a level h m on that gauge is drawn ${ch != null ? `at ${ch.toFixed(2)} + h m AHD` : 'h m over the channel'} here, whatever datum its zero is on`
              + (!inAhd ? '' : zeroAhd ? `; its ${inAhd} brought down to gauge heights through its AHD zero first`
                                       : `; ${notAhd} — its zero is not in AHD, so there is no AHD level to bring down to the gauge`) + '.';
    }
    const here = `Drawn in metres AHD on ${ground}.`;
    const brief = b.mode === 'ahd' ? 'm AHD, as lent' : 'm AHD, over this channel';
    return { from, carried, here, brief };
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
  //   scale(levels, { lo, hi, px, gap, k }) → [{ key, mark, at, shown }]
  //
  // in the levels' own order; `mark` and `at` are px down from the head of the
  // track, and `at` is null for a label that gave way. `gap` is the height of
  // a label: no two labels' middles are nearer than that. `k` is the track's
  // bend (see curve(), below): none for a linear track.
  function scale(levels, { lo, hi, px, gap, k = null }) {
    const c = curve(lo, hi, k);
    const markOf = a => (hi - lo > 0 ? Math.max(0, Math.min(px, px * (1 - c.at(a)))) : px);
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

  // ── Linear or logarithmic ──────────────────────────────────────────────────
  // The scale is linear to begin with: a metre is the same height on the track
  // from 0 m to the top. Where a station's levels crowd together at the top —
  // at Gatton, major, the four AEP floods and the 1893 and 2011 floods are
  // seven levels in the top 1.7 m of 16.3, 10% of the track — a linear track
  // has them all on one short stretch, their names pushed off their marks in
  // a fan, and the rise passes all seven in its last second and a half.
  //
  // So the track can be logarithmic instead, in the depth below the top:
  //
  //   t(h) = 1 − ln(1 + (hi − h) / k) / ln(1 + (hi − lo) / k)
  //
  // 0 at the foot and 1 at the head either way. `k` is the bend, in metres:
  // the depth below the top over which the track is still roughly linear, and
  // under which it opens out — a small k gives the top metres most of the
  // track, a large one is nearly linear. Measured down from the top because
  // that is where a station's levels crowd: the classes are metres apart and
  // the AEP floods and the largest floods are centimetres to a metre apart over
  // them, never under them. The rise keeps its clock and runs along the track,
  // so on a logarithmic one it slows as it climbs into the levels, and passes
  // them at a pace a person can follow.
  //
  // Which k, and whether a station's levels warrant it at all, are worked out
  // from the levels alone, on a track of a set height (LOG_PX, about the tab's)
  // so that the answer is the station's and not the window's: laid out as the
  // stage lays them out (scale(), above), how far on average is a name pushed
  // off its mark? logFit() tries a handful of bends and keeps the gentlest
  // that does about as well as the best of them — a sharper bend than the
  // levels need spends the track on the top few centimetres; the levels
  // warrant it where the linear track pushes the names more than half a
  // name's height on average and the bend takes more than a third of that
  // away. A station with only its three classes, a few metres apart, never
  // does; nearly a third of the stations with levels on the ground do.
  const LOG_PX     = 320;
  const LOG_GAP    = 18;                  // a name's height (digital-twin.js, SCALE_GAP)
  const LOG_BENDS  = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];   // as fractions of the range
  const LOG_K_MIN  = 0.02;                // m: no bend sharper than 2 cm
  const LOG_EASE   = LOG_GAP / 6;         // px: "about as well as the best"
  const LOG_WANT   = LOG_GAP / 2;         // px pushed, on average, before log is worth offering
  const LOG_GAIN   = 2 / 3;               // …and it must come down to at most this share of it

  // The track's own measure: where a height stands on it, 0 at the foot (lo)
  // to 1 at the head (hi), and the height at a place on it. Linear for no k.
  function curve(lo, hi, k = null) {
    const D = hi - lo;
    const clamp = t => Math.max(0, Math.min(1, t));
    if (!(D > 0)) return { k: null, at: () => 1, of: () => hi };
    if (!(k > 0)) return { k: null, at: h => clamp((h - lo) / D), of: t => lo + clamp(t) * D };
    const L = Math.log1p(D / k);
    return {
      k,
      at: h => 1 - Math.log1p(Math.max(0, Math.min(D, hi - h)) / k) / L,
      of: t => hi - k * Math.expm1((1 - clamp(t)) * L),
    };
  }

  // How far, on average, the names are pushed off their marks on a track of
  // LOG_PX with bend k (px). The names that give way are the same whatever
  // the bend — the track's height decides how many fit — so only the shown
  // ones are counted.
  function crowding(levels, lo, hi, k) {
    const pos = scale(levels, { lo, hi, px: LOG_PX, gap: LOG_GAP, k }).filter(p => p.shown);
    return pos.length ? pos.reduce((a, p) => a + Math.abs(p.at - p.mark), 0) / pos.length : 0;
  }

  // The bend that spreads these levels best, and whether they warrant it:
  //   { k, linear, log, warrant } — `linear` and `log` the crowding of each.
  //
  // A bend is found for any station with a range, so that one pressed onto
  // the logarithmic track has one; with one or two levels the gentlest wins,
  // since there is nothing to crowd.
  function logFit(levels, lo, hi) {
    const D = hi - lo;
    const linear = crowding(levels, lo, hi, null);
    if (!(D > 0)) return { k: null, linear, log: linear, warrant: false };
    const tried = LOG_BENDS.map(f => Math.max(LOG_K_MIN, f * D)).map(k => ({ k, cost: crowding(levels, lo, hi, k) }));
    const least = Math.min(...tried.map(t => t.cost));
    const pick = tried.filter(t => t.cost <= least + LOG_EASE).reduce((a, b) => (b.k > a.k ? b : a));
    return { k: pick.k, linear, log: pick.cost, warrant: linear > LOG_WANT && pick.cost <= linear * LOG_GAIN };
  }

  // A level on the scale, in a few words: its name — a flood by its month and
  // year, the highest with a star — and its height, on the gauge where every
  // level has one, else in m AHD. The label's title says it in full.
  function scaleText(l, onGauge) {
    const name = l.kind === 'peak' ? `${l.short || 'Flood'}${l.highest ? ' ★' : ''}` : l.label;
    return `${name} ${onGauge && l.gauge != null ? `${Number(l.gauge).toFixed(1)} m` : `${Number(l.ahd).toFixed(2)} m`}`;
  }

  // "7.0 m on the gauge", "102.69 m AHD" — how a level is said.
  function gaugeText(m, where = 'on the gauge') { return num(m) == null ? '' : `${Number(m).toFixed(1)} m ${where}`; }
  function ahdText(m) { return num(m) == null ? '' : `${Number(m).toFixed(2)} m AHD`; }
  function levelText(l) {
    if (!l) return '';
    if (l.kind === 'aep') return `${l.label} ${ahdText(l.ahd)}`;
    return `${l.label} ${l.gauge != null ? `${Number(l.gauge).toFixed(1)} m` : ahdText(l.ahd)}`;
  }

  // ── Lines on a chart (#226) ────────────────────────────────────────────────
  // ARRO Data and Field Data (arro-data.js) draw a river level against its
  // station's flood classes and AEP levels: a horizontal line at each, at the
  // height it stands at *in the series' own datum*. A level series is metres
  // on the gauge or metres AHD, and the two sit the gauge zero apart — 87.54 m
  // at Gatton, where a class drawn in the wrong one is off the chart, and
  // 1.53 m at Alligator Creek, where it is on it, a metre and a half out, with
  // nothing to say so. So every line is placed by the rule the ladder above
  // keeps for the twin, turned round to face the series:
  //
  //                   classes (m on the gauge)       AEP levels (m AHD)
  //   gauge series    as the list gives them         less the zero in force
  //   AHD series      plus the zero in force         as the sheet gives them
  //
  // and only ever through a zero surveyed in AHD. Where the rule needs one and
  // the gauge has none — its zero on an assumed, a State or an unknown datum,
  // or never surveyed — the lines that needed it are not drawn, and `notes`
  // names them and says why: never hung from that zero anyway, and never left
  // out without a word. A series on the gauge needs no zero at all for its own
  // classes, so a gauge on an assumed datum still gets those.
  //
  //   lines(s, datum, { classes, aep, typical, since })
  //     → { datum, lines, notes, suspect, relevelled, zero, ahdZero,
  //         classesAsAt, aepAsAt, has: { classes, aep } }
  //
  // `datum` is 'gauge' or 'AHD'; anything else draws nothing, and says so.
  // `lines` is lowest first, each { key, kind, label, short, rank, value, own,
  // ownDatum, converted, oneIn?, aepIndex?, aepCount? }: `value` the height in
  // the series' datum, `own` and `ownDatum` the figure as the record gives it.
  // `typical` — a reading typical of the series, its median — lets the answer
  // say when the readings look like the *other* datum (`suspect`: { datum,
  // words }), which is the one mistake the arithmetic cannot catch by itself;
  // `since` — the series' first day, ISO — when the gauge was re-levelled
  // inside it (`relevelled`: { from, was, now, words }).
  const SUSPECT_SLACK = 5;     // m either side of where each datum's readings can be

  function lines(s, datum, { classes: wantClasses = true, aep: wantAep = true, typical = null, since = null } = {}) {
    const d = datum === 'gauge' || datum === 'AHD' ? datum : null;
    const notes = [];
    const out = [];
    const zero = zeroOf(s);
    const ahdZero = zero && zero.datum === 'AHD' ? zero.m : null;
    const ed = newest(((s && s.flood_classes) || []).filter(r => r), 'as_at')[0] || null;
    const cls = ed ? CLASSES.filter(c => num(ed[c.key]) != null) : [];
    const row = aepRow(s);
    const aeps = row ? aepLevels().filter(l => num(row[l.key]) != null) : [];
    const res = {
      datum: d, lines: out, notes, suspect: null, relevelled: null, zero, ahdZero,
      classesAsAt: ed ? ed.as_at || null : null, aepAsAt: row ? row.as_at || null : null,
      has: { classes: cls.length > 0, aep: aeps.length > 0 },
    };
    const useClasses = wantClasses && cls.length > 0;
    const useAep = wantAep && aeps.length > 0;
    if (!useClasses && !useAep) return res;
    if (!d) {
      notes.push('Nothing says whether the readings are metres on the gauge or metres AHD, so no level can be put on them.');
      return res;
    }

    // Why the zero cannot carry a figure across, in the words the ladder's
    // notes use for the same thing.
    const noZero = zero
      ? `the gauge's zero is on ${zero.datum ? `the ${datumWord(zero.datum)}` : 'no stated datum'} rather than AHD`
      : 'the gauge has no surveyed zero';
    if (useClasses) {
      if (d === 'gauge' || ahdZero != null) {
        for (const c of cls) {
          const h = num(ed[c.key]);
          out.push({ key: c.key, kind: c.kind, label: c.label, short: c.label, rank: c.rank,
                     value: d === 'gauge' ? h : ahdZero + h, own: h, ownDatum: 'gauge', converted: d !== 'gauge' });
        }
      } else {
        notes.push(`The flood classes are heights on the gauge, and ${noZero}, so they cannot be put in metres AHD: `
          + `${cls.map(c => `${c.label.toLowerCase()} ${figure(ed[c.key], 1)} m`).join(', ')}.`);
      }
    }
    if (useAep) {
      if (d === 'AHD' || ahdZero != null) {
        aeps.forEach((l, i) => {
          const a = num(row[l.key]);
          out.push({ key: l.key, kind: 'aep', label: `${l.label} AEP`, short: l.label, rank: 4 + i, oneIn: l.oneIn,
                     aepIndex: i, aepCount: aeps.length,
                     value: d === 'AHD' ? a : a - ahdZero, own: a, ownDatum: 'AHD', converted: d !== 'AHD' });
        });
      } else {
        notes.push(`The AEP levels are metres AHD, and ${noZero}, so they cannot be brought down to heights on the gauge: `
          + `${aeps.map(l => `${l.label} ${figure(row[l.key], 2)}`).join(', ')} m AHD.`);
      }
    }
    out.sort((a, b) => a.value - b.value || a.rank - b.rank);

    // Readings that look like the other datum. Where the zero is far enough
    // from 0 m AHD that the two can be told apart — the heights on the gauge
    // a river reaches, and the same heights over the zero, with room either
    // side — a series whose middle sits in the other one's band is named for
    // what it looks like. Only said, never acted on: the datum is the
    // operator's to set, and the middle of a record is evidence, not proof.
    const t = num(typical);
    if (t != null && ahdZero != null && out.length) {
      const onGauge = [...cls.map(c => num(ed[c.key])), ...aeps.map(l => num(row[l.key]) - ahdZero)];
      const top = Math.max(0, ...onGauge);
      if (Math.abs(ahdZero) > top + 2 * SUSPECT_SLACK) {
        const inGauge = t >= -SUSPECT_SLACK && t <= top + SUSPECT_SLACK;
        const inAhd = t >= ahdZero - SUSPECT_SLACK && t <= ahdZero + top + SUSPECT_SLACK;
        const z = `${ahdZero.toFixed(2)} m AHD`;
        if (d === 'gauge' && inAhd && !inGauge) {
          res.suspect = { datum: 'AHD', words: `The readings sit around ${t.toFixed(2)} m — where this gauge's levels are in metres AHD, `
            + `over its zero of ${z}, and far above any height on the gauge. They look like metres AHD.` };
        } else if (d === 'AHD' && inGauge && !inAhd) {
          res.suspect = { datum: 'gauge', words: `The readings sit around ${t.toFixed(2)} m — where this gauge's levels are as heights on the gauge, `
            + `and far below its zero of ${z}. They look like heights on the gauge.` };
        }
      }
    }

    // A gauge re-levelled inside the series: readings before the day were
    // taken against another zero, and the lines are on today's. Only a series
    // on the gauge is moved by it — a level in AHD is the same water either
    // side of the day. Its own words rather than a note: `notes` are the
    // lines that could not be drawn, and these are drawn.
    const day = since ? String(since).slice(0, 10) : '';
    if (d === 'gauge' && day && zero && zero.from && day < String(zero.from).slice(0, 10)) {
      const then = newest(((s && s.gauge_survey) || []).filter(r => num(r.gauge_zero_m) != null
        && (!r.valid_from || r.valid_from <= day) && (!r.valid_to || r.valid_to > day)), 'valid_from')[0];
      if (then && (num(then.gauge_zero_m) !== zero.m || (then.datum || null) !== zero.datum)) {
        const was = { m: num(then.gauge_zero_m), datum: then.datum || null };
        const from = String(zero.from).slice(0, 10);
        const say = z => `${z.m.toFixed(2)} m ${z.datum === 'AHD' ? 'AHD' : `on ${z.datum ? `the ${datumWord(z.datum)}` : 'no stated datum'}`}`;
        res.relevelled = { from, was, now: { m: zero.m, datum: zero.datum },
          words: was.datum === zero.datum && zero.datum
            ? `The gauge was re-levelled on ${from}, from a zero of ${say(was)} to ${say(zero)}: a reading before then is `
              + `${Math.abs(was.m - zero.m).toFixed(2)} m ${was.m > zero.m ? 'lower' : 'higher'} than the same water reads on the gauge today, and the lines are on today's gauge.`
            : `The gauge's zero changed on ${from}, from ${say(was)} to ${say(zero)}, so readings before then may not read against these lines as later ones do.` };
      }
    }
    return res;
  }

  // A figure as the record gives it, padded to `minDp` decimals and never
  // rounded: a class of 3.25 m is 3.25, not 3.3 (river-details.js's rule for
  // the card).
  function figure(v, minDp = 0) {
    const n = num(v);
    if (n == null) return '';
    const dp = (String(n).split('.')[1] || '').length;
    return n.toFixed(Math.max(dp, minDp));
  }

  // A line as the chart labels it — its name and its height in the series'
  // datum: "Minor 7.0 m on the gauge", "1% AEP 15.15 m on the gauge",
  // "Minor 94.54 m AHD". A figure carried across a zero is to the centimetre,
  // which is what the zero and the AEP sheet are given to.
  function lineFigure(l) {
    return l.converted ? Number(l.value).toFixed(2) : figure(l.own, l.ownDatum === 'gauge' ? 1 : 2);
  }
  function lineText(l, datum) {
    return `${l.label} ${lineFigure(l)} ${datum === 'AHD' ? 'm AHD' : 'm on the gauge'}`;
  }

  // …and in full, for the line's title: where the figure came from and, for
  // one carried across, through which zero.
  function lineHow(l, res) {
    const z = res && res.zero;
    const zeroWords = z ? `the gauge zero, ${z.m.toFixed(2)} m AHD${z.from ? ` (since ${String(z.from).slice(0, 10)})` : ''}` : 'the gauge zero';
    if (l.kind === 'aep') {
      const own = `${l.label} ${figure(l.own, 2)} m AHD`;
      return l.converted
        ? `${own}, less ${zeroWords}: ${Number(l.value).toFixed(2)} m on the gauge. Modelled — indicative.`
        : `${own}, as the AEP sheet${res && res.aepAsAt ? ` of ${res.aepAsAt}` : ''} gives it. Modelled — indicative.`;
    }
    const own = `${l.label} ${figure(l.own, 1)} m on the gauge`;
    return l.converted
      ? `${own}, plus ${zeroWords}: ${Number(l.value).toFixed(2)} m AHD.`
      : `${own}, as the Bureau's flood classification${res && res.classesAsAt ? ` of ${res.classesAsAt}` : ''} gives it.`;
  }

  return {
    CLASSES, COLOURS, RISE_S, HOLD_S, DRAIN_S, ZERO_MAX_BELOW, ZERO_MAX_ABOVE,
    ladder, start, passed, colourOf, mix, cycle, gaugeText, ahdText, levelText,
    borrowable, borrowed, onGround, datumWords, datumWord, scale, spread, scaleText, peakWhen,
    curve, crowding, logFit, LOG_PX, LOG_GAP,
    lines, lineText, lineFigure, lineHow, figure,
  };
})();
if (typeof window !== 'undefined') window.FloodStages = FloodStages;
