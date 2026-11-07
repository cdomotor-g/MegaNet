// The busy wheel at the far right of the banner (busy.js). In Chromium, over
// the real app in the default (Calm) look and in Classic:
//
//   1. **Quiet when nothing is happening.** Loaded and settled, the wheel is
//      put away — not drawn, not focusable — and its slot is the same width
//      busy or not, so no button in the row moves when it comes and goes.
//   2. **Every fetch().** A slow read spins it blue (loading), named for what
//      it reads; a slow write green (saving); a database function by its name
//      — save_station saving, task_list loading; a quick answer never brings it
//      up; `{ busy: false }` keeps a request out of it; reading the body keeps
//      the job going until the body is read.
//   3. **Two at once.** The outer ring the first kind (saving), the inner the
//      next (loading), a count of 2; and a run of quick requests one after
//      another is busy, though none of them lasts long enough alone.
//   4. **The end.** At least MIN_MS up, then a ✓, then put away.
//   5. **The page's own lines.** A status line on screen that ends in "…" spins
//      it (amber, working it out), and stops it when it changes; one that is
//      hidden, or says "Waiting for…", does not; aria-busy="true" does (blue).
//   6. **Busy.run** with a promise, until it settles.
//   7. **Pressing it** opens the card: what is happening, live, and the key;
//      Escape closes it and gives focus back.
//   8. **Reduced motion**: the rings stand still and the light fades instead.
//   9. **A phone, and Classic**: in the row on an iPhone 12 mini's screen
//      (375 px, a touch screen) with no sideways scroll, and round there —
//      the touch-target floor makes every button 2 rem tall, and a wheel drawn
//      to the button went oval; it is drawn in a square of its own now — and
//      the Classic banner's own colours.
//
// Run:  npm run busy
//       npm run busy -- -v    also print what passed

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

// Requests this check makes itself, answered after `ms`: /busy-test/<ms>/<name>.
async function routeSlow(page) {
  await page.route('**/busy-test/**', async route => {
    const m = new URL(route.request().url()).pathname.match(/\/busy-test\/(\d+)\//);
    await new Promise(r => setTimeout(r, m ? Number(m[1]) : 0));
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }).catch(() => {});
  });
  // A database function, on whichever address the app is pointed at.
  await page.route('**/rest/v1/rpc/busytest_*', async route => {
    await new Promise(r => setTimeout(r, 700));
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }).catch(() => {});
  });
  await page.route('**/rest/v1/rpc/save_busytest', async route => {
    await new Promise(r => setTimeout(r, 700));
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }).catch(() => {});
  });
}

