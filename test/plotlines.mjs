// The arithmetic behind "Your lines" on the Plots and Field Data charts.
//
// plot-lines.js parses a function a person types and fits curves to readings
// they picked. Both have answers known in advance, so both are held to them
// here: an expression evaluates to what it says on paper, anything outside the
// grammar is refused (and in particular nothing reaches JavaScript), and each
// fit recovers the coefficients of a curve built from them. Node only, no
// browser, well under a second.
//
//   npm run plotlines          (-- -v to list what passed)

import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const P = require(path.join(REPO_ROOT, 'plot-lines.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
let failures = 0, passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; if (VERBOSE) console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ── The expression language ──────────────────────────────────────────────────
const at = (src, h) => { const c = P.compile(src); return c.error ? c.error : c.f(h); };
const cases = [
  ['2t+1', 3, 7],
  ['2 * t + 1', 3, 7],
  ['-t^2', 3, -9],               // unary minus binds looser than ^, as on paper
  ['2^3^2', 0, 512],             // ^ is right-associative
  ['2(t+1)', 3, 8],              // juxtaposition is multiplication
  ['2 pi', 0, 2 * Math.PI],
  ['3.2*exp(-t/36)', 36, 3.2 / Math.E],
  ['d', 48, 2],                  // d is days
  ['x', 5, 5],                   // x is t
  ['t**2', 4, 16],
  ['max(t, 2)', 1, 2],
  ['step(t - 6) * 0.4', 5, 0],
  ['step(t - 6) * 0.4', 6, 0.4],
  ['ln(e)', 0, 1],
  ['log(1000)', 0, 3],
  ['1.5e3', 0, 1500],
  ['4 × 2 ÷ 8 − 1', 0, 0],       // pasted typography
  ['sqrt(abs(-16))', 0, 4],
];
for (const [src, h, want] of cases) {
  const got = at(src, h);
  check(`${src} at t=${h} is ${want}`, typeof got === 'number' && near(got, want), String(got));
}
check('a plain number is a constant', P.compile('1.8').constant === true);
check('a function of t is not', P.compile('1.8 + 0*t').constant === false);

// Refused — and refused by the parser, which is the whole safety argument:
// nothing typed here is ever handed to Function or eval.
for (const src of ['alert(1)', 'constructor', 'window', 't.constructor', '__proto__',
                   'this', '[1]', 't;1', '"a"', 'sin t', 'max(1)', '', '   ', 't +', '(t', 't)']) {
  const c = P.compile(src);
  check(`refuses ${JSON.stringify(src)}`, !!c.error && !c.f, c.error || 'compiled');
}
check('an error says where', /position \d+/.test(P.compile('t + $').error || ''));

// ── Fits ─────────────────────────────────────────────────────────────────────
const xs = Array.from({ length: 60 }, (_, i) => i * 0.75);
const fitOf = (kind, f) => P.fit(kind, xs, xs.map(f));

{
  const r = fitOf('linear', x => 1.25 + 0.04 * x);
  check('linear recovers a and b', near(r.coef[0], 1.25, 1e-9) && near(r.coef[1], 0.04, 1e-9), JSON.stringify(r.coef));
  check('linear r² is 1 on a straight line', near(r.r2, 1, 1e-12));
  check('linear equation reads as written', r.eq === '1.25 + 0.04·t', r.eq);
}
{
  const r = fitOf('quadratic', x => 1.5 + 0.3 * x - 0.01 * x * x);
  check('quadratic recovers its three', [1.5, 0.3, -0.01].every((c, j) => near(r.coef[j], c, 1e-8)), JSON.stringify(r.coef));
  check('quadratic equation folds the sign', r.eq === '1.5 + 0.3·t − 0.01·t²', r.eq);
}
{
  const r = fitOf('cubic', x => 2 - 0.1 * x + 0.004 * x ** 2 - 0.00005 * x ** 3);
  check('cubic recovers its four', [2, -0.1, 0.004, -0.00005].every((c, j) => near(r.coef[j], c, 1e-6)), JSON.stringify(r.coef));
}
{
  const r = fitOf('exp', x => 3 * Math.exp(0.05 * x));
  check('exponential recovers a and b', near(r.coef[0], 3, 1e-9) && near(r.coef[1], 0.05, 1e-9), JSON.stringify(r.coef));
  check('exponential refuses a value at or below zero', !!fitOf('exp', x => x - 1).error);
}
{
  const r = fitOf('recession', x => 0.4 + 2 * Math.exp(-x / 7));
  const [base, a, k] = r.coef;
  check('recession recovers baseline, size and time constant',
        near(base, 0.4, 1e-4) && near(a, 2, 1e-4) && near(k, 7, 1e-4), JSON.stringify(r.coef));
  check('recession says which way it is going', /falling towards 0\.4/.test(r.note || ''), r.note);
}
{
  const r = fitOf('best', x => 0.4 + 2 * Math.exp(-x / 7));
  check('best of these picks recession for a recession', r.kind === 'recession', r.kind);
  const q = fitOf('best', x => 1.5 + 0.3 * x - 0.01 * x * x);
  check('best of these picks quadratic for a quadratic', q.kind === 'quadratic', q.kind);
}
// Every fit's source text compiles back to the same curve — that is how a
// fit is drawn, so a mismatch would draw a different curve from the one whose
// equation and r² the panel quotes.
for (const kind of ['linear', 'quadratic', 'cubic', 'exp', 'recession']) {
  const r = fitOf(kind, x => 1 + 0.5 * Math.exp(-x / 9) + 0.01 * x);
  const c = P.compile(r.src);
  check(`${kind}: its source compiles to the same curve`,
        !c.error && [0, 7.3, 30, 80].every(h => near(c.f(h), r.f(h), 1e-12)), c.error || r.src);
}
check('too few readings is said, not thrown', /at least 4/.test(P.fit('cubic', [0, 1, 2], [1, 2, 3]).error || ''));
check('readings all at one moment are said, not thrown', !!P.fit('linear', [5, 5, 5], [1, 2, 3]).error);
check('non-finite readings are left out', P.fit('linear', [0, 1, 2, NaN], [1, 2, 3, 4]).n === 3);
{
  const r = P.fit('linear', [0, 1, 2, 3], [1, 1, 1, 1]);
  check('a flat run fits with r² 1, not NaN', r.r2 === 1 && r.rmse === 0, `${r.r2} ${r.rmse}`);
}

console.log(`\nplotlines: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
