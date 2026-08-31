// The app shell and the design system (#109).
//
// The eleventh check, and it exists for the reason the other ten do: every
// claim below is invisible to `npm run smoke`, which opens all twenty tabs
// and asserts a clean console. A page can render twenty tabs perfectly while
// having no skip link, no landmark structure, a focus ring that vanishes on
// half its backgrounds, a nav that drops focus on every tab change, and a
// palette that fails contrast in the dark theme. None of that throws.
//
// It is also the check that makes #109 *enforceable* rather than merely
// documented. Six per-tab issues (#136–#141) are about to restyle nineteen
// tabs in parallel, and each of them is told: use the tokens, do not add a
// breakpoint, do not remove the focus ring, do not invent a table pattern.
// Those instructions are worth what they can be checked against.
//
// Eight things are checked, and the first three are the ones the U-issues are
// held to:
//
//   The scale.      Every `@media (max-width: N)` in styles.css has N in
//                   BREAKPOINTS (core.js). Six named steps and no seventh.
//                   Read out of the *running page*, so the CSS and the two
//                   JavaScript uses of those numbers cannot drift apart.
//
//   Contrast.       Every token pair that makes text-on-background, in both
//                   themes, against WCAG AA — computed off the values the
//                   browser resolves rather than off the source, so a var()
//                   chain, a color-mix() or a missing dark value is measured
//                   as rendered. Plus the control border at the 3:1 non-text
//                   threshold, against both surfaces a control sits on.
//
//   The focus ring. One ring, and an allowlist of two places allowed to
//                   replace it. A third has to be argued into this file.
//
//   Landmarks.      One banner, one main, one labelled nav, one labelled
//                   complementary. And the skip link: present, first in the
//                   tab order, and it actually moves focus.
//
//   Disclosure.     Every shell control that opens something says so and says
//                   when — the ☰, the nav toggle, the help toggle, the memory
//                   strip. Each is toggled and its aria-expanded re-read.
//
//   Focus & voice.  Where focus goes on a tab switch (the new tab's own nav
//                   button; nowhere at all if the user was not in the shell),
//                   and that the live region says which tab opened.
//
//   Overflow.       The document does not scroll sideways at 375, 768 or 1440,
//                   in either theme. A panel is never allowed to decide the
//                   page is wider than the screen.
//
//   Reach.          Every button in either rail can be brought on screen with
//                   that rail's own scrollbar, at the top of the page and
//                   again scrolled to the bottom of it. A rail that ends past
//                   the fold is not a rail anyone can use.
//
// Run:  npm run shell
//       npm run shell -- -v    also print what passed

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The `outline: none` allowlist ────────────────────────────────────────────
// Each entry is here because the element has no box worth ringing, and each
// replaces the outline with a shape change on the thing that has focus, which
// is the condition for being in this list at all — "it looked bad" is not.
// Adding one means editing this file and saying why, which is the point: the
// cost of the exception is visible.
//
// It held a third until #165: `.map-split:focus-visible`, the Stations tab's
// draggable divider. The divider is gone with the two-pane split and so is its
// exception — and this check is what remembered, because it fails on a stale
// entry exactly as it fails on an unlisted removal.
const OUTLINE_NONE_ALLOWED = [
  { selector: '.nv-node:focus-visible',
    because: 'an SVG <g> has no box; the node\'s own circle takes a 3px accent stroke' },
  { selector: '#main-content:focus',
    because: 'a script-focus target; the ring is restored on :focus-visible directly below' },
];

