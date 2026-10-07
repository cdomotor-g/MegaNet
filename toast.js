// MegaNet — toast.js
//
//   Toast   a line at the foot of the window saying how something went — done,
//           or failed and why — in place of the browser's alert() (#223).
//
// After core.js (announce, esc), before init.js; nothing runs at load, so its
// place among the modules is free. index.html holds the order and the reasons.
//
// What it is for, and what it is not. A toast is the outcome of something
// somebody just did, said where they will see it without being stopped by it:
// "Could not load from GitHub — HTTP 404", "Name the investigation first." It
// is not for a question (confirmDialog, modal.js), and not for a state the page
// is in — a browser that cannot open a serial port says so on the tab, for as
// long as it is true, not once in a corner.
//
// What a screen reader hears goes through announce() (core.js), the app's one
// live region, so a toast is said exactly once and by the same rules as every
// other result — the box itself is not a second live region. A toast that says
// something worked goes after a few seconds (longer while the pointer or focus
// is on it); one that says something failed stays until it is dismissed — it is
// the one somebody may need to read twice, or copy into a bug report. Three at
// most: a fourth pushes the oldest out.
//
// Exposes: Toast.show(text, { kind, ms }), Toast.done(text), Toast.failed(text),
//          Toast.note(text), Toast.clear().
// Requires: core.js (announce, esc).

const Toast = (function () {
  const MAX = 3;
  const DONE_MS = 5000;
  const ICON = { done: '✓', failed: '⚠', note: 'ℹ' };
  let seq = 0;

  function host() {
    let el = document.getElementById('toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toasts';
      el.className = 'toasts';
      document.body.appendChild(el);
    }
    return el;
  }

  function dismiss(id) {
    const el = document.getElementById(id);
    if (!el) return;
    clearTimeout(el._t);
    el.remove();
  }

  // Timed toasts count down only while nobody is reading them.
  function arm(el, ms) {
    if (!ms) return;
    const start = () => { clearTimeout(el._t); el._t = setTimeout(() => dismiss(el.id), ms); };
    const stop = () => clearTimeout(el._t);
    el.addEventListener('pointerenter', stop);
    el.addEventListener('pointerleave', start);
    el.addEventListener('focusin', stop);
    el.addEventListener('focusout', start);
    start();
  }

  function show(text, { kind = 'note', ms } = {}) {
    const msg = String(text ?? '').trim();
    if (!msg) return null;
    if (!ICON[kind]) kind = 'note';
    const box = host();
    while (box.children.length >= MAX) { clearTimeout(box.firstElementChild._t); box.firstElementChild.remove(); }
    const id = `toast-${++seq}`;
    const el = document.createElement('div');
    el.id = id;
    el.className = `toast toast--${kind}`;
    el.dataset.kind = kind;
    el.innerHTML = `<span class="toast-icon" aria-hidden="true">${ICON[kind]}</span>
      <p class="toast-text">${esc(msg)}</p>
      <button type="button" class="toast-x" aria-label="Dismiss: ${esc(msg)}" title="Dismiss">×</button>`;
    el.querySelector('.toast-x').addEventListener('click', () => dismiss(id));
    box.appendChild(el);
    arm(el, ms === undefined ? (kind === 'failed' ? 0 : DONE_MS) : ms);
    announce(msg);
    return id;
  }

  function clear() {
    const box = document.getElementById('toasts');
    if (!box) return;
    [...box.children].forEach(el => clearTimeout(el._t));
    box.innerHTML = '';
  }

  return {
    show,
    done:   text => show(text, { kind: 'done' }),
    failed: text => show(text, { kind: 'failed' }),
    note:   text => show(text, { kind: 'note' }),
    dismiss,
    clear,
  };
})();
if (typeof window !== 'undefined') window.Toast = Toast;
