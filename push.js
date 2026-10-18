// MegaNet — push.js
//
//   Push   an administrator's notifications on this device (0066): the Admin
//          tab's 🔔 Notifications panel — turn them on (the browser's
//          permission, a push subscription made with the server's VAPID key,
//          push_subscribe), send a test, turn them off, and this account's
//          other devices with what their push service last said; the number
//          of things waiting, on the app's icon (the Badging API), set
//          whenever the page learns it; and where a pressed notification
//          asked to go, when the app was already open — sw.js posts it here
//          rather than reloading a page somebody may be typing into.
//
// The sender is the Worker, on a schedule (worker/push.js); sw.js shows what
// arrives; db/migrations/0066_push_notifications.sql decides who hears what.
//
// What a device cannot do, and what the panel says then:
//   * an iPhone or iPad in a browser tab — Web Push and the badge belong to
//     the home-screen app (iOS 16.4 and later), which keeps its own sign-in:
//     add it to the Home Screen, open it from there, turn them on there;
//   * a browser with no Push API, or a device with no service worker (the
//     📲 Offline & Install tab's Start again takes it away) — said, and why;
//   * notifications blocked for the site — where to allow them again;
//   * a server with no key yet, or whose schedule has stopped.
//
// The badge, on a device that is told and nowhere else. iOS lets a web app's
// push only show a notification, never just change a number, so the count on
// the icon is the one the last notification carried until the app is opened —
// and then this file puts it right, from push_mine(), on sign-in, on coming
// back to the foreground, and after an administrator decides something here.
// A device that is not told has nothing to keep a count true, so it shows none.
//
// Nothing runs at load; init.js calls start().
//
// Exposes: start, render, refresh, enable, disable, test, forget, authChanged.
// Requires: core.js (state, esc, escAttr, announce), datastore.js (dbRpc),
//           auth.js (Auth), app.js (switchTab, renderTabs, renderMain),
//           admin-tokens.js (AdminTokens.restoreFromUrl), offline-tab.js
//           (OfflineTab.detect), modal.js (confirmDialog) and toast.js (Toast),
//           at call time.

