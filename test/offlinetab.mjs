// 📲 Offline & Install (offline-tab.js, and pwa.js's half of it), in Chromium.
//
//   1. **Where it is** — under Start here, after the Site Map; ?tab=offline
//      opens it; it draws with no station list loaded (it is about the
//      device, and most wanted on one that has none yet).
//   2. **Which browser** — detect() against a table of real user-agent
//      strings: iPhone and iPad (an iPad says it is a Mac), Safari and the
//      others there, an iPhone's home-screen app, Android's four browsers,
//      another app's built-in browser (Facebook's, a WebView, an iPhone app's),
//      and the four on a computer. Then three emulated devices, each shown its
//      own steps first — and the iPhone told its icon keeps its own copy,
//      Firefox on a computer told it cannot install, an app's browser offered
//      the page's address to take elsewhere.
//   3. **The install prompt** — a beforeinstallprompt is held (default
//      prevented: no strip of the browser's own), becomes 📲 Install, and
//      pressing it asks once and says how it went; accepted and dismissed.
//      Opened as the installed app, the tab says so.
//   4. **No signal** — the signal row says so, and Get ready and Check are off
//      with a reason; back online, on again. Check for a newer version says
//      this is the newest, by its stamp.
//   5. **With a real worker** — one first visit keeps the station list and
//      every sheet pick-list without a reload; the tab says Ready and counts
//      them; Start again with "do not keep one" removes the worker and every
//      copy and keeps it off across a reload; Get this device ready turns it
//      back on and goes through its four steps to Ready.
//
// Run:  npm run offlinetab
//       npm run offlinetab -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { formFixture } from './lib/migration.mjs';
import { answer } from './lib/ask.mjs';

// The worker's own requests reach the context's routes only with this set
// (Chromium; Playwright calls it experimental) — see offline.mjs.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };
const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  iphoneApp:    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iphoneInsta:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0',
  ipad:         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsung:      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  androidEdge:  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0',
  webview:      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36',
  facebook:     'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 [FBAN/EMA;FBLC/en_GB;FBAV/400.0.0.0]',
  winChrome:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  winEdge:      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  macSafari:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  winFirefox:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  linuxChrome:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

// [ua, touchMac, standalone] → key, name
const DETECT = [
  [UA.iphoneSafari, false, false, 'ios-safari', 'Safari on an iPhone'],
  [UA.iphoneChrome, false, false, 'ios-other', 'Chrome on an iPhone'],
  [UA.iphoneApp, false, true, 'ios-safari', null],                 // the home-screen app
  [UA.iphoneApp, false, false, 'inapp', null],                     // an app's own view
  [UA.iphoneInsta, false, false, 'inapp', null],
  [UA.ipad, true, false, 'ios-safari', 'Safari on an iPad'],       // an iPad says it is a Mac
  [UA.androidChrome, false, false, 'android-chrome', 'Chrome on Android'],
  [UA.samsung, false, false, 'android-samsung', 'Samsung Internet on Android'],
  [UA.androidFirefox, false, false, 'android-firefox', 'Firefox on Android'],
  [UA.androidEdge, false, false, 'android-edge', 'Edge on Android'],
  [UA.webview, false, false, 'inapp', null],
  [UA.facebook, false, false, 'inapp', null],
  [UA.winChrome, false, false, 'desktop-chrome', 'Chrome on a computer'],
  [UA.winEdge, false, false, 'desktop-edge', 'Edge on a computer'],
  [UA.macSafari, false, false, 'desktop-safari', 'Safari on a computer'],
  [UA.winFirefox, false, false, 'desktop-firefox', 'Firefox on a computer'],
  [UA.linuxChrome, false, false, 'desktop-chrome', 'Chrome on a computer'],
];

function installDatastore(context, tables) {
  return context.route('**://*.supabase.co/rest/v1/**', route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '').split('?')[0];
    const rows = tables[name];
    if (route.request().method() !== 'GET' || !rows) return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}

const tabState = page => page.evaluate(() => {
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const facts = {};
  document.querySelectorAll('#ot-page .ot-fact').forEach(f => { facts[txt(f.querySelector('dt'))] = txt(f.querySelector('dd')); });
  return {
    verdict: txt(document.querySelector('#ot-status .ot-verdict')),
    facts,
    install: txt(document.getElementById('ot-install-body')),
    installBtn: !!document.getElementById('ot-install'),
    copyBtn: [...document.querySelectorAll('#ot-install-body button')].some(b => /Copy this page/.test(b.textContent)),
    ready: (document.getElementById('ot-ready') || {}).disabled,
    checkBtn: (document.getElementById('ot-check') || {}).disabled,
    steps: [...document.querySelectorAll('#ot-steps .ot-step')].map(txt),
    notes: [...document.querySelectorAll('#ot-page p.ot-aside')].map(txt),
    said: txt(document.getElementById('app-status')),
  };
});

