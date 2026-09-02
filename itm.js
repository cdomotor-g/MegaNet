// MegaNet — itm.js
//
//   ITM   the ITS Irregular Terrain Model (Longley–Rice), point-to-point mode,
//         in the browser. The propagation model Radio Mobile runs, ported
//         function-for-function from NTIA's reference C++ (v1.3, which NTIA
//         states is functionally identical to Hufford's FORTRAN v1.2.2 of
//         September 1984 — the same code Radio Mobile wraps).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches into nothing: this file is pure arithmetic over a terrain profile,
// and that is deliberate. test/itm.mjs loads it into a bare Node VM and holds
// it against reference losses computed by the NTIA library itself, so anything
// it borrowed from the app would have to be mocked there — and a propagation
// model that cannot be checked against its reference is a number, not a model.
//
// ── What it computes ─────────────────────────────────────────────────────────
// Basic transmission loss A (dB) between two antennas over a terrain profile:
//
//   A = A_fs + A_ref − V_med − Y_R − Y_S        (Hufford, "The Algorithm", §5)
//
//   A_fs     free-space loss over the great-circle distance
//   A_ref    the *reference attenuation* — excess loss over free space in the
//            median situation, from one of three regimes the path falls in:
//              line of sight     two-ray ground reflection blended with an
//                                extrapolated diffraction line
//              diffraction       knife-edge over the two horizons weighted with
//                                Vogler's smooth-earth diffraction, plus a
//                                clutter term A_fo from the terrain roughness
//              troposcatter      past the diffraction/scatter crossover
//   V_med    the climate's adjustment of the long-term median
//   Y_R, Y_S the variability allowances — time (which climate), location
//            (terrain roughness Δh) and situation ("everything else") — for the
//            percentages asked for: %time / %locations / %situations in Radio
//            Mobile's words, which are exactly this model's words too.
//
// The terrain enters through five numbers QuickPfl reads off the profile: the
// two radio-horizon distances and angles as seen from each antenna over the
// effective earth, the two effective antenna heights above the ground the
// path actually reflects off, and Δh — the interdecile range of the terrain
// about a straight-line fit, the model's whole notion of "irregularity".
//
// Units and conventions are the reference's: metres, MHz, radians, dB. The
// profile is the PFL array — pfl[0] = number of intervals, pfl[1] = the
// spacing in metres, pfl[2..] = the heights — because that is the contract the
// reference vectors are stated in. Variable names follow the C++ (pseudo-LaTeX,
// double underscore before a unit) so a line here can be found there.
//
// Radio Mobile calls this same model with the same inputs: its network
// properties dialog is climate, refractivity, permittivity, conductivity,
// polarization, mode of variability and the three percentages, and those are
// this function's parameters one for one.

