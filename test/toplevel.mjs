// The load-order contract, made checkable (#132, and #142 which needed it).
//
// `index.html` loads thirty classic scripts into one shared global scope, in a
// fixed order, and the reason that order is safe to add to is a single property:
// **`init.js` is the only file that executes at load. Everything else declares.**
// A file that only declares can sit anywhere among the modules, because nothing
// it does is observable until something calls it — which is what let #129's four
// milestones move twenty-six features into files of their own without ever
// having to reason about which of them came first.
//
// One top-level statement that runs on sight takes that back, silently. Nothing
// throws, `npm run all` stays green, and the file is load-bearing in a way no
// one wrote down — until the day someone inserts a script above it.
//
// Three milestones raised an ordering worry that measuring dissolved in minutes
// (`Alert2` ↔ `Serial` in M2, `PathProfile` ↔ `LinkBudget` in M3, `RfChanges` ↔
// `Workbench` in M4), each time by running this check by hand and each time
// writing it again. #142 needed it a fourth time — its whole risk is a module
// registering itself at its top level instead of from its init() — so it is a
// script now rather than a paragraph on #113 saying it takes minutes.
//
// Run:  npm run toplevel
//       npm run toplevel -- -v    also list what passed, per file
//
// ── What counts as inert ─────────────────────────────────────────────────────
//
//   declarations       `function`, `class`, `const`, `let`, `var`. The point of
//                      the exercise. Their initialisers are not inspected: a
//                      `const` whose value is an object literal that calls
//                      localStorage.getItem is still just a binding, and the
//                      app has several.
//   module IIFEs       `const X = (function () { … })()` is inert only if its
//                      body is, so the check **descends into it** — that is
//                      where every module in this app lives, and a stray
//                      registration inside one is exactly what #142 risks.
//   `return`           inside such a body: how a module hands back its exports.
//   `window.X = X`     the export idiom, including guarded as
//                      `if (typeof window !== 'undefined') window.X = X`. An
//                      assignment to a global that is already in scope.
//
// Everything else is reported. That deliberately includes the two statements the
// app knowingly runs at load — they are precisely the ones whose position means
// something, and a check that hid them would be hiding its own best findings.
// They are listed in ACCEPTED with the reason each has to run, and the check
// fails only on statements that are not.

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { localScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

// Statements the app runs at load on purpose, each with the reason it has to.
// Matched by the first line of the statement's own source text, so ordinary
// edits above one do not have to be re-recorded here.
//
// Adding an entry is a decision, not a formality: it makes that file's position
// in `index.html` mean something. Say why, or do not add it. A file mapped to
// `null` is exempt entirely.
const ACCEPTED = {
  'init.js': null,   // the one file that is allowed to do anything at all
  'maps-data.js': [
    {
      match: '(function (global) {',
      why: 'Publishes window.MegaNetMaps at load. This is the app\'s one real '
         + 'ordering constraint and #113 names it: network-maps.js reads '
         + 'window.MegaNetMaps at load too, so maps-data.js must precede it — '
         + 'true by construction in index.html, not by coincidence. Predates the '
         + 'split, is not part of the app.js lineage (see lib/app-scripts.mjs) '
         + 'and is generated data behind its own namespace.',
    },
  ],
  'hfem.js': [
    {
      match: "if (typeof module !== 'undefined' && module.exports) module.exports = HFEM;",
      why: 'The HFEM codec\'s CommonJS registration (#153): the bridge requires '
         + 'this same file, so there is one decoder and never a second opinion '
         + 'about what T3 means. Guarded so the browser, where `module` is '
         + 'undefined, never runs it. Constrains nothing below it.',
    },
  ],
  'core.js': [
    {
      match: "if (typeof window !== 'undefined') {",
      why: 'window.onerror / unhandledrejection capture. Registered as early as '
         + 'possible so a bug report carries what actually went wrong; MegaNet '
         + 'has no backend and this is the only record of a failure that exists. '
         + 'Constrains nothing below it.',
    },
    {
      match: "if (typeof L !== 'undefined' && L.Canvas) {",
      why: 'The Leaflet canvas-teardown patch, and the one statement in the app '
         + 'that genuinely is load-bearing: it must run before the first L.map() '
         + 'call, which is what putting it at the bottom of core.js buys. Its own '
         + 'comment says not to move it into a module file.',
    },
  ],
};

// `const X = (function () { … })()` — return the body's statements, or null if
// this expression is not an immediately-invoked function.
function iifeBody(node) {
  if (!node || node.type !== 'CallExpression') return null;
  let fn = node.callee;
  // (0, function () {})() — take the value the sequence evaluates to.
  if (fn.type === 'SequenceExpression') fn = fn.expressions[fn.expressions.length - 1];
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return null;
  return fn.body.type === 'BlockStatement' ? fn.body.body : null;
}

// `window.X = …` / `globalThis.X = …`, and nothing else.
function isGlobalExport(node) {
  if (node.type !== 'ExpressionStatement') return false;
  const e = node.expression;
  if (e.type !== 'AssignmentExpression' || e.operator !== '=') return false;
  const t = e.left;
  return t.type === 'MemberExpression' && !t.computed
    && t.object.type === 'Identifier'
    && (t.object.name === 'window' || t.object.name === 'globalThis');
}

// Collect every statement in `body` that is not inert, descending into module
// IIFEs. `inModule` allows `return`, which only makes sense inside one.
function offenders(body, inModule, out) {
  for (const node of body) {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'EmptyStatement':
        break;

      case 'ReturnStatement':
        if (!inModule) out.push(node);
        break;

      case 'VariableDeclaration':
        // The binding is inert; what it is bound to may not be.
        for (const d of node.declarations) {
          const inner = iifeBody(d.init);
          if (inner) offenders(inner, true, out);
        }
        break;

      // Two statements that are only as inert as what is inside them, judged
      // the same way: walk the branches and report the outer statement if any
      // branch is not inert.
      //
      // `if (typeof window !== 'undefined') window.X = X;` is the guarded export
      // idiom; `if (typeof L !== 'undefined') { L.Canvas.prototype… }` is not.
      // Judging the branches rather than the guard tells those two apart by
      // itself, without a list of blessed guard expressions.
      //
      // `try { return sessionStorage.getItem(k); } catch (_) { return null; }`
      // is how two constants in this app are computed defensively — a `return`
      // and a `const`, inside a module IIFE, and inert.
      case 'IfStatement':
      case 'TryStatement': {
        const before = out.length;
        const branch = s => s && offenders(s.type === 'BlockStatement' ? s.body : [s], inModule, out);
        if (node.type === 'IfStatement') {
          branch(node.consequent);
          branch(node.alternate);
        } else {
          branch(node.block);
          branch(node.handler && node.handler.body);
          branch(node.finalizer);
        }
        // Report the outer statement, once, instead of its innards, so the
        // message points at a line someone can act on.
        if (out.length > before) { out.length = before; out.push(node); }
        break;
      }

      default:
        if (!isGlobalExport(node)) out.push(node);
    }
  }
}

