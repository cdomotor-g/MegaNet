// M0 — the headless smoke test (#130), extended by M4 (#135).
//
// Loads index.html in a real Chromium, waits for a real stations.json, then
// opens all sixteen tabs one at a time and asserts that nothing threw. Since
// M4 it also audits every rendered on*= handler for a name that no longer
// resolves, and clicks its way through the RF Changes and Interference
// Workbench controls — see lib/controls.mjs for why those two checks exist and
// why opening a tab was never going to be enough.
//
// What it is for: the front end has no other mechanical net. `node --check`
// proves the braces balance and nothing else — it cannot see a helper that
// moved out of scope, a namespace that lost a member, or an `onclick` naming an
// identifier that no longer resolves. Those are precisely the failures the
// app.js decomposition (#129) risks introducing, and precisely the failures the
// two live TDZ crashes in #131 already are.
//
// The single most important line in this file is the `pageerror` handler. An
// uncaught ReferenceError during script evaluation never reaches
// `console.error`; it surfaces as `pageerror`. A test watching only the console
// would miss the whole class of bug this exists to catch.
//
// Run:  npm run smoke          (from test/)
//       npm run smoke -- -v    to see every tab and every blocked request

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers, exerciseSurface, CONTROL_SCRIPT } from './lib/controls.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
// Long enough for a tab's own async work — a fetch that has to be refused, a
// Leaflet map settling — to land inside the window we are watching for errors,
// rather than after we stopped looking and while the next tab is blamed for it.
const TAB_SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 400);

