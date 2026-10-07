// MegaNet — pwa.js
//
//   Pwa   the page's half of opening with no signal (#213): it registers
//         sw.js for the version this page is, has the station list and the
//         sheets' lists kept the first time the worker takes the page over,
//         and — on a page that came out of the kept copy while there was no
//         signal — offers the newer version once the site can be reached,
//         never swapping it in. For the 📲 Offline & Install tab
//         (offline-tab.js) it also says what this device has kept, gets it
//         ready in one go, holds the browser's install prompt for a button,
//         and takes the copy away again.
//
// Nothing runs at load; init.js calls start(). sw.js says what is kept and
// why; this file says when the worker is asked for, and what the page tells
// somebody about it.
//
// Not registered: from file:// or plain http to anywhere but this machine
// (a service worker needs a secure context, and a copy opened from disk is
// left exactly as it was); in a browser without service workers; on a device
// whose person said not to keep one (localStorage mn-sw = 'off', from the
// tab's Start again); and under test automation (navigator.webdriver) unless
// a check asks for one with mn-sw = 'on' — a worker answering requests would
// stand between every other check and the requests it stubs.
//
// The first visit. A page is only ever answered by a worker that was there
// when it loaded, so the station list a first visit loads goes past the
// worker and is not kept. When the worker first takes the page over, the list
// is asked for again — from the source the page had it from — and so are the
// inspection and maintenance sheets' lists, through the worker this time: one
// visit with a signal is enough. About 300 KB, once per device.
//
// The install prompt. Chromium browsers say when the app can be installed
// (beforeinstallprompt). It is held here rather than left to show as the
// browser's own strip at the foot of a phone's screen, so the tab's 📲 Install
// button can offer it when somebody asks for it. Every other browser installs
// from its own menu, and the tab says where.
//
// What is said, and how. The newer-version bar is not announced: nothing the
// person did brought it (core.js, announce, rule 1), and it waits, unmoving,
// at the foot of the page until somebody chooses — Reload now or Later. A form
// being filled in is never reloaded from under its author. Later puts it away
// until somebody asks again (the tab's Check for a newer version).
//
// Exposes: start, check, offer, wanted, possible, status, prepare, keepData,
//          remove, canPrompt, promptInstall, installed, onChange.
// Requires: core.js (APP_VERSION, state, DB_URL); at call time, app.js
//           (stationDocRequest), datastore.js (dbSelect), and inspections.js
//           and maintenance.js (refPaths).

