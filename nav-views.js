// MegaNet — nav-views.js
//
//   NavViews   what the left bar shows. A view is a choice of tabs, put into
//              groups and an order: 📚 All is every tab as TABS files them, and
//              always will be; 🪶 Simple and 🥾 Field are two built-in
//              starting points; and an account can make its own on the 🎛️
//              Views tab — rename a group, move a tab up, down or into another
//              group, take a tab out — kept with the account in the database
//              (0062: meganet.user_pref, my_prefs(), save_my_views()), so a
//              view made on a laptop is there on the phone.
//
// After core.js (TABS, TAB_LIST, esc, escAttr, announce, state) and app.js
// (renderTabs, switchTab, setNavCollapsed, focusNavFind); across to auth.js
// (Auth), datastore.js (dbRpc), modal.js (confirmDialog) and toast.js (Toast).
// All of it at call time — nothing here runs at load. init.js calls start()
// before the first renderTabs(); auth.js calls authChanged() on every sign-in
// and sign-out; renderMain() calls render() and init() for the Views tab.
//
// ── Which view is showing ────────────────────────────────────────────────────
// The view *picked* is this device's ('mn-view'): a phone held in a paddock
// wants Field and the desk it came from wants All, and one account picking for
// both would be wrong on one of them. The views themselves are the account's.
// A device that has never picked starts on the one the account last picked
// anywhere (layout.current), and a device with no account on All — which is
// also what every check that counts the nav's tabs expects to find.
//
// ── A tab outside the view is never lost ─────────────────────────────────────
// A view only decides what the bar *lists*. The tab open now is always in the
// bar — under "Not in this view" when the view leaves it out, so a link, the
// palette or a "See also" can still land somewhere the bar admits to — and the
// find box answers from every tab, the view's first. All cannot be changed or
// deleted, so there is always a way back to everything.
//
// ── The built-in two ─────────────────────────────────────────────────────────
// Simple is All less what the owner named (October 2026): Export, the Map
// Generator, and the whole Interference group — a subtraction, so a tab added
// to the app later is in Simple without anybody editing this, unless it joins
// the Interference group: then it joins this list too, as Bit-Flip Sources and
// the 🧪 Bit Bench did (views.mjs holds the group out of Simple). Field is an
// addition — what a site visit on a phone needs: the station and the way to
// it, the camera and the photos, the forms (and 📟 the SWR Meter, which their
// Antenna Tests open), the surveys, and whether the station is reporting — so
// a desk tool added later stays out of it. Either
// becomes the account's own the first time it is changed, and Reset puts the
// built-in back; until then it is not stored as a list at all, only as "the
// built-in Field", so it follows the app as the app changes.
const NavViews = (function () {
  const PICK_KEY  = 'mn-view';     // this device's pick
  const CACHE_KEY = 'mn-views';    // { email, layout } — the account's views, for the first paint
  const MAX_VIEWS = 24, MAX_GROUPS = 30, MAX_TABS = 80, NAME_MAX = 40;
  const ID_RE  = /^[a-z0-9][a-z0-9-]{0,39}$/;
  const TAB_RE = /^[a-z0-9]{1,30}$/;

  const ALL = { id: 'all', name: 'All', icon: '📚',
    about: 'Every tab, filed as Flood-Net files them. It cannot be changed, so whatever another view leaves out is always one pick away.' };

  const PRESETS = {
    simple: {
      name: 'Simple', icon: '🪶',
      about: 'Everything but the desk-bound radio work: no Export, no Map Generator, and none of the Interference group.',
      drop: ['export', 'mapgen', 'rf', 'rfchanges', 'workbench', 'reception', 'flipsources', 'bitbench'],
    },
    field: {
      name: 'Field', icon: '🥾',
      about: 'What a site visit needs on a phone: the nearest stations, the station and the way to it, the camera and the photos, the forms and the SWR meter, the surveys, and whether the station is reporting.',
      groups: [
        { name: 'Stations & networks', tabs: ['nearby', 'stations', 'lookaround'] },
        { name: 'Site visits',         tabs: ['camera', 'photos', 'inspections', 'swr', 'maintenance', 'history'] },
        { name: 'Surveying',           tabs: ['levels', 'twopeg', 'surveyguide'] },
        { name: 'Is it reporting?',    tabs: ['msglog', 'health'] },
        { name: 'Before you go',       tabs: ['offline', 'views'] },
      ],
    },
  };
  const CUSTOM_ICON = '🧩';
  const OUTSIDE = 'Not in this view';

  // The account's views, or null for the built-in pair. `owner` is whose they
  // are, so that a sign-out on a shared machine takes them away with it.
  let layout = null;
  let owner = null;
  let saveTimer = null;
  let save = { state: '', text: '' };   // '' | 'saving' | 'saved' | 'failed'
  let editing = null;                   // the view open in the Views tab's editor
  let drag = null;                      // { vid, gi, ti } while a tab row is dragged

  // ── Plumbing ───────────────────────────────────────────────────────────────

  function readLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeLS(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private mode */ }
  }

  function tab(id) { return TAB_LIST.find(t => t.id === id) || null; }
  function homeGroup(id) {
    const g = TABS.find(x => x.tabs.some(t => t.id === id));
    return g ? g.group : '';
  }
  function cleanName(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }
  function signedIn() { return typeof Auth !== 'undefined' && Auth.isSignedIn(); }
  function deepCopy(x) { return JSON.parse(JSON.stringify(x)); }

  // Whatever arrived — the database, the cache, a hand-edited store — made into
  // the shape save_my_views() accepts, or null if there is nothing usable in it.
  // The database checks the same shape; this is so a bad copy never reaches the
  // nav, not a second guard.
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.views)) return null;
    const ids = new Set();
    const views = [];
    for (const v of raw.views.slice(0, MAX_VIEWS)) {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !ID_RE.test(v.id) || v.id === 'all' || ids.has(v.id)) continue;
      const out = { id: v.id };
      if (v.preset === 'simple' || v.preset === 'field') out.preset = v.preset;
      const name = cleanName(v.name);
      if (name) out.name = name;
      if (Array.isArray(v.groups)) {
        out.groups = v.groups.slice(0, MAX_GROUPS)
          .filter(g => g && typeof g === 'object' && Array.isArray(g.tabs))
          .map(g => ({ name: cleanName(g.name) || 'Group',
                       tabs: g.tabs.filter(t => typeof t === 'string' && TAB_RE.test(t)).slice(0, MAX_TABS) }));
      }
      if (!out.preset && !out.groups) continue;
      if (!out.preset && !out.name) out.name = 'My view';
      ids.add(out.id);
      views.push(out);
    }
    const current = typeof raw.current === 'string' && ID_RE.test(raw.current) ? raw.current : null;
    return { v: 1, current, views };
  }

  function storedViews() {
    return layout ? layout.views : [{ id: 'simple', preset: 'simple' }, { id: 'field', preset: 'field' }];
  }

  // A view as the nav and the editor use it: its groups as tab objects, a tab
  // the app no longer has dropped, and no tab twice — the first place a view
  // puts it is where it stays.
  function resolve(v) {
    let groups;
    let meta;
    if (v.id === 'all') {
      meta = ALL;
      groups = TABS.map(g => ({ group: g.group, tabs: g.tabs.slice() }));
    } else {
      const p = v.preset ? PRESETS[v.preset] : null;
      meta = { name: v.name || (p ? p.name : 'My view'), icon: p ? p.icon : CUSTOM_ICON,
               about: p ? p.about : '' };
      if (v.groups) {
        groups = v.groups.map(g => ({ group: g.name, tabs: g.tabs.map(tab).filter(Boolean) }));
      } else if (p && p.drop) {
        groups = TABS.map(g => ({ group: g.group, tabs: g.tabs.filter(t => !p.drop.includes(t.id)) }));
      } else if (p) {
        groups = p.groups.map(g => ({ group: g.name, tabs: g.tabs.map(tab).filter(Boolean) }));
      } else {
        groups = [];
      }
    }
    // A tab this session is not offered (tabShown, core.js) is left out of
    // every view here, so the bar, the count and the editor agree on it.
    const seen = new Set();
    for (const g of groups) g.tabs = g.tabs.filter(t => tabShown(t) && !seen.has(t.id) && seen.add(t.id));
    return {
      id: v.id, name: meta.name, icon: meta.icon, about: meta.about,
      preset: v.preset || null, edited: !!(v.preset && v.groups), fixed: v.id === 'all',
      groups, count: seen.size,
    };
  }

  function views() { return [resolve(ALL), ...storedViews().map(resolve)]; }
  function find(id) { return views().find(v => v.id === id) || null; }

  function currentId() {
    const ids = new Set(views().map(v => v.id));
    const picked = readLS(PICK_KEY);
    if (picked && ids.has(picked)) return picked;
    if (!picked && layout && layout.current && ids.has(layout.current)) return layout.current;
    return 'all';
  }
  function current() { return find(currentId()) || resolve(ALL); }

  // ── What the nav asks ──────────────────────────────────────────────────────

  // The current view's groups with at least one tab, as navFiltered() (app.js)
  // walks them: [{ group, tabs: [tab, …] }].
  function navGroups() {
    return current().groups.filter(g => g.tabs.length);
  }

  // The heading the nav files a tab under when the view leaves it out.
  function outsideLabel() { return OUTSIDE; }

  // Whether the current view lists a tab — what the nav asks before adding
  // the open tab under "Not in this view".
  function inView(id) {
    return navGroups().some(g => g.tabs.some(t => t.id === id));
  }

  // The view row at the top of the nav: a <select> of every view and ✎ to the
  // Views tab, and — on the icon rail, where there is no room for either — one
  // button with the view's icon that opens the nav with the cursor on the
  // select, as 🔎 does for the find box.
  function navHeadHtml() {
    const cur = current();
    const opts = views().map(v =>
      `<option value="${escAttr(v.id)}"${v.id === cur.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
    return `
        <div class="nav-view">
          <label class="nav-view-label" for="nav-view-select" title="What the bar lists — pick a view">
            <span class="nav-view-ico" aria-hidden="true">${cur.icon}</span>View</label>
          <select id="nav-view-select" class="nav-view-select" onchange="NavViews.pick(this.value)">${opts}</select>
          <button type="button" class="nav-view-edit" onclick="NavViews.openTab()"
                  aria-label="Make or change a view" title="Make or change a view (the Views tab)">✎</button>
        </div>
        <button type="button" class="nav-view-btn" onclick="NavViews.railOpen()"
                title="View: ${escAttr(cur.name)} — pick another">
          <span class="nav-icon" aria-hidden="true">${cur.icon}</span>
          <span class="nav-label">View: ${esc(cur.name)}</span>
        </button>`;
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  function pick(id) {
    const v = find(id);
    if (!v) return;
    writeLS(PICK_KEY, v.id);
    if (signedIn()) {
      if (!layout) layout = { v: 1, current: null, views: deepCopy(storedViews()) };
      if (layout.current !== v.id) { layout.current = v.id; persist({ quiet: true }); }
    }
    if (typeof renderTabs === 'function') renderTabs();
    const sel = document.getElementById('nav-view-select');
    if (sel && document.activeElement === document.body) sel.focus();
    repaint();
    announce(`View: ${v.name} — ${v.count} tab${v.count === 1 ? '' : 's'} in the bar.`);
  }

  // The rail's view button: the nav opened, the cursor on the select.
  function railOpen() {
    if (state.navCollapsed && typeof setNavCollapsed === 'function') setNavCollapsed(false);
    const sel = document.getElementById('nav-view-select');
    if (sel) sel.focus();
  }

  function openTab() {
    editing = currentId();
    if (typeof switchTab === 'function') switchTab('views');
  }

  // ── The account's copy ─────────────────────────────────────────────────────

  // Before the first paint (init.js): the views this device last saw for the
  // account whose session is stored here, so the bar does not open on All and
  // then jump to the view once the database answers.
  function start() {
    let cached = null;
    try { cached = JSON.parse(readLS(CACHE_KEY) || 'null'); } catch (_) { cached = null; }
    const email = typeof Auth !== 'undefined' && Auth.storedEmail ? Auth.storedEmail() : null;
    if (cached && email && cached.email === email) {
      layout = sanitize(cached.layout);
      owner = layout ? email : null;
    }
  }

  // A sign-in, a sign-out, or the database saying who this is (auth.js).
  async function authChanged() {
    const email = typeof Auth !== 'undefined' && Auth.email ? (Auth.email() || '').toLowerCase() : '';
    if (!signedIn()) {
      const had = !!layout;
      layout = null; owner = null; save = { state: '', text: '' };
      writeLS(CACHE_KEY, null);
      if (had && typeof renderTabs === 'function') renderTabs();
      repaint();
      return;
    }
    if (owner && email && owner !== email) { layout = null; owner = null; }
    try {
      const prefs = await dbRpc('my_prefs', {});
      if (!signedIn()) return;
      const fresh = prefs ? sanitize(prefs.nav_views) : null;
      layout = fresh;
      owner = email || owner;
      cache();
    } catch (err) {
      // A database without 0062 answers 404: the views are this device's
      // until it has it, and the Views tab says why they are not saving.
      if (err && err.status === 404) save = { state: 'failed', text: 'The database cannot keep views yet (it needs 0062) — they last until this page is closed.' };
    }
    if (typeof renderTabs === 'function') renderTabs();
    repaint();
  }

  function cache() {
    if (layout && owner) writeLS(CACHE_KEY, JSON.stringify({ email: owner, layout }));
    else writeLS(CACHE_KEY, null);
  }

  // Kept: on this device at once, in the database a moment after the last
  // change — one write for a burst of clicks.
  function persist({ quiet = false } = {}) {
    if (!signedIn() || !layout) return;
    if (!owner && Auth.email) owner = (Auth.email() || '').toLowerCase() || null;
    cache();
    if (!quiet) { save = { state: 'saving', text: 'Saving to your account…' }; paintSave(); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
  }

  async function flush() {
    saveTimer = null;
    if (!signedIn() || !layout) return;
    try {
      await dbRpc('save_my_views', { p_views: layout });
      save = { state: 'saved', text: 'Saved to your account — on every device you sign in on.' };
    } catch (err) {
      save = { state: 'failed', text: err && err.status === 404
        ? 'Not saved: the database cannot keep views yet (it needs 0062). They last until this page is closed.'
        : `Not saved — ${err && err.message ? err.message : 'the database did not answer'}.` };
    }
    paintSave();
  }

  // ── Changing a view ────────────────────────────────────────────────────────

  // The account's own copy of a view, made from the built-in the first time
  // one is changed. Returns the stored view, or null for All and when signed
  // out (the Views tab offers sign-in instead of a control that would do
  // nothing).
  function own(vid) {
    if (vid === 'all' || !signedIn()) return null;
    if (!layout) layout = { v: 1, current: null, views: deepCopy(storedViews()) };
    const v = layout.views.find(x => x.id === vid);
    if (!v) return null;
    if (!v.groups) {
      const r = resolve(v);
      v.groups = r.groups.map(g => ({ name: g.group, tabs: g.tabs.map(t => t.id) }));
      if (!v.name) v.name = r.name;
    }
    return v;
  }

  // After every change: kept, the bar redrawn (it may be the view in use), the
  // editor redrawn, and focus put back on the control that did it — or the
  // nearest thing to it, when that control has just gone (its row moved).
  function changed(said, focusKey) {
    persist();
    if (typeof renderTabs === 'function') renderTabs();
    repaint(focusKey);
    if (said) announce(said);
  }

  function newId() {
    let id;
    do { id = 'v-' + Math.random().toString(36).slice(2, 10); } while (storedViews().some(v => v.id === id));
    return id;
  }

  function create() { duplicate('all', 'My view'); }

  function duplicate(vid, name) {
    if (!signedIn()) return signInFirst();
    const src = find(vid);
    if (!src) return;
    if (!layout) layout = { v: 1, current: null, views: deepCopy(storedViews()) };
    if (layout.views.length >= MAX_VIEWS) { Toast.failed(`An account keeps at most ${MAX_VIEWS} views — delete one first.`); return; }
    const taken = new Set(views().map(v => v.name));
    let base = cleanName(name || `${src.name} (copy)`), nm = base, n = 2;
    while (taken.has(nm)) nm = cleanName(`${base} ${n++}`);
    const v = { id: newId(), name: nm, groups: src.groups.map(g => ({ name: g.group, tabs: g.tabs.map(t => t.id) })) };
    layout.views.push(v);
    editing = v.id;
    changed(`Made ${nm}, a copy of ${src.name}. It is open below to change.`, 'view-name');
  }

  function rename(vid, value) {
    const v = own(vid);
    if (!v) return;
    const nm = cleanName(value);
    if (!nm) { repaint('view-name'); return; }
    if (nm === v.name) return;
    v.name = nm;
    changed(`Renamed the view ${nm}.`, 'view-name');
  }

  async function remove(vid) {
    if (vid === 'all' || !signedIn()) return;
    const r = find(vid);
    if (!r) return;
    if (!(await confirmDialog({ title: `Delete the ${r.name} view?`,
      message: r.preset ? `The built-in ${r.name} can be put back from the Views tab at any time.`
                        : 'Its tabs stay in All, and in any other view that has them.',
      confirm: 'Delete the view', danger: true }))) return;
    if (!layout) layout = { v: 1, current: null, views: deepCopy(storedViews()) };
    layout.views = layout.views.filter(v => v.id !== vid);
    if (layout.current === vid) layout.current = null;
    if (readLS(PICK_KEY) === vid) writeLS(PICK_KEY, 'all');
    editing = currentId();
    changed(`Deleted the ${r.name} view.`, `pick:${editing}`);
  }

  function reset(vid) {
    if (!signedIn() || !layout) return;
    const v = layout.views.find(x => x.id === vid);
    if (!v || !v.preset) return;
    delete v.groups;
    delete v.name;
    // The Reset button has gone with the change it undid: focus to the
    // editor's heading (repaint's fallback).
    changed(`Put the built-in ${PRESETS[v.preset].name} back.`, 'view-reset');
  }

  // The built-in pair, back after a delete.
  function restorePresets() {
    if (!signedIn()) return;
    if (!layout) layout = { v: 1, current: null, views: deepCopy(storedViews()) };
    for (const p of ['simple', 'field']) {
      if (!layout.views.some(v => v.preset === p && !v.groups) && !layout.views.some(v => v.id === p)) {
        layout.views.push({ id: p, preset: p });
      }
    }
    changed('The built-in Simple and Field views are back.', 'restore');
  }

  function groupOf(v, gi) { return v && v.groups[gi] ? v.groups[gi] : null; }

  function renameGroup(vid, gi, value) {
    const v = own(vid), g = groupOf(v, gi);
    if (!g) return;
    const nm = cleanName(value);
    if (!nm || nm === g.name) { repaint(`g:${gi}:name`); return; }
    g.name = nm;
    changed(`Renamed the group ${nm}.`, `g:${gi}:name`);
  }

  function moveGroup(vid, gi, dir) {
    const v = own(vid);
    const to = gi + dir;
    if (!v || !v.groups[gi] || to < 0 || to >= v.groups.length) return;
    const [g] = v.groups.splice(gi, 1);
    v.groups.splice(to, 0, g);
    changed(`Moved the ${g.name} group ${dir < 0 ? 'up' : 'down'}.`, `g:${to}:${dir < 0 ? 'up' : 'down'}`);
  }

  async function removeGroup(vid, gi) {
    const v = own(vid), g = groupOf(v, gi);
    if (!g) return;
    const n = g.tabs.filter(tab).length;
    if (n && !(await confirmDialog({ title: `Remove the ${g.name} group?`,
      message: `Its ${n} tab${n === 1 ? '' : 's'} leave${n === 1 ? 's' : ''} this view too. They stay in All, and can be added back below.`,
      confirm: 'Remove the group', danger: true }))) return;
    v.groups.splice(gi, 1);
    changed(`Removed the ${g.name} group.`, v.groups.length ? `g:${Math.min(gi, v.groups.length - 1)}:name` : 'add-group');
  }

  function addGroup(vid) {
    const v = own(vid);
    if (!v) return;
    if (v.groups.length >= MAX_GROUPS) { Toast.failed(`A view has at most ${MAX_GROUPS} groups.`); return; }
    v.groups.push({ name: 'New group', tabs: [] });
    changed('Added a group, New group, at the foot of the view. Name it in the box that has the cursor.', `g:${v.groups.length - 1}:name`);
  }

  // ↑ and ↓ walk the bar, not only the group: at the top of a group ↑ takes a
  // tab into the foot of the group above, as dragging it there would.
  function moveTab(vid, gi, ti, dir) {
    const v = own(vid), g = groupOf(v, gi);
    if (!g || ti < 0 || ti >= g.tabs.length) return;
    const id = g.tabs[ti];
    const t = tab(id);
    let to = { gi, ti: ti + dir };
    if (to.ti < 0 || to.ti >= g.tabs.length) {
      const ng = gi + dir;
      if (ng < 0 || ng >= v.groups.length) return;
      g.tabs.splice(ti, 1);
      if (dir < 0) { v.groups[ng].tabs.push(id); to = { gi: ng, ti: v.groups[ng].tabs.length - 1 }; }
      else { v.groups[ng].tabs.unshift(id); to = { gi: ng, ti: 0 }; }
      changed(`Moved ${t ? t.label : id} into ${v.groups[ng].name}.`, `t:${id}:${dir < 0 ? 'up' : 'down'}`);
      return;
    }
    g.tabs.splice(ti, 1);
    g.tabs.splice(to.ti, 0, id);
    changed(`Moved ${t ? t.label : id} ${dir < 0 ? 'up' : 'down'}.`, `t:${id}:${dir < 0 ? 'up' : 'down'}`);
  }

  function tabToGroup(vid, gi, ti, toGi) {
    const v = own(vid), g = groupOf(v, gi);
    const to = Number(toGi);
    if (!g || toGi === '' || !isFinite(to) || !v.groups[to] || to === gi) { repaint(); return; }
    const [id] = g.tabs.splice(ti, 1);
    if (v.groups[to].tabs.length >= MAX_TABS) { g.tabs.splice(ti, 0, id); Toast.failed(`A group has at most ${MAX_TABS} tabs.`); return; }
    v.groups[to].tabs.push(id);
    const t = tab(id);
    changed(`Moved ${t ? t.label : id} into ${v.groups[to].name}.`, `t:${id}:group`);
  }

  function removeTab(vid, gi, ti) {
    const v = own(vid), g = groupOf(v, gi);
    if (!g || !g.tabs[ti]) return;
    const [id] = g.tabs.splice(ti, 1);
    const t = tab(id);
    const next = g.tabs[Math.min(ti, g.tabs.length - 1)];
    changed(`Took ${t ? t.label : id} out of ${v.name}. It is under Not in this view, to add back.`,
            next ? `t:${next}:remove` : `g:${gi}:name`);
  }

  function addTab(vid, id, toGi) {
    const v = own(vid);
    if (!v || !tab(id) || toGi === '') { repaint(); return; }
    let to = Number(toGi);
    if (toGi === 'new' || !v.groups.length) {
      if (v.groups.length >= MAX_GROUPS) { Toast.failed(`A view has at most ${MAX_GROUPS} groups.`); return; }
      v.groups.push({ name: homeGroup(id) || 'New group', tabs: [] });
      to = v.groups.length - 1;
    }
    if (!v.groups[to]) return;
    if (v.groups[to].tabs.length >= MAX_TABS) { Toast.failed(`A group has at most ${MAX_TABS} tabs.`); return; }
    for (const g of v.groups) g.tabs = g.tabs.filter(x => x !== id);
    v.groups[to].tabs.push(id);
    changed(`Added ${tab(id).label} to ${v.groups[to].name}.`, `t:${id}:remove`);
  }

  // ── Dragging, for a mouse — the buttons do the same for a keyboard ─────────

  function dragStart(e, vid, gi, ti) {
    drag = { vid, gi, ti };
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `${gi}:${ti}`); } catch (_) {}
    const row = e.currentTarget;
    if (row && row.classList) requestAnimationFrame(() => row.classList.add('is-dragging'));
  }

  function dragOver(e) {
    if (!drag) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    const over = e.currentTarget;
    document.querySelectorAll('.vw-drop-before, .vw-drop-end')
      .forEach(n => { if (n !== over) n.classList.remove('vw-drop-before', 'vw-drop-end'); });
    over.classList.add(over.classList.contains('vw-tab') ? 'vw-drop-before' : 'vw-drop-end');
  }

  function dragLeave(e) {
    const n = e.currentTarget;
    if (n && !n.contains(e.relatedTarget)) n.classList.remove('vw-drop-before', 'vw-drop-end');
  }

  // Dropped on a row: before it. Dropped on a group's list (its empty space or
  // the line under its last row): at its foot.
  function drop(e, gi, ti) {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const d = drag;
    drag = null;
    document.querySelectorAll('.vw-drop-before, .vw-drop-end, .is-dragging')
      .forEach(n => n.classList.remove('vw-drop-before', 'vw-drop-end', 'is-dragging'));
    const v = own(d.vid), from = groupOf(v, d.gi), to = groupOf(v, gi);
    if (!from || !to || !from.tabs[d.ti]) return;
    const id = from.tabs[d.ti];
    let at = ti == null ? to.tabs.length : ti;
    if (from === to && d.ti < at) at -= 1;
    from.tabs.splice(d.ti, 1);
    if (from === to && at === d.ti) { to.tabs.splice(at, 0, id); repaint(); return; }
    to.tabs.splice(Math.max(0, Math.min(at, to.tabs.length)), 0, id);
    const t = tab(id);
    changed(`Moved ${t ? t.label : id}${from === to ? '' : ` into ${to.name}`}.`, `t:${id}:up`);
  }

  function dragEnd() {
    drag = null;
    document.querySelectorAll('.vw-drop-before, .vw-drop-end, .is-dragging')
      .forEach(n => n.classList.remove('vw-drop-before', 'vw-drop-end', 'is-dragging'));
  }

  // ── The Views tab ──────────────────────────────────────────────────────────

  function signInFirst() {
    if (typeof Auth !== 'undefined') Auth.open({ mode: 'signup' });
  }

  function edit(vid) {
    editing = vid;
    repaint(`pick:${vid}`);
    const h = document.getElementById('vw-ed-h');
    if (h) h.scrollIntoView({ block: 'nearest' });
  }

  function saveHtml() {
    if (!signedIn()) return '';
    return save.text ? `${esc(save.text)}${save.state === 'failed'
      ? ' <button type="button" class="exp-btn-sm" data-k="retry" onclick="NavViews.retry()">Try again</button>' : ''}` : '';
  }

  function paintSave() {
    const el = document.getElementById('vw-save');
    if (el) {
      el.innerHTML = saveHtml();
      el.dataset.state = save.state;
    }
  }

  function retry() { persist(); }

  function listHtml(all, cur) {
    return `
      <ul class="vw-list" role="list">
        ${all.map(v => `
          <li>
            <button type="button" class="vw-item${v.id === editing ? ' is-open' : ''}" data-k="pick:${escAttr(v.id)}"
                    aria-pressed="${v.id === editing}" onclick="NavViews.edit('${escAttr(v.id)}')">
              <span class="vw-item-ico" aria-hidden="true">${v.icon}</span>
              <span class="vw-item-name">${esc(v.name)}</span>
              <span class="vw-item-count">${v.count} tab${v.count === 1 ? '' : 's'}</span>
              ${v.id === cur ? '<span class="badge vw-in-use">in use</span>' : ''}
            </button>
          </li>`).join('')}
      </ul>
      <div class="button-group vw-list-acts">
        <button type="button" data-k="create" onclick="NavViews.create()"
                ${signedIn() ? '' : 'disabled aria-describedby="vw-signin-why"'}>+ New view</button>
        ${signedIn() && !storedViews().some(v => v.preset === 'simple') || signedIn() && !storedViews().some(v => v.preset === 'field')
          ? '<button type="button" data-k="restore" onclick="NavViews.restorePresets()">Bring back Simple and Field</button>' : ''}
      </div>`;
  }

  function editorHtml(v, cur) {
    const mine = signedIn() && !v.fixed;
    const vid = escAttr(v.id);
    const shown = new Set(v.groups.flatMap(g => g.tabs.map(t => t.id)));
    const missing = TAB_LIST.filter(t => !shown.has(t.id) && tabShown(t));
    const groupOpts = (except) => v.groups.map((g, i) => i === except ? ''
      : `<option value="${i}">${esc(g.group)}</option>`).join('');

    const groups = v.groups.map((g, gi) => `
      <fieldset class="vw-group">
        <legend class="sr-only">Group ${gi + 1} of ${v.groups.length}: ${esc(g.group)}</legend>
        <div class="vw-group-head">
          ${mine
            ? `<input type="text" class="vw-group-name" data-k="g:${gi}:name" value="${escAttr(g.group)}" maxlength="${NAME_MAX}"
                      aria-label="Name of group ${gi + 1}" onchange="NavViews.renameGroup('${vid}',${gi},this.value)"
                      onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
               <span class="vw-group-acts">
                 <button type="button" class="vw-ico-btn" data-k="g:${gi}:up" ${gi === 0 ? 'disabled' : ''}
                         aria-label="Move the ${escAttr(g.group)} group up" title="Move the group up"
                         onclick="NavViews.moveGroup('${vid}',${gi},-1)">↑</button>
                 <button type="button" class="vw-ico-btn" data-k="g:${gi}:down" ${gi === v.groups.length - 1 ? 'disabled' : ''}
                         aria-label="Move the ${escAttr(g.group)} group down" title="Move the group down"
                         onclick="NavViews.moveGroup('${vid}',${gi},1)">↓</button>
                 <button type="button" class="vw-ico-btn vw-danger" data-k="g:${gi}:remove"
                         aria-label="Remove the ${escAttr(g.group)} group" title="Remove the group"
                         onclick="NavViews.removeGroup('${vid}',${gi})">✕</button>
               </span>`
            : `<h4 class="vw-group-title">${esc(g.group)}</h4>`}
        </div>
        <ol class="vw-tabs"${mine ? ` ondragover="NavViews.dragOver(event)" ondragleave="NavViews.dragLeave(event)"
            ondrop="NavViews.drop(event,${gi},null)"` : ''}>
          ${g.tabs.map((t, ti) => {
            const first = gi === 0 && ti === 0;
            const last = gi === v.groups.length - 1 && ti === g.tabs.length - 1;
            return `
            <li class="vw-tab"${mine ? ` draggable="true"
                ondragstart="NavViews.dragStart(event,'${vid}',${gi},${ti})" ondragend="NavViews.dragEnd()"
                ondragover="NavViews.dragOver(event)" ondragleave="NavViews.dragLeave(event)"
                ondrop="NavViews.drop(event,${gi},${ti})"` : ''}>
              ${mine ? '<span class="vw-grip" aria-hidden="true" title="Drag to move">⠿</span>' : ''}
              <span class="vw-tab-ico" aria-hidden="true">${t.icon}</span>
              <span class="vw-tab-label">${esc(t.label)}</span>
              ${mine ? `
              <span class="vw-tab-acts">
                <button type="button" class="vw-ico-btn" data-k="t:${t.id}:up" ${first ? 'disabled' : ''}
                        aria-label="Move ${escAttr(t.label)} up" title="Move up"
                        onclick="NavViews.moveTab('${vid}',${gi},${ti},-1)">↑</button>
                <button type="button" class="vw-ico-btn" data-k="t:${t.id}:down" ${last ? 'disabled' : ''}
                        aria-label="Move ${escAttr(t.label)} down" title="Move down"
                        onclick="NavViews.moveTab('${vid}',${gi},${ti},1)">↓</button>
                ${v.groups.length > 1 ? `<select class="vw-to-group" data-k="t:${t.id}:group"
                        aria-label="Move ${escAttr(t.label)} into another group"
                        onchange="NavViews.tabToGroup('${vid}',${gi},${ti},this.value)">
                  <option value="">Move to…</option>${groupOpts(gi)}</select>` : ''}
                <button type="button" class="vw-ico-btn vw-danger" data-k="t:${t.id}:remove"
                        aria-label="Take ${escAttr(t.label)} out of this view" title="Take out of this view"
                        onclick="NavViews.removeTab('${vid}',${gi},${ti})">✕</button>
              </span>` : ''}
            </li>`;
          }).join('')}
        </ol>
        ${g.tabs.length ? '' : `<p class="small vw-empty">No tabs in this group yet${mine ? ' — add one from the list below, or drag one here' : ''}.</p>`}
      </fieldset>`).join('');

    const missingHtml = missing.length ? `
      <section class="vw-missing" aria-labelledby="vw-missing-h">
        <h4 id="vw-missing-h">${OUTSIDE} <span class="badge">${missing.length}</span></h4>
        <ul class="vw-missing-list" role="list">
          ${missing.map(t => `
            <li class="vw-tab">
              <span class="vw-tab-ico" aria-hidden="true">${t.icon}</span>
              <span class="vw-tab-label">${esc(t.label)} <span class="vw-home">${esc(homeGroup(t.id))}</span></span>
              ${mine ? `<select class="vw-add" data-k="add:${t.id}" aria-label="Add ${escAttr(t.label)} to this view"
                      onchange="NavViews.addTab('${vid}','${t.id}',this.value)">
                  <option value="">Add to…</option>${groupOpts(-1)}<option value="new">a new group</option>
                </select>` : ''}
            </li>`).join('')}
        </ul>
      </section>` : `<p class="small vw-missing-none">Every tab is in this view.</p>`;

    return `
      <div class="vw-ed-head">
        <h3 id="vw-ed-h" class="vw-ed-title"><span aria-hidden="true">${v.icon}</span> ${esc(v.name)}</h3>
        <div class="button-group vw-ed-acts">
          ${v.id === cur
            ? '<span class="badge vw-in-use">In use on this device</span>'
            : `<button type="button" class="primary" data-k="use" onclick="NavViews.pick('${vid}')">Use this view</button>`}
          <button type="button" data-k="duplicate" onclick="NavViews.duplicate('${vid}')"
                  ${signedIn() ? '' : 'disabled aria-describedby="vw-signin-why"'}>Duplicate</button>
          ${mine && v.preset && v.edited ? `<button type="button" data-k="view-reset" onclick="NavViews.reset('${vid}')">Reset to the built-in ${esc(PRESETS[v.preset].name)}</button>` : ''}
          ${mine ? `<button type="button" class="adm-danger" data-k="delete" onclick="NavViews.remove('${vid}')">Delete</button>` : ''}
        </div>
      </div>
      ${v.about ? `<p class="small vw-about">${esc(v.about)}${v.edited ? ' — changed from the built-in.' : ''}</p>` : ''}
      ${mine ? `
      <label class="vw-name">View name
        <input type="text" class="vw-name-input" data-k="view-name" value="${escAttr(v.name)}" maxlength="${NAME_MAX}"
               onchange="NavViews.rename('${vid}',this.value)"
               onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"></label>` : ''}
      <div class="vw-groups">${groups || '<p class="small vw-empty">This view has no groups yet.</p>'}</div>
      ${mine ? `<div class="button-group"><button type="button" data-k="add-group" onclick="NavViews.addGroup('${vid}')">+ Add a group</button></div>` : ''}
      ${missingHtml}`;
  }

  function render() {
    const all = views();
    const cur = currentId();
    if (!editing || !all.some(v => v.id === editing)) editing = cur;
    const v = all.find(x => x.id === editing);
    const signedOut = !signedIn();
    return `
      <div class="page vw-page">
        <h2 class="vw-title"><span aria-hidden="true">🎛️</span> Views</h2>
        <p class="vw-lead">A view is what the bar on the left lists: which tabs, in which groups, in what order. Pick
          one at the top of the bar — <strong>All</strong> for everything, <strong>Simple</strong> without the desk-bound
          radio work, <strong>Field</strong> for a site visit on a phone — or make your own here. Whatever a view leaves
          out is still one pick of All away, and the tab you have open always shows in the bar.</p>
        ${signedOut ? `
        <div class="panel vw-signin" id="vw-signin-why">
          <p><strong>Sign in to make views of your own.</strong> They are kept with your account, so a view you set up
            on a laptop is waiting on your phone. Picking All, Simple or Field needs no account.</p>
          <div class="button-group">
            <button type="button" class="primary" onclick="Auth.open({mode:'signup'})">Create a free account</button>
            <button type="button" onclick="Auth.open()">Sign in</button>
          </div>
        </div>` : ''}
        <div class="vw-grid">
          <section class="panel vw-list-panel" aria-labelledby="vw-list-h">
            <h3 id="vw-list-h">Your views</h3>
            <div id="vw-list">${listHtml(all, cur)}</div>
          </section>
          <section class="panel vw-editor" aria-labelledby="vw-ed-h" id="vw-editor">${v ? editorHtml(v, cur) : ''}</section>
        </div>
        <p class="small vw-save" id="vw-save" role="status" data-state="${escAttr(save.state)}">${saveHtml()}</p>
      </div>`;
  }

  function init() { /* nothing to start: render() is the whole of it */ }

  // Redraw the Views tab, if it is open, with focus back where it was — by the
  // data-k of the control that had it, or `focusKey` for a change that moved
  // or removed that control.
  function repaint(focusKey) {
    if (state.activeTab !== 'views') return;
    const list = document.getElementById('vw-list');
    const ed = document.getElementById('vw-editor');
    if (!list || !ed) return;
    const a = document.activeElement;
    const had = a && a.dataset && a.dataset.k && (list.contains(a) || ed.contains(a)) ? a.dataset.k : null;
    const all = views();
    const cur = currentId();
    if (!editing || !all.some(v => v.id === editing)) editing = cur;
    const v = all.find(x => x.id === editing);
    list.innerHTML = listHtml(all, cur);
    ed.innerHTML = v ? editorHtml(v, cur) : '';
    paintSave();
    const key = focusKey || had;
    if (!key) return;
    const el = document.querySelector(`#vw-list [data-k="${CSS.escape(key)}"], #vw-editor [data-k="${CSS.escape(key)}"]`);
    const target = el && !el.disabled && el.getClientRects().length ? el
      : document.querySelector(`#vw-editor [data-k="${CSS.escape(key.replace(/:(up|down)$/, ':remove'))}"]`)
        || document.getElementById('vw-ed-h');
    if (target) {
      if (target.id === 'vw-ed-h') target.tabIndex = -1;
      target.focus({ preventScroll: false });
    }
  }

  return {
    start, authChanged, navGroups, navHeadHtml, outsideLabel, inView, current, currentId, views,
    pick, railOpen, openTab, render, init, edit, create, duplicate, rename, remove, reset, restorePresets,
    renameGroup, moveGroup, removeGroup, addGroup, moveTab, tabToGroup, removeTab, addTab,
    dragStart, dragOver, dragLeave, drop, dragEnd, retry,
    // Read by the checks (test/views.mjs): the built-in definitions, and what
    // is stored for the account right now.
    presets: () => deepCopy(PRESETS),
    layout: () => (layout ? deepCopy(layout) : null),
  };
})();
if (typeof window !== 'undefined') window.NavViews = NavViews;
