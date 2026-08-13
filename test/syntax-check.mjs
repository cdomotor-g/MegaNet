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

console.log('');
if (failed) {
  console.log(`FAIL — ${failed} of ${scripts.length} script(s) did not parse.`);
  process.exit(1);
}
console.log(`PASS — ${scripts.length} script(s) parse.`);
