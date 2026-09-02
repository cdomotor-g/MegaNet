// The Longley–Rice port against its reference.
//
// itm.js is a function-for-function port of NTIA's ITM C++ (v1.3, functionally
// FORTRAN v1.2.2 — the model inside Radio Mobile). A port of a propagation
// model has exactly one honest test: the reference implementation's own
// numbers. test/baseline/itm-vectors.json holds 53 of them — NTIA's five
// published point-to-point vectors verbatim, plus 48 synthetic profiles chosen
// to land in every regime (line of sight, diffraction, troposcatter), every
// climate, both polarizations, all four modes of variability with and without
// the +10/+20 eliminations, and frequencies from 70 to 900 MHz — each run
// through the compiled NTIA library and recorded with its intermediates.
//
// Tolerance is 1e-6 dB on the loss and 1e-6 relative on the intermediates.
// That is tighter than any decision anybody will make on a fade margin by
// six orders of magnitude, and it is the point: a port that agrees to 0.1 dB
// could be hiding a wrong branch that only shows on the next profile.
//
//   node --run itm      (or: npm run itm)
//       npm run itm -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT, baseline } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const ITM = require(path.join(REPO_ROOT, 'itm.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const { cases } = JSON.parse(fs.readFileSync(baseline('itm-vectors.json'), 'utf8'));
const TOL_DB = 1e-6;
const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log(`\nLongley–Rice point-to-point against the NTIA reference (${cases.length} vectors)`);

const modes = { 1: 0, 2: 0, 3: 0 };
for (const c of cases) {
  const r = ITM.pointToPoint(c);
  const e = c.expect;
  if (!r.ok) { ok(`${c.name} computes`, false, r.error); continue; }
  modes[r.mode]++;
  const bits = [
    ['A_db', close(r.A_db, e.A_db, TOL_DB)],
    ['A_ref', close(r.A_ref_db, e.A_ref_db, TOL_DB)],
    ['A_fs', close(r.A_fs_db, e.A_fs_db, TOL_DB)],
    ['Δh', close(r.delta_h_m, e.delta_h_m, 1e-6)],
    ['he', close(r.h_e_m[0], e.h_e_m[0], 1e-6) && close(r.h_e_m[1], e.h_e_m[1], 1e-6)],
    ['dl', close(r.d_hzn_m[0], e.d_hzn_m[0], 1e-6) && close(r.d_hzn_m[1], e.d_hzn_m[1], 1e-6)],
    ['θ', close(r.theta_hzn[0], e.theta_hzn[0], 1e-6) && close(r.theta_hzn[1], e.theta_hzn[1], 1e-6)],
    ['Ns', close(r.N_s, e.N_s, 1e-6)],
    ['mode', r.mode === e.mode],
    ['warnings', r.warnBits === e.warnBits],
  ];
  const bad = bits.filter(([, v]) => !v).map(([k]) => k);
  ok(`${c.name} (${r.modeLabel.toLowerCase()}, ${(r.d_m / 1000).toFixed(1)} km, ${c.fMhz} MHz, climate ${c.climate}, mdvar ${c.mdvar})`,
     bad.length === 0,
     bad.length ? `${bad.join(', ')} differ — got A=${r.A_db.toFixed(6)} ref ${e.A_db.toFixed(6)}, A_ref ${r.A_ref_db.toFixed(6)} ref ${e.A_ref_db.toFixed(6)}, Δh ${r.delta_h_m.toFixed(6)} ref ${e.delta_h_m.toFixed(6)}, warn ${r.warnBits} ref ${e.warnBits}`
                : `A=${r.A_db.toFixed(2)} dB`);
}
ok('the vectors cover all three propagation regimes', modes[1] > 0 && modes[2] > 0 && modes[3] > 0,
   `LOS ${modes[1]}, diffraction ${modes[2]}, troposcatter ${modes[3]}`);

console.log('\nThe model’s own properties');

// A smooth, flat path at k=4/3: the loss must sit near free space in the
// median and never below what Eqn 52 allows.
const flat = [100, 100];
for (let i = 0; i <= 100; i++) flat.push(200);
const fs0 = ITM.pointToPoint({ pfl: flat, hTx: 30, hRx: 30, fMhz: 151.5, climate: 5, N0: 301, pol: 1,
                               epsilon: 15, sigma: 0.005, mdvar: 0, time: 50, location: 50, situation: 50 });
ok('a 10 km flat path with 30 m masts is line of sight', fs0.ok && fs0.mode === 1, fs0.modeLabel);
ok('…and costs within 10 dB of free space at the median', fs0.ok && Math.abs(fs0.A_db - fs0.A_fs_db) < 10,
   `excess ${(fs0.A_db - fs0.A_fs_db).toFixed(2)} dB`);

// More reliability must never cost less.
const at = s => ITM.pointToPoint({ pfl: flat, hTx: 4, hRx: 4, fMhz: 151.5, climate: 2, N0: 301, pol: 1,
                                   epsilon: 15, sigma: 0.005, mdvar: 0, time: 50, location: 50, situation: s }).A_db;
ok('loss rises monotonically with %situations', at(50) < at(70) && at(70) < at(90) && at(90) < at(99),
   `${at(50).toFixed(1)} < ${at(70).toFixed(1)} < ${at(90).toFixed(1)} < ${at(99).toFixed(1)}`);

// N_s = 301 is the textbook k = 4/3.
ok('N_s = 301 gives k = 4/3', Math.abs(ITM.kFactor(301) - 4 / 3) < 0.002, ITM.kFactor(301).toFixed(4));

// The quantile function is A&S 26.2.23 — an approximation good to 4.5e-4,
// so the median lands within that of zero, and the two tails mirror exactly.
ok('qerfi(0.5) ≈ 0 and qerfi is antisymmetric',
   Math.abs(ITM.qerfi(0.5)) < 4.5e-4 && Math.abs(ITM.qerfi(0.1) + ITM.qerfi(0.9)) < 1e-12,
   `qerfi(0.5) = ${ITM.qerfi(0.5).toExponential(2)}`);

// Inputs the reference refuses, this refuses too — with a reason in words.
const bad = ITM.pointToPoint({ pfl: flat, hTx: 0.2, hRx: 4, fMhz: 151.5 });
ok('an antenna under 0.5 m is refused with a reason', !bad.ok && /height/.test(bad.error), bad.error);
const badf = ITM.pointToPoint({ pfl: flat, hTx: 4, hRx: 4, fMhz: 5 });
ok('a frequency under 20 MHz is refused with a reason', !badf.ok && /frequency/i.test(badf.error), badf.error);

console.log(failures
  ? `\nFAIL — ${failures} of ${failures + passes} assertions about the Longley–Rice port.`
  : `\nPASS — ${passes} assertions: the port reproduces the NTIA reference to 1e-6 dB on every vector.`);
process.exit(failures ? 1 : 0);
