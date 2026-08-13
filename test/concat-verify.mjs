// The concat-and-diff verifier (#130, item 2).
//
// What it is for: when #132–#135 cut app.js into ordered classic scripts, the
// only claim that matters is "the split lost nothing". Concatenating the pieces
// in index.html order and comparing the bytes against the file before the cut is
// what proves it — and it is the only check that reliably catches the 4 NUL-byte
// hazard (#129). A tool that round-trips one of these files as text and
// normalises control characters corrupts those lines invisibly; a byte
// comparison does not care what the bytes mean.
//
// Everything here compares Buffers. Nothing decodes.
//
// M2 (#133) moved the fourth of those out with Alert2, so the hazard is now
// spread across two files — app.js:6154 and 6218×2, alert2.js:857 — which is an
// argument for this check rather than against it: the count below is over the
// whole concatenation, so it does not care which file they end up in.
//
// This is a milestone tool, not a CI gate, and deliberately so: the baseline is
// a snapshot of app.js at a moment in time, so any honest change to the app
// makes it stale. Wiring it into every push would mean re-recording the baseline
// on every commit, which would train everyone to re-record it without looking —
// and a verifier nobody looks at verifies nothing.
//
// How to use it across a split:
//
//   1. Before cutting:   npm run concat -- --update
//   2. Cut the file, wiring every piece into index.html in load order.
//   3. After cutting:    npm run concat
//      Identical bytes → the split moved code and changed none of it.
//   4. Land the split, then re-record the baseline for the next milestone.
//
// A milestone that also *edits* code cannot be verified this way, which is the
// point: do the move and the edit as two commits.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { appScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT, baseline } from './lib/paths.mjs';

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const againstIdx = args.indexOf('--against');
const AGAINST = againstIdx >= 0 ? args[againstIdx + 1] : null;
const BASELINE = baseline('app-bytes.json');

const scripts = appScripts();
if (!scripts.length) {
  console.error('index.html loads no local app scripts — nothing to verify.');
  process.exit(1);
}

const parts = scripts.map(s => ({ name: s.name, buf: fs.readFileSync(s.path) }));
const joined = Buffer.concat(parts.map(p => p.buf));

const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const nuls = b => { let n = 0; for (const byte of b) if (byte === 0) n++; return n; };

const actual = { bytes: joined.length, sha256: digest(joined), nulBytes: nuls(joined) };

console.log('  Load order (from index.html):');
for (const p of parts) console.log(`    ${p.name.padEnd(28)} ${String(p.buf.length).padStart(9)} bytes`);
console.log('');
console.log(`  concatenated: ${actual.bytes} bytes, ${actual.nulBytes} NUL, sha256 ${actual.sha256.slice(0, 16)}…`);
console.log('');

// --against compares straight to a file on disk, e.g. a copy of app.js taken
// from git before the cut: `git show <ref>:app.js > /tmp/pre-split.js`.
if (AGAINST) {
  const expected = fs.readFileSync(AGAINST);
  report({ bytes: expected.length, sha256: digest(expected), nulBytes: nuls(expected) },
         `the file at ${AGAINST}`, expected);
} else if (UPDATE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: 'Byte snapshot of the app.js lineage, in index.html load order. Re-record '
        + 'with: npm run concat -- --update. See the header of test/concat-verify.mjs.',
    recordedFrom: parts.map(p => ({ file: p.name, bytes: p.buf.length })),
    ...actual,
  }, null, 2) + '\n');
  console.log(`  Baseline written to ${path.relative(REPO_ROOT, BASELINE)}`);
  console.log('\nRECORDED — split the file, then run `npm run concat` to prove nothing changed.');
} else if (fs.existsSync(BASELINE)) {
  report(JSON.parse(fs.readFileSync(BASELINE, 'utf8')), path.relative(REPO_ROOT, BASELINE), null);
} else {
  console.log(`No baseline at ${path.relative(REPO_ROOT, BASELINE)}.`);
  console.log('Record one before splitting anything:  npm run concat -- --update');
  process.exit(1);
}

function report(expected, source, expectedBuf) {
  const same = expected.sha256 === actual.sha256;
  if (same) {
    console.log(`PASS — byte-identical to ${source}.`);
    return;
  }

  console.log(`FAIL — the concatenation does not match ${source}.\n`);
  console.log(`  bytes     expected ${expected.bytes}  actual ${actual.bytes}  `
    + `(${actual.bytes - expected.bytes >= 0 ? '+' : ''}${actual.bytes - expected.bytes})`);
  console.log(`  sha256    expected ${expected.sha256}\n            actual   ${actual.sha256}`);
  console.log(`  NUL bytes expected ${expected.nulBytes}  actual ${actual.nulBytes}`);

  if (expected.nulBytes !== actual.nulBytes) {
    console.log('\n  ** The NUL byte count changed. **');
    console.log('  app.js carries 4 literal U+0000 characters inside string literals, used as');
    console.log('  compound-key separators (#129). Something in the toolchain rewrote the file as');
    console.log('  text and normalised them away. The affected keys silently stop being unique.');
    console.log('  Redo the split with byte-exact tooling — read and write Buffers, never strings.');
  }

  // With the expected bytes in hand, say where they diverge — far more useful
  // than "the hashes differ" when a split dropped or duplicated a line.
  if (expectedBuf) {
    const n = Math.min(expectedBuf.length, joined.length);
    let i = 0;
    while (i < n && expectedBuf[i] === joined[i]) i++;
    const line = joined.subarray(0, i).toString('utf8').split('\n').length;
    console.log(`\n  First difference at byte ${i} (concatenated line ${line}).`);
    const around = b => JSON.stringify(b.subarray(Math.max(0, i - 40), i + 40).toString('utf8'));
    console.log(`    expected …${around(expectedBuf)}…`);
    console.log(`    actual   …${around(joined)}…`);
  }

  process.exitCode = 1;
}