const Push = (function () {
  // What the database last said (push_mine), or null before it has.
  let mine = null;
  // This browser's own subscription and the permission, as last read.
  let sub = null;
  let permission = 'default';
  let busy = false;
  let error = '';          // the last thing that went wrong, for the panel
  let missing = false;     // the database predates 0066
  let lastRefresh = 0;
  let started = false;
  // How long since the sender last ran before the panel says it may have
  // stopped. It notes a run at most every ten minutes (0066), and runs every one.
  const STALE_MS = 30 * 60 * 1000;
  const FOREGROUND_GAP_MS = 30 * 1000;

  const signedIn = () => typeof Auth !== 'undefined' && Auth.known && Auth.known();
  const isAdmin = () => typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();

  function standalone() {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
    try { return matchMedia('(display-mode: standalone)').matches; } catch (_) { return false; }
  }
  function device() {
    return typeof OfflineTab !== 'undefined' && OfflineTab.detect ? OfflineTab.detect()
      : { ios: false, platform: 'computer', browser: 'a browser', iosVersion: null };
  }

  // '' when this device can be told, else why not.
  function support() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'nopush';
    if (!window.isSecureContext) return 'insecure';
    const d = device();
    if (d.ios && !standalone()) return 'ios-tab';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      return d.ios ? 'ios-old' : 'nopush';
    }
    return '';
  }

  // What the device calls itself in the list: "iPhone · Home Screen".
  function label() {
    const d = device();
    const where = d.platform === 'computer'
      ? (/Macintosh/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows'
        : /CrOS/.test(navigator.userAgent) ? 'Chromebook' : /Linux/.test(navigator.userAgent) ? 'Linux' : 'Computer')
      : d.platform === 'Android' ? 'Android' : d.platform;
    return `${where} · ${d.ios && standalone() ? 'Home Screen' : d.browser || 'a browser'}`.slice(0, 60);
  }

  function b64urlBytes(s) {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesB64url(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // The worker in charge of this page's scope, or null — never a wait on one
  // that is not coming (pwa.js stands down under automation, and on a device
  // whose person said not to keep a copy).
  async function registration() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    try { return (await navigator.serviceWorker.getRegistration('./')) || null; } catch (_) { return null; }
  }

  // Was this subscription made with the server's key? Unknown (no options) is
  // taken as yes; the server refuses a stale one anyway.
  function madeWith(s, key) {
    try {
      const k = s && s.options && s.options.applicationServerKey;
      return !k || !key || bytesB64url(k) === key;
    } catch (_) { return true; }
  }

  // ── The badge ──

  function badge(n) {
    if (typeof navigator === 'undefined') return;
    try {
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (!(n > 0) && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (_) { /* no Badging API, or no permission for it */ }
  }

  // ── What the database and the browser say ──

  async function refresh() {
    lastRefresh = Date.now();
    // Only an administrator has anything waiting, or a device to be told: for
    // anybody else the database is not asked, and the icon is cleared of a
    // count an administrator signed in here before may have left on it.
    if (!signedIn() || !isAdmin()) {
      mine = null; sub = null;
      badge(0);
      repaint();
      return;
    }
    try {
      mine = await dbRpc('push_mine', {});
      missing = false;
    } catch (err) {
      mine = null;
      missing = err.status === 404;
      if (!missing) error = `Could not read your notifications: ${err.message}`;
    }
    permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
    const reg = support() ? null : await registration();
    try { sub = reg ? await reg.pushManager.getSubscription() : null; } catch (_) { sub = null; }
    // Only on a device that is told: anywhere else nothing would keep it true
    // between visits.
    badge(thisRow() && mine.waiting ? Number(mine.waiting.total) || 0 : 0);
    repaint();
  }

  // This device's row on the server, if its subscription is one.
  function thisRow() {
    if (!sub || !mine || !Array.isArray(mine.devices)) return null;
    return mine.devices.find(d => d.endpoint === sub.endpoint) || null;
  }

  // ── Turning it on and off ──

  // The permission is asked first, before anything is awaited: Safari grants
  // it only inside the tap that asked.
  async function enable() {
    if (busy) return;
    const why = support();
    if (why) { repaint(); return; }
    if (!mine || !mine.key) { error = 'Notifications are not set up on the server yet.'; repaint(); return; }
    busy = true; error = ''; repaint();
    try {
      permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(permission === 'denied'
        ? 'Notifications are blocked for Flood-Net on this device — see below for where to allow them.'
        : 'Notifications were not allowed.');
      const reg = await registration();
      if (!reg) throw new Error('This device has no service worker for Flood-Net, which is what notifications arrive through.');
      let s = await reg.pushManager.getSubscription();
      if (s && !madeWith(s, mine.key)) { try { await s.unsubscribe(); } catch (_) {} s = null; }
      if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(mine.key) });
      await dbRpc('push_subscribe', {
        p_endpoint: s.endpoint,
        p_p256dh: bytesB64url(s.getKey('p256dh')),
        p_auth: bytesB64url(s.getKey('auth')),
        p_key: mine.key,
        p_label: label(),
      });
      sub = s;
      announce('Notifications are on for this device.');
      if (typeof Toast !== 'undefined') {
        Toast.done('Notifications are on for this device. A test notification is on its way — it arrives within a minute or two.');
      }
    } catch (err) {
      error = (err && err.message) || String(err);
    }
    busy = false;
    await refresh();
  }

  async function disable() {
    if (busy) return;
    busy = true; error = ''; repaint();
    try {
      if (sub) {
        await dbRpc('push_unsubscribe', { p_endpoint: sub.endpoint });
        try { await sub.unsubscribe(); } catch (_) { /* gone already */ }
      }
      sub = null;
      badge(0);
      announce('Notifications are off for this device.');
    } catch (err) {
      error = `Could not turn them off: ${err.message}`;
    }
    busy = false;
    await refresh();
  }

  async function test() {
    if (busy) return;
    try {
      const n = await dbRpc('push_test', {});
      const words = `A test notification is on its way to ${n} device${n === 1 ? '' : 's'} — within a minute or two.`;
      announce(words);
      if (typeof Toast !== 'undefined') Toast.done(words);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.failed(err.message);
    }
    await refresh();
  }

  // One of the list's devices off — a phone that was lost or replaced.
  async function forget(id) {
    const d = mine && (mine.devices || []).find(x => x.id === id);
    if (!d || busy) return;
    const here = sub && d.endpoint === sub.endpoint;
    if (!(await confirmDialog({ title: `Stop notifications to ${d.label}?`,
      message: here ? 'This device stops being told. You can turn it on again here.'
        : 'That device stops being told. It can be turned on again from the Admin tab on it.',
      confirm: 'Stop them', danger: true }))) return;
    try {
      await dbRpc('push_unsubscribe', { p_id: id });
      if (here) { try { await sub.unsubscribe(); } catch (_) {} sub = null; badge(0); }
      announce(`Notifications to ${d.label} are off.`);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.failed(err.message);
    }
    await refresh();
  }

  // ── Where a pressed notification goes ──

  // sw.js found Flood-Net open and posts the address here instead of
  // reloading it: #pair= opens that base station's approve form, as its QR
  // code does; anything else names a tab.
  function openFrom(raw) {
    let u;
    try { u = new URL(raw, location.href); } catch (_) { return; }
    if (u.origin !== location.origin) return;
    if (/^#pair=/.test(u.hash) && typeof AdminTokens !== 'undefined') {
      history.replaceState(null, '', location.pathname + location.search + u.hash);
      AdminTokens.restoreFromUrl();
    } else if (typeof switchTab === 'function') {
      switchTab(u.searchParams.get('tab') || 'admin');
    }
    refresh();
  }

  function start() {
    if (started || typeof window === 'undefined') return;
    started = true;
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'floodnet-open' && typeof e.data.url === 'string') openFrom(e.data.url);
      });
    }
    // Back from the background: what the icon says may be out of date.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isAdmin() && Date.now() - lastRefresh > FOREGROUND_GAP_MS) refresh();
    });
  }

  function authChanged() {
    mine = null; sub = null; error = ''; missing = false;
    refresh();
  }

  // ── The panel ──

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? esc(ts) : esc(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  }

  function whyHtml(why) {
    if (why === 'ios-tab') {
      return `<p class="small">On an iPhone or iPad, notifications and the count on the icon come to the
        <strong>Home Screen app</strong> only. Add Flood-Net to your Home Screen, open it from the icon, sign in there
        (it keeps its own sign-in) and turn notifications on in that copy.</p>
        <div class="button-group"><button type="button" onclick="switchTab('offline')">📲 How to add it</button></div>`;
    }
    if (why === 'ios-old') return '<p class="small txt-warn">This iPhone or iPad cannot receive notifications from a web app: that needs iOS 16.4 or later.</p>';
    if (why === 'insecure') return '<p class="small txt-warn">Notifications need the site over https.</p>';
    return '<p class="small txt-warn">This browser cannot receive notifications from a web page.</p>';
  }

  function deviceStatus(d) {
    if (!d.current_key) return '<span class="txt-warn">made with an old key — turn it on again on that device</span>';
    if (d.test_waiting) return '<span class="txt-muted">a test is on its way</span>';
    if (d.last_status != null && d.last_status >= 200 && d.last_status < 300) return `<span class="txt-ok">last sent ${when(d.last_sent_at)}</span>`;
    if (d.last_error) return `<span class="txt-bad">the last one did not go: ${esc(d.last_error)}</span>`;
    return '<span class="txt-muted">nothing sent yet</span>';
  }

  function panelHtml() {
    if (!signedIn() || !isAdmin()) return '';
    const head = `<div class="panel-header"><h2 id="adm-push-h">🔔 Notifications</h2></div>
      <p class="small">Your phone tells you when an account is waiting for approval or a base station asks for a
        token, and the app's icon shows how many are waiting. Each device is turned on by itself.</p>`;
    if (missing) {
      return `<div class="panel">${head}<p class="small txt-warn">The database does not have notifications yet —
        apply <code>db/migrations/0066_push_notifications.sql</code>.</p></div>`;
    }
    if (!mine) return `<div class="panel">${head}<p class="small txt-muted">${error ? esc(error) : 'Checking…'}</p></div>`;

    const why = support();
    const row = thisRow();
    const on = !!(row && row.current_key);
    const lastRun = mine.last_run ? new Date(mine.last_run) : null;
    let server = '';
    if (!mine.key) {
      server = `<p class="small txt-warn">Not set up on the server yet. The Worker makes its key on its first scheduled run,
        a minute after it is deployed with <code>[triggers]</code> in <code>wrangler.toml</code> — docs/accounts.md,
        “Notifications on a phone”.</p>`;
    } else if (lastRun && Date.now() - lastRun.getTime() > STALE_MS) {
      server = `<p class="small txt-warn">The server last looked for news at ${when(mine.last_run)} — its schedule may have
        stopped, and nothing is being sent.</p>`;
    }

    let here;
    if (why) here = whyHtml(why);
    else if (permission === 'denied') {
      here = `<p class="small txt-bad">Notifications are blocked for Flood-Net on this device. On an iPhone:
        Settings → Notifications → Flood-Net → Allow Notifications. In a browser: the site's settings, by the address bar.</p>`;
    } else if (on) {
      here = `<p class="small" role="status"><strong class="txt-ok">On</strong> — this device is told. ${deviceStatus(row)}.</p>
        <div class="button-group adm-actions">
          <button type="button" onclick="Push.test()" ${busy ? 'disabled' : ''}>Send a test</button>
          <button type="button" onclick="Push.disable()" ${busy ? 'disabled' : ''}>Turn off on this device</button>
        </div>`;
    } else {
      here = `<p class="small" role="status"><strong>Off</strong> on this device.${sub && row && !row.current_key
          ? ' It was turned on with a key the server no longer uses.' : ''}</p>
        <div class="button-group adm-actions">
          <button type="button" class="primary" onclick="Push.enable()" ${busy || !mine.key ? 'disabled' : ''}>🔔 Turn on for this device</button>
        </div>`;
    }

    const devices = Array.isArray(mine.devices) ? mine.devices : [];
    const list = devices.length ? `
      <h3 class="small adm-push-h">Your devices</h3>
      <ul class="adm-wait-list" aria-labelledby="adm-push-h">${devices.map(d => `
        <li class="adm-wait-row">
          <div class="adm-wait-who">
            <strong>${esc(d.label)}${sub && d.endpoint === sub.endpoint ? ' <span class="badge">this device</span>' : ''}</strong>
            <span class="small txt-muted">since ${when(d.created_at)} · ${deviceStatus(d)}</span>
          </div>
          <div class="button-group adm-wait-acts">
            <button type="button" class="exp-btn-sm adm-danger" onclick="Push.forget(${Number(d.id)})"
                    aria-label="Stop notifications to ${escAttr(d.label)}">Remove</button>
          </div>
        </li>`).join('')}</ul>` : '';

    return `<div class="panel">${head}${server}${here}
      ${error ? `<p class="small txt-bad" role="alert">${esc(error)}</p>` : ''}${list}</div>`;
  }

  function repaint() {
    if (typeof document === 'undefined' || typeof state === 'undefined' || state.activeTab !== 'admin') return;
    const el = document.getElementById('adm-push');
    if (el) el.innerHTML = panelHtml();
  }

  function render() { return panelHtml(); }

  return { start, render, refresh, enable, disable, test, forget, authChanged };
})();
if (typeof window !== 'undefined') window.Push = Push;
