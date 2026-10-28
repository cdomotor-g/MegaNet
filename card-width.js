// MegaNet — card-width.js
//
// CardWidth — a handle on the edge of every card that floats over a map (the
// station card, What is here, and the ACMA transmitter card), so the card can
// be made wider or narrower by dragging it.
//
// The cards are a set width — 340 px for the station card and What is here,
// 370 for the ACMA card — and that is the right default and the wrong ceiling:
// at 340 the land, road and mobile sections put half their figures on a line
// of their own, and on a wide screen there is a map's worth of room beside
// the card. The handle is the way out, one card at a time.
//
//   drag            the edge facing the map, with a mouse, a pen or a finger
//   double-click    puts it back to the card's own width
//   keyboard        the ARIA window-splitter pattern on a focusable separator:
//                   ← → move the edge a step, PageUp / PageDown widen and
//                   narrow it a big one, Home the narrowest and End the
//                   widest; Enter is the double-click and Escape closes the
//                   card, as it does from inside it
//
// Which edge is the stylesheet's to say, beside the rule that anchors the
// card: --mn-card-grip is `right` on a card anchored at the left (the station
// card), `left` on one anchored at the right (the ACMA card), and `none` where
// the card's width is not its own (a phone, where the station card is a sheet
// across the map). The width is --mn-card-w, a custom property rather than a
// width so the phone's sheet can go on ignoring it. It runs from MIN to the
// card's own max-width — 82 % of what it floats over — and is remembered on
// this device (localStorage mn-card-w), per card, and put back whenever the
// card is drawn again.
//
// The handle cannot be inside the card. The card is its own scroller: a
// handle in it would scroll away with the rows, the half of it over the map
// would be clipped, and what it had left would be under the scrollbar — and
// every repaint replaces what is inside the card anyway. So it is the card's
// next sibling, laid over the card's edge from the card's own box, and kept
// there by a ResizeObserver on the card and on what the card floats over. It
// takes the card's z-index, so it is over what the card is over and under what
// the card is under; the 3-D view and the twin lift the station card over
// their canvases, and the handle is lifted with it the next time the pointer
// comes over the map.
//
// Nothing runs at load; init.js calls start().
//
// Exposes: start, reset.
// Requires: nothing.

