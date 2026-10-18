// An administrator's notifications on the Admin tab (push.js, 0066), driven in
// Chromium against a stand-in for the database's push functions — answering
// as they answer, and recording what they are sent.
//
//   1. **Who sees the panel** — an administrator, and nobody else: a member's
//      Admin tab has none, and the database is not asked.
//   2. **What the server says** — a database without 0066 says to apply it; a
//      server with no key yet says so, and Turn on waits; a sender whose last
//      run is long gone says its schedule may have stopped.
//   3. **Turning it on** — the browser's permission asked first, a push
//      subscription made with the server's own key, and push_subscribe sent
//      the endpoint, both keys (base64url), that key and what the device calls
//      itself; then On, this device marked in the list, a test on its way.
//   4. **The icon** — the count of what is waiting, as push_mine says it, put
//      on the app's icon of a device that is told, and on no other; cleared
//      when the device is turned off or the account signs out.
//   5. **The rest** — Send a test (push_test); another device removed, asked
//      first (push_unsubscribe by id); this one turned off (push_unsubscribe by
//      endpoint, the browser's subscription unsubscribed, the icon cleared);
//      permission refused, said with where to allow it.
//   6. **An iPhone in Safari's tab** — told the Home Screen app is where
//      notifications come, with the way to add it, and offered nothing else.
//   7. **A pressed notification, the app already open** — sw.js's message
//      takes the app to the Admin tab, or to a base station's approve form,
//      without a reload.
//
// Under test automation pwa.js registers no service worker, and Chromium
// headless has no push service, so the page's registration and its push
// manager, the permission prompt and the Badging API are stand-ins too —
// recording what they are asked. test/push.mjs checks what lies beyond them:
// the Worker's sender and sw.js.
//
// Run:  npm run notify
//       npm run notify -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

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

// A 65-byte uncompressed point and a 16-byte secret, as base64url — the
// shapes, which is all the page handles.
const KEY = 'B' + 'A'.repeat(86);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/notify-check-this-device';

