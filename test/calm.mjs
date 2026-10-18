// The Calm look (looks.js, calm-shell.js) and what came with it: 📌 Nearby
// (nearby.js) and the inspection sheet a section at a time on a phone.
//
// Every other browser check opens the app in Classic (lib/browser.mjs says
// why), so this is the one that opens it as a person does — in the default —
// and holds the default to what it promises:
//
//   1. **The default.** A device that has never chosen opens in Calm: the bar
//      down the side is one button a group, the open group's tabs are a row
//      across the top, and a first visit is not told that anything changed.
//   2. **The bar and the row.** A group's button opens the tab last used in
//      it; the row marks the open tab as the page; a switch from the row
//      leaves focus on the row's own button; ← → walk it; the bar follows the
//      view (Field lists its own groups).
//   3. **The banner.** Search is a box, Export, Report a Bug and Theme are
//      behind ⋯, and ⋯ opens a list whose Theme & look carries the switch.
//   4. **The way back.** Classic from the Theme dialog is the old bar, whole,
//      remembered; Calm again from the same dialog; `?look=classic` is taken
//      as a choice and taken out of the address; Ctrl+K finds it by "classic".
//   5. **The note** for a device that knew Classic: once, with the way back,
//      and gone for good once it is closed.
//   6. **A phone.** The bar along the foot; ⋯ More is the drawer, every group
//      with its tabs; 📌 Nearby nearest first from the map's centre; a station's
//      Start inspection opens the sheet filled in with it, a section at a time,
//      Next and Back moving through it with nothing typed lost.
//   7. **Less to read first.** A tab's long introduction two lines deep with
//      More about this tab, remembered once opened, a short one left alone;
//      Station Health's answer in a sentence above its numbers, See them going
//      down to the list; Classic showing neither.
//   8. **Every tab, in Calm.** Opened one by one with a clean console, and every
//      on*= handler on the page — the bar's, the row's, ⋯'s — resolving.
//
// Run:  npm run calm
//       npm run calm -- -v    also print what passed