const settled = page => page.waitForFunction(() => typeof OfflineTab !== 'undefined' && OfflineTab.last() !== null,
  null, { timeout: 20_000 });

async function openTab(browser, server, opts = {}, init = null) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  await applyNetworkPolicy(context, server.origin);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(server.url('/?tab=offline'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForSelector('#ot-page', { timeout: LOAD_TIMEOUT });
  await settled(page);
  return { context, page };
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Where it is\n');
    {
      const { context, page } = await openTab(browser, server);
      page.on('pageerror', e => errors.push(String(e)));
      const nav = await page.evaluate(() => ({
        group: TABS.find(g => g.tabs.some(t => t.id === 'offline')).group,
        order: TABS[0].tabs.map(t => t.id),
        active: state.activeTab,
        heading: (document.querySelector('#ot-page h2') || {}).textContent,
        button: !!document.querySelector('#tab-nav .tab-btn[data-tab="offline"]'),
      }));
      check('📲 Offline & Install is under Start here, after the Site Map, and has its button in the nav',
        nav.group === 'Start here' && J(nav.order) === J(['sitemap', 'offline']) && nav.button, J(nav));
      check('?tab=offline opens it', nav.active === 'offline' && /Offline & install/.test(nav.heading || ''), J(nav));
      const bare = await page.evaluate(() => {
        const had = state.data;
        state.data = null;
        renderMain();
        const drawn = !!document.getElementById('ot-page') && !document.getElementById('load-card');
        state.data = had;
        renderMain();
        return drawn;
      });
      check('…and draws with no station list loaded — it is about the device, not the stations', bare);
      const s = await tabState(page);
      check('under automation, with no worker asked for, it says so rather than "not ready"',
        /automated test/.test(s.verdict) && s.ready === false, J({ verdict: s.verdict, ready: s.ready }));
      check('the facts: signal, browser, how it was opened, the app, the list, the sheets, the space',
        ['Signal', 'Browser', 'Opened as', 'App', 'Station list', 'Inspection and maintenance sheets', 'Space used']
          .every(k => k in s.facts) && /Online/.test(s.facts.Signal) && /Chrome on a computer|Chrome on Linux|on a computer/.test(s.facts.Browser),
        J(s.facts));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Which browser\n');
    {
      const { context, page } = await openTab(browser, server);
      const got = await page.evaluate(rows => rows.map(([ua, touchMac, standalone]) => OfflineTab.detect(ua, touchMac, standalone)), DETECT);
      const wrong = [];
      DETECT.forEach(([, , , key, name], i) => {
        if (got[i].key !== key || (name && got[i].name !== name)) wrong.push({ i, want: { key, name }, got: got[i] });
      });
      check(`detect() names all ${DETECT.length} browsers right — an iPad as an iPad, the home-screen app as Safari, three app browsers as apps`,
        !wrong.length, J(wrong.slice(0, 3)));
      check('…and reads the iOS version Chrome on an iPhone needs (16.4) from the string',
        got[1].iosVersion === 17.04 && got[1].iosLabel === '17.4' && got[1].ios === true, J(got[1]));
      await context.close();

      const old = await openTab(browser, server, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: UA.iphoneChrome.replace(/17_4/g, '15_7') });
      const o = await tabState(old.page);
      check('Chrome on an iPhone older than iOS 16.4 is sent to Safari, with the address to take there',
        /runs iOS 15\.7, and Chrome can add to the home screen only from iOS 16\.4\. Open this page in Safari/.test(o.install) && o.copyBtn,
        o.install.slice(0, 160));
      await old.context.close();

      const iphone = await openTab(browser, server, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA.iphoneSafari });
      let s = await tabState(iphone.page);
      check('an iPhone in Safari is shown Safari\'s steps first — Share, then Add to Home Screen',
        /^In Safari on an iPhone:\s*Tap Share/.test(s.install) && /Add to Home Screen/.test(s.install), s.install.slice(0, 160));
      check('…and told the icon keeps a copy and a sign-in of its own, to set up from the icon',
        /home-screen icon keeps a copy of its own/.test(s.install) && /own sign-in/.test(s.install), s.install.slice(0, 400));
      const noScroll = await iphone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      check('…at 390 px, with nothing pushing the page sideways', noScroll);
      await iphone.context.close();

      const android = await openTab(browser, server, { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: UA.androidChrome });
      s = await tabState(android.page);
      check('Chrome on Android is shown ⋮ → Install app, and no iPhone note',
        /^In Chrome on Android:\s*Tap ⋮/.test(s.install) && /Install app/.test(s.install) && !/home-screen icon keeps a copy/.test(s.install), s.install.slice(0, 200));
      await android.context.close();

      const firefox = await openTab(browser, server, { userAgent: UA.winFirefox });
      s = await tabState(firefox.page);
      check('Firefox on a computer is told plainly that it cannot install — and that the copy works in a tab',
        /cannot install a site as an app/.test(s.install) && /works in a Firefox tab/.test(s.install), s.install.slice(0, 200));
      await firefox.context.close();

      const inapp = await openTab(browser, server, { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: UA.facebook });
      s = await tabState(inapp.page);
      check('another app\'s built-in browser is told to go elsewhere, and given the address to take',
        /open it in Safari on an iPhone or iPad, or Chrome on Android/.test(s.install) && s.copyBtn
          && /cannot install/.test(s.facts.Browser || ''), J({ install: s.install.slice(0, 160), browser: s.facts.Browser }));
      await inapp.context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The install prompt\n');
    {
      const { context, page } = await openTab(browser, server);
      const held = await page.evaluate(async () => {
        window.__asked = 0;
        const e = new Event('beforeinstallprompt', { cancelable: true });
        e.prompt = async () => { window.__asked++; };
        e.userChoice = Promise.resolve({ outcome: 'accepted' });
        window.dispatchEvent(e);
        await OfflineTab.refresh();
        return { prevented: e.defaultPrevented, button: !!document.getElementById('ot-install') };
      });
      check('the browser\'s install prompt is held — no strip of its own — and becomes 📲 Install', held.prevented && held.button, J(held));
      await page.click('#ot-install');
      await page.waitForFunction(() => /Installed\./.test((document.getElementById('app-status') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
      let s = await tabState(page);
      check('pressing it asks once, and says it is installed — and the button goes, the prompt spent',
        await page.evaluate(() => window.__asked) === 1 && /Installed\./.test(s.said) && !s.installBtn, J({ said: s.said, btn: s.installBtn }));
      const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
      check('…and focus goes to its section\'s heading, not to nowhere, when the button it was on goes', focus === 'ot-install-h', String(focus));
      await page.evaluate(async () => {
        const e = new Event('beforeinstallprompt', { cancelable: true });
        e.prompt = async () => {};
        e.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(e);
        await OfflineTab.refresh();
      });
      await page.click('#ot-install');
      await page.waitForFunction(() => /Not installed/.test((document.getElementById('app-status') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
      s = await tabState(page);
      check('…turned down, it says so, and that it can be done from here later', /Not installed\. You can install it from here/.test(s.said), s.said);
      await context.close();

      const app = await openTab(browser, server, {}, () => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = q => (/display-mode:\s*standalone/.test(q)
          ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
          : real(q));
      });
      s = await tabState(app.page);
      check('opened as the installed app, the tab says so — and offers no steps first',
        /The installed app/.test(s.facts['Opened as'] || '') && /^✓ You are using Flood-Net as an installed app\./.test(s.install), J({ opened: s.facts['Opened as'], install: s.install.slice(0, 80) }));
      await app.context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. No signal, and updates\n');
    {
      const { context, page } = await openTab(browser, server);
      await page.click('#ot-check');
      await page.waitForFunction(() => /newest version/.test((document.getElementById('app-status') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
      let s = await tabState(page);
      const stamp = await page.evaluate(() => APP_VERSION);
      check('Check for a newer version says this is the newest, by its stamp — said, and beside the button',
        s.said.includes(`This is the newest version (${stamp}).`) && s.notes.some(n => n.includes(stamp)), J({ said: s.said, notes: s.notes }));
      await context.setOffline(true);
      await page.waitForFunction(() => /No signal/.test((document.querySelector('#ot-page .ot-fact dd') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
      s = await tabState(page);
      check('with no signal, the signal row says so, and Get ready and Check are off with the reason beside them',
        /No signal/.test(s.facts.Signal) && s.ready === true && s.checkBtn === true && s.notes.some(n => /needs a signal/.test(n)),
        J({ signal: s.facts.Signal, ready: s.ready, check: s.checkBtn, notes: s.notes }));
      await context.setOffline(false);
      await page.waitForFunction(() => /Online/.test((document.querySelector('#ot-page .ot-fact dd') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
      s = await tabState(page);
      check('…and back on when the signal is', /Online/.test(s.facts.Signal) && s.ready === false && s.checkBtn === false, J({ signal: s.facts.Signal, ready: s.ready }));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. With a real worker\n');
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
      await applyNetworkPolicy(context, server.origin);
      await installDatastore(context, formFixture());
      await context.addInitScript(() => { try { if (localStorage.getItem('mn-sw') !== 'off') localStorage.setItem('mn-sw', 'on'); } catch (_) {} });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(server.url('/?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
      // One visit, no reload: the worker takes the page over and the list and
      // the sheets' lists are asked for again, through it.
      let st = null;
      for (const end = Date.now() + 30_000; Date.now() < end; await page.waitForTimeout(300)) {
        st = await page.evaluate(() => Pwa.status());
        if (st.list && st.sheets.of && st.sheets.kept === st.sheets.of) break;
      }
      check('one first visit keeps the station list and every sheet pick-list — no reload needed',
        !!(st && st.list && st.list.kind === 'bundled' && st.sheets.of >= 15 && st.sheets.kept === st.sheets.of),
        J(st && { list: st.list, sheets: st.sheets }));
      await page.evaluate(() => switchTab('offline'));
      await settled(page);
      await page.evaluate(() => OfflineTab.refresh());
      let s = await tabState(page);
      check('the tab says Ready, and counts what is kept: this version\'s files, the list and its age, every pick-list',
        /^✓ Ready\. This device will open Flood-Net with no signal\./.test(s.verdict)
          && /Saved — this version \(\w+\), \d{2,} files/.test(s.facts.App) && /Saved — .*from this site's copy of stations\.json/.test(s.facts['Station list'])
          && /all \d+ of their pick-lists saved/.test(s.facts['Inspection and maintenance sheets']),
        J({ verdict: s.verdict, facts: s.facts }));

      // Start again, and keep it off.
      await page.click('#ot-remove');
      await page.waitForSelector('#app-ask-check', { timeout: 5000 });
      await page.check('#app-ask-check');
      const q = await answer(page, true);
      check('Start again asks first, in its own words, with the way out first and the "keep it off" choice in the question',
        /Remove the saved copy\?/.test(q.title) && q.danger && /Remove the saved copy/.test(q.yes) && /drafts are kept/i.test(q.text), J(q));
      // Said last, once the page shows it: wait for the words, not the first repaint.
      await page.waitForFunction(() => /Removed, and turned off/.test((document.getElementById('app-status') || {}).textContent || ''), null, { timeout: 15_000 }).catch(() => {});
      const gone = await page.evaluate(async () => ({
        caches: (await caches.keys()).filter(n => n.startsWith('floodnet-')),
        regs: (await navigator.serviceWorker.getRegistrations()).length,
        flag: localStorage.getItem('mn-sw'),
      }));
      s = await tabState(page);
      check('…which removes the worker and every copy it kept, and says it is off on this device',
        !gone.caches.length && gone.regs === 0 && gone.flag === 'off' && /Turned off on this device/.test(s.verdict)
          && /Removed, and turned off/.test(s.said), J({ gone, verdict: s.verdict, said: s.said }));
      await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await settled(page);
      await page.waitForTimeout(1500);
      const after = await page.evaluate(async () => ({
        controlled: !!navigator.serviceWorker.controller,
        regs: (await navigator.serviceWorker.getRegistrations()).length,
      }));
      check('…and kept off across a reload: no worker comes back by itself', !after.controlled && after.regs === 0, J(after));

      // Get this device ready: on again, in four steps.
      await page.click('#ot-ready');
      await page.waitForFunction(() => /^Ready\./.test((document.getElementById('app-status') || {}).textContent || '')
        || /Not everything could be saved/.test((document.getElementById('app-status') || {}).textContent || ''), null, { timeout: 120_000 }).catch(() => {});
      s = await tabState(page);
      const on = await page.evaluate(() => localStorage.getItem('mn-sw'));
      check('Get this device ready turns it back on and goes through its steps — files, list, pick-lists — to Ready',
        on === 'on' && /^Ready\./.test(s.said)
          && /Save the app's files — Done: \d{2,} files/.test(s.steps[0] || '')
          && /Save the station list — Done: from this site's copy/.test(s.steps[1] || '')
          && /pick-lists — Done: (\d+) of \1/.test(s.steps[2] || '')
          && /Ask the browser to keep them through a clean-up — (Done|Note)/.test(s.steps[3] || '')
          && /^✓ Ready/.test(s.verdict),
        J({ on, said: s.said, steps: s.steps, verdict: s.verdict }));
      await context.close();
    }

    check('nothing threw', !errors.length, J(errors.slice(0, 3)));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — the Offline & Install tab says what this device has kept, gets it ready in one go,\n'
    + '       and shows each browser its own way to install — or says plainly that it cannot.');
}

main().catch(err => { console.error(err); process.exit(1); });
