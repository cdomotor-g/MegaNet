// The left bar's views (nav-views.js, 0062), driven in a real browser.
//
//   1. **Picking a view** — All is where every device starts, and lists every
//      tab; the View box at the top of the bar offers All, Simple and Field in
//      that order; Simple is All less Export, the Map Generator and the whole
//      Interference group; Field is the site-visit list, Look Around in it;
//      the pick is this device's and survives a reload.
//   2. **Nothing is lost** — a tab the view leaves out, opened anyway, is in
//      the bar under "Not in this view"; the find box answers from every tab,
//      the view's own first; on the icon rail the view is one button that
//      opens the bar with the cursor on the View box.
//   3. **The Views tab, signed out** — the three views, Field open read-only,
//      and an offer to sign in rather than controls that would do nothing.
//   4. **An account's own views** — with the database stood in for (whoami,
//      my_prefs and save_my_views, which records what it is sent): duplicate
//      Field, rename a group, move a tab down, into another group, take one
//      out and add it back, use the view — the bar follows each — change the
//      built-in Field and reset it, delete the copy; every change saved in the
//      shape 0062 accepts; a reload with the database answering with them
//      opens on them; signing out takes them away.
//
// Why a check of its own: a view is the bar, and every check that counts the
// bar's tabs runs on All. A Field view that listed a desk tool, a pick that a
// reload forgot, a tab opened from a link that the bar no longer admitted to,
// or an account's views saved in a shape the database refuses — none of them
// throws, and none of them is visible to a check that never picks a view.
//
// Run:  npm run views
//       npm run views -- -v

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

// What the bar lists, as headings and tab ids, and what the View box says.
const bar = page => page.evaluate(() => ({
  view: document.getElementById('nav-view-select')?.value || null,
  options: [...document.querySelectorAll('#nav-view-select option')].map(o => o.textContent.trim()),
  groups: [...document.querySelectorAll('#nav-groups .nav-group')].map(g => ({
    h: g.querySelector('.nav-heading').textContent.trim(),
    tabs: [...g.querySelectorAll('.tab-btn')].map(b => b.dataset.tab),
    outside: g.classList.contains('nav-outside'),
  })),
}));
const ids = b => b.groups.flatMap(g => g.tabs);

