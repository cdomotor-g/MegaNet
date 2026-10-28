// A map card made wider by the handle on its edge (card-width.js), and the
// app's own scrollbar, in Chromium with the pointer moved as a mouse.
//
//   1. **The handle** — on the Stations map with a station card open: the
//      card's next sibling, a focusable, named, vertical separator with a
//      value, laid over the card's right edge (the one facing the map) at the
//      card's height and z-index, and the thing under the pointer just outside
//      that edge.
//   2. **The drag** — 160 px right is 160 px wider with the handle still on the
//      edge and the width stored under the card; far right stops at the card's
//      own max-width (82 % of the map), far left at the 280 px floor; a tap
//      that wobbles a pixel is not a width.
//   3. **Kept** — through a repaint for another station, a close and a reopen,
//      a full render of the tab (a new card element) and a reload.
//   4. **The keyboard** — → ← a step, End the widest, Home the narrowest,
//      Enter and a double-click back to the card's own width and forgotten,
//      Escape closing the card as it does from inside it.
//   5. **The other edge** — the ACMA card, anchored at the right, has its
//      handle on its left edge, and dragging that left widens it.
//   6. **Its height** — lifted with the station card when the 3-D view's class
//      lifts the card, the next time the pointer comes over the map.
//   7. **The phone** — at 375 px the station card is a sheet across the map
//      and has no handle.
//   8. **The scrollbar** — in a browser that draws real scrollbars, the card's
//      gutter and the page's are the app's 10 px, not the browser's own.
//
// Why a check of its own: a handle under the card's scrollbar, a handle left
// behind where the card was, a width that reverts on the next pin click — none
// of them is an error, and every other check sees a card that looks fine.
//
// Run:  npm run cardwidth
//       npm run cardwidth -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const STORE = 'mn-card-w';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && (!ok || VERBOSE) ? ` — ${detail}` : ''}`);
}
const log = (...a) => console.log(...a);
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const J = v => JSON.stringify(v);

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await load(page, server);
  return { context, page };
}

async function load(page, server) {
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom
    && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
  await page.waitForTimeout(150);
}

// The n-th located station's card, opened without moving the map.
const openCard = (page, n = 0) => page.evaluate(i => {
  const s = state.data.stations.filter(x => x.lat != null && x.lon != null)[i];
  showStationCard(s.id, { select: false });
  return s.id;
}, n);

// A card and its handle, as the page has them.
const read = (page, id = 'stn-card') => page.evaluate(cid => {
  const card = document.getElementById(cid);
  if (!card) return null;
  const grip = card.nextElementSibling;
  const c = card.getBoundingClientRect();
  const isGrip = !!grip && grip.classList.contains('mn-cardw');
  const g = isGrip ? grip.getBoundingClientRect() : null;
  const mid = { x: 0, y: c.top + c.height / 2 };
  return {
    hidden: card.hidden, left: c.left, right: c.right, top: c.top, height: c.height, width: c.width,
    z: getComputedStyle(card).zIndex,
    grip: isGrip && {
      hidden: grip.hidden, left: g.left, right: g.right, top: g.top, height: g.height, width: g.width,
      side: grip.dataset.side, z: getComputedStyle(grip).zIndex,
      role: grip.getAttribute('role'), orient: grip.getAttribute('aria-orientation'),
      label: grip.getAttribute('aria-label'), controls: grip.getAttribute('aria-controls'),
      now: Number(grip.getAttribute('aria-valuenow')), min: Number(grip.getAttribute('aria-valuemin')),
      max: Number(grip.getAttribute('aria-valuemax')), tab: grip.tabIndex,
      // What is under the pointer just outside the edge the handle is on.
      hit: (() => {
        mid.x = grip.dataset.side === 'left' ? c.left - 4 : c.right + 4;
        const t = document.elementFromPoint(mid.x, mid.y);
        return t === grip;
      })(),
    },
  };
}, id);

const stored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}'), STORE);