const CardWidth = (() => {
  const CARDS = '.acma-card';
  const MIN = 280;          // px: a label and its figure still side by side
  const STEP = 20;          // px an arrow key moves the edge
  const PAGE_STEP = 100;    // px PageUp and PageDown move it
  const INSET = 3;          // px of the handle over the card: its border, and
                            // the gutter beside its scrollbar's thumb
  const STORE = 'mn-card-w';

  let started = false;
  let sizes = null;         // { card id: px }, read once
  let ro = null;
  let raf = 0;
  const cards = new Set();          // every card with a handle, for a window resize
  const gripOf = new WeakMap();     // card → its handle
  const ownerOf = new WeakMap();    // handle → its card
  const hooked = new WeakSet();     // what the cards float over, listened to

  // ── Remembering ───────────────────────────────────────────────────────────

  function stored() {
    if (!sizes) {
      try { sizes = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { sizes = null; }
      if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) sizes = {};
    }
    return sizes;
  }

  function remember(card, px) {
    if (!card.id) return;
    const s = stored();
    if (px == null) delete s[card.id]; else s[card.id] = px;
    try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) {}
  }

  // ── Measuring ─────────────────────────────────────────────────────────────

  // The edge the handle goes on, or null where the card has no width of its
  // own to give.
  function sideOf(card) {
    const v = getComputedStyle(card).getPropertyValue('--mn-card-grip').trim();
    return v === 'left' || v === 'right' ? v : null;
  }

  // From MIN to the card's own max-width, and never past what it floats over.
  // A fixed card (RF Changes, the Workbench) floats over the window.
  function range(card) {
    const cs = getComputedStyle(card);
    const box = cs.position === 'fixed' ? document.documentElement.clientWidth
      : card.offsetParent ? card.offsetParent.clientWidth : 0;
    let max = box - 16;
    const cap = parseFloat(cs.maxWidth);
    if (Number.isFinite(cap)) max = Math.min(max, cs.maxWidth.endsWith('%') ? box * cap / 100 : cap);
    return { min: MIN, max: Math.floor(max) };
  }

  // ── Placing a handle ──────────────────────────────────────────────────────

  function attach(card) {
    if (!card.isConnected) return;
    let grip = gripOf.get(card);
    if (!grip) {
      grip = document.createElement('div');
      grip.className = 'mn-cardw';
      grip.hidden = true;
      grip.tabIndex = 0;
      grip.setAttribute('role', 'separator');
      grip.setAttribute('aria-orientation', 'vertical');
      grip.setAttribute('aria-label', 'Card width');
      if (card.id) grip.setAttribute('aria-controls', card.id);
      grip.title = 'Drag to make the card wider or narrower — double-click to put it back';
      grip.addEventListener('pointerdown', dragStart);
      grip.addEventListener('keydown', onKey);
      grip.addEventListener('dblclick', onDouble);
      grip.addEventListener('focus', () => sync(card));
      gripOf.set(card, grip);
      ownerOf.set(grip, card);
      cards.add(card);
      const px = card.id ? stored()[card.id] : null;
      if (Number.isFinite(px) && px > 0) card.style.setProperty('--mn-card-w', `${Math.max(MIN, px)}px`);
      ro.observe(card);       // and the first notification places it
    }
    const host = card.parentElement;
    if (host && !hooked.has(host)) {
      hooked.add(host);
      ro.observe(host);
      // The 3-D view and the twin change the card's z-index with a class on
      // their canvas, which no observer here sees; the pointer coming over
      // the map is the moment the handle has to be at the right height.
      host.addEventListener('pointerover', later, { passive: true });
    }
    if (card.nextElementSibling !== grip) card.after(grip);
  }

  function drop(card) {
    const grip = gripOf.get(card);
    if (grip && grip.isConnected) grip.remove();
    ro.unobserve(card);
    cards.delete(card);
  }

  // Over the card's edge, at the card's height and z-index — or hidden, with
  // the card or where the card has no edge to give.
  function sync(card) {
    const grip = gripOf.get(card);
    if (!grip) return;
    if (!card.isConnected) { drop(card); return; }
    if (card.nextElementSibling !== grip) card.after(grip);
    const side = !card.hidden && card.getClientRects().length ? sideOf(card) : null;
    const r = side ? range(card) : null;
    const showing = !!side && r.max > r.min;
    if (grip.hidden === showing) grip.hidden = !showing;
    if (!showing) return;
    const cs = getComputedStyle(card);
    const fixed = cs.position === 'fixed';
    const box = fixed ? card.getBoundingClientRect()
      : { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
    grip.dataset.side = side;
    grip.dataset.fixed = fixed ? 'true' : 'false';
    grip.style.setProperty('--cw-z', cs.zIndex);
    grip.style.setProperty('--cw-top', `${box.top}px`);
    grip.style.setProperty('--cw-h', `${box.height}px`);
    grip.style.setProperty('--cw-left', `${side === 'right' ? box.left + box.width - INSET : box.left + INSET - grip.offsetWidth}px`);
    const w = Math.round(box.width);
    grip.setAttribute('aria-valuemin', String(r.min));
    grip.setAttribute('aria-valuemax', String(Math.max(r.max, w)));
    grip.setAttribute('aria-valuenow', String(w));
    grip.setAttribute('aria-valuetext', `${w} pixels wide`);
  }

  function syncAll() {
    raf = 0;
    for (const card of [...cards]) sync(card);
  }

  // Once a frame at most: a pointer crossing the map passes over a great many
  // things.
  function later() {
    if (!raf) raf = requestAnimationFrame(syncAll);
  }

  function onResize(entries) {
    for (const { target } of entries) {
      if (cards.has(target)) { sync(target); continue; }
      // What the cards float over changed size, and a card anchored at its
      // foot has moved with it.
      for (const card of [...cards]) if (card.parentElement === target) sync(card);
    }
  }

  // New cards, wherever a tab draws them — the Stations map redraws its three
  // with every full render; and a handle whose card was taken away on its own,
  // which goes with it.
  function onMutations(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.classList.contains('mn-cardw')) continue;
        if (n.matches(CARDS)) attach(n);
        if (n.firstElementChild) n.querySelectorAll(CARDS).forEach(attach);
      }
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1 || n.isConnected || !cards.has(n)) continue;
        drop(n);
      }
    }
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  // The new width, clamped. Stored when `persist` — on release and on each key
  // press, not on every frame of a drag.
  function setWidth(card, px, persist) {
    const r = range(card);
    const w = Math.round(Math.max(r.min, Math.min(r.max, px)));
    card.style.setProperty('--mn-card-w', `${w}px`);
    if (persist) remember(card, w);
    sync(card);
    return w;
  }

  // Back to the width the stylesheet gives it.
  function reset(card) {
    if (!card || !gripOf.has(card)) return;
    card.style.removeProperty('--mn-card-w');
    remember(card, null);
    sync(card);
  }

  function onDouble(e) {
    reset(ownerOf.get(e.currentTarget));
  }

  function dragStart(e) {
    if (e.button != null && e.button !== 0) return;
    const grip = e.currentTarget;
    const card = ownerOf.get(grip);
    if (!card || !card.isConnected) return;
    e.preventDefault();                       // no text selection while dragging
    // Captured, so the drag survives the pointer leaving a handle a dozen
    // pixels wide — which it does at once.
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    // The anchored edge stays where it is, so the width is the one it started
    // at plus however far the free edge has been pulled outwards.
    const out = grip.dataset.side === 'left' ? -1 : 1;
    const x0 = e.clientX;
    const w0 = card.getBoundingClientRect().width;
    let done = false, dragged = false;
    grip.classList.add('is-dragging');
    document.body.classList.add('mn-cardw-dragging');
    // A finger that lands and lifts again wobbles a pixel or two; that is a
    // tap, not a width.
    const move = ev => {
      if (!dragged && Math.abs(ev.clientX - x0) < 3) return;
      dragged = true;
      setWidth(card, w0 + (ev.clientX - x0) * out, false);
    };
    const end = () => {
      if (done) return;
      done = true;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.removeEventListener('lostpointercapture', end);
      grip.classList.remove('is-dragging');
      document.body.classList.remove('mn-cardw-dragging');
      if (dragged) remember(card, Math.round(card.getBoundingClientRect().width));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
  }

  function onKey(e) {
    const grip = e.currentTarget;
    const card = ownerOf.get(grip);
    if (!card) return;
    if (e.key === 'Escape') {
      // The card's own Escape, which closes it and puts focus back where the
      // card was opened from. A card that closed has had the key; one with no
      // Escape of its own lets it go on to the page, as it would from inside.
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (card.hidden) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); reset(card); return; }
    const out = grip.dataset.side === 'left' ? -1 : 1;
    const w = card.getBoundingClientRect().width;
    const step = { ArrowRight: STEP * out, ArrowLeft: -STEP * out, PageUp: PAGE_STEP, PageDown: -PAGE_STEP }[e.key];
    let next = null;
    if (step) next = w + step;
    else if (e.key === 'Home') next = MIN;
    else if (e.key === 'End') next = range(card).max;
    if (next == null) return;
    e.preventDefault();
    setWidth(card, next, true);
  }

  function start() {
    if (started || typeof MutationObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
    started = true;
    ro = new ResizeObserver(onResize);
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', later);
    document.querySelectorAll(CARDS).forEach(attach);
  }

  return { start, reset };
})();