const Pwa = (function () {
  const FRESH = 'floodnet-fresh';
  const DATA = 'floodnet-data';
  const SHELL = 'floodnet-shell-';
  const KEPT = 'X-FloodNet-Kept';
  let shown = false;          // the newer-version bar is up
  let declined = false;       // …and was put away with Later
  let deferred = null;        // the browser's install prompt, held for the tab
  let installedNow = false;   // appinstalled fired on this page
  let listening = false;
  const subscribers = new Set();

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const abs = u => new URL(u, location.href).href;
  const scope = () => abs('./');
  const versionOf = w => (w && w.scriptURL ? new URL(w.scriptURL).searchParams.get('v') : null);
  const mine = w => versionOf(w) === APP_VERSION;
  const stored = () => { try { return localStorage.getItem('mn-sw'); } catch (_) { return null; } };
  const store = v => {
    try { if (v == null) localStorage.removeItem('mn-sw'); else localStorage.setItem('mn-sw', v); } catch (_) {}
  };

  // The tab listens; anything that changes what it would say tells it.
  function onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  function notify() { subscribers.forEach(fn => { try { fn(); } catch (_) {} }); }

  // Can this page keep a copy at all? '' if it can; else why not, as a word
  // offline-tab.js turns into a sentence.
  function possible() {
    if (typeof location === 'undefined' || typeof navigator === 'undefined') return 'nosw';
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !(location.protocol === 'http:' && local)) return 'insecure';
    if (!('serviceWorker' in navigator) || typeof caches === 'undefined') return 'nosw';
    return '';
  }
  const optedOut = () => stored() === 'off';

  function wanted() {
    if (possible() || optedOut()) return false;
    if (navigator.webdriver) return stored() === 'on';
    return true;
  }

  function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; notify(); });
    window.addEventListener('appinstalled', () => { deferred = null; installedNow = true; notify(); });
  }

  async function start() {
    listen();
    if (!wanted()) return;
    const firstTime = !navigator.serviceWorker.controller;
    try {
      await navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: './' });
    } catch (err) {
      // An offline copy that could not be set up is not this page's failure.
      console.warn('[Flood-Net] no copy kept for working offline:', (err && err.message) || err);
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', notify);
    if (firstTime) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        listLoaded().then(() => keepData()).catch(() => {}).then(notify);
      }, { once: true });
    }
    window.addEventListener('online', () => { check(); });
    setTimeout(() => { check(); }, 8000);
  }

  // The first load done (or given up on): asking for the list again while it
  // is still arriving would fetch it twice at once.
  async function listLoaded(ms = 120000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(500)) {
      if (!(state.load && state.load.busy)) return;
    }
  }

  // Is the site serving a newer version than this page is? Asked of the site
  // itself — FRESH is the one request the worker lets past — and only ever
  // answered by the app's own index.html: Access's sign-in, a redirect or an
  // error says nothing about versions. 'newer' (and the bar is up), 'same',
  // 'offline', 'unreachable', 'declined' (Later was pressed — asked again only
  // with force) or 'dev'.
  async function check({ force = false } = {}) {
    if (APP_VERSION === 'dev') return 'dev';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (!force && (shown || declined)) return shown ? 'newer' : 'declined';
    try {
      const res = await fetch(`./?${FRESH}=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      if (!res.ok || res.type !== 'basic' || res.redirected) return 'unreachable';
      const html = await res.text();
      const m = html.match(/<script src="core\.js\?v=([^"&]+)"/);
      if (!m) return 'unreachable';
      if (decodeURIComponent(m[1]) === APP_VERSION) return 'same';
      offer();
      return 'newer';
    } catch (_) { return 'unreachable'; }
  }

  function offer() {
    if (shown) return;
    shown = true;
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
    const away = () => {
      el.remove();
      root.style.removeProperty('--pwa-lift');
      window.removeEventListener('resize', lift);
      shown = false;
      declined = true;
    };
    el.querySelector('[data-pwa="reload"]').addEventListener('click', () => location.reload());
    el.querySelector('[data-pwa="later"]').addEventListener('click', away);
    document.body.appendChild(el);
    lift();
    window.addEventListener('resize', lift);
  }

  // ── What this device has kept ────────────────────────────────────────────

  // Where each source of the station list is kept: the address the chain
  // asks it at (app.js, stationDocRequest).
  function listSources() {
    const out = [];
    for (const kind of ['api', 'bundled', 'github']) {
      try { out.push({ kind, url: abs(stationDocRequest(kind)[0]) }); } catch (_) { /* not loaded yet */ }
    }
    return out;
  }
  // The sheets' lists, by the paths the sheets ask for them at.
  function sheetPaths() {
    const all = [];
    for (const m of [typeof Inspections !== 'undefined' ? Inspections : null,
                     typeof Maintenance !== 'undefined' ? Maintenance : null]) {
      if (m && typeof m.refPaths === 'function') all.push(...m.refPaths());
    }
    return [...new Set(all)];
  }
  const sheetUrl = path => abs(`${DB_URL}/${path}`);

  function installed() {
    try {
      return matchMedia('(display-mode: standalone)').matches
        || matchMedia('(display-mode: window-controls-overlay)').matches
        || navigator.standalone === true;
    } catch (_) { return false; }
  }

  // Everything the tab says about this device, read rather than remembered:
  // the worker, the copy of this version's files, the list and the sheets'
  // lists with when each was kept, and the storage the browser gives the site.
  async function status() {
    const s = {
      possible: possible(), optedOut: optedOut(),
      automation: typeof navigator !== 'undefined' && !!navigator.webdriver,
      wanted: wanted(), online: typeof navigator === 'undefined' || navigator.onLine !== false,
      version: APP_VERSION,
      worker: null, settingUp: false, controlled: false,
      shell: { files: 0, whole: false, older: [] },
      list: null,
      sheets: { kept: 0, of: sheetPaths().length },
      storage: null,
      canPrompt: !!deferred, installed: installed(), installedNow,
    };
    if (s.possible) return s;
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      if (reg) {
        s.worker = versionOf(reg.active);
        s.settingUp = !!(reg.installing || reg.waiting);
      }
      s.controlled = !!navigator.serviceWorker.controller;
      const names = await caches.keys();
      const here = SHELL + APP_VERSION;
      s.shell.older = names.filter(n => n.startsWith(SHELL) && n !== here).map(n => n.slice(SHELL.length));
      if (names.includes(here)) {
        const keys = await (await caches.open(here)).keys();
        s.shell.files = keys.length;
        s.shell.whole = keys.some(r => r.url === scope());
      }
      if (names.includes(DATA)) {
        const data = await caches.open(DATA);
        for (const { kind, url } of listSources()) {
          const hit = await data.match(url);
          if (!hit) continue;
          const t = Date.parse(hit.headers.get(KEPT) || '');
          const at = Number.isNaN(t) ? null : new Date(t);
          if (!s.list || (at && (!s.list.at || at > s.list.at))) s.list = { kind, at };
        }
        for (const p of sheetPaths()) if (await data.match(sheetUrl(p))) s.sheets.kept++;
      }
    } catch (_) { /* a browser that will not say: the tab says what it could find */ }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        s.storage = { usage: e.usage || 0, quota: e.quota || 0, persisted: null };
        if (navigator.storage.persisted) s.storage.persisted = await navigator.storage.persisted();
      }
    } catch (_) { /* not said */ }
    return s;
  }

  // ── Getting a device ready ───────────────────────────────────────────────

  // This version's worker, installed and answering this page. Registered if
  // it is not, waited for while it keeps its files (onTick hears how many so
  // far), and asked to take this page if it is in charge of the site but not
  // of this page (a hard reload goes past a worker). Throws 'install' when
  // the browser threw the worker away — a file would not come — and 'slow'.
  async function untilReady(onTick = () => {}, ms = 180000) {
    let reg = await navigator.serviceWorker.getRegistration('./');
    if (!reg || !(mine(reg.active) || mine(reg.installing) || mine(reg.waiting))) {
      reg = await navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: './' });
    }
    const t0 = Date.now();
    let asked = false;
    for (;;) {
      reg = (await navigator.serviceWorker.getRegistration('./')) || reg;
      if (mine(reg.active) && mine(navigator.serviceWorker.controller)) return reg;
      if (mine(reg.active) && !asked && Date.now() - t0 > 1500) {
        reg.active.postMessage({ type: 'claim' });
        asked = true;
      }
      if (!mine(reg.active) && !mine(reg.installing) && !mine(reg.waiting) && Date.now() - t0 > 3000) {
        throw new Error('install');
      }
      if (Date.now() - t0 > ms) throw new Error('slow');
      onTick(await shellCount());
      await wait(400);
    }
  }

  async function shellCount() {
    try {
      const name = SHELL + APP_VERSION;
      if (!(await caches.has(name))) return 0;
      return (await (await caches.open(name)).keys()).length;
    } catch (_) { return 0; }
  }

  // Has the worker written a copy of url since t0? It writes beside the
  // answer, not before it, so this gives it a moment.
  async function keptSince(url, t0, ms = 10000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
      try {
        const hit = await caches.match(url, { cacheName: DATA });
        const at = hit ? Date.parse(hit.headers.get(KEPT) || '') : NaN;
        if (at >= t0 - 1000) return true;
      } catch (_) { return false; }
    }
    return false;
  }

  // The station list and the sheets' lists, asked for through the worker so
  // it keeps them: the list from the source this page has it from first, then
  // the chain's own order; the sheets' lists by the calls the sheets make.
  async function keepData(onStep = () => {}) {
    const t0 = Date.now();
    const out = { list: '', sheets: { kept: 0, of: 0 } };
    onStep('list', 'doing');
    const had = state.dataSource && state.dataSource.kind;
    const kinds = [...new Set([...(['api', 'bundled', 'github'].includes(had) ? [had] : []), 'api', 'bundled', 'github'])];
    for (const kind of kinds) {
      try {
        const [url, init] = stationDocRequest(kind);
        const res = await fetch(url, init);
        if (!res.ok) continue;
        await res.arrayBuffer();
        if (await keptSince(abs(url), t0)) { out.list = kind; break; }
      } catch (_) { /* the next source */ }
    }
    onStep('list', out.list ? 'done' : 'failed', out.list);
    onStep('sheets', 'doing');
    const paths = sheetPaths();
    out.sheets.of = paths.length;
    await Promise.all(paths.map(p => dbSelect(p)
      .then(() => keptSince(sheetUrl(p), t0))
      .then(ok => { if (ok) out.sheets.kept++; }, () => {})));
    onStep('sheets', out.sheets.of && out.sheets.kept === out.sheets.of ? 'done' : 'failed', out.sheets);
    return out;
  }

  // Everything a device needs to open with no signal, in one go, each step
  // said as it happens: the app's files, the station list, the sheets' lists,
  // and the browser asked to keep them through a clean-up. Pressing it is
  // asking for a copy in so many words, so it undoes Start again's "don't".
  // Resolves to { ok, app, list, sheets, persisted, why }.
  async function prepare(onStep = () => {}) {
    const out = { ok: false, app: false, list: '', sheets: null, persisted: null, why: possible() };
    if (out.why) return out;
    if (navigator.onLine === false) { out.why = 'offline'; return out; }
    store('on');
    onStep('app', 'doing', 0);
    try {
      await untilReady(n => onStep('app', 'doing', n));
      out.app = true;
      onStep('app', 'done', await shellCount());
    } catch (err) {
      out.why = (err && err.message === 'slow') ? 'slow' : 'install';
      onStep('app', 'failed', out.why);
      notify();
      return out;
    }
    const kept = await keepData(onStep);
    out.list = kept.list;
    out.sheets = kept.sheets;
    onStep('protect', 'doing');
    try {
      if (navigator.storage && navigator.storage.persist) out.persisted = await navigator.storage.persist();
    } catch (_) { out.persisted = null; }
    onStep('protect', out.persisted ? 'done' : 'note', out.persisted);
    out.ok = !!(out.app && out.list && kept.sheets.of && kept.sheets.kept === kept.sheets.of);
    if (!out.ok) out.why = 'data';
    notify();
    return out;
  }

  // Start again: this site's worker gone and every copy it kept. Drafts are
  // localStorage's and stay. keepOff: and none kept on this device again
  // until somebody presses Get this device ready.
  async function remove({ keepOff = false } = {}) {
    if (!possible()) {
      const regs = await navigator.serviceWorker.getRegistrations();
      // Only this app's: a github.io origin is shared with every other
      // project its owner publishes.
      await Promise.all(regs.filter(r => r.scope === scope()).map(r => r.unregister()));
      for (const name of await caches.keys()) {
        if (name.startsWith('floodnet-')) await caches.delete(name);
      }
    }
    store(keepOff ? 'off' : null);
    notify();
  }

  // ── Installing ───────────────────────────────────────────────────────────

  const canPrompt = () => !!deferred;

  // The browser's own install question, from a press of the tab's button.
  // 'accepted', 'dismissed' or 'unavailable'. Used once: the browser hands
  // out another when it is ready to ask again.
  async function promptInstall() {
    if (!deferred) return 'unavailable';
    const e = deferred;
    deferred = null;
    try {
      await e.prompt();
      const choice = await e.userChoice;
      return (choice && choice.outcome) || 'dismissed';
    } catch (_) {
      return 'unavailable';
    } finally {
      notify();
    }
  }

  return {
    start, check, offer, wanted, possible, status, prepare, keepData, remove,
    canPrompt, promptInstall, installed, onChange,
  };
})();
if (typeof window !== 'undefined') window.Pwa = Pwa;