async function open(browser, server, opts, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await routeSlow(page);
  page.on('pageerror', e => errors.push(e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  // Settled: nothing the first load asked for is still going.
  await page.waitForFunction(() => !Busy.jobs().length && document.getElementById('busy').dataset.state !== 'spin'
    && document.getElementById('busy').dataset.state !== 'tick', null, { timeout: LOAD_TIMEOUT });
  // Every state the wheel passes through, from here on, with when.
  await page.evaluate(() => {
    const b = document.getElementById('busy');
    window.__busyLog = [];
    const t0 = performance.now();
    new MutationObserver(() => {
      const last = window.__busyLog[window.__busyLog.length - 1];
      const s = b.dataset.state || '';
      if (!last || last.s !== s) window.__busyLog.push({ s, t: Math.round(performance.now() - t0), kind: b.dataset.kind, kind2: b.dataset.kind2 });
    }).observe(b, { attributes: true, attributeFilter: ['data-state', 'data-kind', 'data-kind2'] });
    window.__busyMark = () => { window.__busyLog = []; };
  });
  return { context, page };
}

const wheel = page => page.evaluate(() => {
  const b = document.getElementById('busy');
  const cs = getComputedStyle(b);
  return {
    state: b.dataset.state || '', kind: b.dataset.kind || '', kind2: b.dataset.kind2 || '',
    n: b.querySelector('.busy-n').textContent, title: b.getAttribute('title') || '',
    label: b.getAttribute('aria-label') || '', visibility: cs.visibility,
    jobs: Busy.jobs(),
  };
});
const settle = page => page.waitForFunction(() => {
  const s = document.getElementById('busy').dataset.state;
  return !Busy.jobs().length && s !== 'spin' && s !== 'tick';
}, null, { timeout: 10_000 });
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 10_000 }).then(() => true, () => false);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ── 1. Quiet when nothing is happening ─────────────────────────────────
    log('\n1. Quiet when nothing is happening\n');
    const { context, page } = await open(browser, server, { look: 'calm' }, errors);
    let w = await wheel(page);
    check('loaded and settled, the wheel is put away', w.state !== 'spin' && w.visibility === 'hidden', J(w));
    check('…and it is last in the banner\'s row, at its right-hand end', await page.evaluate(() => {
      const slot = document.getElementById('busy-slot');
      const row = slot.parentElement;
      const shown = [...row.children].filter(e => e.getClientRects().length);
      return row.classList.contains('header-actions') && shown[shown.length - 1] === slot;
    }));
    const before = await page.evaluate(() => ({
      slot: document.getElementById('busy-slot').getBoundingClientRect().width,
      more: Math.round(document.getElementById('btn-more').getBoundingClientRect().left),
    }));

    // ── 2. Every fetch() ───────────────────────────────────────────────────
    log('\n2. Every fetch()\n');
    await page.evaluate(() => { window.__busyMark(); fetch('/busy-test/900/stations-a.json').then(r => r.json()); });
    check('a slow read spins it', await until(page, () => document.getElementById('busy').dataset.state === 'spin'));
    w = await wheel(page);
    check('…blue: loading', w.kind === 'load' && w.visibility === 'visible', J(w));
    check('…named for what it reads, in its tooltip and its name', /Loading from this site — stations-a\.json/.test(w.title)
      && /Loading from this site/.test(w.label) && /Blue: loading/.test(w.title), J(w));
    const during = await page.evaluate(() => ({
      slot: document.getElementById('busy-slot').getBoundingClientRect().width,
      more: Math.round(document.getElementById('btn-more').getBoundingClientRect().left),
    }));
    check('the slot is the same width spinning as put away, so ⋯ has not moved', J(before) === J(during), J({ before, during }));
    await settle(page);

    await page.evaluate(() => { fetch('/busy-test/800/a', { method: 'POST', body: '{}' }); });
    check('a slow write spins it green: saving', await until(page, () => {
      const b = document.getElementById('busy'); return b.dataset.state === 'spin' && b.dataset.kind === 'save';
    }), J(await wheel(page)));
    await settle(page);

    const dbUrl = await page.evaluate(() => DB_URL);
    await page.evaluate(u => { fetch(`${u}/rpc/busytest_list`, { method: 'POST', body: '{}' }).catch(() => {}); }, dbUrl);
    check('a database function whose name changes nothing is loading, though it is a POST', await until(page, () => {
      const b = document.getElementById('busy'); return b.dataset.state === 'spin' && b.dataset.kind === 'load';
    }), J(await wheel(page)));
    w = await wheel(page);
    check('…and is named as the database', /Loading from the database — busytest list/.test(w.title), J(w.title));
    await settle(page);
    await page.evaluate(u => { fetch(`${u}/rpc/save_busytest`, { method: 'POST', body: '{}' }).catch(() => {}); }, dbUrl);
    check('save_… is saving', await until(page, () => {
      const b = document.getElementById('busy'); return b.dataset.state === 'spin' && b.dataset.kind === 'save';
    }), J(await wheel(page)));
    await settle(page);

    await page.evaluate(() => { window.__busyMark(); return fetch('/busy-test/5/quick').then(r => r.json()); });
    await page.waitForTimeout(400);
    let L = await page.evaluate(() => window.__busyLog);
    check('a quick answer never brings it up', !L.some(e => e.s === 'spin'), J(L));

    await page.evaluate(() => { window.__busyMark(); fetch('/busy-test/700/quiet', { busy: false }); });
    await page.waitForTimeout(500);
    L = await page.evaluate(() => window.__busyLog);
    w = await wheel(page);
    check('{ busy: false } keeps a request out of it', !L.some(e => e.s === 'spin') && !w.jobs.length, J({ L, w }));
    await page.waitForTimeout(400);

    const body = await page.evaluate(async () => {
      const res = await fetch('/busy-test/5/body');
      const during = Busy.jobs().map(j => j.label);
      await res.json();
      await new Promise(r => setTimeout(r, 20));
      return { during, after: Busy.jobs().map(j => j.label) };
    });
    check('reading the body keeps the job going until it is read', body.during.some(l => /body/.test(l))
      && !body.after.some(l => /body/.test(l)), J(body));
    await settle(page);

    // ── 3. Two at once ─────────────────────────────────────────────────────
    log('\n3. Two at once\n');
    await page.evaluate(() => { fetch('/busy-test/900/two-a'); fetch('/busy-test/900/two-b', { method: 'PATCH', body: '{}' }); });
    check('a read and a write together spin it', await until(page, () => document.getElementById('busy').dataset.state === 'spin'));
    w = await wheel(page);
    check('…the outer ring saving, the inner loading, and a 2 on it', w.kind === 'save' && w.kind2 === 'load' && w.n === '2', J(w));
    await settle(page);
    await page.evaluate(() => {
      window.__busyMark();
      let i = 0;
      const next = () => { if (i++ < 12) fetch('/busy-test/30/run').then(r => r.json()).then(() => setTimeout(next, 10)); };
      next();
    });
    check('a run of quick requests, one after another, is busy', await until(page, () => window.__busyLog.some(e => e.s === 'spin')),
      J(await page.evaluate(() => window.__busyLog)));
    await settle(page);

    // ── 4. The end ─────────────────────────────────────────────────────────
    log('\n4. The end\n');
    await page.evaluate(() => { window.__busyMark(); fetch('/busy-test/160/short'); });
    await page.waitForTimeout(1600);
    L = await page.evaluate(() => window.__busyLog);
    const up = L.find(e => e.s === 'spin'), tick = L.find(e => e.s === 'tick'), out = L.find(e => e.s === 'out');
    check('a job of 160 ms is up for at least 450 ms', up && tick && tick.t - up.t >= 440, J(L));
    check('…then a ✓, then put away', up && tick && out && out.t > tick.t && out.t - tick.t >= 380, J(L));

    // ── 5. The page's own lines ────────────────────────────────────────────
    log('\n5. The page\'s own lines\n');
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'busy-fx'; p.setAttribute('role', 'status');
      p.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:3000;background:#fff;margin:0';
      p.textContent = 'Working out the drive…';
      document.body.appendChild(p);
    });
    check('a status line ending in "…" spins it', await until(page, () => document.getElementById('busy').dataset.state === 'spin'));
    w = await wheel(page);
    check('…amber, working it out, under the line\'s own words', w.kind === 'work' && /Working out the drive…/.test(w.title), J(w));
    await page.evaluate(() => { document.getElementById('busy-fx').textContent = 'The drive is 42 km.'; });
    check('…and it stops when the line says it is done', await until(page, () => document.getElementById('busy').dataset.state === 'tick'
      || document.getElementById('busy').dataset.state === 'out'));
    await settle(page);
    await page.evaluate(() => { window.__busyMark(); const p = document.getElementById('busy-fx'); p.textContent = 'Reading the land cover…'; p.style.display = 'none'; });
    await page.waitForTimeout(700);
    L = await page.evaluate(() => window.__busyLog);
    check('a line that is not on screen does not', !L.some(e => e.s === 'spin'), J(L));
    await page.evaluate(() => { window.__busyMark(); const p = document.getElementById('busy-fx'); p.style.display = ''; p.textContent = 'Waiting for a GPS fix…'; });
    await page.waitForTimeout(700);
    L = await page.evaluate(() => window.__busyLog);
    check('"Waiting for…" is a state, not work, and does not', !L.some(e => e.s === 'spin'), J(L));
    await page.evaluate(() => { const p = document.getElementById('busy-fx'); p.removeAttribute('role'); p.textContent = 'The list'; p.setAttribute('aria-busy', 'true'); });
    check('aria-busy="true" on screen spins it, blue', await until(page, () => {
      const b = document.getElementById('busy'); return b.dataset.state === 'spin' && b.dataset.kind === 'load';
    }), J(await wheel(page)));
    await page.evaluate(() => document.getElementById('busy-fx').remove());
    await settle(page);

    // ── 6. Busy.run ────────────────────────────────────────────────────────
    log('\n6. Busy.run\n');
    const ran = await page.evaluate(async () => {
      let done;
      const p = Busy.run('work', 'Adding up the paths', new Promise(r => { done = r; }));
      await new Promise(r => setTimeout(r, 300));
      const mid = { state: document.getElementById('busy').dataset.state, kind: document.getElementById('busy').dataset.kind, jobs: Busy.jobs() };
      done(7);
      const v = await p;
      await new Promise(r => setTimeout(r, 20));
      return { mid, v, after: Busy.jobs() };
    });
    check('Busy.run spins it until the promise settles, and hands the value back', ran.mid.state === 'spin' && ran.mid.kind === 'work'
      && ran.mid.jobs.some(j => j.label === 'Adding up the paths') && ran.v === 7 && !ran.after.length, J(ran));
    await settle(page);

    // ── 7. Pressing it ─────────────────────────────────────────────────────
    log('\n7. Pressing it\n');
    await page.evaluate(() => { fetch('/busy-test/3000/press.json'); });
    await until(page, () => document.getElementById('busy').dataset.state === 'spin');
    await page.click('#busy');
    const pop = await page.evaluate(() => {
      const p = document.getElementById('busy-pop');
      return p && {
        text: p.textContent.replace(/\s+/g, ' '), focus: document.activeElement && document.activeElement.className,
        expanded: document.getElementById('busy').getAttribute('aria-expanded'),
        right: Math.round(window.innerWidth - p.getBoundingClientRect().right),
        top: Math.round(p.getBoundingClientRect().top), header: Math.round(document.querySelector('header').getBoundingClientRect().bottom),
      };
    });
    check('pressing it opens the card, under the banner at the right', pop && pop.top >= pop.header && pop.right >= 0 && pop.right < 40, J(pop));
    check('…saying what is happening', pop && /What’s happening/.test(pop.text) && /press\.json/.test(pop.text), pop && pop.text.slice(0, 200));
    check('…and what the colours mean', pop && /Blue — Loading\./.test(pop.text) && /Green — Saving\./.test(pop.text)
      && /Amber — Working it out\./.test(pop.text) && /✓ ?Done\. It closes into a tick/.test(pop.text), pop && pop.text);
    check('…with focus on its ×, and the wheel saying it is open', pop && /busy-pop-x/.test(pop.focus) && pop.expanded === 'true', J(pop));
    check('…and it follows the work: done says so', await until(page, () => /all done/.test(document.getElementById('busy-pop').textContent)));
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() => ({ pop: !!document.getElementById('busy-pop'), expanded: document.getElementById('busy').getAttribute('aria-expanded') }));
    check('Escape closes it', !closed.pop && closed.expanded === 'false', J(closed));
    await settle(page);

    // ── 8. Reduced motion ──────────────────────────────────────────────────
    log('\n8. Reduced motion\n');
    const motion = await page.evaluate(async () => {
      const end = Busy.begin('load', 'A held job');
      await new Promise(r => setTimeout(r, 250));
      const read = () => ({
        out: getComputedStyle(document.querySelector('#busy .busy-out')).animationName,
        inner: getComputedStyle(document.querySelector('#busy .busy-in')).animationName,
      });
      const on = read();
      window.__end = end;
      return on;
    });
    check('it turns: the outer ring and the inner, both', motion.out === 'busy-turn' && motion.inner === 'busy-turn', J(motion));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page.evaluate(() => ({
      out: getComputedStyle(document.querySelector('#busy .busy-out')).animationName,
      inner: getComputedStyle(document.querySelector('#busy .busy-in')).animationName,
      drop: getComputedStyle(document.querySelector('#busy .busy-drop')).animationName,
    }));
    check('reduced motion: nothing turns, and the light fades instead', still.out === 'busy-glow' && still.inner === 'none' && still.drop === 'none', J(still));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.__end());
    await settle(page);
    await context.close();

    // ── 9. A phone, and Classic ────────────────────────────────────────────
    log('\n9. A phone, and Classic\n');
    // An iPhone 12 mini's screen, as Playwright describes it.
    const phone = await open(browser, server, { look: 'calm', viewport: { width: 375, height: 629 }, screen: { width: 375, height: 812 },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true }, errors);
    await phone.page.evaluate(() => { fetch('/busy-test/1500/phone'); });
    await until(phone.page, () => document.getElementById('busy').dataset.state === 'spin');
    // Measured on the slot: the wheel itself may still be popping up.
    const P = await phone.page.evaluate(() => {
      const b = document.getElementById('busy-slot').getBoundingClientRect();
      const h = document.querySelector('header').getBoundingClientRect();
      const side = document.getElementById('btn-side');
      const s = side && !side.hidden ? side.getBoundingClientRect() : null;
      return { tab: state.activeTab, right: Math.round(b.right), w: innerWidth, top: Math.round(b.top), bottom: Math.round(b.bottom),
        hTop: Math.round(h.top), hBottom: Math.round(h.bottom), side: s && { left: Math.round(s.left), right: Math.round(s.right) },
        scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
    });
    // ⋮ keeps the far corner where it shows (a phone's Stations tab); the
    // wheel is the next thing in from it.
    const end = P.side ? P.side.left : P.w;
    check('on a phone it is in the banner, at its right-hand end (next to ⋮, which keeps the corner)',
      P.right <= end + 1 && P.right > end - 30 && (!P.side || P.side.right > P.w - 20) && P.top >= P.hTop && P.bottom <= P.hBottom, J(P));
    check('…with no sideways scroll', P.scroll <= P.client, J(P));
    // Once it has popped up: the wheel and every ring in it round, however
    // tall the button is made for a finger.
    await phone.page.waitForTimeout(300);
    const R = await phone.page.evaluate(() => {
      const q = sel => { const e = document.querySelector(sel); const r = e ? e.getBoundingClientRect() : { width: 0, height: 0 };
        return { w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
      return { coarse: matchMedia('(pointer: coarse)').matches, button: q('#busy'), face: q('#busy .busy-face'),
        out: q('#busy .busy-out'), tick: q('#busy .busy-tick') };
    });
    const round = b => b.w > 20 && Math.abs(b.w - b.h) < 0.5;
    check('on a touch screen the button is tall enough to press, and the wheel in it is round — not stretched to the button',
      R.coarse && R.button.h >= 32 && round(R.face) && round(R.out) && round(R.tick), J(R));
    await phone.context.close();

    const classic = await open(browser, server, { look: 'classic' }, errors);
    await classic.page.evaluate(() => { fetch('/busy-test/1500/classic'); });
    await until(classic.page, () => document.getElementById('busy').dataset.state === 'spin');
    const C = await classic.page.evaluate(() => ({
      load: getComputedStyle(document.getElementById('busy')).getPropertyValue('--busy-load').trim(),
      shown: getComputedStyle(document.getElementById('busy')).visibility,
    }));
    check('Classic: it spins there too, in the blue banner\'s lighter colours', C.shown === 'visible' && /^#a9d8ff$/i.test(C.load), J(C));
    await classic.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — the busy wheel comes up for what takes a moment, says what it is, and goes with a ✓ (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
