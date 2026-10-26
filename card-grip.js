// MegaNet — card-grip.js
//
// CardGrip — a handle on the bottom edge of every list and table a card caps
// the height of, so the card can be made taller (or shorter) by dragging it.
//
// A card caps a long table or list at a share of the window — the shared
// `.table-wrap.tall` and `.medium` (styles.css, pattern 1), and the lists that
// cap themselves the same way — so that three thousand rows scroll inside the
// card rather than pushing the rest of the page off the screen. That is the
// right default and the wrong ceiling: somebody reading down the station list
// on a big screen is looking at a dozen rows through a slot with the window
// empty beneath it. The handle is the way out, one card at a time.
//
//   drag            the bottom edge, with a mouse, a pen or a finger; it stops
//                   where the rows run out
//   double-click    fills the window (85 % of its height) — or, once moved,
//                   puts it back to the card's own height
//   keyboard        the ARIA window-splitter pattern on a focusable separator:
//                   ↓/↑ a step, PageDown/PageUp a big one, End fills the
//                   window and Home puts it back; Enter is the double-click
//
// The handle shows only while there is more than the card shows — a table
// that fits needs no handle — or once it has been moved, so it can be put
// back. The height is remembered on this device (localStorage mn-grip-h), per
// card, and put back whenever the tab draws that card again: most tabs redraw
// their tables whenever the data changes, and a height that reverted on every
// redraw would be no use at all.
//
// The handle is a sibling after the scroller, not a child of it: what is in
// the scroller belongs to the module that draws it (logs that trim their first
// line, lists whose last row is styled as the last), and a handle in there
// would be one more row to all of them. It takes no room — its negative
// margins add up to its height — so a card looks exactly as it did until the
// pointer finds the edge. Only where something after the scroller goes under
// it: not beside it in a flex row or a grid, and not on anything placed over a
// map or the page, which is already as tall as what it floats over allows.
// `data-no-grip` on a scroller, or on anything around it, keeps one off.
//
// Nothing runs at load; init.js calls start().
//
// Exposes: start, reset.
// Requires: core.js (state) at call time.

