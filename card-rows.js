// MegaNet — card-rows.js
//
// CardRows — the station card's rows, one line each: the label in a column of
// its own, the answer beside it, and a long explanation folded away behind a
// tap on the row (›).
//
// ── Why ─────────────────────────────────────────────────────────────────────
// The owner could not tell the card's rows apart. Each answer was pushed to
// the right edge and its explanation ran on after it in the same paragraph,
// so a row that wrapped started every line somewhere different and ran into
// the label of the next. Of four mock-ups (5 November 2026) he picked "one
// line a row": the label in its own column, the answer and its short words
// (indicative, modelled, here) beside it, a line between rows, and the long
// explanation one tap away — with each section's heading on a shaded band
// the full width of the card. The Radio tab's Links, with their fade margin
// bars, stay as they are: they are not rows.
//
// ── How ─────────────────────────────────────────────────────────────────────
// The layout is the stylesheet's (#stn-card .acma-row). What this module adds
// is the fold, because which part of a row is its explanation is only known
// from the markup every section already writes: `.mn-pop-note`, the muted
// note after a value. A row's notes are folded when
//   - they are direct children of the row's value, at its end: nothing but
//     notes and white space after them, so the words keep their order;
//   - one of them runs past SHORT characters — "indicative", "mapped 2012",
//     "here" and "— council or TMR" stay on the line, as the answer's tags;
//   - and the value has something besides notes to show while the fold is
//     shut. A value that is only a note ("none within 150 m") is the answer.
// From the first long note to the end of the value is moved, not copied,
// into a <details> at the end of the value. Moved, so an element a module
// fills later by its id is still the same element; the row's text reads as
// it did (the summary holds no text — its › is drawn); and the card's search
// (station-card-view.js) opens a fold its word is in, as it opens every other
// fold on the card, and shuts it again when the box is cleared. A tap
// anywhere on the row opens or shuts it, except on a link or a button in it;
// from the keyboard the summary is the control, named for its row.
//
// The sections fill in after their fetches, each writing its own markup into
// its own element, so the card is watched — a MutationObserver on #stn-card,
// childList only — and every new row is seen to as it lands. repaintStnCard()
// also calls enhance() straight after it writes the card, before it puts
// focus back by position among the card's controls, so the summaries are
// counted the same both times. A fold somebody opened stays open when its
// section is drawn again: the open ones are remembered, by station and label,
// for the session.
//
// After core.js. app.js's repaintStnCard() calls watch() and enhance();
// nothing runs at load.

const CardRows = (() => {
  // A note this long or shorter stays on the line as a tag of the answer.
  const SHORT = 24;
  // `${station id}␁${label}` for every fold somebody opened, this session.
  const opened = new Set();
  const watched = new WeakSet();

  const flat = t => String(t || '').replace(/\s+/g, ' ').trim();
  const stationId = () => (typeof state !== 'undefined' && state.stnCard && state.stnCard.id) || '';
  const labelOf = row => flat(row.firstElementChild && row.firstElementChild.textContent);
  const keyOf = row => `${stationId()}\u0001${labelOf(row)}`;
  const isNote = n => n.nodeType === 1 && n.classList.contains('mn-pop-note');
  const isBlank = n => n.nodeType === 3 && !n.nodeValue.trim();

  // The first node to fold in a row's value, or null: the first long note
  // among the notes it ends with, when something other than notes is before
  // them.
  function foldFrom(val) {
    const kids = [...val.childNodes];
    let i = kids.length - 1;
    const tail = [];
    for (; i >= 0; i--) {
      if (isBlank(kids[i])) continue;
      if (isNote(kids[i])) { tail.unshift(kids[i]); continue; }
      break;
    }
    if (i < 0 || !tail.length) return null;
    return tail.find(n => flat(n.textContent).length > SHORT) || null;
  }

  function enhanceRow(row) {
    row.dataset.cr = '';
    const val = row.lastElementChild;
    if (!val || val === row.firstElementChild) return;
    const from = foldFrom(val);
    if (!from) return;
    const d = document.createElement('details');
    d.className = 'cr-more';
    const s = document.createElement('summary');
    s.setAttribute('aria-label', `What ${labelOf(row) || 'this'} means here`);
    d.append(s);
    val.insertBefore(d, from);
    for (let n = d.nextSibling; n; n = d.nextSibling) d.append(n);
    row.classList.add('cr-fold');
    if (opened.has(keyOf(row))) d.open = true;
    // Remembered only when a person opened it: a fold the search opened
    // (station-card-view.js marks it) is the search's to shut.
    d.addEventListener('toggle', () => {
      const k = keyOf(row);
      if (d.open && !d.dataset.cvOpened) opened.add(k);
      else if (!d.open) opened.delete(k);
    });
  }

  // Every row in it not yet seen to.
  function enhance(root) {
    if (!root) return;
    for (const row of root.querySelectorAll('.acma-row:not([data-cr])')) enhanceRow(row);
  }

  // A tap on a row with a fold opens or shuts it — not on a link, a button or
  // a box in it, not inside the open explanation, and not at the end of a
  // drag that selected some of its words.
  function onClick(e) {
    const row = e.target.closest('.acma-row.cr-fold');
    if (!row || !e.currentTarget.contains(row)) return;
    if (e.target.closest('summary, a, button, input, select, textarea, label, [onclick], .cr-more')) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;
    const d = row.lastElementChild && row.lastElementChild.querySelector(':scope > details.cr-more');
    if (d) d.open = !d.open;
  }

  // Once per card element: the taps, and the rows the sections fill in later.
  function watch(el) {
    if (!el || watched.has(el)) return;
    watched.add(el);
    el.addEventListener('click', onClick);
    new MutationObserver(muts => {
      if (muts.some(m => m.addedNodes.length)) enhance(el);
    }).observe(el, { childList: true, subtree: true });
  }

  return { watch, enhance, SHORT };
})();
