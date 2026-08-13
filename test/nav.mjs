// The left nav: grouping, coverage, and the find box (#108).
//
// `npm run smoke` opens all nineteen tabs and asserts each one renders, but it
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
  { q: 'radio mobile',          want: 'export',      why: 'what the output is for' },
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

  // ── Coverage ──────────────────────────────────────────────────────────────
  console.log('\nCoverage — every tab is in the nav, once, under one heading\n');

  const shape = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#tab-nav .nav-group')].map(g => ({
      heading: g.querySelector('.nav-heading')?.textContent || '',
      labelled: g.getAttribute('aria-labelledby') === g.querySelector('.nav-heading')?.id,
      tabs: [...g.querySelectorAll('.tab-btn')].map(b => b.querySelector('.nav-label')?.textContent || ''),
    }));
    return {
      groups,
      declared: TABS.map(g => ({ group: g.group, ids: g.tabs.map(t => t.id) })),
      labels: TAB_LIST.map(t => t.label),
      ids: TAB_LIST.map(t => t.id),
    };
  });

  const rendered = shape.groups.flatMap(g => g.tabs);
  check(`all ${shape.labels.length} tabs render a button`,
    rendered.length === shape.labels.length,
    `${rendered.length} button(s) for ${shape.labels.length} tab(s)`);

  const missing = shape.labels.filter(l => !rendered.includes(l));
  check('and every one of them is a tab from TAB_LIST', missing.length === 0,
    missing.length ? `not in the nav: ${missing.join(', ')}` : '');

  check('no tab is rendered twice', new Set(rendered).size === rendered.length,
    rendered.length !== new Set(rendered).size
      ? `duplicated: ${rendered.filter((l, i) => rendered.indexOf(l) !== i).join(', ')}` : '');

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

  // ── The find box ──────────────────────────────────────────────────────────
  console.log('\nThe find box — every tab is findable, and the words people type land\n');

  const find = q => page.evaluate(query => {
    navFind(query);
    const label = b => b.querySelector('.nav-label')?.textContent || '';
    const best = document.querySelector('#nav-groups .tab-btn.nav-best');
    return {
      shown: [...document.querySelectorAll('#tab-nav .tab-btn')].map(label),
      best: best ? label(best) : null,
      count: document.getElementById('nav-found')?.textContent || '',
      none: !!document.querySelector('#tab-nav .nav-none'),
    };
  }, q);

  const idOf = label => shape.ids[shape.labels.indexOf(label)];

  // Its own label finds it, and finds it alone or nearly so. This is the
  // assertion that a rename cannot quietly break: the box matches the label, so
  // a label changed in TABS is still typed and still found.
  let selfOk = 0;
  for (const label of shape.labels) {
    const r = await find(label);
    if (r.shown.includes(label)) selfOk++;
    else check(`"${label}" finds itself`, false, `showed: ${r.shown.join(', ') || 'nothing'}`);
  }
  check(`every tab is found by typing its own label (${selfOk}/${shape.labels.length})`,
    selfOk === shape.labels.length);

  // Two claims per probe, and the second is the stronger one: the tab has to be
  // in the list *and* be the one marked ↵, because that is the tab Enter opens.
  // A probe that merely appears among five is not an answer to "would they find
  // it without scanning".
  for (const p of PROBES) {
    const r = await find(p.q);
    const ids = r.shown.map(idOf);
    check(`"${p.q}" → ${p.want}`, ids.includes(p.want),
      `${p.why}; showed: ${r.shown.join(', ') || 'nothing'}`);
    check(`  …and it is the one Enter takes`, r.best !== null && idOf(r.best) === p.want,
      `marked: ${r.best || 'none'}`);
  }

  // ── The rule ──────────────────────────────────────────────────────────────
  console.log('\nBest score wins — narrows as you type, survives words that mean nothing\n');

  const broad  = await find('alert');
  const narrow = await find('alert packets');
  check('a second term narrows rather than widens', narrow.shown.length < broad.shown.length,
    `"alert" → ${broad.shown.length}, "alert packets" → ${narrow.shown.length}`);
  // The tie the group heading creates, and the reason the ↵ mark exists: three
  // tabs share the heading "Addresses & packets", so all three score on
  // "packets", and the topmost of the three is not the one that was asked for.
  check('and the label breaks the tie the shared group heading creates',
    narrow.best !== null && idOf(narrow.best) === 'packets',
    `showed ${narrow.shown.join(', ')}; marked ${narrow.best}`);

  // Word starts, not bare substrings. Both of these matched under the first
  // version — "the" inside *hypotheses*, "rf" inside *interference* — and both
  // pulled the Interference Workbench into a query that was not about it.
  const inner = await find('the');
  check('a term only matches from the start of a word', inner.none,
    `"the" showed: ${inner.shown.join(', ') || 'nothing'}`);

  // What "best score" buys over "every term must match": a word on no tab adds
  // nothing everywhere, so it changes no ranking. Under the stricter rule this
  // query found nothing, because "view" is a find word on one tab and "the" is
  // on none — three terms, no tab carrying all three.
  const noise = await find('the rf environment view');
  check('a word on no tab costs nothing, and one on the wrong tab cannot win',
    noise.shown.length > 0 && noise.shown.map(idOf).includes('rf'),
    `showed: ${noise.shown.join(', ') || 'nothing'}`);

  // And a query where the best score is zero is a real empty result. This is the
  // case the stricter rule got backwards: with every term dropped as dead, it
  // fell through to "no filter" and showed all nineteen.
  const nothing = await find('zzzznotatab');
  check('a query that matches nothing says so, rather than showing everything',
    nothing.none && nothing.shown.length === 0,
    `${nothing.shown.length} tab(s) shown`);

  const counted = await find('acma');
  check('the live region counts what survived', /^\d+ of \d+ tabs$/.test(counted.count.trim()),
    counted.count);
  const quiet = await find('');
  check('and says nothing while nothing is filtered', quiet.count.trim() === ''
    && quiet.shown.length === shape.labels.length);

  // ── Its exits ─────────────────────────────────────────────────────────────
  console.log('\nExits — picking a tab and collapsing both end the query\n');

  const picked = await page.evaluate(() => {
    navFind('council');
    const btn = document.querySelector('#nav-groups .tab-btn');
    btn.click();
    return {
      tab: state.activeTab,
      query: state.navQuery,
      shown: document.querySelectorAll('#tab-nav .tab-btn').length,
      value: document.getElementById('nav-search')?.value,
    };
  });
  check('Enter/click on the one match opens that tab', picked.tab === 'maintenance', picked.tab);
  check('and the query is cleared behind it',
    picked.query === '' && picked.value === '' && picked.shown === shape.labels.length,
    `query ${JSON.stringify(picked.query)}, ${picked.shown} tab(s) back in the nav`);

  const railed = await page.evaluate(() => {
    navFind('council');
    setNavCollapsed(true);
    const out = { query: state.navQuery, shown: document.querySelectorAll('#tab-nav .tab-btn').length };
    setNavCollapsed(false);
    return out;
  });
  check('collapsing to the rail clears it too — the box is not there to clear it with',
    railed.query === '' && railed.shown === shape.labels.length,
    `${railed.shown} tab(s) on the rail`);

  // ── The rail ──────────────────────────────────────────────────────────────
  console.log('\nThe rail — an icon still says which tab, and which group\n');

  const rail = await page.evaluate(() => {
    setNavCollapsed(true);
    const btns = [...document.querySelectorAll('#tab-nav .tab-btn')];
    const out = {
      named: btns.every(b => (b.textContent || '').trim().length > 0),
      grouped: btns.every(b => (b.getAttribute('title') || '').includes(' — ')),
      icons: btns.map(b => b.querySelector('.nav-icon')?.textContent || ''),
      searchHidden: document.getElementById('nav-search')?.offsetParent === null,
      findBtn: !!document.querySelector('#tab-nav .nav-find-btn'),
    };
    setNavCollapsed(false);
    return out;
  });
  check('every rail button keeps its accessible name', rail.named);
  check('and its tooltip names the group the clipped heading was giving it', rail.grouped);
  check('every tab has an icon, and no two share one',
    rail.icons.every(Boolean) && new Set(rail.icons).size === rail.icons.length,
    rail.icons.join(' '));
  check('the find box is off the rail, and its button is on it',
    rail.searchHidden && rail.findBtn);

  // Ctrl+K is the whole reason the box is worth having from a tab rather than
  // from the nav, and it is registered on the document in init.js — nothing else
  // here would notice if that listener stopped being added.
  const chord = await page.evaluate(async () => {
    setNavCollapsed(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return {
      open: !state.navCollapsed,
      focused: document.activeElement === document.getElementById('nav-search'),
    };
  });
  check('Ctrl+K opens the nav from the rail', chord.open);
  check('and puts the cursor in the find box', chord.focused);

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
console.log('PASS — every tab is in the nav once, and findable by name and by what it does.');
