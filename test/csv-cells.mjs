// csvEscape (core.js), the one cell writer most of the app's CSVs go through.
// A cell is quoted when it holds a comma, a quote or a line break; and a cell a
// spreadsheet would work out as a formula — =, @, a tab or carriage return
// first, or + or - before anything but a number — starts with an apostrophe,
// because text in these files (a base station's path, a station's name, a
// purpose typed in) is not ours, and Excel runs a formula even in quotes.
// Numbers, negative ones included, stay numbers.
//
// Run:  npm run csvcells

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';

const core = readFileSync(path.join(REPO_ROOT, 'core.js'), 'utf8');
const src = core.match(/function csvEscape\(s\) \{[\s\S]*?\n\}/);
if (!src) { console.log('FAIL — csvEscape is not in core.js'); process.exit(1); }
const csvEscape = new Function(`${src[0]}; return csvEscape;`)();

const cases = [
  ['plain', 'plain'], ['a,b', '"a,b"'], ['say "hi"', '"say ""hi"""'], ['two\nlines', '"two\nlines"'],
  [-7, '-7'], ['-5', '-5'], ['+3.2', '+3.2'], ['-1e5', '-1e5'], ['.5', '.5'], ['-', '-'], [null, ''], [0, '0'],
  ['=HYPERLINK("http://x","y")', '"\'=HYPERLINK(""http://x"",""y"")"'], ['@SUM(A1)', "'@SUM(A1)"],
  ['+cmd', "'+cmd"], ['-2+3', "'-2+3"], ['\tx', "'\tx"], ['\rx', '"\'\rx"'], ['x\ry', '"x\ry"'],
];
let failed = 0;
for (const [v, want] of cases) {
  const got = csvEscape(v), ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${JSON.stringify(v)} → ${JSON.stringify(got)}${ok ? '' : `, wanted ${JSON.stringify(want)}`}`);
}
console.log('');
if (failed) { console.log(`FAIL — ${failed} of ${cases.length} cells written wrong.`); process.exit(1); }
console.log(`PASS — ${cases.length} cells: quoted where they must be, a formula never live, numbers left as numbers.`);
