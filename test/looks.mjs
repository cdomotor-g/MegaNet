// The three looks drawn in pictures (looks.js): 🔲 Tiles, 🎚️ Instrument and
// 🪧 Signs — their pictograms (glyphs.js), 🏠 Home (home.js), and what each
// does to the shell it shares with Calm. calm.mjs holds that shell itself;
// this holds what the three add to it, and that each is one pick from the
// rest:
//
//   1. **The choice.** The Theme dialog lists five looks, Calm first and
//      Classic last; a pick applies at once, wears its own data-look and
//      Calm's data-shell (Classic its own), and is remembered; Ctrl+K finds
//      each other look by its word.
//   2. **Every picture.** Every tab, group and inspection section has a
//      drawing of its own, and every drawing named is one there is.
//   3. **Home.** The six big tiles, then every other tab once, under its
//      group; a tile opens its tab; the counts are dashes until Station
//      Health has answered, then the numbers, with how many need a look on
//      Health's tile.
//   4. **Tiles.** The groups wear their pictures on their colours, the banner
//      its pictograms and 🏠 — put back to the emoji in Calm; the map on the
//      Light ground; a phone's foot Home, Nearby, Look, Map, Visits.
//   5. **Instrument.** A dark banner in the light theme, the rail shrunk to
//      its pictures, the counts across the banner (and nowhere else), the map
//      on the Dark ground with its pins coloured by health — unless the
//      switch was turned off — and not under Calm.
//   6. **Signs.** Larger type, black and yellow for the button that acts, the
//      street map; on a phone the inspection sheet's sections a row of signs,
//      each one a way to its section.
//   7. **Classic untouched.** No counts, no 🏠, the emoji back.
//   8. **The pages that matter, in each.** Home, Stations, Nearby, Health and
//      Inspections open in each of the three with a clean console, and every
//      on*= handler on Home resolves.
//
// Run:  npm run looks
//       npm run looks -- -v    also print what passed

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

// The inspection form's reference tables, as calm.mjs serves them.
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

async function open(browser, server, { viewport, storage = null, errors }) {
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
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(SETTLE);
  return { context, page };
}

// What the shell shows, read off the page.
const shell = page => page.evaluate(() => {
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const icoOf = id => {
    const i = document.querySelector(`#${id} > .hdr-ico`);
    return !i ? null : i.querySelector('svg.gl') ? 'gl' : i.textContent.trim();
  };
  return {
    look: document.documentElement.getAttribute('data-look'),
    shell: document.documentElement.getAttribute('data-shell'),
    tiles: [...document.querySelectorAll('#tab-nav .nav-sec')].filter(vis).map(b => !!b.querySelector('.gl-tile')),
    calmIco: !!document.querySelector('#tab-nav .nav-sec .calm-ico'),
    home: vis(document.getElementById('btn-home')),
    homeOn: document.getElementById('btn-home').getAttribute('aria-current'),
    status: vis(document.getElementById('hdr-status'))
      ? [...document.querySelectorAll('#hdr-status .hm-chip')].map(c => c.dataset.status) : null,
    ico: Object.fromEntries(['btn-palette', 'btn-auth', 'btn-more', 'btn-home'].map(id => [id, icoOf(id)])),
    field: [...document.querySelectorAll('.field-bar .field-btn')].filter(vis).map(b => b.dataset.field),
    collapsed: state.navCollapsed,
    tab: state.activeTab,
  };
});

// The lightness of an element's background, 0–1 (rgb only).
const lightness = (page, sel) => page.evaluate(s => {
  const m = getComputedStyle(document.querySelector(s)).backgroundColor.match(/\d+(\.\d+)?/g);
  return m ? (Number(m[0]) * 0.299 + Number(m[1]) * 0.587 + Number(m[2]) * 0.114) / 255 : null;
}, sel);

