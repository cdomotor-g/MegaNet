// MegaNet — calm-shell.js
//
//   CalmShell   the shell of the Calm look (looks.js): the bar down the side
//               as one button a group, that group's tabs as a row across the
//               top of the page (#section-bar), ⋯ in the banner for what the
//               banner no longer shows, and on a phone a bar along the foot
//               for the five things a site visit reaches for.
//
// After core.js (state, TABS, TAB_LIST, esc, escAttr, slug, tabShown,
// tabCannot, announce), before init.js. Reaches across to app.js for
// navFiltered, navCountHtml, switchTab, setNavCollapsed, isPhoneNav,
// updateChromeHeight, setDockTab and openThemeMenu; to nav-views.js for
// NavViews.navHeadHtml; to looks.js for Looks.introHtml; and to the dialogs
// ⋯ opens (ExportMenu, BugReport, WhatsNew, Modal). All of it at call time,
// so this file's position among the modules is free. Nothing runs at load
// (`npm run toplevel`): renderTabs() (app.js) hands the bar to render() when
// the look is Calm, and that is the only way in.
//
// ── Two levels, not forty-two buttons ────────────────────────────────────────
// Classic lists every tab in the bar, under its group's heading. Calm lists the
// groups — nine under All, fewer in a view — and the tabs of the group you are
// in go across the top of the page, where the tab they belong to is. A group's
// button opens the tab last used in it on this device (the first, the first
// time), so the bar is a place you go back to rather than a list you read.
// The groups are the view's (NavViews.navGroups via navFiltered), so a view an
// account has made is honoured here exactly as in Classic, its "Not in this
// view" included; and the groups are TABS' own words, so the Site Map, help
// and Ctrl+K say the same names the bar does.
//
// Each group's tabs are in the bar as well, inside its group, put away above a
// phone's width. On a phone the bar is a drawer and has room for all of them —
// and the Site Map's gold line has a button to find for every tab whichever
// width it is (site-map.js falls back to the group's button, then the row
// across the top, whichever is on screen).
//
// ── Icons ────────────────────────────────────────────────────────────────────
// A group's icon is a line drawing in the ink of the text beside it, not an
// emoji: nine emoji down a bar were nine colours competing for a glance. The
// drawing is the group TABS files the group's first tab under, so a view's own
// group ("Before you go", say) takes the icon of what is in it rather than a
// blank.
//
// Exposes: render, clearBar, openSection, stripKey, navKey, more, moreGo,
//          fieldGo, foldLede, ledeToggle, icon, ICONS.

