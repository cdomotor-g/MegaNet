// MegaNet — flood-velocity.js
//
//   FloodVelocity   an indicative peak flood velocity at a station, worked out
//                   from the modelled AEP flood levels it carries (0033) with
//                   Manning's equation — for the station card, beside the wind
//                   region, as the other load a site's structures have to
//                   stand up to.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Pure: it reads a station record and returns numbers and the sentences that
// say where they came from. river-details.js draws them; nothing here touches
// the page, and the IIFE body only declares, so its position among the modules
// is free (`npm run toplevel`).
//
// ── The method ───────────────────────────────────────────────────────────────
// Manning's equation for uniform open-channel flow,
//
//     V = (1/n) · R^(2/3) · S^(1/2)
//
// with R the hydraulic radius, S the energy slope and n the roughness. For a
// flood wide against its depth R is the depth itself, which is the assumption
// made here (and it errs high in a narrow creek, where R is less than the
// depth — the safe side for somebody sizing a structure). The depth is the AEP
// level less the ground under it; the slope is the fall of the modelled flood
// surface between this station and a neighbour on the same stream, which
// tools/ingest/aep_levels.py works out from the same sheets; n is a textbook
// value for the setting — Chow's "normal" figures (*Open-Channel Hydraulics*,
// 1959, table 5-6), the middle of the ranges Queensland and NSW flood studies
// use:
//
//     channel     0.040   a natural stream, clean and winding, some pools and
//                         shoals
//     floodplain  0.060   light brush and trees — between pasture (0.030–0.050)
//                         and dense scrub (0.070 and up)
//
// A natural flood does not run supercritical for long: past a Froude number of
// 1 it jumps back. So V is capped at √(g·d), and the card says when it was.
//
// ── Channel or floodplain ────────────────────────────────────────────────────
// The sheets do not say, and nothing else MegaNet holds can tell a gauge in
// the channel from a hut on the floodplain reliably. So both are worked out
// and both are shown until somebody who knows the site picks one in the
// station editor (`setting` on the AEP row). They differ in two ways:
//
//   in the channel   the bed is the gauge zero in force (Section 6), where it
//                    is in AHD and below the sheet's ground — a gauge zero sits
//                    near the channel's low point, and the sheet's ground at a
//                    gauge is the bank the survey saw (a median 6.8 m above
//                    the zero across the 249 stations that have both). Not
//                    more than 30 m below it, and not at a storage: a dam's
//                    headwater gauge often reads AHD straight off a zero of 0,
//                    which is not a bed. Otherwise the sheet's ground. n 0.040.
//   on the floodplain  the bed is the sheet's ground. n 0.060.
//
// Above 5 m/s the card says so: few measured floods run faster, and a figure
// up there is usually a deep channel whose hydraulic radius is well short of
// its depth, or a slope that is not the one at the gauge.
//
// ── Where the slope comes from ───────────────────────────────────────────────
// In order: the AEP row's own `slope` — the ingest's same-stream figure, or one
// an editor entered — and otherwise the default for the station's ground
// height, which is the median of the same-stream slopes among stations at a
// similar height (data/aep-levels.json, meta.default_slopes; `npm run
// floodlevels` holds this copy to that one). Whatever the source, a slope
// flatter than 1:10,000 is read as 1:10,000 — between two tidal gauges tens of
// kilometres apart the difference in modelled peaks is inside the model's own
// error — and one steeper than 1:50 as 1:50.
//
// ── What it is not ───────────────────────────────────────────────────────────
// A hydraulic model. It is one equation over one point, and its inputs are
// modelled levels, a slope between two gauges and a roughness out of a table.
// Everything that shows it says "indicative", and the card shows its workings.
//
// ── In the digital twin ──────────────────────────────────────────────────────
// The twin (digital-twin.js) has what the card does not: the ground itself, to
// a metre where the State holds LiDAR. So the same equation is worked there on
// what the twin can see, and every assumption is the operator's to change for
// the session. Three pieces of that are here, pure like the rest:
//
//   ROUGHNESS   Chow's "normal" n for the channels and floodplains flood
//               studies describe, to pick a roughness by what the site looks
//               like rather than by number.
//   flowLine    the line the water runs along through the station, traced on
//               the twin's ground, and the slope of the ground along it.
//   SPEEDS      the bands the twin colours its water by, once each sample of
//               it has a speed: the same equation, its own depth, and the
//               channel's roughness or the floodplain's (atLevel for the two
//               figures at the station).
//
// The flow line. A line through the station parallel to the flow is the
// obvious thing to sample a slope along, and on real ground a straight one
// fails more often than it works: a river bends inside 400 m, the station
// stands 20 to 100 m from the channel, and a straight line out of a bend
// climbs the valley side. So the line follows the channel instead — the path
// of least cost from the channel by the gauge out to the patch's edge, both
// ways, where a step costs more the higher it stands above the lowest ground
// round it and above where it started. That keeps it on the bed of whatever
// channel the gauge is in, round every bend. Its two ends are the two
// cheapest places it can reach on a ring near the patch's edge, at least
// 100° apart seen from where it started; the lower end is downstream. The
// slope is the median of the slopes between every pair of points along it
// (Theil–Sen), which a bridge deck, a weir or a pool's flat water moves
// little.
//
// What the ground can and cannot say. LiDAR does not see through water: in a
// pool its "bed" is the water surface on the day it was flown, flat between
// riffles. Measured on the twin's own ground against the slope the sheets'
// modelled 1% AEP surface gives between same-stream gauges, at 27 Queensland
// stations, the line's slope was within a factor of two of the sheets' at 9 of
// 24 over a 400 m patch and at 17 of 27 over a 1,600 m one — the pools average
// out over a longer reach. The ground-height default the card falls back on
// is within a factor of two at 57% of the rows that have a sheet slope. So the
// line's slope is offered beside the card's, never in place of it, and the
// twin says how long a reach it was read over. A trace that finds no channel
// standing out from the ground round it — a station on a floodplain hundreds
// of metres from its river — says so (`stands` false), and so does one that
// falls too little over its length to tell which way the water runs
// (`falls` false); `clear` is neither.