const SHAPE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHAPE_TAB = /^[a-z0-9]{1,30}$/;
// The shape save_my_views() (0062) accepts, checked the same way here.
function shapeOk(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.views) || p.views.length > 24) return 'not an object with views';
  if (p.current != null && !SHAPE_ID.test(p.current)) return 'current';
  const seen = new Set();
  for (const v of p.views) {
    if (!v || !SHAPE_ID.test(v.id || '') || seen.has(v.id)) return `view id ${v && v.id}`;
    seen.add(v.id);
    if (v.preset != null && !['simple', 'field'].includes(v.preset)) return 'preset';
    if (v.name != null && (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40)) return 'name';
    if (v.groups != null) {
      if (!Array.isArray(v.groups) || v.groups.length > 30) return 'groups';
      for (const g of v.groups) {
        if (typeof g.name !== 'string' || !g.name.trim() || g.name.length > 40) return 'group name';
        if (!Array.isArray(g.tabs) || g.tabs.length > 80 || !g.tabs.every(t => SHAPE_TAB.test(t))) return 'group tabs';
      }
    }
  }
  return JSON.stringify(p).length <= 32768 ? '' : 'size';
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  // The database, stood in for: who is signed in, and the views kept for them.
  const db = { prefs: null, saved: [], who: null };

  async function open(url, { context = null, viewport = { width: 1440, height: 900 }, session = null } = {}) {
    context = context || await browser.newContext({ viewport });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await page.route('**/rest/v1/rpc/whoami', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: J(db.who || { signed_in: false, is_member: false, may_write: false, signup: 'open' }) }));
    await page.route('**/rest/v1/rpc/my_prefs', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: J({ nav_views: db.prefs, updated_at: db.prefs ? '2026-10-13T00:00:00Z' : null }) }));
    await page.route('**/rest/v1/rpc/save_my_views', route => {
      const body = JSON.parse(route.request().postData() || '{}');
      db.saved.push(body.p_views);
      db.prefs = body.p_views;
      return route.fulfill({ status: 200, contentType: 'application/json', body: J({ updated_at: '2026-10-13T00:00:01Z' }) });
    });
    if (session) {
      await page.addInitScript(s => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem('meganet.session', JSON.stringify(s));
          sessionStorage.setItem('seeded', '1');
        }
      }, session);
    }
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    return { context, page };
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Picking a view\n');
    const { context: ctx, page } = await open(server.url('/index.html?tab=stations'));
    let b = await bar(page);
    // Every tab this session is offered: a tab for some people only — the
    // administrators, or the ALERT2 Transition Plan's list (tabShown, core.js)
    // — is in no view of anybody else's.
    const all = await page.evaluate(() => TAB_LIST.filter(tabShown).map(t => t.id));
    check('a tab for some people only is left out of every view of a session that is none of them',
      await page.evaluate(() => TAB_LIST.some(t => t.who) && NavViews.views().every(v => v.groups.every(g => g.tabs.every(t => !t.who)))));
    check('a device that has never picked is on All, and All lists every tab once',
      b.view === 'all' && J(ids(b)) === J(all) && !b.groups.some(g => g.outside), J({ view: b.view, n: ids(b).length }));
    check('the View box, at the top of the bar, offers All, Simple and Field in that order',
      J(b.options) === J(['All', 'Simple', 'Field']), J(b.options));
    const head = await page.evaluate(() => {
      const h = document.querySelector('#tab-nav .nav-head');
      const kids = [...h.children].map(c => c.className.split(' ')[0]);
      return { kids, label: document.querySelector('label[for="nav-view-select"]')?.textContent.trim() };
    });
    check('…under the collapse toggle and over the find box, labelled View',
      head.kids.indexOf('nav-toggle') < head.kids.indexOf('nav-view') && head.kids.indexOf('nav-view') < head.kids.indexOf('nav-find')
        && /View/.test(head.label || ''), J(head));

    await page.selectOption('#nav-view-select', 'simple');
    b = await bar(page);
    const gone = ['export', 'mapgen', 'rf', 'rfchanges', 'workbench', 'reception'];
    check('Simple: All less Export, the Map Generator and the Interference group',
      b.view === 'simple' && gone.every(t => !ids(b).includes(t)) && !b.groups.some(g => g.h === 'Interference')
        && J(ids(b)) === J(all.filter(t => !gone.includes(t))), J(ids(b)));
    check('…and the pick is kept on this device',
      await page.evaluate(() => localStorage.getItem('mn-view')) === 'simple');

    await page.selectOption('#nav-view-select', 'field');
    b = await bar(page);
    const FIELD = ['nearby', 'stations', 'lookaround', 'camera', 'photos', 'inspections', 'maintenance', 'history',
                   'levels', 'twopeg', 'surveyguide', 'msglog', 'health', 'offline', 'views'];
    check('Field: the site-visit list — Nearby, Stations and Look Around first, no desk tool',
      b.view === 'field' && J(ids(b)) === J(FIELD), J(b.groups));
    check('…in groups of its own: Site visits, Surveying, Is it reporting?, Before you go',
      J(b.groups.map(g => g.h)) === J(['Stations & networks', 'Site visits', 'Surveying', 'Is it reporting?', 'Before you go']),
      J(b.groups.map(g => g.h)));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
    b = await bar(page);
    check('a reload opens on Field again', b.view === 'field' && J(ids(b)) === J(FIELD), J(b.view));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Nothing is lost\n');
    await page.evaluate(() => switchTab('export'));
    b = await bar(page);
    const out = b.groups.find(g => g.outside);
    const cur = await page.evaluate(() => document.querySelector('#tab-nav .tab-btn[aria-current="page"]')?.dataset.tab);
    check('a tab Field leaves out, opened anyway, is in the bar under "Not in this view", as the tab you are on',
      out && out.h === 'Not in this view' && J(out.tabs) === J(['export']) && cur === 'export', J({ out, cur }));
    await page.fill('#nav-search', 'radio mobile');
    b = await bar(page);
    const pick = await page.evaluate(() => document.querySelector('#nav-groups .tab-btn.nav-best')?.dataset.tab);
    check('the find box answers from every tab: "radio mobile" finds Export under "Not in this view", ↵ on it',
      b.groups.some(g => g.outside && g.tabs.includes('export')) && pick === 'export', J({ groups: b.groups, pick }));
    await page.fill('#nav-search', 'camera');
    b = await bar(page);
    check('…and a tab the view has is found under the view\'s own heading',
      b.groups.some(g => !g.outside && g.tabs.includes('camera')), J(b.groups));
    await page.fill('#nav-search', '');
    await page.evaluate(() => switchTab('stations'));
    await page.evaluate(() => { if (!state.navCollapsed) setNavCollapsed(true); });
    const rail = await page.evaluate(() => {
      const btn = document.querySelector('#tab-nav .nav-view-btn');
      return { shown: !!btn && btn.getClientRects().length > 0, icon: btn?.querySelector('.nav-icon')?.textContent,
               title: btn?.title, box: document.querySelector('#tab-nav .nav-view')?.getClientRects().length || 0 };
    });
    check('on the icon rail the view is one button with Field\'s icon, and the View box is put away',
      rail.shown && rail.icon === '🥾' && /Field/.test(rail.title || '') && rail.box === 0, J(rail));
    await page.click('#tab-nav .nav-view-btn');
    const railed = await page.evaluate(() => ({ collapsed: state.navCollapsed, focus: document.activeElement?.id }));
    check('…which opens the bar with the cursor on the View box', !railed.collapsed && railed.focus === 'nav-view-select', J(railed));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The Views tab, signed out\n');
    await page.click('#tab-nav .tab-btn[data-tab="views"]');
    await page.waitForFunction(() => !!document.getElementById('vw-editor'));
    const tabOut = await page.evaluate(() => ({
      list: [...document.querySelectorAll('.vw-item .vw-item-name')].map(n => n.textContent.trim()),
      open: document.getElementById('vw-ed-h')?.textContent.trim(),
      inputs: document.querySelectorAll('#vw-editor input, #vw-editor select').length,
      newDisabled: document.querySelector('[data-k="create"]')?.disabled,
      signin: /Sign in to make views of your own/.test(document.getElementById('vw-signin-why')?.textContent || ''),
      missing: document.querySelectorAll('#vw-editor .vw-missing .vw-tab').length,
    }));
    check('signed out: All, Simple and Field, the view in use (Field) open, read-only, and an offer to sign in',
      J(tabOut.list) === J(['All', 'Simple', 'Field']) && /Field/.test(tabOut.open || '') && tabOut.inputs === 0
        && tabOut.newDisabled === true && tabOut.signin && tabOut.missing === all.length - FIELD.length, J(tabOut));
    await page.click('[data-k="pick:simple"]');
    await page.click('#vw-editor [data-k="use"]');
    b = await bar(page);
    check('Use this view, on the tab, puts the bar on it', b.view === 'simple', b.view);
    await ctx.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. An account\'s own views\n');
    db.who = { signed_in: true, email: 'pat@council.example', role: 'editor', may_write: false, is_admin: false,
               is_member: true, status: 'approved', signup: 'open', schema_version: '65' };
    db.prefs = null;
    const session = { access_token: 'member-token', refresh_token: 'r', expires_at: Date.now() + 3600e3, email: 'pat@council.example' };
    const { context: ctx2, page: p2 } = await open(server.url('/index.html?tab=views'), { session });
    await p2.waitForFunction(() => Auth.known && Auth.known(), null, { timeout: 15_000 });
    await p2.waitForFunction(() => !document.querySelector('[data-k="create"]')?.disabled, null, { timeout: 10_000 });
    await p2.click('[data-k="pick:field"]');
    await p2.click('#vw-editor [data-k="duplicate"]');
    await p2.waitForFunction(() => /Field \(copy\)/.test(document.getElementById('vw-ed-h')?.textContent || ''));
    const copy = await p2.evaluate(() => NavViews.layout().views.find(v => v.name === 'Field (copy)'));
    check('Duplicate makes the account a copy of Field, open to change, its groups written out',
      copy && /^v-/.test(copy.id) && Array.isArray(copy.groups) && copy.groups.length === 5, J(copy));

    const nameBox = '#vw-editor [data-k="g:0:name"]';
    await p2.fill(nameBox, 'On site');
    await p2.press(nameBox, 'Enter');
    await p2.waitForFunction(() => NavViews.layout().views.some(v => v.groups && v.groups[0].name === 'On site'));
    await p2.click('#vw-editor [data-k="t:stations:down"]');
    let mine = await p2.evaluate(() => NavViews.layout().views.find(v => v.name === 'Field (copy)'));
    check('a group renamed, and Stations moved down below Look Around',
      mine.groups[0].name === 'On site' && J(mine.groups[0].tabs) === J(['nearby', 'lookaround', 'stations']), J(mine.groups[0]));
    const focusAfter = await p2.evaluate(() => document.activeElement?.dataset.k);
    check('…focus stays on the moved tab\'s ↓', focusAfter === 't:stations:down', String(focusAfter));
    await p2.selectOption('#vw-editor [data-k="t:health:group"]', '0');
    mine = await p2.evaluate(() => NavViews.layout().views.find(v => v.name === 'Field (copy)'));
    check('Move to… puts Station Health at the foot of On site',
      J(mine.groups[0].tabs) === J(['nearby', 'lookaround', 'stations', 'health']) && !mine.groups[3].tabs.includes('health'), J(mine.groups));
    await p2.click('#vw-editor [data-k="t:maintenance:remove"]');
    mine = await p2.evaluate(() => NavViews.layout().views.find(v => v.name === 'Field (copy)'));
    const missingNow = await p2.evaluate(() => [...document.querySelectorAll('#vw-editor .vw-missing [data-k^="add:"]')].map(s => s.dataset.k));
    check('✕ takes Site Maintenance out, and it is listed under Not in this view to add back',
      !mine.groups.some(g => g.tabs.includes('maintenance')) && missingNow.includes('add:maintenance'), J(missingNow.slice(0, 5)));
    await p2.selectOption('#vw-editor [data-k="add:export"]', '0');
    mine = await p2.evaluate(() => NavViews.layout().views.find(v => v.name === 'Field (copy)'));
    check('Add to… puts Export in On site', mine.groups[0].tabs.includes('export'), J(mine.groups[0]));
    await p2.click('#vw-editor [data-k="use"]');
    let b2 = await bar(p2);
    check('Use this view: the bar lists it, its renamed group and moved tabs included',
      b2.view === mine.id && b2.groups[0].h === 'On site' && J(b2.groups[0].tabs) === J(['nearby', 'lookaround', 'stations', 'health', 'export'])
        && !ids(b2).includes('maintenance'), J(b2.groups.slice(0, 2)));
    await p2.waitForFunction(() => document.getElementById('vw-save')?.dataset.state === 'saved', null, { timeout: 10_000 });
    const last = db.saved[db.saved.length - 1];
    check('every change is saved to the account, in the shape 0062 accepts, the view in use with it',
      db.saved.length > 0 && db.saved.every(p => shapeOk(p) === '') && last.current === mine.id
        && last.views.some(v => v.id === mine.id && v.groups[0].name === 'On site'),
      J({ n: db.saved.length, bad: db.saved.map(shapeOk).filter(Boolean), current: last && last.current }));

    // The built-in Field, changed and put back.
    await p2.click('[data-k="pick:field"]');
    await p2.click('#vw-editor [data-k="t:history:remove"]');
    let field = await p2.evaluate(() => NavViews.layout().views.find(v => v.id === 'field'));
    check('changing the built-in Field makes it the account\'s: kept as Field, with its groups written out',
      field.preset === 'field' && Array.isArray(field.groups) && !field.groups.some(g => g.tabs.includes('history')), J(field));
    await p2.click('#vw-editor [data-k="view-reset"]');
    field = await p2.evaluate(() => NavViews.layout().views.find(v => v.id === 'field'));
    check('Reset puts the built-in back: no list kept, so it follows the app', field.preset === 'field' && !field.groups, J(field));

    // A reload: the database answers with what was saved.
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForFunction(() => !!state.data && Auth.known && Auth.known(), null, { timeout: LOAD_TIMEOUT });
    await p2.waitForFunction(id => document.getElementById('nav-view-select')?.value === id, mine.id, { timeout: 10_000 });
    b2 = await bar(p2);
    check('a reload opens on the account\'s view, from the database', b2.groups[0].h === 'On site', J(b2.groups[0]));

    // Delete the copy (it is in use): the bar goes back to All.
    await p2.evaluate(() => switchTab('views'));
    await p2.click(`[data-k="pick:${mine.id}"]`);
    await p2.click('#vw-editor [data-k="delete"]');
    await p2.click('[data-ask="yes"]');
    await p2.waitForFunction(id => !NavViews.layout().views.some(v => v.id === id), mine.id);
    b2 = await bar(p2);
    check('Delete, asked first, takes the copy away, and the bar goes back to All', b2.view === 'all'
      && J(ids(b2)) === J(all), b2.view);

    // Signing out takes the account's views away with it.
    await p2.evaluate(() => { NavViews.duplicate('simple', 'Mine'); });
    await p2.waitForFunction(() => NavViews.layout().views.some(v => v.name === 'Mine'));
    db.who = null;
    await p2.evaluate(() => Auth.signOut({ announce: false }));
    await p2.waitForFunction(() => !Auth.isSignedIn() && NavViews.layout() === null, null, { timeout: 10_000 });
    const after = await p2.evaluate(() => ({ cache: localStorage.getItem('mn-views'),
      options: [...document.querySelectorAll('#nav-view-select option')].map(o => o.textContent.trim()) }));
    check('signing out takes the account\'s views away — the bar offers the built-in three, nothing cached',
      after.cache === null && J(after.options) === J(['All', 'Simple', 'Field']), J(after));
    await ctx2.close();
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — the left bar's views: All, Simple and Field, nothing lost from any of them, and an account's own kept (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