// Aborting every off-origin request is this test's network policy, not a fault
// in the app (see lib/network.mjs). Chromium reports each one on the console;
// those are the only console errors that are ever ignored, and `pageerror`
// never is.
const RESOURCE_NOISE = [
  /^Failed to load resource/i,
  /net::ERR_BLOCKED_BY_CLIENT/i,
  /net::ERR_FAILED/i,
];
const isResourceNoise = text => RESOURCE_NOISE.some(re => re.test(text));

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const failures = [];

  try {
    // acceptDownloads: several of the controls the click phase presses end in
    // dlText() — a blob and a synthetic anchor click. Left unaccepted, Chromium
    // cancels the navigation and the run is noisier for no reason.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const { blocked } = await applyNetworkPolicy(page, server.origin);

    // One buffer, drained around each step, so a message is attributed to the
    // tab that was open when it arrived.
    let errors = [];
    page.on('pageerror', e => errors.push({ kind: 'pageerror', text: e.stack || e.message }));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (isResourceNoise(text)) return;
      const loc = m.location();
      const where = loc && loc.url ? ` (${loc.url.replace(server.origin, '')}:${loc.lineNumber})` : '';
      errors.push({ kind: 'console.error', text: text + where });
    });
    // Nothing in this app should ever open a dialog unprompted. If something
    // does, an unhandled dialog would block the run until it timed out.
    page.on('dialog', async d => {
      errors.push({ kind: 'dialog', text: `${d.type()}: ${d.message()}` });
      await d.dismiss().catch(() => {});
    });

    const drain = () => { const e = errors; errors = []; return e; };
    const check = (label, extra = []) => {
      const found = [...drain(), ...extra];
      if (found.length) {
        failures.push({ label, found });
        log(`  ✗ ${label}`);
        for (const f of found) log(`      [${f.kind}] ${f.text.split('\n')[0]}`);
      } else {
        log(`  ✓ ${label}`);
      }
    };

    // ── Load ──────────────────────────────────────────────────────────────
    log(`\nLoading ${server.url()}`);
    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });

    // autoLoad() is async and runs the datastore → bundled → GitHub chain. With
    // everything off-origin refused, the bundled stations.json on loopback is
    // what wins. Waiting on the *data* rather than on a timeout is what makes
    // the run deterministic.
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT },
    ).catch(() => {
      failures.push({ label: 'initial load', found: [{
        kind: 'fatal',
        text: 'stations.json never reached state.data — every data-backed tab would render the '
            + 'empty state, so the run would prove nothing. Check that stations.json is committed '
            + 'and that the static server is serving it.',
      }] });
    });
    check('initial load — clean console');

    const boot = await page.evaluate(() => ({
      version:  typeof APP_VERSION !== 'undefined' ? APP_VERSION : null,
      stations: (typeof state !== 'undefined' && state.data && state.data.stations || []).length,
      source:   (typeof state !== 'undefined' && state.dataSource && state.dataSource.kind) || null,
      tabs:     typeof TAB_LIST !== 'undefined' ? TAB_LIST.map(t => t.id) : [],
      helpKeys: typeof HELP !== 'undefined' ? Object.keys(HELP) : [],
      leaflet:  typeof L !== 'undefined' && !!L.map,
    }));

    log(`  · ${boot.stations} stations from ${boot.source}, app version ${boot.version}`);

    // `document.currentScript` is how APP_VERSION reads the `?v=` off its own
    // tag (app.js:440). If a split ever loses that, every bug report says 'dev'
    // — a quiet failure worth one loud assertion. See #129's cache-buster note.
    check('APP_VERSION resolved from the script tag', boot.version && boot.version !== 'dev' ? []
      : [{ kind: 'assert', text: `APP_VERSION is ${JSON.stringify(boot.version)} — index.html's `
          + `?v= cache-buster is not reaching it` }]);

    check('Leaflet available', boot.leaflet ? []
      : [{ kind: 'assert', text: 'L.map is not defined — the vendored Leaflet did not load' }]);

    // ── The tab registry ─────────────────────────────────────────────────
    // #130 asks for the count to be asserted, so that a tab added to TABS
    // without a renderMain() case fails here rather than in front of a user.
    const EXPECTED_TABS = 16;
    check(`TABS holds ${EXPECTED_TABS} tabs`, boot.tabs.length === EXPECTED_TABS ? []
      : [{ kind: 'assert', text: `TABS holds ${boot.tabs.length} tabs, expected ${EXPECTED_TABS}. `
          + `If a tab was added on purpose: give it a renderMain() case, a HELP entry, and bump `
          + `EXPECTED_TABS here. Tabs: ${boot.tabs.join(', ')}` }]);

    const missingHelp = boot.tabs.filter(id => !boot.helpKeys.includes(id));
    check('every tab has a HELP entry', missingHelp.length === 0 ? []
      : [{ kind: 'assert', text: `no HELP entry for: ${missingHelp.join(', ')} — the help rail `
          + `would be blank on those tabs` }]);

    // ── Every tab ────────────────────────────────────────────────────────
    const handlerTotals = { total: 0, checked: 0 };
    log('\nOpening every tab:');
    for (const id of boot.tabs) {
      const extra = [];
      try {
        await page.evaluate(tab => switchTab(tab), id);
        await page.waitForTimeout(TAB_SETTLE);

        const seen = await page.evaluate(() => {
          const el = document.getElementById('main-content');
          const html = el ? el.innerHTML : '';
          return {
            active:  typeof state !== 'undefined' ? state.activeTab : null,
            length:  html.length,
            unknown: html.includes('Unknown tab'),
            // renderEmpty() is what a data-backed tab shows with no file
            // loaded. Reaching it here means the load silently regressed.
            empty:   /class="empty|No station data|Load stations\.json/i.test(html),
          };
        });

        if (seen.active !== id) {
          extra.push({ kind: 'assert', text: `switchTab('${id}') left state.activeTab as '${seen.active}'` });
        }
        if (seen.unknown) {
          extra.push({ kind: 'assert', text: `renderMain() has no case for '${id}' — it fell through `
            + `to the "Unknown tab" default. A tab in TABS with no case in the switch (app.js:2572) `
            + `is a dead entry in the nav.` });
        }
        if (seen.empty) {
          extra.push({ kind: 'assert', text: `'${id}' rendered the empty state despite stations.json `
            + `being loaded` });
        }
        if (seen.length < 50) {
          extra.push({ kind: 'assert', text: `'${id}' rendered ${seen.length} chars of content — `
            + `effectively nothing` });
        }

        // Every on*= attribute this tab rendered, resolved against page scope.
        // A handler naming a function that has moved inside an IIFE resolves to
        // nothing and throws a ReferenceError at click time — which is the
        // failure M4 (#135) was built around, and which opening the tab cannot
        // see. See lib/controls.mjs.
        const audit = await auditHandlers(page);
        handlerTotals.total += audit.total;
        handlerTotals.checked += audit.checked;
        for (const u of audit.unresolved) {
          extra.push({ kind: 'handler', text: `${u.attr}="${u.value}" on <${u.where}> calls `
            + `${u.path}(), which does not resolve to a function. It would throw at click time, `
            + `not at load — nothing else in this harness can see it.` });
        }
      } catch (err) {
        extra.push({ kind: 'throw', text: `switchTab('${id}') threw: ${err.message}` });
      }
      check(`tab: ${id}`, extra);
    }
    log(`  · ${handlerTotals.checked} distinct handler call(s) across ${handlerTotals.total} on*= `
      + `attribute(s) all resolve`);

    // ── Clicking, not reading ────────────────────────────────────────────
    // M4 (#135) pulled 111 top-level names inside two IIFEs. Twenty-six of them
    // were reachable only from an inline on*= attribute, which resolves against
    // the global scope at click time — so for those twenty-six, the wrap is
    // exactly as safe as the rewrite of the template string naming them, and
    // nothing that does not press the button can tell you whether it worked.
    // The audit above proves each name resolves; this proves the control still
    // does its job.
    log('\nExercising controls (the on*= handlers, pressed):');
    for (const tabId of Object.keys(CONTROL_SCRIPT)) {
      await page.evaluate(t => switchTab(t), tabId);
      // A longer settle than the tab loop uses: RF Changes fetches its timeline
      // on init and the Workbench pulls ACMA detail once a case exists, and a
      // control clicked before the panel holding it has rendered is a control
      // this test silently failed to press.
      await page.waitForTimeout(TAB_SETTLE * 4);
      drain();   // whatever the render produced is the tab loop's business

      const settle = () => page.waitForTimeout(TAB_SETTLE);
      const res = await exerciseSurface(page, tabId, { settle, drain, log });

      const extra = res.failed.map(f => ({ kind: 'control', text: `${f.member}: ${f.reason}` }));
      for (const m of res.missing) log(`      ~ not reached: ${m}`);
      check(`controls: ${tabId} — ${res.fired.length}/${res.total} fired`, extra);
    }

    // Returning to the first tab exercises the teardown side of switchTab()
    // (NetworkView.stop / ArroData.stop / Alert2.stop) with every module having
    // been initialised at least once — which is when a stale observer or a
    // detached Leaflet map actually shows up.
    await page.evaluate(() => switchTab(TAB_LIST[0].id));
    await page.waitForTimeout(TAB_SETTLE);
    check('return to the first tab');

    if (VERBOSE && blocked.length) {
      const hosts = [...new Set(blocked.map(u => { try { return new URL(u).host; } catch { return u; } }))];
      log(`\nBlocked off-origin hosts (by policy): ${hosts.join(', ')}`);
    }

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }

  log('');
  if (failures.length) {
    log(`FAIL — ${failures.length} step(s) with errors:\n`);
    for (const { label, found } of failures) {
      log(`  ${label}`);
      for (const f of found) log(`    [${f.kind}] ${f.text}`);
      log('');
    }
    process.exitCode = 1;
    return;
  }
  log('PASS — every tab rendered with a clean console.');
}

await main().catch(err => {
  console.error('\nSmoke test could not run:\n', err);
  process.exitCode = 1;
});
