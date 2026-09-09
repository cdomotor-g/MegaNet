// CI runs what `npm run all` runs, and vice versa.
//
// Written because the same drift has happened twice and both times was found
// by accident. `catchments.mjs` landed in `npm run all` with no step in
// `.github/workflows/web-smoke.yml`, so it ran for whoever typed it and on no
// push at all; `mapfade.mjs` did the same, and was found while adding the step
// for something else. The workflow's own comment ends: *"The two lists still
// have to be kept in step by hand and still nothing verifies that they agree —
// which is the check worth writing the next time either is touched."* This is
// that check.
//
// What makes the drift invisible is that **both halves stay green while they
// disagree**. A check missing from CI passes locally for the person who wrote
// it. A step naming a script that no longer exists fails the job, but with
// `npm ERR! Missing script` — which reads like a broken workflow rather than
// like a check that was renamed. Neither is loud, and neither is anybody's job
// to notice.
//
// Parse-only, no browser, under a second. It reads three things:
//
//   * the script names in `test/package.json`
//   * what `npm run all` chains together
//   * every `npm run <name>` under a `working-directory: test` step in the
//     workflow
//
// and requires them to agree in both directions, with one explicit exemption
// list: `concat`, the milestone tool the workflow's own footer says is
// deliberately not run, and the two npm-shaped entries that are not checks at
// all. This check is in both lists like any other — it is fast, it is
// parse-only, and a rule that exempts its own enforcer is a rule with a hole
// in it.
//
// Run:  npm run steps
//       npm run steps -- -v    also list what matched

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORKFLOW = path.join(REPO, '.github/workflows/web-smoke.yml');

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

// Scripts that are deliberately neither in `all` nor in CI, each with the
// reason it is out. Anything not on this list has to be in both.
const EXEMPT = {
  all:     'the chain itself',
  test:    'node --test, the empty default npm puts there',
  concat:  'a milestone tool for the #129 split: it diffs the app against a recorded '
         + 'snapshot, so any honest change makes it stale. The workflow footer says so too',
};

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const scripts = Object.keys(pkg.scripts || {});

// What `npm run all` actually chains. Split on && rather than on whitespace so
// a script name that happens to appear in a comment cannot join the list.
const chained = (pkg.scripts.all || '').split('&&')
  .map(s => s.trim())
  .map(s => (s.match(/^npm run ([\w-]+)$/) || [, null])[1])
  .filter(Boolean);

check('`npm run all` is a chain of npm run steps and nothing else',
  chained.length === (pkg.scripts.all || '').split('&&').length,
  pkg.scripts.all);

// The workflow's `npm run` invocations, taken only from steps that run in the
// harness directory — the Python and psql steps are a different net.
const yml = fs.readFileSync(WORKFLOW, 'utf8');
const inCi = new Set();
for (const m of yml.matchAll(/working-directory:\s*test\s*\n\s*run:\s*npm run ([\w-]+)/g)) {
  inCi.add(m[1]);
}
inCi.delete('ci');            // `npm ci` — the install step, not a check

check('the workflow runs some checks out of test/', inCi.size > 10, `${inCi.size} found`);

// ── The two directions ───────────────────────────────────────────────────────

for (const name of scripts) {
  if (EXEMPT[name]) continue;
  const inAll = chained.includes(name);
  const ci    = inCi.has(name);
  check(`${name}: in \`npm run all\``, inAll,
    'a check nobody chains is a check that only runs when somebody remembers it');
  check(`${name}: has a step in web-smoke.yml`, ci,
    'a check CI does not run is a check that is not there');
}

for (const name of chained) {
  check(`${name}: \`all\` names a script that exists`, scripts.includes(name),
    `not in package.json — ${scripts.join(', ')}`);
}
for (const name of inCi) {
  check(`${name}: the workflow names a script that exists`, scripts.includes(name),
    'the job fails with "Missing script", which reads like a broken workflow');
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s) over ${scripts.length - Object.keys(EXEMPT).length} `
  + `check(s); ${Object.keys(EXEMPT).length} exempt: ${Object.keys(EXEMPT).join(', ')}.`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — every check is chained by `npm run all` and run by CI, and both name '
  + 'scripts that exist.');