// ── The contrast contract ────────────────────────────────────────────────────
// Text on a background is AA at 4.5:1. A control's boundary against what is
// behind it is 1.4.11 at 3:1. Surfaces are --panel and --bg, because those are
// the two things anything in this app is actually drawn on; --subtle and
// --thead are checked only for the two colours that are read as running text
// on them.
const TEXT_PAIRS = [
  ['--text', '--bg'], ['--text', '--panel'], ['--text', '--panel-sub'],
  ['--text', '--subtle'], ['--text', '--thead'],
  ['--muted', '--bg'], ['--muted', '--panel'], ['--muted', '--panel-sub'],
  ['--muted', '--subtle'], ['--muted', '--thead'],
  ['--accent', '--bg'], ['--accent', '--panel'],
  ['--ok', '--bg'], ['--ok', '--panel'],
  ['--bad', '--bg'], ['--bad', '--panel'],
  ['--warn', '--bg'], ['--warn', '--panel'],
  ['--role-field', '--panel'], ['--role-repeater', '--panel'],
  ['--role-base', '--panel'], ['--role-satcom', '--panel'],
  ['--hit-text', '--hit-bg'],
  ['--primary-text', '--primary'],
  // The river-note buttons (#150 A4): river-blue text on the panel they sit
  // on. The permanent map label is NOT a pair here — like the pin labels it
  // paints its own fixed near-white ground with fixed ink, so its contrast is
  // constant by construction rather than theme-dependent.
  ['--map-river', '--panel'],
  // The banner writes `color: white` as a literal, so the pair is stated as a
  // literal too rather than pretending there is a token for it.
  ['#ffffff', '--header'],
  // The packet bit cells (#140). These are the one family that paints its own
  // ground *and* its own ink, so the pair is the cell against itself and the
  // answer does not depend on the theme — which is exactly why nobody had
  // measured them: three of the nine were under AA on 11-13 px type and had
  // been since the tab was written. Stated here so the next hue that looks
  // right on a designer's screen has to clear the bar before it ships.
  ['--c-frame-t', '--c-frame'], ['--c-addr-t', '--c-addr'],
  ['--c-data-t', '--c-data'],   ['--c-ident-t', '--c-ident'],
  ['--c-crc-t', '--c-crc'],     ['--c-batt-t', '--c-batt'],
  ['--c-hd-t', '--c-hd'],       ['--c-time-t', '--c-time'],
  ['--c-status-t', '--c-status'],
  // …and the white ink the ALERT2 packed-byte cell writes over the two halves
  // of its gradient, which is a literal in the stylesheet and so is a literal
  // here (.a2 .r-pack).
  ['#ffffff', '--c-data'], ['#ffffff', '--c-addr'],
  // The ACMA mechanism pills (#136) — the contrast question #138 handed over
  // with the palette. The map popup wrote `color: #fff` over all seven hues and
  // four of them failed AA doing it, so each hue now carries its own ink and
  // both are checked as a pair. This is also the check that keeps them paired:
  // an eighth mechanism added without an ink resolves to --acma-mech-ink and
  // shows up here rather than on a map.
  ['--acma-mech-co-channel-ink', '--acma-mech-co-channel'],
  ['--acma-mech-adjacent-ink', '--acma-mech-adjacent'],
  ['--acma-mech-imd3-ink', '--acma-mech-imd3'],
  ['--acma-mech-imd5-ink', '--acma-mech-imd5'],
  ['--acma-mech-imd3-triple-ink', '--acma-mech-imd3-triple'],
  ['--acma-mech-harmonic-ink', '--acma-mech-harmonic'],
  ['--acma-mech-cosite-desense-ink', '--acma-mech-cosite-desense'],
  // …and the station role pills in the map popup. Stated as literals, because
  // that is what is drawn: a pill is its own ground, so it takes ROLE_COLOR's
  // stable light values through --pill rather than var(--role-*) — the same
  // reasoning the Bit Flipper's pills carry. Against the *dark* theme's role
  // tokens white ink would be 1.88:1; against these it is 5.03:1 at worst, in
  // both themes, because the ground does not move.
  ['#ffffff', '#107c10'], ['#ffffff', '#0b5cab'],
  ['#ffffff', '#c7401a'], ['#ffffff', '#7c35a3'],
];

const NONTEXT_PAIRS = [
  ['--ctl-border', '--panel'], ['--ctl-border', '--bg'],
  ['--focus', '--panel'], ['--focus', '--bg'],
  // The blast-radius pair (#161). Checked against --panel because that is
  // where the readout card's own swatch legend draws them; on the map itself
  // their second channels (weight, dash, growth, the focus dim) carry them.
  ['--map-blast', '--panel'], ['--map-blast-ring', '--panel'],
  ['--map-line-blocked', '--panel'],
  // The ERT-A2 decoder's RSSI scale (#140). Unlike the bit cells above, these
  // are drawn *on the page* — a 3 px bar beside a number, a legend dot, a map
  // pin — so each step has to hold 3:1 against the ground of whichever theme is
  // up. As literals they did not: "weak" was 2.46:1 on the dark panel. They are
  // tokens now, stated per theme, and this is what holds them there.
  ['--rssi-strong', '--panel'],   ['--rssi-strong', '--panel-sub'],
  ['--rssi-good', '--panel'],     ['--rssi-good', '--panel-sub'],
  ['--rssi-fair', '--panel'],     ['--rssi-fair', '--panel-sub'],
  ['--rssi-marginal', '--panel'], ['--rssi-marginal', '--panel-sub'],
  ['--rssi-weak', '--panel'],     ['--rssi-weak', '--panel-sub'],
];