import { formFixture } from './lib/migration.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 300);
const J = v => JSON.stringify(v);

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && (!ok || VERBOSE) ? ` — ${detail}` : ''}`);
}
const log = (...a) => console.log(...a);
const NOISE = /^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i;

// The inspection form's reference tables, out of the migration (as
// inspections.mjs serves them) — the sheet renders from the database, and
// a phone's section-at-a-time is a claim about that sheet.
function installForms(page, tables) {
  return page.route('**://*.supabase.co/rest/v1/**', route => {
    const url = new URL(route.request().url());
    const table = url.pathname.replace(/^.*\/rest\/v1\//, '').split('?')[0];
    const rows = route.request().method() === 'GET' ? tables[table] : null;
    if (!rows) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not in this fixture"}' });
    const order = (url.searchParams.get('order') || '').split(',').filter(Boolean);
    const out = rows.slice().sort((a, b) => {
      for (const key of order) {
        const col = key.split('.')[0], dir = key.endsWith('.desc') ? -1 : 1;
        if (a[col] < b[col]) return -dir;
        if (a[col] > b[col]) return dir;
      }
      return 0;
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

async function open(browser, server, { viewport, storage = null, url = '', errors }) {
  const context = await browser.newContext({ look: null, viewport });
  if (storage) {
    await context.addInitScript(s => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, storage);
  }
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await installForms(page, formFixture());
  page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.goto(server.origin + '/index.html' + url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(SETTLE);
  return { context, page };
}

// What the shell shows, read off the page.
const shell = page => page.evaluate(() => {
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  return {
    look: document.documentElement.getAttribute('data-look'),
    sections: [...document.querySelectorAll('#tab-nav .nav-sec')].filter(vis).map(b => b.querySelector('.nav-label').textContent),
    current: (document.querySelector('#tab-nav .nav-sec[aria-current="true"] .nav-label') || {}).textContent || null,
    navTabsShown: [...document.querySelectorAll('#tab-nav .tab-btn')].filter(vis).length,
    bar: vis(document.getElementById('section-bar')),
    row: [...document.querySelectorAll('#section-bar .tab-btn')].map(b => b.dataset.tab),
    rowOn: (document.querySelector('#section-bar .tab-btn[aria-current="page"]') || {}).dataset?.tab || null,
    intro: !!document.querySelector('#section-bar .look-intro'),
    tab: state.activeTab,
    btn: Object.fromEntries(['btn-palette', 'btn-export', 'btn-report', 'btn-theme', 'btn-more', 'btn-auth', 'btn-nav']
      .map(id => [id, vis(document.getElementById(id))])),
    field: [...document.querySelectorAll('.field-bar .field-btn')].filter(vis).map(b => b.dataset.field),
  };
});

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];

  try {
    // ── 1. The default ─────────────────────────────────────────────────────
    log('\n1. A device that has never chosen opens in Calm\n');
    let { context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 }, errors });
    let S = await shell(page);
    const groups = await page.evaluate(() => NavViews.navGroups().map(g => g.group));
    check('the page wears Calm, and state says so', S.look === 'calm' && await page.evaluate(() => state.look === 'calm'), S.look);
    check('the bar is one button a group of the view — every group, in order — and no tab button of its own on screen',
      J(S.sections) === J(groups) && S.navTabsShown === 0, J({ S: S.sections, groups, tabs: S.navTabsShown }));
    check('the open group is marked in the bar, and its tabs are the row across the top, the open one the page',
      S.bar && S.current && S.rowOn === S.tab && S.row.includes(S.tab), J(S));
    check('a first visit is not told that the look is new', !S.intro);
    check('…and nothing about the look is stored for it — a default is not a choice',
      await page.evaluate(() => localStorage.getItem('mn-look')) === null);
    check('the forecast and information outlines start off under Calm', await page.evaluate(() => state.mapPinSls === false));
    check('the address carries no look', !/look=/.test(await page.evaluate(() => location.search)));

    // ── 2. The bar and the row ─────────────────────────────────────────────
    log('\n2. The bar and the row across the top\n');
    await page.evaluate(() => switchTab('stations'));
    await page.click('#tab-nav .nav-sec >> text=Interference');
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('a group\'s button opens its first tab the first time, and the row becomes that group\'s',
      S.tab === 'rf' && S.current === 'Interference' && J(S.row) === J(['rf', 'rfchanges', 'workbench', 'reception']), J(S));
    await page.click('#section-bar .tab-btn[data-tab="workbench"]');
    await page.waitForTimeout(SETTLE);
    const focus = await page.evaluate(() => ({ tab: document.activeElement?.dataset?.tab, inRow: !!document.activeElement?.closest('#section-bar') }));
    check('a tab picked in the row opens, and focus stays on that tab\'s button in the row', focus.tab === 'workbench' && focus.inRow, J(focus));
    await page.keyboard.press('ArrowRight');
    check('→ walks the row', await page.evaluate(() => document.activeElement?.dataset?.tab) === 'reception');
    await page.keyboard.press('Home');
    check('Home goes to its first tab', await page.evaluate(() => document.activeElement?.dataset?.tab) === 'rf');
    await page.click('#tab-nav .nav-sec >> text=Data');
    await page.waitForTimeout(SETTLE);
    await page.click('#tab-nav .nav-sec >> text=Interference');
    await page.waitForTimeout(SETTLE);
    check('back to a group, it opens on the tab last used in it', await page.evaluate(() => state.activeTab) === 'workbench');
    await page.evaluate(() => { switchTab('stations'); });
    await page.selectOption('#nav-view-select', 'field');
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    const field = await page.evaluate(() => NavViews.navGroups().map(g => g.group));
    check('the bar follows the view: Field lists its own groups', J(S.sections) === J(field) && S.sections.includes('Before you go'), J(S.sections));
    await page.selectOption('#nav-view-select', 'all');
    await page.waitForTimeout(SETTLE);
    await page.click('#tab-nav .nav-toggle');
    await page.waitForTimeout(400);
    const rail = await page.evaluate(() => ({ w: document.getElementById('tab-nav').getBoundingClientRect().width,
      labels: [...document.querySelectorAll('#tab-nav .nav-sec .nav-label')].every(l => l.getBoundingClientRect().width <= 1) }));
    check('« shrinks the bar to its icons, the names kept for a screen reader', rail.w < 80 && rail.labels, J(rail));
    await page.click('#tab-nav .nav-toggle');
    await page.waitForTimeout(400);

    // ── 3. The banner ──────────────────────────────────────────────────────
    log('\n3. The banner and ⋯\n');
    S = await shell(page);
    check('search, sign in and ⋯ are in the banner; Export, Report a Bug and Theme are not',
      S.btn['btn-palette'] && S.btn['btn-auth'] && S.btn['btn-more']
      && !S.btn['btn-export'] && !S.btn['btn-report'] && !S.btn['btn-theme'], J(S.btn));
    const searchName = await page.evaluate(() => {
      const b = document.getElementById('btn-palette');
      return { hint: b.querySelector('.hdr-find').getBoundingClientRect().width > 50, label: b.querySelector('.hdr-label').textContent };
    });
    check('search is drawn as a box with what it finds written in it, and is still called Search', searchName.hint && searchName.label === 'Search', J(searchName));
    await page.click('#btn-more');
    const menu = await page.evaluate(() => ({
      title: document.getElementById('app-modal-title')?.textContent,
      items: [...document.querySelectorAll('#more-menu .more-item')].map(b => b.dataset.go),
      focus: document.activeElement?.dataset?.go,
    }));
    check('⋯ opens More: export, theme & look, help, the Site Map, what\'s new and report a bug, the first in focus',
      menu.title === 'More' && J(menu.items) === J(['export', 'theme', 'help', 'guide', 'news', 'bug']) && menu.focus === 'export', J(menu));
    await page.click('#more-menu .more-item[data-go="theme"]');
    const dlg = await page.evaluate(() => ({ title: document.getElementById('app-modal-title')?.textContent,
      themes: document.querySelectorAll('#theme-pick input').length,
      looks: [...document.querySelectorAll('#look-pick input')].map(r => r.value + (r.checked ? '*' : '')) }));
    check('Theme & look is the Theme dialog, with the looks under the themes, Calm picked',
      dlg.title === 'Theme' && dlg.themes === 4 && J(dlg.looks) === J(['calm*', 'classic']), J(dlg));

    // ── 4. The way back ────────────────────────────────────────────────────
    log('\n4. Classic, and back\n');
    await page.click('#look-pick input[value="classic"]');
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    const said = await page.evaluate(() => document.getElementById('app-status').textContent);
    check('Classic: the old bar, every tab under its heading, and no row across the top',
      S.look === 'classic' && S.sections.length === 0 && S.navTabsShown > 30 && !S.bar, J({ look: S.look, tabs: S.navTabsShown, bar: S.bar }));
    check('…the banner\'s buttons back and ⋯ gone, the choice remembered, and said',
      S.btn['btn-export'] && S.btn['btn-report'] && S.btn['btn-theme'] && !S.btn['btn-more']
      && await page.evaluate(() => localStorage.getItem('mn-look')) === 'classic' && said === 'Look: Classic', J({ btn: S.btn, said }));
    check('…and the dialog stays, so the two can be compared', await page.evaluate(() => !!document.getElementById('look-pick')));
    await page.click('#look-pick input[value="calm"]');
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('Calm again from the same dialog', S.look === 'calm' && S.bar && S.sections.length > 0, S.look);
    await page.keyboard.press('Escape');
    const pal = await page.evaluate(() => Palette.results('classic').filter(x => x.kind === 'action').map(x => x.label));
    check('Ctrl+K finds the way to Classic by name', pal.some(l => /Classic/.test(l)), J(pal));
    await context.close();

    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 }, url: '?look=classic&tab=packets', errors }));
    const addr = await page.evaluate(() => ({ look: state.look, attr: document.documentElement.getAttribute('data-look'),
      search: location.search, stored: localStorage.getItem('mn-look'), tab: state.activeTab }));
    check('?look=classic opens Classic and is kept as the choice, then taken out of the address — the rest of it left',
      addr.look === 'classic' && addr.attr === 'classic' && addr.stored === 'classic' && !/look=/.test(addr.search)
      && /tab=packets/.test(addr.search) && addr.tab === 'packets', J(addr));
    check('Classic keeps the forecast outlines on, as it always had them', await page.evaluate(() => state.mapPinSls === true));
    await context.close();

    // ── 5. The note ────────────────────────────────────────────────────────
    log('\n5. The note for somebody who knew Classic\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 }, storage: { 'mn-tab': 'stations' }, errors }));
    S = await shell(page);
    check('a device that has been here before, with no look chosen, is told once, with the way back', S.intro
      && await page.evaluate(() => /Switch back to Classic/.test(document.querySelector('.look-intro').textContent)), J(S.intro));
    await page.click('.look-intro-x');
    await page.waitForTimeout(150);
    check('× closes it for good, and focus goes on along the row',
      !(await shell(page)).intro && await page.evaluate(() => localStorage.getItem('mn-look-intro')) === 'seen'
      && await page.evaluate(() => !!document.activeElement?.closest('#section-bar')));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    check('…and it does not come back on the next visit', !(await shell(page)).intro);
    await context.close();

    // ── 6. A phone ─────────────────────────────────────────────────────────
    log('\n6. A phone: the bar along the foot, Nearby, and a sheet a section at a time\n');
    ({ context, page } = await open(browser, server, {
      viewport: { width: 390, height: 844 },
      // Not opened on Stations: leaving its map would write where it was
      // looking over the view seeded here, and that view is the point.
      storage: { 'mn-tab': 'sitemap', 'mn-look-intro': 'seen', 'mn-map-view': JSON.stringify({ lat: -27.99, lng: 152.68, zoom: 10 }) },
      errors,
    }));
    await page.evaluate(() => switchTab('sitemap'));
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('the bar along the foot: Nearby, Map, Visits, Camera and More — and no ☰ in the banner',
      J(S.field) === J(['nearby', 'map', 'visits', 'camera', 'more']) && !S.btn['btn-nav'], J({ field: S.field, nav: S.btn['btn-nav'] }));
    const foot = await page.evaluate(() => {
      const r = document.querySelector('.field-bar').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight,
               chrome: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mn-footbar')) };
    });
    check('…standing on the bottom of the screen, and counted as chrome', foot.bottom === foot.vh && foot.h > 40 && foot.chrome === foot.h, J(foot));
    await page.click('.field-bar [data-field="more"]');
    await page.waitForTimeout(400);
    const drawer = await page.evaluate(() => ({
      open: !state.navCollapsed,
      tabs: [...document.querySelectorAll('#tab-nav .calm-tabs .tab-btn')].filter(b => b.getClientRects().length).length,
      expanded: document.querySelector('.field-bar [data-field="more"]')?.getAttribute('aria-expanded'),
    }));
    const shown = await page.evaluate(() => TAB_LIST.filter(tabShown).length);
    check('More opens the drawer: every group with every one of its tabs', drawer.open && drawer.tabs === shown, J({ drawer, shown }));
    await page.click('#tab-nav .calm-tabs .tab-btn[data-tab="history"]');
    await page.waitForTimeout(SETTLE);
    check('a tab picked in the drawer opens and the drawer shuts', await page.evaluate(() => state.activeTab === 'history' && state.navCollapsed));

    await page.click('.field-bar [data-field="nearby"]');
    await page.waitForTimeout(SETTLE);
    check('Nearby opens 📌 Nearby, marked in the bar', await page.evaluate(() => state.activeTab === 'nearby'
      && document.querySelector('.field-bar [data-field="nearby"]').getAttribute('aria-current') === 'page'));
    await page.click('#nb-map');
    await page.waitForTimeout(SETTLE);
    const list = await page.evaluate(() => [...document.querySelectorAll('.nb-row')].map(r => ({
      id: r.dataset.id, km: parseFloat(r.querySelector('.nb-dist strong').textContent) * (/ m$/.test(r.querySelector('.nb-dist strong').textContent) ? 0.001 : 1) })));
    const sorted = list.every((r, i) => !i || r.km >= list[i - 1].km);
    check('From the map\'s centre: twenty-five stations, nearest first', list.length === 25 && sorted, J(list.slice(0, 3)));
    const near = await page.evaluate(() => {
      const c = { lat: -27.99, lon: 152.68 };
      const all = filteredStations().filter(s => s.lat != null && s.lon != null)
        .map(s => ({ id: s.id, km: acmaHaversineKm(c.lat, c.lon, s.lat, s.lon) })).sort((a, b) => a.km - b.km);
      return all[0].id;
    });
    check('…the first of them the nearest of all', list[0] && list[0].id === near, J({ first: list[0], near }));
    await page.click('.nb-row >> nth=0');
    await page.waitForTimeout(SETTLE);
    const stn = await page.evaluate(() => ({ h: document.getElementById('nb-stn-h')?.textContent,
      dir: document.querySelector('.nb-dir')?.getAttribute('href') || '' }));
    check('a station: its name, Start inspection, Photos, and Directions to its coordinate', !!stn.h && /destination=|daddr=/.test(stn.dir), J(stn));

    await page.click('.nb-big');
    await page.waitForFunction(() => state.activeTab === 'inspections' && !!document.querySelector('.insp-steps'), null, { timeout: 15_000 });
    const sheet = () => page.evaluate(() => ({
      station: (document.querySelector('.insp-form-head h3') || {}).textContent || '',
      shown: [...document.querySelectorAll('.insp-section')].filter(s => !s.hidden).map(s => s.dataset.section),
      total: document.querySelectorAll('.insp-section').length,
      step: document.querySelector('.insp-steps .insp-step-name')?.textContent,
    }));
    let sh = await sheet();
    const want = await page.evaluate(id => (state.data.stations.find(s => s.id === id) || {}).name, near);
    check('Start inspection opens the sheet filled in with that station', sh.station.startsWith(want), J({ sh: sh.station, want }));
    check('…a section at a time: one showing, the rest in the page but hidden', sh.shown.length === 1 && sh.total > 3, J(sh));
    const first = sh.shown[0];
    const input = await page.$(`.insp-section[data-section="${first}"] input[type="text"], .insp-section[data-section="${first}"] input:not([type])`);
    if (input) await input.fill('calm-check');
    await page.click('.insp-step-nav .primary');
    await page.waitForTimeout(SETTLE);
    sh = await sheet();
    check('Next shows the next section, and says which', sh.shown.length === 1 && sh.shown[0] !== first
      && /Section 2 of/.test(await page.evaluate(() => document.getElementById('app-status').textContent)), J(sh));
    await page.click('.insp-step-nav button:not(.primary)');
    await page.waitForTimeout(SETTLE);
    sh = await sheet();
    const kept = input ? await page.evaluate(f => [...document.querySelectorAll(`.insp-section[data-section="${f}"] input`)]
      .some(i => i.value === 'calm-check'), first) : true;
    check('Back returns to it, with what was typed there kept', sh.shown[0] === first && kept, J({ sh, kept }));
    // What the open sheet says it is, as it stands — 'calm-check' may well be
    // its station-name box, typed into above.
    const openSheet = await page.evaluate(() => (document.querySelector('.insp-form-head h3') || {}).textContent || '');
    await page.evaluate(() => switchTab('nearby'));
    await page.click('.nb-row >> nth=1');
    await page.click('.nb-big');
    await page.waitForTimeout(SETTLE);
    const again = await page.evaluate(() => ({ tab: state.activeTab, h: (document.querySelector('.insp-form-head h3') || {}).textContent || '' }));
    check('Start inspection with a sheet already open takes you back to that sheet rather than starting over it',
      again.tab === 'inspections' && again.h === openSheet, J({ again, openSheet }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { renderTabs(); renderMain(); });
    await page.waitForTimeout(SETTLE);
    sh = await sheet();
    check('wider than a phone, the sheet is whole again', sh.shown.length === sh.total && !sh.step, J(sh));
    await context.close();

    // ── 7. Introductions folded, and Station Health's answer first ─────────
    log('\n7. A tab\'s introduction folded, and Station Health\'s answer first\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-tab': 'sitemap', 'mn-look-intro': 'seen' }, errors }));
    await page.evaluate(() => { switchTab('health'); Health.demo(); });
    await page.waitForSelector('.hl-verdict', { timeout: 15_000 });
    const lede = () => page.evaluate(() => {
      const p = document.querySelector('.hl-sub');
      const line = parseFloat(getComputedStyle(p).lineHeight) || 20;
      const b = document.querySelector('.lede-more');
      return { folded: p.classList.contains('lede-fold'), lines: Math.round(p.getBoundingClientRect().height / line),
               button: b && b.textContent, expanded: b && b.getAttribute('aria-expanded'), whole: p.textContent.length > 300 };
    });
    let L = await lede();
    check('Station Health\'s introduction is two lines deep, with More about this tab — and all of it still in the page',
      L.folded && L.lines <= 2 && L.button === 'More about this tab' && L.expanded === 'false' && L.whole, J(L));
    await page.click('.lede-more');
    L = await lede();
    check('More opens it, and says so', L.lines > 2 && L.button === 'Less' && L.expanded === 'true', J(L));
    await page.evaluate(() => { switchTab('sitemap'); switchTab('health'); Health.demo(); });
    await page.waitForSelector('.hl-verdict', { timeout: 15_000 });
    L = await lede();
    check('…and it stays open on that tab when the tab is opened again', L.folded && L.lines > 2 && L.button === 'Less', J(L));
    const short = await page.evaluate(() => { switchTab('maps'); return !document.querySelector('#main-content .lede-fold'); });
    check('a tab that opens with a short line is left as it is (Radio Path Maps)', short);
    await page.evaluate(() => { switchTab('health'); Health.demo(); });
    await page.waitForSelector('.hl-verdict', { timeout: 15_000 });
    const V = await page.evaluate(() => {
      const t = document.querySelector('.hl-verdict').textContent.replace(/\s+/g, ' ');
      const tiles = [...document.querySelectorAll('.hl-kpis .qs-chip')];
      const attn = tiles.find(c => /Need attention/.test(c.textContent));
      return { t, attn: attn && attn.querySelector('.qs-chip-v').textContent,
               above: !!(document.querySelector('.hl-verdict').compareDocumentPosition(document.querySelector('.hl-kpis')) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    check('the answer in a sentence above the numbers, its count the Need attention tile\'s',
      V.above && new RegExp(`^${V.attn} findings? needs? attention`).test(V.t) && /critical/.test(V.t) && /% of the checks due came in/.test(V.t), J(V));
    await page.click('.hl-verdict .link-btn');
    check('See them goes down to Needs attention, its heading in focus',
      await page.evaluate(() => document.activeElement && document.activeElement.id === 'hl-h-attn'));
    await page.evaluate(() => Looks.set('classic'));
    await page.evaluate(() => Health.demo());
    await page.waitForSelector('.hl-kpis', { timeout: 15_000 });
    const classic = await page.evaluate(() => ({ verdict: !!document.querySelector('.hl-verdict'),
      fold: !!document.querySelector('.lede-fold'), more: !!document.querySelector('.lede-more') }));
    check('Classic: the whole introduction and the numbers alone, as before', !classic.verdict && !classic.fold && !classic.more, J(classic));
    await context.close();

    // ── 8. Every tab ───────────────────────────────────────────────────────
    log('\n8. Every tab, in Calm\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 }, errors }));
    await page.evaluate(() => { Auth.isSignedIn = () => true; Auth.isAdmin = () => true; Auth.role = () => 'admin'; renderTabs(); });
    const ids = await page.evaluate(() => TAB_LIST.map(t => t.id));
    const bad = [];
    let unresolved = [];
    for (const id of ids) {
      const before = errors.length;
      await page.evaluate(t => switchTab(t), id);
      await page.waitForTimeout(SETTLE);
      const row = await page.evaluate(t => document.querySelector('#section-bar .tab-btn[aria-current="page"]')?.dataset.tab === t, id);
      if (errors.length > before || !row) bad.push(id);
      const audit = await auditHandlers(page);
      unresolved = unresolved.concat(audit.unresolved.map(u => `${id}: ${u.path || J(u)}`));
    }
    check(`all ${ids.length} tabs open in Calm, each with its button the page in the row, and a clean console`, !bad.length, bad.join(', '));
    check('every on*= handler on every one of them resolves', !unresolved.length, unresolved.slice(0, 5).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — the Calm look: the default, its bar and row, ⋯, the way back, a phone's foot, Nearby, the stepped sheet, folded introductions and Station Health's answer first (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
