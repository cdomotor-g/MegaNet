// MegaNet — kb-staff.js
//
//   KbStaff   📏 the Staff Simulator tab (Knowledge base): reading a levelling
//             staff through the level, in seven short modules — the central
//             hair, the stadia hairs and the distance they give, the same
//             reading at six distances, heat haze, wind on an extended staff,
//             rocking the staff, and one complete two-peg test. Each module is
//             a few paragraphs and a drill: an E-pattern staff drawn in SVG
//             behind the crosshairs, focus sliders for the staff and the
//             crosshairs, and the reading typed in metres and marked. Adapted
//             from Mallee HydroTech's Survey Staff Simulator
//             (github.com/MalleeHydroTech/survey-staff-simulator): its staff
//             face, its readings, its tolerances and its motion models for
//             haze, wind and rocking are ported number for number; its React
//             app, its progress rail, its certificate and its picture of the
//             level are left out, and the teaching words around each drill are
//             Flood-Net's condensing of the original's own prompts.
//
// After core.js and knowledge-base.js (and two-peg.js, whose diagram module 7
// borrows when it is there), before init.js. Reaches back to core.js for esc
// and to app.js for switchTab. Nothing runs at load.
//
// Every figure a learner is marked against comes from the ported models
// below, so the text and the marking cannot disagree.

