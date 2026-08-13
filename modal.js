// MegaNet — modal.js
//
//   Modal   the one dialog shell everything else borrows: a title, arbitrary
//           HTML, Esc or × to close, Tab kept inside it, and focus handed back
//           to whatever opened it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc and nowhere else. Nothing runs at load, so
// this file's position among the modules is free — including relative to the
// modules that open dialogs through it, since none of them do so before a click.
//
// The last line exposes it on window for parity with the other tab modules. It
// is not what makes the inline on*= handlers resolve: a top-level const lives in
// the global lexical environment, which name resolution consults before the
// global object.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129. The bug reporter keeps
// its own copy of this markup on purpose — bug-report.js says why.

// ── Modal shell ────────────────────────────────────────────────────────────────
// One dialog, borrowed by whoever needs one: a title, arbitrary HTML, Esc or ×
// to close, Tab kept inside it, and focus handed back to whatever opened it.
//
// The bug reporter has its own copy of this markup and keeps it. It is the one
// thing people reach for when the app is already misbehaving, so it does not
// get to depend on anything newer than itself.

const Modal = (function () {
  let lastFocus = null;

  const root = () => document.getElementById('app-modal');
  const isOpen = () => { const el = root(); return el && el.style.display !== 'none'; };

  function open({ title, html, wide }) {
    let el = root();
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-modal';
      el.className = 'modal-overlay';
      // Only the backdrop closes — a click that started inside the card and
      // drifted out (selecting text, say) is not a request to close it.
      el.onclick = ev => { if (ev.target === el) close(); };
      document.body.appendChild(el);
    }
    lastFocus = document.activeElement;
    el.innerHTML = `
      <div class="modal-card${wide ? ' modal-card--wide' : ''}" role="dialog" aria-modal="true"
           aria-labelledby="app-modal-title" tabindex="-1">
        <div class="modal-head">
          <h2 id="app-modal-title">${esc(title)}</h2>
          <button class="modal-x" title="Close (Esc)" aria-label="Close" onclick="Modal.close()">×</button>
        </div>
        <div class="modal-body">${html}</div>
      </div>`;
    el.style.display = 'flex';
    document.addEventListener('keydown', onKey, true);
    el.querySelector('.modal-card')?.focus();
  }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Tab cycles within the dialog. Without this it walks off into the page
    // behind, which for a keyboard user is a dialog with no walls.
    const items = [...root().querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey) { if (at <= 0) { e.preventDefault(); items[items.length - 1].focus(); } }
    else if (at < 0 || at === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }

  function close() {
    const el = root();
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  return { open, close };
})();
if (typeof window !== 'undefined') window.Modal = Modal;