const CalmShell = (() => {
  const SECTIONS_KEY = 'mn-look-sections';

  // 24-unit line drawings, stroked in currentColor (styles.css, .calm-ico).
  const ICONS = {
    start:     '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    stations:  '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    radio:     '<path d="M5 19a10 10 0 0 1 0-14"/><path d="M19 5a10 10 0 0 1 0 14"/><path d="M8.5 15.5a5 5 0 0 1 0-7"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><circle cx="12" cy="12" r="1.5"/>',
    code:      '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 5-4 14"/>',
    activity:  '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="m9 13 2 2 4-4"/>',
    ruler:     '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
    book:      '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7"/>',
    shield:    '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    dots:      '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    pin:       '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    map:       '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
    camera:    '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    nearby:    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    look:      '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M12 16.5s-3.5-3-3.5-5.7a3.5 3.5 0 0 1 7 0c0 2.7-3.5 5.7-3.5 5.7z"/><circle cx="12" cy="10.8" r="1.1"/>',
    download:  '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    palette:   '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.7-1.3-.7-2.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.7-4-8.6-9-8.6z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
    help:      '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6"/>',
    bug:       '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8v12M9 5l1.5 2M15 5l-1.5 2M3 13h4M17 13h4M4 8l3 2M20 8l-3 2M4 19l3-2M20 19l-3-2"/>',
    sparkle:   '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  };

  // Which drawing each of TABS' groups wears.
  const GROUP_ICON = {
    'Start here':          'start',
    'Stations & networks': 'stations',
    'Interference':        'radio',
    'ALERT':               'code',
    'Data':                'activity',
    'Site visits':         'clipboard',
    'Surveying':           'ruler',
    'Knowledge base':      'book',
    'Admin':               'shield',
  };

  function icon(name, cls = 'calm-ico') {
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.folder}</svg>`;
  }

  // The TABS group a tab is filed under — what its icon, and a view's group
  // made of it, are drawn from.
  function homeGroup(id) {
    const g = TABS.find(x => x.tabs.some(t => t.id === id));
    return g ? g.group : '';
  }

  function groupIcon(g) {
    if (g.outside) return icon('dots');
    const own = GROUP_ICON[g.group];
    if (own) return icon(own);
    return icon(GROUP_ICON[homeGroup(g.tabs[0] && g.tabs[0].id)] || 'folder');
  }

  // The groups the bar lists, as navFiltered() gives them with nothing typed —
  // the view's own, and "Not in this view" when the open tab is outside it.
  function sections() {
    state.navQuery = '';
    return navFiltered().groups;
  }

  function current(list = sections()) {
    return list.find(g => g.tabs.some(t => t.id === state.activeTab)) || null;
  }

  // ── Which tab a group opens on ────────────────────────────────────────────
  function remembered() {
    try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function remember(g) {
    if (!g || g.outside) return;
    const all = remembered();
    if (all[g.group] === state.activeTab) return;
    all[g.group] = state.activeTab;
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(all)); } catch (_) {}
  }

  function openSection(i) {
    const g = sections()[i];
    if (!g || !g.tabs.length) return;
    const last = remembered()[g.group];
    const tab = g.tabs.find(t => t.id === last) || g.tabs[0];
    switchTab(tab.id);
  }

  // ── The bar ───────────────────────────────────────────────────────────────

  function render(nav) {
    watchLedes();
    const list = sections();
    const here = current(list);
    remember(here);
    const collapsed = state.navCollapsed;
    const phone = isPhoneNav();
    const toggle = phone
      ? { icon: '✕', label: 'Close', title: 'Close the menu' }
      : collapsed
        ? { icon: '»', label: 'Expand', title: 'Show the groups\' names' }
        : { icon: '«', label: 'Collapse', title: 'Shrink the bar to its icons' };
    const used = new Set();
    const groups = list.map((g, i) => {
      let hid = 'nav-h-' + slug(g.group);
      for (let n = 2; used.has(hid); n++) hid = `nav-h-${slug(g.group)}-${n}`;
      used.add(hid);
      const on = g === here;
      const count = g.tabs.map(t => navCountHtml(t.id)).join('');
      return `
      <div class="calm-sec${on ? ' on' : ''}${g.outside ? ' nav-outside' : ''}" role="group" aria-labelledby="${hid}">
        <button type="button" class="nav-sec${on ? ' active' : ''}" id="${hid}" data-section="${i}"
                onclick="CalmShell.openSection(${i})" ${on ? 'aria-current="true"' : ''}
                title="${escAttr(`${g.group} — ${g.tabs.map(t => t.label).join(', ')}`)}">
          <span class="nav-icon">${groupIcon(g)}</span>
          <span class="nav-label">${esc(g.group)}</span>
          ${count}
        </button>
        <ul class="nav-list calm-tabs">
          ${g.tabs.map(t => tabButtonHtml(t, g)).join('')}
        </ul>
      </div>`;
    }).join('');
    nav.innerHTML = `
      <div class="nav-inner calm-nav" onkeydown="CalmShell.navKey(event)">
        <div class="nav-head">
          <button class="nav-toggle" onclick="toggleNav()" aria-controls="tab-nav"
                  aria-expanded="${collapsed ? 'false' : 'true'}" title="${toggle.title}">
            <span class="nav-icon" aria-hidden="true">${toggle.icon}</span>
            <span class="nav-label">${toggle.label}</span>
          </button>
        </div>
        <div id="nav-groups" class="calm-sections">${groups}</div>
        <div class="calm-foot">
          ${typeof NavViews !== 'undefined' ? NavViews.navHeadHtml() : ''}
          <p class="nav-legal"><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
        </div>
      </div>
      ${fieldBarHtml(phone)}`;
    renderBar(here, phone);
  }

  // One tab's button, in the bar (a phone's drawer) or across the top. The
  // same element either way, so everything that finds a tab's button by
  // data-tab — the Site Map's line, the checks — finds it here too.
  function tabButtonHtml(t, g, { li = true } = {}) {
    const on = state.activeTab === t.id;
    const cannot = tabCannot(t);
    const btn = `
          <button type="button" class="tab-btn${on ? ' active' : ''}" data-tab="${t.id}"
                  onclick="switchTab('${t.id}')" ${on ? 'aria-current="page"' : ''}
                  title="${esc(cannot ? `${t.label} — ${cannot}` : `${t.label} — ${g.group}`)}">
            <span class="nav-label">${esc(t.label)}</span>
            ${navCountHtml(t.id)}
            ${cannot ? `<span class="nav-needs" aria-hidden="true">🖥️</span><span class="sr-only"> — ${esc(cannot)}</span>` : ''}
          </button>`;
    return li ? `<li>${btn}</li>` : btn;
  }

  // ── Across the top ────────────────────────────────────────────────────────
  // The open group's name and its tabs, over the page and the side panel
  // (styles.css puts #section-bar in the shell's grid). Not a heading: the
  // tab's own h2 is the page's, and a group name above it as another h2 would
  // be a heading with nothing under it but one more heading.
  function renderBar(here, phone) {
    const bar = document.getElementById('section-bar');
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = here ? `
      <div class="sec-bar-in">
        <span class="sec-name">${groupIcon(here)}<span>${esc(here.group)}</span></span>
        <div class="sec-tabs" role="group" aria-label="${escAttr(here.group)} — its tabs"
             onkeydown="CalmShell.stripKey(event)">
          ${here.tabs.map(t => tabButtonHtml(t, here, { li: false })).join('')}
        </div>
      </div>
      ${Looks.introHtml()}` : Looks.introHtml();
    // The bar is above the page now, so it is part of what "the screen below
    // the banner" is measured against (updateChromeHeight, app.js) — and its
    // height moves with the note under it and with how its tabs wrap.
    if (typeof updateChromeHeight === 'function') updateChromeHeight();
    // The open tab's button, scrolled into the row on a phone, where the row
    // scrolls sideways rather than wrapping.
    if (phone) {
      const on = bar.querySelector('.tab-btn.active');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  // Classic draws no row across the top; whatever Calm left there goes.
  function clearBar() {
    const bar = document.getElementById('section-bar');
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    bar.innerHTML = '';
  }

  // ← and → walk the row, Home and End go to its ends, as a row of tabs does.
  function stripKey(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = [...document.querySelectorAll('#section-bar .tab-btn')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const n = items.length;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
            : (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    items[j].focus();
    e.preventDefault();
  }

  // ↑ and ↓ walk the bar, over whatever of it is on screen — the groups at a
  // desktop's width, the groups and their tabs in a phone's drawer.
  function navKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...document.querySelectorAll('#tab-nav .calm-sections .nav-sec, #tab-nav .calm-sections .tab-btn')]
      .filter(b => b.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (next) { next.focus(); e.preventDefault(); }
  }

  // ── A phone's foot ────────────────────────────────────────────────────────
  // Six buttons, for the six things a site visit reaches for. Inside #tab-nav
  // rather than a nav of its own, because the page has one navigation landmark
  // (`npm run shell`), and a fixed child of the bar is drawn where styles.css
  // puts it whatever the bar's own width — 0 on a phone. ⋯ More is the drawer:
  // every group and every tab, the way back to all of it.
  //
  // 🔭 Look Around sits beside Nearby, asked for by the owner as the other
  // thing a phone at a site reaches for most: Nearby says which station is
  // closest, Look Around which one that mast on the skyline is. Six buttons is
  // 60 px apiece on a 360 px phone, so its label under the drawing is "Look"
  // and its full name is the button's own (`name`), which starts with the word
  // that is drawn.
  const FIELD = [
    { key: 'nearby',  tab: 'nearby',      icon: 'nearby',    label: 'Nearby' },
    { key: 'look',    tab: 'lookaround',  icon: 'look',      label: 'Look', name: 'Look Around' },
    { key: 'map',     tab: 'stations',    icon: 'map',       label: 'Map' },
    { key: 'visits',  tab: 'inspections', icon: 'clipboard', label: 'Visits' },
    { key: 'camera',  tab: 'camera',      icon: 'camera',    label: 'Camera' },
  ];

  function fieldBarHtml(phone) {
    if (!phone) return '';
    const open = !state.navCollapsed;
    return `
      <div class="field-bar" role="group" aria-label="Site visit">
        ${FIELD.map(f => {
          const on = !open && state.activeTab === f.tab;
          return `
        <button type="button" class="field-btn${on ? ' active' : ''}" data-field="${f.key}"
                onclick="CalmShell.fieldGo('${f.key}')" ${on ? 'aria-current="page"' : ''}${
                f.name ? ` aria-label="${escAttr(f.name)}" title="${escAttr(f.name)}"` : ''}>
          ${icon(f.icon)}<span>${f.label}</span>
        </button>`;
        }).join('')}
        <button type="button" class="field-btn${open ? ' active' : ''}" data-field="more"
                onclick="CalmShell.fieldGo('more')" aria-controls="tab-nav"
                aria-expanded="${open ? 'true' : 'false'}" title="Every group and every tab">
          ${icon('dots')}<span>More</span>
        </button>
      </div>`;
  }

  function fieldGo(key) {
    if (key === 'more') { setNavCollapsed(!state.navCollapsed); return; }
    const f = FIELD.find(x => x.key === key);
    if (!f) return;
    if (!state.navCollapsed) { state.navCollapsed = true; try { localStorage.setItem('mn-nav', 'collapsed'); } catch (_) {} }
    if (state.activeTab === f.tab) { renderTabs(); window.scrollTo(0, 0); return; }
    switchTab(f.tab);
  }

  // ── ⋯ in the banner ───────────────────────────────────────────────────────
  // What Classic's banner shows as buttons and Calm's keeps one press away.
  // A list in the app's one dialog, so Escape, the Tab walls and focus going
  // back to ⋯ are Modal's; a choice that opens a dialog of its own puts it in
  // this one's place, so focus still goes back to ⋯ in the end.
  function more() {
    // ✨ stands in the banner while there is news this device has not seen
    // (whats-new.js); the line here says so either way.
    const pill = document.getElementById('btn-whatsnew');
    const fresh = !!pill && !pill.hidden;
    const items = [
      { go: 'export', ico: 'download', label: 'Export what this tab shows', sub: 'As a file — CSV, GeoJSON, KML, PNG and the rest' },
      { go: 'theme',  ico: 'palette',  label: 'Theme & look', sub: 'Light, dark or sunlight; Calm or Classic' },
      { go: 'help',   ico: 'help',     label: 'Help for this tab', sub: 'In the side panel' },
      { go: 'guide',  ico: 'start',    label: 'Site Map', sub: 'What every tab is for, and where it is' },
      { go: 'news',   ico: 'sparkle',  label: 'What\'s new', sub: fresh ? 'Changes you have not seen yet' : 'The latest changes' },
      { go: 'bug',    ico: 'bug',      label: 'Report a bug or suggest an improvement', sub: '' },
    ];
    Modal.open({
      title: 'More',
      html: `
        <div class="more-menu" id="more-menu">
          ${items.map(x => `
          <button type="button" class="more-item" data-go="${x.go}" onclick="CalmShell.moreGo('${x.go}')">
            ${icon(x.ico)}
            <span class="more-text"><strong>${esc(x.label)}</strong>${x.sub ? `<span class="small txt-muted">${esc(x.sub)}</span>` : ''}</span>
          </button>`).join('')}
          <p class="nav-legal"><a href="/about">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
        </div>`,
    });
    const first = document.querySelector('#more-menu .more-item');
    if (first) first.focus();
  }

  function moreGo(go) {
    switch (go) {
      case 'export': ExportMenu.open(); break;
      case 'theme':  openThemeMenu(); break;
      case 'news':   WhatsNew.open(); break;
      case 'help':   Modal.close(); setDockTab('help'); break;
      case 'guide':  Modal.close(); switchTab('sitemap'); break;
      case 'bug':    Modal.close(); BugReport.open(); break;
    }
  }

  // ── A tab's introduction, folded ──────────────────────────────────────────
  // Most tabs open with a paragraph saying what the tab is for and how it
  // works it out — four lines of it on Station Health, eight on the Serial
  // Monitor at a phone's width — above the thing somebody came to the tab to
  // read. Under Calm the first long paragraph after the tab's heading is shown
  // two lines deep, with "More about this tab" to open it; opened on a tab, it
  // stays open there on this device. Nothing is taken out: the whole paragraph
  // is in the page, and a screen reader reads it all.
  //
  // Which paragraph is decided off the page rather than listed per tab, since
  // the tabs were not written to one pattern: the first <p> after the first
  // h2, inside the same panel, section or page, of real length, holding no
  // control and not a status line or a table's. A tab that opens with a short
  // line, or with nothing, is left as it is. Applied again whenever a tab
  // writes its page afresh (several draw themselves, not through renderMain),
  // by watching #main-content's own children.
  const LEDE_KEY = 'mn-lede-open';
  const LEDE_MIN_CHARS = 160;
  let ledeWatch = null;

  function ledesOpen() {
    try { const v = JSON.parse(localStorage.getItem(LEDE_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }

  function ledeOf(main) {
    const h = main.querySelector('h2');
    if (!h) return null;
    const box = h.closest('.panel, .page, section') || main;
    // The heading's own row — the tab's name and its buttons, an owner
    // picker's drop-down — is not the page's text; nor is anything folded away.
    const head = h.closest('.panel-header');
    const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const aside = el => (head && head.contains(el)) || !!el.closest('details, table, .modal-card');
    const p = [...box.querySelectorAll('p')].find(x => after(h, x) && !aside(x));
    if (!p || p.classList.contains('sr-only')) return null;
    if (p.closest('[role="status"], [aria-live], .map-panel')) return null;
    if (p.querySelector('input, select, textarea, button')) return null;
    if ((p.textContent || '').trim().length < LEDE_MIN_CHARS) return null;
    // A control between the heading and the paragraph makes the paragraph a
    // note on that control — the Workbench's known-good list says what
    // marking a station does — rather than the tab's introduction.
    const ctl = [...box.querySelectorAll('input, select, textarea, button')]
      .some(c => after(h, c) && after(c, p) && !aside(c));
    return ctl ? null : p;
  }

  function foldLede() {
    if (state.look !== 'calm') return;
    const main = document.getElementById('main-content');
    const p = main && ledeOf(main);
    if (!p || p.classList.contains('lede-fold') || !p.getClientRects().length) return;
    const cs = getComputedStyle(p);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 20;
    if (p.getBoundingClientRect().height <= line * 2.6) return;     // two lines already
    const tab = state.activeTab;
    const open = ledesOpen().includes(tab);
    if (!p.id) p.id = `lede-${tab}`;
    p.classList.add('lede-fold');
    p.classList.toggle('lede-open', open);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn lede-more';
    b.setAttribute('aria-controls', p.id);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.setAttribute('onclick', 'CalmShell.ledeToggle(this)');
    b.textContent = open ? 'Less' : 'More about this tab';
    p.after(b);
  }

  function ledeToggle(b) {
    const p = b && document.getElementById(b.getAttribute('aria-controls'));
    if (!p) return;
    const open = !p.classList.contains('lede-open');
    p.classList.toggle('lede-open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.textContent = open ? 'Less' : 'More about this tab';
    const all = ledesOpen().filter(t => t !== state.activeTab);
    if (open) all.push(state.activeTab);
    try { localStorage.setItem(LEDE_KEY, JSON.stringify(all)); } catch (_) {}
  }

  function watchLedes() {
    if (ledeWatch || typeof MutationObserver === 'undefined') return;
    const main = document.getElementById('main-content');
    if (!main) return;
    ledeWatch = new MutationObserver(foldLede);
    ledeWatch.observe(main, { childList: true });
  }

  return { render, clearBar, openSection, stripKey, navKey, more, moreGo, fieldGo, icon, ICONS,
           foldLede, ledeToggle };
})();
if (typeof window !== 'undefined') window.CalmShell = CalmShell;
