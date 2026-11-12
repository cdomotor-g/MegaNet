// MegaNet — busy.js
//
//   Busy   the little wheel at the far right of the banner. It spins while the
//          app is doing something you may have to wait a moment for — loading
//          from the database or the web, saving to it, or working something
//          out on this device — and closes into a ✓ when it is done.
//
// Three ways a job reaches it, so that almost nothing has to call it:
//
//   1. Every fetch(). start() wraps window.fetch, first thing in init.js and
//      so before anything else asks for anything, and a read from the
//      database, a photo going up, a data file or a tile of terrain all count
//      with no change to the code that asks. A GET is loading; a POST, PATCH,
//      PUT or DELETE is saving — except a database function (PostgREST's
//      /rpc/, always a POST) whose name does not say it changes anything
//      (task_list, inspection_doc), which is loading. Reading the answer's
//      body (res.json(), .text() …) is part of the load, so the job lasts
//      until that is done too. `fetch(url, { busy: false })` keeps a
//      background request out of it.
//   2. The page's own "working on it" lines. A status line (role="status")
//      whose words end in "…" — "Working out the drive…", "Reading the land
//      cover along the path…" — or anything marked aria-busy="true", while it
//      is on screen. Every tab already keeps that convention, so a long sum
//      that says so on the page spins the wheel without knowing it exists.
//      "Waiting for…", "Watching…" and "Listening…" are states somebody is
//      waiting on, not work, and do not count; nor does a line that has not
//      changed in STALE_MS, which is a line left behind rather than a job.
//   3. Busy.run(kind, label, promise or function) and Busy.begin(kind, label)
//      → end(), for anything that says nothing on the page.
//
// The wheel shows only once the app has been busy for SHOW_MS without a break
// (a pause under GAP_MS between one job and the next is not a break) — a read
// answered from the cache in 5 ms is not worth a flicker — and once up it
// stays for at least MIN_MS, then closes into a ✓ and goes. Its slot in the banner is always
// there, empty while nothing is happening, so the buttons never shift when it
// comes and goes.
//
// The rings are HTML boxes turned by a CSS transform, not SVG: the browser
// turns those on its compositor, so the wheel keeps spinning while a long sum
// has the page's own thread tied up — which is exactly when it is wanted.
//
// Pressing it opens a small card: what is happening now, live, and what the
// colours mean — the same words as its tooltip, for a finger or a keyboard.
//
// Nothing runs at load. init.js calls start(), first.
//
// Exposes: start, begin, run, explain, close, jobs, KEY.
// Requires: core.js (esc) at call time.

