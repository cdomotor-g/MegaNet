// MegaNet — tooltips.js
//
// Tooltips — the app's own drawing of the tooltips its markup asks for: an
// element's title attribute, and an SVG shape's <title>. Left to the browser,
// those come up just under the pointer, where the pointer itself covers their
// first words — the hand over a button covers more, and an enlarged pointer
// set in the operating system more again — and nothing a page does can move
// the browser's box. So on a mouse or a pen, the words come up here instead:
// centred above the pointer, following it, and kept off the window's edges.
// With no room above (the top of the window), under it, far enough down to
// clear the pointer.
//
// The browser's own is kept from showing by holding the title while the
// pointer is on it: the attribute is made "" — the platform's own "no tooltip
// here", which also stops the browser looking further out for an ancestor's —
// and an SVG <title> is emptied. Both are put back the moment the pointer
// leaves. Held as "" rather than taken away so that what the element's own
// code does meanwhile can be told from what this file did: a new title is
// followed (the tip says it), a title taken away is followed too (the tip
// goes, and nothing is put back). A screen reader following the pointer still
// finds the words: the element is described by the tip while it is held, or
// named by it when the title was all that named it.
//
// When, as the browser does it: half a second's rest brings the first; within
// half a second of one going, the next comes at once; pressing, typing or
// dragging puts it away until the pointer is on something else. A finger
// never sees any of this — it does not hover — and focus shows nothing, as
// before.
//
// Under test automation (navigator.webdriver) it stands down unless a check
// asks for it with localStorage mn-tips = 'on', as pwa.js does with mn-sw: a
// hundred checks read titles, and one whose pointer happened to rest on the
// element would read "". mn-tips = 'off' on any device leaves tooltips to the
// browser.
//
// Nothing runs at load; init.js calls start().
//
// Exposes: start.
// Requires: nothing.

