// The app asks and tells in its own words (#223: modal.js's confirmDialog and
// promptDialog, toast.js's Toast, and core.js's TAB_NEEDS), where it used to
// stop the page with the browser's alert(), confirm() and prompt().
//
//   1. **None left** — every script index.html loads, parsed, calls none of
//      the three: not bare, not through window, self or globalThis, and not
//      from an inline handler written into a string.
//   2. **A question** — confirmDialog: an alertdialog named by its question and
//      described by what follows; its buttons named for what they do; a
//      dangerous one starts on the way out; Escape, ×, the backdrop and a
//      question asked over it are all "no"; focus goes back where it was; Tab
//      stays inside; a tick inside it rides on the answer. Asked over an open
//      dialog it leaves that dialog standing, and no key gets past it to a
//      listener underneath — the photo viewer's Escape and arrows are on the
//      document, and an Escape for the question must not close the viewer.
//   3. **A line of text** — promptDialog: the box focused, the button off
//      while it is blank, Enter answers, Cancel is null.
//   4. **A toast** — said once, through the app's live region; "done" goes by
//      itself and waits while it is pointed at; "failed" stays until it is
//      dismissed; three at most.
//   5. **Where they are used** — the map's drawings (Remove all; a text note
//      from a click on the map), the map's reset, a station list that will not
//      load, the bug reporter's own line, and the Workbench's case name.
//   6. **A browser that cannot run a tab** — with no Web Serial the nav marks
//      the Serial Monitor, in its tooltip and its accessible name as well as
//      the mark, and the tab says why on arrival; with it, nothing is marked.
//
// And throughout: no native dialog opens at all — one would fail the run.
//
// Run:  npm run dialogs
//       npm run dialogs -- -v

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { localScripts } from './lib/app-scripts.mjs';
import { REPO_ROOT } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { answer } from './lib/ask.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// ── 1. Static ──────────────────────────────────────────────────────────────────
const NATIVE = new Set(['alert', 'confirm', 'prompt']);
const GLOBALS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit); }
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}

// A call whose callee is one of the three: alert(…), window.confirm(…),
// globalThis['prompt'](…). A local function may not take one of the names
// either — a reader cannot tell it from the browser's, and nor can this.
function nativeName(callee) {
  if (callee.type === 'Identifier' && NATIVE.has(callee.name)) return callee.name;
  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && GLOBALS.has(callee.object.name)) {
    const p = callee.computed ? (callee.property.type === 'Literal' ? callee.property.value : null) : callee.property.name;
    if (NATIVE.has(p)) return `${callee.object.name}.${p}`;
  }
  return null;
}

