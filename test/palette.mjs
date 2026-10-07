// Ctrl/Cmd+K and 🔎 Search (palette.js, #221), driven in a real browser.
//
//   1. **Opening it** — the chord from any tab and the banner's button open
//      one dialog, the cursor in a box that is an ARIA combobox over a
//      listbox; with nothing typed it offers the stations looked at this
//      session and the actions; Escape closes it and hands focus back.
//   2. **Stations** — through the Stations filter's own matching: "mount
//      archer" finds Mt Archer AL (the abbreviation table), a station number
//      ranks its station first, an address window offers every station in it
//      as the Stations list's filter. Enter opens a station from another tab
//      as one step in the browser's history, its card up — and back returns.
//   3. **The keyboard** — ↓ and ↑ move the marked option and the box's
//      aria-activedescendant with it, wrapping; the mark says ↵; the count is
//      said in a status line.
//   4. **Places, tabs and actions** — a name goes to 📍 Find a place with the
//      text in its box; a coordinate moves the map there; "council" opens Site
//      Maintenance; an action runs; nothing matching says so.
//
// Why a check of its own: every failure here is a list that looks fine. A
// station ranked below its namesakes, an arrow key that moves the highlight
// but not what Enter opens, a pick that leaves two history steps, a place
// typed into a box that is not there — none of them throws.
//
// Run:  npm run palette
//       npm run palette -- -v

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

// Every history call, counted (as test/links.mjs does): one pick, one step.
const COUNT_STEPS = () => {
  window.__steps = { push: 0 };
  const push = history.pushState.bind(history);
  history.pushState = (...a) => { window.__steps.push++; return push(...a); };
};

// What the dialog shows.
const look = page => page.evaluate(() => {
  const box = document.getElementById('pal-q');
  const opts = [...document.querySelectorAll('#pal-list [role="option"]')];
  const groups = [...document.querySelectorAll('#pal-list .pal-group-title')].map(g => g.textContent.trim());
  const on = opts.find(o => o.getAttribute('aria-selected') === 'true');
  return {
    open: !!box,
    focused: document.activeElement === box,
    role: box && box.getAttribute('role'),
    controls: box && box.getAttribute('aria-controls'),
    listbox: (document.getElementById(box && box.getAttribute('aria-controls')) || {}).getAttribute
      ? document.getElementById(box.getAttribute('aria-controls')).getAttribute('role') : null,
    descendant: box && box.getAttribute('aria-activedescendant'),
    activeId: on ? on.id : null,
    activeLabel: on ? on.querySelector('.pal-label').textContent : null,
    activeEnter: on ? !!on.querySelector('.pal-enter') : false,
    marked: opts.filter(o => o.classList.contains('is-active')).length,
    labels: opts.map(o => o.querySelector('.pal-label').textContent),
    groups,
    count: (document.getElementById('pal-count') || {}).textContent || '',
    none: (document.querySelector('#pal-list .pal-none') || {}).textContent || '',
  };
});

async function type(page, text) {
  await page.fill('#pal-q', text);
  await page.waitForTimeout(60);
  return look(page);
}