// utf8 round-trips the app's 4 NUL bytes unharmed — they sit inside string
// literals and JS strings hold U+0000 like any other code point. Nothing here
// writes a file back, so there is no corruption risk either way (#129).
function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const found = [];
  offenders(ast.body, false, found);
  const lines = src.split('\n');
  return {
    statements: ast.body.length,
    found: found.map(n => ({
      line: n.loc.start.line,
      text: (lines[n.loc.start.line - 1] || '').trim(),
    })),
  };
}

const scripts = localScripts();
let unexplained = 0;
let accepted = 0;

console.log('');
for (const s of scripts) {
  const rel = path.relative(REPO_ROOT, s.path);
  if (Object.prototype.hasOwnProperty.call(ACCEPTED, s.name) && ACCEPTED[s.name] === null) {
    console.log(`  – ${rel} — exempt (the file that runs the app)`);
    continue;
  }

  let res;
  try {
    res = scan(s.path);
  } catch (err) {
    console.log(`  ✗ ${rel} — could not parse: ${err.message}`);
    process.exit(1);
  }

  const allow = ACCEPTED[s.name] || [];
  const bad = [];
  for (const f of res.found) {
    const hit = allow.find(a => a.match === f.text);
    if (hit) { accepted++; if (VERBOSE) console.log(`  · ${rel}:${f.line} — accepted: ${hit.why}`); }
    else bad.push(f);
  }

  if (bad.length) {
    unexplained += bad.length;
    console.log(`  ✗ ${rel} — ${bad.length} statement(s) that execute at load:`);
    for (const f of bad) console.log(`      ${f.line}: ${f.text}`);
  } else if (VERBOSE) {
    console.log(`  ✓ ${rel} — ${res.statements} top-level statement(s), all inert`);
  }
}

console.log('');
console.log(`  ${scripts.length} script(s) checked, ${accepted} accepted side effect(s).`);
console.log('');

if (unexplained) {
  console.log(`FAIL — ${unexplained} statement(s) execute at load in a file that should only declare.\n`);
  console.log('  Each one makes its file\'s position in index.html load-bearing: a script');
  console.log('  inserted above it now changes what it sees. Either move the work into the');
  console.log('  module\'s own init()/render() where the app calls it, or — if it genuinely');
  console.log('  has to run at load — put it in init.js, or add it to ACCEPTED at the top of');
  console.log('  this file with the reason. See #129 and #132.\n');
  process.exit(1);
}
console.log('PASS — init.js is still the only file that executes at load.');