const AA_TEXT = 4.5;
const AA_NONTEXT = 3.0;

function channel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function parseRgb(s) {
  const m = String(s).match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ── styles.css, read as text ─────────────────────────────────────────────────
// The two source-level claims — the breakpoint scale and the focus allowlist —
// are about what is *written*, not about what a particular page renders, so
// they are read off the file. Everything else needs a browser.

const css = fs.readFileSync(repo('styles.css'), 'utf8');

// The block a declaration sits in, for a message that names the rule rather
// than a character offset.
function selectorAt(index) {
  const before = css.slice(0, index);
  const open = before.lastIndexOf('{');
  if (open < 0) return '(unknown)';
  const start = Math.max(before.lastIndexOf('}', open), before.lastIndexOf('*/', open), 0);
  return before.slice(start, open).replace(/^[}\/*]+/, '').replace(/\s+/g, ' ').trim();
}

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

  // ── 1. The breakpoint scale ───────────────────────────────────────────────
  console.log('\nThe scale — six named steps, and styles.css uses no seventh\n');

  const scale = await page.evaluate(() => (typeof BREAKPOINTS === 'undefined' ? null : BREAKPOINTS));
  check('BREAKPOINTS exists in the running page', !!scale,
    scale ? Object.entries(scale).map(([k, v]) => `${k}:${v}`).join(' ') : 'core.js does not declare it');

  const allowed = new Set(Object.values(scale || {}));
  const widths = [...css.matchAll(/@media[^{]*\(\s*max-width:\s*(\d+)px\s*\)/g)]
    .map(m => ({ px: Number(m[1]), at: m.index }));
  const strays = widths.filter(w => !allowed.has(w.px));
  check(`every max-width in styles.css is a step on the scale (${widths.length} block(s))`,
    strays.length === 0,
    strays.length
      ? strays.map(s => `${s.px}px at "${selectorAt(s.at)}"`).join('; ')
      : [...new Set(widths.map(w => w.px))].sort((a, b) => b - a).join(', '));

  // Not a formality: the two numbers the app *also* holds in JavaScript are the
  // ones most likely to drift, because changing the CSS is the obvious half of
  // the job and changing the constant is the half that gets forgotten.
  const mirrored = await page.evaluate(() => ({
    autoCollapse: NAV_AUTO_COLLAPSE_PX,
    phone: isPhoneNav.toString().includes('BREAKPOINTS.xs'),
  }));
  check('NAV_AUTO_COLLAPSE_PX is the `md` step, not a repeated literal',
    mirrored.autoCollapse === scale?.md, `${mirrored.autoCollapse} vs md:${scale?.md}`);
  check('isPhoneNav() reads the `xs` step, not a repeated literal', mirrored.phone);

  // Every step earns its place. A name in BREAKPOINTS that no rule uses is a
  // step somebody will "helpfully" pick next time, and a scale is only a scale
  // while all of it is real.
  const used = new Set(widths.map(w => w.px));
  const unused = Object.entries(scale || {}).filter(([, v]) => !used.has(v));
  check('and every step on the scale is actually used', unused.length === 0,
    unused.map(([k, v]) => `${k}:${v}`).join(', '));

  // ── 2. The focus ring ─────────────────────────────────────────────────────
  console.log('\nFocus — one ring, and two places allowed to replace it\n');

  const removals = [...css.matchAll(/outline:\s*(none|0)\s*;/g)]
    .map(m => ({ selector: selectorAt(m.index), at: m.index }));
  const allowlist = new Set(OUTLINE_NONE_ALLOWED.map(a => a.selector));
  const unlisted = removals.filter(r => ![...allowlist].some(a => r.selector.includes(a)));
  check(`no unallowlisted \`outline: none\` (${removals.length} in the file)`,
    unlisted.length === 0,
    unlisted.length
      ? unlisted.map(u => `"${u.selector}"`).join('; ')
      : OUTLINE_NONE_ALLOWED.map(a => a.selector).join(', '));

  // The allowlist has to stay honest in the other direction too: an entry for a
  // rule that no longer exists is a licence nobody is using and the next person
  // reads as precedent.
  const stale = OUTLINE_NONE_ALLOWED.filter(a => !removals.some(r => r.selector.includes(a.selector)));
  check('and no allowlist entry is stale', stale.length === 0,
    stale.map(s => s.selector).join(', '));

  const ring = await page.evaluate(() => {
    const btn = document.querySelector('#tab-nav .tab-btn');
    btn.focus();
    const cs = getComputedStyle(btn);
    return { width: cs.outlineWidth, style: cs.outlineStyle, colour: cs.outlineColor };
  });
  check('a focused control paints a real ring',
    ring.style !== 'none' && parseFloat(ring.width) >= 2,
    `${ring.width} ${ring.style} ${ring.colour}`);

  // ── 3. Contrast, in both themes ───────────────────────────────────────────
  console.log('\nContrast — every text pair, both themes, off the resolved values\n');

  // Resolved in the page rather than parsed out of the file, so a var() chain,
  // a color-mix() and an inherited value are all measured as they render. The
  // sentinel is what distinguishes "this token resolves to black" from "this
  // token does not exist and the declaration was thrown away".
  const readTokens = names => page.evaluate(list => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const out = {};
    for (const name of list) {
      if (name.startsWith('#')) { out[name] = name; continue; }
      probe.style.color = 'rgb(1, 2, 3)';
      probe.style.color = `var(${name})`;
      const got = getComputedStyle(probe).color;
      out[name] = got === 'rgb(1, 2, 3)' ? null : got;
    }
    probe.remove();
    return out;
  }, names);

  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const wanted = [...new Set([...TEXT_PAIRS, ...NONTEXT_PAIRS].flat())];

  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    const values = await readTokens(wanted);

    const missing = wanted.filter(n => !n.startsWith('#') && !values[n]);
    check(`${theme}: every token in the contract resolves`, missing.length === 0,
      missing.join(', '));

    const rgb = n => (n.startsWith('#') ? hexToRgb(n) : parseRgb(values[n]));
    const run = (pairs, floor, label) => {
      const failures = [];
      for (const [fg, bg] of pairs) {
        const a = rgb(fg), b = rgb(bg);
        if (!a || !b) continue;
        const ratio = contrast(a, b);
        if (ratio < floor) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
        else if (VERBOSE) console.log(`      ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
      }
      check(`${theme}: ${label} (${pairs.length} pair(s), floor ${floor}:1)`,
        failures.length === 0, failures.join('; '));
    };

    run(TEXT_PAIRS, AA_TEXT, 'text on background clears WCAG AA');
    run(NONTEXT_PAIRS, AA_NONTEXT, 'control boundaries clear 1.4.11');
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // ── 4. Landmarks and the skip link ────────────────────────────────────────
  console.log('\nLandmarks — one of each, and a way past the nav\n');

  // Scoped to the shell — landmarks *outside* #main-content. Five tabs render
  // an <aside> of their own inside main (Stations' filter pane, both Workbench
  // rails, Export's sidebar, Radio Path Maps' left column, ARRO Data's side),
  // each of which is an unnamed complementary landmark in a screen reader's
  // landmark list. That is a real finding and it is not this issue's: those
  // asides belong to #136, #139, #141, #137 and #141 respectively, and naming
  // them is in each U-issue's Definition of Done. What #109 owns is the shell,
  // and the rule the U-issues inherit is written in docs/design-system.md: a
  // landmark inside a tab carries an aria-label or it is not a landmark.
  const marks = await page.evaluate(() => {
    const outsideMain = sel => [...document.querySelectorAll(sel)]
      .filter(el => !el.closest('#main-content'));
    return {
      banner: outsideMain('body > header, [role="banner"]').length,
      main: document.querySelectorAll('main, [role="main"]').length,
      mainFocusable: document.getElementById('main-content')?.getAttribute('tabindex') === '-1',
      navs: outsideMain('nav').map(n => n.getAttribute('aria-label')),
      asides: outsideMain('aside').map(n => n.getAttribute('aria-label')),
    };
  });
  check('exactly one banner', marks.banner === 1, String(marks.banner));
  check('exactly one main, and it can take focus', marks.main === 1 && marks.mainFocusable);
  check('one nav, and it is labelled', marks.navs.length === 1 && !!marks.navs[0],
    marks.navs.join(', '));
  check('one complementary region, and it is labelled',
    marks.asides.length === 1 && !!marks.asides[0], marks.asides.join(', '));

  const skip = await page.evaluate(() => {
    const focusables = [...document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null || el.classList.contains('skip-link'));
    const link = document.querySelector('.skip-link');
    if (!link) return { present: false };
    link.focus();
    const visible = getComputedStyle(link).transform;
    link.click();
    return {
      present: true,
      first: focusables[0] === link,
      landed: document.activeElement === document.getElementById('main-content'),
      // translateY(-120%) parked, matrix(1,0,0,1,0,0) once focused.
      revealed: visible === 'none' || visible === 'matrix(1, 0, 0, 1, 0, 0)',
      hash: location.hash,
    };
  });
  check('the skip link exists', skip.present);
  check('and it is the first thing Tab reaches', skip.first);
  check('and it becomes visible when focused', skip.revealed);
  check('and it moves focus to main, rather than only scrolling', skip.landed);
  check('and it leaves no fragment in the URL', skip.hash === '', skip.hash);

  // ── 5. Disclosure state ───────────────────────────────────────────────────
  console.log('\nDisclosure — every shell control that opens something says when\n');

  const flips = await page.evaluate(async () => {
    const read = sel => document.querySelector(sel)?.getAttribute('aria-expanded');
    const out = {};

    out.navToggle = (() => {
      setNavCollapsed(false);
      const before = read('#tab-nav .nav-toggle');
      toggleNav();
      const after = read('#tab-nav .nav-toggle');
      setNavCollapsed(false);
      return { before, after };
    })();

    out.burger = (() => {
      setNavCollapsed(false);
      const before = read('#btn-nav');
      setNavCollapsed(true);
      const after = read('#btn-nav');
      setNavCollapsed(false);
      return { before, after, controls: document.getElementById('btn-nav')?.getAttribute('aria-controls') };
    })();

    out.help = (() => {
      setHelpCollapsed(true);
      const before = read('#help-panel .help-toggle');
      setHelpCollapsed(false);
      const after = read('#help-panel .help-toggle');
      setHelpCollapsed(true);
      return { before, after };
    })();

    out.mem = (() => {
      const before = read('#mem-bar');
      MemMeter.togglePanel();
      const after = read('#mem-bar');
      const focused = document.activeElement?.classList.contains('mem-card');
      MemMeter.closePanel();
      return { before, after, focused, closed: read('#mem-bar'),
               controls: document.getElementById('mem-bar')?.getAttribute('aria-controls') };
    })();

    return out;
  });

  check('the nav toggle flips aria-expanded',
    flips.navToggle.before === 'true' && flips.navToggle.after === 'false',
    `${flips.navToggle.before} → ${flips.navToggle.after}`);
  check('the header ☰ flips with it, and names what it controls',
    flips.burger.before === 'true' && flips.burger.after === 'false'
      && flips.burger.controls === 'tab-nav',
    `${flips.burger.before} → ${flips.burger.after}, controls ${flips.burger.controls}`);
  check('the help toggle flips aria-expanded',
    flips.help.before === 'false' && flips.help.after === 'true',
    `${flips.help.before} → ${flips.help.after}`);
  check('the memory strip flips aria-expanded, and names what it controls',
    flips.mem.before === 'false' && flips.mem.after === 'true'
      && flips.mem.closed === 'false' && flips.mem.controls === 'mem-modal',
    `${flips.mem.before} → ${flips.mem.after} → ${flips.mem.closed}`);
  check('and opening it puts focus inside the panel', flips.mem.focused === true);

  // ── 6. Focus and voice on a tab switch ────────────────────────────────────
  console.log('\nA tab switch — where focus goes, and what is said\n');

  const current = await page.evaluate(() => {
    const on = [...document.querySelectorAll('#tab-nav [aria-current]')];
    return {
      count: on.length,
      label: on[0]?.querySelector('.nav-label')?.textContent,
      active: state.activeTab,
      matches: on[0]?.classList.contains('active'),
    };
  });
  check('exactly one nav item is aria-current', current.count === 1, String(current.count));
  check('and it is the open tab', current.matches === true, `${current.label} / ${current.active}`);

  const fromNav = await page.evaluate(async () => {
    setNavCollapsed(false);
    document.getElementById('app-status').textContent = '';
    const btn = [...document.querySelectorAll('#tab-nav .tab-btn')]
      .find(b => b.querySelector('.nav-label')?.textContent === 'Networks');
    btn.focus();
    btn.click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const now = document.activeElement;
    return {
      tab: state.activeTab,
      onNavButton: !!now?.classList?.contains('tab-btn'),
      onTheNewOne: now?.querySelector?.('.nav-label')?.textContent === 'Networks',
      current: now?.getAttribute('aria-current'),
      said: document.getElementById('app-status')?.textContent || '',
    };
  });
  check('clicking a nav tab opens it', fromNav.tab === 'networks', fromNav.tab);
  check('and focus lands on the new tab\'s own button, not on <body>',
    fromNav.onNavButton && fromNav.onTheNewOne);
  check('and that button is the one marked aria-current, so arriving on it says so',
    fromNav.current === 'page', String(fromNav.current));
  // The other half of the rule, and the easier one to get wrong: the region
  // stays quiet when focus has already said it. A screen reader reads
  // "Networks, button, current page" on arrival; a live region saying
  // "Networks — Stations & networks" a moment later is the same fact twice.
  check('and the live region stays quiet, because focus already said it',
    fromNav.said === '', JSON.stringify(fromNav.said));

  // The guard. switchTab() is called at startup by Workbench.restoreFromUrl()
  // and by deep-link buttons inside tabs; a page that grabs focus on load is
  // worse than the problem the rule above fixes. This is also the route where
  // the announcement is the *only* signal, so both halves are asserted here.
  const fromNowhere = await page.evaluate(async () => {
    document.activeElement?.blur?.();
    document.getElementById('app-status').textContent = '';
    switchTab('passranges');
    const now = document.activeElement;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const region = document.getElementById('app-status');
    return {
      tab: state.activeTab,
      stayed: now === document.body || now === null,
      said: region?.textContent || '',
      polite: region?.getAttribute('aria-live'),
    };
  });
  check('but a switch from outside the shell does not move focus at all',
    fromNowhere.tab === 'passranges' && fromNowhere.stayed);
  check('and there the live region does say which tab, politely',
    fromNowhere.polite === 'polite' && /Pass Ranges/.test(fromNowhere.said),
    JSON.stringify(fromNowhere.said));

  // ── 7. Reduced motion, and sideways scroll ────────────────────────────────
  console.log('\nOne motion policy, and a page that never scrolls sideways\n');

  const motionBlocks = [...css.matchAll(/@media[^{]*prefers-reduced-motion/g)];
  check('one reduced-motion policy, not one per component', motionBlocks.length === 1,
    `${motionBlocks.length} block(s)`);
  const policy = css.slice(motionBlocks[0]?.index ?? 0, (motionBlocks[0]?.index ?? 0) + 900);
  check('and it names the two rail transitions app.js waits on',
    policy.includes('#tab-nav.nav-ready') && policy.includes('#help-panel.help-ready'));

  // The proving ground plus the shell, at the three widths the epic names, in
  // both themes. Not all twenty tabs — that is U1–U6's Definition of Done,
  // and asserting it here would be claiming work this issue did not do.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // Crossing the `xs` step turns both rails from drawers into columns, and
    // the width change is a .16s transition — measure inside it and the nav is
    // whatever fraction of 236 px it had reached, which is how this check
    // reported a 13 px overflow at 768 px that did not exist a moment later.
    // The app itself waits exactly this long before re-measuring its maps
    // (NAV_TRANSITION_MS + 40), for the same reason.
    await page.waitForTimeout(250);
    for (const theme of ['light', 'dark']) {
      const over = await page.evaluate(async t => {
        document.documentElement.setAttribute('data-theme', t);
        switchTab('networks');
        await new Promise(r => requestAnimationFrame(r));
        const d = document.documentElement;
        return { scroll: d.scrollWidth, client: d.clientWidth };
      }, theme);
      check(`no sideways scroll at ${width}px, ${theme}`,
        over.scroll <= over.client + 1, `${over.scroll}px of content in ${over.client}px`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 8. Both rails reachable without scrolling the window ──────────────────
  // Each rail is a sticky box in a document that scrolls, and the banner is
  // part of that document — it scrolls away with it. So a rail sized to 100dvh
  // starts at the banner's foot and therefore ends --mn-chrome px past the
  // fold, and the rail's own scrollbar cannot reach into that overhang: it
  // moves content inside a box whose last stretch is off screen. Nothing about
  // that looks broken. The rail scrolls, it just runs out early, and the bottom
  // two of twenty-two tabs are unreachable until the whole window is scrolled —
  // which is how it survived every check in this harness until this one.
  //
  // The claim is the one an operator would make: at the top of the page, and
  // again at the bottom of it, every button in either rail can be brought on
  // screen with that rail's own scrollbar. Four heights, because the failure is
  // a function of the banner's height against the viewport's, and 1024 px wide
  // is where the banner wraps to two rows and takes 96 px rather than 75.
  console.log('\nBoth rails reach every one of their own buttons\n');

  for (const [w, h] of [[1440, 900], [1280, 720], [1024, 640], [1440, 550]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => { setHelpCollapsed(false); scrollTo(0, 0); });
    await page.waitForTimeout(250);
    for (const at of ['at the top', 'scrolled to the foot']) {
      if (at !== 'at the top') {
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(120);
      }
      const reach = await page.evaluate(() => {
        const out = {};
        for (const [name, sel] of [['nav', '.nav-inner'], ['help', '.help-inner']]) {
          const rail  = document.querySelector(sel);
          const items = [...rail.querySelectorAll('button, a')];
          // Scrolled to its own end, the last item has to be above the fold;
          // scrolled back to its start, the first has to be below the top.
          rail.scrollTop = rail.scrollHeight;
          const last = items[items.length - 1].getBoundingClientRect().bottom;
          rail.scrollTop = 0;
          const first = items[0].getBoundingClientRect().top;
          out[name] = { n: items.length, below: Math.round(last - innerHeight), above: Math.round(-first) };
        }
        return out;
      });
      for (const name of ['nav', 'help']) {
        const r = reach[name];
        check(`${name} rail: all ${r.n} buttons reachable ${at}, ${w}×${h}`,
          r.below <= 1 && r.above <= 1,
          r.below > 1 ? `last item ${r.below}px below the fold`
                      : `first item ${r.above}px above it`);
      }
    }
  }
  await page.evaluate(() => { setHelpCollapsed(true); scrollTo(0, 0); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);

  // The proving ground itself: #109 is only done if the system it defines is
  // demonstrably in use somewhere. Networks is the smallest tab in the app and
  // #137 owns it afterwards.
  const proof = await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    switchTab('networks');
    await new Promise(r => requestAnimationFrame(r));
    const main = document.getElementById('main-content');
    const tables = [...main.querySelectorAll('table')];
    return {
      page: !!main.querySelector('.page'),
      wrapped: tables.length > 0 && tables.every(t => t.closest('.table-wrap')),
      captioned: tables.length > 0 && tables.every(t => (t.caption?.textContent || '').trim()),
      scoped: tables.every(t => [...t.querySelectorAll('thead th')].every(h => h.getAttribute('scope') === 'col')),
      // A <col> is exempt and is the only exemption. The element exists for no
      // other purpose than to carry a width, there is no token for "28% of
      // this table", and the proportions are a property of *this* data rather
      // than a design decision that another tab could inherit. Everything else
      // — a container laying itself out inline, a colour written into an
      // element — is a decision no token can reach, and is the thing U1–U6 are
      // replacing. `--page-max` is allowed because it *is* the token.
      inlineStyles: [...main.querySelectorAll('[style]')]
        .filter(el => el.tagName !== 'COL')
        .map(el => el.getAttribute('style'))
        .filter(s => !/^--/.test(s.trim())).length,
    };
  });
  check('the proving ground uses .page rather than an inline layout', proof.page);
  check('every table on it is wrapped, captioned and scoped',
    proof.wrapped && proof.captioned && proof.scoped,
    `wrapped:${proof.wrapped} captioned:${proof.captioned} scoped:${proof.scoped}`);
  check('and carries no inline style but a token override',
    proof.inlineStyles === 0, `${proof.inlineStyles} left`);

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
  console.log('\n  The system is in three places and documented in one:');
  console.log('    styles.css   the tokens, and the contract in short form at the top');
  console.log('    core.js      BREAKPOINTS — the only place the widths exist — and announce()');
  console.log('    docs/design-system.md   all of it, with the reasoning');
  console.log('\n  If you need something that is not there, add it there and write down');
  console.log('  why. A number typed into one tab is a decision the next tab cannot');
  console.log('  find. See #109.\n');
  process.exit(1);
}
console.log('PASS — the shell is navigable, the palette clears AA in both themes, and the');
console.log('       scale is six steps with nothing outside it.');
