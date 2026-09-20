// The on-map panels put themselves away (#164's control, and the defect that
// outlived it).
//
// MapChrome draws four icons in the Stations map's top-right corner — Base map,
// Map display, Draw & measure, the legend — and every one of them opens a flyout
// *over the map*. The whole design rests on one promise, written at the top of
// both map-controls.js and the `.mn-mapctl` block in styles.css: **the pin is
// the only way a panel stays.** Everything else that opens one is supposed to
// expire on its own.
//
// It did not. Clicking any control *inside* a panel — a checkbox, a base-layer
// radio, a colour swatch, a draw tool — focuses that control, and an ungated
// `focusin` promoted the panel to open-for-real on that focus. So the ordinary
// act of using a panel welded it to the map until its icon was hunted down and
// clicked again, and because a stuck flyout is 300 px wide and opens leftward
// across the icon column, the *first* panel left open covers the icons of the
// ones below it. Two of them and the corner is unusable.
//
// That failure mode is why this file is a check and not a fixed comment. It is
// invisible to everything else in `test/`: nothing threw, no handler went
// unresolved, no contrast changed, and a page-load smoke test never moves a
// mouse. The only thing that sees it is a real pointer moving away and the panel
// still being there — so that is what every assertion below does. Real
// page.mouse moves, real clicks, and the question asked afterwards is always
// "is it still on the map?", never "which class is set?".
//
// Runs on the Stations map because it is the one carrying all four panels; the
// primitive is shared, so what passes here is what the other six Leaflet maps
// get.
//
// ── And since #192, the corner they stand in ────────────────────────────────
// The eleven icons were regrouped into one control holding five labelled
// groups, and §9 below is about that arrangement rather than about any one
// panel. Everything it asserts is measured off the geometry the browser gave
// the elements, for the reason `maplinks` states at more length: an
// implementation that sets the right attribute and draws the wrong thing
// passes every check that reads the attribute. So "the groups are separated"
// is asked as *is the smallest gap between two groups bigger than the biggest
// gap inside one*, and "the camera buttons are not on the flat map" is asked
// as `getClientRects()`, never as `el.hidden`.
//
// The one thing here that is not geometry is the order, which is read from
// `MapChrome.groups()` rather than from a list copied into this file — a sixth
// group added there is then in this check the day it lands, and a group that
// exists on screen and not in that table fails.
//
// Run:  npm run mapctl
//       npm run mapctl -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // ── Helpers ───────────────────────────────────────────────────────────────

  // What one panel is doing, in the terms the assertions are written in.
  // `shown` is measured off the box the browser gave the element — not off a
  // class — because a class that says "open" about an invisible panel is one of
  // the things this file exists to catch.
  const look = (panel) => page.evaluate((p) => {
    const wrap = document.querySelector(`.mn-mapctl[data-panel="${p}"]`);
    if (!wrap) return null;
    const btn  = wrap.querySelector('.mn-mapctl-btn');
    const body = wrap.querySelector('.mn-mapctl-body');
    const r    = btn.getBoundingClientRect();
    const br   = body.getBoundingClientRect();
    return {
      icon:  { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      body:  { x: br.left + 20, y: br.top + 20 },
      shown: !!(body.offsetWidth || body.offsetHeight || body.getClientRects().length),
      open:   wrap.classList.contains('is-open'),
      shut:   wrap.classList.contains('is-shut'),
      pinned: wrap.classList.contains('is-pinned'),
      expanded: btn.getAttribute('aria-expanded'),
    };
  }, panel);

  // Somewhere on the map with no control anywhere near it. Every "does it go
  // away" assertion is this move followed by a look.
  const leave = async () => { await page.mouse.move(200, 760); await page.waitForTimeout(200); };

  const hover = async (panel) => {
    const p = await look(panel);
    await page.mouse.move(p.icon.x, p.icon.y);
    await page.waitForTimeout(150);
    return look(panel);
  };

  // Click something inside an open panel, arriving *along the panel* rather
  // than straight at it: the flyout sits a gap away from its icon and the
  // pointer has to stay over the control the whole way, which is what the
  // .mn-mapctl-body::after bridge in styles.css is for. A jump would land the
  // click on a panel that hover had already dropped.
  const clickInside = async (panel, selector) => {
    const p = await look(panel);
    const at = await page.evaluate(([q, s]) => {
      const el = document.querySelector(`.mn-mapctl[data-panel="${q}"] .mn-mapctl-body ${s}`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [panel, selector]);
    if (!at) return null;
    await page.mouse.move(p.body.x, p.body.y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(180);
    return at;
  };

  // ── 1. The baseline: hover shows it, leaving puts it away ─────────────────
  check('hovering the pencil opens Draw & measure', (await hover('draw')).shown);
  await leave();
  check('and moving off the control puts it away', !(await look('draw')).shown);

  // ── 2. The defect: using a panel must not weld it to the map ──────────────
  // One case per panel, because the three carry different controls and the
  // promotion fired on all of them: a checkbox, a checkbox, a radio. The pair
  // of assertions is deliberate — "still open under the pointer" first, so a
  // fix that merely made panels close on click (breaking the panel instead of
  // fixing it) cannot pass the half that matters.
  for (const [panel, selector, label] of [
    ['draw',    'input[type="checkbox"]', 'Draw & measure ("Snap to stations")'],
    ['display', 'input[type="checkbox"]', 'Map display (a filter checkbox)'],
    ['basemap', 'input[type="radio"]',    'Base map (a base-layer radio)'],
  ]) {
    await hover(panel);
    const hit = await clickInside(panel, selector);
    check(`${label}: the control was there to click`, !!hit);
    if (!hit) continue;
    check(`${label}: the panel stays open while the pointer is still on it`,
      (await look(panel)).shown, JSON.stringify(await look(panel)));
    await leave();
    const after = await look(panel);
    check(`${label}: and it goes away when the pointer leaves`,
      !after.shown, JSON.stringify(after));
  }

  // ── 3. Arming a draw tool leaves the map free to draw on ──────────────────
  // The sharpest form of the defect, and the one it was reported as: the panel
  // you use to pick a tool is the panel covering the ground you picked it for.
  await hover('draw');
  const tool = await page.evaluate(() =>
    document.querySelector('.mn-mapctl[data-panel="draw"] .draw-tool').textContent.trim());
  await clickInside('draw', '.draw-tool');
  check(`clicking "${tool}" arms the tool`, await page.evaluate(() => !!state.draw.tool));
  await leave();
  check('and the panel is off the map, over the ground it was armed for',
    !(await look('draw')).shown, JSON.stringify(await look('draw')));
  await page.evaluate(() => MapDraw.setTool(''));
  await leave();

  // ── 4. They do not stack up ───────────────────────────────────────────────
  // The compounding failure, and the one in the bug report's screenshot: two
  // panels on the map at once, overlapping. Each flyout opens at the top of its
  // *own* icon, and the icons are ~46 px apart while the panels are 150–450 px
  // tall — so a second stuck panel does not sit tidily below the first, it lies
  // across it. What that costs is more than looks: the later control paints on
  // top, so a click aimed at a checkbox in the panel underneath lands on the
  // panel above it instead, and the one underneath loses the hover that was
  // showing it. §2 proves one panel closes; this proves the corner as a whole
  // only ever has one thing open in it.
  await hover('basemap');
  await clickInside('basemap', 'input[type="radio"]');
  await hover('draw');
  const openNow = await page.evaluate(() =>
    [...document.querySelectorAll('.mn-mapctl')]
      .filter((w) => {
        const b = w.querySelector('.mn-mapctl-body');
        return !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length);
      })
      .map((w) => w.dataset.panel));
  check('moving from one panel to the next leaves exactly one open — they never stack',
    openNow.length === 1 && openNow[0] === 'draw', JSON.stringify(openNow));
  await leave();

  // ── 5. The icon reflects what is on screen ────────────────────────────────
  // On a mouse the icon cannot be clicked without being hovered first, so the
  // panel is always already open when the click lands. A toggle that read only
  // its own class flipped to "open" there — a click that looked like it did
  // nothing and left the panel up for good.
  await hover('draw');
  check('hovered open, ready to click the icon', (await look('draw')).shown);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(150);
  let s = await look('draw');
  check('one click on the icon of an open panel shuts it, pointer still on the icon',
    !s.shown && s.expanded === 'false', JSON.stringify(s));
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(150);
  s = await look('draw');
  check('and clicking again opens it', s.shown && s.expanded === 'true', JSON.stringify(s));
  await page.mouse.down(); await page.mouse.up();
  await leave();
  s = await look('draw');
  check('nothing is left holding it shut once the pointer has gone', !s.shut && !s.shown,
    JSON.stringify(s));
  check('so hover opens it again', (await hover('draw')).shown);
  await leave();

  // ── 6. The keyboard keeps its safety net ──────────────────────────────────
  // §2 narrows the focus promotion to keyboard focus, and this is the half of
  // it that must not have been narrowed away: Tab into a panel open on hover
  // alone, move the mouse, and the panel must not go display:none with focus
  // inside it — which drops focus to <body> and starts the next Tab at the top
  // of the document.
  await page.evaluate(() =>
    document.querySelector('.mn-mapctl[data-panel="display"] .mn-mapctl-btn').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  s = await look('display');
  check('Enter on an icon opens its panel and says so', s.shown && s.expanded === 'true',
    JSON.stringify(s));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  s = await look('display');
  check('and Enter again shuts it', !s.shown && s.expanded === 'false', JSON.stringify(s));

  await hover('draw');
  await page.evaluate(() =>
    document.querySelector('.mn-mapctl[data-panel="draw"] .mn-mapctl-btn').focus());
  await page.keyboard.press('Tab');      // the pin
  await page.keyboard.press('Tab');      // the first control in the body
  await page.waitForTimeout(150);
  s = await look('draw');
  check('Tab into a hover-opened panel promotes it to open-for-real', s.open, JSON.stringify(s));
  check('and focus is inside the panel', await page.evaluate(() =>
    document.querySelector('.mn-mapctl[data-panel="draw"]').contains(document.activeElement)));
  await leave();
  s = await look('draw');
  check('and the pointer leaving does not pull it out from under the keyboard',
    s.shown, JSON.stringify(s));
  check('with focus still where the keyboard put it', await page.evaluate(() =>
    document.querySelector('.mn-mapctl[data-panel="draw"]').contains(document.activeElement)));
  await page.evaluate(() => {
    const w = document.querySelector('.mn-mapctl[data-panel="draw"]');
    w.classList.remove('is-open');
    document.activeElement.blur();
  });
  await leave();

  // ── 7. A pointer-focused control is not left stranded ─────────────────────
  // The other end of the same narrowing. A panel closing on hover-out while a
  // *clicked* checkbox still holds focus would send focus to <body>; the icon
  // is where it came from and where Tab should carry on from.
  await hover('basemap');
  await clickInside('basemap', 'input[type="radio"]');
  await leave();
  const landed = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a && a.tagName, cls: (a && a.className) || '', panel:
      a && a.closest ? (a.closest('.mn-mapctl') || {}).dataset?.panel : null };
  });
  check('focus follows the closing panel back to its icon, not to <body>',
    landed.tag === 'BUTTON' && /mn-mapctl-btn/.test(landed.cls) && landed.panel === 'basemap',
    JSON.stringify(landed));

  // ── 8. The pin is still the one thing that does persist ───────────────────
  // Everything above is about panels going away. This is the check that the
  // cure did not become the disease: pinning is the operator saying "keep it",
  // and it has to survive a pointer that is nowhere near the map.
  await page.evaluate(() => MapChrome.setPinned('legend', true));
  await leave();
  s = await look('legend');
  check('a pinned panel is docked and stays with the pointer elsewhere',
    s.shown && s.pinned, JSON.stringify(s));
  const persisted = await page.evaluate(() =>
    (localStorage.getItem('mn-map-panels') || '').split(',').includes('legend'));
  check('and the pin is written down for the next visit', persisted);
  await page.evaluate(() => MapChrome.setPinned('legend', false));
  await leave();
  s = await look('legend');
  check('unpinning puts it away again', !s.shown && !s.pinned, JSON.stringify(s));

  // ── 9. The corner is grouped, and the grouping is on screen (#192) ────────
  // Eleven equal icons in one column, four apart from the panel they belong
  // to, is what this section exists to stop coming back.
  const corner = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width }; };
    const shown = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const bar = document.querySelector('.leaflet-top.leaflet-right .mn-mapbar');
    return {
      controls: document.querySelectorAll('.leaflet-top.leaflet-right > .leaflet-control').length,
      known: Object.keys(MapChrome.groups()),
      loose: bar ? [...bar.children].filter(c => !c.classList.contains('mn-mapbar-group')).length : -1,
      groups: bar ? [...bar.querySelectorAll('.mn-mapbar-group')].map(g => ({
        name:  g.dataset.group,
        label: g.getAttribute('aria-label'),
        role:  g.getAttribute('role'),
        items: [...g.children].map(c => ({
          panel: c.dataset.panel || '',
          cls:   c.className,
          pair:  c.dataset.pair || '',
          order: Number(c.dataset.order),
          shown: shown(c),
          ...box(c),
        })),
      })) : [],
    };
  });

  check('the corner is one control, not one per icon', corner.controls === 1,
    `${corner.controls} controls in the top-right corner`);
  check('and nothing is loose in it — every icon is in a group', corner.loose === 0,
    `${corner.loose} children of the bar are not groups`);

  const names = corner.groups.map(g => g.name);
  check('every group on screen is one MapChrome names',
    names.every(n => corner.known.includes(n)), JSON.stringify({ names, known: corner.known }));
  check('and they are in the order it declares them in',
    JSON.stringify(names) === JSON.stringify(corner.known.filter(n => names.includes(n))),
    JSON.stringify(names));
  check('each one is a labelled group, so the hairline means something without eyes',
    corner.groups.every(g => g.role === 'group' && !!g.label),
    JSON.stringify(corner.groups.map(g => [g.name, g.role, g.label])));
  check('the destructive one is still last in the column', names[names.length - 1] === 'reset',
    JSON.stringify(names));

  // The separators, measured rather than read off the stylesheet: what a
  // reader has to be able to see is that the gap between two groups is bigger
  // than the gaps inside them. A hairline that renders as nothing still fails
  // here, because the spacing it sits in is part of the same rule.
  const visible = corner.groups.map(g => g.items.filter(i => i.shown)).filter(g => g.length);
  const inside = [];
  for (const g of visible) for (let i = 1; i < g.length; i++) inside.push(g[i].top - g[i - 1].bottom);
  const between = [];
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1], next = visible[i];
    between.push(next[0].top - prev[prev.length - 1].bottom);
  }
  check('every gap between two groups is wider than every gap inside one',
    between.length > 1 && inside.length > 1 && Math.min(...between) > Math.max(...inside),
    JSON.stringify({ inside, between }));

  // The split button: the ⛰️ that turns 3-D on and the caret that opens
  // everything about it, as one control. "Adjacent" is the claim, and touching
  // is how it is made — so both halves are measured, not just found.
  const three = corner.groups.find(g => g.name === '3d') || { items: [] };
  const mode  = three.items.find(i => /mn-map-3d/.test(i.cls));
  const caret = three.items.find(i => i.panel === '3d');
  check('the ⛰️ mode and the 3-D panel are in the same group', !!mode && !!caret);
  if (mode && caret) {
    check('…next to each other, in that order', caret.order > mode.order
      && !three.items.some(i => i.order > mode.order && i.order < caret.order),
      JSON.stringify(three.items.map(i => [i.order, i.cls])));
    check('…joined into one control rather than two buttons a gap apart',
      Math.abs(caret.top - mode.bottom) <= 1 && Math.abs(caret.w - mode.w) < 1,
      JSON.stringify({ modeBottom: mode.bottom, caretTop: caret.top, w: [mode.w, caret.w] }));
    check('…and the small half is the smaller one',
      (caret.bottom - caret.top) < (mode.bottom - mode.top) * 0.75,
      JSON.stringify({ mode: mode.bottom - mode.top, caret: caret.bottom - caret.top }));
  }

  // The camera pair. There is no camera in 2-D — Leaflet has no pitch and no
  // bearing — so these two are built, placed in the 3-D group, and not on the
  // map. Asked of the geometry: `[hidden]` loses to `.mn-mapctl-btn`'s own
  // `display: flex` at the same specificity, which is a set attribute and a
  // button still on screen.
  for (const [cls, what] of [['mn-map-north', 'the compass'], ['mn-map-tilt', 'the tilt']]) {
    const b = three.items.find(i => i.cls.includes(cls));
    check(`${what} button is in the 3-D group`, !!b, JSON.stringify(three.items.map(i => i.cls)));
    if (b) check(`…and is not on the map while the map is flat`, !b.shown,
      JSON.stringify(b));
  }

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the on-map panels put themselves away, and only the pin keeps one.');