const KbStaff = (function () {
  const TAB = 'kbstaff';
  const STORE = 'floodnet-kb-staff';
  const $ = id => document.getElementById(id);

  // ── The staff and the eyepiece (the original's staff-model.ts) ─────────────
  // The eyepiece is a 720-unit square; the staff is drawn at 1800 units a
  // metre and then magnified about the centre by (scale × 3).
  const CASES = [0.842, 1.126, 1.374, 1.586, 1.928, 2.147, 2.463, 2.714, 3.086, 3.418];
  const ORDER = [3, 0, 7, 1, 9, 4, 6, 2, 8, 5];
  const C = 360, PPM = 1800, MAG = 3, DM = PPM / 10;
  const STADIA_PX = 172;                       // hairs ±172 units from the centre on screen
  const TOL = 0.001, DIST_TOL = 0.005, K = 100, MASTERY = 3;
  const STATIC_SCALE = 0.5;
  const E_W = 0.52;                            // face width ÷ decimetre height
  // [x, y, w, h] as fractions of one decimetre's face: rule, stem, the E's
  // three arms, the two blocks below.
  const E_RECTS = [[0.17, 0, 0.66, 0.008], [0.17, 0, 0.19, 0.5], [0.17, 0, 0.38, 0.1], [0.17, 0.2, 0.38, 0.1],
    [0.17, 0.4, 0.38, 0.1], [0.17, 0.6, 0.19, 0.1], [0.17, 0.8, 0.19, 0.1]];
  const NUM_BOX = [0.46, 0.56, 0.37, 0.38];
  // The staff's condensed upright numerals, as strokes in a unit box.
  const DIGITS = {
    0: [[0.14, 0.07, 0.86, 0.07], [0.86, 0.07, 0.86, 0.93], [0.86, 0.93, 0.14, 0.93], [0.14, 0.93, 0.14, 0.07]],
    1: [[0.24, 0.22, 0.5, 0.07], [0.5, 0.07, 0.5, 0.93], [0.2, 0.93, 0.8, 0.93]],
    2: [[0.14, 0.1, 0.84, 0.1], [0.84, 0.1, 0.84, 0.46], [0.84, 0.46, 0.14, 0.46], [0.14, 0.46, 0.14, 0.93], [0.14, 0.93, 0.86, 0.93]],
    3: [[0.14, 0.1, 0.84, 0.1], [0.84, 0.1, 0.84, 0.93], [0.14, 0.5, 0.78, 0.5], [0.14, 0.93, 0.84, 0.93]],
    4: [[0.14, 0.1, 0.14, 0.5], [0.14, 0.5, 0.86, 0.5], [0.78, 0.07, 0.78, 0.93]],
    5: [[0.84, 0.1, 0.14, 0.1], [0.14, 0.1, 0.14, 0.5], [0.14, 0.5, 0.84, 0.5], [0.84, 0.5, 0.84, 0.93], [0.84, 0.93, 0.14, 0.93]],
    6: [[0.84, 0.1, 0.14, 0.1], [0.14, 0.1, 0.14, 0.93], [0.14, 0.5, 0.84, 0.5], [0.84, 0.5, 0.84, 0.93], [0.84, 0.93, 0.14, 0.93]],
    7: [[0.14, 0.1, 0.86, 0.1], [0.8, 0.1, 0.36, 0.93]],
    8: [[0.14, 0.07, 0.86, 0.07], [0.14, 0.5, 0.86, 0.5], [0.14, 0.93, 0.86, 0.93], [0.14, 0.07, 0.14, 0.93], [0.86, 0.07, 0.86, 0.93]],
    9: [[0.14, 0.07, 0.86, 0.07], [0.14, 0.07, 0.14, 0.5], [0.14, 0.5, 0.86, 0.5], [0.86, 0.07, 0.86, 0.93], [0.14, 0.93, 0.86, 0.93]],
  };
  // Module 3: [sight, apparent scale] — the same readings, the staff further away each time.
  const DIST_CASES = [[5, 2], [10, 1], [20, 0.5], [30, 0.33], [40, 0.25], [50, 0.2]];
  // [staff target, crosshair target] per case: where each focus is sharp.
  const FOCUS = [[62, 38], [41, 69], [74, 46], [53, 77], [68, 55], [36, 63], [58, 32], [47, 72], [71, 43], [44, 59]];
  // The original blurs in screen pixels; this eyepiece is drawn at about half
  // its size on a phone, so a viewBox unit counts for a little more.
  const BLUR_K = 1.5;

  const rnd = (v, dp) => Number(v.toFixed(dp));
  const mm = v => Math.round((v + Number.EPSILON) * 1000) / 1000;
  const cm = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const n2 = v => +v.toFixed(2);
  const f3 = v => v.toFixed(3);
  const rad = d => d * Math.PI / 180;
  const caseFor = step => CASES[ORDER[step % ORDER.length]];
  const norm = p => ((p % 1) + 1) % 1;

  // A reading as typed: a comma for the point is fine, nothing else is.
  function parse(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input !== 'string') return null;
    const s = input.trim().replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }
  const near = (got, want, tol = TOL) => Number.isFinite(got) && Math.abs(got - want) <= tol + 1e-9;

  // Piecewise-linear between keyframes, as the original's models do it.
  function interp(phases, values, phase) {
    if (phase === 1) return values[values.length - 1];
    const p = norm(phase);
    let i = phases.findIndex((t, k) => phases[k + 1] !== undefined && p >= t && p <= phases[k + 1]);
    if (i < 0) i = 0;
    const a = phases[i], b = phases[i + 1] ?? 1;
    const va = values[i], vb = values[i + 1] ?? va;
    return va + (vb - va) * ((p - a) / (b - a));
  }

  // Stadia hairs sit a fixed distance either side of the centre on screen, so
  // on the staff their spacing shrinks as the staff is drawn bigger.
  function stadia(central, scale) {
    const off = (STADIA_PX / MAG) / (PPM * scale);
    const upper = mm(central + off), lower = mm(central - off);
    return { central, upper, lower, distance: cm((upper - lower) * K) };
  }

  // ── Focus: the crosshairs stay set; the staff needs refocusing each time ───
  function focusFor(step) {
    const [st, rt] = FOCUS[ORDER[step % ORDER.length]];
    const dir = step % 2 === 0 ? -1 : 1;
    return { sf: st + dir * 19, st, rf: rt - dir * 17, rt };
  }
  function imperfect(target) {
    const r = Math.min(Math.max(Math.random(), 0), 1);
    const lo = Math.max(0, target - 24), hi = Math.min(100, target + 24);
    const v = lo + (hi - lo) * r;
    if (Math.abs(v - target) >= 12) return v;
    return v >= target && target + 12 <= 100 ? target + 12 : target - 12;
  }
  function nextFocus(f, step) {
    const t = focusFor(step).st;
    return { ...f, sf: imperfect(t), st: t };
  }
  const blurs = f => ({ s: Math.abs(f.sf - f.st) * 0.065 * BLUR_K, r: Math.abs(f.rf - f.rt) * 0.045 * BLUR_K });

  // ── Module 4: heat haze (heat-haze-model.ts) ──────────────────────────────
  const HAZE_D = [15, 25, 40];
  const HAZE = {
    15: { scale: 0.72, hx: 2.5, vy: 0.001, blur: 0.18, disp: 1.6, fine: 0.7, vpx: 0.8 },
    25: { scale: 0.57, hx: 4.5, vy: 0.002, blur: 0.26, disp: 3.2, fine: 1.1, vpx: 1.2 },
    40: { scale: 0.42, hx: 7, vy: 0.003, blur: 0.34, disp: 5.4, fine: 1.6, vpx: 1.6 },
  };
  const HAZE_PH = [0, 0.07, 0.16, 0.24, 0.33, 0.41, 0.5, 0.59, 0.68, 0.78, 0.89, 1];
  const HAZE_WAVE = [[0, 0], [0.35, 0.22], [-0.1, 0.75], [-0.7, 0.55], [-0.95, -0.1], [-0.35, -0.8], [0.4, -1],
    [0.9, -0.45], [0.62, 0.2], [-0.15, 0.8], [-0.78, 0.45], [0, 0]];
  const HAZE_BLUR = [0, 0.25, 0.65, 0.4, 0.8, 0.15, 0.55, 0.85, 0.3, 0.72, 0.38, 0];
  const HAZE_FREQ = [[1, 1], [1.08, 0.92], [0.94, 1.12], [1.16, 0.88], [0.9, 1.06], [1.12, 0.96],
    [0.96, 1.16], [1.18, 0.9], [0.92, 1.08], [1.1, 0.94], [0.98, 1.14], [1, 1]];

  // The answer is the staff at rest; the tolerance is how far the haze can
  // carry the hair off it, rounded up to the millimetre (1, 2 and 3 mm).
  function haze(step) {
    const d = HAZE_D[step % HAZE_D.length], h = HAZE[d];
    const ds = h.scale * MAG;
    const vAmp = rnd(rnd(h.vy * 0.75, 6) * PPM * ds, 4);
    const frames = HAZE_WAVE.map(([x, y]) => [rnd(x * h.hx, 4), rnd(y * vAmp, 4)]);
    const maxY = Math.max(...frames.map(f => Math.abs(f[1])));
    const env = rnd((maxY + h.vpx) / (PPM * ds), 6);
    const tol = rnd(Math.max(0.001, Math.ceil(env * 1000) / 1000), 3);
    const sample = rnd((d * 0.037 + 0.01) % 1, 6);
    const still = [rnd(interp(HAZE_PH, HAZE_WAVE.map(w => w[0]), sample) * h.hx, 4),
      rnd(interp(HAZE_PH, HAZE_WAVE.map(w => w[1]), sample) * vAmp, 4)];
    return { d, h, central: caseFor(step), scale: h.scale, answer: caseFor(step), tol, frames, still };
  }

  // ── Module 6: rocking the staff (staff-rocking-model.ts) ───────────────────
  const ROCK_READ = [0.842, 2.147, 3.418];
  const ROCK_PH = [0, 0.12, 0.24, 0.36, 0.5, 0.64, 0.76, 0.88, 1];
  const ROCK_ANG = [0, 2.7, 4.5, 2, 0, -2, -4.5, -2.7, 0];
  const ROCK_COS = ROCK_ANG.map(a => Math.cos(rad(a)));
  const ROCK_STILL = [3.5, -3.5, 0];
  const ROCK_DS = STATIC_SCALE * MAG;
  // Leaning towards or away from the level shortens the staff's height in the
  // line of sight by cos(lean), about its foot — so the hair cuts it higher.
  const rockPivot = r => C + r * PPM * ROCK_DS;
  const rockRead = (r, lean) => r / Math.cos(rad(lean));
  function rockExcursion(r, phase) {
    const seen = rnd(r / interp(ROCK_PH, ROCK_COS, phase), 6);
    return rnd(Math.max(0, seen - r), 6);
  }

  // ── Module 5: wind on an extended staff (wind-stability-model.ts) ──────────
  const WIND_EXT = [1.0, 2.5, 4.5];
  const WIND_READ = [0.873, 2.647, 4.537];
  const WIND_BAND = ['Low reading', 'Middle reading', 'High reading'];
  const WIND_STILL = [0.18, 0.52, 0.84];
  const WIND_PH = [0, 0.021, 0.049, 0.081, 0.126, 0.171, 0.208, 0.241, 0.279, 0.314, 0.359, 0.402, 0.431, 0.477,
    0.516, 0.557, 0.604, 0.632, 0.669, 0.704, 0.748, 0.781, 0.812, 0.842, 0.874, 0.897, 0.919, 0.942, 0.963,
    0.978, 0.987, 0.992, 0.996, 0.999, 1];
  const WIND_LAT = [0, 0.08, 0.18, 0.29, 0.35, 0.28, 0.14, 0.06, 0.02, -0.01, -0.06, -0.16, -0.25, -0.29, -0.24,
    -0.12, -0.02, 0.04, 0.08, 0.05, 0.01, -0.02, -0.03, 0.02, 0.11, 0.19, 0.23, 0.18, 0.09, 0.03, -0.02, -0.04,
    -0.02, 0.01, 0];
  const WIND_FA = [0, 0.12, 0.2, 0.23, 0.17, 0.09, 0.02, -0.04, -0.08, -0.11, -0.08, -0.01, 0.09, 0.15, 0.12, 0.04,
    -0.06, -0.12, -0.13, -0.08, -0.01, 0.05, 0.07, 0.03, -0.05, -0.13, -0.18, -0.15, -0.08, -0.02, 0.03, 0.08,
    0.09, 0.04, 0];
  const WIND_ANG = [0, 0.05, 0.16, 0.28, 0.34, 0.23, 0.08, -0.01, -0.08, -0.12, -0.19, -0.27, -0.22, -0.08, 0.06,
    0.12, 0.08, 0.02, -0.05, -0.11, -0.06, 0.03, 0.1, 0.17, 0.22, 0.16, 0.06, -0.02, -0.1, -0.14, -0.08, 0.01,
    0.08, 0.05, 0];
  const WIND_DS = (1 / 3) * MAG;               // = 1

  // The foot stays put. A gust leans the staff sideways (×3 so it shows) and
  // fore-and-aft, more the further it is extended, with the rocking model's
  // foreshortening doubled on top; the hair reads reference ÷ d.
  function windAt(ext, phase, ref) {
    const f = ext / 4.5;
    const p = phase === 1 ? 1 : norm(phase);
    const tilt = rnd(interp(WIND_PH, WIND_FA, phase) * f * 1.25, 4);
    const fa = rnd(Math.cos(rad(tilt)), 8);
    const rock = rnd(ref / (ref + rockExcursion(ref, p) * 2), 8);
    const sy = rnd(fa * rock, 8);
    const cur = rnd((interp(WIND_PH, WIND_ANG, p) * 0.75 + interp(WIND_PH, WIND_LAT, p) * 0.25) * f * 1.5, 4);
    const rot = rnd(cur * 3, 4);
    return { rot, sy, d: Math.cos(rad(rot)) * sy };
  }
  const windPivot = ref => C + ref * PPM * WIND_DS;
  function windMatrix(w, px, py) {
    const c = Math.cos(rad(w.rot)), s = Math.sin(rad(w.rot));
    const a = c, b = s, cc = -s * w.sy, d = c * w.sy;
    return [a, b, cc, d, px - a * px - cc * py, py - b * px - d * py].map(v => v.toFixed(8)).join(' ');
  }
  // Any reading the moving staff actually shows is accepted: from the plumb
  // reading up to the highest the gusts reach, to the millimetre.
  const windRanges = [];
  function windRange(i) {
    if (windRanges[i]) return windRanges[i];
    const ext = WIND_EXT[i], ref = WIND_READ[i];
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 2049; k++) {
      const v = ref / windAt(ext, k / 2048, ref).d;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    windRanges[i] = {
      min: rnd(Math.floor((lo + 1e-9) * 1000) / 1000, 3),
      max: rnd(Math.ceil((hi - 1e-9) * 1000) / 1000, 3),
    };
    return windRanges[i];
  }

  // ── Module 7: the two-peg test (two-peg-model.ts) ──────────────────────────
  const PEG = { base: 50, midMin: 23, midMax: 27, min: -6, max: 56, step: 0.5, perM: 0.002 / 50 };
  const PEG_CASES = [
    [100.000, 100.246, 101.842, 101.876],
    [100.420, 99.873, 101.926, 101.859],
    [101.105, 100.782, 102.344, 102.396],
    [100.912, 101.203, 102.574, 102.546],
    [101.514, 101.127, 103.452, 103.543],
    [99.842, 100.531, 102.384, 102.341],
  ];                                           // [RL A, RL B, set-up 1 HI, set-up 2 HI]
  const PEG_X0 = 86, PEG_X1 = 914, PEG_GY = 150;
  const pegX = m => PEG_X0 + (m - PEG.min) / (PEG.max - PEG.min) * (PEG_X1 - PEG_X0);
  const pegM = x => Math.min(PEG.max, Math.max(PEG.min, PEG.min + (x - PEG_X0) / (PEG_X1 - PEG_X0) * (PEG.max - PEG.min)));
  const pegSnap = m => Math.round(Math.min(PEG.max, Math.max(PEG.min, m)) / PEG.step) * PEG.step;
  const midOk = m => m >= PEG.midMin - 1e-9 && m <= PEG.midMax + 1e-9;
  const nearOk = m => (m >= -6 - 1e-9 && m <= -4 + 1e-9) || (m >= 4 - 1e-9 && m <= 6 + 1e-9);
  // The level's line of sight is built 2 mm out over the 50 m (0.04 mm a
  // metre of sight); set-up 1 is booked as if it were perfect, since it cancels.
  function pegObs(c, pos, setup) {
    const dA = Math.abs(pos), dB = Math.abs(pos - PEG.base);
    const hi = setup === 1 ? c[2] : c[3];
    const eA = setup === 1 ? 0 : dA * PEG.perM, eB = setup === 1 ? 0 : dB * PEG.perM;
    const a = mm(hi - c[0] + eA), b = mm(hi - c[1] + eB);
    return { dA, dB, a, b, diff: mm(a - b), sA: 10 / dA, sB: 10 / dB };
  }
  const PEG_LABEL = { a: 'Staff A reading', b: 'Staff B reading', d: 'the absolute staff difference', r: 'the difference between results' };

  // ── Drawing the view through the eyepiece ──────────────────────────────────
  function face(central, ds) {
    const w = DM * E_W, left = C - w / 2;
    const half = ds === 1 ? 0.23 : C / (PPM * ds) + 0.05;
    const lo = Math.max(0, Math.floor((central - half) * 10));
    const hi = Math.ceil((central + half) * 10);
    const y = r => C - (r - central) * PPM;
    const top = y((hi + 1) / 10) - 12, bot = y(lo / 10) + 12;
    let out = `<rect class="ks-staff" x="${n2(left)}" y="${n2(top)}" width="${n2(w)}" height="${n2(bot - top)}" rx="3"/>
      <rect class="ks-edge" x="${n2(left + 7)}" y="${n2(top)}" width="5" height="${n2(bot - top)}"/>
      <rect class="ks-edge" x="${n2(left + w - 12)}" y="${n2(top)}" width="5" height="${n2(bot - top)}"/>`;
    for (let b = lo; b <= hi; b++) {
      const rev = b % 2 !== 1;                 // the E faces the other way on even decimetres
      const red = Math.floor(b / 10) % 2 !== 0; // red on odd metres
      const X = (x, rw) => (rev ? w - x * w - rw * w : x * w);
      let d = '';
      for (const [x, yy, rw, rh] of E_RECTS) d += `M${n2(X(x, rw))} ${n2(yy * DM)}h${n2(rw * w)}v${n2(rh * DM)}h${n2(-rw * w)}z`;
      const bw = NUM_BOX[2] * w, bx = X(NUM_BOX[0], NUM_BOX[2]);
      const s = String(b).padStart(2, '0');
      const gw = bw * 0.34, gap = bw * 0.08, gh = DM * 0.31, ty = DM * 0.93 - gh;
      const x0 = bx + (bw - (s.length * gw + (s.length - 1) * gap)) / 2;
      let p = '';
      [...s].forEach((ch, i) => {
        const gx = x0 + i * (gw + gap);
        for (const [x1, y1, x2, y2] of DIGITS[ch]) p += `M${n2(gx + x1 * gw)} ${n2(ty + y1 * gh)}L${n2(gx + x2 * gw)} ${n2(ty + y2 * gh)}`;
      });
      out += `<g transform="translate(${n2(left)} ${n2(y((b + 1) / 10))})"><path class="${red ? 'ks-r' : 'ks-k'}" d="${d}"/><path class="${red ? 'ks-rn' : 'ks-kn'}" stroke-width="3.24" d="${p}"/></g>`;
    }
    return `<g transform="translate(${C} ${C}) scale(${ds}) translate(${-C} ${-C})">${out}</g>`;
  }

  function hazeFilter(id, h, d, animate) {
    const f = (d - 15) / 25;
    const bx = rnd(0.0035 + f * 0.0015, 5), by = rnd(0.024 + f * 0.012, 5);
    const fx = rnd(bx * 2.6, 5), fy = rnd(by * 1.55, 5);
    const kt = HAZE_PH.map(p => p.toFixed(2)).join(';');
    const anim = (x, y) => (animate ? `<animate attributeName="baseFrequency" dur="12s" repeatCount="indefinite" calcMode="linear" keyTimes="${kt}"
      values="${HAZE_FREQ.map(([mx, my]) => `${(x * mx).toFixed(5)} ${(y * my).toFixed(5)}`).join(';')}"/>` : '');
    const seed = 17 + Math.round(d);
    return `<filter id="${id}" x="-40" y="-40" width="800" height="800" filterUnits="userSpaceOnUse">
      <feTurbulence type="fractalNoise" baseFrequency="${bx} ${by}" numOctaves="1" seed="${seed}" stitchTiles="stitch" result="n1">${anim(bx, by)}</feTurbulence>
      <feComponentTransfer in="n1" result="n1h"><feFuncA type="table" tableValues="0.5 0.5"/></feComponentTransfer>
      <feDisplacementMap in="SourceGraphic" in2="n1h" scale="${h.disp}" xChannelSelector="R" yChannelSelector="A" result="d1"/>
      <feTurbulence type="fractalNoise" baseFrequency="${fx} ${fy}" numOctaves="1" seed="${seed + 41}" stitchTiles="stitch" result="n2">${anim(fx, fy)}</feTurbulence>
      <feComponentTransfer in="n2" result="n2h"><feFuncA type="table" tableValues="0.5 0.5"/></feComponentTransfer>
      <feDisplacementMap in="d1" in2="n2h" scale="${h.fine}" xChannelSelector="R" yChannelSelector="A" result="d2"/>
      <feComponentTransfer in="n2" result="n2v"><feFuncA type="table" tableValues="0.5 0.5"/></feComponentTransfer>
      <feDisplacementMap in="d2" in2="n2v" scale="${h.vpx * 2}" xChannelSelector="A" yChannelSelector="G"/>
    </filter>`;
  }
  const hazeBlurValues = (amp, base) => HAZE_BLUR.map(k => rnd(base + amp * k, 4)).join(';');

  // o: { id, central, scale, f (focus), haze, motion, fixed }
  //   motion: { px, py, dur, kt, rot?: 'values', scale: 'values' } — about the staff's foot
  //   fixed:  a transform for the whole staff (reduced motion, or a manual lean)
  function scope(o) {
    const id = o.id, ds = o.scale * MAG, b = blurs(o.f);
    const sb = b.s.toFixed(2), rb = b.r.toFixed(2);
    const hz = o.haze;
    const blurAnim = hz && !hz.still
      ? `<animate id="ks-${id}-sba" attributeName="stdDeviation" values="${hazeBlurValues(hz.h.blur * BLUR_K, b.s)}" dur="12s" repeatCount="indefinite" calcMode="linear" keyTimes="${HAZE_PH.map(p => p.toFixed(2)).join(';')}"/>`
      : '';
    let staff = face(o.central, ds);
    const m = o.motion;
    if (m) {
      const at = (type, values) => `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${m.dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="${m.kt}"/>`;
      staff = m.translate
        ? `<g>${at('translate', m.translate)}${staff}</g>`
        : `<g transform="translate(${n2(m.px)} ${n2(m.py)})"><g>${m.rot ? at('rotate', m.rot) : ''}<g>${at('scale', m.scale)}<g transform="translate(${n2(-m.px)} ${n2(-m.py)})">${staff}</g></g></g></g>`;
    }
    const tid = `ks-${id}-t`;
    return `<svg class="ks-scope" viewBox="0 0 720 720" role="img" aria-labelledby="${tid}">
      <title id="${tid}">The staff seen through the level's eyepiece: read it where the fixed central hair crosses it${o.stadia ? ', and where the short upper and lower stadia hairs cross it' : ''}.</title>
      <defs>
        <filter id="ks-${id}-sb" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur id="ks-${id}-sbf" stdDeviation="${sb}">${blurAnim}</feGaussianBlur></filter>
        <filter id="ks-${id}-rb" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur id="ks-${id}-rbf" stdDeviation="${rb}"/></filter>
        ${hz ? hazeFilter(`ks-${id}-hz`, hz.h, hz.d, !hz.still) : ''}
        <clipPath id="ks-${id}-clip"><circle cx="360" cy="360" r="318"/></clipPath>
      </defs>
      <circle class="ks-rim" cx="360" cy="360" r="338"/>
      <circle class="ks-field" cx="360" cy="360" r="319"/>
      <g clip-path="url(#ks-${id}-clip)">
        <g filter="url(#ks-${id}-sb)"><g id="ks-${id}-pose"${o.fixed ? ` transform="${o.fixed}"` : ''}${hz ? ` filter="url(#ks-${id}-hz)"` : ''}>${staff}</g></g>
        <g class="ks-hair" filter="url(#ks-${id}-rb)">
          <line x1="54" y1="360" x2="666" y2="360" stroke-width="1" vector-effect="non-scaling-stroke"/>
          <line x1="360" y1="54" x2="360" y2="666" stroke-width="1" vector-effect="non-scaling-stroke"/>
          <line x1="255" y1="${C - STADIA_PX}" x2="465" y2="${C - STADIA_PX}" stroke-width="0.75" vector-effect="non-scaling-stroke"/>
          <line x1="255" y1="${C + STADIA_PX}" x2="465" y2="${C + STADIA_PX}" stroke-width="0.75" vector-effect="non-scaling-stroke"/>
        </g>
      </g>
      <circle class="ks-ring" cx="360" cy="360" r="328"/>
    </svg>`;
  }

  // ── The drills ─────────────────────────────────────────────────────────────
  const FIELDS4 = ['central', 'upper', 'lower', 'distance'];
  const LABEL4 = { central: 'Central reading', upper: 'Upper stadia reading', lower: 'Lower stadia reading', distance: 'Distance' };
  const WORD4 = { central: 'central reading', upper: 'upper stadia reading', lower: 'lower stadia reading', distance: 'distance' };
  const S = {};
  let P = null;                                // the two-peg drill
  let pending = null;

  const still = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
  function st(key) {
    if (!S[key]) { const f = focusFor(0); S[key] = { step: 0, streak: 0, solved: false, f, lean: 0 }; }
    return S[key];
  }

  function scenario(key, step) {
    if (key === 'central') { const c = caseFor(step); return { central: c, scale: STATIC_SCALE, answer: c, tol: TOL }; }
    if (key === 'stadia') return { ...stadia(caseFor(step), STATIC_SCALE), scale: STATIC_SCALE };
    if (key === 'distance') {
      const i = step % DIST_CASES.length, s = DIST_CASES[i][1];
      return { ...stadia(mm(CASES[i]), s), scale: s, i };
    }
    if (key === 'haze') return haze(step);
    if (key === 'wind') {
      const i = step % WIND_EXT.length, ref = WIND_READ[i];
      return { i, ext: WIND_EXT[i], central: ref, scale: 1 / 3, answer: ref, range: windRange(i) };
    }
    const i = step % ROCK_READ.length;          // rock
    return { i, central: ROCK_READ[i], scale: STATIC_SCALE, answer: ROCK_READ[i], tol: TOL };
  }

  function drillScope(key) {
    const s = st(key), sc = scenario(key, s.step), calm = still();
    const o = { id: key, central: sc.central, scale: sc.scale, f: s.f, stadia: key === 'stadia' || key === 'distance' };
    if (key === 'haze') {
      o.haze = { h: sc.h, d: sc.d, still: calm };
      if (calm) o.fixed = `translate(${sc.still[0]} ${sc.still[1]})`;
      else o.motion = { dur: 12, kt: HAZE_PH.map(p => p.toFixed(2)).join(';'), translate: sc.frames.map(f => `${f[0]} ${f[1]}`).join(';') };
    } else if (key === 'wind') {
      const px = C, py = windPivot(sc.central);
      if (calm) o.fixed = `matrix(${windMatrix(windAt(sc.ext, WIND_STILL[sc.i], sc.central), px, py)})`;
      else {
        const at = WIND_PH.map(p => windAt(sc.ext, p, sc.central));
        o.motion = { px, py, dur: 12, kt: WIND_PH.map(p => p.toFixed(4)).join(';'),
          rot: at.map(w => w.rot.toFixed(8)).join(';'), scale: at.map(w => `1 ${w.sy.toFixed(8)}`).join(';') };
      }
    } else if (key === 'rock') {
      const py = rockPivot(sc.central);
      if (calm) o.fixed = rockFixed(sc.central, s.lean);
      else o.motion = { px: C, py, dur: 10, kt: ROCK_PH.map(p => p.toFixed(2)).join(';'), scale: ROCK_COS.map(v => `1 ${v.toFixed(8)}`).join(';') };
    }
    return scope(o);
  }
  function rockFixed(r, lean) {
    const d = Math.cos(rad(lean)), py = rockPivot(r);
    return `matrix(1 0 0 ${d.toFixed(8)} 0 ${(py - d * py).toFixed(8)})`;
  }

  const INTRO = {
    central: 'Enter the reading to the nearest millimetre.',
    stadia: 'Enter the three staff readings to the nearest millimetre and the calculated distance in metres.',
    distance: 'Enter the three staff readings to the nearest millimetre and the calculated distance in metres.',
    haze: 'Read the central hair where it crosses the staff, then check your answer.',
    wind: 'Read the central hair while the staff moves. Enter the lowest stable reading.',
    rock: 'Watch the staff pass through upright, then enter the lowest reading.',
  };

  function situation(key, sc) {
    if (key === 'distance') return `Staff position ${sc.i + 1} of ${DIST_CASES.length} — each new example moves the staff further away.`;
    if (key === 'haze') return `Sight length ${sc.d} m, warm afternoon air.`;
    if (key === 'wind') return `${WIND_BAND[sc.i]}: ${sc.ext.toFixed(1)} m of staff extended, moderate gusts.`;
    if (key === 'rock') return `Example ${sc.i + 1} of ${ROCK_READ.length}: the staff is rocked towards and away from the level.`;
    return '';
  }

  function field(id, label, placeholder, fb) {
    return `<div class="ks-field"><label for="${id}">${label}</label>
      <span class="ks-unit"><input id="${id}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-describedby="${fb}"><span aria-hidden="true">m</span></span></div>`;
  }

  function focusHtml(key, f) {
    return `<fieldset class="ks-focus"><legend>Focus</legend>
      <label for="ks-${key}-sf"><span>Staff</span><input type="range" id="ks-${key}-sf" min="0" max="100" step="1" value="${Math.round(f.sf)}" oninput="KbStaff.focus('${key}')"></label>
      <label for="ks-${key}-rf"><span>Crosshairs</span><input type="range" id="ks-${key}-rf" min="0" max="100" step="1" value="${Math.round(f.rf)}" oninput="KbStaff.focus('${key}')"></label>
    </fieldset>`;
  }

  function progressHtml(streak) {
    const k = Math.min(streak, MASTERY);
    return `<span class="ks-pips" aria-hidden="true">${[0, 1, 2].map(i => `<span class="ks-pip${i < k ? ' is-on' : ''}"></span>`).join('')}</span>
      <strong>${k} / ${MASTERY}</strong> correct examples${k >= MASTERY ? ' — module complete' : ''}`;
  }

  function drillInner(key) {
    const s = st(key), sc = scenario(key, s.step), fb = `ks-${key}-fb`;
    const four = key === 'stadia' || key === 'distance';
    const lean = key === 'rock' && still()
      ? `<fieldset class="ks-focus"><legend>Lean the staff</legend>
          <label for="ks-rock-lean"><span>Lean from vertical</span><input type="range" id="ks-rock-lean" min="-5" max="5" step="0.5" value="${s.lean}"
            aria-valuetext="${s.lean.toFixed(1)} degrees from vertical" oninput="KbStaff.lean()"></label>
          <p class="small">Try either direction and come back to 0°. The lowest reading is at upright.</p></fieldset>`
      : '';
    const fields = four
      ? `<div class="ks-fields">${FIELDS4.map(f => field(`ks-${key}-${f}`, LABEL4[f], f === 'distance' ? '0.00' : '0.000', fb)).join('')}</div>`
      : field(`ks-${key}-in`, key === 'rock' ? 'Lowest reading' : 'Reading', '0.000', fb);
    const sit = situation(key, sc);
    return `<div class="ks-view">${drillScope(key)}</div>
      <div class="ks-ctrl">
        ${sit ? `<p class="ks-sit">${sit}</p>` : ''}
        ${focusHtml(key, s.f)}
        ${lean}
        <form class="ks-form" novalidate onsubmit="KbStaff.check(event, '${key}')">
          ${fields}
          <div class="button-row"><button type="submit" class="primary" id="ks-${key}-go">${four ? 'Check readings' : 'Check reading'}</button>
            <button type="button" onclick="KbStaff.next('${key}')">New example</button></div>
        </form>
        <p class="ks-fb" id="${fb}" role="status" aria-live="polite">${INTRO[key]}</p>
        <p class="ks-progress" id="ks-${key}-pr">${progressHtml(s.streak)}</p>
      </div>`;
  }
  const drill = key => `<div class="ks-drill" id="ks-d-${key}">${drillInner(key)}</div>`;

  function say(key, tone, msg) {
    const el = $(`ks-${key}-fb`);
    if (!el) return;
    el.textContent = msg;
    el.className = `ks-fb ks-fb--${tone}`;
  }
  function lock(key) {
    const box = $(`ks-d-${key}`);
    if (!box) return;
    box.querySelectorAll('.ks-form input').forEach(i => { i.disabled = true; });
    const go = $(`ks-${key}-go`);
    if (go) go.disabled = true;
  }
  function scored(key, ok) {
    const s = st(key);
    if (ok) s.streak += 1;
    const pr = $(`ks-${key}-pr`);
    if (pr) pr.innerHTML = progressHtml(s.streak);
    if (ok && s.streak >= MASTERY) markDone(key);
    return s.streak >= MASTERY;
  }

  function joinWords(list) {
    if (list.length <= 1) return list[0] || 'the reading';
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  }

  function check(ev, key) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const s = st(key);
    if (s.solved) return;
    const sc = scenario(key, s.step);
    if (key === 'stadia' || key === 'distance') return checkFour(key, s, sc);
    const input = $(`ks-${key}-in`);
    const v = parse(input ? input.value : '');
    if (v == null) {
      say(key, 'bad', key === 'rock' ? 'Enter a reading in metres to three decimal places.' : 'Enter a reading in metres, for example 1.426.');
      if (input) input.focus();
      return;
    }
    const ok = key === 'wind' ? v >= sc.range.min && v <= sc.range.max : near(v, sc.answer, sc.tol);
    if (!ok) {
      scored(key, false);
      const msg = key === 'wind' ? 'Not quite. Watch for the lowest reading as the staff passes through upright, then retry.'
        : key === 'rock' ? 'Not quite. Watch both directions and use the lowest reading at upright, then retry.'
          : `Not quite. Your reading is ${v > sc.answer ? 'high' : 'low'}. Check the millimetres and retry.`;
      say(key, 'bad', msg);
      if (input) input.select();
      return;
    }
    s.solved = true;
    const done = scored(key, true);
    const what = key === 'central' ? `The reading is ${f3(sc.answer)} m.`
      : key === 'haze' ? `The central reading is ${f3(sc.answer)} m (accepted within ±${(sc.tol * 1000).toFixed(0)} mm at ${sc.d} m).`
        : key === 'wind' ? `The plumb reading is ${f3(sc.answer)} m; anything from ${f3(sc.range.min)} to ${f3(sc.range.max)} m was on the staff.`
          : `The minimum reading is ${f3(sc.answer)} m.`;
    say(key, done ? 'done' : 'ok', `${done ? 'Three examples complete. Nicely read.' : 'Correct.'} ${what}`);
    lock(key);
  }

  function checkFour(key, s, sc) {
    const ans = {};
    FIELDS4.forEach(f => { const el = $(`ks-${key}-${f}`); ans[f] = el ? el.value : ''; });
    const miss = [], wrong = [], val = {};
    for (const f of FIELDS4) {
      const raw = ans[f];
      if (String(raw).trim() === '') { miss.push(f); continue; }
      const v = parse(raw);
      if (v == null) { wrong.push(f); continue; }
      val[f] = v;
      // The distance is marked against the learner's own hair readings, so a
      // slip in one is not counted twice.
      const up = parse(ans.upper), lo = parse(ans.lower);
      const want = f === 'distance' && up != null && lo != null ? cm((mm(up) - mm(lo)) * K) : sc[f];
      if ((f === 'distance' && v < 0) || !near(v, want, f === 'distance' ? DIST_TOL : TOL)) wrong.push(f);
    }
    const bad = FIELDS4.filter(f => miss.includes(f) || wrong.includes(f));
    FIELDS4.forEach(f => { const el = $(`ks-${key}-${f}`); if (el) el.setAttribute('aria-invalid', bad.includes(f) ? 'true' : 'false'); });
    if (bad.length) {
      scored(key, false);
      const parts = [];
      if (miss.length) parts.push(`Enter the ${joinWords(miss.map(f => WORD4[f]))}.`);
      const rev = bad.filter(f => !miss.includes(f));
      if (rev.length) parts.push(`Check the ${joinWords(rev.map(f => WORD4[f]))}.`);
      say(key, 'bad', parts.join(' '));
      const first = $(`ks-${key}-${bad[0]}`);
      if (first) first.focus();
      return;
    }
    s.solved = true;
    const done = scored(key, true);
    const vals = `Central: ${f3(val.central)} m. Upper stadia: ${f3(val.upper)} m. Lower stadia: ${f3(val.lower)} m. Distance: ${val.distance.toFixed(2)} m.`;
    say(key, done ? 'done' : 'ok', `${done ? 'Three examples complete.' : 'Correct.'} ${vals}`);
    lock(key);
  }

  function next(key) {
    const s = st(key);
    s.step += 1;
    s.f = nextFocus(s.f, s.step);
    if (s.streak >= MASTERY) s.streak = 0;
    s.solved = false;
    s.lean = 0;
    const box = $(`ks-d-${key}`);
    if (!box) return;
    box.innerHTML = drillInner(key);
    const first = box.querySelector('.ks-form input');
    if (first) first.focus();
  }

  function paintBlur(key, f) {
    const b = blurs(f);
    const sf = $(`ks-${key}-sbf`), rf = $(`ks-${key}-rbf`), an = $(`ks-${key}-sba`);
    if (sf) sf.setAttribute('stdDeviation', b.s.toFixed(2));
    if (rf) rf.setAttribute('stdDeviation', b.r.toFixed(2));
    if (an && key === 'haze') an.setAttribute('values', hazeBlurValues(scenario('haze', st('haze').step).h.blur * BLUR_K, b.s));
  }
  function focus(key) {
    const f = key === 'peg' ? P.f : st(key).f;
    const sv = $(`ks-${key}-sf`), rv = $(`ks-${key}-rf`);
    if (sv) f.sf = Number(sv.value);
    if (rv) f.rf = Number(rv.value);
    paintBlur(key, f);
  }

  function lean() {
    const s = st('rock'), el = $('ks-rock-lean'), pose = $('ks-rock-pose');
    if (!el) return;
    s.lean = Number(el.value) || 0;
    el.setAttribute('aria-valuetext', `${s.lean.toFixed(1)} degrees from vertical`);
    if (pose) pose.setAttribute('transform', rockFixed(scenario('rock', s.step).central, s.lean));
  }

  // ── Module 7's drill: one complete two-peg test ────────────────────────────
  function pegFresh(prev) {
    const fstep = prev ? prev.fstep + 1 : 0;
    return {
      stage: 'mid-place', pos: PEG.min, placed: false, c: null, midPos: null, nearPos: null,
      staff: 'A', viewed: new Set(['A']), mid: null, near: null, result: null, drag: false,
      fstep, f: prev ? nextFocus(prev.f, fstep) : focusFor(0),
    };
  }
  const placing = () => P.stage === 'mid-place' || P.stage === 'near-place';
  function pegObsNow() {
    if (!P.c) return null;
    if (P.stage === 'mid-read' || P.stage === 'moved') return pegObs(P.c, P.midPos, 1);
    if (P.stage === 'near-read' || P.stage === 'done') return pegObs(P.c, P.nearPos, 2);
    return null;
  }
  function pegScope() {
    const o = pegObsNow();
    if (!o) return '';
    return scope({ id: 'peg', central: P.staff === 'A' ? o.a : o.b, scale: P.staff === 'A' ? o.sA : o.sB, f: P.f });
  }
  const pegTitle = where => `Side view of the two-peg line: Staff A at 0 m, Staff B at ${PEG.base} m. ${where}`;
  function pegInstAttr() { return `translate(${n2(pegX(P.pos))} 0)`; }

  function pegSvg() {
    const ax = pegX(0), bx = pegX(PEG.base);
    const staffMark = x => `<line class="ks-peg-staff" x1="${n2(x)}" y1="58" x2="${n2(x)}" y2="${PEG_GY}"/>
      ${[78, 90, 102, 114, 126, 138].map(y => `<line class="ks-peg-tick" x1="${n2(x - 8)}" y1="${y}" x2="${n2(x + 8)}" y2="${y}"/>`).join('')}
      <polygon class="ks-peg-foot" points="${n2(x - 9)},${PEG_GY} ${n2(x + 9)},${PEG_GY} ${n2(x)},${PEG_GY + 17}"/>`;
    const where = P.placed ? `The level is ${P.pos.toFixed(1)} m from Staff A.` : 'The level has not been placed yet.';
    return `<svg class="ks-peg-svg" id="ks-peg-svg" viewBox="0 0 1000 250" role="img" aria-labelledby="ks-peg-svg-t"
        onpointerdown="KbStaff.pegDown(event)" onpointermove="KbStaff.pegDrag(event)" onpointerup="KbStaff.pegUp(event)" onpointercancel="KbStaff.pegUp(event)">
      <title id="ks-peg-svg-t">${pegTitle(where)}</title>
      <rect x="52" y="46" width="896" height="150" fill="transparent"/>
      ${staffMark(ax)}${staffMark(bx)}
      <text class="ks-peg-lab" x="${n2(ax)}" y="38" text-anchor="middle">Staff A</text>
      <text class="ks-peg-lab" x="${n2(bx)}" y="38" text-anchor="middle">Staff B</text>
      <line class="ks-peg-ground" x1="52" y1="${PEG_GY}" x2="948" y2="${PEG_GY}"/>
      <g id="ks-peg-inst" transform="${pegInstAttr()}" visibility="${P.placed ? 'visible' : 'hidden'}">
        <line class="ks-peg-leg" x1="0" y1="98" x2="-24" y2="${PEG_GY}"/><line class="ks-peg-leg" x1="0" y1="98" x2="24" y2="${PEG_GY}"/>
        <line class="ks-peg-leg" x1="0" y1="98" x2="0" y2="${PEG_GY}"/>
        <rect class="ks-peg-inst" x="-30" y="80" width="60" height="16" rx="4"/><rect class="ks-peg-inst" x="-38" y="83" width="9" height="10" rx="2"/>
        <text class="ks-peg-pos" id="ks-peg-pos" x="0" y="${PEG_GY + 44}" text-anchor="middle">${P.pos.toFixed(1)} m</text>
      </g>
      ${placing() && !P.placed ? `<text class="ks-peg-prompt" x="${n2((ax + bx) / 2)}" y="112" text-anchor="middle">Tap the line or use the slider to place the level</text>` : ''}
    </svg>`;
  }

  function stagesHtml() {
    const num = { 'mid-place': 1, 'mid-read': 2, moved: 3, 'near-place': 3, 'near-read': 4, done: 5 }[P.stage];
    return `<ol class="ks-stages" aria-label="The four stages of the test">${['Midpoint placement', 'Midpoint readings', 'Move the level', 'Near readings']
      .map((t, i) => `<li class="${num > i + 1 ? 'is-done' : ''}"${num === i + 1 ? ' aria-current="step"' : ''}>${i + 1}. ${t}${num > i + 1 ? ' ✓' : ''}</li>`).join('')}</ol>`;
  }

  function evidenceHtml(title, o, result) {
    return `<div class="ks-evidence"><h5>${title}</h5><dl class="ks-dl">
      <dt>Staff A reading</dt><dd>${f3(o.a)} m</dd><dt>Staff B reading</dt><dd>${f3(o.b)} m</dd>
      <dt>Absolute staff difference</dt><dd>${f3(Math.abs(o.diff))} m</dd>
      ${result != null ? `<dt>Difference between results</dt><dd>${f3(result)} m</dd>` : ''}</dl>
      <p class="small">Sight lengths: A ${o.dA.toFixed(1)} m, B ${o.dB.toFixed(1)} m.</p></div>`;
  }

  function pegInner() {
    const fb = 'ks-peg-fb';
    const reading = P.stage === 'mid-read' || P.stage === 'near-read';
    const pre = P.stage === 'mid-read' ? 'Midpoint' : 'Near set-up';
    const ids = { a: 'ks-peg-a', b: 'ks-peg-b', d: 'ks-peg-d', r: 'ks-peg-r' };
    const labels = { a: `${pre} Staff A reading`, b: `${pre} Staff B reading`, d: `${pre} absolute difference (A and B)`, r: 'Absolute difference between results' };
    const keys = P.stage === 'near-read' ? ['a', 'b', 'd', 'r'] : ['a', 'b', 'd'];
    const place = placing()
      ? `<div class="ks-peg-place">
          <label for="ks-peg-range">Level position, metres from Staff A <output id="ks-peg-out" for="ks-peg-range">${P.placed ? `${P.pos.toFixed(1)} m` : 'not placed'}</output></label>
          <input type="range" id="ks-peg-range" min="${PEG.min}" max="${PEG.max}" step="${PEG.step}" value="${P.pos}" oninput="KbStaff.pegSlide()">
          <div class="button-row"><button type="button" class="primary" id="ks-peg-start" onclick="KbStaff.pegStart()"${P.placed ? '' : ' disabled'}>Start</button></div>
        </div>` : '';
    const view = reading || P.stage === 'moved' || P.stage === 'done'
      ? `<div class="ks-drill">
          <div class="ks-view" id="ks-peg-view">${pegScope()}</div>
          <div class="ks-ctrl">
            ${P.c ? `<div class="button-row ks-seg" role="group" aria-label="Which staff to look at">${['A', 'B'].map(x =>
              `<button type="button" id="ks-peg-v${x}" aria-pressed="${P.staff === x}" onclick="KbStaff.pegView('${x}')">Staff ${x}</button>`).join('')}</div>
              ${reading ? `<p class="small" id="ks-peg-seen">${pegSeenText()}</p>` : ''}` : ''}
            ${focusHtml('peg', P.f)}
            ${reading ? `<form class="ks-form" novalidate onsubmit="KbStaff.pegCheck(event)">
              <div class="ks-fields">${keys.map(k => field(ids[k], labels[k], '0.000', fb)).join('')}</div>
              <p class="small">${P.stage === 'mid-read' ? 'Enter readings to the nearest millimetre. Subtract the smaller staff reading from the larger.'
                : 'Enter the readings, the absolute staff difference and the absolute difference between the two set-ups\' differences.'}</p>
              <div class="button-row"><button type="submit" class="primary">${P.stage === 'mid-read' ? 'Check midpoint readings' : 'Check near readings'}</button></div>
            </form>` : ''}
          </div>
        </div>` : '';
    return `${stagesHtml()}
      ${pegSvg()}
      ${place}
      ${P.mid ? evidenceHtml('Midpoint readings', P.mid) : ''}
      ${P.stage === 'moved' ? '<div class="button-row"><button type="button" class="primary" onclick="KbStaff.pegRelocate()">Move the level</button></div>' : ''}
      ${view}
      ${P.near ? evidenceHtml('Near readings and the comparison', P.near, P.result) : ''}
      <p class="ks-fb${P.fb ? ` ks-fb--${P.fb[0]}` : ''}" id="${fb}" role="status" aria-live="polite">${P.fb ? esc(P.fb[1]) : 'Place the level halfway between the staffs, then press Start.'}</p>
      <div class="button-row"><button type="button" onclick="KbStaff.pegNew()">New example</button></div>`;
  }
  const pegSeenText = () => `Staff ${P.staff} in view. Staff A ${P.viewed.has('A') ? 'seen' : 'not yet seen'}, Staff B ${P.viewed.has('B') ? 'seen' : 'not yet seen'}.`;

  function pegPaint(fb) {
    if (fb !== undefined) P.fb = fb;
    const box = $('ks-peg');
    if (box) box.innerHTML = pegInner();
  }
  function pegSay(tone, msg) {
    P.fb = [tone, msg];
    const el = $('ks-peg-fb');
    if (!el) return;
    el.textContent = msg;
    el.className = `ks-fb ks-fb--${tone}`;
  }

  function pegSet(m) {
    if (!placing()) return;
    P.pos = pegSnap(m);
    P.placed = true;
    const inst = $('ks-peg-inst'), out = $('ks-peg-out'), r = $('ks-peg-range'), go = $('ks-peg-start');
    const pos = $('ks-peg-pos'), title = $('ks-peg-svg-t');
    const prompt = document.querySelector('#ks-peg-svg .ks-peg-prompt');
    if (inst) { inst.setAttribute('transform', pegInstAttr()); inst.setAttribute('visibility', 'visible'); }
    if (pos) pos.textContent = `${P.pos.toFixed(1)} m`;
    if (title) title.textContent = pegTitle(`The level is ${P.pos.toFixed(1)} m from Staff A.`);
    if (out) out.textContent = `${P.pos.toFixed(1)} m`;
    if (r && Number(r.value) !== P.pos) r.value = String(P.pos);
    if (go) go.disabled = false;
    if (prompt) prompt.remove();
  }
  function pegSlide() { const r = $('ks-peg-range'); if (r) pegSet(Number(r.value)); }
  function pegPoint(ev) {
    const svg = ev.currentTarget;
    const m = svg && svg.getScreenCTM && svg.getScreenCTM();
    if (!m) return;
    let x;
    try { x = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()).x; } catch (e) {
      const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; x = p.matrixTransform(m.inverse()).x;
    }
    pegSet(pegM(x));
  }
  function pegDown(ev) {
    if (!P || !placing()) return;
    ev.preventDefault();
    P.drag = true;
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) { /* capture is a nicety */ }
    pegPoint(ev);
  }
  function pegDrag(ev) { if (P && P.drag && placing()) pegPoint(ev); }
  function pegUp(ev) {
    if (!P) return;
    P.drag = false;
    try { if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
  }

  function pegStart() {
    if (!P.placed) return;
    if (P.stage === 'mid-place') {
      if (!midOk(P.pos)) {
        pegSay('bad', 'Place the level halfway between Staff A and Staff B. Keep both sight lengths equal. A small tilt in the level\'s line of sight then affects both readings equally, so it cancels in the absolute staff difference.');
        return;
      }
      P.c = PEG_CASES[Math.min(PEG_CASES.length - 1, Math.floor(Math.random() * PEG_CASES.length))];
      P.midPos = P.pos;
      P.stage = 'mid-read';
    } else {
      if (!nearOk(P.pos)) {
        pegSay('bad', 'Place the level 4 to 6 m from Staff A, on either side. That gives one short sight and one long one. A tilt in the line of sight then affects the readings differently, so comparing with the midpoint result shows the error.');
        return;
      }
      P.nearPos = P.pos;
      P.stage = 'near-read';
    }
    P.staff = 'A';
    P.viewed = new Set(['A']);
    pegPaint(null);
  }
  function pegRelocate() {
    P.stage = 'near-place';
    P.placed = false;
    pegPaint(null);
  }
  function pegView(x) {
    P.staff = x;
    P.viewed.add(x);
    const v = $('ks-peg-view'), seen = $('ks-peg-seen');
    if (v) v.innerHTML = pegScope();
    ['A', 'B'].forEach(k => { const b = $(`ks-peg-v${k}`); if (b) b.setAttribute('aria-pressed', String(k === x)); });
    if (seen) seen.textContent = pegSeenText();
  }

  function pegCheck(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const midStage = P.stage === 'mid-read';
    if (P.viewed.size < 2) { pegSay('bad', `View Staff B before checking the ${midStage ? 'midpoint' : 'near set-up'} answers.`); return; }
    const o = midStage ? pegObs(P.c, P.midPos, 1) : pegObs(P.c, P.nearPos, 2);
    const keys = midStage ? ['a', 'b', 'd'] : ['a', 'b', 'd', 'r'];
    const raw = {};
    keys.forEach(k => { const el = $(`ks-peg-${k}`); raw[k] = el ? el.value : ''; });
    const midDiff = midStage ? null : Math.abs(P.mid.diff);
    const want = { a: o.a, b: o.b, d: Math.abs(o.diff), r: midStage ? 0 : mm(Math.abs(Math.abs(P.mid.diff) - Math.abs(o.diff))) };
    const miss = [], wrong = [], val = {};
    for (const k of keys) {
      if (String(raw[k]).trim() === '') { miss.push(k); continue; }
      const v = parse(raw[k]);
      if (v == null) { wrong.push(k); continue; }
      val[k] = v;
      const a = parse(raw.a), b = parse(raw.b), d = parse(raw.d);
      let target = want[k];
      if (k === 'd' && a != null && b != null) target = mm(Math.abs(mm(a) - mm(b)));
      if (k === 'r' && midDiff != null && d != null) target = mm(Math.abs(midDiff - d));
      if (((k === 'd' || k === 'r') && v < 0) || !near(v, target)) wrong.push(k);
    }
    const bad = keys.filter(k => miss.includes(k) || wrong.includes(k));
    keys.forEach(k => { const el = $(`ks-peg-${k}`); if (el) el.setAttribute('aria-invalid', bad.includes(k) ? 'true' : 'false'); });
    if (bad.length) {
      const parts = [];
      if (miss.length) parts.push(`Enter ${joinWords(miss.map(k => PEG_LABEL[k]))}.`);
      const rev = bad.filter(k => !miss.includes(k));
      if (rev.length) parts.push(`Check ${joinWords(rev.map(k => PEG_LABEL[k]))}.`);
      pegSay('bad', parts.join(' '));
      const first = $(`ks-peg-${bad[0]}`);
      if (first) first.focus();
      return;
    }
    if (midStage) {
      P.mid = { ...o, a: val.a, b: val.b, diff: val.d };
      P.stage = 'moved';
      pegPaint(['ok', 'Midpoint readings complete. Now move the level.']);
      return;
    }
    P.near = { ...o, a: val.a, b: val.b, diff: val.d };
    P.result = val.r;
    P.stage = 'done';
    markDone('peg');
    pegPaint(['done', 'Correct. One complete two-peg test is finished.']);
  }
  function pegNew() { P = pegFresh(P); pegPaint(); }

  // ── Which modules are done (this browser only) ─────────────────────────────
  function doneSet() {
    try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch (e) { return new Set(); }
  }
  function markDone(key) {
    const d = doneSet();
    d.add(key);
    try { localStorage.setItem(STORE, JSON.stringify([...d])); } catch (e) { /* progress is a nicety */ }
    const t = $(`ks-t-${key}`);
    if (t) t.textContent = ' ✓ done';
  }

  // ── The lessons ────────────────────────────────────────────────────────────
  function modules() {
    const ex = stadia(1.586, STATIC_SCALE);
    const hz = HAZE_D.map((d, i) => haze(i));
    const wr = WIND_EXT.map((e, i) => windRange(i));
    const pegTol = typeof Levelling !== 'undefined' && Levelling.TOL ? Levelling.TOL.pegtest : null;
    const w1 = pegObs(PEG_CASES[0], 25, 1), w2 = pegObs(PEG_CASES[0], 5, 2);
    const wRes = mm(Math.abs(Math.abs(w1.diff) - Math.abs(w2.diff)));
    return [
      ['central', 'Central-hair staff readings', `
        <p>Read the staff where the fixed central hair crosses it. Everything else in this tab builds on doing that quickly and to the millimetre.</p>
        <h4>How the staff face is laid out</h4>
        <ul>
          <li>Each decimetre of the face is one <strong>E</strong>: a stem with three arms, then two square blocks under it. Arms, blocks and the
            gaps between them are all <strong>1 cm</strong> tall, so the face changes between colour and white every centimetre.</li>
          <li>The E faces left and right in turn from one decimetre to the next, which helps you keep your place.</li>
          <li>The number beside the blocks names that decimetre in tenths of a metre: <strong>08</strong> is 0.8 m, <strong>14</strong> is 1.4 m,
            <strong>34</strong> is 3.4 m. The colour changes with each whole metre — black for 0.x and 2.x m, red for 1.x and 3.x m.</li>
        </ul>
        <h4>Reading it</h4>
        <ol>
          <li>Focus the crosshairs first, then the staff. On a level that is the eyepiece and then the focusing knob; here they are the two
            sliders. The crosshairs stay as you set them from one example to the next — the staff needs focusing every time.</li>
          <li>Find the decimetre the hair is in and read its number: metres and decimetres.</li>
          <li>Count the whole centimetres from that decimetre's bottom line up to the hair.</li>
          <li>Judge the millimetres inside the centimetre the hair cuts, and book it to three decimals.</li>
        </ol>
        <p class="ks-eq">red 13 · 7 whole cm above 1.300 · about 4 mm into the next → 1.374 m</p>
        <p>The drill marks you right within <strong>±${TOL * 1000} mm</strong>; a wrong answer tells you whether you were high or low, and you can try again.
          Three correct examples completes the module.</p>`],
      ['stadia', 'Stadia-hair staff readings', `
        <p>Above and below the central hair are two short hairs, the <strong>stadia hairs</strong>. Read the central, upper and lower hairs together,
          each to the millimetre, exactly as you would the central one.</p>
        <p>The gap between the stadia readings grows with the distance to the staff, so it gives you the sight length:</p>
        <p class="ks-eq">distance = (upper stadia − lower stadia) × ${K}</p>
        <p>For example, a central reading of ${f3(ex.central)} with the upper hair on ${f3(ex.upper)} and the lower on ${f3(ex.lower)} gives
          (${f3(ex.upper)} − ${f3(ex.lower)}) × ${K} = <strong>${ex.distance.toFixed(2)} m</strong>. The central reading should sit about midway
          between the two — a quick check on a slip.</p>
        <p>Book the distance to two decimals. It is marked against <em>your own</em> upper and lower readings, within ±${DIST_TOL} m, so a slip in
          one hair is not counted twice; each hair reading is marked within ±${TOL * 1000} mm.</p>`],
      ['distance', 'Variable-distance staff readings', `
        <p>The same three readings, at several sight lengths. Each new example puts the staff further away, over six positions, then starts again.</p>
        <ul>
          <li>Up close the staff fills the view: centimetres are big and easy, and the stadia hairs cut it only a short way apart.</li>
          <li>Further off the staff looks smaller, the hairs span more of it, and the millimetres get harder to judge — one reason survey practice
            keeps sights short.</li>
          <li>Work out the distance from your hair readings each time, and watch it grow as the staff moves away.</li>
        </ul>
        <p>Marking is the same as module 2: ±${TOL * 1000} mm on each hair, ±${DIST_TOL} m on the distance worked from your own readings.</p>`],
      ['haze', 'Heat haze', `
        <p>Over warm ground the air near the surface shimmers, and the whole staff seems to shift together — sideways and a little up and down —
          while the crosshairs stay put. The further the sight, the worse it gets.</p>
        <ul>
          <li>The drill cycles through three sight lengths: ${HAZE_D.join(', ')} m.</li>
          <li>Watch a few cycles, then read where the hair sits on the staff when it is at rest in the middle of the movement.</li>
          <li>You are marked right anywhere inside what the haze can carry the hair to: within
            ${hz.map(h => `±${(h.tol * 1000).toFixed(0)} mm at ${h.d} m`).join(', ')}.</li>
        </ul>
        <p>That widening allowance is the lesson: on a long, low sight over hot ground you lose millimetres you can't get back. Shorten the
          sight and keep the line of sight up off the hot ground (see <button type="button" class="link-btn" onclick="switchTab('surveyguide')">How to Survey</button>).</p>`],
      ['wind', 'Wind and staff stability', `
        <p>The staff's foot stays where it is, but a gust leans the staff — sideways and towards or away from the level — and the more of it is
          extended, the more it moves. The drill holds the gusts at one moderate strength and raises the staff over three examples:</p>
        <div class="table-wrap" role="region" aria-label="The wind examples" tabindex="0"><table>
          <caption>The three wind examples and the readings accepted</caption>
          <thead><tr><th scope="col">Example</th><th scope="col">Staff extended</th><th scope="col">Plumb reading</th><th scope="col">Accepted</th></tr></thead>
          <tbody>${WIND_EXT.map((e, i) => `<tr><td>${WIND_BAND[i]}</td><td>${e.toFixed(1)} m</td><td>${f3(WIND_READ[i])} m</td><td>${f3(wr[i].min)}–${f3(wr[i].max)} m</td></tr>`).join('')}</tbody>
        </table></div>
        <p>Any lean makes the hair cut the staff higher, never lower. So book the <strong>lowest stable reading</strong> — the one you see as the
          staff passes through upright. Anything the moving staff actually shows is accepted, but aim for the lowest: that is the true one.</p>`],
      ['rock', 'Staff rocking', `
        <p>The staff holder can find upright for you: rock the staff slowly towards the level and away from it, through vertical, while the
          reader watches. Leaning either way makes the reading rise — the staff's height in the line of sight shrinks by the cosine of the lean —
          so the <strong>lowest reading</strong> is the plumb one. Book that.</p>
        <p>The error grows with the reading. At ${f3(ROCK_READ[2])} m, a 4.5° lean reads ${f3(rockRead(ROCK_READ[2], 4.5))} m — about
          ${Math.round((rockRead(ROCK_READ[2], 4.5) - ROCK_READ[2]) * 1000)} mm high; at ${f3(ROCK_READ[0])} m the same lean costs about
          ${Math.round((rockRead(ROCK_READ[0], 4.5) - ROCK_READ[0]) * 1000)} mm.</p>
        <p><strong>Keep a stable point contact.</strong> A thick flat foot can lift on a flat surface when it is rocked, corrupting the low reading.</p>
        <p>The drill rocks the staff up to 4.5° either way over three examples (${ROCK_READ.map(f3).join(', ')} m), marked within ±${TOL * 1000} mm.
          If your device is set to reduce motion, the staff holds still and a slider leans it instead.</p>`],
      ['peg', 'Two-peg test', `
        <p>Place the level for one complete two-peg test, read both staffs from each set-up, and compare. It shows whether the level's line of
          sight is truly horizontal.</p>
        <ol>
          <li><strong>Midpoint.</strong> With the staffs ${PEG.base} m apart, set up halfway — within ${PEG.midMax - 25} m of the 25 m mark. Read
            Staff A and Staff B and take the smaller from the larger. Both sights are the same length, so a small tilt in the line of sight
            affects both readings equally and cancels in the difference.</li>
          <li><strong>Near one staff.</strong> Move the level to 4–6 m from Staff A, on either side of it. Now one sight is short and one is long, so
            a tilt affects the two readings differently.</li>
          <li><strong>Compare.</strong> Read both staffs again, take the difference, and find the difference between the two results. If the level
            were perfect, both set-ups would give the same difference whatever the height of the instrument.</li>
        </ol>
        <p>In the drill the level's line of sight is out by 2 mm over ${PEG.base} m. With the first example's staffs, the midpoint gives
          ${f3(w1.a)} − ${f3(w1.b)} = ${f3(Math.abs(w1.diff))} m and a set-up 5 m from A gives ${f3(w2.a)} − ${f3(w2.b)} = ${f3(Math.abs(w2.diff))} m:
          the results differ by <strong>${f3(wRes)} m</strong>. The instrument heights differ between set-ups; the difference doesn't care.</p>
        ${typeof TwoPeg !== 'undefined' && TwoPeg.diagram ? `<div class="ks-figs">
          <figure>${TwoPeg.diagram(1, w1.a, w1.b, 0)}<figcaption class="small">From the middle: equal sights, the tilt cancels.</figcaption></figure>
          <figure>${TwoPeg.diagram(2, w2.a, w2.b, PEG.perM)}<figcaption class="small">From near A: unequal sights, the tilt shows (drawn far bigger than life).</figcaption></figure></div>` : ''}
        <p>Every reading and difference is marked within ±${TOL * 1000} mm.${pegTol != null ? ` For a real level, Flood-Net's Two-Peg Test starts
          with a limit of ${f3(pegTol)} m on that difference between results.` : ''}</p>
        <p><button type="button" onclick="switchTab('twopeg')">🎯 Open the Two-Peg Test</button></p>`],
    ];
  }

  function render() {
    if (!P) P = pegFresh(null);
    const list = modules(), done = doneSet();
    const open = pending || 'central';
    return `<div class="page ks-page" style="--page-max:960px"><h2 class="sr-only">Staff Simulator</h2><div class="stack">
      <section class="panel ks-intro">
        <h3>📏 Reading a levelling staff</h3>
        <p>Seven short modules on reading a metric E-pattern staff through a level: the central hair, the stadia hairs and the distance they give,
          the same readings at different distances, then heat haze, wind and rocking the staff, and finally one complete two-peg test. Each has a
          drill — focus the view, read the staff, type the reading in metres.</p>
        <nav aria-label="Staff Simulator modules"><ol class="ks-toc">${list.map(([key, title]) =>
          `<li><button type="button" class="link-btn" onclick="KbStaff.show('${key}')">${esc(title)}</button><span class="ks-done" id="ks-t-${key}">${done.has(key) ? ' ✓ done' : ''}</span></li>`).join('')}</ol></nav>
        <p class="small">Modules 1–6 are complete after three correct examples; module 7 after one complete test. Completed modules are remembered in this browser only.</p>
        <div class="button-row"><button type="button" onclick="switchTab('levels')">📏 Level Survey</button>
          <button type="button" onclick="switchTab('twopeg')">🎯 Two-Peg Test</button>
          <button type="button" onclick="switchTab('surveyguide')">📖 How to Survey</button></div>
      </section>
      ${list.map(([key, title, html], i) => `<details class="panel ks-module" id="ks-m-${key}"${key === open ? ' open' : ''}>
        <summary><h3>Module ${i + 1} — ${esc(title)}</h3></summary>
        <div class="ks-body">${html}
          <h4>Practice</h4>
          ${key === 'peg' ? `<div class="ks-peg" id="ks-peg">${pegInner()}</div>` : drill(key)}
        </div></details>`).join('')}
      ${KnowledgeBase.credit('staff')}
    </div></div>`;
  }

  // Open a module — from the list above, or from another tab.
  function show(key) {
    pending = key;
    if (typeof state !== 'undefined' && state.activeTab === TAB) { reveal(); return; }
    switchTab(TAB);
  }
  function reveal() {
    const key = pending;
    pending = null;
    if (!key) return;
    const el = $(`ks-m-${key}`);
    if (!el) return;
    el.open = true;
    const s = el.querySelector('summary');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    if (s) s.focus({ preventScroll: true });
  }
  function init() { reveal(); }

  return {
    render, init, show, check, next, focus, lean,
    pegSlide, pegDown, pegDrag, pegUp, pegStart, pegRelocate, pegView, pegCheck, pegNew,
  };
})();

if (typeof window !== 'undefined') window.KbStaff = KbStaff;
