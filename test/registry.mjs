// The module registries, checked (#142).
//
// `switchTab()` used to name three modules to stop and `invalidateMapSizes()`
// five maps to re-measure, and by the end of #129 nearly every one of those
// names lived in a file other than the one doing the naming. #142 inverted it:
// a module registers itself, from its own file.
//
// That is only an improvement if the registration is actually there, and the
// whole reason this registry was worth fixing is that a missing entry **fails
// in silence**. A map absent from the re-measure list renders at the wrong size
// after a nav collapse; a module absent from the stop-list keeps its loop or its
// ResizeObserver running behind whatever tab replaced it. Nothing throws, no
// console error is printed, and `npm run check`, `npm run names` and
// `npm run smoke` are all still green — smoke opens the tab, and the tab is
// fine. It is the *leaving* that isn't.
//
// So this check does the two things a person would otherwise have to do by hand
// on every tab, every time:
//
//   Static   — no file creates a Leaflet map without also registering one. This
//              is the one that catches the *next* tab, the one nobody has
//              written yet, because it never has to be told the tab exists.
//   Runtime  — open the map tabs in a real browser, collapse the nav, and assert
//              invalidateSize() was actually called on each live map; then leave
//              each stateful tab and assert the thing it started actually
//              stopped.
//
// Run:  npm run registry
//       npm run registry -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { localScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 400);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Static: no map without a registration ────────────────────────────────────
// Walk each script for `L.map(…)` and for `registerLiveMap(…)`. A file that
// creates a map and never registers one is the omission this whole issue is
// about, caught before a browser is launched.

function callsIn(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return; }
  if (node.type === 'CallExpression') {
    const c = node.callee;
    if (c.type === 'Identifier') out.push({ name: c.name, line: node.loc.start.line });
    else if (c.type === 'MemberExpression' && !c.computed
             && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
      out.push({ name: `${c.object.name}.${c.property.name}`, line: node.loc.start.line });
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    callsIn(node[k], out);
  }
}

function staticPhase() {
  console.log('\nStatic — every file that builds a map registers one\n');
  for (const s of localScripts()) {
    // utf8 round-trips the app's 4 NUL bytes unharmed, and nothing here writes
    // a file back (#129).
    const src = fs.readFileSync(s.path, 'utf8');
    let ast;
    try {
      ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    } catch (err) {
      check(`${s.name} parses`, false, err.message);
      continue;
    }
    const calls = [];
    callsIn(ast.body, calls);
    const builds  = calls.filter(c => c.name === 'L.map');
    const registers = calls.filter(c => c.name === 'registerLiveMap');
    if (!builds.length) continue;
    const rel = path.relative(REPO_ROOT, s.path);
    check(`${rel} registers the map(s) it builds`,
      registers.length >= builds.length,
      `${builds.length} L.map() call(s) at line(s) ${builds.map(b => b.line).join(', ')}, `
      + `${registers.length} registerLiveMap() call(s)`);
  }
}

// ── Runtime: the registries do what the two functions used to do by name ─────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `state`, `_liveMaps` and `_tabTeardowns` are top-level `const`s in classic
// scripts, so they are in the global lexical scope but not on `window`. String
// expressions evaluate in that scope; `window.x` lookups would not find them.
const eq = (page, expr) => page.evaluate(expr);

