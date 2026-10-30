// A capped table's card made taller by its handle (card-grip.js).
//
// What it holds the handle to: there under a table taller than its card, and
// not under one that fits or one in a grid or a flex row; taking no room —
// a card with a handle laid out to the pixel as the same card without one,
// in a block and in a flex column with a gap; a drag that moves the bottom
// edge with the pointer, stops where the rows run out and never goes under
// the floor; the height kept on this device and put back when the tab draws
// the card again; double-click filling the window and then putting it back;
// the keyboard's steps, Home and End; a handle going when its table goes;
// and no errors along the way.
//
// Run:  npm run grip
//       npm run grip -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const STORE = 'mn-grip-h';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && (!ok || VERBOSE) ? ` — ${detail}` : ''}`);
}
const log = (...a) => console.log(...a);
const NOISE = /^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i;
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const J = v => JSON.stringify(v);

// The first capped table on the tab that has more rows than it shows (one in
// a fold that is shut has its handle hidden, rightly), and its handle, as the
// page has them.
const readTable = page => page.evaluate(() => {
  const wrap = [...document.querySelectorAll('#main-content .table-wrap.tall, #main-content .table-wrap.medium')]
    .find(w => w.getClientRects().length && !w.closest('details:not([open])') && w.scrollHeight > w.clientHeight + 1);
  if (!wrap) return null;
  const grip = wrap.nextElementSibling;
  const r = wrap.getBoundingClientRect();
  const g = grip && grip.classList.contains('mn-grip') ? grip.getBoundingClientRect() : null;
  return {
    h: r.height, bottom: r.bottom, left: r.left, width: r.width,
    scroll: wrap.scrollHeight, client: wrap.clientHeight,
    inline: wrap.style.maxHeight,
    grip: g && {
      hidden: grip.hidden, top: g.top, bottom: g.bottom, height: g.height, width: g.width,
      role: grip.getAttribute('role'), label: grip.getAttribute('aria-label'),
      now: Number(grip.getAttribute('aria-valuenow')), tab: grip.tabIndex,
    },
  };
});

