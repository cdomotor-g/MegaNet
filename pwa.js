// MegaNet — pwa.js
//
//   Pwa   the page's half of opening with no signal (#213): it registers
//         sw.js for the version this page is, and — on a page that came out
//         of the kept copy while there was no signal — offers the newer
//         version once the site can be reached, never swapping it in.
//
// Nothing runs at load; init.js calls start(). sw.js says what is kept and
// why; this file says when the worker is asked for, and what the page tells
// somebody about it.
//
// Not registered: from file:// or plain http to anywhere but this machine
// (a service worker needs a secure context, and a copy opened from disk is
// left exactly as it was); in a browser without service workers; and under
// test automation (navigator.webdriver) unless a check asks for one with
// localStorage mn-sw = 'on' — a worker answering requests would stand between
// every other check and the requests it stubs.
//
// What is said, and how. The banner is not announced: nothing the person did
// brought it (core.js, announce, rule 1), and it waits, unmoving, at the foot
// of the page until somebody chooses — Reload now or Later. A form being
// filled in is never reloaded from under its author.
//
// Exposes: start, check, offer, wanted.
// Requires: core.js (APP_VERSION).

const Pwa = (function () {
  const FRESH = 'floodnet-fresh';
  let offered = false;

  function wanted() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !(location.protocol === 'http:' && local)) return false;
    if (navigator.webdriver) {
      try { return localStorage.getItem('mn-sw') === 'on'; } catch (_) { return false; }
    }
    return true;
  }

  async function start() {
    if (!wanted()) return;
    try {
      await navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: './' });
    } catch (err) {
      // An offline copy that could not be set up is not this page's failure.
      console.warn('[Flood-Net] no copy kept for working offline:', (err && err.message) || err);
      return;
    }
    window.addEventListener('online', () => { check(); });
    setTimeout(() => { check(); }, 8000);
  }

  // Is the site serving a newer version than this page is? Asked of the site
  // itself — FRESH is the one request the worker lets past — and only ever
  // answered by the app's own index.html: Access's sign-in, a redirect or an
  // error says nothing about versions.
  async function check() {
    if (offered || (typeof navigator !== 'undefined' && navigator.onLine === false) || APP_VERSION === 'dev') return false;
    try {
      const res = await fetch(`./?${FRESH}=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok || res.type !== 'basic' || res.redirected) return false;
      const html = await res.text();
      const m = html.match(/<script src="core\.js\?v=([^"&]+)"/);
      if (!m || decodeURIComponent(m[1]) === APP_VERSION) return false;
      offer();
      return true;
    } catch (_) { return false; }
  }

  function offer() {
    if (offered) return;
    offered = true;
    const el = document.createElement('div');
    el.id = 'pwa-update';
    el.className = 'pwa-update';
    el.innerHTML = `<p class="pwa-update-text"><strong>A newer version of Flood-Net is ready.</strong>
        This page is the version before it. Drafts are kept either way.</p>
      <div class="pwa-update-acts">
        <button type="button" class="primary" data-pwa="reload">Reload now</button>
        <button type="button" data-pwa="later">Later</button>
      </div>`;
    // The notes at the foot of the window (toast.js) stand above the bar
    // while it is up, never over its buttons: --pwa-lift is its height.
    const root = document.documentElement;
    const lift = () => root.style.setProperty('--pwa-lift', `${el.offsetHeight + 8}px`);
    const away = () => { el.remove(); root.style.removeProperty('--pwa-lift'); window.removeEventListener('resize', lift); };
    el.querySelector('[data-pwa="reload"]').addEventListener('click', () => location.reload());
    el.querySelector('[data-pwa="later"]').addEventListener('click', away);
    document.body.appendChild(el);
    lift();
    window.addEventListener('resize', lift);
  }

  return { start, check, offer, wanted };
})();
if (typeof window !== 'undefined') window.Pwa = Pwa;