// A drag of the handle by dx, in six steps, from just outside the card's edge.
async function drag(page, at, dx) {
  const x = at.grip.side === 'left' ? at.left - 4 : at.right + 4;
  const y = at.top + at.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

const onEdge = (r, side = 'right') => !!r.grip && !r.grip.hidden
  && near(side === 'right' ? r.grip.left : r.grip.right, side === 'right' ? r.right - 3 : r.left + 3, 1.5)
  && near(r.grip.top, r.top, 1) && near(r.grip.height, r.height, 1.5);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];

  try {
    log('\nThe handle on the station card\'s edge\n');
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
    const first = await openCard(page, 0);
    await page.waitForTimeout(150);
    let r = await read(page);
    check('the station card is open, at its own 340 px', r && !r.hidden && near(r.width, 340, 1), J(r && { hidden: r.hidden, width: r.width }));
    check('its next sibling is the handle: a focusable separator, vertical, named, controlling the card',
      r.grip && r.grip.role === 'separator' && r.grip.orient === 'vertical' && r.grip.tab === 0
        && /width/i.test(r.grip.label || '') && r.grip.controls === 'stn-card', J(r.grip));
    check('…on the right edge, the one facing the map, at the card\'s height', onEdge(r) && r.grip.side === 'right', J({ card: r, grip: r.grip }));
    check('…at the card\'s z-index', r.grip.z === r.z, J({ card: r.z, grip: r.grip.z }));
    check('…with a value: the width now, 280 the least, more than now the most',
      near(r.grip.now, 340, 1) && r.grip.min === 280 && r.grip.max > 340, J(r.grip));
    check('…and it is the thing under the pointer just outside the edge', r.grip.hit);

    log('\nDragged\n');
    await drag(page, r, 160);
    r = await read(page);
    let s = await stored(page);
    check('160 px right is 160 px wider', near(r.width, 500, 2), `width ${r.width}`);
    check('…with the handle still on the edge and its value following', onEdge(r) && near(r.grip.now, r.width, 1), J(r.grip));
    check('…and the width stored under the card', near(s['stn-card'], 500, 2), J(s));
    const stage = await page.evaluate(() => document.querySelector('.mn-map-stage').clientWidth);
    await drag(page, r, 2000);
    r = await read(page);
    check('far right stops at the card\'s own max-width, 82 % of the map', near(r.width, Math.floor(stage * 0.82), 2) && near(r.grip.max, r.width, 1),
      J({ width: r.width, stage, max: r.grip.max }));
    await drag(page, r, -2000);
    r = await read(page);
    check('far left stops at the 280 px floor', near(r.width, 280, 1), `width ${r.width}`);
    await drag(page, r, 120);
    r = await read(page);
    const w = r.width;
    check('…and from there 120 px right is 400 wide', near(w, 400, 2), `width ${w}`);
    // A tap that wobbles: down, a pixel, up.
    await page.mouse.move(r.right + 4, r.top + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.right + 5, r.top + r.height / 2);
    await page.mouse.up();
    r = await read(page);
    check('a tap that wobbles a pixel changes nothing', near(r.width, w, 0.5), `${w} → ${r.width}`);

    log('\nKept\n');
    const second = await openCard(page, 5);
    await page.waitForTimeout(150);
    r = await read(page);
    check('a repaint for another station keeps the width and the handle', second !== first && near(r.width, w, 1) && onEdge(r), J({ width: r.width, w }));
    await page.evaluate(() => closeStnCard());
    r = await read(page);
    check('closing the card hides the handle with it', r.hidden && r.grip && r.grip.hidden, J(r.grip));
    await openCard(page, 0);
    await page.waitForTimeout(150);
    r = await read(page);
    check('…and reopening it brings both back, at the same width', !r.hidden && near(r.width, w, 1) && onEdge(r), J({ width: r.width }));
    await page.evaluate(() => { switchTab('home'); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { switchTab('stations'); });
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: 20_000 });
    await openCard(page, 0);
    await page.waitForTimeout(200);
    r = await read(page);
    const handles = await page.evaluate(() => document.querySelectorAll('.mn-cardw').length);
    check('a new card from a full render of the tab comes up at the stored width, with one handle',
      near(r.width, w, 1) && onEdge(r) && handles === 3, J({ width: r.width, handles }));
    await load(page, server);
    await openCard(page, 0);
    await page.waitForTimeout(200);
    r = await read(page);
    check('…and so does the card after a reload', near(r.width, w, 1) && onEdge(r), J({ width: r.width }));

    log('\nThe keyboard\n');
    await page.focus('#stn-card + .mn-cardw');
    await page.keyboard.press('ArrowRight');
    r = await read(page);
    check('→ moves the edge right a step: 20 px wider', near(r.width, w + 20, 1), `${w} → ${r.width}`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    r = await read(page);
    check('← moves it back left', near(r.width, w - 20, 1), `${r.width}`);
    await page.keyboard.press('End');
    r = await read(page);
    check('End: the widest', near(r.width, r.grip.max, 1) && near(r.width, Math.floor(stage * 0.82), 2), `${r.width} of ${r.grip.max}`);
    await page.keyboard.press('Home');
    r = await read(page);
    check('Home: the narrowest', near(r.width, 280, 1), `${r.width}`);
    await page.keyboard.press('Enter');
    r = await read(page);
    s = await stored(page);
    check('Enter: back to the card\'s own 340, and forgotten', near(r.width, 340, 1) && !('stn-card' in s), J({ width: r.width, s }));
    await drag(page, r, 100);
    r = await read(page);
    await page.mouse.dblclick(r.right + 4, r.top + r.height / 2);
    await page.waitForTimeout(80);
    r = await read(page);
    s = await stored(page);
    check('a double-click puts a dragged card back too, and forgets it', near(r.width, 340, 1) && !('stn-card' in s), J({ width: r.width, s }));
    await page.focus('#stn-card + .mn-cardw');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    r = await read(page);
    const focusAfter = await page.evaluate(() => document.activeElement && document.activeElement !== document.body);
    check('Escape on the handle closes the card, with focus put somewhere, not on <body>', r.hidden && r.grip.hidden && focusAfter,
      J({ hidden: r.hidden, focusAfter }));

    log('\nIts height, in the 3-D view\n');
    await openCard(page, 0);
    await page.waitForTimeout(150);
    // The class Map3D.open() puts on its canvas host, standing in for the
    // canvas itself: what lifts the card is the stylesheet's :has() on it.
    await page.evaluate(() => {
      const h = document.createElement('div');
      h.id = 'map3d'; h.className = 'is-on mn-test-fake';
      state.map.getContainer().appendChild(h);
    });
    r = await read(page);
    await page.mouse.move(700, 300);
    await page.mouse.move(720, 320);
    await page.waitForTimeout(80);
    const lifted = await read(page);
    check('the card lifted over the 3-D canvas lifts the handle with it once the pointer is over the map',
      lifted.z === '760' && lifted.grip.z === '760', J({ card: lifted.z, grip: lifted.grip.z }));
    await page.evaluate(() => document.querySelector('.mn-test-fake').remove());
    await page.mouse.move(700, 300);
    await page.waitForTimeout(80);
    r = await read(page);
    check('…and put back down with it', r.z === '690' && r.grip.z === '690', J({ card: r.z, grip: r.grip.z }));
    await page.evaluate(() => closeStnCard());

    log('\nThe ACMA card: the other edge\n');
    // Shown by hand, as its renderer would leave it: what matters here is the
    // card's anchoring, not the licence it is about.
    await page.evaluate(() => {
      const a = document.getElementById('acma-card');
      a.innerHTML = '<div class="acma-card-head"><strong>Test</strong></div><div class="acma-sect">x</div>';
      a.hidden = false;
    });
    await page.waitForTimeout(100);
    r = await read(page, 'acma-card');
    check('the ACMA card, anchored at the right, has its handle on its left edge', onEdge(r, 'left') && r.grip.side === 'left' && r.grip.hit,
      J({ card: { left: r.left, top: r.top, height: r.height }, grip: r.grip }));
    const aw = r.width;
    await drag(page, r, -100);
    r = await read(page, 'acma-card');
    s = await stored(page);
    check('…and dragging that edge 100 px left is 100 px wider, its right edge where it was, stored under it',
      near(r.width, aw + 100, 2) && onEdge(r, 'left') && near(s['acma-card'], aw + 100, 2), J({ was: aw, now: r.width, s }));
    await page.focus('#acma-card + .mn-cardw');
    await page.keyboard.press('ArrowLeft');
    const ak = await read(page, 'acma-card');
    check('…and ← moves that edge left: wider', near(ak.width, r.width + 20, 1), `${r.width} → ${ak.width}`);
    await page.evaluate(() => closeAcmaCard(false));
    await context.close();

    log('\nThe phone\n');
    const phone = await openStations(browser, server, errors, { viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });
    await openCard(phone.page, 0);
    await phone.page.waitForTimeout(200);
    r = await read(phone.page);
    check('at 375 px the station card is a sheet and has no handle', !r.hidden && r.grip && r.grip.hidden, J({ hidden: r.hidden, grip: r.grip }));
    await phone.context.close();
  } finally {
    await browser.close();
  }

  log('\nThe scrollbar\n');
  // Playwright's headless default hides scrollbars, which would make any
  // gutter zero; this one draws them, as a desktop browser does.
  const classic = await launchBrowser({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const { page } = await openStations(classic, server, errors, { viewport: { width: 1440, height: 700 } });
    // A station card long enough to scroll.
    await openCard(page, 0);
    await page.waitForTimeout(400);
    const bars = await page.evaluate(() => {
      const card = document.getElementById('stn-card');
      const cs = getComputedStyle(card);
      const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const root = document.documentElement;
      return {
        scrolls: card.scrollHeight > card.clientHeight + 1,
        card: card.offsetWidth - card.clientWidth - borders,
        page: root.scrollHeight > root.clientHeight ? window.innerWidth - root.clientWidth : null,
      };
    });
    check('the station card scrolls, in the app\'s 10 px gutter rather than the browser\'s own',
      bars.scrolls && bars.card === 10, J(bars));
    check('…and so does the page, where it scrolls', bars.page == null || bars.page === 10, J(bars));
  } finally {
    await classic.close();
    await server.close();
  }

  check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(x => !x.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — a map card is as wide as its edge is dragged, from the mouse or the\n'
    + '       keyboard, and stays that wide; and the scrollbars are the app\'s own.');
}

main().catch(err => { console.error(err); process.exit(1); });
