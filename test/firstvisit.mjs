// A first visit, and What's new (#222: route.js's newDevice/firstVisit,
// site-map.js's greeting, whats-new.js), driven in a real browser.
//
//   1. **A first visit** — a browser that has never been here, at a bare
//      address, opens the Site Map with a greeting that says why; the list
//      arriving does not take the greeting away; Got it does, and so does
//      leaving; the next bare visit opens the tab used last, ungreeted.
//   2. **A new device that came by a link** — goes where the link says, and is
//      not greeted.
//   3. **What's new** — a new device has seen it all; a device that has been
//      here before is shown ✨ What's new, which lists the entries with the
//      unseen ones marked, and once looked at is gone, reload or not.
//
// Why a check of its own: every failure here is a page that looks right. A
// greeting that comes back on every visit, one that vanishes when the list
// lands two seconds in, a pill that tells a brand-new user what changed —
// none of them throws.
//
// Run:  npm run firstvisit
//       npm run firstvisit -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

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

const look = page => page.evaluate(() => ({
  tab: state.activeTab,
  data: !!state.data,
  welcome: !!document.getElementById('sm-welcome'),
  pill: !document.getElementById('btn-whatsnew').hidden,
  seen: localStorage.getItem('mn-whats-new'),
  latest: WhatsNew.entries[0].n,
}));

async function open(browser, server, errors, url, { context = null, init = null } = {}) {
  context = context || await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  return { context, page };
}
const loaded = page => page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
  null, { timeout: LOAD_TIMEOUT });

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. A first visit\n');
    const { context: ctx, page } = await open(browser, server, errors, server.url());
    let L = await look(page);
    check('a browser that has never been here opens the Site Map, greeted', L.tab === 'sitemap' && L.welcome, J(L));
    check('…and is not shown What\'s new: a new device has seen it all', !L.pill && Number(L.seen) === L.latest, J(L));
    await loaded(page);
    L = await look(page);
    check('the list arriving re-draws the page and keeps the greeting', L.data && L.welcome, J(L));
    const say = await page.evaluate(() => document.querySelector('#sm-welcome').textContent.replace(/\s+/g, ' '));
    check('the greeting says why, and that it will not happen again', /first time this browser has been here/.test(say)
      && /opens on the tab you used last/.test(say), say);
    await page.click('#sm-welcome button:not(.primary)');
    const got = await page.evaluate(() => ({ welcome: !!document.getElementById('sm-welcome'),
      focus: document.activeElement && document.activeElement.id }));
    check('Got it puts it away, focus on the page\'s heading', !got.welcome && got.focus === 'sm-h', J(got));
    await page.evaluate(() => { switchTab('stations'); switchTab('sitemap'); });
    check('…and it does not come back for the rest of the visit', !(await look(page)).welcome);
    await page.evaluate(() => switchTab('passranges'));
    await page.close();

    const again = (await open(browser, server, errors, server.url(), { context: ctx })).page;
    L = await look(again);
    check('the next bare visit opens the tab used last, ungreeted', L.tab === 'passranges' && !L.welcome && !L.pill, J(L));
    await ctx.close();

    {
      const { context, page: p } = await open(browser, server, errors, server.url());
      await loaded(p);
      await p.click('#sm-welcome button.primary');
      await p.waitForFunction(() => state.activeTab === 'stations', null, { timeout: 10_000 });
      await p.evaluate(() => switchTab('sitemap'));
      check('📍 Go to Stations goes there, and the greeting is spent', !(await look(p)).welcome);
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. A new device that came by a link\n');
    {
      const { context, page: p } = await open(browser, server, errors, server.url('/index.html?tab=health'));
      L = await look(p);
      check('goes where the link says, ungreeted and not shown What\'s new', L.tab === 'health' && !L.welcome && !L.pill, J(L));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. What\'s new, on a device that has been here before\n');
    {
      const { context, page: p } = await open(browser, server, errors, server.url(),
        { init: () => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('mn-theme', 'light'); sessionStorage.setItem('seeded', '1'); } } catch (_) {} } });
      L = await look(p);
      check('a device that has been here before opens where it always did — not the guide', L.tab === 'stations' && !L.welcome, J(L));
      check('…and is shown ✨ What\'s new', L.pill, J(L));
      await p.click('#btn-whatsnew');
      const dlg = await p.evaluate(() => ({
        title: (document.getElementById('app-modal-title') || {}).textContent,
        entries: document.querySelectorAll('.wn-entry').length,
        fresh: document.querySelectorAll('.wn-entry.is-new .wn-tag').length,
        lines: document.querySelectorAll('.wn-entry li').length,
        pill: !document.getElementById('btn-whatsnew').hidden,
      }));
      check('pressed, it lists every entry, the unseen ones marked "new" in words',
        dlg.title === 'What\'s new in Flood-Net' && dlg.entries === dlg.fresh && dlg.entries >= 1 && dlg.lines >= 1, J(dlg));
      check('…and looking is seeing: the pill goes', !dlg.pill, J(dlg));
      await p.keyboard.press('Escape');
      await p.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
      L = await look(p);
      check('a reload does not bring it back', !L.pill && Number(L.seen) === L.latest, J(L));
      await context.close();
    }

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — a first visit is greeted by the guide once, and What\'s new is shown only\n'
    + '       to a device that has something it has not seen.');
}

main().catch(err => { console.error(err); process.exit(1); });
