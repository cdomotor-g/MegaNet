// Exercising the controls inside a tab, rather than only opening it (#135).
//
// The smoke test opens all seventeen tabs and asserts nothing threw. That catches
// a module that failed to load and a render path that blew up, and it is blind
// to the failure M4 risks: an inline `on*=` attribute naming an identifier that
// no longer resolves. Those attributes are evaluated by the browser against the
// **global** scope, at click time — so pulling a function inside an IIFE breaks
// its button silently. `node --check` cannot see it, the duplicate-name check
// cannot see it, and a page-load smoke test cannot see it either, because
// nothing has been clicked.
//
// Two checks here, and they are complementary rather than redundant:
//
//   auditHandlers()     reads every on*= attribute the tab rendered, extracts
//                       the callee path out of each, and asks the page whether
//                       it resolves to a function. Exhaustive over whatever is
//                       on screen and costs one evaluate() per tab, so it runs
//                       on all sixteen. It proves the name is *reachable*.
//
//   exerciseSurface()   actually clicks. #135 asks for this in those words —
//                       "then verify by clicking, not by reading" — and it is
//                       the stronger check, because it also runs the function
//                       body and whatever re-render follows it.
//
// The click list is keyed by the handler each control names, not by a CSS class
// or a button label. That is deliberate: it makes the test a direct statement
// about a module's public surface — every member that exists to be named by an
// on*= attribute has an entry here — and it reports which members it never
// managed to reach, so a control that quietly stopped rendering is visible
// rather than silently skipped.

// Roots that appear in handler attributes and are not app globals: the DOM's own
// bindings, and the standard library. Everything else must resolve.
const AMBIENT = new Set([
  'this', 'event', 'window', 'document', 'console', 'location', 'history',
  'navigator', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'return', 'if', 'else',
  'for', 'while', 'switch', 'typeof', 'new', 'delete', 'void', 'function',
]);

/**
 * Every on*= attribute currently in the document, reduced to the callee paths
 * inside it, with each path resolved in page scope.
 *
 * Returns { total, checked, unresolved: [{ path, attr, value, where }] }.
 */
