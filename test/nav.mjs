// The left nav: grouping, coverage and who sees what (#108), under Calm.
// (The find box in the bar was Classic's, retired: archive/classic/test/nav.mjs.)
//
// `npm run smoke` opens all twenty tabs and asserts each one renders, but it
// opens them by calling `switchTab(id)` — it never touches the nav. So the whole
// of #108 is invisible to it. A tab could be missing from `TABS`' groups, or
// rendered into no group at all, or filtered permanently out of the list by the
// find box, and smoke would stay green the entire time: it does not need the nav
// to reach a tab, and a user has nothing else.
//
// Four things are checked here, and each exists because nothing else can see it:
//
//   Coverage.      Every tab in TAB_LIST has exactly one button in the nav, under
//                  exactly one heading. This is the assertion that makes "keeping
//                  every existing tab reachable" — #108's one hard requirement —
//                  a checked claim rather than a promise in a commit message.
//
//   The find box.  A filter is the one control that can *remove* the route to a
//                  tab, so every tab has to be findable by its own label, and the
//                  words #108 asks about by name ("the packet decoder", "the RF
//                  Environment view") have to land on the tab they describe. The
//                  probe table below is that question, written down.
//
//   Its rule.      Best score wins: the tabs matching the most of the typed terms
//                  are the ones shown. That has to narrow as you type, survive a
//                  word that is on no tab at all, and still return nothing for a
//                  query that means nothing. This file wrote the rule — the first
//                  version required every term to match, and the probe for
//                  #108's own "the RF Environment view" is what failed it.
//
//   Its exits.     Picking a tab clears the query, and so does collapsing to the
//                  rail. A filter left running behind a nav that cannot show its
//                  own box is a nav that has silently lost fifteen tabs.
//
//   Who sees what. A tab marked `who` (tabShown, core.js) is listed to the
//                  people it is for and to nobody else — not in the bar, the
//                  find box, Ctrl+K or the Site Map: `who: 'admin'` to an
//                  administrator, `who: 'a2plan'` to the ALERT2 Transition
//                  Plan's list (0076), administrators or not, and `who:
//                  'tasks'` to administrators and the people on a team (0095).
//                  So the coverage above runs as an administrator on that list,
//                  where every tab is listed, and the end of the file checks
//                  the other half — an administrator off the list among them,
//                  and somebody on a team who is nothing else.
//
// Run:  npm run nav
//       npm run nav -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// What somebody would type, and the tab they mean by it. Two of these are
// #108's own examples; the rest are the cases the label alone cannot serve —
// the job rather than the name ("com port"), the vendor ("contrail", "elpro"),
// the artefact ("pdf"), and the two labels this issue changed, which have to
// keep working under the names people already learnt.
const PROBES = [
  { q: 'packet decoder',        want: 'packets',     why: "#108's own example" },
  { q: 'rf environment',        want: 'rf',          why: "#108's own example" },
  { q: 'the rf environment view', want: 'rf',        why: 'a sentence, not a keyword' },
  { q: 'com port',              want: 'serial',      why: 'the job, not the label' },
  { q: 'contrail',              want: 'arro',        why: 'the vendor name' },
  { q: 'elpro',                 want: 'alert2',      why: 'the vendor name' },
  { q: 'pdf',                   want: 'maps',        why: 'the artefact' },
  { q: 'council',               want: 'maintenance', why: 'the form owner' },
  { q: 'network view',          want: 'network',     why: 'the old label, after the rename' },
  { q: 'network maps',          want: 'maps',        why: 'the old label, after the rename' },
  { q: 'orphan',                want: 'passranges',  why: 'a term from the tab, not its title' },
  { q: 'allocate address',      want: 'passranges',  why: 'the job, not the label' },
  { q: 'radio mobile',          want: 'export',      why: 'what the output is for' },
  { q: 'guide',                 want: 'sitemap',     why: 'what a newcomer looks for' },
  { q: 'what does each tab do', want: 'sitemap',     why: 'the question, typed as asked' },
  { q: 'install',               want: 'offline',     why: 'the job, not the label' },
  { q: 'no signal',             want: 'offline',     why: 'the situation, typed as said' },
  { q: 'home screen',           want: 'offline',     why: 'where it ends up' },
  { q: 'sort forum',            want: 'tasks',       why: 'where the forum\'s jobs go (0095)' },
  { q: 'todo',                  want: 'tasks',       why: 'the job list, typed as one word' },
];

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // The nav starts expanded at 1440 px unless a stored preference says otherwise;
  // this context is fresh, so it is expanded. Said out loud because every
  // assertion below about the find box depends on it.
  await page.evaluate(() => setNavCollapsed(false));

  // An administrator on the plan's list, as whoami() would say: every tab is
  // listed to one, so "every tab is in the nav" is a claim about this session.
  // The other kinds of session are checked at the end.
  await page.evaluate(() => {
    window.__auth = { isSignedIn: Auth.isSignedIn, isAdmin: Auth.isAdmin, role: Auth.role, a2plan: Auth.a2plan, tasks: Auth.tasks };
    Auth.isSignedIn = () => true; Auth.isAdmin = () => true; Auth.role = () => 'admin'; Auth.a2plan = () => true; Auth.tasks = () => true;
    renderTabs();
  });

  // ── Coverage ──────────────────────────────────────────────────────────────
  console.log('\nCoverage — every tab is in the nav, once, under one heading\n');

  const shape = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#tab-nav .calm-sec')].map(g => ({
      heading: g.querySelector('.nav-sec .nav-label')?.textContent || '',
      labelled: g.getAttribute('aria-labelledby') === g.querySelector('.nav-sec')?.id,
      tabs: [...g.querySelectorAll('.tab-btn')].map(b => b.dataset.tab),
    }));
    const bar = TABS.flatMap(g => g.tabs.filter(tabInBar));
    return {
      groups,
      declared: TABS.map(g => ({ group: g.group, ids: g.tabs.flatMap(t => [t.id, ...(t.parts || []).map(p => p.id)]) })),
      labels: TAB_LIST.map(t => t.label),
      ids: TAB_LIST.map(t => t.id),
      barIds: bar.map(t => t.id),
      // A view (core.js, `parts`) is reached through its host's strip, and a
      // tab out of the bar (`bar: false`) through the banner or a menu.
      orphans: TAB_LIST.filter(t => t.partOf && !bar.some(b => b.id === t.partOf)).map(t => t.id),
      offBar: TAB_LIST.filter(t => !t.partOf && t.bar === false).map(t => t.id),
      offline: !!document.querySelector('#btn-offline[onclick*="offline"]'),
      viewsMenu: typeof viewsPickHtml === 'function',
    };
  });

  // The bar lists every tab that is not a view of another, and not one of
  // the two reached from the banner instead (November 2026): a view is a
  // button in its tab's strip across the top of the page, checked below.
  const rendered = shape.groups.flatMap(g => g.tabs);
  check(`all ${shape.barIds.length} tabs in the bar render a button`,
    rendered.length === shape.barIds.length,
    `${rendered.length} button(s) for ${shape.barIds.length} tab(s)`);

  const missing = shape.barIds.filter(id => !rendered.includes(id));
  check('and every one of them is a tab from TABS', missing.length === 0,
    missing.length ? `not in the nav: ${missing.join(', ')}` : '');

  check('no tab is rendered twice', new Set(rendered).size === rendered.length,
    rendered.length !== new Set(rendered).size
      ? `duplicated: ${rendered.filter((l, i) => rendered.indexOf(l) !== i).join(', ')}` : '');

  check('every view is a view of a tab the bar lists', shape.orphans.length === 0, shape.orphans.join(', '));
  check('the tabs out of the bar are Offline & Install, from 📲 in the banner, and Views, from Theme & layout',
    shape.offBar.join(',') === 'offline,views' && shape.offline && shape.viewsMenu,
    `${shape.offBar.join(', ')}; 📲 ${shape.offline}; menu ${shape.viewsMenu}`);

  // Each view's strip: a button for every view of its tab, the open one
  // marked, and each one opening its own view.
  const strips = await page.evaluate(() => {
    const out = [];
    for (const host of TABS.flatMap(g => g.tabs).filter(t => (t.parts || []).length)) {
      for (const v of [host, ...host.parts]) {
        switchTab(v.id);
        const s = document.querySelector('#main-content > #view-strip');
        const btns = s ? [...s.querySelectorAll('.view-btn')] : [];
        const on = btns.filter(b => b.getAttribute('aria-current') === 'page').map(b => b.dataset.view);
        const lit = document.querySelector('#tab-nav .tab-btn.active');
        out.push({ id: v.id, ok: !!s && btns.length === host.parts.length + 1 && on.length === 1 && on[0] === v.id
          && !!lit && lit.dataset.tab === host.id });
      }
    }
    switchTab('stations');
    return out.filter(x => !x.ok).map(x => x.id);
  });
  check('every view shows its tab\'s strip, itself marked, and lights its tab in the bar', strips.length === 0, strips.join(', '));

  // 📦 The Decoder's "not sure which kind?" box (decoder-sniff.js) sends each
  // kind of message to its own view, and says so when it is none of them.
  const sniff = await page.evaluate(() => [
    DecoderSniff.kindOf('1000001110111010101011111100001111111100')?.kind,
    DecoderSniff.kindOf('07D5F8FE')?.kind,
    DecoderSniff.kindOf(':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|NN:')?.kind,
    DecoderSniff.kindOf('2026-11-20 10:00:01 ALERT2A 01 02 03')?.kind,
    DecoderSniff.kindOf('541155'),
  ]);
  check('the Decoder\'s box tells an ALERT packet, HFEM lines and ERT-A2 output apart, and a station number from all three',
    JSON.stringify(sniff) === JSON.stringify(['packets', 'packets', 'hfem', 'alert2', null]), JSON.stringify(sniff));

  // An ARRO address pasted into Ctrl+K: the same page, in ARRO admin — for
  // somebody knocked out of administrator mode (palette.js, arroItems).
  const arro = await page.evaluate(() => {
    const r = Palette.results('https://arro.example/graphs/?site_id=3318&device_id=2').filter(x => x.kind === 'arro');
    return { n: r.length, first: r[0] && r[0].label, bare: Palette.results('3318').some(x => x.kind === 'arro') };
  });
  check('Ctrl+K reads a pasted ARRO address and offers its page in ARRO admin, and a bare number is left to the stations',
    arro.n === 2 && /sensor in ARRO admin/.test(arro.first || '') && !arro.bare, JSON.stringify(arro));

  // A tab listed under two groups in TABS would render twice above; this catches
  // the same mistake in the source, where it is easier to read.
  const declaredIds = shape.declared.flatMap(g => g.ids);
  check('no tab is declared in two groups', new Set(declaredIds).size === declaredIds.length);

  check('every group has a heading and is labelled by it',
    shape.groups.length > 0 && shape.groups.every(g => g.heading.trim() && g.labelled),
    shape.groups.map(g => `${g.heading}(${g.tabs.length})`).join(', '));

  check('no group is empty', shape.groups.every(g => g.tabs.length > 0));

  // The reason #108 exists: one group held eight of nineteen tabs, which is a
  // list rather than a grouping. Not a style rule — a ceiling, so the next tab
  // added has to be filed rather than dropped on the end of the biggest pile.
  const biggest = Math.max(...shape.groups.map(g => g.tabs.length));
  check('no group is larger than six tabs', biggest <= 6,
    `largest group holds ${biggest}`);

  // The find box, its rule, its exits and the icon rail were the Classic bar's:
  // Calm's search is the banner's (npm run palette), and its bar has no box to
  // type in. Those sections are kept, whole, in archive/classic/test/nav.mjs.

  // ── The site map ──────────────────────────────────────────────────────────
  // The nav's guide, so it is held here: a card for every tab the nav lists,
  // in words written for it, and a line from each card to the button it is
  // about — which is a claim about the nav as much as about the page, because
  // the line has to find that button wherever the nav has put it.
  console.log('\nThe site map — a card for every tab, and a line from each to its button\n');

  await page.evaluate(() => { setNavCollapsed(false); switchTab('sitemap'); });
  await page.waitForTimeout(150);

  const sm = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#main-content .sm-card')];
    return {
      ids: cards.map(c => c.dataset.tab),
      borrowed: cards.filter(c => c.dataset.fallback).map(c => c.dataset.tab),
      unused: Object.keys(SiteMap.guide).filter(id => !TAB_LIST.some(t => t.id === id)),
      jobs: SiteMap.tasks.filter(t => !TAB_LIST.some(x => x.id === t.tab)).map(t => t.tab),
      stops: document.querySelectorAll('#main-content .sm-stop').length,
      groups: TABS.filter(g => g.tabs.some(t => t.id !== 'sitemap')).length,
    };
  });
  const others = shape.ids.filter(id => id !== 'sitemap');
  check(`the site map has a card for each of the other ${others.length} tabs, once`,
    sm.ids.length === others.length && others.every(id => sm.ids.includes(id)),
    `${sm.ids.length} card(s); missing: ${others.filter(id => !sm.ids.includes(id)).join(', ') || 'none'}`);
  check('every card is written for the site map, not borrowed from the help',
    sm.borrowed.length === 0, sm.borrowed.length ? `no GUIDE entry in site-map.js for: ${sm.borrowed.join(', ')}` : '');
  check('and nothing is written up for a tab that is not there', sm.unused.length === 0, sm.unused.join(', '));
  check('every job under "I want to…" opens a real tab', sm.jobs.length === 0, sm.jobs.join(', '));
  check('the journey has a stop for every group', sm.stops === sm.groups, `${sm.stops} for ${sm.groups}`);

  // 📇 Capabilities is written by hand, a line per thing the app can do, so it
  // is held to the nav the way the Site Map is: a tab added with no line on
  // it, or a line left pointing at a tab that has gone, fails here.
  console.log('\nCapabilities — a line for every tab, each opening a real one, and a search that narrows\n');
  await page.evaluate(() => switchTab('capabilities'));
  await page.waitForTimeout(150);
  const caps = await page.evaluate(() => {
    const lines = Capabilities.lines();
    const ids = TAB_LIST.map(t => t.id);
    const covered = new Set(lines.map(l => l.tab));
    const names = lines.map(l => l.group + '/' + l.name);
    return {
      n: lines.length,
      tabbed: lines.filter(l => l.tab).length,
      bare: ids.filter(id => !covered.has(id)),
      gone: lines.filter(l => l.tab && !ids.includes(l.tab)).map(l => `${l.name} → ${l.tab}`),
      nowhere: lines.filter(l => [l.tab, l.act, l.href].filter(Boolean).length !== 1 || !l.acts).map(l => l.name),
      panelOff: lines.filter(l => l.panel && l.tab !== 'stations').map(l => l.name),
      badWho: lines.filter(l => !['', 'signin', 'member', 'editor', 'admin', 'list', 'team'].includes(l.who)).map(l => l.name),
      twice: names.filter((x, i) => names.indexOf(x) !== i),
      rendered: document.querySelectorAll('#cap-list .cap-item[id]').length,
      links: [...document.querySelectorAll('#cap-list .cap-item[id] a.cap-name')].filter(a => /[?&]tab=[a-z0-9]+/.test(a.getAttribute('href'))).length,
    };
  });
  check(`every tab has at least one line (${caps.n} lines)`, caps.bare.length === 0, `no line for: ${caps.bare.join(', ')}`);
  check('every line names a tab that is there', caps.gone.length === 0, caps.gone.join('; '));
  check('every line goes one place — a tab, a banner tool the page knows, or a page', caps.nowhere.length === 0, caps.nowhere.join(', '));
  check('a line that opens a map panel is a Stations line', caps.panelOff.length === 0, caps.panelOff.join(', '));
  check('every line says who it is for in a word the page knows', caps.badWho.length === 0, caps.badWho.join(', '));
  check('no line is written twice in one group', caps.twice.length === 0, caps.twice.join(', '));
  check('the page draws every line, each tab\'s name a link to its address', caps.rendered === caps.n && caps.links === caps.tabbed,
    `${caps.rendered} drawn of ${caps.n}; ${caps.links} linked of ${caps.tabbed}`);
  // Where the data comes from: every outside organisation a line names is in
  // the list of sources, every source listed with a name to match is used by
  // a line, and its count narrows the list to exactly those lines.
  const srcs = await page.evaluate(() => {
    const c = Capabilities.sourceCheck();
    const btn = document.querySelector('#cap-g-sources .cap-used');
    const n = btn ? parseInt(btn.textContent, 10) : -1;
    if (btn) btn.click();
    const shown = document.querySelectorAll('#cap-list .cap-item[id]').length;
    const said = document.getElementById('cap-srcpick');
    const r = { ...c, n, shown, said: !!said && !said.hidden, section: !!document.getElementById('cap-g-sources') };
    Capabilities.clear();
    r.back = !!document.getElementById('cap-g-sources');
    return r;
  });
  check('every outside source a line names is in the list of where the data comes from', srcs.unlisted.length === 0,
    `not listed: ${srcs.unlisted.join(', ')}`);
  check('every source listed is used by a line, and each of Flood-Net\'s own opens a real tab',
    srcs.unused.length === 0 && srcs.ownTabs.length === 0, `unused: ${srcs.unused.join(', ')}; tabs: ${srcs.ownTabs.join(', ')}`);
  check('a source\'s count narrows the list to that many lines, and says so', srcs.n > 0 && srcs.shown === srcs.n && srcs.said && !srcs.section,
    JSON.stringify(srcs));
  check('  …and clearing brings the sources back', srcs.back);

  const narrowed = await page.evaluate(() => {
    const q = document.getElementById('cap-q');
    q.value = 'lidar profile';
    q.dispatchEvent(new Event('input'));
    return {
      shown: document.querySelectorAll('#cap-list .cap-item[id]').length,
      marks: document.querySelectorAll('#cap-list mark.hit').length,
      count: document.getElementById('cap-count').textContent,
    };
  });
  check('two words narrow the list to the lines carrying both, marked where they matched',
    narrowed.shown > 0 && narrowed.shown < caps.n && narrowed.marks > 0, JSON.stringify(narrowed));
  const went = await page.evaluate(() => {
    const a = document.querySelector('#cap-list .cap-item[id] a.cap-name');
    const want = new URL(a.href).searchParams.get('tab');
    a.click();
    return { want, now: state.activeTab };
  });
  check('pressing a name opens its tab', went.now === went.want, JSON.stringify(went));
  await page.evaluate(() => { Capabilities.clear(); switchTab('sitemap'); });
  await page.waitForTimeout(150);

  // What the line is doing, read off the page: the svg up, the one element it
  // lit, and whether the ring drawn round that element actually encloses it.
  const lead = () => page.evaluate(() => {
    const svg = document.getElementById('sm-leader');
    const ring = svg && svg.querySelector('.sm-l-ring');
    const lit = [...document.querySelectorAll('.sm-lit')];
    const r = ring && ring.getBoundingClientRect();
    const t = lit[0] && lit[0].getBoundingClientRect();
    return {
      on: !!svg && svg.classList.contains('is-on') && getComputedStyle(svg).display !== 'none',
      lit: lit.map(el => el.dataset.tab || el.id || el.querySelector('.nav-heading')?.textContent || el.className),
      rings: !!(r && t && r.left <= t.left && r.right >= t.right && r.top <= t.top && r.bottom >= t.bottom),
      inView: !!(t && t.top >= 0 && t.bottom <= innerHeight),
      svgCount: document.querySelectorAll('#sm-leader').length,
    };
  });
  const settle = () => page.waitForTimeout(150);
  // Under Calm a tab's button is lit when its group is open; when it is not,
  // the line ends on the group's own heading button (nav-h-<group>) instead.
  const onNav = (L, id) => L.lit.length === 1 && (L.lit[0] === id || /^nav-h-/.test(L.lit[0]));

  await page.hover('#sm-card-packets .sm-card-h');
  await settle();
  let L = await lead();
  check('pointing at a card draws the line', L.on);
  check('  …to that tab\'s button in the nav, and nothing else', onNav(L, 'packets'),
    L.lit.join(', ') || 'nothing lit');
  check('  …ending on a ring round it', L.rings);

  await page.hover('#sm-card-packets .sm-pair[data-sm-point="tab:bitflipper"]');
  await settle();
  L = await lead();
  check('a related tab on a card points at its own button', onNav(L, 'bitflipper'),
    L.lit.join(', '));

  // The nav is taller than a 900 px window with every group in it, so the
  // last group's buttons start below its fold.
  await page.hover('#sm-card-tdma .sm-card-h');
  await settle();
  L = await lead();
  check('a button below the nav\'s fold is scrolled into it, and ringed there',
    (L.lit[0] === 'tdma' || /^nav-h-/.test(L.lit[0])) && L.inView && L.rings, `lit ${L.lit.join(', ')}, in view ${L.inView}`);

  // A view's card points at the tab it is a view of: the bar lists that.
  await page.hover('#sm-card-hfem .sm-card-h');
  await settle();
  L = await lead();
  check('a view\'s card points at its tab\'s button', onNav(L, 'packets') && L.rings,
    L.lit.join(', ') || 'nothing lit');

  await page.hover('.sm-stop-btn[data-sm-point="group:radio_signals"]');
  await settle();
  L = await lead();
  check('a group on the journey rings that whole group in the nav',
    L.lit.length === 1 && L.lit[0] === 'calm-sec sm-lit' && L.rings, L.lit.join(', '));

  // Off every source: the line goes, and so does the lit button.
  await page.hover('#sm-h');
  await page.waitForTimeout(400);
  L = await lead();
  check('moving off it takes the line and the lit button away', !L.on && L.lit.length === 0,
    `on ${L.on}, lit ${L.lit.join(', ')}`);

  // The keyboard gets the same line: focus on a card's button is pointing at it.
  // The pointer is parked in the banner first: left on the heading, the scroll
  // to the focused card can slide another card under it, and hover would win.
  await page.mouse.move(1, 1);
  await page.focus('#sm-card-rf .sm-open');
  await settle();
  L = await lead();
  check('focus on a card\'s button draws the same line, without a pointer',
    L.on && onNav(L, 'rf') && L.rings, L.lit.join(', '));
  await page.evaluate(() => document.activeElement.blur());

  // Shrunk to the icon rail, the nav is rewritten (renderTabs) — the line has
  // to find the button again, and end on the icon.
  await page.evaluate(() => setNavCollapsed(true));
  await page.waitForTimeout(300);
  await page.hover('#sm-card-health .sm-card-h');
  await settle();
  L = await lead();
  check('with the nav shrunk to icons, the line ends on the icon',
    L.on && onNav(L, 'health') && L.rings, L.lit.join(', '));
  await page.evaluate(() => setNavCollapsed(false));
  await page.waitForTimeout(300);

  await page.evaluate(() => switchTab('stations'));
  await page.waitForTimeout(150);
  L = await lead();
  check('leaving the tab takes the line\'s svg off the page and unlights the nav',
    L.svgCount === 0 && L.lit.length === 0, `${L.svgCount} svg(s), lit ${L.lit.join(', ')}`);

  // A phone: the bar is behind ☰, so the line goes to ☰ — from the key under
  // the drawing, the one source near enough the top of a phone's page for the
  // banner to be on screen with it.
  await page.setViewportSize({ width: 375, height: 800 });
  // A toast left by an earlier step (a Capabilities line that opened a tool)
  // can sit over the key at a phone's foot; it is not what is being checked.
  await page.evaluate(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); setNavCollapsed(true); switchTab('sitemap'); window.scrollTo(0, 0); });
  await page.waitForTimeout(300);
  await page.hover('.sm-anat-key li[data-sm-point="nav"] strong');
  await settle();
  L = await lead();
  check('on a phone the line ends on More, in the bar along the foot',
    L.on && L.lit.length === 1 && L.lit[0] === 'field-btn sm-lit' && L.rings, L.lit.join(', ') || 'nothing lit');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.hover('#sm-card-history .sm-card-h');
  await settle();
  L = await lead();
  check('and the bar along the foot stays on screen as the page scrolls, so the line stays with it',
    L.on && L.lit[0] === 'field-btn sm-lit', `on ${L.on}, lit ${L.lit.join(', ')}`);

  // ── Who sees what ─────────────────────────────────────────────────────────
  console.log('\nWho sees what — a tab for some people is listed to nobody else\n');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Who this session is: signed in or not, an administrator or not, on the
  // ALERT2 Transition Plan's list or not, on a team or not.
  const as = (signedIn, admin, onList, onTeam = false) => page.evaluate(([signedIn, admin, onList, onTeam]) => {
    Auth.isSignedIn = () => signedIn; Auth.isAdmin = () => admin;
    Auth.role = () => (admin ? 'admin' : signedIn ? 'editor' : null); Auth.a2plan = () => onList;
    Auth.tasks = () => onTeam;
    renderTabs();
  }, [signedIn, admin, onList, onTeam]);
  const restricted = await page.evaluate(() => TAB_LIST.filter(t => t.who).map(t => ({ id: t.id, label: t.label, who: t.who })));
  check('at least one tab is listed only to some people', restricted.length > 0, restricted.map(t => `${t.id} (${t.who})`).join(', '));
  const seen = () => page.evaluate((ids) => {
    setNavCollapsed(false);
    const bar = [...document.querySelectorAll('#tab-nav .tab-btn')].map(b => b.dataset.tab);
    const found = ids.map(t => Palette.results(t.label).some(x => x.kind === 'tab' && x.label === t.label));
    switchTab('sitemap');
    const cards = [...document.querySelectorAll('#main-content .sm-card')].map(c => c.dataset.tab);
    return { bar: ids.map(t => bar.filter(x => x === t.id).length), found, cards: ids.map(t => cards.includes(t.id)) };
  }, restricted);
  let w = await seen();
  check('somebody each is for has it in the bar once, finds it by name in Ctrl+K, and has its Site Map card',
    w.bar.every(n => n === 1) && w.found.every(Boolean) && w.cards.every(Boolean), JSON.stringify(w));
  await as(false, false, false);
  w = await seen();
  check('signed out, none of them is in the bar, Ctrl+K or the Site Map',
    w.bar.every(n => n === 0) && !w.found.some(Boolean) && !w.cards.some(Boolean), JSON.stringify(w));
  await as(true, false, false);
  w = await seen();
  check('signed in without being anybody they are for, the same', w.bar.every(n => n === 0) && !w.found.some(Boolean) && !w.cards.some(Boolean), JSON.stringify(w));
  await as(true, true, false);
  w = await seen();
  const plan = restricted.findIndex(t => t.who === 'a2plan');
  const tasksAt = restricted.findIndex(t => t.who === 'tasks');
  check('an administrator who is not on the plan\'s list does not have the plan, and has every tab for administrators — Tasks among them',
    plan >= 0 && w.bar[plan] === 0 && !w.found[plan] && !w.cards[plan]
    && restricted.every((t, i) => (t.who !== 'admin' && t.who !== 'tasks') || (w.bar[i] === 1 && w.found[i] && w.cards[i])), JSON.stringify(w));
  await as(true, false, false, true);
  w = await seen();
  check('somebody on a team who is nothing else has Tasks, and no tab for administrators or the plan',
    tasksAt >= 0 && w.bar[tasksAt] === 1 && w.found[tasksAt] && w.cards[tasksAt]
    && restricted.every((t, i) => t.who === 'tasks' || (w.bar[i] === 0 && !w.found[i] && !w.cards[i])), JSON.stringify(w));
  await as(true, false, true);
  w = await seen();
  check('…and somebody on the list who is not an administrator has the plan',
    w.bar[plan] === 1 && w.found[plan] && w.cards[plan], JSON.stringify(w));
  const inPalette = (on) => page.evaluate(([ids, on]) => {
    Auth.isSignedIn = () => on; Auth.isAdmin = () => on; Auth.role = () => (on ? 'admin' : null); Auth.a2plan = () => on;
    Auth.tasks = () => on;
    return ids.map(t => Palette.results(t.label).some(x => x.kind === 'tab' && x.label === t.label));
  }, [restricted, on]);
  const palOut = await inPalette(false), palIn = await inPalette(true);
  check('Ctrl+K offers each to somebody it is for and to nobody else', palIn.every(Boolean) && !palOut.some(Boolean),
    `for ${palIn.join(',')}, signed out ${palOut.join(',')}`);
  await as(true, false, false);
  const opened = await page.evaluate((ids) => { navFind(''); return ids.map(t => { switchTab(t.id); return document.getElementById('main-content').textContent; }); }, restricted);
  check('opened by its address, each says who it is for and shows nothing more',
    opened.every(t => /administrators only|only for the people nominated|for administrators and the people on a team/i.test(t) && t.length < 600), opened.map(t => t.slice(0, 100)).join(' | '));
  await page.evaluate(() => { navFind(''); switchTab('stations'); });

  if (errors.length) check('no uncaught page errors', false, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
console.log('');
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}:\n`);
  for (const f of failed) console.log(`  ${f.name}`);
  console.log('\n  TABS in core.js is the only description of the nav: a tab needs a group, an');
  console.log('  icon nothing else uses, and `find` words covering what somebody would type');
  console.log('  looking for it. A tab renamed there keeps its id. See #108.\n');
  process.exit(1);
}
console.log('PASS — every tab is in the nav once, under a group, and listed only to the people it is for.');