const WHO = {
  'tok-admin':  { signed_in: true, email: 'boss@bom.gov.au', display_name: 'Boss', role: 'admin', may_write: true,
                  is_admin: true, is_member: true, status: 'automatic', signup: 'open', approvals_waiting: 1, schema_version: '66' },
  'tok-member': { signed_in: true, email: 'pat@council.example', display_name: 'Pat', role: 'editor', may_write: false,
                  is_admin: false, is_member: true, status: 'approved', signup: 'open', schema_version: '66' },
};

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const sent = [];
  // What push_mine answers, as the checks set it.
  let mine = null;
  let mineStatus = 200;

  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

  async function open(url, { tok = 'tok-admin', permission = 'default', answer = 'granted', userAgent = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(userAgent ? { userAgent } : {}) });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await page.route('**/auth/v1/**', route => {
      const path = new URL(route.request().url()).pathname.replace(/^.*\/auth\/v1\//, '');
      if (path === 'settings') return route.fulfill({ status: 200, contentType: 'application/json', body: J({ external: { email: true } }) });
      if (path === 'logout') return route.fulfill({ status: 204, body: '' });
      return route.fulfill({ status: 404, contentType: 'application/json', body: J({ msg: 'not stood in for' }) });
    });
    await page.route('**/rest/v1/rpc/**', async route => {
      const req = route.request();
      const name = new URL(req.url()).pathname.split('/rpc/')[1];
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      const bearer = (req.headers().authorization || '').replace(/^Bearer\s+/, '');
      sent.push({ name, body, bearer });
      const reply = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(obj) });
      if (name === 'whoami') return reply(WHO[bearer] || { signed_in: false, is_member: false, may_write: false, signup: 'open' });
      if (name === 'my_prefs') return reply({ nav_views: null, updated_at: null });
      if (name === 'admin_users' || name === 'admin_allowlist') return reply([]);
      if (name === 'push_mine') return mineStatus === 200 ? reply(mine) : reply({ message: 'Could not find the function meganet.push_mine' }, mineStatus);
      if (name === 'push_subscribe') return reply({ id: 7 });
      if (name === 'push_unsubscribe') return reply(1);
      if (name === 'push_test') return reply(2);
      return reply({ message: 'not stood in for' }, 404);
    });
    await page.addInitScript(({ tok, permission, answer }) => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('meganet.session', JSON.stringify({ access_token: tok, refresh_token: `r-${tok}`,
          expires_at: Date.now() + 3600e3, email: tok === 'tok-admin' ? 'boss@bom.gov.au' : 'pat@council.example' }));
      }
      // The stand-ins: what the page asks of the browser, recorded.
      const asked = window.__asked = { permission: 0, subscribe: [], unsubscribed: 0, badges: [] };
      let sub = null;
      const bytes = n => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 255);
      const makeSub = opts => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/notify-check-this-device',
        options: { applicationServerKey: opts.applicationServerKey.buffer.slice(0), userVisibleOnly: opts.userVisibleOnly },
        getKey: k => (k === 'p256dh' ? Uint8Array.from([4, ...bytes(64)]).buffer : bytes(16).buffer),
        unsubscribe: async () => { asked.unsubscribed++; sub = null; return true; },
      });
      const reg = { pushManager: {
        getSubscription: async () => sub,
        subscribe: async opts => { asked.subscribe.push({ key: [...new Uint8Array(opts.applicationServerKey)], visible: opts.userVisibleOnly }); sub = makeSub(opts); return sub; },
      } };
      if (navigator.serviceWorker) navigator.serviceWorker.getRegistration = async () => reg;
      let perm = permission;
      window.Notification = class { static get permission() { return perm; } };
      window.Notification.requestPermission = async () => { asked.permission++; perm = answer; return perm; };
      window.PushManager = window.PushManager || function PushManager() {};
      navigator.setAppBadge = async n => { asked.badges.push(n); };
      navigator.clearAppBadge = async () => { asked.badges.push(0); };
    }, { tok, permission, answer });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => Auth.known(), null, { timeout: 15_000 });
    return { context, page };
  }

  const panel = page => page.evaluate(() => (document.getElementById('adm-push')?.textContent || '').replace(/\s+/g, ' ').trim());
  const asked = page => page.evaluate(() => window.__asked);
  const since = n => sent.slice(n);
  const waitText = (page, re) => page.waitForFunction(
    src => new RegExp(src).test((document.getElementById('adm-push')?.textContent || '').replace(/\s+/g, ' ')),
    re.source, { timeout: 10_000 });

  const device = (over = {}) => ({ id: 7, endpoint: ENDPOINT, label: 'Linux · Chrome', created_at: '2026-10-18T03:00:00Z',
    last_sent_at: null, last_status: null, last_error: null, failures: 0, test_waiting: true, current_key: true, ...over });
  const recent = () => new Date(Date.now() - 60e3).toISOString();

  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Who sees the panel\n');
    {
      const n = sent.length;
      const { context, page } = await open(server.url('/index.html?tab=admin'), { tok: 'tok-member' });
      await page.waitForTimeout(800);
      check('a member\'s Admin tab has no Notifications panel', (await panel(page)) === '', await panel(page));
      check('…and the database is not asked about notifications for them', !since(n).some(r => r.name.startsWith('push_')));
      check('…and the icon is cleared of any count left on it', (await asked(page)).badges.at(-1) === 0, J((await asked(page)).badges));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. What the server says\n');
    {
      mineStatus = 404;
      const { context, page } = await open(server.url('/index.html?tab=admin'));
      await waitText(page, /0066/);
      check('a database without 0066: apply it', /apply db\/migrations\/0066_push_notifications\.sql/.test(await panel(page)), await panel(page));
      await context.close();
      mineStatus = 200;
    }
    {
      mine = { key: null, last_run: null, is_admin: true, waiting: { accounts: 1, tokens: 0, total: 1 }, devices: [] };
      const { context, page } = await open(server.url('/index.html?tab=admin'));
      await waitText(page, /Not set up/);
      const off = await page.evaluate(() => document.querySelector('#adm-push button.primary')?.disabled);
      check('no key yet: not set up on the server, said with where to look, and Turn on waits',
        /Not set up on the server yet/.test(await panel(page)) && /docs\/accounts\.md/.test(await panel(page)) && off === true, await panel(page));
      await context.close();
    }
    {
      mine = { key: KEY, last_run: '2026-10-17T01:00:00Z', is_admin: true, waiting: { accounts: 0, tokens: 0, total: 0 }, devices: [] };
      const { context, page } = await open(server.url('/index.html?tab=admin'));
      await waitText(page, /schedule may have stopped/);
      check('a sender that last ran yesterday: its schedule may have stopped', true);
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. Turning it on, 4. the icon, 5. the rest\n');
    {
      mine = { key: KEY, last_run: recent(), is_admin: true, waiting: { accounts: 1, tokens: 2, total: 3 },
               devices: [device({ id: 3, endpoint: 'https://web.push.apple.com/notify-check-old-phone', label: 'iPhone · Home Screen',
                                  test_waiting: false, last_status: 403, last_error: 'HTTP 403 {"reason":"BadJwtToken"}' })] };
      const { context, page } = await open(server.url('/index.html?tab=admin'));
      await waitText(page, /Off/);
      check('off on this device, with the button to turn it on', /Off on this device/.test(await panel(page))
        && !!(await page.$('#adm-push button:has-text("Turn on for this device")')), await panel(page));
      check('the account\'s other device is listed with what its push service last said',
        /iPhone · Home Screen/.test(await panel(page)) && /did not go: HTTP 403/.test(await panel(page)), await panel(page));
      check('not told, so no count on the icon: nothing would keep it true', !(await asked(page)).badges.some(n => n > 0), J((await asked(page)).badges));

      const n = sent.length;
      mine = { ...mine, devices: [device(), ...mine.devices] };
      await page.click('#adm-push button:has-text("Turn on for this device")');
      await waitText(page, /this device is told/);
      const a = await asked(page);
      const sub = since(n).find(r => r.name === 'push_subscribe');
      check('the browser\'s permission is asked, once', a.permission === 1, J(a));
      check('…a subscription made with the server\'s own key, every message to be shown',
        a.subscribe.length === 1 && a.subscribe[0].visible === true && a.subscribe[0].key.length === 65 && a.subscribe[0].key[0] === 4, J(a.subscribe));
      check('…and push_subscribe sent the endpoint, both keys as base64url, the key and the device\'s name',
        sub && sub.body.p_endpoint === ENDPOINT && /^B[\w-]{86}$/.test(sub.body.p_p256dh) && /^[\w-]{22}$/.test(sub.body.p_auth)
          && sub.body.p_key === KEY && /^Linux · /.test(sub.body.p_label) && sub.bearer === 'tok-admin', J(sub && sub.body));
      check('told now, the icon shows what is waiting: 1 account and 2 base stations', (await asked(page)).badges.at(-1) === 3,
            J((await asked(page)).badges));
      check('then: on, this device marked in the list, a test on its way',
        /On — this device is told/.test(await panel(page)) && /this device/.test(await panel(page)) && /a test is on its way/.test(await panel(page)), await panel(page));

      let m = sent.length;
      await page.click('#adm-push button:has-text("Send a test")');
      await page.waitForTimeout(400);
      check('Send a test asks push_test', since(m).some(r => r.name === 'push_test'));

      m = sent.length;
      await page.click('#adm-push button[aria-label="Stop notifications to iPhone · Home Screen"]');
      await page.waitForSelector('[data-ask="yes"]');
      const ask = await page.evaluate(() => document.querySelector('.modal-card--ask')?.textContent.replace(/\s+/g, ' ') || '');
      await page.click('[data-ask="yes"]');
      await page.waitForTimeout(400);
      const gone = since(m).find(r => r.name === 'push_unsubscribe');
      check('another device removed, asked first, by its place in the list', gone && gone.body.p_id === 3 && /Stop notifications to iPhone/.test(ask),
            J({ body: gone && gone.body, ask: ask.slice(0, 80) }));

      m = sent.length;
      mine = { ...mine, devices: [] };
      await page.click('#adm-push button:has-text("Turn off on this device")');
      await waitText(page, /Off on this device/);
      const off = since(m).find(r => r.name === 'push_unsubscribe');
      const a2 = await asked(page);
      check('turned off: push_unsubscribe by this endpoint, the browser\'s subscription ended, the icon cleared',
        off && off.body.p_endpoint === ENDPOINT && a2.unsubscribed === 1 && a2.badges.at(-1) === 0, J({ body: off && off.body, a2 }));

      // ── 7. A pressed notification, the app already open ──
      log('\n7. A pressed notification\n');
      await page.evaluate(() => switchTab('stations'));
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message',
        { data: { type: 'floodnet-open', url: `${location.origin}/index.html?tab=admin` } })));
      await page.waitForFunction(() => state.activeTab === 'admin', null, { timeout: 5000 }).catch(() => {});
      const nav = await page.evaluate(() => ({ tab: state.activeTab, loads: performance.getEntriesByType('navigation').length }));
      check('sw.js says where: the Admin tab, without a reload', nav.tab === 'admin' && nav.loads === 1, J(nav));
      await page.evaluate(() => switchTab('stations'));
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message',
        { data: { type: 'floodnet-open', url: `${location.origin}/#pair=BCDF-GHJK` } })));
      await page.waitForFunction(() => state.activeTab === 'admin', null, { timeout: 5000 }).catch(() => {});
      check('…or a base station\'s approve form, by its #pair= code', await page.evaluate(() => state.activeTab === 'admin'
        && !/#pair=/.test(location.hash)));
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message',
        { data: { type: 'floodnet-open', url: 'https://evil.test/?tab=stations' } })));
      await page.waitForTimeout(200);
      check('…and an address on another site is ignored', await page.evaluate(() => state.activeTab === 'admin'));

      // Signing out clears the icon.
      await page.evaluate(() => Auth.signOut && Auth.signOut());
      await page.waitForFunction(() => !Auth.known(), null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      check('signed out: the icon is cleared', (await asked(page)).badges.at(-1) === 0, J((await asked(page)).badges));
      await context.close();
    }
    {
      mine = { key: KEY, last_run: recent(), is_admin: true, waiting: { accounts: 0, tokens: 0, total: 0 }, devices: [] };
      const { context, page } = await open(server.url('/index.html?tab=admin'), { answer: 'denied' });
      await waitText(page, /Off/);
      const n = sent.length;
      await page.click('#adm-push button:has-text("Turn on for this device")');
      await waitText(page, /blocked/);
      check('permission refused: said, with where to allow it, and nothing sent',
        /blocked for Flood-Net/.test(await panel(page)) && /Settings → Notifications/.test(await panel(page))
          && !since(n).some(r => r.name === 'push_subscribe'), await panel(page));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n6. An iPhone in Safari\'s tab\n');
    {
      mine = { key: KEY, last_run: recent(), is_admin: true, waiting: { accounts: 0, tokens: 0, total: 0 }, devices: [] };
      const { context, page } = await open(server.url('/index.html?tab=admin'), { userAgent: iphone });
      await waitText(page, /Home Screen/);
      const t = await panel(page);
      check('told notifications come to the Home Screen app, which keeps its own sign-in, and how to add it',
        /Home Screen app/.test(t) && /own sign-in/.test(t) && !!(await page.$('#adm-push button:has-text("How to add it")'))
          && !(await page.$('#adm-push button:has-text("Turn on")')), t);
      await page.click('#adm-push button:has-text("How to add it")');
      await page.waitForTimeout(300);
      check('…which opens 📲 Offline & Install', await page.evaluate(() => state.activeTab === 'offline'));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — notifications: an administrator turns them on, tests, removes and turns them off; the icon counts; an iPhone is told where (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