export async function auditHandlers(page) {
  return page.evaluate(ambient => {
    const out = { total: 0, checked: 0, unresolved: [] };
    const seen = new Set();

    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (!/^on[a-z]+$/.test(a.name)) continue;
        out.total++;
        // Callee paths: `Foo.bar(`, `baz(`. A leading `new` or a keyword is
        // filtered by the ambient list rather than by parsing — this is a
        // reachability check, not a JS parser, and a false *pass* here is
        // caught by the click phase.
        //
        // String literals are blanked out first, or a station called
        // "Fitzroy River (Qld)" sitting in a handler argument reads as a call
        // to River(). Same length, so the offsets still line up.
        const code = a.value.replace(/'[^']*'|"[^"]*"/g, s => "'" + ' '.repeat(s.length - 2) + "'");
        for (const m of code.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
          const path = m[1];
          const root = path.split('.')[0];
          if (ambient.includes(root)) continue;
          // A method call on whatever the previous expression returned —
          // `document.getElementById(…).click()`. There is no name to resolve
          // here, only a property on a value this check never evaluates.
          if (/[)\].]/.test(code[m.index - 1] || '')) continue;
          const key = `${a.name}|${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.checked++;
          let ok = false;
          try {
            ok = typeof (0, eval)(path) === 'function';
          } catch {
            ok = false;
          }
          if (!ok) {
            out.unresolved.push({
              path,
              attr: a.name,
              value: a.value.slice(0, 90),
              where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
            });
          }
        }
      }
    }
    return out;
  }, [...AMBIENT]);
}

// ── the click script ──────────────────────────────────────────────────────────
//
// One entry per member of RfChanges' and Workbench's public surface that exists
// to be named by an on*= attribute — 8 and 18 of them, which is the whole set
// M4 had to rewrite. Order matters and is the order a person would work in:
// nothing is on screen in the Workbench until a case exists, so `loadExample`
// comes first and `clearCase` comes last; the two controls that navigate to
// another tab come just before it, since they need the case too.
//
//   how      'click'  — press it. A checkbox toggles and fires onchange, which
//                       is why there is no separate 'check' mode: setChecked()
//                       verifies the box afterwards, and half these handlers
//                       re-render the panel out from under it.
//            'fill'   — type into it (fires oninput)
//            'select' — choose the first real option (fires onchange)
//   value    for 'fill'
//   prep     { selector, value } typed into another field first, for a control
//            that does nothing until its input has something in it
//   needs    a member that must have fired first for this one to be on screen
//   soft     true if the control legitimately may not render — reported as
//            "not reached" rather than failed
//
// A control with no entry is a control this test does not press. Adding a
// member to either surface without adding it here leaves it unexercised, and
// the coverage line at the end of the run is what says so.

// Twelve days that sit flat and then jump — the shape the rolling-median
// detector in rfcDetectSteps() exists to find. Dates are fixed rather than
// relative to today so a failure reproduces a year from now.
function corrSeriesWithAStep() {
  const flat = [0, 1, 0, 0, 1, 0], high = [20, 22, 19, 21, 20, 23];
  return [...flat, ...high]
    .map((v, i) => `Test Ck, 2026-04-${String(i + 1).padStart(2, '0')}, ${v}`)
    .join('\n');
}

export const CONTROL_SCRIPT = {
  rfchanges: [
    { member: 'RfChanges.selectAllAnchors', how: 'click',  note: 'select every repeater' },
    { member: 'RfChanges.toggleAnchor',     how: 'click',  note: 'one repeater on/off' },
    { member: 'RfChanges.sort',             how: 'click',  note: 'table header' },
    // The step detector reports nothing until it is given a series, and the
    // "use this date as the onset" buttons only exist once it has found a step
    // — so paste twelve days that step from 0 to 20 and it finds one. Twelve
    // points because rfcDetectSteps needs n ≥ 2k and k floors at 3.
    { member: 'RfChanges.analyseCorr', how: 'click', note: 'onset step detector',
      prep: { selector: '#rfc-corr', value: corrSeriesWithAStep() } },
    { member: 'RfChanges.useOnset',    how: 'click', note: 'adopt a detected step',
      needs: 'RfChanges.analyseCorr' },
    // Only rendered when two or more pasted series resolve to real stations
    // that share one repeater *and* that repeater is in the ACMA threat layer.
    // Too data-dependent to drive from a paste box without pinning the test to
    // whichever stations happen to be in stations.json this month.
    { member: 'RfChanges.focusAnchor',      how: 'click',  note: 'grouping panel', soft: true },
    { member: 'RfChanges.cardFor',          how: 'click',  note: 'open a transmitter card' },
    { member: 'RfChanges.exportCsv',        how: 'click',  note: 'download the table' },
  ],
  workbench: [
    { member: 'Workbench.loadExample',     how: 'click',  note: 'build a case to work with' },
    // Two characters minimum before the picker returns anything (wbPickResultsHtml),
    // so the query has to be a real one or addStation below has nothing to press.
    { member: 'Workbench.refreshPick',     how: 'fill',   value: 'creek', note: 'station search' },
    { member: 'Workbench.addStation',      how: 'click',  note: 'add a search result', needs: 'Workbench.refreshPick' },
    { member: 'Workbench.addFromPaste',    how: 'click',  note: 'add from the paste box' },
    { member: 'Workbench.swapId',          how: 'click',  note: 'affected ⇄ known-good' },
    { member: 'Workbench.removeId',        how: 'click',  note: 'drop a station chip' },
    { member: 'Workbench.openConcept',     how: 'click',  note: 'open the concept drawer' },
    { member: 'Workbench.closeDrawer',     how: 'click',  note: 'close it', needs: 'Workbench.openConcept' },
    { member: 'Workbench.saveCase',        how: 'click',  note: 'save to localStorage' },
    { member: 'Workbench.loadCase',        how: 'select', note: 'reload a saved case', needs: 'Workbench.saveCase' },
    { member: 'Workbench.shareLink',       how: 'click',  note: 'copy a #hash link' },
    { member: 'Workbench.deleteCase',      how: 'click',  note: 'delete the saved case', needs: 'Workbench.saveCase' },
    { member: 'Workbench.exportCsv',       how: 'click',  note: 'download the case' },
    { member: 'Workbench.exportChecklist', how: 'click',  note: 'download the site-visit checklist' },
    { member: 'Workbench.exportComplaint', how: 'click',  note: 'download the ACMA draft' },
    // Both of these leave the tab, so they run last and hand it back.
    { member: 'Workbench.openBf',  how: 'click', note: '→ Bit Flipper', soft: true, returnsTo: 'workbench' },
    { member: 'Workbench.openRfc', how: 'click', note: '→ RF Changes',  soft: true, returnsTo: 'workbench' },
    { member: 'Workbench.clearCase',       how: 'click',  note: 'wipe the case' },
  ],
};

// The attribute selector for "an element whose on*= handler calls this member".
// Handlers are written `onclick="Workbench.saveCase()"` and
// `oninput="state.wb.pickQuery=this.value;Workbench.refreshPick()"`, so the
// member can be anywhere in the value — *= rather than ^=.
const selectorFor = member =>
  ['onclick', 'onchange', 'oninput', 'onkeydown', 'onsubmit', 'onblur']
    .map(a => `[${a}*="${member}("]`).join(',');

/**
 * Work through one tab's control script. `settle` is awaited after each
 * interaction so a re-render or an async fetch lands inside the window the
 * caller is watching for errors.
 *
 * Returns { fired: [...], missing: [...], failed: [{member, reason}] }.
 */
export async function exerciseSurface(page, tabId, { settle, drain, log }) {
  const script = CONTROL_SCRIPT[tabId] || [];
  const fired = [], missing = [], failed = [];

  for (const step of script) {
    if (step.needs && !fired.includes(step.needs)) {
      missing.push(`${step.member} (needs ${step.needs}, which never fired)`);
      continue;
    }

    const sel = selectorFor(step.member);
    let el;
    try {
      if (step.prep) {
        const field = page.locator(step.prep.selector).first();
        if (!(await field.count())) {
          failed.push({ member: step.member, reason: `its input ${step.prep.selector} is not on `
            + `the ${tabId} tab, so the control could not be put in a state where it does anything` });
          continue;
        }
        await field.fill(step.prep.value);
      }
      el = await page.locator(sel).first();
      if (!(await el.count())) {
        (step.soft ? missing : failed).push(step.soft
          ? `${step.member} — no control on screen names it (${step.note})`
          : { member: step.member, reason: `no element on the ${tabId} tab has an on*= handler `
              + `calling ${step.member}(. Either the control stopped rendering, or the handler `
              + `string was renamed without updating this script.` });
        continue;
      }

      // scrollIntoView + force: the point is to fire the handler, not to prove
      // the control is hittable — layout is #107's problem, not M4's.
      switch (step.how) {
        case 'fill':   await el.fill(step.value ?? 'a'); break;
        case 'select': {
          const opts = await el.locator('option').all();
          let picked = false;
          for (const o of opts) {
            const v = await o.getAttribute('value');
            if (v) { await el.selectOption(v); picked = true; break; }
          }
          if (!picked) { missing.push(`${step.member} — the select had no real option`); continue; }
          break;
        }
        default:       await el.click({ force: true, timeout: 5000 });
      }
      fired.push(step.member);
      await settle();

      if (step.returnsTo) {
        await page.evaluate(t => switchTab(t), step.returnsTo);
        await settle();
      }
    } catch (err) {
      failed.push({ member: step.member, reason: `${step.how} threw: ${err.message.split('\n')[0]}` });
      continue;
    }

    // Anything the handler threw is on the shared error buffer; attribute it to
    // this control rather than to whatever is clicked next.
    const errs = drain();
    if (errs.length) {
      failed.push({ member: step.member, reason: errs.map(e => `[${e.kind}] ${e.text.split('\n')[0]}`).join('; ') });
    } else {
      log(`      · ${step.member} — ${step.note}`);
    }
  }

  return { fired, missing, failed, total: script.length };
}