function staticScan() {
  const found = [];
  let calls = 0, files = 0;
  for (const s of localScripts()) {
    files++;
    const src = fs.readFileSync(s.path, 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    walk(ast, node => {
      if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
      calls++;
      const n = nativeName(node.callee);
      if (n) found.push(`${path.relative(REPO_ROOT, s.path)}:${node.loc.start.line} ${n}()`);
    });
    // Markup written as a string — onclick="return confirm('…')" — is code the
    // parser above sees only as text.
    for (const t of acorn.tokenizer(src, { ecmaVersion: 'latest', allowHashBang: true, locations: true })) {
      if (t.type !== acorn.tokTypes.string && t.type !== acorn.tokTypes.template) continue;
      const text = String(t.value || '');
      const m = text.match(/\bon[a-z]+\s*=\s*\\?["'][^"']*?\b(alert|confirm|prompt)\s*\(/i);
      if (m) found.push(`${path.relative(REPO_ROOT, s.path)}:${t.loc ? t.loc.start.line : '?'} ${m[1]}() in an inline handler`);
    }
  }
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/\bon[a-z]+\s*=\s*["'][^"']*?\b(alert|confirm|prompt)\s*\(/gi)) found.push(`index.html: ${m[1]}() in an inline handler`);
  return { found, calls, files };
}

// ── Browser ────────────────────────────────────────────────────────────────────
const asked = page => page.evaluate(() => {
  const card = document.querySelector('#app-ask .modal-card');
  if (!card) return null;
  const desc = card.getAttribute('aria-describedby');
  return {
    role: card.getAttribute('role'),
    modal: card.getAttribute('aria-modal'),
    labelled: (document.getElementById(card.getAttribute('aria-labelledby')) || {}).textContent || '',
    described: desc ? ((document.getElementById(desc) || {}).textContent || '').replace(/\s+/g, ' ').trim() : '',
    paras: card.querySelectorAll('.ask-text p').length,
    buttons: [...card.querySelectorAll('.modal-foot button')].map(b => b.textContent.trim()),
    danger: !!card.querySelector('[data-ask="yes"].btn-danger'),
    focused: document.activeElement && (document.activeElement.dataset.ask || document.activeElement.id || document.activeElement.className),
  };
});

async function open(browser, server, natives, errors, { url = '/index.html?tab=stations', init = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', async d => { natives.push(`${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
  await page.goto(server.url(url), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  return { context, page };
}

async function main() {
  // ═════════════════════════════════════════════════════════════════════════
  log('\n1. None left\n');
  const S = staticScan();
  check(`no script index.html loads calls alert(), confirm() or prompt() (${S.calls} calls in ${S.files} files read)`,
    S.found.length === 0 && S.files > 100, S.found.join('; '));

  const server = await startServer();
  const browser = await launchBrowser();
  const natives = [], errors = [];
  try {
    const { context, page } = await open(browser, server, natives, errors);
    await page.waitForFunction(() => !!state.data && !!state.map, null, { timeout: LOAD_TIMEOUT });

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. A question\n');
    const ask = (opts) => page.evaluate(o => {
      window.__ans = 'pending';
      confirmDialog(o).then(v => { window.__ans = v; });
    }, opts);
    const ans = () => page.waitForFunction(() => window.__ans !== 'pending', null, { timeout: 5_000 })
      .then(() => page.evaluate(() => window.__ans), () => 'still pending');

    // The shell's own first dialog first: before anything else has opened
    // one, Escape hands focus back to the button that opened it.
    await page.click('#btn-theme');
    await page.keyboard.press('Escape');
    const firstBack = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('the first dialog the shell ever opens hands focus back to what opened it', firstBack === 'btn-theme', J(firstBack));

    await page.focus('#btn-theme');
    await ask({ title: 'Delete “Gatton”?', message: 'It is removed from the list.\n\nThe record is kept.', confirm: 'Delete the station', danger: true });
    let A = await asked(page);
    check('an alertdialog, modal, named by its question and described by what follows, in paragraphs',
      A && A.role === 'alertdialog' && A.modal === 'true' && A.labelled === 'Delete “Gatton”?'
        && A.described === 'It is removed from the list. The record is kept.' && A.paras === 2, J(A));
    check('its buttons say what they do, the one that acts drawn as dangerous', A && J(A.buttons) === J(['Cancel', 'Delete the station']) && A.danger, J(A));
    check('…and a dangerous question starts on the way out', A && A.focused === 'no', J(A));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement.closest('#app-ask'));
    check('Tab stays inside it', inside);
    await page.keyboard.press('Escape');
    let v = await ans();
    const back = await page.evaluate(() => ({ gone: !document.querySelector('#app-ask .modal-card'), focus: document.activeElement && document.activeElement.id }));
    check('Escape is "no", it goes, and focus is back where it was', v === false && back.gone && back.focus === 'btn-theme', J({ v, back }));

    await ask({ title: 'Upload the table?', confirm: 'Upload the table' });
    A = await asked(page);
    check('a question that is not dangerous starts on its answer, and has nothing to describe it with when nothing follows',
      A && A.focused === 'yes' && !A.danger && A.described === '' , J(A));
    await page.keyboard.press('Enter');
    v = await ans();
    check('…and Enter on it is "yes"', v === true, J(v));

    await ask({ title: 'One?', confirm: 'Go' });
    await page.mouse.click(8, 8);
    check('the backdrop is "no"', (await ans()) === false);
    await ask({ title: 'Two?', confirm: 'Go' });
    await page.click('#app-ask .modal-x');
    check('× is "no"', (await ans()) === false);

    await page.evaluate(() => {
      window.__first = 'pending';
      confirmDialog({ title: 'First?', confirm: 'Go' }).then(x => { window.__first = x; });
    });
    await ask({ title: 'Second?', confirm: 'Go' });
    const first = await page.evaluate(() => window.__first);
    const second = await asked(page);
    check('a question asked over another answers the first "no", and is the one on screen', first === false && second && second.labelled === 'Second?', J({ first, second }));
    await page.keyboard.press('Escape');
    await ans();

    await ask({ title: 'Delete it?', message: 'Gone.', confirm: 'Delete', danger: true,
                checkbox: { label: 'Also remove its allowlist entry' } });
    await page.check('#app-ask-check');
    await page.click('#app-ask [data-ask="yes"]');
    const ticked = await ans();
    await ask({ title: 'Delete it?', confirm: 'Delete', checkbox: { label: 'Also…' } });
    await page.click('#app-ask [data-ask="yes"]');
    const unticked = await ans();
    await ask({ title: 'Delete it?', confirm: 'Delete', checkbox: { label: 'Also…' } });
    await page.keyboard.press('Escape');
    const declined = await ans();
    check('a tick inside a question rides on the answer: { checked } for yes, false for no',
      J(ticked) === J({ checked: true }) && J(unticked) === J({ checked: false }) && declined === false, J({ ticked, unticked, declined }));

    // Over an open dialog, with a listener on the document the way the photo
    // viewer has one.
    await page.evaluate(() => {
      window.__keys = [];
      window.__docKey = e => window.__keys.push(e.key);
      document.addEventListener('keydown', window.__docKey, true);
      openThemeMenu();
    });
    await ask({ title: 'Over the menu?', confirm: 'Go', danger: true });
    const stack = await page.evaluate(() => ({ menu: !!document.getElementById('theme-pick'), ask: !!document.querySelector('#app-ask .modal-card') }));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    v = await ans();
    const after = await page.evaluate(() => ({
      menu: !!document.getElementById('theme-pick'),
      keys: window.__keys.slice(),
      focusInMenu: !!(document.activeElement && document.activeElement.closest('#app-modal')),
    }));
    check('asked over an open dialog, the dialog stays standing underneath', stack.menu && stack.ask, J(stack));
    check('…its Escape closes only the question, and focus goes back into the dialog', v === false && after.menu && after.focusInMenu, J({ v, after }));
    check('…and no key got past it to a listener on the document', after.keys.length === 0, J(after.keys));
    await ask({ title: 'And if the dialog goes?', confirm: 'Go' });
    await page.evaluate(() => Modal.close());
    v = await ans();
    check('closing the dialog a question is over answers the question "no"', v === false
      && await page.evaluate(() => !document.querySelector('#app-ask .modal-card') && !document.getElementById('theme-pick')), J(v));
    await page.evaluate(() => document.removeEventListener('keydown', window.__docKey, true));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. A line of text\n');
    await page.evaluate(() => { window.__ans = 'pending'; promptDialog({ title: 'Add a note', label: 'Text', confirm: 'Add the note' }).then(x => { window.__ans = x; }); });
    let P = await page.evaluate(() => ({
      focus: document.activeElement && document.activeElement.id,
      off: document.querySelector('#app-ask [data-ask="yes"]').disabled,
      role: document.querySelector('#app-ask .modal-card').getAttribute('role'),
      label: document.querySelector('#app-ask label.ask-field').textContent.trim(),
    }));
    check('the box has the focus, labelled, and the button is off while it is blank', P.focus === 'app-ask-input' && P.off && P.role === 'dialog' && P.label === 'Text', J(P));
    await page.keyboard.press('Enter');
    check('…Enter in a blank box answers nothing', await page.evaluate(() => window.__ans === 'pending' && !!document.querySelector('#app-ask .modal-card')));
    await page.keyboard.type('Gauge hut');
    const on = await page.evaluate(() => !document.querySelector('#app-ask [data-ask="yes"]').disabled);
    await page.keyboard.press('Enter');
    v = await ans();
    check('typed, the button is on and Enter answers with the text', on && v === 'Gauge hut', J({ on, v }));
    await page.evaluate(() => { window.__ans = 'pending'; promptDialog({ title: 'Add a note', label: 'Text', value: 'kept?' }).then(x => { window.__ans = x; }); });
    await page.click('#app-ask [data-ask="no"]');
    check('Cancel is null', (await ans()) === null);

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. A toast\n');
    await page.evaluate(() => Toast.clear());
    await page.evaluate(() => Toast.done('Saved Gatton.'));
    const said = await page.waitForFunction(() => document.getElementById('app-status').textContent === 'Saved Gatton.', null, { timeout: 3_000 }).then(() => true, () => false);
    const T = await page.evaluate(() => {
      const t = document.querySelector('#toasts .toast');
      const host = document.getElementById('toasts');
      return { text: t && t.querySelector('.toast-text').textContent, kind: t && t.dataset.kind,
               live: host.getAttribute('aria-live') || host.getAttribute('role') || null };
    });
    check('it says what happened, on screen and once through the app\'s live region — not a second region of its own',
      T.text === 'Saved Gatton.' && T.kind === 'done' && said && T.live === null, J({ T, said }));
    await page.evaluate(() => { Toast.clear(); Toast.done('Goes by itself.'); Toast.failed('Could not save: HTTP 500'); });
    await page.waitForTimeout(5_600);
    const kept = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast-text')].map(e => e.textContent));
    check('"done" goes by itself; "failed" stays until it is dismissed', J(kept) === J(['Could not save: HTTP 500']), J(kept));
    await page.click('#toasts .toast-x');
    check('…and × dismisses it', await page.evaluate(() => !document.querySelector('#toasts .toast')));
    await page.evaluate(() => Toast.show('Pointed at.', { kind: 'done', ms: 400 }));
    await page.hover('#toasts .toast');
    await page.waitForTimeout(900);
    const held = await page.evaluate(() => !!document.querySelector('#toasts .toast'));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(900);
    const went = await page.evaluate(() => !document.querySelector('#toasts .toast'));
    check('a timed toast waits while it is pointed at, and goes once it is not', held && went, J({ held, went }));
    await page.evaluate(() => { ['one', 'two', 'three', 'four'].forEach(t => Toast.failed(t)); });
    const three = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast-text')].map(e => e.textContent));
    check('three at most, the oldest making way', J(three) === J(['two', 'three', 'four']), J(three));
    await page.evaluate(() => Toast.clear());

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. Where they are used\n');
    await page.evaluate(() => {
      MapDraw.addLine([[-27.50, 152.40], [-27.50, 152.50]], [null, null]);
      MapDraw.addLine([[-27.60, 152.40], [-27.60, 152.50]], [null, null]);
      MapDraw.clearAll();
    });
    let q = await answer(page, false);
    let n = await page.evaluate(() => state.draw.shapes.length);
    check('Remove all asks — "Remove all 2 drawings?", "Remove the drawings" — and "no" keeps them',
      q.title === 'Remove all 2 drawings?' && q.yes === 'Remove the drawings' && q.danger && n === 2, J({ q, n }));
    await page.evaluate(() => { resetStationsMap(); });
    q = await answer(page, false);
    n = await page.evaluate(() => state.draw.shapes.length);
    check('the map\'s reset asks about the drawings it would take, and "no" keeps them',
      q.title === 'Reset the map?' && /2 drawings/.test(q.text) && q.yes === 'Reset the map' && n === 2, J({ q, n }));
    await page.evaluate(() => { MapDraw.clearAll(); });
    await answer(page, true);
    n = await page.evaluate(() => state.draw.shapes.length);
    check('…and "yes" to Remove all removes them', n === 0, J(n));
    await page.evaluate(() => { MapDraw.addLine([[-27.50, 152.40], [-27.50, 152.50]], [null, null]); MapDraw.clearAll(); });
    const one = await page.evaluate(() => ({ n: state.draw.shapes.length, asking: !!document.querySelector('#app-ask .modal-card') }));
    check('one drawing goes without a question, before clearAll returns', one.n === 0 && !one.asking, J(one));

    // Out over the Coral Sea, where no station's marker can take the click.
    await page.evaluate(() => { state.map.setView([-26.2, 156.4], 9, { animate: false }); MapDraw.setTool('text'); });
    await page.waitForTimeout(150);
    const at = await page.evaluate(() => {
      const r = state.map.getContainer().getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
    });
    await page.mouse.click(at.x, at.y);
    q = await answer(page, true, { type: 'Gauge hut' });
    const note = await page.evaluate(() => state.draw.shapes.filter(s => s.kind === 'text').map(s => s.text));
    check('the Text tool asks for its note in the app\'s own box, and a click on the map with an answer puts it there',
      q.title === 'Add a note to the map' && q.yes === 'Add the note' && J(note) === J(['Gauge hut']), J({ q, note }));
    await page.evaluate(() => { MapDraw.setTool(''); state.draw.shapes = []; MapDraw.render(); MapDraw.rerenderPanel(); });

    await page.evaluate(() => { loadFromGitHub(); });
    const failed = await page.waitForFunction(() => {
      const t = document.querySelector('#toasts .toast--failed .toast-text');
      return t && t.textContent;
    }, null, { timeout: 15_000 }).then(h => h.jsonValue(), () => null);
    check('a station list that will not load says so, and from where, as a failure that stays', /^Could not load stations\.json \(GitHub\): /.test(failed || ''), String(failed));
    await page.evaluate(() => Toast.clear());

    await page.evaluate(() => BugReport.open());
    await page.click('#bugreport-modal button.primary');
    const B = await page.evaluate(() => {
      const m = document.getElementById('br-msg');
      const ta = document.getElementById('br-desc');
      return { shown: m && !m.hidden, text: m && m.textContent, invalid: ta.getAttribute('aria-invalid'),
               described: ta.getAttribute('aria-describedby'), focus: document.activeElement === ta };
    });
    check('the bug reporter says what it needs in its own line, describing the box, with the cursor put there',
      B.shown && /Describe what went wrong/.test(B.text) && B.invalid === 'true' && B.described === 'br-msg' && B.focus, J(B));
    await page.evaluate(() => BugReport.close());

    await page.evaluate(() => switchTab('workbench'));
    await page.fill('#wb-case-name', '');
    await page.evaluate(() => { state.wb.caseName = ''; });
    await page.click('button:has-text("Save")');
    const W = await page.evaluate(() => ({
      toast: (document.querySelector('#toasts .toast-text') || {}).textContent,
      focus: document.activeElement && document.activeElement.id,
      invalid: document.getElementById('wb-case-name').getAttribute('aria-invalid'),
    }));
    check('the Workbench, asked to save an unnamed case, says so and puts the cursor in the name', /^Name the investigation first/.test(W.toast || '')
      && W.focus === 'wb-case-name' && W.invalid === 'true', J(W));
    await page.evaluate(() => Toast.clear());

    // ═══════════════════════════════════════════════════════════════════════
    log('\n6. A browser that cannot run a tab\n');
    const navMark = p => p.evaluate(() => {
      const b = document.querySelector('#tab-nav .tab-btn[data-tab="serial"]');
      const marked = [...document.querySelectorAll('#tab-nav .tab-btn')].filter(x => x.querySelector('.nav-needs')).map(x => x.dataset.tab);
      // The name a screen reader is given: the button's text without what is
      // hidden from it (the icon and the mark).
      const named = b && (() => { const c = b.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
        return c.textContent.replace(/\s+/g, ' ').trim(); })();
      return { marked, title: b && b.title, name: named };
    });
    let N = await navMark(page);
    check('with Web Serial, nothing in the nav is marked', N.marked.length === 0, J(N));
    await context.close();

    {
      const { context: c2, page: p2 } = await open(browser, server, natives, errors, {
        url: '/index.html?tab=serial',
        init: () => { try { delete Navigator.prototype.serial; } catch (_) {} },
      });
      N = await navMark(p2);
      check('without it, the Serial Monitor is marked in the nav — and only it',
        J(N.marked) === J(['serial']), J(N));
      check('…the reason in its tooltip and in its name, not only the mark',
        N.title === 'Serial Monitor — needs Chrome, Edge or Opera on a computer, to reach a device on a cable'
          && N.name === N.title, J(N));
      const banner = await p2.evaluate(() => (document.querySelector('.ser-warn') || {}).textContent || '');
      check('…and the tab says why on arrival, naming the browsers that can', /Web Serial isn’t available in this browser/.test(banner)
        && /Chrome, Edge or Opera/.test(banner), banner.slice(0, 200));
      await c2.close();
    }

    check('no native dialog opened, all run', natives.length === 0, natives.join(' | '));
    check('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failedChecks = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failedChecks.length) {
    log(`\nFAIL — ${failedChecks.length} of them:\n`);
    for (const f of failedChecks) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — nothing stops the page to ask or to tell: questions are the app\'s own,\n'
    + '       name what they do, and leave what they were asked over standing.');
}

main().catch(err => { console.error(err); process.exit(1); });