// The same, with the handle scrolled to the middle of the window first, where
// a pointer can reach it.
const inView = async page => {
  await page.evaluate(() => {
    const wrap = [...document.querySelectorAll('#main-content .table-wrap.tall, #main-content .table-wrap.medium')]
      .find(w => w.getClientRects().length && !w.closest('details:not([open])') && w.nextElementSibling && w.nextElementSibling.classList.contains('mn-grip')
        && !w.nextElementSibling.hidden);
    if (wrap) wrap.nextElementSibling.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(50);
  return readTable(page);
};

const stored = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}'), STORE);

async function drag(page, from, dy) {
  const x = from.left + from.width / 2;
  const y = (from.grip.top + from.grip.bottom) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (dy * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
    await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });

    // ── 1. A table taller than its card ──────────────────────────────────────
    log('\n1. A handle under a table taller than its card\n');
    await page.evaluate(() => switchTab('repeaters'));
    await page.waitForTimeout(500);
    const t0 = await readTable(page);
    check('Repeaters has a capped table with more rows than it shows', !!t0, J(t0));
    if (!t0) throw new Error('no capped table to test against');
    check('the handle is the next element after the table, and showing', !!t0.grip && !t0.grip.hidden, J(t0.grip));
    check('it is a focusable, named separator with a value',
      t0.grip.role === 'separator' && t0.grip.tab === 0 && /^Height of /.test(t0.grip.label || '') && near(t0.grip.now, t0.h, 1),
      J(t0.grip));
    check('it lies across the bottom edge, as wide as the table',
      t0.grip.top < t0.bottom && t0.grip.bottom > t0.bottom && near(t0.grip.width, t0.width, 2), J({ t0 }));

    // ── 2. It takes no room ──────────────────────────────────────────────────
    log('\n2. A card with a handle is laid out as the same card without one\n');
    const room = await page.evaluate(() => {
      const make = (parentCss, noGrip) => {
        const host = document.createElement('div');
        if (noGrip) host.dataset.noGrip = '';
        host.style.cssText = `position:absolute;left:0;top:0;width:400px;${parentCss}`;
        host.innerHTML = `<p style="margin:0 0 12px">above</p>
          <div class="table-wrap tall" style="max-height:120px"><div style="height:600px"></div></div>
          <p class="after" style="margin:5px 0 0">after</p>`;
        document.getElementById('main-content').appendChild(host);
        return host;
      };
      const out = {};
      return new Promise(resolve => requestAnimationFrame(() => {
        for (const [name, css] of [['block', 'display:block'], ['flex column', 'display:flex;flex-direction:column;gap:10px'],
                                   ['grid', 'display:grid;gap:10px'], ['flex row', 'display:flex;gap:10px']]) {
          const a = make(css, false), b = make(css, true);
          out[name] = { a, b };
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const res = {};
          for (const [name, { a, b }] of Object.entries(out)) {
            const grip = a.querySelector('.mn-grip');
            res[name] = {
              grip: !!grip && !grip.hidden,
              afterA: a.querySelector('.after').offsetTop, afterB: b.querySelector('.after').offsetTop,
              hA: a.offsetHeight, hB: b.offsetHeight,
            };
            a.remove(); b.remove();
          }
          resolve(res);
        }));
      }));
    });
    for (const name of ['block', 'flex column']) {
      const r = room[name];
      check(`${name}: a handle, and what follows the table exactly where it was without one`,
        r.grip && r.afterA === r.afterB && r.hA === r.hB, J(r));
    }
    for (const name of ['grid', 'flex row']) {
      check(`${name}: no handle, where it would sit beside the table rather than under it`, !room[name].grip, J(room[name]));
    }
    const fits = await page.evaluate(() => new Promise(resolve => {
      const host = document.createElement('div');
      host.innerHTML = '<div class="table-wrap tall" style="max-height:300px"><div style="height:80px"></div></div>';
      document.getElementById('main-content').appendChild(host);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const g = host.querySelector('.mn-grip');
        resolve({ made: !!g, hidden: g ? g.hidden : null });
        host.remove();
      }));
    }));
    check('a table that fits its card has no handle showing', !fits.made || fits.hidden, J(fits));

    // ── 3. Dragging ──────────────────────────────────────────────────────────
    log('\n3. Dragged, it follows the pointer and stops where the rows run out\n');
    await drag(page, await inView(page), 160);
    const t1 = await readTable(page);
    check('dragged down 160 px, the table is 160 px taller', near(t1.h, t0.h + 160, 3), J({ before: t0.h, after: t1.h }));
    check('the handle stays on its bottom edge', t1.grip.top < t1.bottom && t1.grip.bottom > t1.bottom, J(t1.grip));
    const s1 = await stored(page);
    const key = Object.keys(s1).find(k => k.startsWith('repeaters'));
    check('the height is kept on this device, under the tab', !!key && near(s1[key], t1.h, 3), J(s1));
    await drag(page, await inView(page), -600);
    const tMin = await readTable(page);
    check('dragged far up, it stops at the floor (72 px)', near(tMin.h, 72, 1), J(tMin.h));

    // ── 4. Put back when the tab draws it again ──────────────────────────────
    log('\n4. Put back when the tab draws the card again\n');
    await drag(page, await inView(page), 200);
    const tSet = await readTable(page);
    await page.evaluate(() => switchTab('export'));
    await page.waitForTimeout(300);
    await page.evaluate(() => switchTab('repeaters'));
    await page.waitForTimeout(500);
    const tBack = await readTable(page);
    check('a new table, drawn at the height it was left at', tBack && near(tBack.h, tSet.h, 2), J({ set: tSet.h, back: tBack && tBack.h }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('repeaters'));
    await page.waitForTimeout(500);
    const tReload = await readTable(page);
    check('and after the app is opened again', tReload && near(tReload.h, tSet.h, 2), J({ set: tSet.h, reload: tReload && tReload.h }));

    // ── 5. Double-click ──────────────────────────────────────────────────────
    log('\n5. Double-click puts it back, then fills the window\n');
    const gripBox = r => ({ x: r.left + r.width / 2, y: (r.grip.top + r.grip.bottom) / 2 });
    let p = gripBox(await inView(page));
    await page.mouse.dblclick(p.x, p.y);
    await page.waitForTimeout(80);
    const tReset = await readTable(page);
    const s2 = await stored(page);
    check('once moved, double-click puts it back to the card\'s own height', near(tReset.h, t0.h, 1) && !tReset.inline,
      J({ default: t0.h, now: tReset.h, inline: tReset.inline }));
    check('and forgets the height it was left at', !(key in s2), J(s2));
    p = gripBox(await inView(page));
    await page.mouse.dblclick(p.x, p.y);
    await page.waitForTimeout(80);
    const tFill = await readTable(page);
    const want = Math.min(Math.round(900 * 0.85), tFill.scroll + 2);
    check('at its own height, double-click fills 85 % of the window (or shows every row)', near(tFill.h, want, 3),
      J({ want, got: tFill.h }));

    // ── 6. Keyboard ──────────────────────────────────────────────────────────
    log('\n6. The keyboard\'s steps, Home and End\n');
    await page.evaluate(() => {
      const w = [...document.querySelectorAll('#main-content .table-wrap.tall, #main-content .table-wrap.medium')]
        .find(x => x.nextElementSibling && x.nextElementSibling.classList.contains('mn-grip') && !x.nextElementSibling.hidden);
      w.nextElementSibling.focus();
    });
    await page.keyboard.press('Home');
    const k0 = await readTable(page);
    check('Home puts it back', near(k0.h, t0.h, 1) && !k0.inline, J(k0.h));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const k1 = await readTable(page);
    check('↓ twice: 80 px taller, and the value says so', near(k1.h, t0.h + 80, 2) && near(k1.grip.now, k1.h, 1), J({ h: k1.h, now: k1.grip.now }));
    await page.keyboard.press('ArrowUp');
    const k2 = await readTable(page);
    check('↑: 40 px shorter', near(k2.h, k1.h - 40, 2), J(k2.h));
    await page.keyboard.press('End');
    const k3 = await readTable(page);
    check('End fills the window', near(k3.h, Math.min(Math.round(900 * 0.85), k3.scroll + 2), 3), J(k3.h));
    await page.keyboard.press('Home');

    // ── 7. Gone with its table ───────────────────────────────────────────────
    log('\n7. A handle goes when its table does\n');
    const orphan = await page.evaluate(() => new Promise(resolve => {
      const host = document.createElement('div');
      host.innerHTML = '<div class="table-wrap tall" style="max-height:100px"><div style="height:500px"></div></div><p>after</p>';
      document.getElementById('main-content').appendChild(host);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const made = !!host.querySelector('.mn-grip');
        host.querySelector('.table-wrap').remove();
        setTimeout(() => { resolve({ made, left: host.querySelectorAll('.mn-grip').length }); host.remove(); }, 50);
      }));
    }));
    check('the table taken away alone takes its handle with it', orphan.made && orphan.left === 0, J(orphan));

    check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
