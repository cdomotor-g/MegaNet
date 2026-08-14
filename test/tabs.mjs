// The per-tab Definition of Done (EPIC #107's six U-issues).
//
// The twelfth check, added by #137 — the first of the six per-tab issues to
// land. It exists for the reason the other eleven do, and the reason is sharper
// here than anywhere else on the board: `npm run shell` holds #109's system,
// but it holds it against *the shell and one tab*, deliberately and by its own
// comment. Nothing was holding the other eighteen. Six issues are converting
// nineteen tabs in parallel, each told "use the tokens, wrap the tables, name
// the landmarks, don't scroll the page sideways" — and every one of those
// instructions was worth exactly as much as the reviewer's attention until now.
//
// The shape is a list, not a sweep. CONVERTED below names the tabs that claim
// to have been through a U-issue; everything in this file is asserted against
// those and against nothing else. A U-issue's last commit adds its tab ids to
// that list, which is the point: the check grows tab by tab with the epic, and
// a tab nobody has converted yet does not fail a check for work nobody has done.
//
// Eight things are checked per tab:
//
//   Inline styles.  None, except a `--token: value` override (that *is* the
//                   system — see .page's --page-max) and a <col> width, which
//                   is what #109's own proving-ground check exempts and why.
//
//   Tables.         Wrapped in .table-wrap, captioned, and every thead th
//                   scoped. Pattern 1 and 6.
//
//   Scroll regions. A .table-wrap that caps its height (.tall / .medium) is
//                   role="region" + tabindex="0" + a name. Pattern 7a: a div
//                   with overflow:auto is keyboard-scrollable in Firefox and
//                   nowhere else, so the content below the fold of one was
//                   unreachable without a mouse.
//
//   Clickable rows. A <tr> with an onclick contains a focusable control.
//                   Pattern 7b. The row is a mouse convenience; the button in
//                   its first cell is the part a keyboard can reach.
//
//   Landmarks.      An <aside> inside <main> is a complementary landmark in
//                   every screen reader's landmark list. Five tabs render one.
//                   It carries an aria-label or it is not a landmark — the rule
//                   shell.mjs §4 states and hands to the U-issues.
//
//   Names.          Every visible interactive element has an accessible name.
//                   "Open" ×40 and a bare "↗" both count as *having* one, so
//                   this is a floor rather than a ceiling — but it is the floor
//                   the audit behind #111 found the app below.
//
//   Headings.       h1 → h2 → h3 with no step skipped, counting the shell's own
//                   h1. A tab that opens at h3 tells a screen reader it is a
//                   subsection of something that is not there.
//
//   Overflow.       No sideways scroll of the document at 375, 768 and 1440, in
//                   both themes. Same assertion shell.mjs makes about the shell,
//                   made about each converted tab — which is where the wide
//                   thing actually lives.
//
// Plus one that belongs to a pattern rather than to a tab:
//
//   Pattern 8.      A graphic marked role="img" that is a *shortcut* for
//                   controls beside it must have a name, and every operation it
//                   offers must be on one of those controls. Radio Path Maps'
//                   basin drawing is the first instance: a hundred clickable
//                   polygons, none of them a tab stop, and eight region buttons
//                   underneath that do the same thing. The check is that the
//                   claim holds — every region on the drawing has a chip.
//
// Run:  npm run tabs
//       npm run tabs -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