const Tooltips = (() => {
  const DELAY = 500;   // ms of rest before the first tip
  const WARM  = 500;   // ms after one goes in which the next comes at once
  const GAP   = 10;    // px from the pointer's point up to the tip
  const UNDER = 30;    // px from the point down, when there is no room above
  const EDGE  = 6;     // px kept from the window's sides
  const TIP_ID = 'mn-tip';

  let started = false;
  let box = null;      // the one tip, made on first use
  let cur = null;      // what the pointer is on: { el, node, text, label, described }
  let pressed = false; // pressed, typed or dragged on since: no tip until the pointer moves on
  let shown = false, timer = 0, raf = 0, watch = 0, warmTill = 0;
  let px = 0, py = 0, lastTarget = null;

  function wanted() {
    let flag = null;
    try { flag = localStorage.getItem('mn-tips'); } catch (_) {}
    if (flag === 'off') return false;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return flag === 'on';
    return true;
  }

  const titleChild = n => { for (const c of n.children) if (c.localName === 'title') return c; return null; };

  // What the browser would show for a pointer on `node`: the nearest element,
  // from it outward, with a title — an HTML element's attribute, an SVG
  // element's <title> child. The first found decides, an empty one meaning
  // none. The one held here, its title emptied, is still itself.
  function sourceOf(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      if (cur && n === cur.el) return cur;
      if (n instanceof SVGElement) {
        const t = titleChild(n);
        if (!t) continue;
        return t.textContent.trim() ? { el: n, node: t, text: t.textContent } : null;
      }
      if (n.hasAttribute('title')) {
        const text = n.getAttribute('title');
        return text.trim() ? { el: n, node: null, text } : null;
      }
    }
    return null;
  }

  function hold(s) {
    tipBox().textContent = s.text.trim();
    if (s.node) { s.node.textContent = ''; return; }
    const el = s.el;
    el.setAttribute('title', '');
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.hasAttribute('alt')
        && !(el.labels && el.labels.length) && !el.textContent.trim()) {
      el.setAttribute('aria-label', s.text);
      s.label = true;
    } else {
      s.described = el.getAttribute('aria-describedby');
      el.setAttribute('aria-describedby', s.described ? `${s.described} ${TIP_ID}` : TIP_ID);
    }
  }

  // Everything back as it was — the title only where it is still the "" this
  // file left, so one its own code set or took away meanwhile stands.
  function release(s) {
    if (s.node) { if (s.node.textContent === '') s.node.textContent = s.text; return; }
    const el = s.el;
    if (el.getAttribute('title') === '') el.setAttribute('title', s.text);
    if (s.label) {
      if (el.getAttribute('aria-label') === s.text) el.removeAttribute('aria-label');
    } else if (el.getAttribute('aria-describedby') === (s.described ? `${s.described} ${TIP_ID}` : TIP_ID)) {
      if (s.described == null) el.removeAttribute('aria-describedby');
      else el.setAttribute('aria-describedby', s.described);
    }
  }

  // What the element's own code did while it was held. Gone from the page:
  // put back, so a map pin taken off and added again still has its title. A
  // new title: the tip says it, and it is held in turn. Taken away: the tip
  // goes.
  function follow() {
    if (!cur) return;
    if (!cur.el.isConnected) { leave(); return; }
    const now = cur.node ? (cur.node.isConnected ? cur.node.textContent : null) : cur.el.getAttribute('title');
    if (now === '') return;
    if (now == null || !now.trim()) { leave(); return; }
    cur.text = now;
    if (cur.label) cur.el.setAttribute('aria-label', now);
    if (cur.node) cur.node.textContent = ''; else cur.el.setAttribute('title', '');
    tipBox().textContent = now.trim();
    if (shown) place();
  }

  function tipBox() {
    if (box) return box;
    box = document.createElement('div');
    box.id = TIP_ID;
    box.className = 'mn-tip';
    box.setAttribute('role', 'tooltip');
    // In the top layer where the browser has one, so a tip is over a
    // full-screen camera too; elsewhere over everything by its z-index.
    if (typeof box.showPopover === 'function') box.setAttribute('popover', 'manual');
    else box.hidden = true;
    document.body.appendChild(box);
    return box;
  }

  function show() {
    timer = 0;
    if (!cur || pressed) return;
    const b = tipBox();
    b.textContent = cur.text.trim();
    if (!shown) {
      shown = true;
      if (b.hasAttribute('popover')) { try { b.showPopover(); } catch (_) {} } else b.hidden = false;
    }
    place();
  }

  function place() {
    raf = 0;
    if (!shown || !box) return;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = box.offsetWidth, h = box.offsetHeight;
    const x = Math.max(EDGE, Math.min(vw - w - EDGE, px - w / 2));
    let y = py - GAP - h;
    if (y < EDGE) y = Math.max(EDGE, Math.min(vh - h - EDGE, py + UNDER));
    box.style.left = `${Math.round(x)}px`;
    box.style.top = `${Math.round(y)}px`;
  }

  function hide(warm) {
    clearTimeout(timer);
    timer = 0;
    if (!shown) return;
    shown = false;
    if (warm) warmTill = Date.now() + WARM;
    if (box.hasAttribute('popover')) { try { box.hidePopover(); } catch (_) {} } else box.hidden = true;
  }

  function leave() {
    clearInterval(watch);
    watch = 0;
    if (cur) { release(cur); cur = null; }
    pressed = false;
    hide(true);
  }

  // Pressed, typed on or dragged: the tip goes and stays gone while the
  // pointer is on the same thing — still held, so the browser's does not come
  // up in its place.
  function quiet() {
    if (!cur) return;
    pressed = true;
    hide(false);
  }

  function at(target) {
    lastTarget = target;
    const s = sourceOf(target);
    if (s === cur) return;
    leave();
    if (!s) return;
    cur = s;
    hold(s);
    watch = setInterval(follow, 250);
    if (Date.now() < warmTill) show();
    else timer = setTimeout(show, DELAY);
  }

  const hovers = e => e.pointerType === 'mouse' || e.pointerType === 'pen';

  function over(e) {
    if (!hovers(e)) return;
    px = e.clientX;
    py = e.clientY;
    if (!e.buttons) at(e.target);
  }

  function move(e) {
    if (!hovers(e)) return;
    px = e.clientX;
    py = e.clientY;
    if (e.buttons) { quiet(); return; }
    // A target that changed with no pointerover — the page redrawn under a
    // still pointer, or scrolled under it — is caught here, and so is a title
    // given to the element after the pointer arrived.
    if (e.target !== lastTarget || !cur) at(e.target); else follow();
    if (shown && !raf) raf = requestAnimationFrame(place);
  }

  function out(e) {
    if (!e.relatedTarget) { leave(); lastTarget = null; }
  }

  // Scrolled by a person, or the box it is in scrolled away from under it —
  // never a log somewhere else on the page scrolling itself.
  function scrolled(e) {
    if (!cur) return;
    const t = e.target;
    if (e.type === 'wheel' || t === document || (t.contains && t.contains(cur.el))) { leave(); lastTarget = null; }
  }

  function start() {
    if (started || typeof document === 'undefined' || !wanted()) return;
    started = true;
    // Capturing, so a handler that stops an event on its way (Leaflet's
    // controls stop several) cannot keep it from here.
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerdown', e => { if (hovers(e)) quiet(); }, true);
    document.addEventListener('keydown', quiet, true);
    document.addEventListener('wheel', scrolled, { capture: true, passive: true });
    document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); });
    window.addEventListener('blur', () => { leave(); lastTarget = null; });
  }

  return { start };
})();
