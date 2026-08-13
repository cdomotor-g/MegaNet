// The one genuinely new failure mode the app.js split introduces (#130).
//
// Classic scripts share a single global lexical environment — which is exactly
// why the split works at all (#129), and exactly why it is dangerous. A
// duplicate top-level `const` throws loudly at load, so the smoke test would
// catch it. A duplicate top-level `function` does not: the second declaration
// silently overwrites the first, and everything that called the original starts
// calling something else. With several agents adding helpers to different files,
// a second `function esc()` is not a hypothetical.
//
// So: parse every script index.html loads, collect the declarations that land in
// the shared global scope, and refuse duplicates across all of them.
//
// Run:  npm run names
//       npm run names -- --update   to re-record the declaration count

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { localScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT, baseline } from './lib/paths.mjs';

const UPDATE = process.argv.includes('--update');
const BASELINE = baseline('top-level-names.json');

// Destructuring at the top level binds every name in the pattern.
function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':        out.push(node.name); break;
    case 'ObjectPattern':     node.properties.forEach(p =>
                                patternNames(p.type === 'RestElement' ? p.argument : p.value, out)); break;
    case 'ArrayPattern':      node.elements.forEach(e => e && patternNames(e, out)); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement':       patternNames(node.argument, out); break;
  }
}

function topLevelNames(file) {
  // utf8 round-trips the 4 NUL bytes in app.js unharmed — they sit inside string
  // literals and JS strings hold U+0000 like any other code point. Nothing here
  // writes the file back, so there is no corruption risk either way (#129).
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const names = [];
  for (const node of ast.body) {
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      names.push({ name: node.id.name, kind: node.type === 'FunctionDeclaration' ? 'function' : 'class',
                   line: node.loc.start.line });
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        const got = [];
        patternNames(d.id, got);
        for (const name of got) names.push({ name, kind: node.kind, line: node.loc.start.line });
      }
    }
  }
  return names;
}

const scripts = localScripts();
const seen = new Map();          // name -> [{ file, kind, line }]
let total = 0;

for (const s of scripts) {
  let names;
  try {
    names = topLevelNames(s.path);
  } catch (err) {
    console.log(`  ✗ ${s.name} — could not parse: ${err.message}`);
    process.exit(1);
  }
  total += names.length;
  for (const n of names) {
    if (!seen.has(n.name)) seen.set(n.name, []);
    seen.get(n.name).push({ file: s.name, ...n });
  }
  console.log(`  · ${path.relative(REPO_ROOT, s.path)} — ${names.length} top-level declaration(s)`);
}

const dups = [...seen.entries()].filter(([, uses]) => uses.length > 1);

console.log('');
console.log(`  ${total} top-level declarations across ${scripts.length} script(s), ${seen.size} distinct.`);

if (UPDATE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({
    note: 'Re-record with: npm run names -- --update. The count is informational; '
        + 'the hard rule is that there are no duplicates.',
    scripts: scripts.map(s => s.name),
    total, distinct: seen.size,
  }, null, 2) + '\n');
  console.log(`  Baseline written to ${path.relative(REPO_ROOT, BASELINE)}`);
}

// The count moves whenever anyone writes a function, so it is reported rather
// than enforced — a check that goes red for ordinary work gets switched off. It
// is still worth printing: a *drop* of a hundred in a split commit means a file
// stopped being loaded.
if (!UPDATE && fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  if (base.total !== total) {
    const delta = total - base.total;
    console.log(`  (baseline was ${base.total}; ${delta > 0 ? '+' : ''}${delta} since. `
      + `Re-record with: npm run names -- --update)`);
  }
}

console.log('');
if (dups.length) {
  console.log(`FAIL — ${dups.length} name(s) declared more than once in the shared global scope:\n`);
  for (const [name, uses] of dups) {
    console.log(`  ${name}`);
    for (const u of uses) console.log(`    ${u.kind} at ${u.file}:${u.line}`);
    const silent = uses.every(u => u.kind === 'function');
    console.log(silent
      ? '    → both are function declarations: the later one silently wins, and every\n'
      + '      caller of the first is now calling the second. Nothing throws.\n'
      : '    → at least one is let/const/class: this throws at load.\n');
  }
  process.exit(1);
}
console.log('PASS — no duplicate top-level declarations.');
