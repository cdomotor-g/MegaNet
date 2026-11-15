// `node --check` over every script index.html loads, not just app.js.
//
// #130 asks for this to be kept rather than replaced: it is the fast pre-filter.
// It runs in well under a second and catches a broken brace before Chromium is
// ever launched. What it cannot catch is the entire reason smoke.mjs exists — a
// name that no longer resolves is perfectly valid syntax.
//
// The reason it lives here instead of in a one-line CI step is the split (#129):
// after M1–M4 there are a dozen files to check, and this reads the list out of
// index.html so nobody has to remember to extend it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { localScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const run = promisify(execFile);
const scripts = localScripts();

if (!scripts.length) {
  console.error('No local <script src> found in index.html — that cannot be right.');
  process.exit(1);
}

let failed = 0;
for (const s of scripts) {
  try {
    await run(process.execPath, ['--check', s.path]);
    console.log(`  ✓ ${path.relative(REPO_ROOT, s.path)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${path.relative(REPO_ROOT, s.path)}`);
    console.log((err.stderr || err.message).trim().split('\n').map(l => `      ${l}`).join('\n'));
  }
}

// Two ways to put a name into the page unescaped that parse perfectly well.
// escAttr is for a value inside '…' in an attribute; around JSON.stringify it
// doubles the backslash JSON put before a quote, and the quote ends the
// string — esc(JSON.stringify(x)) is the form. And Leaflet writes a tooltip or
// popup string as HTML, so a name goes in through esc().
const { readFileSync } = await import('node:fs');
const UNSAFE = [
  [/escAttr\(JSON\.stringify\(/, 'escAttr(JSON.stringify(…)) — use esc(JSON.stringify(…))'],
  [/\.(bindTooltip|bindPopup)\(`[^`]*\$\{[\w.]*\.name\}/, 'a name in a Leaflet tooltip or popup without esc()'],
];
for (const s of scripts) {
  readFileSync(s.path, 'utf8').split('\n').forEach((line, i) => {
    for (const [re, why] of UNSAFE) if (re.test(line)) {
      failed++;
      console.log(`  ✗ ${path.relative(REPO_ROOT, s.path)}:${i + 1} ${why}`);
    }
  });
}

console.log('');
if (failed) {
  console.log(`FAIL — ${failed} problem(s) in ${scripts.length} script(s): a script that did not parse, or a name put in the page unescaped.`);
  process.exit(1);
}
console.log(`PASS — ${scripts.length} script(s) parse.`);
