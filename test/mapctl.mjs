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