async function openWithChord(page) {
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pal-q', null, { timeout: 5_000 });
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
    const page = await context.newPage();
    await page.addInitScript(COUNT_STEPS);
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(String(e)));
    // On Stations by name: a first visit's bare address is the Site Map (#222).
    await page.goto(server.url('/index.html?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && !!state.map, null, { timeout: LOAD_TIMEOUT });

    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Opening it\n');
    await page.click('#btn-palette');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pal-q', null, { timeout: 5_000 });
    let L = await look(page);
    check('🔎 Search in the banner opens it, the cursor in its box', L.open && L.focused);
    check('the box is a combobox over a listbox', L.role === 'combobox' && L.controls === 'pal-list' && L.listbox === 'listbox', J(L));
    check('with nothing typed and nothing looked at: the actions, the first marked',
      L.groups.join('|') === 'Actions' && L.marked === 1 && L.descendant === L.activeId && L.activeEnter, J(L));
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({ open: !!document.getElementById('pal-q'),
      focus: document.activeElement && document.activeElement.id }));
    check('Escape closes it and hands focus back to the button', !closed.open && closed.focus === 'btn-palette', J(closed));

    // A station looked at becomes the first offer.
    await page.evaluate(() => showStationCard('loudoun_br_al'));
    await openWithChord(page);
    L = await look(page);
    check('Ctrl+K opens it; with nothing typed it offers the stations looked at this session, first',
      L.groups[0] === 'Looked at this session' && L.labels[0] === 'Loudoun Br AL', J(L.groups));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Stations\n');
    L = await type(page, 'mount archer');
    check('"mount archer" finds Mt Archer AL — the filter\'s own abbreviations', L.labels.includes('Mt Archer AL'), J(L.labels));
    L = await type(page, '541155');
    check('a station number puts its station first', L.labels[0] === 'Loudoun Br AL' && L.activeLabel === 'Loudoun Br AL', J(L.labels.slice(0, 3)));
    L = await type(page, 'gatton');
    check('a name ranks the ones that start with it first', L.labels[0].startsWith('Gatton') && L.groups[0] === 'Stations', J(L.labels.slice(0, 4)));
    L = await type(page, '4021-4025');
    const all = L.labels.find(x => /^All \d+ matching stations$/.test(x));
    check('an address window offers every station in it, as the list\'s filter', !!all, J(L.labels));
    await page.keyboard.press('Escape');

    // From another tab: one step, the card up, and back returns.
    await page.evaluate(() => switchTab('health'));
    const before = await page.evaluate(() => window.__steps.push);
    await openWithChord(page);
    await type(page, '541155');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.activeTab === 'stations' && state.stnCard.id === 'loudoun_br_al', null, { timeout: LOAD_TIMEOUT });
    const went = await page.evaluate(() => ({ push: window.__steps.push, tab: state.activeTab, card: state.stnCard.id,
      station: new URLSearchParams(location.search).get('station'), open: !!document.getElementById('pal-q') }));
    check('Enter opens the station from another tab: its card up, the address naming it, the dialog gone',
      went.card === 'loudoun_br_al' && went.station === 'loudoun_br_al' && !went.open, J(went));
    check('…as one step in the browser\'s history', went.push === before + 1, J({ before, after: went.push }));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => state.activeTab === 'health', null, { timeout: 10_000 });
    check('back returns to the tab it was opened from', true);

    // The window, opened.
    await openWithChord(page);
    L = await type(page, '4021-4025');
    const allIdx = L.labels.findIndex(x => /^All \d+ matching stations$/.test(x));
    for (let i = 0; i < allIdx; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.activeTab === 'stations' && !!state.map, null, { timeout: LOAD_TIMEOUT });
    const filtered = await page.evaluate(() => ({ text: state.filters.searches.map(r => r.text).join('|'), n: filteredStations().length }));
    check('"All N matching stations" puts the window in the Stations filter',
      filtered.text === '4021-4025' && filtered.n === Number(all.match(/\d+/)[0]), J(filtered));
    await page.evaluate(() => { resetStationFilters(); renderMain(); });
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The keyboard\n');
    await openWithChord(page);
    L = await type(page, 'gatton');
    const first = L.activeId;
    await page.keyboard.press('ArrowDown');
    let M = await look(page);
    check('↓ moves the mark and aria-activedescendant together', M.activeId !== first && M.descendant === M.activeId
      && M.marked === 1 && M.activeEnter, J({ first, now: M.activeId, d: M.descendant }));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    M = await look(page);
    check('↑ past the top wraps to the bottom', M.activeLabel === M.labels[M.labels.length - 1], J({ at: M.activeLabel, last: M.labels[M.labels.length - 1] }));
    check('the count is said in a status line', /\d+ stations?/.test(M.count), M.count);
    L = await type(page, 'zzqxw');
    check('nothing matching says so — offering only to look for it as a place',
      /Nothing matches/.test(L.none) && /Nothing matches/.test(L.count)
        && L.labels.length === 1 && L.labels[0] === 'Find “zzqxw” as a place', J({ none: L.none, count: L.count, labels: L.labels }));
    await page.keyboard.press('Escape');

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. Places, tabs and actions\n');
    await openWithChord(page);
    L = await type(page, 'Lockyer');
    const placeAt = L.labels.findIndex(x => x === 'Find “Lockyer” as a place');
    check('a name is offered as a place', placeAt >= 0 && L.groups.includes('Places'), J(L.labels));
    await page.click(`#pal-opt-${placeAt}`);
    await page.waitForFunction(() => (document.getElementById('places-q') || {}).value === 'Lockyer', null, { timeout: 10_000 });
    const pl = await page.evaluate(() => ({ dock: dockShowing(), q: document.getElementById('places-q').value,
      focus: document.activeElement && document.activeElement.id }));
    check('a click on it opens 📍 Find a place with the text in its box, the cursor there',
      pl.dock === 'places' && pl.q === 'Lockyer' && pl.focus === 'places-q', J(pl));

    await openWithChord(page);
    L = await type(page, '-27.4705, 153.0260');
    check('a coordinate is offered as a place to go to', /^Go to -27\.47/.test(L.labels[0] || '') && L.groups[0] === 'Places', J(L.labels));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const c = state.map.getCenter(); return Math.abs(c.lat + 27.4705) < 0.01 && Math.abs(c.lng - 153.026) < 0.01; },
      null, { timeout: 10_000 }).then(() => check('…and Enter takes the map there', true),
      () => check('…and Enter takes the map there', false, J(null)));

    await openWithChord(page);
    L = await type(page, 'council');
    check('"council" finds Site Maintenance among the tabs', L.labels.includes('Site Maintenance') && L.groups.includes('Tabs'), J(L.labels));
    const tabAt = L.labels.indexOf('Site Maintenance');
    for (let i = 0; i < tabAt; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.activeTab === 'maintenance', null, { timeout: 10_000 });
    check('…and Enter opens it', true);

    await openWithChord(page);
    const themeBefore = await page.evaluate(() => state.theme);
    L = await type(page, 'theme');
    check('an action is found by what it does', /^Switch to the (dark|light) theme$/.test(L.labels[0] || ''), J(L.labels));
    await page.keyboard.press('Enter');
    check('…and Enter runs it', (await page.evaluate(() => state.theme)) !== themeBefore);
    await page.evaluate(() => toggleTheme());

    await openWithChord(page);
    await type(page, 'copy link');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const copied = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), here: location.href }));
    check('"Copy a link to where you are" copies the address', copied.clip === copied.here, J(copied));

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
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
  log('\nPASS — Ctrl+K finds a station, a place, a tab or an action from anywhere, and\n'
    + '       opens what it found in one step.');
}

main().catch(err => { console.error(err); process.exit(1); });
