// MegaNet — station-card-view.js
//
// StnCardView — how the station card on the Stations map is laid out, and the
// search across it.
//
// The card had grown to some twenty sections, read top to bottom, and on a
// gauge like Beaudesert AL it ran past 5,000 px: the part somebody came for
// was somewhere in it, and nothing said where. So its sections are put in
// groups — the owner, then seven more — each a question, and each with its
// own colour and icon, on the tab, the list row and the group's heading alike:
//
//   about    About            whose station it is, its number and its kind
//   health   Health           is it working?  (and the tasks going on here)
//   data     Data             what is it reading?
//   flood    Flood            what does the river do here?
//   radio    Radio            how does it talk?
//   site     Site & access    where is it, whose land, can I get there?
//   kit      Kit & records    what is fitted here, and who changed it?
//   act      Actions          everything the card can do with it
//
// …and the card can show them two ways, chosen with Tabs | List beside the
// search box and remembered on this device (localStorage mn-stn-card-view):
//
//   Tabs (the first)   Overview — the owner, Health and Data in full, and a
//                      line from each of the other groups — then a tab per
//                      group. Four everyday actions along the foot, the
//                      fourth of which is All actions.
//   List               a summary — the owner and Health — and every group as
//                      one row with its line, each opening as a page of its
//                      own, with ‹ Summary, and the next and the previous.
//
// Search, in both: a word typed in the box shows every group that has it,
// headed, with only the rows that hold it, the word marked in each, and how
// many there are and where. Folds holding it are opened, and shut again when
// the box is cleared. Enter goes to the first; Escape clears the box, and
// closes the card from an empty one, as it does from anywhere else in it.
//
// ── How it is put together ──────────────────────────────────────────────────
// app.js's stnCardHtml() still writes every section, with the ids the modules
// fill in after their fetches (SLS.ask, SiteLand.ask, HealthGlance.ask …),
// and hands them here grouped; frame() wraps each group in a panel and adds
// the box, the tabs or the back bar, and the foot. A tab, a page or a word
// changes nothing but which panels and rows are hidden — apply() — so a
// section a module is still filling goes on filling where it is, and a fold
// somebody opened stays open. Only Tabs | List draws the card again
// (repaintStnCard), the two views' chrome being different markup.
//
// The search marks its words with the CSS Custom Highlight API: nothing is
// written into the text, so a module's fill and the next keystroke never meet
// a <mark> the other put there. Where the API is missing the rows are still
// filtered, only unmarked. A fill that lands while a word is in the box is
// searched as it lands (a MutationObserver on the card, which ignores the
// card's own top, where the count is written).
//
// Where the place, the word and the view are kept: the view on this device;
// the tab and the page for the session, so the next station opens on the same
// one; the word for its station only — a different station starts with an
// empty box.
//
// After core.js (esc, escAttr) and app.js, whose repaintStnCard() calls
// apply() after every paint; explainer-tour.js calls reveal() before it rings
// a part of the card a tab is hiding. Nothing runs at load.