const CardGrip = (() => {
  // What gets a handle. The pickers under a search box (.insp-hits and their
  // kind) do not: they are a choice made and gone, capped at twenty-five hits
  // in the markup. Nor do the full-screen table (.ad-table-full, sized to its
  // dialog) or the Message Log's payload (beside its label in a flex row).
  const SCROLLERS = [
    '.table-wrap.tall',     // the shared capped table, on most tabs
    '.table-wrap.medium',
    '.sspk-table-wrap',     // a sensor's readings, under its sparkline
    '.checklist',           // Export's networks
    '.filter-list',         // a Stations filter's options
    '.ef-carried',          // the stations inside a repeater's pass ranges
    '.maps-file-list',      // Radio Path Maps' sheets
    '.mg-file-list',        // Map Generator's files
    '.bs-log',              // a base station's log
    '.diag-pre',            // a bug report's diagnostics
    '.lc-raw pre',          // what the level camera's reader saw
  ].join(',');

  const MIN = 72;           // px: a header and a row or two — any less is a slot
  const STEP = 40;          // px an arrow key moves it
  const PAGE_STEP = 200;    // px PageDown and PageUp move it
  const FILL = 0.85;        // of the window's height, for End and double-click
  const STORE = 'mn-grip-h';

  let started = false;
  let sizes = null;         // { key: px }, read once
  let ro = null;
  const gripOf = new WeakMap();   // scroller → its handle
  const ownerOf = new WeakMap();  // handle → its scroller
  const keyOf = new WeakMap();    // scroller → the key its height is kept under
  const ownCap = new WeakMap();   // scroller → the inline max-height its module gave it, if any
  const moved = new WeakSet();    // scrollers whose height somebody has set

  // ── Remembering ───────────────────────────────────────────────────────────

  function stored() {
    if (!sizes) {
      try { sizes = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { sizes = null; }
      if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) sizes = {};
    }
    return sizes;
  }

  function remember(el, px) {
    const key = keyOf.get(el);
    if (!key) return;
    const s = stored();
    if (px == null) delete s[key]; else s[key] = px;
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) {}
  }

  // Which card this is, the same each time its tab draws it: the tab, then
  // the scroller's id, or the heading that names it, or — for one with
  // neither — where it falls among the capped scrollers inside the nearest
  // thing that has an id.
  function cardKey(el) {
    const tab = (typeof state !== 'undefined' && state && state.activeTab) || '';
    if (el.id) return `${tab}#${el.id}`;
    const by = el.getAttribute('aria-labelledby');
    if (by) return `${tab}@${by}`;
    const host = el.parentElement && el.parentElement.closest('[id]');
    const n = host ? [...host.querySelectorAll(SCROLLERS)].indexOf(el) : -1;
    return `${tab}>${host ? host.id : ''}:${n}`;
  }

  // What the scroller is called, for the handle's own name.
  function nameOf(el) {
    let name = el.getAttribute('aria-label') || '';
    const by = el.getAttribute('aria-labelledby');
    if (!name && by) {
      name = by.split(/\s+/).map(id => {
        const h = document.getElementById(id);
        return h ? h.textContent : '';
      }).join(' ');
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (name.length > 80) name = name.slice(0, 79) + '…';
    return name;
  }

  // ── Placing a handle ──────────────────────────────────────────────────────

  // Whether a handle can go under `el`, and the gap it has to take back if
  // the column it is in spaces its children apart. Null where it cannot.
  function placement(el) {
    const p = el.parentElement;
    if (!p || el.closest('[data-no-grip]')) return null;
    const pos = getComputedStyle(el).position;
    if (pos === 'absolute' || pos === 'fixed') return null;
    const ps = getComputedStyle(p);
    if (/grid/.test(ps.display)) return null;
    if (/flex/.test(ps.display)) {
      if (!/column/.test(ps.flexDirection)) return null;
      return { gap: parseFloat(ps.rowGap) || 0 };
    }
    return { gap: 0 };
  }

  function attach(el) {
    if (!el.isConnected) return;
    const had = gripOf.get(el);
    if (had) {
      // Moved, or something was put between: it goes back under its scroller.
      if (el.nextElementSibling !== had) el.after(had);
      return;
    }
    const place = placement(el);
    if (!place) return;
    const grip = document.createElement('div');
    grip.className = 'mn-grip';
    grip.hidden = true;
    grip.tabIndex = 0;
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'horizontal');
    const name = nameOf(el);
    grip.setAttribute('aria-label', name ? `Height of ${name}` : 'Height of the list above');
    if (el.id) grip.setAttribute('aria-controls', el.id);
    grip.title = 'Drag to make it taller or shorter — double-click to fill the window, or to put it back';
    if (place.gap) grip.style.setProperty('--grip-gap', `${place.gap}px`);
    grip.addEventListener('pointerdown', dragStart);
    grip.addEventListener('keydown', onKey);
    grip.addEventListener('dblclick', toggle);
    gripOf.set(el, grip);
    ownerOf.set(grip, el);
    keyOf.set(el, cardKey(el));
    ownCap.set(el, el.style.maxHeight);
    const px = stored()[keyOf.get(el)];
    if (Number.isFinite(px) && px > 0) {
      el.style.maxHeight = `${Math.max(MIN, px)}px`;
      moved.add(el);
    }
    el.after(grip);
    ro.observe(el);    // and the first notification shows or hides it
  }

  // Show the handle while there is more than shows, or once it has been moved;
  // and keep its value in step with the height.
  function sync(el) {
    const grip = gripOf.get(el);
    if (!grip) return;
    if (el.nextElementSibling !== grip) el.after(grip);
    const over = el.scrollHeight > el.clientHeight + 1;
    const showing = el.getClientRects().length > 0 && (over || moved.has(el));
    if (grip.hidden === showing) grip.hidden = !showing;
    if (!showing) return;
    const h = Math.round(el.getBoundingClientRect().height);
    grip.setAttribute('aria-valuemin', String(MIN));
    grip.setAttribute('aria-valuemax', String(Math.max(h, fit(el))));
    grip.setAttribute('aria-valuenow', String(h));
    grip.setAttribute('aria-valuetext', over ? `${h} pixels tall` : `${h} pixels tall, all of it showing`);
  }

  function onResize(entries) {
    for (const { target: el } of entries) {
      if (el.isConnected) { sync(el); continue; }
      ro.unobserve(el);
      const grip = gripOf.get(el);
      if (grip && grip.isConnected) grip.remove();
    }
  }

  // New scrollers, wherever a tab draws them; and a handle whose scroller was
  // taken away on its own, which goes with it.
  function onMutations(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.classList.contains('mn-grip')) continue;
        if (n.matches(SCROLLERS)) attach(n);
        if (n.firstElementChild) n.querySelectorAll(SCROLLERS).forEach(attach);
      }
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1 || n.isConnected) continue;
        const grip = gripOf.get(n);
        if (grip && grip.isConnected) grip.remove();
      }
    }
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  // Tall enough to show every row: the content, and the border and any
  // sideways scroll bar around it (box-sizing is border-box everywhere).
  function fit(el) {
    return el.scrollHeight + (el.offsetHeight - el.clientHeight);
  }

  // The new cap, from MIN up to where the rows run out. Stored when `persist`
  // — on release and on each key press, not on every frame of a drag.
  function setHeight(el, px, persist) {
    const h = Math.round(Math.max(MIN, Math.min(px, Math.max(fit(el), MIN))));
    el.style.maxHeight = `${h}px`;
    moved.add(el);
    if (persist) remember(el, h);
    sync(el);
  }

  function fill(el) {
    setHeight(el, Math.round(window.innerHeight * FILL), true);
  }

  // Back to the height the card gives it.
  function reset(el) {
    if (!el || !keyOf.has(el)) return;
    el.style.maxHeight = ownCap.get(el) || '';
    moved.delete(el);
    remember(el, null);
    sync(el);
  }

  function toggle(e) {
    const el = ownerOf.get(e.currentTarget);
    if (!el) return;
    if (moved.has(el)) reset(el); else fill(el);
  }

  function dragStart(e) {
    if (e.button != null && e.button !== 0) return;
    const grip = e.currentTarget;
    const el = ownerOf.get(grip);
    if (!el || !el.isConnected) return;
    e.preventDefault();                       // no text selection while dragging
    // Captured, so the drag survives the pointer leaving a handle a few pixels
    // tall — which it does at once.
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    const y0 = e.clientY;
    const h0 = el.getBoundingClientRect().height;
    let done = false, dragged = false;
    grip.classList.add('is-dragging');
    document.body.classList.add('mn-grip-dragging');
    // A finger that lands and lifts again wobbles a pixel or two; that is a
    // tap, not a height.
    const move = ev => {
      if (!dragged && Math.abs(ev.clientY - y0) < 3) return;
      dragged = true;
      setHeight(el, h0 + ev.clientY - y0, false);
    };
    const end = () => {
      if (done) return;
      done = true;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.removeEventListener('lostpointercapture', end);
      grip.classList.remove('is-dragging');
      document.body.classList.remove('mn-grip-dragging');
      if (dragged) remember(el, Math.round(parseFloat(el.style.maxHeight)));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
  }

  function onKey(e) {
    const el = ownerOf.get(e.currentTarget);
    if (!el) return;
    const step = { ArrowDown: STEP, ArrowUp: -STEP, PageDown: PAGE_STEP, PageUp: -PAGE_STEP }[e.key];
    if (step) setHeight(el, el.getBoundingClientRect().height + step, true);
    else if (e.key === 'End') fill(el);
    else if (e.key === 'Home') reset(el);
    else if (e.key === 'Enter') toggle(e);
    else return;
    e.preventDefault();
  }

  function start() {
    if (started || typeof MutationObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
    started = true;
    ro = new ResizeObserver(onResize);
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll(SCROLLERS).forEach(attach);
  }

  return { start, reset };
})();
