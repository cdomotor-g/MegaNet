// A title's words above the pointer (tooltips.js): the app's own tip in place
// of the browser's box under the pointer, where the pointer covers its first
// words. In Chromium, with the pointer moved by Playwright as a mouse:
//
//   1. **Stands down under automation** unless asked (mn-tips = 'on'): a
//      title stays a title and no tip is made.
//   2. **Above the pointer.** Nothing for half a second, the title held as ""
//      from the first moment (so the browser's own never comes); then the
//      words, over the pointer and clear of it, following it as it moves, and
//      the element described by the tip — or named by it, when the title was
//      all that named it. Everything put back on leaving.
//   3. **As the browser times it.** The next one at once while warm, half a
//      second again once cold; a press puts it away until the pointer moves
//      on; a finger never starts one.
//   4. **What the page's own code does meanwhile** is followed: a new title
//      shown and kept, a title taken away not put back, an element taken off
//      the page given its title back.
//   5. **SVG <title>**, an inner title="" keeping an outer one quiet, the top
//      of the window (under, clear of the pointer) and its right edge.
//   6. **The app's own markup**: the banner's Search button.
//
// Run:  npm run tooltips
//       npm run tooltips -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const J = v => JSON.stringify(v);

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && (!ok || VERBOSE) ? ` — ${detail}` : ''}`);
}
const log = (...a) => console.log(...a);
const NOISE = /^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i;

async function open(browser, server, { storage, errors }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(s => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { errors.push(`dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(300);
  // Elements of known shape, over everything the app draws.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'tt-fixture';
    host.style.cssText = 'position:fixed;left:300px;top:260px;z-index:3000;background:#fff;display:grid;gap:16px;padding:0';
    host.innerHTML = `
      <button id="tt-a" title="First tip — what this button does" style="width:220px;height:60px">A</button>
      <button id="tt-b" title="Second tip" style="width:220px;height:60px">B</button>
      <span id="tt-icon" title="Named only by its title" style="display:block;width:40px;height:40px;background:#ccc"></span>
      <div id="tt-plain" style="width:220px;height:40px">no title</div>
      <svg id="tt-svg" width="220" height="40"><rect id="tt-rect" width="220" height="40" fill="#9cf"><title>An SVG shape's title</title></rect></svg>
      <div id="tt-outer" title="The outer one" style="padding:12px"><span id="tt-inner" title="" style="display:block;height:30px">quiet inside</span></div>`;
    document.body.appendChild(host);
    const top = document.createElement('button');
    top.id = 'tt-top'; top.title = 'At the top of the window';
    top.style.cssText = 'position:fixed;left:640px;top:0;width:160px;height:30px;z-index:3000';
    document.body.appendChild(top);
    const right = document.createElement('button');
    right.id = 'tt-right'; right.title = 'At the right edge, a long title that would run off the window if it were centred on the pointer';
    right.style.cssText = 'position:fixed;right:0;top:500px;width:40px;height:40px;z-index:3000';
    document.body.appendChild(right);
  });
  return { context, page };
}

const centre = async (page, sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};