const StnCardView = (() => {

  const VIEW_KEY = 'mn-stn-card-view';

  // The icons: one stroked path each on a 16-unit square, drawn in the
  // group's colour (currentColor).
  const ICON = {
    about:    'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
    health:   'M1.5 8.5h3l1.8-4.5 3.4 8 1.8-3.5h3',
    data:     'M2 13.5h12M4 11V8M7 11V4.5M10 11V7M13 11V5.5',
    flood:    'M1.5 6q1.6-2 3.25 0t3.25 0 3.25 0 3.25 0M1.5 10.5q1.6-2 3.25 0t3.25 0 3.25 0 3.25 0',
    radio:    'M8 8.5V14M5.5 14h5M8 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M5.2 4.2a4 4 0 0 0 0 5.6M10.8 4.2a4 4 0 0 1 0 5.6M3 2a7 7 0 0 0 0 10M13 2a7 7 0 0 1 0 10',
    site:     'M8 14.5s-4.5-4.3-4.5-8a4.5 4.5 0 0 1 9 0c0 3.7-4.5 8-4.5 8zM8 8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2',
    kit:      'M2.5 4.8 8 2l5.5 2.8v6.4L8 14l-5.5-2.8zM2.5 4.8 8 7.6l5.5-2.8M8 7.6V14',
    act:      'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
    overview: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
    search:   'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3 14 14',
    chevL:    'M10 3.5 5.5 8 10 12.5',
    chevR:    'M6 3.5 10.5 8 6 12.5',
  };

  const GROUPS = [
    { id: 'about',  title: 'About',         short: 'About',   q: 'Whose station it is, its number and its kind' },
    { id: 'health', title: 'Health',        short: 'Health',  q: 'Is it working?' },
    { id: 'data',   title: 'Data',          short: 'Data',    q: 'What is it reading?' },
    { id: 'flood',  title: 'Flood',         short: 'Flood',   q: 'What does the river do here?' },
    { id: 'radio',  title: 'Radio',         short: 'Radio',   q: 'How does it talk?' },
    { id: 'site',   title: 'Site & access', short: 'Site',    q: 'Where is it, whose land, can I get there?' },
    { id: 'kit',    title: 'Kit & records', short: 'Kit',     q: 'What is fitted here, and who changed it?' },
    { id: 'act',    title: 'Actions',       short: 'Actions', q: 'Everything the card can do with it' },
  ];
  const BY = Object.fromEntries(GROUPS.map(g => [g.id, g]));

  // What each view's first page shows in full; the rest are a tab, or a page.
  const HOME = { tabs: ['about', 'health', 'data'], list: ['about', 'health'] };
  // The groups with a tab (Actions is the foot's All actions) and the ones
  // with a row in the list (the owner and Health are on the summary itself).
  const TABBED = ['flood', 'radio', 'site', 'kit'];
  const LISTED = ['data', 'flood', 'radio', 'site', 'kit', 'act'];

  const S = {
    view: null,                         // 'tabs' | 'list', read on first use
    at: { tabs: '', list: '' },         // '' is Overview / the summary
    q: '', qFor: null,                  // the word, and the station it is for
    present: [],                        // the groups this station's card has
    obs: null, pend: 0,
  };

  function view() {
    if (S.view == null) {
      let v = null;
      try { v = localStorage.getItem(VIEW_KEY); } catch (_) {}
      S.view = v === 'list' ? 'list' : 'tabs';
    }
    return S.view;
  }

  const icon = (id, size = 15) => `<svg class="stn-cv-svg" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${ICON[id]}"></path></svg>`;

  // ── the markup ─────────────────────────────────────────────────────────────

  // `p`: { head, proposal, groups: { id: html }, lines: { id: text },
  // dock: [html], note } from stnCardHtml(). A group with nothing in it is
  // left out, tab and row and all.
  function frame(s, p) {
    const v = view();
    if (S.qFor !== s.id) { S.q = ''; S.qFor = s.id; }
    S.present = GROUPS.map(g => g.id).filter(id => String(p.groups[id] || '').trim());
    const has = id => S.present.includes(id);
    const panels = GROUPS.filter(g => has(g.id)).map(g => panelHtml(g, p.groups[g.id])).join('');
    const rows = (ids, head) => {
      const list = ids.filter(has);
      return list.length ? `<nav class="stn-cv-nav stn-cv-${v === 'tabs' ? 'digest' : 'index'}" aria-label="${escAttr(head)}">
        <h3 class="stn-cv-nav-h">${esc(head)}</h3>
        ${list.map(id => rowHtml(id, p.lines[id])).join('')}
      </nav>` : '';
    };
    return `
    <div class="stn-cv-top">
      ${p.head}
      <div class="stn-cv-tools">
        <div class="stn-cv-search" role="search">
          ${icon('search', 14)}
          <input type="search" class="stn-cv-q" id="stn-cv-q" value="${escAttr(S.q)}"
                 placeholder="Search this card" aria-label="Search this station’s card"
                 aria-describedby="stn-cv-hits" autocomplete="off" spellcheck="false"
                 oninput="StnCardView.search(this.value)" onkeydown="StnCardView.qKey(event)">
        </div>
        <div class="stn-cv-views" role="group" aria-label="Lay the card out as">
          <button type="button" class="stn-cv-view" aria-pressed="${v === 'tabs'}" onclick="StnCardView.setView('tabs')"
                  title="Tabs: an overview, then a tab for each group">Tabs</button>
          <button type="button" class="stn-cv-view" aria-pressed="${v === 'list'}" onclick="StnCardView.setView('list')"
                  title="List: a summary, then each group as a page of its own">List</button>
        </div>
      </div>
      ${v === 'tabs' ? tabsHtml() : backHtml()}
      <p class="stn-cv-hits small" id="stn-cv-hits" role="status" aria-live="polite" hidden></p>
    </div>
    <div class="stn-cv-body">
      ${p.proposal || ''}
      ${panels}
      ${v === 'tabs' ? rows(TABBED, 'On the other tabs') : rows(LISTED, 'Everything on this card')}
      ${v === 'list' ? pagerHtml() : ''}
      <div class="stn-cv-none" hidden>
        <p class="stn-cv-none-h"></p>
        <p class="small txt-muted">Try another word, or the search at the top of the page for another station.</p>
      </div>
      ${p.note || ''}
    </div>
    ${dockHtml(p.dock || [])}`;
  }

  function panelHtml(g, html) {
    const tabbed = view() === 'tabs' && TABBED.includes(g.id);
    return `<section class="stn-grp" data-grp="${g.id}" id="stn-grp-${g.id}"${tabbed
        ? ` role="tabpanel" aria-labelledby="stn-cv-tab-${g.id}"` : ` aria-label="${escAttr(g.title)}"`}>
      <div class="stn-grp-head"><span class="stn-cv-ic">${icon(g.id, 16)}</span>
        <span class="stn-grp-names"><h3 class="stn-grp-h">${esc(g.title)}</h3><span class="stn-grp-q small">${esc(g.q)}</span></span></div>
      ${html}
      <p class="stn-grp-none small txt-muted">Nothing on record here for this station.</p>
    </section>`;
  }

  function tabsHtml() {
    const tabs = [{ id: 'overview', short: 'Overview', title: 'Overview', q: 'who owns it, its health and its data, and a line from each of the other tabs' }]
      .concat(TABBED.filter(id => S.present.includes(id)).map(id => BY[id]));
    return `<div class="stn-cv-tabs" role="tablist" aria-label="Parts of this card" onkeydown="StnCardView.tabKey(event)">
      ${tabs.map(t => `<button type="button" role="tab" class="stn-cv-tab" id="stn-cv-tab-${t.id}" data-grp="${t.id}"
          ${t.id === 'overview' ? '' : `aria-controls="stn-grp-${t.id}"`} aria-selected="false" tabindex="-1"
          title="${escAttr(`${t.title}: ${t.q.charAt(0).toLowerCase()}${t.q.slice(1)}`)}"
          onclick="StnCardView.go('${t.id === 'overview' ? '' : t.id}')">${icon(t.id, 15)}<span>${esc(t.short)}</span></button>`).join('')}
    </div>`;
  }

  function backHtml() {
    return `<div class="stn-cv-back" hidden>
      <button type="button" class="link-btn stn-cv-backbtn" onclick="StnCardView.go('')">${icon('chevL', 13)}Summary</button>
      <span class="stn-cv-where small txt-muted"></span>
    </div>`;
  }

  function pagerHtml() {
    return `<div class="stn-cv-pager" hidden>
      <button type="button" class="pill stn-cv-prev" onclick="StnCardView.step(-1)">${icon('chevL', 12)}<span></span></button>
      <button type="button" class="pill stn-cv-next" onclick="StnCardView.step(1)"><span></span>${icon('chevR', 12)}</button>
    </div>`;
  }

  function rowHtml(id, line) {
    const g = BY[id];
    return `<button type="button" class="stn-cv-row" data-grp="${id}" onclick="StnCardView.go('${id}')">
        <span class="stn-cv-ic">${icon(id, 15)}</span>
        <span class="stn-cv-row-t"><span class="stn-cv-row-h">${esc(g.title)}</span><span class="stn-cv-row-s small">${esc(line || g.q)}</span></span>
        <span class="stn-cv-row-go" aria-hidden="true">${icon('chevR', 14)}</span>
      </button>`;
  }

  // The everyday four along the foot: the station's own buttons, given by
  // stnCardHtml() (whatever the station can have of Field data, Zoom and
  // Directions), and All actions.
  function dockHtml(items) {
    return `<nav class="stn-cv-dock" aria-label="Everyday actions">
      ${items.join('')}
      <button type="button" class="stn-cv-dockbtn stn-cv-allacts" aria-pressed="false" onclick="StnCardView.toggleActions()"
              ><span class="stn-cv-dockic" aria-hidden="true">⋯</span><span>All actions</span></button>
    </nav>`;
  }

  // ── where the card is ──────────────────────────────────────────────────────

  const card = () => document.getElementById('stn-card');

  // What the open view shows: '' for its first page, else a group it has.
  function place() {
    const v = view(), at = S.at[v];
    return at && S.present.includes(at) && !(v === 'tabs' && HOME.tabs.includes(at)) ? at : '';
  }

  // Which panels show, which tab is chosen, and the word's rows — after every
  // paint, and after every press here. `moved` scrolls the card to its top.
  function apply(moved = false) {
    const el = card();
    if (!el || el.hidden) return;
    const body = el.querySelector('.stn-cv-body');
    if (!body) return;
    const v = view(), at = place(), q = S.q.trim();
    const mode = q ? 'search' : (at ? 'group' : 'home');
    el.dataset.cv = v;
    el.dataset.cvMode = mode;
    el.dataset.cvAt = at;
    for (const g of body.querySelectorAll(':scope > .stn-grp')) {
      const id = g.dataset.grp;
      g.hidden = mode === 'home' ? !HOME[v].includes(id) : mode === 'group' ? id !== at : false;
    }
    body.querySelectorAll(':scope > .stn-cv-nav').forEach(n => { n.hidden = mode !== 'home'; });
    // One tab in the Tab order: the chosen one, or Overview while none is
    // (a word in the box, or All actions on show).
    const tabs = [...el.querySelectorAll('.stn-cv-tab')];
    const chosen = mode === 'search' ? null : tabs.find(t => t.dataset.grp === (at || 'overview')) || null;
    tabs.forEach(t => {
      t.setAttribute('aria-selected', String(t === chosen));
      t.tabIndex = t === (chosen || tabs[0]) ? 0 : -1;
    });
    const all = el.querySelector('.stn-cv-allacts');
    if (all) all.setAttribute('aria-pressed', String(mode === 'group' && at === 'act'));
    const back = el.querySelector('.stn-cv-back');
    if (back) {
      back.hidden = !(v === 'list' && mode === 'group');
      const list = LISTED.filter(id => S.present.includes(id)), i = list.indexOf(at);
      setText(back.querySelector('.stn-cv-where'), i >= 0 ? `${BY[at].title} · ${i + 1} of ${list.length}` : '');
      const pager = body.querySelector('.stn-cv-pager');
      if (pager) {
        pager.hidden = back.hidden || list.length < 2;
        if (i >= 0 && list.length > 1) {
          setText(pager.querySelector('.stn-cv-prev span'), BY[list[(i - 1 + list.length) % list.length]].title);
          setText(pager.querySelector('.stn-cv-next span'), BY[list[(i + 1) % list.length]].title);
        }
      }
    }
    runSearch(el, body);
    watch(el);
    pads(el);
    if (moved) el.scrollTop = 0;
  }

  // How tall the band at the top and the foot are, for the card's scroll
  // padding (styles.css) — on a phone only the name stays at the top.
  function pads(el) {
    const top = el.querySelector('.stn-cv-top'), foot = el.querySelector('.stn-cv-dock');
    const head = top && (getComputedStyle(top).display === 'contents' ? top.querySelector('.acma-card-head') : top);
    const set = (k, n) => { const v = `${Math.round(n || 0)}px`; if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
    set('--stn-cv-top', head ? head.offsetHeight : 0);
    set('--stn-cv-foot', foot ? foot.offsetHeight : 0);
  }

  // A tab, a list row, ‹ Summary: '' for the first page.
  function go(id) {
    const v = view();
    S.at[v] = id && BY[id] ? id : '';
    if (S.q) { S.q = ''; const box = document.getElementById('stn-cv-q'); if (box) box.value = ''; }
    apply(true);
  }

  // The next or the previous page, in the list's order, round the end.
  function step(d) {
    const list = LISTED.filter(id => S.present.includes(id));
    const i = list.indexOf(place());
    if (!list.length) return;
    go(list[(Math.max(i, 0) + d + list.length) % list.length]);
  }

  function toggleActions() { go(place() === 'act' ? '' : 'act'); }

  function setView(v) {
    v = v === 'list' ? 'list' : 'tabs';
    if (v === view()) return;
    // The group on show goes across, as far as the other view has it.
    const at = place();
    S.view = v;
    S.at[v] = at && !(v === 'tabs' && HOME.tabs.includes(at)) ? at : '';
    try { localStorage.setItem(VIEW_KEY, v); } catch (_) {}
    const el = card();
    const keep = el && el.contains(document.activeElement);
    if (typeof repaintStnCard === 'function') repaintStnCard();
    if (keep) {
      const b = [...document.querySelectorAll('#stn-card .stn-cv-view')].find(x => x.getAttribute('aria-pressed') === 'true');
      if (b) b.focus({ preventScroll: true });
    }
  }

  // ← → Home End along the tabs (the ARIA tabs pattern), choosing as they go.
  function tabKey(e) {
    const tabs = [...e.currentTarget.querySelectorAll('.stn-cv-tab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    tabs[to].click();
    tabs[to].focus();
  }

  // Shows the group `target` (an element in the card, or a selector) is in,
  // when what is on show is hiding it — for a tour that is about to ring it.
  // True when it moved anything.
  function reveal(target) {
    const el = card();
    const t = typeof target === 'string' ? (el && el.querySelector(target)) : target;
    if (!el || !t || !el.contains(t)) return false;
    const grp = t.closest('.stn-grp');
    if (!grp || !grp.hidden) return false;
    const id = grp.dataset.grp, v = view();
    S.q = '';
    const box = document.getElementById('stn-cv-q');
    if (box) box.value = '';
    S.at[v] = HOME[v].includes(id) ? '' : id;
    apply(false);
    return true;
  }

  // Which group is on show, for a test or a tour: { view, at, q }.
  function current() { return { view: view(), at: place(), q: S.q }; }

  // ── the search ─────────────────────────────────────────────────────────────

  function search(q) {
    S.q = String(q || '');
    const el = card();
    if (el) S.qFor = state.stnCard && state.stnCard.id;
    apply(true);
  }

  function qKey(e) {
    if (e.key === 'Escape' && e.target.value) {
      e.preventDefault(); e.stopPropagation();
      e.target.value = '';
      search('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const el = card();
      const hit = el && firstHit(el);
      if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // A row, a list item, a pill, a line of text: the smallest things the
  // search shows or hides. A word that is in none of them — a section's
  // heading, a caption — shows its whole section.
  const ITEM = '.acma-row, li, .pill, p, .mn-pop-line';
  const SECT = '.acma-sect, .stn-card-group, .stn-card-ids';

  function reset(body) {
    body.querySelectorAll('.stn-cv-miss').forEach(n => n.classList.remove('stn-cv-miss'));
    body.querySelectorAll('details[data-cv-opened]').forEach(d => { d.open = false; delete d.dataset.cvOpened; });
  }

  // Every place the word is in the text a group shows.
  function hitsIn(g, q) {
    const out = [];
    const walk = document.createTreeWalker(g, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue || p.closest('.stn-grp-head, .stn-grp-none, script, style, [hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const lo = n.nodeValue.toLowerCase();
      for (let i = lo.indexOf(q); i >= 0; i = lo.indexOf(q, i + q.length)) out.push({ n, i });
    }
    return out;
  }

  // Opens the folds a hit is in, and only those, so the hit can be seen —
  // before visibility is judged, since a shut fold hides what it holds.
  function openFolds(g, q) {
    for (const d of g.querySelectorAll('details:not([open])')) {
      if (d.textContent.toLowerCase().includes(q)) { d.open = true; d.dataset.cvOpened = '1'; }
    }
  }

  function runSearch(el, body) {
    reset(body);
    const q = S.q.trim().toLowerCase();
    const hits = el.querySelector('.stn-cv-hits');
    const none = body.querySelector('.stn-cv-none');
    if (!q) {
      if (hits) { hits.hidden = true; setText(hits, ''); }
      if (none) none.hidden = true;
      mark([]);
      return;
    }
    const ranges = [], found = [];
    let n = 0;
    for (const g of body.querySelectorAll(':scope > .stn-grp')) {
      const meta = BY[g.dataset.grp];
      openFolds(g, q);
      const at = hitsIn(g, q).filter(h => visible(h.n.parentElement));
      const whole = meta && meta.title.toLowerCase().includes(q);
      if (!at.length && !whole) { g.hidden = true; continue; }
      g.hidden = false;
      found.push(meta ? meta.title : g.dataset.grp);
      n += at.length;
      for (const h of at) {
        try { const r = new Range(); r.setStart(h.n, h.i); r.setEnd(h.n, h.i + q.length); ranges.push(r); } catch (_) {}
      }
      if (whole) continue;
      // Each section: hidden when the word is not in it; when it is, only
      // its items that hold it, unless the word is in its heading.
      for (const sec of g.querySelectorAll(SECT)) {
        const mine = at.filter(h => sec.contains(h.n));
        if (!mine.length) { sec.classList.add('stn-cv-miss'); continue; }
        const items = mine.map(h => itemOf(h.n, sec));
        if (items.includes(null)) continue;
        for (const it of sec.querySelectorAll(ITEM)) {
          if (items.some(k => k === it || k.contains(it) || it.contains(k))) continue;
          it.classList.add('stn-cv-miss');
        }
      }
    }
    body.querySelectorAll(':scope > .stn-cv-nav, :scope > .stn-cv-pager').forEach(x => { x.hidden = true; });
    const words = found.length > 1 ? `${found.slice(0, -1).join(', ')} and ${found[found.length - 1]}` : found.join('');
    if (hits) {
      hits.hidden = false;
      setText(hits, n ? `${n} ${n === 1 ? 'match' : 'matches'} — in ${words}` : (found.length ? `In ${words}` : 'No matches'));
    }
    if (none) {
      none.hidden = found.length > 0;
      setText(none.querySelector('.stn-cv-none-h'), `Nothing on this card matches “${S.q.trim()}”.`);
    }
    mark(ranges);
  }

  // Written only when it changes: a write is a mutation, and the observer
  // below would take the card's own count for a module's fill.
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function itemOf(node, sec) {
    const it = node.parentElement && node.parentElement.closest(ITEM);
    return it && sec.contains(it) ? it : null;
  }

  function visible(p) {
    if (!p) return false;
    if (typeof p.checkVisibility === 'function') return p.checkVisibility();
    return !!(p.offsetParent || p.getClientRects().length);
  }

  function mark(ranges) {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (ranges.length) CSS.highlights.set('stn-cv-hit', new Highlight(...ranges));
    else CSS.highlights.delete('stn-cv-hit');
  }

  function firstHit(el) {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      const h = CSS.highlights.get('stn-cv-hit');
      if (h) for (const r of h) { const p = r.startContainer.parentElement; if (p && el.contains(p)) return p; }
    }
    return el.querySelector('.stn-cv-body > .stn-grp:not([hidden])');
  }

  // A fill that lands while a word is in the box is searched as it lands.
  // The card's own top is left out: the count is written there.
  function watch(el) {
    if (S.obs || typeof MutationObserver === 'undefined') return;
    S.obs = new MutationObserver(list => {
      const c = card();
      if (!c || !S.q.trim() || c.hidden) return;
      const top = c.querySelector('.stn-cv-top');
      if (!list.some(m => !(top && top.contains(m.target)) && c.contains(m.target))) return;
      cancelAnimationFrame(S.pend);
      S.pend = requestAnimationFrame(() => apply(false));
    });
    S.obs.observe(el, { childList: true, subtree: true, characterData: true });
  }

  // The card closed: no marks left on a card that has gone.
  function closed() { mark([]); }

  return { GROUPS, frame, apply, go, step, setView, toggleActions, tabKey, reveal, current, search, qKey, closed };
})();