const Busy = (() => {
  const SHOW_MS  = 100;     // how long the app must be busy before the wheel comes up
  const GAP_MS   = 60;      // a pause shorter than this between two jobs is no pause
  const MIN_MS   = 450;     // once up, at least this long — a turn and a half
  const TICK_MS  = 420;     // the ✓ at the end
  const SCAN_MS  = 150;     // the page's status lines are read at most this often
  const RECHECK_MS = 600;   // …and again this often while one of them counts
  const STALE_MS = 60000;   // a status line unchanged for this long no longer counts

  // What the colours mean: the tooltip, the card's key and docs/design-system.md
  // all say this, from here.
  const KEY = {
    load: { word: 'Loading', meaning: 'Fetching something from the database or the web — a station list, photos, map data.' },
    save: { word: 'Saving', meaning: 'Sending a change to the database — a station you edited, a photo, a setting.' },
    work: { word: 'Working it out', meaning: 'A sum this device is doing — a path profile, a coverage map, a drive.' },
  };
  const COLOUR = { load: 'Blue', save: 'Green', work: 'Amber' };
  // When two kinds are going at once the outer ring wears the first of these
  // and the inner ring the next: a save is what somebody waits on, a sum is
  // usually why the loads are happening.
  const ORDER = ['save', 'work', 'load'];

  // Database functions whose name says they change something.
  const WRITES = /(^|_)(save|update|delete|remove|add|create|set|log|attach|detach|claim|release|allocate|approve|decide|deny|revoke|restore|propose|apply|return|subscribe|unsubscribe|cancel|command|test|upload|upsert|insert|record|mark|send)(_|$)/i;
  const LOAD_WORDS = /^(loading|reading|fetching|downloading|opening|finding|asking|getting|looking|checking|connecting|signing)\b/i;
  const SAVE_WORDS = /^(saving|uploading|sending|writing|deleting|removing|storing|publishing|submitting)\b/i;
  const IDLE_WORDS = /^(waiting|watching|listening)\b/i;
  const STATUS_SEL = '[role="status"], [aria-busy="true"]';

  const jobs = new Map();          // id → { kind, label, t0 } — fetches and begin()
  let statusJobs = [];             // the same shape, read off the page
  const seen = new WeakMap();      // status element → { text, t0, changed }
  let seq = 0;
  let started = false;
  let phase = 'idle';              // idle · wait · spin · tick
  let busySince = 0, quietSince = 0, shownAt = 0, tickAt = 0;
  let timer = 0, soon = 0, scanTimer = 0, recheckTimer = 0;
  let painted = '';                // what the wheel shows, so a repaint that changes nothing writes nothing
  let popOpen = false;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const kindOf = k => (KEY[k] ? k : 'work');

  // ── Jobs ──────────────────────────────────────────────────────────────────

  // A job from now until end() is called; end() twice is once.
  function begin(kind, label, t0) {
    const id = ++seq;
    jobs.set(id, { kind: kindOf(kind), label: String(label || KEY[kindOf(kind)].word), t0: t0 == null ? now() : t0 });
    queue();
    let over = false;
    return function end() {
      if (over) return;
      over = true;
      jobs.delete(id);
      queue();
    };
  }

  // `work` is a promise, or a function returning one (or a value); the wheel
  // spins until it settles. Hands back what it was given, so it wraps in place:
  // `const rows = await Busy.run('load', 'Reading the log', fetchRows())`.
  function run(kind, label, work) {
    const end = begin(kind, label);
    let out;
    try { out = typeof work === 'function' ? work() : work; } catch (e) { end(); throw e; }
    Promise.resolve(out).then(end, end);
    return out;
  }

  // ── 1. fetch() ────────────────────────────────────────────────────────────

  function describeFetch(input, init) {
    let url = '', method = 'GET';
    try {
      if (typeof input === 'string') url = input;
      else if (typeof URL !== 'undefined' && input instanceof URL) url = input.href;
      else if (input && typeof input.url === 'string') { url = input.url; method = input.method || method; }
    } catch (_) {}
    if (init && init.method) method = String(init.method);
    method = method.toUpperCase();
    let u = null;
    try { u = new URL(url, location.href); } catch (_) {}
    const path = u ? u.pathname : url;
    const own = !!u && u.origin === location.origin;
    let kind = method === 'GET' || method === 'HEAD' ? 'load' : 'save';
    let where = '', what = '', m;
    if ((m = path.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)/i))) {
      where = 'the database';
      what = m[1].replace(/_/g, ' ');
      if (kind === 'save' && !WRITES.test(m[1])) kind = 'load';
    } else if ((m = path.match(/\/rest\/v1\/([a-z0-9_]+)/i))) {
      where = 'the database';
      what = m[1].replace(/_/g, ' ');
    } else if (/\/auth\/v1\//.test(path) || (own && path === '/api/session')) {
      return { kind: 'load', label: 'Checking your sign-in' };
    } else if (/\/storage\/v1\//.test(path)) {
      where = 'the file store';
    } else if (own && /^\/api\//.test(path)) {
      where = 'Flood-Net’s server';
    } else if (own) {
      where = 'this site';
      try { what = decodeURIComponent(path.split('/').pop() || ''); } catch (_) { what = ''; }
    } else if (u && /(^|\.)overpass[a-z0-9.-]*\.(de|systems|org|fr|ch)$/i.test(u.hostname)) {
      // Overpass takes its question as a POST body, but it only reads the
      // OpenStreetMap map data; nothing is stored anywhere.
      kind = 'load';
      where = 'OpenStreetMap map data';
      what = 'via ' + u.hostname;
    } else {
      where = u ? u.hostname.replace(/^www\./, '') : 'the web';
    }
    return { kind, label: `${kind === 'save' ? 'Saving to' : 'Loading from'} ${where}${what ? ` — ${what}` : ''}` };
  }

  // The answer's body is part of the load: a read of it that starts straight
  // away (as `await res.json()` does, a microtask after the headers) begins a
  // job of its own, dated from the request, before the request's own ends.
  function holdBody(res, job, end) {
    for (const name of ['json', 'text', 'arrayBuffer', 'blob', 'formData']) {
      const own = res && res[name];
      if (typeof own !== 'function') continue;
      try {
        res[name] = function () {
          const done = begin(job.kind, job.label, job.t0);
          const p = own.apply(this, arguments);
          p.then(done, done);
          return p;
        };
      } catch (_) {}
    }
    setTimeout(end, 0);
  }

  function wrapFetch() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.fetch.busyWrapped) return;
    const real = window.fetch;
    const wrapped = function fetch(input, init) {
      if (init && init.busy === false) return real.call(window, input, init);
      const job = describeFetch(input, init);
      job.t0 = now();
      const end = begin(job.kind, job.label, job.t0);
      let p;
      try { p = real.call(window, input, init); } catch (e) { end(); throw e; }
      return p.then(res => { holdBody(res, job, end); return res; }, err => { end(); throw err; });
    };
    wrapped.busyWrapped = true;
    window.fetch = wrapped;
  }

  // ── 2. The page's own status lines ─────────────────────────────────────────

  function visible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    }
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function ours(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('#busy-slot, #busy-pop'));
  }

  function queueScan(records) {
    if (records && records.length && records.every(r => ours(r.target))) return;
    if (!scanTimer) scanTimer = setTimeout(scan, SCAN_MS);
  }

  function scan() {
    scanTimer = 0;
    clearTimeout(recheckTimer); recheckTimer = 0;
    const t = now();
    const out = [];
    const labels = new Set();
    for (const el of document.querySelectorAll(STATUS_SEL)) {
      if (el.id === 'app-status' || ours(el) || el.closest('.sr-only')) continue;
      const marked = el.getAttribute('aria-busy') === 'true';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const says = text.length <= 200 && text.endsWith('…') && !IDLE_WORDS.test(text);
      if (!marked && !says) { seen.delete(el); continue; }
      if (!visible(el)) continue;
      let s = seen.get(el);
      if (!s) { s = { text, t0: t, changed: t }; seen.set(el, s); }
      else if (s.text !== text) { s.text = text; s.changed = t; }
      if (t - s.changed > STALE_MS) continue;
      const label = text && text.length <= 120 ? text : (el.getAttribute('aria-label') || 'Loading…');
      if (labels.has(label)) continue;
      labels.add(label);
      const kind = SAVE_WORDS.test(label) ? 'save' : LOAD_WORDS.test(label) || (marked && !says) ? 'load' : 'work';
      // The page has been saying so since before it was read: up at once.
      out.push({ kind, label, t0: s.t0 - SHOW_MS });
    }
    const was = statusJobs.map(j => j.label).join('\n');
    statusJobs = out;
    if (out.length) recheckTimer = setTimeout(scan, RECHECK_MS);
    if (out.map(j => j.label).join('\n') !== was) queue();
  }

  // ── The wheel ─────────────────────────────────────────────────────────────

  function all() { return [...jobs.values(), ...statusJobs]; }

  function queue() { if (!soon) soon = setTimeout(update, 0); }
  function later(ms) { clearTimeout(timer); timer = setTimeout(update, Math.max(0, ms)); }

  function update() {
    soon = 0;
    const list = all();
    const t = now();
    if (list.length) {
      quietSince = 0;
      if (phase === 'idle' || phase === 'wait') {
        // Busy since the first of these began, or since the run of jobs this
        // one belongs to did: a page firing a quick request after a quick
        // request is busy, though no one of them lasts SHOW_MS.
        const first = Math.min(...list.map(j => j.t0));
        busySince = phase === 'wait' ? Math.min(busySince, first) : first;
        const age = t - busySince;
        if (age < SHOW_MS) { phase = 'wait'; later(SHOW_MS - age); return; }
        shownAt = t;
      }
      clearTimeout(timer);
      phase = 'spin';
      paint(list);
      return;
    }
    if (phase === 'wait') {
      if (!quietSince) quietSince = t;
      const left = GAP_MS - (t - quietSince);
      if (left > 0) { later(left); return; }
      phase = 'idle';
      clearTimeout(timer);
      return;
    }
    if (phase === 'spin') {
      const left = MIN_MS - (t - shownAt);
      if (left > 0) { later(left); return; }
      phase = 'tick';
      tickAt = t;
      paint([]);
      later(TICK_MS);
      return;
    }
    if (phase === 'tick') {
      const left = TICK_MS - (t - tickAt);
      if (left > 0) { later(left); return; }
      phase = 'idle';
      paint([]);
    }
  }

  // The labels, alike ones counted once: "Loading from this site — 7.png (×6)".
  function lines(list) {
    const by = new Map();
    for (const j of list) {
      const k = `${j.kind}\n${j.label}`;
      const g = by.get(k);
      if (g) g.n++; else by.set(k, { kind: j.kind, label: j.label, n: 1 });
    }
    return [...by.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  function kindsOf(list) {
    const has = new Set(list.map(j => j.kind));
    const k = ORDER.filter(x => has.has(x));
    return [k[0] || 'load', k[1] || k[0] || 'load'];
  }

  function titleOf(list) {
    const ls = lines(list);
    const shown = ls.slice(0, 4).map(l => `${l.label}${l.n > 1 ? ` (×${l.n})` : ''}`);
    if (ls.length > 4) shown.push(`…and ${ls.length - 4} more`);
    const key = Object.keys(KEY).map(k => `${COLOUR[k]}: ${KEY[k].word.toLowerCase()}`).join(' · ');
    return `${shown.join('\n')}\n${key}. Press for more.`;
  }

  function paint(list) {
    const el = typeof document !== 'undefined' && document.getElementById('busy');
    if (el) {
      const [a, b] = kindsOf(list);
      // "out": put away, with the ✓ still drawn while it fades.
      const state = phase === 'spin' ? 'spin' : phase === 'tick' ? 'tick' : 'out';
      const n = list.length > 1 ? String(Math.min(list.length, 99)) : '';
      const title = state === 'spin' ? titleOf(list) : '';
      const sig = [state, a, b, n, title].join('|');
      if (sig !== painted) {
        const badge = el.querySelector('.busy-n');
        const before = badge ? Number(badge.textContent || 0) : 0;
        painted = sig;
        el.dataset.state = state;
        if (state === 'spin') { el.dataset.kind = a; el.dataset.kind2 = b; }
        if (badge) {
          badge.textContent = n;
          // One fewer: the badge gives a little hop, so a job ending is seen.
          if (n && Number(n) < before) { badge.classList.remove('hop'); void badge.offsetWidth; badge.classList.add('hop'); }
        }
        if (state === 'spin') {
          el.title = title;
          const said = lines(list).map(l => l.label).slice(0, 2).join('; ');
          el.setAttribute('aria-label', `Busy — ${said}${/[.…]$/.test(said) ? '' : '.'} Press for what is happening.`);
        } else if (state === 'tick') {
          el.title = 'Done';
          el.setAttribute('aria-label', 'Done');
        } else {
          el.removeAttribute('title');
          el.setAttribute('aria-label', 'Nothing is happening');
        }
      }
    }
    if (popOpen) paintPop(list);
  }

  // ── The card: what is happening, and what the colours mean ─────────────────

  function popHtml(list) {
    const ls = lines(list);
    const dot = k => `<span class="busy-dot" data-kind="${k}" aria-hidden="true"></span>`;
    const nowHtml = ls.length
      ? `<ul class="busy-pop-now">${ls.slice(0, 8).map(l => `<li>${dot(l.kind)}<span>${esc(l.label)}${
          l.n > 1 ? ` <span class="txt-muted">(×${l.n})</span>` : ''}</span></li>`).join('')}${
          ls.length > 8 ? `<li class="txt-muted">…and ${ls.length - 8} more</li>` : ''}</ul>`
      : '<p class="busy-pop-idle">✓ Nothing right now — it’s all done.</p>';
    const keyHtml = Object.keys(KEY).map(k => `<li>${dot(k)}<span><strong>${COLOUR[k]} — ${esc(KEY[k].word)}.</strong> ${esc(KEY[k].meaning)}</span></li>`).join('');
    return `<div class="busy-pop-head"><strong id="busy-pop-h">What’s happening</strong>
        <button type="button" class="busy-pop-x" onclick="Busy.close()" aria-label="Close" title="Close">×</button></div>
      <div class="busy-pop-live">${nowHtml}</div>
      <p class="busy-pop-sub">What the wheel means</p>
      <ul class="busy-pop-key">${keyHtml}
        <li><span class="busy-dot busy-dot-tick" aria-hidden="true">✓</span><span><strong>Done.</strong> It closes into a tick and goes. It only comes up for something that takes longer than a tenth of a second.</span></li></ul>`;
  }

  let popSig = '';
  function paintPop(list) {
    const pop = document.getElementById('busy-pop');
    if (!pop) return;
    const live = pop.querySelector('.busy-pop-live');
    const html = popHtml(list);
    if (!live || html === popSig) return;
    popSig = html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    live.innerHTML = tmp.querySelector('.busy-pop-live').innerHTML;
  }

  function place(pop) {
    const header = document.querySelector('header');
    const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    pop.style.top = `${Math.round(top + 6)}px`;
  }

  function explain() {
    if (popOpen) { close(); return; }
    const pop = document.createElement('div');
    pop.id = 'busy-pop';
    pop.className = 'busy-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'busy-pop-h');
    const list = all();
    popSig = popHtml(list);
    pop.innerHTML = popSig;
    document.body.appendChild(pop);
    place(pop);
    popOpen = true;
    const btn = document.getElementById('busy');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    const x = pop.querySelector('.busy-pop-x');
    if (x) x.focus();
  }

  function close() {
    const pop = document.getElementById('busy-pop');
    const hadFocus = pop && pop.contains(document.activeElement);
    if (pop) pop.remove();
    popOpen = false;
    popSig = '';
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    const btn = document.getElementById('busy');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (hadFocus && phase !== 'idle') btn.focus();
    }
  }

  function onAway(e) {
    if (e.target && e.target.closest && e.target.closest('#busy-pop, #busy')) return;
    close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  function onResize() {
    const pop = document.getElementById('busy-pop');
    if (pop) place(pop);
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  function start() {
    if (started) return;
    started = true;
    wrapFetch();
    if (typeof MutationObserver !== 'undefined' && document.body) {
      new MutationObserver(queueScan).observe(document.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['aria-busy', 'role', 'hidden', 'open'],
      });
    }
    queueScan();
  }

  return {
    start, begin, run, explain, close, KEY,
    jobs: () => all().map(j => ({ kind: j.kind, label: j.label })),
  };
})();

if (typeof window !== 'undefined') window.Busy = Busy;