async function runtimePhase() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.dismiss().catch(() => {}));

    await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });

    const go = async id => { await page.evaluate(t => switchTab(t), id); await sleep(SETTLE * 2); };

    console.log('\nRuntime — each map registers itself, keyed by name\n');

    // init.js renders the Stations tab at load, so its map is already up.
    check('Stations map registered at load',
      await eq(page, `_liveMaps.has('Stations') && !!_liveMaps.get('Stations')()`));

    await go('bitflipper');
    check('BitFlipper map registered when the tab builds it',
      await eq(page, `_liveMaps.has('BitFlipper') && !!_liveMaps.get('BitFlipper')()`));

    await go('network');
    check('NetworkView map registered when the tab builds it',
      await eq(page, `_liveMaps.has('NetworkView') && !!_liveMaps.get('NetworkView')()`));
    check('NetworkView teardown registered',
      await eq(page, `_tabTeardowns.has('NetworkView')`));

    await go('alert2');
    await page.evaluate(() => Alert2.loadSample());
    await sleep(SETTLE * 3);
    check('Alert2 map registered once a capture is decoded',
      await eq(page, `_liveMaps.has('Alert2') && !!_liveMaps.get('Alert2')()`));
    check('Alert2 teardown registered',
      await eq(page, `_tabTeardowns.has('Alert2')`));

    await go('arrodata');
    check('ArroData teardown registered',
      await eq(page, `_tabTeardowns.has('ArroData')`));

    await go('workbench');
    await page.evaluate(() => Workbench.loadExample());
    await sleep(SETTLE * 4);
    check('Workbench map registered once a case is analysed',
      await eq(page, `_liveMaps.has('Workbench') && !!_liveMaps.get('Workbench')()`));

    // The gesture the hardcoded list existed to serve. Spy on each live map's
    // invalidateSize, collapse the nav, and count: a map missing from the
    // registry is a map that silently does not get this call.
    console.log('\nRuntime — a nav collapse re-measures every live map\n');
    await go('stations');
    const nav = await page.evaluate(async () => {
      const maps = liveMaps();
      let calls = 0;
      const undo = maps.map(m => {
        const orig = m.invalidateSize.bind(m);
        m.invalidateSize = function (...a) { calls++; return orig(...a); };
        return () => { delete m.invalidateSize; };
      });
      setNavCollapsed(true);
      await new Promise(r => setTimeout(r, 800));
      undo.forEach(f => f());
      setNavCollapsed(false);
      return { maps: maps.length, calls };
    });
    // Three, not five: Network View and ALERT2 take their maps down when the
    // tab is left, so what is live here is Stations, Bit Flipper and Workbench
    // — the three that build a map and register no teardown. That is
    // pre-existing behaviour, unchanged by #142 and the same set the hardcoded
    // list re-measured; the assertion is that *every* live one gets the call.
    check('every live map re-measured on nav collapse',
      nav.maps >= 3 && nav.calls === nav.maps,
      `${nav.calls} invalidateSize() call(s) across ${nav.maps} live map(s)`);
    await sleep(SETTLE);

    // Leaving a tab has to stop what it started — the half no smoke test that
    // only opens tabs can see.
    console.log('\nRuntime — leaving a tab stops what it started\n');
    await go('network');
    const nvUp = await eq(page, `!!state.nvMap`);
    await go('stations');
    check('NetworkView map torn down on leave',
      nvUp && await eq(page, `state.nvMap === null`));

    await go('alert2');
    await page.evaluate(() => Alert2.loadSample());
    await sleep(SETTLE * 3);
    const a2Up = await eq(page, `!!state.a2.map`);
    await go('stations');
    check('Alert2 coverage map torn down on leave',
      a2Up && await eq(page, `state.a2.map === null`));

    const fired = await page.evaluate(`(() => {
      const seen = [], saved = new Map();
      _tabTeardowns.forEach((fn, name) => { saved.set(name, fn); _tabTeardowns.set(name, () => { seen.push(name); fn(); }); });
      switchTab('stations');
      saved.forEach((fn, name) => _tabTeardowns.set(name, fn));
      return { seen, size: saved.size };
    })()`);
    check('switchTab runs every registered teardown, not a chosen few',
      fired.seen.length === fired.size && fired.size >= 3,
      `${fired.seen.join(', ')} (${fired.size} registered)`);

    // One module's bad day must not leave the app half-switched.
    const boom = await page.evaluate(`(() => {
      registerTabTeardown('BoomTest', () => { throw new Error('deliberate'); });
      switchTab('bitflipper');
      const after = state.activeTab;
      _tabTeardowns.delete('BoomTest');
      return { after, logged: _errorLog.some(e => e.kind === 'teardown' && /BoomTest/.test(e.message)) };
    })()`);
    check('a throwing teardown does not take the tab switch with it',
      boom.after === 'bitflipper', `landed on ${boom.after}`);
    check('and lands in the error log, so a bug report carries it', boom.logged);

    // Registration runs on every render of its tab, so it has to be repeatable.
    const stack = await page.evaluate(`(async () => {
      const n0 = _tabTeardowns.size, m0 = _liveMaps.size;
      for (let i = 0; i < 3; i++) {
        switchTab('network'); await new Promise(r => setTimeout(r, 500));
        switchTab('stations'); await new Promise(r => setTimeout(r, 300));
      }
      return { n0, m0, n1: _tabTeardowns.size, m1: _liveMaps.size };
    })()`);
    check('re-entering a tab replaces its entry rather than stacking another',
      stack.n0 === stack.n1 && stack.m0 === stack.m1,
      `teardowns ${stack.n0}→${stack.n1}, maps ${stack.m0}→${stack.m1}`);

    if (errors.length) check('no uncaught page errors', false, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
}

staticPhase();
await runtimePhase();

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
console.log('');
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}:\n`);
  for (const f of failed) console.log(`  ${f.name}`);
  console.log('\n  A module that builds a Leaflet map must call registerLiveMap() where it');
  console.log('  builds it, and one with a loop, an observer or a map to shut down must call');
  console.log('  registerTabTeardown() from its init(). Both live in core.js. See #142.\n');
  process.exit(1);
}
console.log('PASS — every live map and every teardown is registered by its own file.');