// The tabs that have been through a U-issue. Add yours here when you land it —
// that is how this check grows with the epic. The label is the nav label, so a
// failure names the tab the way the app does.
const CONVERTED = [
  { id: 'networks',   label: 'Networks',        issue: '#109 (proving ground) / #137' },
  { id: 'passranges', label: 'Pass Ranges',     issue: '#137' },
  { id: 'maps',       label: 'Radio Path Maps', issue: '#137' },
];

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// The accessible-name rules that matter for the controls this app builds, in
// specificity order. Not a full accname implementation — this is a floor check,
// and the cases it does not model (aria-labelledby chains through shadow roots,
// <label> wrapping something that is not its control) do not occur here.
const NAME_FN = `el => {
  const byIds = ids => (ids || '').split(/\\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
  const labelled = byIds(el.getAttribute('aria-labelledby'));
  if (labelled) return labelled;
  const aria = (el.getAttribute('aria-label') || '').trim();
  if (aria) return aria;
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
  }
  const wrapping = el.closest('label');
  if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
  const text = (el.textContent || '').trim();
  if (text) return text;
  const alt = (el.getAttribute('alt') || '').trim();
  if (alt) return alt;
  const title = (el.getAttribute('title') || '').trim();
  if (title) return title;
  const ph = (el.getAttribute('placeholder') || '').trim();
  return ph;
}`;

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

  for (const tab of CONVERTED) {
    console.log(`\n${tab.label} — converted by ${tab.issue}\n`);

    const found = await page.evaluate(async ([id, nameSrc]) => {
      const accName = eval('(' + nameSrc + ')');
      switchTab(id);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const main = document.getElementById('main-content');
      const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      // A <col> carries a width and nothing else, and a declaration block that
      // is *only* custom properties is a token override rather than a decision
      // — the two exemptions #109's own proving-ground check makes, made here
      // for the same reasons. The second is what a hundred basin polygons and
      // eight chip dots rely on: `--basin: var(--maps-region-seqld)` on the
      // element is the token reaching it, whereas `fill: #9b5de5` was the
      // element deciding, which is the thing being replaced.
      const tokenOnly = s => s.split(';').map(d => d.trim()).filter(Boolean)
        .every(d => /^--[\w-]+\s*:/.test(d));
      const inline = [...main.querySelectorAll('[style]')]
        .filter(el => el.tagName !== 'COL')
        .filter(el => !tokenOnly(el.getAttribute('style') || ''))
        .map(el => el.tagName.toLowerCase() + '[style="' + el.getAttribute('style') + '"]');

      const tables = [...main.querySelectorAll('table')];
      const unwrapped = tables.filter(t => !t.closest('.table-wrap'));
      const uncaptioned = tables.filter(t => !(t.caption?.textContent || '').trim());
      const unscoped = tables.filter(t =>
        [...t.querySelectorAll('thead th')].some(h => h.getAttribute('scope') !== 'col'));

      // Pattern 7a applies to the wrappers that can scroll — the ones that cap
      // their own height. A plain wrapper around a short table is not a region
      // and must not become a tab stop for nothing.
      const capped = [...main.querySelectorAll('.table-wrap.tall, .table-wrap.medium')];
      const unregioned = capped.filter(w =>
        w.getAttribute('role') !== 'region'
        || w.getAttribute('tabindex') !== '0'
        || !accName(w));

      // Pattern 7b.
      const clickRows = [...main.querySelectorAll('tr[onclick]')];
      const deadRows = clickRows.filter(tr =>
        !tr.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'));

      const asides = [...main.querySelectorAll('aside')].filter(a => !accName(a));

      const controls = [...main.querySelectorAll(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(visible);
      const unnamed = controls.filter(el => !accName(el))
        .map(el => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/)[0] : ''));

      // Counting the shell's own h1, because that is what a screen reader's
      // heading list shows: the tab's headings are a continuation of it.
      const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .filter(visible)
        .map(h => Number(h.tagName[1]));
      const skips = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) skips.push(`h${levels[i - 1]} → h${levels[i]}`);
      }

      return {
        inline, unwrapped: unwrapped.length, uncaptioned: uncaptioned.length,
        unscoped: unscoped.length, tables: tables.length,
        capped: capped.length, unregioned: unregioned.length,
        clickRows: clickRows.length, deadRows: deadRows.length,
        asides: asides.length, controls: controls.length, unnamed,
        skips, levels: levels.join(' '),
      };
    }, [tab.id, NAME_FN]);

    check(`${tab.label}: no inline style but a token override`,
      found.inline.length === 0, found.inline.slice(0, 3).join(' · '));
    check(`${tab.label}: every table wrapped, captioned and scoped (${found.tables})`,
      found.unwrapped + found.uncaptioned + found.unscoped === 0,
      `unwrapped:${found.unwrapped} uncaptioned:${found.uncaptioned} unscoped:${found.unscoped}`);
    check(`${tab.label}: every capped .table-wrap is a named region (${found.capped})`,
      found.unregioned === 0, `${found.unregioned} without role/tabindex/name`);
    check(`${tab.label}: every clickable row holds a focusable control (${found.clickRows})`,
      found.deadRows === 0, `${found.deadRows} reachable by mouse only`);
    check(`${tab.label}: every <aside> in main is labelled`,
      found.asides === 0, `${found.asides} unnamed complementary landmark(s)`);
    check(`${tab.label}: every visible control has a name (${found.controls})`,
      found.unnamed.length === 0, [...new Set(found.unnamed)].slice(0, 5).join(', '));
    check(`${tab.label}: headings step by one`,
      found.skips.length === 0, `${found.skips.join(', ')} (${found.levels})`);
  }

  // ── No sideways scroll, per tab, per width, per theme ──────────────────────
  console.log('\nNo sideways scroll — each converted tab, three widths, both themes\n');

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // The rails cross `xs` between 375 and 768 and take .16s to do it; measured
    // inside that the nav is whatever fraction of 236 px it had reached. The
    // app waits exactly this long before re-measuring its own maps.
    await page.waitForTimeout(250);
    for (const tab of CONVERTED) {
      for (const theme of ['light', 'dark']) {
        const over = await page.evaluate(async ([id, t]) => {
          document.documentElement.setAttribute('data-theme', t);
          switchTab(id);
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const d = document.documentElement;
          return { scroll: d.scrollWidth, client: d.clientWidth };
        }, [tab.id, theme]);
        check(`${tab.label} at ${width}px, ${theme}`,
          over.scroll <= over.client + 1, `${over.scroll}px of content in ${over.client}px`);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // ── Pattern 8: a graphic that is a shortcut for the controls beside it ─────
  console.log('\nPattern 8 — the basin drawing is a shortcut, and the chips are the path\n');

  const shortcut = await page.evaluate(async () => {
    switchTab('maps');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const svg = document.querySelector('.maps-basin-svg');
    if (!svg) return { present: false };
    const polys = [...svg.querySelectorAll('polygon')];
    const drawn = [...new Set(polys.map(p => p.dataset.region).filter(Boolean))];
    const chips = [...document.querySelectorAll('#maps-region-chips .maps-chip')]
      .map(b => b.dataset.region);
    return {
      present: true,
      named: (svg.getAttribute('aria-label') || '').trim(),
      role: svg.getAttribute('role'),
      // The condition the pattern rests on: nothing the drawing can do is only
      // on the drawing. If a region ever appears on a basin with no chip, the
      // drawing has become the sole route to it and role="img" is a lie.
      orphanRegions: drawn.filter(r => !chips.includes(r)),
      polys: polys.length,
      // …and the other half: no polygon is a tab stop. A hundred of them would
      // be a hundred stops for an operation that is on eight buttons.
      stops: polys.filter(p => p.hasAttribute('tabindex')).length,
      // The name has to carry the headline number, not be a fixed string
      // (pattern part 1). Cheapest honest test: it contains a figure.
      hasFigure: /\d/.test(svg.getAttribute('aria-label') || ''),
      pressed: [...document.querySelectorAll('#maps-region-chips .maps-chip')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').length,
    };
  });

  check('the basin drawing is present', shortcut.present);
  check('and it is one role="img" rather than a hundred unnamed shapes',
    shortcut.role === 'img' && shortcut.stops === 0,
    `role:${shortcut.role} tabbable polygons:${shortcut.stops} of ${shortcut.polys}`);
  check('and its name carries the headline number', !!shortcut.named && shortcut.hasFigure,
    shortcut.named.slice(0, 80));
  check('and every region it draws has a button of its own',
    (shortcut.orphanRegions || []).length === 0, (shortcut.orphanRegions || []).join(', '));
  check('and exactly one region chip reads as pressed', shortcut.pressed === 1,
    String(shortcut.pressed));

  if (errors.length) check('no uncaught page errors', false, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s) across ${CONVERTED.length} converted tab(s).`);
console.log('');
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}:\n`);
  for (const f of failed) console.log(`  ${f.name}`);
  console.log('\n  This is EPIC #107\'s per-tab Definition of Done, checked. The patterns');
  console.log('  are in docs/design-system.md — sections 3 (tables, patterns 1-8) and 4');
  console.log('  (landmarks, names, headings). If you need something that is not there,');
  console.log('  add it there and write down why; a decision made inside one tab is a');
  console.log('  decision the next five cannot find.\n');
  process.exit(1);
}
console.log('PASS — every converted tab uses the system, names what it draws, and stays');
console.log('       inside the screen at 375, 768 and 1440 in both themes.');
