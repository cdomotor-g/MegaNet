// MegaNet — modal.js
//
//   Modal          the one dialog shell everything else borrows: a title,
//                  arbitrary HTML, Esc or × to close, Tab kept inside it, and
//                  focus handed back to whatever opened it.
//   confirmDialog  a question with two answers, in place of the browser's
//                  confirm(): the button that acts is named for what it does,
//                  and the answer is a Promise (#223).
//   promptDialog   a question with a line of text for an answer, in place of
//                  prompt() (#223).
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
//
// `onClose`, when given, is told once that the dialog has gone — by Esc, ×, the
// backdrop, Modal.close() or another dialog opened in its place — after focus
// has been handed back.
//
// Questions (#223) are asked one layer up, in a shell of their own (#app-ask,
// over the photo viewer as well as this): a confirmation is usually asked from
// inside something — a photo in the viewer, a table in this shell — and asking
// must not tear down what it was asked from. One question at a time; a second
// asked over the first answers the first "no".

const Modal = (function () {
  let lastFocus = null;
  let onClosed = null;

  const root = () => document.getElementById('app-modal');
  const isOpen = () => { const el = root(); return el && el.style.display !== 'none'; };

  // Tells whoever opened the dialog that it has gone, once.
  function settle() {
    const fn = onClosed;
    onClosed = null;
    if (fn) { try { fn(); } catch (err) { console.error(err); } }
  }

  function open({ title, html, wide, onClose }) {
    // Asked before the shell is made: a shell made just now has no inline
    // display yet, which isOpen() would read as open.
    const replacing = isOpen();
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
    // One dialog put in place of another is the first one closed, as far as
    // whoever opened it is concerned — but focus still goes back, in the end,
    // to what opened the first, not to a button inside it that is about to go.
    if (replacing) settle();
    else lastFocus = document.activeElement;
    onClosed = onClose || null;
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

  // The Tab walls, for either shell: Tab cycles within the dialog. Without
  // this it walks off into the page behind, which for a keyboard user is a
  // dialog with no walls.
  function trapTab(e, card) {
    const items = [...card.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (e.shiftKey) { if (at <= 0) { e.preventDefault(); items[items.length - 1].focus(); } }
    else if (at < 0 || at === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }

  function onKey(e) {
    if (!isOpen() || asked) return;      // a question over it has the keys
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    trapTab(e, root());
  }

  function close() {
    if (asked) askClose();               // a question about a dialog goes with it
    const el = root();
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
    settle();
  }

  // ── Asking (#223) ────────────────────────────────────────────────────────────
  // The shell confirmDialog and promptDialog draw in. `wire(card, answer)` hooks
  // the question's own controls up — answer(value) closes it with that value;
  // `focus` is the selector of what holds focus first. `done(value)` is told
  // once, after focus has gone back: the value answered, or undefined for Esc,
  // ×, the backdrop, or another question asked over this one.
  //
  // The keys are taken on the window, in the capture phase — ahead of every
  // listener on the document, the photo viewer's Escape and arrows among them —
  // and none go further while a question is up: an Escape meant for it must
  // not close the viewer underneath as well, and an arrow must not walk the
  // photos behind it. Stopping propagation leaves a key's default alone, so
  // typing, Enter on a button and Tab still do what they do.
  const ASK_ID = 'app-ask';
  let asked = null;                      // { lastFocus, done } while one is up

  function askOpen({ title, html, role = 'alertdialog', describedBy = null, focus = null, wire = null, done = null }) {
    let el = document.getElementById(ASK_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ASK_ID;
      el.className = 'modal-overlay modal-overlay--ask';
      el.onclick = ev => { if (ev.target === el) askClose(); };
      document.body.appendChild(el);
    }
    let back = document.activeElement;
    if (asked) { back = asked.lastFocus; askSettle(undefined); }
    asked = { lastFocus: back, done, value: undefined };
    el.innerHTML = `
      <div class="modal-card modal-card--ask" role="${role}" aria-modal="true"
           aria-labelledby="app-ask-title"${describedBy ? ` aria-describedby="${describedBy}"` : ''} tabindex="-1">
        <div class="modal-head">
          <h2 id="app-ask-title">${esc(title)}</h2>
          <button class="modal-x" type="button" title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div class="modal-body">${html}</div>
      </div>`;
    const card = el.querySelector('.modal-card');
    card.querySelector('.modal-x').addEventListener('click', () => askClose());
    if (wire) wire(card, value => askClose(value));
    el.style.display = 'flex';
    window.addEventListener('keydown', askKey, true);
    (focus && card.querySelector(focus) || card).focus();
  }

  function askKey(e) {
    const el = document.getElementById(ASK_ID);
    if (!asked || !el) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); askClose(); return; }
    if (e.key === 'Tab') trapTab(e, el);
  }

  function askSettle(value) {
    const a = asked;
    asked = null;
    if (a && a.done) { try { a.done(value); } catch (err) { console.error(err); } }
  }

  function askClose(value) {
    if (!asked) return;
    const el = document.getElementById(ASK_ID);
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    window.removeEventListener('keydown', askKey, true);
    const back = asked.lastFocus;
    if (back && back.focus && document.contains(back)) back.focus();
    askSettle(value);
  }

  const asking = () => !!asked;

  return { open, close, ask: askOpen, asking };
})();
if (typeof window !== 'undefined') window.Modal = Modal;

// ── confirmDialog and promptDialog (#223) ─────────────────────────────────────
// The browser's confirm() and prompt() stop the whole page, cannot be styled,
// say "OK" for every action, and in some browsers carry the site's address as
// their only heading. These ask in the app's own dialog instead, and answer
// with a Promise:
//
//   if (!(await confirmDialog({ title: 'Delete “Gatton”?', message: '…',
//                              confirm: 'Delete station', danger: true }))) return;
//
// `title` is the question and the dialog's name; `message` the plain text that
// says what follows (blank lines make paragraphs; `html` instead, for trusted
// markup); `confirm` names the button that acts — what it does, not "OK" —
// and `cancel` the other. `danger` marks the action as one that cannot be taken
// back: its button is drawn as the destructive one, and focus starts on the
// way out rather than the way in, so a stray Enter keeps things as they were.
//
// `checkbox: { label, checked }` adds one choice to the question, and the
// answer becomes false or `{ checked }` — for a second question that only
// arises from a "yes" to the first, asked as part of it rather than after it.
//
// Every way out that is not the button — Esc, ×, the backdrop — is "no".

function askParas(message) {
  return String(message || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function confirmDialog({ title, message = '', html = '', confirm = 'OK', cancel = 'Cancel',
                         danger = false, checkbox = null } = {}) {
  return new Promise(resolve => {
    const text = html || askParas(message);
    Modal.ask({
      title,
      describedBy: text ? 'app-ask-desc' : null,
      html: `${text ? `<div id="app-ask-desc" class="ask-text">${text}</div>` : ''}
        ${checkbox ? `<label class="check-inline ask-check"><input type="checkbox" id="app-ask-check"${
          checkbox.checked ? ' checked' : ''}> <span>${esc(checkbox.label)}</span></label>` : ''}
        <div class="modal-foot">
          <button type="button" data-ask="no">${esc(cancel)}</button>
          <button type="button" data-ask="yes" class="${danger ? 'btn-danger ask-danger' : 'primary'}">${esc(confirm)}</button>
        </div>`,
      focus: danger ? '[data-ask="no"]' : '[data-ask="yes"]',
      wire: (card, answer) => {
        card.querySelector('[data-ask="no"]').addEventListener('click', () => answer(false));
        card.querySelector('[data-ask="yes"]').addEventListener('click', () => {
          const box = card.querySelector('#app-ask-check');
          answer(checkbox ? { checked: !!(box && box.checked) } : true);
        });
      },
      done: value => resolve(checkbox ? (value || false) : value === true),
    });
  });
}

// The text typed, or null for no answer. The button stays off while the box is
// blank, so an empty answer is never given — Enter in an empty box does nothing.
function promptDialog({ title, label, value = '', confirm = 'OK', cancel = 'Cancel', message = '',
                        placeholder = '' } = {}) {
  return new Promise(resolve => {
    const text = askParas(message);
    Modal.ask({
      title,
      role: 'dialog',
      describedBy: text ? 'app-ask-desc' : null,
      html: `${text ? `<div id="app-ask-desc" class="ask-text">${text}</div>` : ''}
        <form class="ask-form" novalidate>
          <label class="ask-field">${esc(label || title)}
            <input type="text" id="app-ask-input" autocomplete="off" value="${esc(value)}"
                   placeholder="${esc(placeholder)}"></label>
          <div class="modal-foot">
            <button type="button" data-ask="no">${esc(cancel)}</button>
            <button type="submit" data-ask="yes" class="primary"${String(value).trim() ? '' : ' disabled'}>${esc(confirm)}</button>
          </div>
        </form>`,
      focus: '#app-ask-input',
      wire: (card, answer) => {
        const input = card.querySelector('#app-ask-input');
        const go = card.querySelector('[data-ask="yes"]');
        input.addEventListener('input', () => { go.disabled = !input.value.trim(); });
        card.querySelector('[data-ask="no"]').addEventListener('click', () => answer(undefined));
        card.querySelector('form').addEventListener('submit', e => {
          e.preventDefault();
          if (input.value.trim()) answer(input.value);
        });
      },
      done: v => resolve(typeof v === 'string' ? v : null),
    });
  });
}