// The tip and the element, as the page has them.
const read = (page, id) => page.evaluate(id => {
  const el = document.getElementById(id), tip = document.getElementById('mn-tip');
  const open = !!tip && (tip.hasAttribute('popover') ? tip.matches(':popover-open') : !tip.hidden);
  const r = open ? tip.getBoundingClientRect() : null;
  return {
    title: el ? el.getAttribute('title') : undefined,
    open, made: !!tip, popover: !!tip && tip.hasAttribute('popover'),
    text: tip ? tip.textContent : null,
    rect: r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    describedby: el ? el.getAttribute('aria-describedby') : null,
    label: el ? el.getAttribute('aria-label') : null,
    vw: document.documentElement.clientWidth,
  };
}, id);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];

  try {
    // ── 1. Under automation, unasked ─────────────────────────────────────────
    log('\n1. Stands down under automation unless asked\n');
    let { context, page } = await open(browser, server, { storage: { 'mn-look-intro': 'seen' }, errors });
    let p = await centre(page, '#tt-a');
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(800);
    let s = await read(page, 'tt-a');
    check('a title stays a title, and no tip is made', s.title === 'First tip — what this button does' && !s.made, J(s));
    await context.close();

    // ── 2. Above the pointer ─────────────────────────────────────────────────
    log('\n2. Above the pointer\n');
    ({ context, page } = await open(browser, server, { storage: { 'mn-tips': 'on', 'mn-look-intro': 'seen' }, errors }));
    await page.mouse.move(5, 790);
    p = await centre(page, '#tt-a');
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(150);
    s = await read(page, 'tt-a');
    check('held at once — the title is "" so the browser\'s own never comes — and no tip yet', s.title === '' && !s.open, J(s));
    await page.waitForTimeout(600);
    s = await read(page, 'tt-a');
    check('half a second on, the words', s.open && s.text === 'First tip — what this button does', J(s));
    check('…in the top layer', s.popover, J(s));
    check('…above the pointer and clear of it, centred over it',
      s.rect && s.rect.bottom <= p.y - 8 && s.rect.left < p.x && s.rect.right > p.x
        && Math.abs((s.rect.left + s.rect.right) / 2 - p.x) <= 1, J({ p, rect: s.rect }));
    check('…and the element described by it', s.describedby === 'mn-tip', J(s));
    const q = { x: p.x + 60, y: p.y + 20 };
    await page.mouse.move(q.x, q.y, { steps: 4 });
    await page.waitForTimeout(120);
    s = await read(page, 'tt-a');
    check('it follows the pointer', s.open && s.rect.bottom <= q.y - 8 && Math.abs((s.rect.left + s.rect.right) / 2 - q.x) <= 1,
      J({ q, rect: s.rect }));
    let c = await centre(page, '#tt-plain');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-a');
    check('off it, the tip goes and everything is put back', !s.open && s.title === 'First tip — what this button does'
      && s.describedby === null, J(s));

    // Named only by its title: named by the tip's words while held.
    c = await centre(page, '#tt-icon');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await read(page, 'tt-icon');
    check('an element its title alone names is named by the words while held', s.open && s.label === 'Named only by its title'
      && s.title === '' && s.describedby === null, J(s));
    c = await centre(page, '#tt-plain');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-icon');
    check('…and the name taken off again', s.label === null && s.title === 'Named only by its title', J(s));

    // ── 3. As the browser times it ───────────────────────────────────────────
    log('\n3. As the browser times it\n');
    p = await centre(page, '#tt-a');
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(700);
    c = await centre(page, '#tt-b');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-b');
    check('the next one at once while warm', s.open && s.text === 'Second tip', J(s));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(900);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(150);
    s = await read(page, 'tt-b');
    check('half a second again once cold', !s.open && s.title === '', J(s));
    await page.waitForTimeout(600);
    s = await read(page, 'tt-b');
    check('…then the words', s.open && s.text === 'Second tip', J(s));
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(700);
    s = await read(page, 'tt-b');
    check('a press puts it away, still held, until the pointer moves on', !s.open && s.title === '', J(s));
    await page.mouse.move(c.x + 30, c.y + 5, { steps: 3 });
    await page.waitForTimeout(700);
    s = await read(page, 'tt-b');
    check('…moving on the same element does not bring it back', !s.open, J(s));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-b');
    check('…and off it, the title is back', s.title === 'Second tip', J(s));
    await page.waitForTimeout(700);
    s = await page.evaluate(() => {
      const el = document.getElementById('tt-b'), r = el.getBoundingClientRect();
      const at = { bubbles: true, pointerType: 'touch', clientX: r.left + 10, clientY: r.top + 10 };
      el.dispatchEvent(new PointerEvent('pointerover', at));
      el.dispatchEvent(new PointerEvent('pointermove', at));
      return el.getAttribute('title');
    });
    await page.waitForTimeout(700);
    const touch = await read(page, 'tt-b');
    check('a finger never starts one', s === 'Second tip' && touch.title === 'Second tip' && !touch.open, J({ s, touch }));

    // ── 4. What the page's own code does meanwhile ───────────────────────────
    log('\n4. What the page\'s own code does meanwhile\n');
    p = await centre(page, '#tt-a');
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(700);
    await page.evaluate(() => { document.getElementById('tt-a').title = 'Changed by its code'; });
    await page.waitForTimeout(400);
    s = await read(page, 'tt-a');
    check('a new title is shown, and held in turn', s.open && s.text === 'Changed by its code' && s.title === '', J(s));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-a');
    check('…and kept on leaving, not the old one', s.title === 'Changed by its code', J(s));

    c = await centre(page, '#tt-b');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('tt-b').removeAttribute('title'));
    await page.waitForTimeout(400);
    s = await read(page, 'tt-b');
    check('a title taken away: the tip goes', !s.open && s.title === null, J(s));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(100);
    s = await read(page, 'tt-b');
    check('…and nothing is put back', s.title === null && s.describedby === null, J(s));

    p = await centre(page, '#tt-a');
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.__ttA = document.getElementById('tt-a'); window.__ttA.remove(); });
    await page.waitForTimeout(400);
    s = await page.evaluate(() => {
      const tip = document.getElementById('mn-tip');
      return { open: tip.matches(':popover-open'), title: window.__ttA.getAttribute('title'),
               describedby: window.__ttA.getAttribute('aria-describedby') };
    });
    check('an element taken off the page: the tip goes, its title back for when it returns',
      !s.open && s.title === 'Changed by its code' && s.describedby === null, J(s));

    // ── 5. SVG, a quiet inner title, the window's edges ──────────────────────
    log('\n5. SVG, a quiet inner title, the window\'s edges\n');
    await page.mouse.move(5, 790);
    await page.waitForTimeout(700);
    c = await centre(page, '#tt-rect');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await page.evaluate(() => {
      const tip = document.getElementById('mn-tip');
      return { open: tip.matches(':popover-open'), text: tip.textContent,
               held: document.querySelector('#tt-rect > title').textContent };
    });
    check('an SVG shape\'s <title>: emptied while held, its words in the tip', s.open && s.held === '' && s.text === 'An SVG shape\'s title', J(s));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(100);
    s = await page.evaluate(() => document.querySelector('#tt-rect > title').textContent);
    check('…and filled again after', s === 'An SVG shape\'s title', J(s));

    await page.waitForTimeout(700);
    c = await centre(page, '#tt-inner');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await read(page, 'tt-outer');
    check('an inner title="" keeps the outer one quiet, as the browser does', !s.open && s.title === 'The outer one', J(s));

    await page.mouse.move(5, 790);
    await page.waitForTimeout(700);
    c = { x: 720, y: 12 };
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await read(page, 'tt-top');
    check('no room above: under the pointer, clear of it', s.open && s.rect.top >= c.y + 24, J({ c, rect: s.rect }));

    await page.mouse.move(5, 790);
    await page.waitForTimeout(700);
    c = await centre(page, '#tt-right');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await read(page, 'tt-right');
    check('at the right edge, kept inside the window and still above', s.open && s.rect.right <= s.vw - 4
      && s.rect.left >= 4 && s.rect.bottom <= c.y - 8, J({ c, rect: s.rect, vw: s.vw }));

    // ── 6. The app's own markup ──────────────────────────────────────────────
    log('\n6. The app\'s own markup\n');
    await page.mouse.move(5, 790);
    await page.waitForTimeout(700);
    const want = await page.evaluate(() => document.getElementById('btn-palette').getAttribute('title'));
    c = await centre(page, '#btn-palette');
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(700);
    s = await read(page, 'btn-palette');
    check('the banner\'s Search button: its title\'s words, above the pointer, or under it at the very top',
      s.open && s.text === want && s.title === '' && (s.rect.bottom <= c.y - 8 || s.rect.top >= c.y + 24), J({ c, s, want }));
    await page.mouse.move(5, 790);
    await page.waitForTimeout(100);
    s = await read(page, 'btn-palette');
    check('…and its title back after', s.title === want, J(s));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — a title's words above the pointer, timed as the browser times them, everything put back (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