// The Stations map's base, as the map has it.
const base = page => page.evaluate(() => state.map && state.map.mnBaseName);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];

  try {
    // ── 1. The choice ──────────────────────────────────────────────────────
    log('\n1. Five looks, each one pick away\n');
    let { context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-tab': 'sitemap', 'mn-look-intro': 'seen' }, errors });
    await page.evaluate(() => openThemeMenu());
    const dlg = await page.evaluate(() => [...document.querySelectorAll('#look-pick input')].map(r => r.value + (r.checked ? '*' : '')));
    check('the Theme dialog lists the five, Calm picked', J(dlg) === J(['calm*', 'tiles', 'instrument', 'signs', 'classic']), J(dlg));
    for (const id of ['tiles', 'instrument', 'signs']) {
      await page.click(`#look-pick input[value="${id}"]`);
      await page.waitForTimeout(SETTLE);
      const S = await shell(page);
      const said = await page.evaluate(() => document.getElementById('app-status').textContent);
      check(`${id}: applies at once, on Calm's shell, remembered and said`,
        S.look === id && S.shell === 'calm' && await page.evaluate(() => localStorage.getItem('mn-look')) === id
        && said === `Look: ${await page.evaluate(i => Looks.label(i), id)}`, J({ S: { look: S.look, shell: S.shell }, said }));
    }
    await page.click('#look-pick input[value="classic"]');
    await page.waitForTimeout(SETTLE);
    check('Classic wears its own shell', (await shell(page)).shell === 'classic');
    await page.keyboard.press('Escape');
    const words = await page.evaluate(() => ({
      tiles: Palette.results('tiles look').filter(x => x.kind === 'action').map(x => x.label),
      instrument: Palette.results('instrument').filter(x => x.kind === 'action').map(x => x.label),
      signs: Palette.results('high contrast signs').filter(x => x.kind === 'action').map(x => x.label),
    }));
    check('Ctrl+K finds each of the three by its word',
      /Tiles/.test(words.tiles[0] || '') && /Instrument/.test(words.instrument[0] || '') && /Signs/.test(words.signs[0] || ''), J(words));
    await context.close();

    // ── 2. Every picture ───────────────────────────────────────────────────
    log('\n2. A picture for everything\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-look': 'tiles', 'mn-tab': 'sitemap' }, errors }));
    const pics = await page.evaluate(() => ({
      noTab: TAB_LIST.map(t => t.id).filter(id => !Glyphs.TAB[id]),
      noGroup: TABS.map(g => g.group).filter(g => !Glyphs.GROUP[g]),
      unknown: [...Object.values(Glyphs.TAB), ...Object.values(Glyphs.GROUP).map(g => g[0]), ...Object.values(Glyphs.SECTION)]
        .filter(n => !Glyphs.has(n)),
      hues: Object.values(Glyphs.GROUP).map(g => g[1]).filter(h => !Glyphs.HUES.includes(h)),
    }));
    check('every tab and every group has a picture of its own', !pics.noTab.length && !pics.noGroup.length, J(pics));
    check('…and every picture named is one there is, in one of the six colours', !pics.unknown.length && !pics.hues.length, J(pics));

    // ── 3. Home ────────────────────────────────────────────────────────────
    log('\n3. 🏠 Home\n');
    await page.evaluate(() => switchTab('home'));
    await page.waitForTimeout(SETTLE);
    const H = await page.evaluate(() => ({
      big: [...document.querySelectorAll('.hm-big')].map(b => b.dataset.go),
      small: [...document.querySelectorAll('.hm-small')].map(b => b.dataset.go),
      shown: TAB_LIST.filter(t => tabShown(t)).map(t => t.id),
      dash: [...document.querySelectorAll('.hm-status .hm-chip strong')].map(s => s.textContent),
      first: TABS[0].tabs[0].id,
    }));
    const every = new Set([...H.big, ...H.small, 'home']);
    check('Home heads Start here', H.first === 'home');
    check('six big tiles — Map, Nearby, Health, Inspect, Camera, Look Around',
      J(H.big) === J(['stations', 'nearby', 'health', 'inspections', 'camera', 'lookaround']), J(H.big));
    check('…then every other tab once', H.small.length + H.big.length + 1 === H.shown.length
      && H.shown.every(id => every.has(id)), J({ small: H.small.length, big: H.big.length, shown: H.shown.length }));
    check('a count Station Health has not answered is a dash, not a nought', H.dash.length === 3 && H.dash.every(d => d === '—'), J(H.dash));
    await page.evaluate(() => {
      HealthGlance.counts = () => ({ status: 'ok', okAt: Date.now(), denied: false, error: '', ok: 1049, watch: 12, fault: 7, nodata: 3, total: 1071 });
      renderMain();
    });
    await page.waitForTimeout(SETTLE);
    const counted = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.hm-status .hm-chip strong')].map(s => s.textContent),
      badge: document.querySelector('.hm-big[data-go="health"] .hm-badge')?.firstChild?.textContent || null,
      name: document.querySelector('.hm-status .hm-chip[data-status="fault"]').getAttribute('aria-label'),
    }));
    check('answered: the numbers, and how many need a look on Health\'s tile',
      J(counted.chips) === J(['1,049', '12', '7']) && counted.badge === '19' && /7 stations at fault/.test(counted.name), J(counted));
    await page.click('.hm-big[data-go="nearby"]');
    await page.waitForTimeout(SETTLE);
    check('a tile opens its tab', await page.evaluate(() => state.activeTab) === 'nearby');

    // ── 4. Tiles ───────────────────────────────────────────────────────────
    log('\n4. 🔲 Tiles\n');
    await page.click('#btn-home');
    await page.waitForTimeout(SETTLE);
    let S = await shell(page);
    check('🏠 in the banner goes Home, and says it is there', S.tab === 'home' && S.home && S.homeOn === 'page', J(S));
    check('every group in the bar wears its picture on its colour', S.tiles.length > 5 && S.tiles.every(Boolean) && !S.calmIco, J(S.tiles));
    check('the banner\'s buttons wear pictograms', Object.values(S.ico).every(v => v === 'gl'), J(S.ico));
    await page.evaluate(() => switchTab('stations'));
    await page.waitForTimeout(1500);
    check('the map on the Light ground', await base(page) === 'Light', J(await base(page)));
    await page.evaluate(() => Looks.set('calm'));
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('…and Calm puts the line drawings and the emoji back, and 🏠 away',
      S.calmIco && !S.home && S.ico['btn-palette'] === '🔎' && S.ico['btn-more'] === '⋯', J(S));
    await context.close();

    ({ context, page } = await open(browser, server, { viewport: { width: 390, height: 844 },
      storage: { 'mn-look': 'tiles', 'mn-tab': 'sitemap' }, errors }));
    S = await shell(page);
    check('a phone\'s foot: Home, Nearby, Look, Map, Visits and More', J(S.field) === J(['home', 'nearby', 'look', 'map', 'visits', 'more']), J(S.field));
    await page.click('.field-bar [data-field="home"]');
    await page.waitForTimeout(SETTLE);
    const fit = await page.evaluate(() => ({ tab: state.activeTab, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    check('…Home opens Home, which fits the phone\'s width', fit.tab === 'home' && fit.over <= 0, J(fit));
    await context.close();

    // ── 5. Instrument ──────────────────────────────────────────────────────
    log('\n5. 🎚️ Instrument\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-look': 'instrument', 'mn-tab': 'sitemap', 'mn-theme': 'light' }, errors }));
    S = await shell(page);
    check('the counts across the banner, OK, on watch and at fault', J(S.status) === J(['ok', 'watch', 'fault']), J(S.status));
    check('the rail shrunk to its pictures, and no 🏠', S.collapsed && S.tiles.every(Boolean) && !S.home, J(S));
    const dark = { banner: await lightness(page, 'header'), rail: await lightness(page, '#tab-nav'), page: await lightness(page, 'body') };
    check('a dark frame in the light theme, round a light page', dark.banner < 0.2 && dark.rail < 0.2 && dark.page > 0.8, J(dark));
    const pins = await page.evaluate(() => ({ health: state.mapHealth, stored: localStorage.getItem('mn-map-health') }));
    check('the pins coloured by health, with nothing stored', pins.health === true && pins.stored === null, J(pins));
    await page.evaluate(() => switchTab('stations'));
    await page.waitForTimeout(1500);
    check('the map on the Dark ground', await base(page) === 'Dark', J(await base(page)));
    await page.evaluate(() => Looks.set('calm'));
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('Calm: no counts in the banner, and the pins in their roles\' colours again',
      S.status === null && await page.evaluate(() => state.mapHealth) === false, J(S.status));
    await page.evaluate(() => { localStorage.setItem('mn-map-health', 'off'); Looks.set('instrument'); });
    await page.waitForTimeout(SETTLE);
    check('a switch turned off stays off under Instrument', await page.evaluate(() => state.mapHealth) === false);
    await context.close();

    // ── 6. Signs ───────────────────────────────────────────────────────────
    log('\n6. 🪧 Signs\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-look': 'signs', 'mn-tab': 'stations', 'mn-theme': 'light' }, errors }));
    await page.waitForTimeout(1200);
    const big = await page.evaluate(() => ({
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      primary: (() => { const b = document.createElement('button'); b.className = 'primary'; document.body.append(b);
        const c = getComputedStyle(b); const out = [c.backgroundColor, c.color]; b.remove(); return out; })(),
    }));
    check('larger type, and the button that acts black on yellow',
      big.root > 16.5 && J(big.primary) === J(['rgb(17, 17, 17)', 'rgb(250, 204, 21)']), J(big));
    check('the map on the street map', await base(page) === 'OpenStreetMap', J(await base(page)));
    await context.close();

    ({ context, page } = await open(browser, server, { viewport: { width: 390, height: 844 },
      storage: { 'mn-look': 'signs', 'mn-tab': 'sitemap', 'mn-look-intro': 'seen',
                 'mn-map-view': JSON.stringify({ lat: -27.99, lng: 152.68, zoom: 10 }) }, errors }));
    S = await shell(page);
    check('a phone\'s foot as Tiles\'', J(S.field) === J(['home', 'nearby', 'look', 'map', 'visits', 'more']), J(S.field));
    await page.click('.field-bar [data-field="nearby"]');
    await page.waitForTimeout(SETTLE);
    await page.click('#nb-map');
    await page.waitForTimeout(SETTLE);
    await page.click('.nb-row >> nth=0');
    await page.waitForTimeout(SETTLE);
    check('a station in Nearby says whether it is reporting', await page.evaluate(() => !!document.querySelector('.nb-stn .stn-card-health')));
    await page.click('.nb-big');
    await page.waitForFunction(() => state.activeTab === 'inspections' && !!document.querySelector('.insp-steps'), null, { timeout: 15_000 });
    const signs = () => page.evaluate(() => ({
      signs: document.querySelectorAll('.insp-sign').length,
      sections: document.querySelectorAll('.insp-section').length,
      on: [...document.querySelectorAll('.insp-sign')].findIndex(b => b.getAttribute('aria-current') === 'step'),
      shown: [...document.querySelectorAll('.insp-section')].findIndex(s => !s.hidden),
      pictures: [...document.querySelectorAll('.insp-sign')].every(b => b.querySelector('svg.gl')),
      next: !!document.querySelector('.insp-step-nav .primary svg.gl'),
    }));
    let G = await signs();
    check('the sheet\'s sections a row of signs, one each, a picture on each, the first marked',
      G.signs === G.sections && G.signs > 3 && G.on === 0 && G.shown === 0 && G.pictures && G.next, J(G));
    await page.click('.insp-sign >> nth=2');
    await page.waitForTimeout(SETTLE);
    G = await signs();
    check('a sign pressed opens its section, and is marked', G.on === 2 && G.shown === 2, J(G));
    await context.close();

    // ── 7. Classic ─────────────────────────────────────────────────────────
    log('\n7. Classic untouched\n');
    ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
      storage: { 'mn-look': 'instrument', 'mn-tab': 'sitemap' }, errors }));
    await page.evaluate(() => Looks.set('classic'));
    await page.waitForTimeout(SETTLE);
    S = await shell(page);
    check('no counts, no 🏠, and the emoji back', S.status === null && !S.home
      && S.ico['btn-palette'] === '🔎' && S.ico['btn-auth'] === '🔑', J(S));
    await context.close();

    // ── 8. The pages that matter ───────────────────────────────────────────
    log('\n8. The pages that matter, in each\n');
    for (const id of ['tiles', 'instrument', 'signs']) {
      ({ context, page } = await open(browser, server, { viewport: { width: 1440, height: 900 },
        storage: { 'mn-look': id, 'mn-tab': 'sitemap', 'mn-look-intro': 'seen' }, errors }));
      const bad = [];
      for (const tab of ['home', 'stations', 'nearby', 'health', 'inspections']) {
        const before = errors.length;
        await page.evaluate(t => switchTab(t), tab);
        await page.waitForTimeout(tab === 'stations' ? 1200 : SETTLE);
        if (errors.length > before) bad.push(tab);
      }
      await page.evaluate(() => switchTab('home'));
      await page.waitForTimeout(SETTLE);
      const audit = await auditHandlers(page);
      check(`${id}: Home, Stations, Nearby, Health and Inspections open with a clean console, and Home's handlers resolve`,
        !bad.length && !audit.unresolved.length, J({ bad, unresolved: audit.unresolved.slice(0, 3) }));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — the looks in pictures: five to choose from, a picture for everything, Home, Tiles, Instrument, Signs and Classic untouched (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
