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
      const band = DEFAULT_SLOPES.find(b => b.below == null || ground < b.below);
      const i = DEFAULT_SLOPES.indexOf(band);
      const lo = i > 0 ? DEFAULT_SLOPES[i - 1].below : null;
      basis = `no same-stream neighbour in the sheets — the median slope of stations standing `
            + (lo == null ? `below ${band.below} m` : band.below == null ? `above ${lo} m` : `${lo}–${band.below} m`)
            + ' AHD';
    }
    const used = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, raw));
    return { raw, used, source, basis, bounded: used !== raw };
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

  return {
    LEVELS,
    SETTINGS,
    DEFAULT_SLOPES,
    SLOPE_MIN,
    SLOPE_MAX,
    FAST,
    pickRow,
    manning,
    estimate,
    speed,
    slopeRatio,
  };
})();
if (typeof window !== 'undefined') window.FloodVelocity = FloodVelocity;