const ITM = (function () {
  const PI = Math.PI;
  const SQRT2 = Math.SQRT2;
  const THIRD = 1 / 3;
  const a_0__meter = 6370e3;
  const a_9000__meter = 9000e3;

  const MODE__P2P = 0;

  const MAX = (x, y) => (x > y ? x : y);
  const MIN = (x, y) => (x < y ? x : y);
  const DIM = (x, y) => (x > y ? x - y : 0);
  // C's fdim(): the positive difference, never negative.
  const fdim = (x, y) => (x > y ? x - y : 0);
  const log10 = Math.log10;

  // ── complex arithmetic, just enough for the ground impedance ──
  const cx = (re, im) => ({ re, im });
  const cabs = z => Math.hypot(z.re, z.im);
  const cadd = (a, b) => cx(a.re + b.re, a.im + b.im);
  const csub = (a, b) => cx(a.re - b.re, a.im - b.im);
  const cmul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const cscale = (a, s) => cx(a.re * s, a.im * s);
  function cdiv(a, b) {
    const d = b.re * b.re + b.im * b.im;
    return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
  }
  // Principal square root, as std::sqrt(complex) gives it.
  function csqrt(z) {
    const r = cabs(z);
    const re = Math.sqrt((r + z.re) / 2);
    const im = Math.sqrt((r - z.re) / 2);
    return cx(re, z.im < 0 ? -im : im);
  }

  // ── enumerations ──
  const CLIMATE = {
    1: 'Equatorial',
    2: 'Continental subtropical',
    3: 'Maritime subtropical',
    4: 'Desert',
    5: 'Continental temperate',
    6: 'Maritime temperate over land',
    7: 'Maritime temperate over sea',
  };
  const MDVAR = { 0: 'Spot (single message)', 1: 'Accidental', 2: 'Mobile', 3: 'Broadcast' };
  const PROP_MODE = { 0: 'not set', 1: 'Line of sight', 2: 'Diffraction', 3: 'Troposcatter' };

  // The reference's warning flags, kept as the same bits so a value can be
  // compared with the C++ side, and named so the card can say them in words.
  const WARN = [
    [0x0001, 'TX antenna height is near the model’s limits'],
    [0x0002, 'RX antenna height is near the model’s limits'],
    [0x0004, 'frequency is near the model’s limits'],
    [0x0008, 'path is near the model’s upper distance limit'],
    [0x0010, 'path is very long — care with the result'],
    [0x0020, 'path is shorter than the antenna-height difference warrants'],
    [0x0040, 'path is under 1 km — the model is not meant for it'],
    [0x0080, 'TX horizon angle is large — small-angle approximations strained'],
    [0x0100, 'RX horizon angle is large — small-angle approximations strained'],
    [0x0200, 'TX horizon is under a tenth of the smooth-earth horizon'],
    [0x0400, 'RX horizon is under a tenth of the smooth-earth horizon'],
    [0x0800, 'TX horizon is over three times the smooth-earth horizon'],
    [0x1000, 'RX horizon is over three times the smooth-earth horizon'],
    [0x2000, 'a percentage asked for is far in the tail of its distribution'],
    [0x4000, 'surface refractivity is low — care with the result'],
  ];
  const ERRORS = {
    1000: 'TX antenna height out of range (0.5–3000 m)',
    1001: 'RX antenna height out of range (0.5–3000 m)',
    1002: 'invalid radio climate',
    1003: '%time must be between 0 and 100 exclusive',
    1004: '%locations must be between 0 and 100 exclusive',
    1005: '%situations must be between 0 and 100 exclusive',
    1008: 'refractivity out of range (250–400 N-units)',
    1009: 'frequency out of range (20–20000 MHz)',
    1010: 'invalid polarization',
    1011: 'permittivity must be at least 1',
    1012: 'conductivity must be positive',
    1013: 'ground impedance: imaginary part exceeds the real part',
    1014: 'invalid mode of variability',
    1016: 'effective earth radius out of range',
    1021: 'surface refractivity too small',
    1022: 'surface refractivity too large',
  };

  // ── ValidateInputs ──
  function validateInputs(h_tx, h_rx, climate, time, location, situation, N_0, f, pol, epsilon, sigma, mdvar, w) {
    if (h_tx < 1 || h_tx > 1000) w.v |= 0x0001;
    if (h_tx < 0.5 || h_tx > 3000) return 1000;
    if (h_rx < 1 || h_rx > 1000) w.v |= 0x0002;
    if (h_rx < 0.5 || h_rx > 3000) return 1001;
    if (!(climate >= 1 && climate <= 7 && climate === Math.floor(climate))) return 1002;
    if (N_0 < 250 || N_0 > 400) return 1008;
    if (f < 40 || f > 10000) w.v |= 0x0004;
    if (f < 20 || f > 20000) return 1009;
    if (pol !== 0 && pol !== 1) return 1010;
    if (epsilon < 1) return 1011;
    if (sigma <= 0) return 1012;
    if (mdvar < 0 || (mdvar > 3 && mdvar < 10) || (mdvar > 13 && mdvar < 20) || (mdvar > 23 && mdvar < 30) || mdvar > 33) return 1014;
    if (situation <= 0 || situation >= 100) return 1005;
    if (time <= 0 || time >= 100) return 1003;
    if (location <= 0 || location >= 100) return 1004;
    return 0;
  }

  // ── InitializePointToPoint ──
  function initializePointToPoint(f__mhz, h_sys__meter, N_0, pol, epsilon, sigma) {
    const gamma_a = 157e-9;
    const N_s = h_sys__meter === 0 ? N_0 : N_0 * Math.exp(-h_sys__meter / 9460);   // [TN101, Eq 4.3]
    const gamma_e = gamma_a * (1 - 0.04665 * Math.exp(N_s / 179.3));                 // [TN101, Eq 4.4]
    const ep_r = cx(epsilon, 18000 * sigma / f__mhz);
    let Z_g = csqrt(csub(ep_r, cx(1, 0)));
    if (pol === 1) Z_g = cdiv(Z_g, ep_r);
    return { Z_g, gamma_e, N_s };
  }

  // ── FindHorizons ──
  function findHorizons(pfl, a_e__meter, h__meter, theta_hzn, d_hzn__meter) {
    const np = Math.trunc(pfl[0]);
    const xi = pfl[1];
    const d__meter = pfl[0] * pfl[1];
    const z_tx = pfl[2] + h__meter[0];
    const z_rx = pfl[np + 2] + h__meter[1];
    theta_hzn[0] = (z_rx - z_tx) / d__meter - d__meter / (2 * a_e__meter);
    theta_hzn[1] = -(z_rx - z_tx) / d__meter - d__meter / (2 * a_e__meter);
    d_hzn__meter[0] = d__meter;
    d_hzn__meter[1] = d__meter;
    let d_tx = 0, d_rx = d__meter;
    for (let i = 1; i < np; i++) {
      d_tx += xi;
      d_rx -= xi;
      const theta_tx = (pfl[i + 2] - z_tx) / d_tx - d_tx / (2 * a_e__meter);
      const theta_rx = -(z_rx - pfl[i + 2]) / d_rx - d_rx / (2 * a_e__meter);
      if (theta_tx > theta_hzn[0]) { theta_hzn[0] = theta_tx; d_hzn__meter[0] = d_tx; }
      if (theta_rx > theta_hzn[1]) { theta_hzn[1] = theta_rx; d_hzn__meter[1] = d_rx; }
    }
  }

  // ── LinearLeastSquaresFit ──
  function linearLeastSquaresFit(pfl, d_start, d_end) {
    const np = Math.trunc(pfl[0]);
    let i_start = Math.trunc(fdim(d_start / pfl[1], 0));
    let i_end = np - Math.trunc(fdim(np, d_end / pfl[1]));
    if (i_end <= i_start) {
      i_start = Math.trunc(fdim(i_start, 1));
      i_end = np - Math.trunc(fdim(np, i_end + 1));
    }
    const x_length = i_end - i_start;
    let mid_shifted_index = -0.5 * x_length;
    const mid_shifted_end = i_end + mid_shifted_index;
    let sum_y = 0.5 * (pfl[i_start + 2] + pfl[i_end + 2]);
    let scaled_sum_y = 0.5 * (pfl[i_start + 2] - pfl[i_end + 2]) * mid_shifted_index;
    for (let i = 2; i <= x_length; i++) {
      i_start++;
      mid_shifted_index++;
      sum_y += pfl[i_start + 2];
      scaled_sum_y += pfl[i_start + 2] * mid_shifted_index;
    }
    sum_y /= x_length;
    scaled_sum_y = scaled_sum_y * 12 / ((x_length * x_length + 2) * x_length);
    return [sum_y - scaled_sum_y * mid_shifted_end, sum_y + scaled_sum_y * (np - mid_shifted_end)];
  }

  // ── ComputeDeltaH ──
  function computeDeltaH(pfl, d_start__meter, d_end__meter) {
    const np = Math.trunc(pfl[0]);
    let x_start = d_start__meter / pfl[1];
    let x_end = d_end__meter / pfl[1];
    if (x_end - x_start < 2) return 0;
    let p10 = Math.trunc(0.1 * (x_end - x_start + 8));
    p10 = MIN(MAX(4, p10), 25);
    const n = 10 * p10 - 5;
    const p90 = n - p10;
    const np_s = n - 1;
    const s = new Array(n + 2).fill(0);
    s[0] = np_s;
    s[1] = 1;
    x_end = (x_end - x_start) / np_s;
    let i = Math.trunc(x_start);
    // The reference does this subtraction in single precision — `float(i + 1.0)`
    // — and so do we, or Δh drifts from it in the last places.
    x_start -= Math.fround(i + 1);
    for (let j = 0; j < n; j++) {
      while (x_start > 0 && (i + 1) < np) { x_start--; i++; }
      s[j + 2] = pfl[i + 3] + (pfl[i + 3] - pfl[i + 2]) * x_start;
      x_start += x_end;
    }
    let [fit_y1, fit_y2] = linearLeastSquaresFit(s, 0, np_s);
    fit_y2 = (fit_y2 - fit_y1) / np_s;
    const diffs = [];
    for (let j = 0; j < n; j++) {
      diffs.push(s[j + 2] - fit_y1);
      fit_y1 += fit_y2;
    }
    // nth_element with std::greater — the (k+1)-th largest, which a full
    // descending sort gives identically.
    diffs.sort((a, b) => b - a);
    const q10 = diffs[p10 - 1];
    const q90 = diffs[p90];
    const delta_h_d__meter = q10 - q90;
    return delta_h_d__meter / (1 - 0.8 * Math.exp(-(d_end__meter - d_start__meter) / 50e3));   // [ERL 79-ITS 67, Eqn 3] inverted
  }

  // ── QuickPfl ──
  function quickPfl(pfl, gamma_e, h__meter) {
    const theta_hzn = [0, 0], d_hzn__meter = [0, 0], h_e__meter = [0, 0];
    const d__meter = pfl[0] * pfl[1];
    const np = Math.trunc(pfl[0]);
    const a_e__meter = 1 / gamma_e;
    findHorizons(pfl, a_e__meter, h__meter, theta_hzn, d_hzn__meter);
    // "consideration of terrain elevations should begin at a point about 15
    // times the tower height" — [Hufford, 1982] p.25
    const d_start__meter = MIN(15 * h__meter[0], 0.1 * d_hzn__meter[0]);
    const d_end__meter = d__meter - MIN(15 * h__meter[1], 0.1 * d_hzn__meter[1]);
    const delta_h__meter = computeDeltaH(pfl, d_start__meter, d_end__meter);
    let q;
    if (d_hzn__meter[0] + d_hzn__meter[1] > 1.5 * d__meter) {
      // Well within line of sight: effective heights over a straight-line fit
      // of the whole profile, horizons re-derived from them.
      const [fit_tx, fit_rx] = linearLeastSquaresFit(pfl, d_start__meter, d_end__meter);
      h_e__meter[0] = h__meter[0] + fdim(pfl[2], fit_tx);
      h_e__meter[1] = h__meter[1] + fdim(pfl[np + 2], fit_rx);
      for (let i = 0; i < 2; i++) {
        d_hzn__meter[i] = Math.sqrt(2 * h_e__meter[i] * a_e__meter) * Math.exp(-0.07 * Math.sqrt(delta_h__meter / MAX(h_e__meter[i], 5)));
      }
      const combined = d_hzn__meter[0] + d_hzn__meter[1];
      if (combined <= d__meter) {
        q = Math.pow(d__meter / combined, 2);
        for (let i = 0; i < 2; i++) {
          h_e__meter[i] *= q;
          d_hzn__meter[i] = Math.sqrt(2 * h_e__meter[i] * a_e__meter) * Math.exp(-0.07 * Math.sqrt(delta_h__meter / MAX(h_e__meter[i], 5)));
        }
      }
      for (let i = 0; i < 2; i++) {
        q = Math.sqrt(2 * h_e__meter[i] * a_e__meter);
        theta_hzn[i] = (0.65 * delta_h__meter * (q / d_hzn__meter[i] - 1) - 2 * h_e__meter[i]) / q;
      }
    } else {
      const [fit_tx] = linearLeastSquaresFit(pfl, d_start__meter, 0.9 * d_hzn__meter[0]);
      h_e__meter[0] = h__meter[0] + fdim(pfl[2], fit_tx);
      const [, fit_rx] = linearLeastSquaresFit(pfl, d__meter - 0.9 * d_hzn__meter[1], d_end__meter);
      h_e__meter[1] = h__meter[1] + fdim(pfl[np + 2], fit_rx);
    }
    return { theta_hzn, d_hzn__meter, h_e__meter, delta_h__meter, d__meter };
  }

  // ── the pieces of the reference attenuation ──

  const terrainRoughness = (d__meter, delta_h__meter) => delta_h__meter * (1 - 0.8 * Math.exp(-d__meter / 50e3));
  const sigmaHFunction = delta_h__meter => 0.78 * delta_h__meter * Math.exp(-0.5 * Math.pow(delta_h__meter, 0.25));

  // Approximation to the ideal knife edge, in v²
  function fresnelIntegral(v2) {
    return v2 < 5.76 ? 6.02 + 9.11 * Math.sqrt(v2) - 1.27 * v2 : 12.953 + 10 * log10(v2);
  }

  function knifeEdgeDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter) {
    const d_ML = d_hzn__meter[0] + d_hzn__meter[1];
    const theta_nlos = d__meter / a_e__meter - theta_los;
    const d_nlos = d__meter - d_ML;
    const v_1 = 0.0795775 * (f__mhz / 47.7) * Math.pow(theta_nlos, 2) * d_hzn__meter[0] * d_nlos / (d_nlos + d_hzn__meter[0]);
    const v_2 = 0.0795775 * (f__mhz / 47.7) * Math.pow(theta_nlos, 2) * d_hzn__meter[1] * d_nlos / (d_nlos + d_hzn__meter[1]);
    return fresnelIntegral(v_1) + fresnelIntegral(v_2);
  }

  function heightFunction(x__km, K) {
    let w, result;
    if (x__km < 200) {
      w = -Math.log(K);
      if (K < 1e-5 || x__km * Math.pow(w, 3) > 5495) {
        result = -117;
        if (x__km > 1) result = 17.372 * Math.log(x__km) + result;
      } else {
        result = 2.5e-5 * Math.pow(x__km, 2) / K - 8.686 * w - 15;
      }
    } else {
      result = 0.05751 * x__km - 4.343 * Math.log(x__km);
      if (x__km < 2000) {
        w = 0.0134 * x__km * Math.exp(-0.005 * x__km);
        result = (1 - w) * result + w * (17.372 * Math.log(x__km) - 117);
      }
    }
    return result;
  }

  // Vogler's three-radii smooth-earth diffraction
  function smoothEarthDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter, h_e__meter, Z_g) {
    const theta_nlos = d__meter / a_e__meter - theta_los;
    const d_ML = d_hzn__meter[0] + d_hzn__meter[1];
    const a = [
      (d__meter - d_ML) / (d__meter / a_e__meter - theta_los),
      0.5 * Math.pow(d_hzn__meter[0], 2) / h_e__meter[0],
      0.5 * Math.pow(d_hzn__meter[1], 2) / h_e__meter[1],
    ];
    const d__km = [a[0] * theta_nlos / 1000, d_hzn__meter[0] / 1000, d_hzn__meter[1] / 1000];
    const C_0 = [], K = [], B_0 = [], x__km = [];
    const zg = cabs(Z_g);
    for (let i = 0; i < 3; i++) {
      C_0[i] = Math.pow((4 / 3) * a_0__meter / a[i], THIRD);
      K[i] = 0.017778 * C_0[i] * Math.pow(f__mhz, -THIRD) / zg;
      B_0[i] = 1.607 - K[i];
    }
    x__km[1] = B_0[1] * Math.pow(C_0[1], 2) * Math.pow(f__mhz, THIRD) * d__km[1];
    x__km[2] = B_0[2] * Math.pow(C_0[2], 2) * Math.pow(f__mhz, THIRD) * d__km[2];
    x__km[0] = B_0[0] * Math.pow(C_0[0], 2) * Math.pow(f__mhz, THIRD) * d__km[0] + x__km[1] + x__km[2];
    const F1 = heightFunction(x__km[1], K[1]);
    const F2 = heightFunction(x__km[2], K[2]);
    const G_x__db = 0.05751 * x__km[0] - 10 * log10(x__km[0]);
    return G_x__db - F1 - F2 - 20;
  }

  function diffractionLoss(d__meter, d_hzn__meter, h_e__meter, Z_g, a_e__meter, delta_h__meter, h__meter, mode, theta_los, d_sML__meter, f__mhz) {
    const A_k__db = knifeEdgeDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter);
    const A_se__db = smoothEarthDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter, h_e__meter, Z_g);
    // Terrain clutter: the roughness at the smooth-earth horizon distance
    const delta_h_dsML = terrainRoughness(d_sML__meter, delta_h__meter);
    const sigma_h_d = sigmaHFunction(delta_h_dsML);
    const A_fo__db = MIN(15, 5 * log10(1 + 1e-5 * h__meter[0] * h__meter[1] * f__mhz * sigma_h_d));   // [ERL 79-ITS 67, Eqn 3.38c]
    const delta_h_d = terrainRoughness(d__meter, delta_h__meter);
    let q = h__meter[0] * h__meter[1];
    const qk = h_e__meter[0] * h_e__meter[1] - q;
    if (mode === MODE__P2P) q += 10;
    const term1 = Math.sqrt(1 + qk / q);
    const d_ML = d_hzn__meter[0] + d_hzn__meter[1];
    q = (term1 + (-theta_los * a_e__meter + d_ML) / d__meter) * MIN(delta_h_d * f__mhz / 47.7, 6283.2);
    const w = 25.1 / (25.1 + Math.sqrt(q));
    return w * A_se__db + (1 - w) * A_k__db + A_fo__db;
  }

  function lineOfSightLoss(d__meter, h_e__meter, Z_g, delta_h__meter, M_d, A_d0, d_sML__meter, f__mhz) {
    const delta_h_d = terrainRoughness(d__meter, delta_h__meter);
    const sigma_h_d = sigmaHFunction(delta_h_d);
    const wn = f__mhz / 47.7;
    const hs = h_e__meter[0] + h_e__meter[1];
    const sin_psi = hs / Math.sqrt(Math.pow(d__meter, 2) + Math.pow(hs, 2));           // [Algorithm, 4.46]
    const sp = cx(sin_psi, 0);
    let R_e = cscale(cdiv(csub(sp, Z_g), cadd(sp, Z_g)), Math.exp(-MIN(10, wn * sigma_h_d * sin_psi)));   // [4.47]
    const q = R_e.re * R_e.re + R_e.im * R_e.im;
    if (q < 0.25 || q < sin_psi) R_e = cscale(R_e, Math.sqrt(sin_psi / q));                              // [4.48]
    let delta_phi = wn * 2 * h_e__meter[0] * h_e__meter[1] / d__meter;                                  // [4.49]
    if (delta_phi > PI / 2) delta_phi = PI - Math.pow(PI / 2, 2) / delta_phi;                           // [4.50]
    const rr = cadd(cx(Math.cos(delta_phi), -Math.sin(delta_phi)), R_e);
    const A_t__db = -10 * log10(rr.re * rr.re + rr.im * rr.im);
    const A_d__db = M_d * d__meter + A_d0;
    const w = 1 / (1 + f__mhz * delta_h__meter / MAX(10e3, d_sML__meter));
    return w * A_t__db + (1 - w) * A_d__db;
  }

  function fFunction(td) {
    const a = [133.4, 104.6, 71.8];
    const b = [0.332e-3, 0.212e-3, 0.157e-3];
    const c = [-10, -2.5, 5];
    const i = td <= 10e3 ? 0 : td <= 70e3 ? 1 : 2;
    return a[i] + b[i] * td + c[i] * log10(td);
  }

  function h0Curve(j, r) {
    const a = [25, 80, 177, 395, 705];
    const b = [24, 45, 68, 80, 105];
    return 10 * log10(1 + a[j] * Math.pow(1 / r, 4) + b[j] * Math.pow(1 / r, 2));
  }

  function h0Function(r, eta_s) {
    eta_s = MIN(MAX(eta_s, 1), 5);
    const i = Math.trunc(eta_s);
    const q = eta_s - i;
    let result = h0Curve(i - 1, r);
    if (q !== 0) result = (1 - q) * result + q * h0Curve(i, r);
    return result;
  }

  // Returns [loss, h0] — h0 is carried between the two calls the caller makes.
  function troposcatterLoss(d__meter, theta_hzn, d_hzn__meter, h_e__meter, a_e__meter, N_s, f__mhz, theta_los, h0) {
    let H_0;
    const wn = f__mhz / 47.7;
    if (h0 > 15) {
      H_0 = h0;
    } else {
      let ad = d_hzn__meter[0] - d_hzn__meter[1];
      let rr = h_e__meter[1] / h_e__meter[0];
      if (ad < 0) { ad = -ad; rr = 1 / rr; }
      const theta = theta_hzn[0] + theta_hzn[1] + d__meter / a_e__meter;
      const r_1 = 2 * wn * theta * h_e__meter[0];
      const r_2 = 2 * wn * theta * h_e__meter[1];
      if (r_1 < 0.2 && r_2 < 0.2) return [1001, h0];
      let s = (d__meter - ad) / (d__meter + ad);
      const q = MIN(MAX(0.1, rr / s), 10);
      s = MAX(0.1, s);
      const h_0__meter = (d__meter - ad) * (d__meter + ad) * theta * 0.25 / d__meter;
      const Z_0__meter = 1.7556e3, Z_1__meter = 8.0e3;
      const eta_s = (h_0__meter / Z_0__meter) * (1 + (0.031 - N_s * 2.32e-3 + Math.pow(N_s, 2) * 5.67e-6) * Math.exp(-Math.pow(MIN(1.7, h_0__meter / Z_1__meter), 6)));
      const H_00 = (h0Function(r_1, eta_s) + h0Function(r_2, eta_s)) / 2;
      const Delta_H_0 = MIN(H_00, 6 * (0.6 - log10(MAX(eta_s, 1))) * log10(s) * log10(q));
      H_0 = H_00 + Delta_H_0;
      H_0 = MAX(H_0, 0);
      if (eta_s < 1) {
        H_0 = eta_s * H_0 + (1 - eta_s) * 10 * log10(Math.pow((1 + SQRT2 / r_1) * (1 + SQRT2 / r_2), 2) * (r_1 + r_2) / (r_1 + r_2 + 2 * SQRT2));
      }
      if (H_0 > 15 && h0 >= 0) H_0 = h0;
    }
    const th = d__meter / a_e__meter - theta_los;
    const D_0__meter = 40e3, H__meter = 47.7;
    const loss = fFunction(th * d__meter) + 10 * log10(wn * H__meter * Math.pow(th, 4)) - 0.1 * (N_s - 301) * Math.exp(-th * d__meter / D_0__meter) + H_0;
    return [loss, H_0];
  }

  // ── LongleyRice: the reference attenuation ──
  function longleyRice(theta_hzn, f__mhz, Z_g, d_hzn__meter, h_e__meter, gamma_e, N_s, delta_h__meter, h__meter, d__meter, mode, w) {
    const a_e__meter = 1 / gamma_e;
    const d_hzn_s = [Math.sqrt(2 * h_e__meter[0] * a_e__meter), Math.sqrt(2 * h_e__meter[1] * a_e__meter)];
    const d_sML = d_hzn_s[0] + d_hzn_s[1];
    const d_ML = d_hzn__meter[0] + d_hzn__meter[1];
    const theta_los = -MAX(theta_hzn[0] + theta_hzn[1], -d_ML / a_e__meter);

    if (Math.abs(theta_hzn[0]) > 200e-3) w.v |= 0x0080;
    if (Math.abs(theta_hzn[1]) > 200e-3) w.v |= 0x0100;
    if (d_hzn__meter[0] < 0.1 * d_hzn_s[0]) w.v |= 0x0200;
    if (d_hzn__meter[1] < 0.1 * d_hzn_s[1]) w.v |= 0x0400;
    if (d_hzn__meter[0] > 3 * d_hzn_s[0]) w.v |= 0x0800;
    if (d_hzn__meter[1] > 3 * d_hzn_s[1]) w.v |= 0x1000;
    if (N_s < 150) return { error: 1021 };
    if (N_s > 400) return { error: 1022 };
    if (N_s < 250) w.v |= 0x4000;
    if (a_e__meter < 4000000 || a_e__meter > 13333333) return { error: 1016 };
    if (Z_g.re <= Math.abs(Z_g.im)) return { error: 1013 };

    // Two distances far in the diffraction region, and the line through them
    const d_3 = MAX(d_sML, d_ML + 5 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, THIRD));
    const d_4 = d_3 + 10 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, THIRD);
    const A_3 = diffractionLoss(d_3, d_hzn__meter, h_e__meter, Z_g, a_e__meter, delta_h__meter, h__meter, mode, theta_los, d_sML, f__mhz);
    const A_4 = diffractionLoss(d_4, d_hzn__meter, h_e__meter, Z_g, a_e__meter, delta_h__meter, h__meter, mode, theta_los, d_sML, f__mhz);
    const M_d = (A_4 - A_3) / (d_4 - d_3);
    const A_d0 = A_3 - M_d * d_3;

    const d_min = Math.abs(h_e__meter[0] - h_e__meter[1]) / 200e-3;
    if (d__meter < d_min) w.v |= 0x0020;
    if (d__meter < 1e3) w.v |= 0x0040;
    if (d__meter > 1000e3) w.v |= 0x0008;
    if (d__meter > 2000e3) w.v |= 0x0010;

    let A_ref, propmode;
    let detail = {};
    if (d__meter < d_sML) {
      const A_sML = d_sML * M_d + A_d0;
      let d_0 = 0.04 * f__mhz * h_e__meter[0] * h_e__meter[1];                       // [ERL 79-ITS 67, 3.16a]
      let d_1;
      if (A_d0 >= 0) {
        d_0 = MIN(d_0, 0.5 * d_ML);
        d_1 = d_0 + 0.25 * (d_ML - d_0);                                              // [3.16d]
      } else {
        d_1 = MAX(-A_d0 / M_d, 0.25 * d_ML);
      }
      const A_1 = lineOfSightLoss(d_1, h_e__meter, Z_g, delta_h__meter, M_d, A_d0, d_sML, f__mhz);
      let flag = false;
      let k1 = 0, k2 = 0;
      if (d_0 < d_1) {
        const A_0 = lineOfSightLoss(d_0, h_e__meter, Z_g, delta_h__meter, M_d, A_d0, d_sML, f__mhz);
        const q = Math.log(d_sML / d_0);
        k2 = MAX(0, ((d_sML - d_0) * (A_1 - A_0) - (d_1 - d_0) * (A_sML - A_0)) / ((d_sML - d_0) * Math.log(d_1 / d_0) - (d_1 - d_0) * q));   // [3.20]
        flag = A_d0 > 0 || k2 > 0;
        if (flag) {
          k1 = (A_sML - A_0 - k2 * q) / (d_sML - d_0);                                 // [3.21]
          if (k1 < 0) {
            k1 = 0;
            k2 = DIM(A_sML, A_0) / q;
            if (k2 === 0) k1 = M_d;
          }
        }
      }
      if (!flag) {
        k1 = DIM(A_sML, A_1) / (d_sML - d_1);
        k2 = 0;
        if (k1 === 0) k1 = M_d;
      }
      const A_o = A_sML - k1 * d_sML - k2 * Math.log(d_sML);
      A_ref = A_o + k1 * d__meter + k2 * Math.log(d__meter);                          // [3.19]
      propmode = 1;
      detail = { d_sML, d_ML, M_d, A_d0 };
    } else {
      const d_5 = d_ML + 200e3, d_6 = d_ML + 400e3;
      let h0 = -1, A_6, A_5;
      [A_6, h0] = troposcatterLoss(d_6, theta_hzn, d_hzn__meter, h_e__meter, a_e__meter, N_s, f__mhz, theta_los, h0);
      [A_5, h0] = troposcatterLoss(d_5, theta_hzn, d_hzn__meter, h_e__meter, a_e__meter, N_s, f__mhz, theta_los, h0);
      let M_s, A_s0, d_x;
      if (A_5 < 1000) {
        M_s = (A_6 - A_5) / 200e3;
        d_x = MAX(MAX(d_sML, d_ML + 1.088 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, THIRD) * Math.log(f__mhz)), (A_5 - A_d0 - M_s * d_5) / (M_d - M_s));
        A_s0 = (M_d - M_s) * d_x + A_d0;
      } else {
        M_s = M_d; A_s0 = A_d0; d_x = 10e6;
      }
      if (d__meter > d_x) { A_ref = M_s * d__meter + A_s0; propmode = 3; }
      else { A_ref = M_d * d__meter + A_d0; propmode = 2; }
      detail = { d_sML, d_ML, M_d, A_d0, d_x };
    }
    A_ref = MAX(A_ref, 0);
    return { A_ref__db: A_ref, propmode, detail };
  }

  const freeSpaceLoss = (d__meter, f__mhz) => 32.45 + 20 * log10(f__mhz) + 20 * log10(d__meter / 1000);

  // Abramowitz & Stegun 26.2.23 — |error| < 4.5e-4
  function qerfi(q) {
    const C_0 = 2.515516, C_1 = 0.802853, C_2 = 0.010328;
    const D_1 = 1.432788, D_2 = 0.189269, D_3 = 0.001308;
    let x = q;
    if (q > 0.5) x = 1 - x;
    const T_x = Math.sqrt(-2 * Math.log(x));
    const zeta_x = ((C_2 * T_x + C_1) * T_x + C_0) / (((D_3 * T_x + D_2) * T_x + D_1) * T_x + 1);
    let Q_q = T_x - zeta_x;
    if (q > 0.5) Q_q = -Q_q;
    return Q_q;
  }

  const curve = (c1, c2, x1, x2, x3, d_e) =>
    (c1 + c2 / (1 + Math.pow((d_e - x2) / x3, 2))) * Math.pow(d_e / x1, 2) / (1 + Math.pow(d_e / x1, 2));

  // ── Variability ──
  // Returns the loss relative to the reference, and the three pieces of it so
  // the card can print "median adjustment", "time/location" and "situation" as
  // rows rather than one opaque statistics figure.
  function variability(time, location, situation, h_e__meter, delta_h__meter, f__mhz, d__meter, A_ref__db, climate, mdvar, w) {
    const all_year = [
      [-9.67, -0.62, 1.26, -9.21, -0.62, -0.39, 3.15],
      [12.7, 9.19, 15.5, 9.05, 9.19, 2.86, 857.9],
      [144.9e3, 228.9e3, 262.6e3, 84.1e3, 228.9e3, 141.7e3, 2222.e3],
      [190.3e3, 205.2e3, 185.2e3, 101.1e3, 205.2e3, 315.9e3, 164.8e3],
      [133.8e3, 143.6e3, 99.8e3, 98.6e3, 143.6e3, 167.4e3, 116.3e3],
    ];
    const bsm1 = [2.13, 2.66, 6.11, 1.98, 2.68, 6.86, 8.51];
    const bsm2 = [159.5, 7.67, 6.65, 13.11, 7.16, 10.38, 169.8];
    const xsm1 = [762.2e3, 100.4e3, 138.2e3, 139.1e3, 93.7e3, 187.8e3, 609.8e3];
    const xsm2 = [123.6e3, 172.5e3, 242.2e3, 132.7e3, 186.8e3, 169.6e3, 119.9e3];
    const xsm3 = [94.5e3, 136.4e3, 178.6e3, 193.5e3, 133.5e3, 108.9e3, 106.6e3];
    const bsp1 = [2.11, 6.87, 10.08, 3.68, 4.75, 8.58, 8.43];
    const bsp2 = [102.3, 15.53, 9.60, 159.3, 8.12, 13.97, 8.19];
    const xsp1 = [636.9e3, 138.7e3, 165.3e3, 464.4e3, 93.2e3, 216.0e3, 136.2e3];
    const xsp2 = [134.8e3, 143.7e3, 225.7e3, 93.1e3, 135.9e3, 152.0e3, 188.5e3];
    const xsp3 = [95.6e3, 98.6e3, 129.7e3, 94.2e3, 113.4e3, 122.7e3, 122.9e3];
    const C_D = [1.224, 0.801, 1.380, 1.000, 1.224, 1.518, 1.518];
    const z_D = [1.282, 2.161, 1.282, 20.0, 1.282, 1.282, 1.282];
    const bfm1 = [1.0, 1.0, 1.0, 1.0, 0.92, 1.0, 1.0];
    const bfm2 = [0.0, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0];
    const bfm3 = [0.0, 0.0, 0.0, 0.0, 1.77, 0.0, 0.0];
    const bfp1 = [1.0, 0.93, 1.0, 0.93, 0.93, 1.0, 1.0];
    const bfp2 = [0.0, 0.31, 0.0, 0.19, 0.31, 0.0, 0.0];
    const bfp3 = [0.0, 2.00, 0.0, 1.79, 2.00, 0.0, 0.0];

    let z_T = qerfi(time / 100);
    let z_L = qerfi(location / 100);
    const z_S = qerfi(situation / 100);
    const c = climate - 1;
    const wn = f__mhz / 47.7;

    const d_ex = Math.sqrt(2 * a_9000__meter * h_e__meter[0]) + Math.sqrt(2 * a_9000__meter * h_e__meter[1]) + Math.pow(575.7e12 / wn, THIRD);   // [5.3]
    const d_e = d__meter < d_ex ? 130e3 * d__meter / d_ex : 130e3 + d__meter - d_ex;

    let md = mdvar;
    const plus20 = md >= 20;
    if (plus20) md -= 20;
    const sigma_S = plus20 ? 0 : 5 + 3 * Math.exp(-d_e / 100e3);                     // [5.10]
    const plus10 = md >= 10;
    if (plus10) md -= 10;

    const V_med = curve(all_year[0][c], all_year[1][c], all_year[2][c], all_year[3][c], all_year[4][c], d_e);

    if (md === 0) { z_T = z_S; z_L = z_S; }
    else if (md === 1) { z_L = z_S; }
    else if (md === 2) { z_L = z_T; }

    if (Math.abs(z_T) > 3.1 || Math.abs(z_L) > 3.1 || Math.abs(z_S) > 3.1) w.v |= 0x2000;

    let sigma_L;
    if (plus10) sigma_L = 0;
    else {
      const delta_h_d = terrainRoughness(d__meter, delta_h__meter);
      sigma_L = 10 * wn * delta_h_d / (wn * delta_h_d + 13);
    }
    const Y_L = sigma_L * z_L;

    const q = Math.log(0.133 * wn);
    const g_minus = bfm1[c] + bfm2[c] / (Math.pow(bfm3[c] * q, 2) + 1);
    const g_plus = bfp1[c] + bfp2[c] / (Math.pow(bfp3[c] * q, 2) + 1);
    const sigma_T_minus = curve(bsm1[c], bsm2[c], xsm1[c], xsm2[c], xsm3[c], d_e) * g_minus;
    const sigma_T_plus = curve(bsp1[c], bsp2[c], xsp1[c], xsp2[c], xsp3[c], d_e) * g_plus;
    const sigma_TD = C_D[c] * sigma_T_plus;
    const tgtd = (sigma_T_plus - sigma_TD) * z_D[c];
    let sigma_T;
    if (z_T < 0) sigma_T = sigma_T_minus;
    else if (z_T <= z_D[c]) sigma_T = sigma_T_plus;
    else sigma_T = sigma_TD + tgtd / z_T;
    const Y_T = sigma_T * z_T;

    const Y_S_temp = Math.pow(sigma_S, 2) + Math.pow(Y_T, 2) / (7.8 + Math.pow(z_S, 2)) + Math.pow(Y_L, 2) / (24 + Math.pow(z_S, 2));   // part of [5.11]

    let Y_R, Y_S;
    if (md === 0) { Y_R = 0; Y_S = Math.sqrt(Math.pow(sigma_T, 2) + Math.pow(sigma_L, 2) + Y_S_temp) * z_S; }
    else if (md === 1) { Y_R = Y_T; Y_S = Math.sqrt(Math.pow(sigma_L, 2) + Y_S_temp) * z_S; }
    else if (md === 2) { Y_R = Math.sqrt(Math.pow(sigma_T, 2) + Math.pow(sigma_L, 2)) * z_T; Y_S = Math.sqrt(Y_S_temp) * z_S; }
    else { Y_R = Y_T + Y_L; Y_S = Math.sqrt(Y_S_temp) * z_S; }

    let result = A_ref__db - V_med - Y_R - Y_S;
    if (result < 0) result = result * (29 - result) / (29 - 10 * result);              // [Algorithm, Eqn 52]
    return { result, V_med, Y_R, Y_S, d_e, sigma_T, sigma_L, sigma_S };
  }

  // ── the entry point ─────────────────────────────────────────────────────
  //
  // pointToPoint({
  //   pfl,                  PFL array: [n, spacing_m, h0, h1, … hn]
  //   hTx, hRx,             antenna heights above ground, m
  //   fMhz,
  //   climate,              1..7 (see CLIMATE)
  //   N0,                   surface refractivity at sea level, N-units (301)
  //   pol,                  0 horizontal, 1 vertical
  //   epsilon, sigma,       ground relative permittivity, conductivity S/m
  //   mdvar,                0..3 (+10 no location variability, +20 no situation)
  //   time, location, situation   percentages, 0 < x < 100
  // })
  //
  // → { ok:true, A_db, A_fs_db, A_ref_db, A_var_db, V_med_db, Y_R_db, Y_S_db,
  //     delta_h_m, h_e_m[2], d_hzn_m[2], theta_hzn[2], N_s, mode, modeLabel,
  //     warnings: [text…], warnBits, d_m, k }
  //   or { ok:false, error, code }
  //
  // A_var_db is the whole statistical adjustment (V_med + Y_R + Y_S, signed the
  // way it enters the loss), so that A_db = A_fs_db + A_ref_db + A_var_db up to
  // the small-loss clamp of Eqn 52 — which is applied exactly as the reference
  // applies it, and reported as `clamped` when it bit.
  function pointToPoint(p) {
    const w = { v: 0 };
    const pfl = p.pfl;
    if (!pfl || pfl.length < 4 || !(pfl[0] >= 1) || !(pfl[1] > 0)) {
      return { ok: false, error: 'a profile needs at least two points and a positive spacing', code: -1 };
    }
    const h_tx = p.hTx, h_rx = p.hRx, f = p.fMhz;
    const climate = p.climate == null ? 5 : p.climate;
    const N_0 = p.N0 == null ? 301 : p.N0;
    const pol = p.pol == null ? 1 : p.pol;
    const epsilon = p.epsilon == null ? 15 : p.epsilon;
    const sigma = p.sigma == null ? 0.005 : p.sigma;
    const mdvar = p.mdvar == null ? 0 : p.mdvar;
    const time = p.time == null ? 50 : p.time;
    const location = p.location == null ? 50 : p.location;
    const situation = p.situation == null ? 50 : p.situation;

    let rc = validateInputs(h_tx, h_rx, climate, time, location, situation, N_0, f, pol, epsilon, sigma, mdvar, w);
    if (rc !== 0) return { ok: false, error: ERRORS[rc] || `ITM error ${rc}`, code: rc };

    const np = Math.trunc(pfl[0]);
    const p10 = Math.trunc(0.1 * np);
    let h_sys = 0;
    for (let i = p10; i <= np - p10; i++) h_sys += pfl[i + 2];
    h_sys /= (np - 2 * p10 + 1);

    const { Z_g, gamma_e, N_s } = initializePointToPoint(f, h_sys, N_0, pol, epsilon, sigma);
    const h__meter = [h_tx, h_rx];
    const qp = quickPfl(pfl, gamma_e, h__meter);

    const lr = longleyRice(qp.theta_hzn, f, Z_g, qp.d_hzn__meter, qp.h_e__meter, gamma_e, N_s, qp.delta_h__meter, h__meter, qp.d__meter, MODE__P2P, w);
    if (lr.error) return { ok: false, error: ERRORS[lr.error] || `ITM error ${lr.error}`, code: lr.error };

    const A_fs = freeSpaceLoss(qp.d__meter, f);
    const v = variability(time, location, situation, qp.h_e__meter, qp.delta_h__meter, f, qp.d__meter, lr.A_ref__db, climate, mdvar, w);
    const A = v.result + A_fs;
    const unclamped = lr.A_ref__db - v.V_med - v.Y_R - v.Y_S;

    const warnings = WARN.filter(([bit]) => w.v & bit).map(([, text]) => text);
    return {
      ok: true,
      A_db: A,
      A_fs_db: A_fs,
      A_ref_db: lr.A_ref__db,
      A_var_db: v.result - lr.A_ref__db,
      V_med_db: v.V_med, Y_R_db: v.Y_R, Y_S_db: v.Y_S,
      sigma_T: v.sigma_T, sigma_L: v.sigma_L, sigma_S: v.sigma_S, d_e_m: v.d_e,
      clamped: unclamped < 0,
      delta_h_m: qp.delta_h__meter,
      h_e_m: qp.h_e__meter.slice(),
      d_hzn_m: qp.d_hzn__meter.slice(),
      theta_hzn: qp.theta_hzn.slice(),
      N_s, gamma_e, k: 1 / (gamma_e * a_0__meter),
      h_sys_m: h_sys,
      d_m: qp.d__meter,
      mode: lr.propmode, modeLabel: PROP_MODE[lr.propmode],
      detail: lr.detail,
      warnBits: w.v, warnings,
    };
  }

  // The effective-earth factor k that a surface refractivity implies, for the
  // profile chart's curvature: the same [TN101, 4.4] the model itself uses, so
  // the picture bends the earth exactly as much as the loss does. N_s = 301 is
  // k = 4/3 to three figures.
  function kFactor(N_s) {
    const gamma_e = 157e-9 * (1 - 0.04665 * Math.exp(N_s / 179.3));
    return 1 / (gamma_e * a_0__meter);
  }

  return {
    pointToPoint, kFactor, qerfi,
    CLIMATE, MDVAR, PROP_MODE,
    // exposed for the test's own probing, and for nothing in the app
    _internals: { quickPfl, computeDeltaH, linearLeastSquaresFit, findHorizons, initializePointToPoint, longleyRice, variability },
  };
})();
if (typeof window !== 'undefined') window.ITM = ITM;
// test/itm.mjs require()s this file and holds it against the NTIA reference
// vectors. Guarded so the browser, where `module` is undefined, never runs it.
if (typeof module !== 'undefined' && module.exports) module.exports = ITM;