const FloodVelocity = (function () {

  const G = 9.81;

  // The four floods the sheets give, most frequent first, and roughly how rare
  // each is — an AEP of 1% is a 1-in-100 chance in any year.
  const LEVELS = [
    { key: 'aep_1_m',     label: '1%',     oneIn: 100 },
    { key: 'aep_0_5_m',   label: '0.5%',   oneIn: 200 },
    { key: 'aep_0_2_m',   label: '0.2%',   oneIn: 500 },
    { key: 'aep_0_066_m', label: '0.066%', oneIn: 1500 },
  ];

  const SETTINGS = [
    { key: 'channel',    label: 'In the channel',    short: 'channel',    n: 0.04 },
    { key: 'floodplain', label: 'On the floodplain', short: 'floodplain', n: 0.06 },
  ];

  const SLOPE_MIN = 0.0001;
  const SLOPE_MAX = 0.02;
  const ZERO_MAX_BELOW = 30;   // m — a gauge zero further below the ground is no bed
  const FAST = 5;              // m/s — above this the card says to check the inputs
  // A station whose water a structure holds: its gauge zero is not a bed.
  const STORAGE_RE = /\b(dam|hw|headwater|storage|spillway)\b/i;

  // data/aep-levels.json meta.default_slopes, by ground height in m AHD: the
  // median same-stream slope among the stations in each band. `below` null is
  // the open top band.
  const DEFAULT_SLOPES = [
    { below: 10,   slope: 0.0003 },
    { below: 50,   slope: 0.001 },
    { below: 150,  slope: 0.0013 },
    { below: 400,  slope: 0.00077 },
    { below: null, slope: 0.0021 },
  ];

  // Chow (1959), table 5-6: the "normal" n for each description, minor streams
  // on a plain and flood plains — the rows Queensland and NSW flood studies
  // quote. The defaults above are a channel's third row and a floodplain's
  // light brush and trees in summer. For the twin's pickers, which name a
  // roughness by what the site looks like.
  const ROUGHNESS = {
    channel: [
      { n: 0.030, words: 'clean and straight, full stage, no rifts or deep pools' },
      { n: 0.035, words: 'clean and straight, with more stones and weeds' },
      { n: 0.040, words: 'clean and winding, some pools and shoals' },
      { n: 0.045, words: 'winding, with some weeds and stones' },
      { n: 0.050, words: 'winding, weeds and many stones' },
      { n: 0.070, words: 'sluggish and weedy, with deep pools' },
      { n: 0.100, words: 'very weedy, deep pools, or a floodway with heavy timber and underbrush' },
    ],
    floodplain: [
      { n: 0.030, words: 'short pasture, or cultivated land with no crop' },
      { n: 0.035, words: 'high grass, or mature row crops' },
      { n: 0.040, words: 'mature field crops, or cleared land with stumps' },
      { n: 0.050, words: 'scattered brush and heavy weeds' },
      { n: 0.060, words: 'light brush and trees' },
      { n: 0.070, words: 'medium to dense brush' },
      { n: 0.100, words: 'heavy timber, the flood below the branches' },
      { n: 0.120, words: 'heavy timber, the flood into the branches' },
      { n: 0.150, words: 'dense willows' },
    ],
  };
  const N_MIN = 0.01, N_MAX = 0.3;    // the bounds 0033 holds manning_n to

  // The bands the twin colours its water by, slowest first: one blue from pale
  // to deep, so that faster reads as more, never a rainbow. Scene colours and
  // legend swatches (styles.css, --flood-speed-*), one set for both themes
  // like the water's own. Half a metre a second a band to 2 m/s, where most
  // of a flood's water is; then 2–3, and 3 m/s and over is the deepest blue.
  // Bands, not a smooth ramp, so a reader can say which one a patch of water
  // is in. A speed band says nothing of hazard: that is depth and speed
  // together, and this is neither a flood map nor a hazard map.
  const SPEEDS = [
    { below: 0.5,  token: '--flood-speed-1', hex: '#9ec5f4' },
    { below: 1,    token: '--flood-speed-2', hex: '#6da7ec' },
    { below: 1.5,  token: '--flood-speed-3', hex: '#3987e5' },
    { below: 2,    token: '--flood-speed-4', hex: '#256abf' },
    { below: 3,    token: '--flood-speed-5', hex: '#184f95' },
    { below: null, token: '--flood-speed-6', hex: '#0d366b' },
  ];

  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  // The row the estimate is made from: the newest by as_at, and among rows of
  // one date the one the sheet is most confident of.
  function pickRow(s) {
    const rows = (s && Array.isArray(s.aep_levels)) ? s.aep_levels : [];
    if (!rows.length) return null;
    return rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const x = a.r.as_at || '', y = b.r.as_at || '';
      if (x !== y) return x < y ? 1 : -1;
      const cx = num(a.r.confidence) ?? -1, cy = num(b.r.confidence) ?? -1;
      if (cx !== cy) return cy - cx;
      return a.i - b.i;
    })[0].r;
  }

  // The gauge zero in force, in AHD, or null. The same rule as the card's
  // (RiverDetails.currentSurvey): open-ended newest first, else the last to end.
  function gaugeZeroAhd(s) {
    const rows = ((s && s.gauge_survey) || []).filter(r => r.datum === 'AHD' && num(r.gauge_zero_m) != null);
    if (!rows.length) return null;
    const by = f => (a, b) => ((b[f] || '') > (a[f] || '') ? 1 : (b[f] || '') < (a[f] || '') ? -1 : 0);
    const open = rows.filter(r => !r.valid_to).sort(by('valid_from'));
    const r = open[0] || rows.slice().sort(by('valid_to'))[0];
    return { m: num(r.gauge_zero_m), from: r.valid_from || null };
  }

  function defaultSlope(ground) {
    if (ground == null) return null;
    const band = DEFAULT_SLOPES.find(b => b.below == null || ground < b.below);
    return band ? band.slope : null;
  }

  // "the median slope of stations standing 50–150 m AHD": where a ground
  // height's default comes from.
  function defaultWords(ground) {
    const band = DEFAULT_SLOPES.find(b => b.below == null || ground < b.below);
    if (!band) return null;
    const i = DEFAULT_SLOPES.indexOf(band);
    const lo = i > 0 ? DEFAULT_SLOPES[i - 1].below : null;
    return 'the median slope of stations standing '
         + (lo == null ? `below ${band.below} m` : band.below == null ? `above ${lo} m` : `${lo}–${band.below} m`)
         + ' AHD';
  }

  // The slope used, where it came from, and whether it had to be bounded.
  function slopeFor(row) {
    const own = num(row.slope);
    const ground = num(row.ground_m);
    let raw, source, basis;
    if (own != null) {
      raw = own; source = row.slope_basis ? 'row' : 'entered';
      basis = row.slope_basis || 'entered on the station';
    } else {
      raw = defaultSlope(ground);
      if (raw == null) return null;
      source = 'default';
      basis = `no same-stream neighbour in the sheets — ${defaultWords(ground)}`;
    }
    return { ...bound(raw), source, basis };
  }

  // Manning, wide-flow, capped at critical flow. Depth ≤ 0 is dry: no velocity.
  function manning(depth, slope, n) {
    if (!(depth > 0) || !(slope > 0) || !(n > 0)) return { v: 0, capped: false };
    const v = (1 / n) * Math.pow(depth, 2 / 3) * Math.sqrt(slope);
    const crit = Math.sqrt(G * depth);
    return v > crit ? { v: crit, capped: true } : { v, capped: false };
  }

  // The whole estimate for a station, or null when there is nothing to work
  // from — no AEP row, no level, or no ground to measure a depth from.
  //
  //   { row, slope, settings: [{ key, label, n, nSource, bed, bedBasis,
  //       levels: [{ key, label, oneIn, level, depth, v, capped }], max, fast }],
  //     chosen, recorded, storage }
  //
  // `max` is the fastest of a setting's levels, which is the rarest flood the
  // sheet gives a level for. `recorded` is the setting on the row, when there
  // is one; `chosen` is the setting to headline — the recorded one, or the
  // channel, which is the faster of the two and so the one to design for.
  function estimate(s) {
    const row = pickRow(s);
    if (!row) return null;
    const ground = num(row.ground_m);
    const given = LEVELS.filter(l => num(row[l.key]) != null);
    if (ground == null || !given.length) return null;
    const slope = slopeFor(row);
    if (!slope) return null;
    const recorded = SETTINGS.some(t => t.key === row.setting) ? row.setting : null;
    const storage = STORAGE_RE.test((s && s.name) || '');
    const zero = storage ? null : gaugeZeroAhd(s);
    const zeroBed = zero && zero.m < ground && ground - zero.m <= ZERO_MAX_BELOW ? zero : null;

    const settings = SETTINGS.filter(t => !recorded || t.key === recorded).map(t => {
      let bed = ground, bedBasis = 'the sheet’s ground';
      if (t.key === 'channel' && zeroBed) {
        bed = zeroBed.m; bedBasis = 'the gauge zero';
      }
      const own = recorded === t.key ? num(row.manning_n) : null;
      const n = own != null ? own : t.n;
      const levels = given.map(l => {
        const level = num(row[l.key]);
        const depth = level - bed;
        const m = manning(depth, slope.used, n);
        return { key: l.key, label: l.label, oneIn: l.oneIn, level, depth, v: m.v, capped: m.capped };
      });
      const max = levels.reduce((a, b) => (b.v > a.v ? b : a), levels[0]);
      return { key: t.key, label: t.label, short: t.short, n, nSource: own != null ? 'entered' : 'default',
               bed, bedBasis, levels, max, fast: max.v > FAST };
    });
    return { row, slope, settings, recorded, storage, chosen: recorded || 'channel' };
  }

  // 0.8, 2.4, 12 — a velocity to the tenth below 10 m/s, and never "0.0" for
  // a flow that is there but slow.
  function speed(v) {
    if (!(v > 0)) return '0';
    if (v < 0.1) return '<0.1';
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }

  // 1:1,250 — how a slope is said.
  function slopeRatio(s) {
    if (!(s > 0)) return 'flat';
    const r = 1 / s;
    const round = r >= 10000 ? 1000 : r >= 1000 ? 50 : r >= 100 ? 5 : 1;
    return `1:${(Math.round(r / round) * round).toLocaleString('en-AU')}`;
  }

  // A slope as this module will use it: held between the flattest and the
  // steepest it reads (see "Where the slope comes from").
  function bound(raw) {
    const used = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, raw));
    return { raw, used, bounded: used !== raw };
  }

  // A roughness said in words, where it is one of Chow's.
  function roughnessWords(key, n) {
    const row = (ROUGHNESS[key] || []).find(r => Math.abs(r.n - n) < 1e-9);
    return row ? row.words : null;
  }

  // Which band of SPEEDS a speed is in.
  function speedBand(v) {
    const i = SPEEDS.findIndex(b => b.below == null || v < b.below);
    return i < 0 ? SPEEDS.length - 1 : i;
  }
  // "under 0.5", "0.5–1", "3 and over" — in m/s.
  function speedBandWords(i) {
    const b = SPEEDS[i], lo = i ? SPEEDS[i - 1].below : null;
    return lo == null ? `under ${b.below}` : b.below == null ? `${lo} and over` : `${lo}–${b.below}`;
  }

  // The two figures at a station for a water level (m AHD): in the channel by
  // the gauge, over its bed, and at the station's own ground — each Manning,
  // wide-flow, with its own depth and roughness and the one slope.
  //   a: { bed, ground, slope, nChannel, nPlain }
  function atLevel(level, a) {
    const ch = manning(level - a.bed, a.slope, a.nChannel);
    const at = manning(level - a.ground, a.slope, a.nPlain);
    return {
      channel: { depth: level - a.bed, v: ch.v, capped: ch.capped },
      ground:  { depth: level - a.ground, v: at.v, capped: at.capped },
    };
  }

  // ── The flow line (see "In the digital twin" above) ──
  // A binary heap on two parallel arrays: keys and the cells they belong to.
  function heap() {
    const k = [], v = [];
    return {
      get size() { return k.length; },
      push(key, val) {
        let c = k.length; k.push(key); v.push(val);
        while (c > 0) { const p = (c - 1) >> 1; if (k[p] <= key) break; k[c] = k[p]; v[c] = v[p]; c = p; }
        k[c] = key; v[c] = val;
      },
      pop(out) {
        out[0] = k[0]; out[1] = v[0];
        const kk = k.pop(), vv = v.pop(), len = k.length;
        if (!len) return;
        let c = 0;
        for (;;) {
          let l = 2 * c + 1;
          if (l >= len) break;
          if (l + 1 < len && k[l + 1] < k[l]) l++;
          if (k[l] >= kk) break;
          k[c] = k[l]; v[c] = v[l]; c = l;
        }
        k[c] = kk; v[c] = vv;
      },
    };
  }

  // The lowest ground in the square r samples about each sample (two passes,
  // a row and a column), holes skipped.
  function lowAbout(e, n, r) {
    const row = new Float64Array(n * n), out = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let m = Infinity;
        for (let x = Math.max(0, i - r); x <= Math.min(n - 1, i + r); x++) { const h = e[j * n + x]; if (h < m) m = h; }
        row[j * n + i] = m;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let m = Infinity;
        for (let y = Math.max(0, j - r); y <= Math.min(n - 1, j + r); y++) { const h = row[y * n + i]; if (h < m) m = h; }
        out[j * n + i] = m;
      }
    }
    return out;
  }

  // Theil–Sen: the median of the slopes between pairs of points, and the
  // share of them that fall the same way it does. Up to ~150 points are used,
  // evenly spread, which is ~11,000 pairs.
  function theilSen(pts) {
    const stride = Math.max(1, Math.ceil(pts.length / 150));
    const p = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
    const sl = [];
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const ds = p[j].s - p[i].s;
        if (ds > 0) sl.push((p[j].h - p[i].h) / ds);
      }
    }
    if (!sl.length) return { slope: 0, intercept: p.length ? p[0].h : NaN, agree: 0 };
    sl.sort((a, b) => a - b);
    const m = sl[sl.length >> 1];
    const c = p.map(q => q.h - m * q.s).sort((a, b) => a - b)[p.length >> 1];
    const agree = m === 0 ? 0 : sl.filter(x => Math.sign(x) === Math.sign(m)).length / sl.length;
    return { slope: m, intercept: c, agree };
  }

  const LINE_LOW_M   = 20;     // the lowest ground "round" a sample is looked for this far off
  const LINE_RELIEF  = 0.3;    // m over that lowest ground at which a step costs twice
  const LINE_RISE    = 0.004;  // and the rise over the start that costs twice, per metre out
  const LINE_SEP     = 100;    // degrees: the two ends at least this far apart, seen from the start
  const LINE_CLEAR   = 2;      // a channel stands out when the ring costs this much more elsewhere
  const LINE_AGREE   = 0.6;    // and the line falls clearly when this share of its pairs agree

  // The flow line on a grid of the twin's: { elev (m AHD, n × n, row 0 north),
  // n, size } — x east and z south of the station at the middle sample.
  //   opts.from  { x, z } to start from (default the station), and
  //   opts.near  m round it to look for the lowest sample to start on.
  // Returns { ok: false, why } or
  //   { ok: true, points: [{ x, z, s, h }] upstream end first — x, z smoothed
  //     for drawing, s along the line from that end, h the ground there —
  //     start: { x, z, h, s }, length, straight, sinuosity, slope (m/m, the
  //     fall it reads; 0 where it rises), fit: { slope, intercept } (h = c − slope·s),
  //     agree, bearing (from the upstream end to the downstream, degrees from
  //     north), heading (the same, along the line at the start), contrast:
  //     { up, down } (what a metre of the ring costs to reach elsewhere, over
  //     what it cost at that end), stands (both ends stand out so: a channel),
  //     falls (its pairs agree which way it falls), clear (both) }
  function flowLine(g, opts = {}) {
    const n = g && g.n, e = g && g.elev;
    if (!(n >= 9) || !e || e.length !== n * n || !(g.size > 0)) return { ok: false, why: 'no ground' };
    const half = g.size / 2, step = g.size / (n - 1);
    const X = k => -half + (k % n) * step, Z = k => -half + Math.floor(k / n) * step;
    const from = opts.from || { x: 0, z: 0 }, near = opts.near != null ? opts.near : 60;
    // The start: the lowest sample within `near` of the point given.
    let start = -1;
    const ci = Math.round((from.x + half) / step), cj = Math.round((from.z + half) / step);
    const rr = Math.ceil(near / step);
    for (let j = Math.max(0, cj - rr); j <= Math.min(n - 1, cj + rr); j++) {
      for (let i = Math.max(0, ci - rr); i <= Math.min(n - 1, ci + rr); i++) {
        const k = j * n + i;
        if (!Number.isFinite(e[k]) || Math.hypot(X(k) - from.x, Z(k) - from.z) > near + 1e-9) continue;
        if (start < 0 || e[k] < e[start]) start = k;
      }
    }
    if (start < 0) return { ok: false, why: 'no ground at the start' };

    // What a step costs, per metre: more the higher it stands over the lowest
    // ground round it, and over where the line began.
    const rho = half - Math.max(8 * step, LINE_LOW_M);
    if (!(rho > 4 * step)) return { ok: false, why: 'the patch is too small' };
    const low = lowAbout(e, n, Math.max(3, Math.round(LINE_LOW_M / step)));
    const h0 = e[start], rise = Math.max(1, LINE_RISE * rho);
    const cost = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) {
      if (!Number.isFinite(e[k])) { cost[k] = Infinity; continue; }
      const a = (e[k] - low[k]) / LINE_RELIEF, b = Math.max(0, e[k] - h0) / rise;
      cost[k] = 1 + a * a + b * b;
    }
    // The least cost from the start to every sample (Dijkstra), and the way back.
    const D = new Float64Array(n * n).fill(Infinity), prev = new Int32Array(n * n).fill(-1);
    const q = heap(), top = [0, 0];
    D[start] = 0; q.push(0, start);
    while (q.size) {
      q.pop(top);
      const d = top[0], k = top[1];
      if (d > D[k]) continue;
      const i0 = k % n, j0 = (k - i0) / n;
      for (let dj = -1; dj <= 1; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= n) continue;
        for (let di = -1; di <= 1; di++) {
          const i = i0 + di;
          if ((!di && !dj) || i < 0 || i >= n) continue;
          const m = j * n + i;
          if (cost[m] === Infinity) continue;
          const nd = d + (di && dj ? Math.SQRT2 : 1) * step * (cost[k] + cost[m]) / 2;
          if (nd < D[m]) { D[m] = nd; prev[m] = k; q.push(nd, m); }
        }
      }
    }
    // The ring: every sample about rho from the station, each with what it
    // cost a metre to reach from the start.
    const sx = X(start), sz = Z(start);
    const ring = [];
    for (let k = 0; k < n * n; k++) {
      if (!Number.isFinite(D[k]) || Math.abs(Math.hypot(X(k), Z(k)) - rho) > 0.75 * step) continue;
      const far = Math.hypot(X(k) - sx, Z(k) - sz);
      if (far < 2 * step) continue;
      ring.push({ k, per: D[k] / far, ang: Math.atan2(X(k) - sx, -(Z(k) - sz)) });
    }
    if (ring.length < 8) return { ok: false, why: 'the line reaches too little of the patch' };
    ring.sort((a, b) => a.per - b.per);
    const apart = (p, r) => { let d = Math.abs(p - r) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d * 180 / Math.PI; };
    const A = ring[0], B = ring.find(r => apart(r.ang, A.ang) >= LINE_SEP);
    if (!B) return { ok: false, why: 'the line reaches the patch\'s edge on one side only' };
    const typical = ring[ring.length >> 1].per;

    // The line: A's end, back to the start, out to B's.
    const back = k => { const out = []; for (let c = k; c >= 0; c = prev[c]) out.push(c); return out; };
    const toA = back(A.k), toB = back(B.k);
    let cells = toA.concat(toB.slice(0, -1).reverse());
    let at = toA.length - 1;
    // Smoothed for drawing and for measuring — an 8-connected path is a
    // staircase, half again as long as the channel on a diagonal — over two
    // samples either side; the ends stay where they are.
    const smooth = list => list.map((c, i) => {
      if (i === 0 || i === list.length - 1) return { x: X(c), z: Z(c) };
      let x = 0, z = 0, w = 0;
      for (let d = -2; d <= 2; d++) {
        const c2 = list[Math.max(0, Math.min(list.length - 1, i + d))];
        x += X(c2); z += Z(c2); w++;
      }
      return { x: x / w, z: z / w };
    });
    const measure = list => {
      const xy = smooth(list);
      let s = 0;
      return xy.map((p, i) => {
        if (i) s += Math.hypot(p.x - xy[i - 1].x, p.z - xy[i - 1].z);
        return { x: p.x, z: p.z, s, h: e[list[i]] };
      });
    };
    let points = measure(cells);
    let fit = theilSen(points);
    let ends = { up: A, down: B };
    // Upstream first: the end the ground falls from.
    if (fit.slope > 0) {
      cells = cells.slice().reverse();
      at = cells.length - 1 - at;
      points = measure(cells);
      fit = theilSen(points);
      ends = { up: B, down: A };
    }
    const length = points[points.length - 1].s;
    const u = points[0], w = points[points.length - 1];
    const straight = Math.hypot(w.x - u.x, w.z - u.z);
    const compass = (dx, dz) => ((Math.atan2(dx, -dz) * 180 / Math.PI) % 360 + 360) % 360;
    // The heading at the start: along the line 20 m either side of it.
    const sAt = points[at].s;
    const near20 = d => points.reduce((b, p) => (Math.abs(p.s - (sAt + d)) < Math.abs(b.s - (sAt + d)) ? p : b), points[at]);
    const pa = near20(-20), pb = near20(20);
    const contrast = { up: typical / ends.up.per, down: typical / ends.down.per };
    const stands = Math.min(contrast.up, contrast.down) >= LINE_CLEAR, falls = fit.agree >= LINE_AGREE;
    return {
      ok: true, points,
      start: { x: points[at].x, z: points[at].z, h: points[at].h, s: sAt, cell: { x: X(start), z: Z(start) } },
      length, straight, sinuosity: straight > 0 ? length / straight : null,
      slope: Math.max(0, -fit.slope), fit: { slope: -fit.slope, intercept: fit.intercept }, agree: fit.agree,
      bearing: compass(w.x - u.x, w.z - u.z),
      heading: compass(pb.x - pa.x, pb.z - pa.z),
      contrast, stands, falls, clear: stands && falls,
      step, ring: rho,
    };
  }

  return {
    LEVELS,
    SETTINGS,
    DEFAULT_SLOPES,
    SLOPE_MIN,
    SLOPE_MAX,
    FAST,
    ROUGHNESS,
    N_MIN,
    N_MAX,
    SPEEDS,
    pickRow,
    manning,
    estimate,
    speed,
    slopeRatio,
    bound,
    defaultSlope,
    defaultWords,
    roughnessWords,
    speedBand,
    speedBandWords,
    atLevel,
    flowLine,
  };
})();
if (typeof window !== 'undefined') window.FloodVelocity = FloodVelocity;
