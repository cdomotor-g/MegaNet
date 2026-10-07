// MegaNet — palette.js
//
// Palette — Ctrl/Cmd+K, and 🔎 Search in the banner: one box that finds a
// station, a place, a tab or an action, from any tab (#221).
//
// Until this, Ctrl+K focused the nav's find box, which filters the tab list by
// label and find words and nothing else. Somebody who knows a station's name
// or number still had to go to Stations, then to its search box, then to the
// row; somebody with a coordinate or a town had to know that 📍 Find a place
// is a pane of the side panel. Here the four answers sit in one list:
//
//   Stations  name, station number, ALERT address or address window, through
//             the Stations filter's own machinery (prepareSearch,
//             stationMatchesSearch) — so "mt stuart" finds Mount Stuart and
//             "4021-4025" finds the window, exactly as the box does. Enter
//             opens the station through goToStation(): one step in the
//             browser's history (route.js), its card up and the map on it.
//   Places    handed to 📍 Find a place rather than answered here: its
//             parse() reads coordinates offline, and its list knows the
//             catchments, rivers, councils and — with a request — towns. A
//             second copy of that would be a second thing to keep right.
//   Tabs      the nav's own scoring (navTerms, navHaystack, navScore), so a
//             query reaches the same tab from either box.
//   Actions   a few things worth doing from anywhere: the Site Map, help for
//             this tab, a link to where you are, a file, an export, the theme,
//             a bug report.
//
// With nothing typed it offers the stations looked at this session (the trail,
// station-trail.js) and the actions — the two things somebody opening it
// without a word in mind is most likely to want.
//
// The list is the ARIA 1.2 combobox: the box keeps focus, the arrow keys move
// aria-activedescendant through the options, Enter opens the one marked, and
// the count is said in a status line of its own — the nav's find box does the
// same (nav-found), and a count is the result of the keystroke that made it.
// The shell is Modal's: Escape closes, Tab stays inside, focus goes back.
//
// Nothing runs at load. init.js's Ctrl+K calls open().
//
// Exposes: open, input, key, pick, results.
// Requires: core.js (state, TABS, esc, escAttr, announce, copyToClipboard),
//           app.js (prepareSearch, stationMatchesSearch, stationAlertIds,
//           goToStation, switchTab, setDockTab, navTerms, navHaystack,
//           navScore, resetStationFilters, newSearchRow, renderMain,
//           toggleTheme), modal.js, places.js, station-trail.js, route.js,
//           bug-report.js.

const Palette = (() => {
  const MAX_STATIONS = 8;
  const MAX_TABS = 5;

  let query = '';
  let items = [];        // the options on screen, in order
  let active = 0;        // index into items of the one Enter opens

  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // ── Stations ──────────────────────────────────────────────────────────────

  // Best first: an exact station number or ALERT address, then a name that
  // starts with what was typed, then one with a word that does, then the rest
  // — and alphabetical inside each, so the list does not reorder between two
  // keystrokes that leave the ranks alone.
  function rankStation(s, q) {
    const name = norm(s.name);
    if (norm(s.station_number) === q || (/^\d+$/.test(q) && stationAlertIds(s).some(id => String(id) === q))) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[^a-z0-9]+/).some(w => w && w.startsWith(q))) return 2;
    return 3;
  }

  function stationSub(s) {
    const bits = [];
    if (s.station_number) bits.push(`Stn ${s.station_number}`);
    const ids = stationAlertIds(s);
    if (ids.length) bits.push(`ALERT ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '…' : ''}`);
    if (s.basin) bits.push(s.basin);
    return bits.join(' · ');
  }

  function stationItems(q) {
    const data = state.data;
    if (!data || !Array.isArray(data.stations)) return { list: [], more: 0 };
    if (!q) {
      // The trail: what was looked at this session, latest first.
      const ids = typeof StationTrail !== 'undefined' && StationTrail.ids ? StationTrail.ids() : [];
      const list = ids.map(id => data.stations.find(s => s.id === id)).filter(Boolean).slice(0, 5)
        .map(s => ({ kind: 'station', icon: '📍', label: s.name, sub: `Looked at this session · ${stationSub(s)}`,
                     run: () => goToStation(s.id) }));
      return { list, more: 0 };
    }
    if (q.length < 2 && !/^\d$/.test(q)) return { list: [], more: 0 };
    const prep = prepareSearch(q);
    const hits = data.stations.filter(s => stationMatchesSearch(s, prep));
    hits.sort((a, b) => rankStation(a, q) - rankStation(b, q) || a.name.localeCompare(b.name));
    const list = hits.slice(0, MAX_STATIONS).map(s => ({
      kind: 'station', icon: '📍', label: s.name, sub: stationSub(s), run: () => goToStation(s.id),
    }));
    const more = hits.length - list.length;
    // The rest, as the Stations list would show them: the filter set to what
    // was typed. Always offered for an address window, whatever its size — a
    // window is a question about a block of stations, and the list is where
    // a block is read.
    if (more > 0 || (prep.ranges.length && hits.length)) {
      list.push({ kind: 'station', offer: true, icon: '🗒️', label: `All ${hits.length} matching stations`,
        sub: 'In the Stations list, the filter set to this', run: () => showAllStations(q) });
    }
    return { list, more };
  }

  function showAllStations(q) {
    resetStationFilters();
    state.filters.searches = [newSearchRow(q)];
    if (state.activeTab === 'stations') renderMain();
    else switchTab('stations');
  }

  // ── Places ────────────────────────────────────────────────────────────────

  function placeItems(raw) {
    const q = raw.trim();
    if (q.length < 3 || typeof Places === 'undefined') return [];
    const coord = Places.parse(q);
    if (coord && coord.lat != null) {
      return [{ kind: 'place', icon: '📌', label: `Go to ${stationLatLonText({ lat: coord.lat, lon: coord.lon })}`,
                sub: 'A coordinate — on the Stations map, with a blue pin', run: () => findPlace(q) }];
    }
    // Digits are a station number or an address, never a place name — the
    // same rule Places keeps before asking its gazetteer. Anything else is
    // offered rather than answered: whether it is a place is Find a place's to
    // say, so it is not counted as a match, and it comes last.
    if (/^[\d\s.,-]+$/.test(q)) return [];
    return [{ kind: 'place', offer: true, icon: '🧭', label: `Find “${q}” as a place`,
              sub: 'Towns, rivers and creeks, catchments and council areas — in 📍 Find a place',
              run: () => findPlace(q) }];
  }

  // The Stations tab, the side panel on Find a place, and the text typed into
  // its box as if it had been typed there — its list, its coordinate jump and
  // its gazetteer are all its own.
  function findPlace(q) {
    if (state.activeTab !== 'stations') switchTab('stations');
    setDockTab('places');
    const box = document.getElementById('places-q');
    if (!box) return;
    box.value = q;
    Places.input(q);
    box.focus({ preventScroll: true });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  function tabItems(q) {
    const terms = navTerms(q);
    if (!terms.length) return [];
    let best = 0;
    const scored = [];
    for (const g of TABS) {
      for (const tab of g.tabs) {
        const score = navScore(navHaystack(tab, g.group), terms);
        if (!score) continue;
        best = Math.max(best, score);
        scored.push({ tab, group: g.group, score, label: navScore(tab.label.toLowerCase(), terms) });
      }
    }
    return scored.filter(x => x.score === best)
      .sort((a, b) => b.label - a.label)
      .slice(0, MAX_TABS)
      .map(x => ({ kind: 'tab', icon: x.tab.icon, label: x.tab.label, sub: `Tab · ${x.group}`,
                   run: () => switchTab(x.tab.id) }));
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function actions() {
    const dark = state.theme === 'dark';
    return [
      { icon: '🗂️', label: 'Site Map — what every tab is for', find: 'site map guide tour overview help new start',
        run: () => switchTab('sitemap') },
      { icon: '❔', label: 'Help for this tab', find: 'help explain how this tab what',
        run: () => setDockTab('help') },
      { icon: '🔗', label: 'Copy a link to where you are', find: 'link copy share url address bookmark send',
        run: copyHere },
      { icon: '📂', label: 'Load a stations.json from this device', find: 'load open file stations json import device',
        run: () => { const f = document.getElementById('file-input'); if (f) f.click(); } },
      { icon: '📤', label: 'Export Radio Mobile CSVs', find: 'export csv radio mobile download networks backup',
        run: () => switchTab('export') },
      { icon: '🌗', label: dark ? 'Switch to the light theme' : 'Switch to the dark theme',
        find: 'theme dark light colour color night mode', run: () => toggleTheme() },
      { icon: '🐞', label: 'Report a bug or suggest an improvement', find: 'bug report problem issue feedback suggest broken',
        run: () => BugReport.open() },
    ];
  }

  function copyHere() {
    let url = location.href;
    try { url = new URL(location.pathname + location.search + location.hash, location.href).href; } catch (_) {}
    copyToClipboard(url).then(ok => announce(ok ? 'Copied a link to where you are' : 'Could not copy the link'));
  }

  function actionItems(q) {
    const all = actions().map(a => ({ ...a, kind: 'action', sub: 'Action' }));
    const terms = navTerms(q);
    if (!terms.length) return all;
    const scored = all.map(a => ({ a, score: navScore(`${a.label} ${a.find}`.toLowerCase(), terms) }))
      .filter(x => x.score > 0);
    const best = Math.max(0, ...scored.map(x => x.score));
    return scored.filter(x => x.score === best).map(x => x.a);
  }

  // ── The list ──────────────────────────────────────────────────────────────

  // Places last: a coordinate is the only thing a coordinate matches, so it
  // still comes first when it is typed, and a name offered to Find a place
  // must never be what Enter opens over a station, a tab or an action that
  // really did match.
  const GROUPS = [
    { key: 'station', title: 'Stations' },
    { key: 'tab',     title: 'Tabs' },
    { key: 'action',  title: 'Actions' },
    { key: 'place',   title: 'Places' },
  ];

  // Everything for a query, in the order the list draws it.
  function results(raw) {
    const q = norm(raw);
    const st = stationItems(q);
    return [
      ...st.list,
      ...tabItems(q),
      ...actionItems(q),
      ...placeItems(raw),
    ];
  }

  // What was found, as against what is offered: an offer is a way to look
  // further, not an answer, and a count that included it would never say
  // "nothing".
  const matches = () => items.filter(i => !i.offer);

  function countText() {
    const found = matches();
    if (!found.length) return query.trim() ? `Nothing matches “${query.trim()}”` : '';
    const by = GROUPS.map(g => [g.title, found.filter(i => i.kind === g.key).length])
      .filter(([, k]) => k).map(([t, k]) => `${k} ${k === 1 ? t.toLowerCase().replace(/s$/, '') : t.toLowerCase()}`);
    return by.join(', ');
  }

  function listHtml() {
    const none = !matches().length
      ? `<p class="pal-none small">${query.trim()
        ? `Nothing matches <strong>${esc(query.trim())}</strong>. A station's name, number or ALERT address; a coordinate; or a tab or an action.`
        : 'Nothing to offer yet.'}</p>`
      : '';
    let i = 0;
    return none + GROUPS.map(g => {
      const mine = items.filter(it => it.kind === g.key);
      if (!mine.length) return '';
      const gid = `pal-g-${g.key}`;
      return `<div role="group" aria-labelledby="${gid}" class="pal-group">
        <div class="pal-group-title" id="${gid}" role="presentation">${g.key === 'station' && !query.trim() ? 'Looked at this session' : g.title}</div>
        ${mine.map(it => {
          const n = i++;
          return `<div role="option" id="pal-opt-${n}" class="pal-opt" aria-selected="false" data-i="${n}"
               onmousedown="event.preventDefault()" onclick="Palette.pick(${n})"
               onmousemove="Palette.hover(${n})">
            <span class="pal-ico" aria-hidden="true">${it.icon}</span>
            <span class="pal-text"><span class="pal-label">${esc(it.label)}</span>
              ${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}</span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  }

  // The list in place of the last one, the box untouched — typing must not
  // rebuild the box it is being typed into (the nav's rule, navFind).
  function paint() {
    const list = document.getElementById('pal-list');
    if (list) list.innerHTML = listHtml();
    const box = document.getElementById('pal-q');
    if (box) box.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    const count = document.getElementById('pal-count');
    if (count) count.textContent = countText();
    mark();
  }

  // Which option Enter opens, moved without redrawing the list: a redraw under
  // a moving pointer replaces the option between its mousedown and its click.
  function mark() {
    const list = document.getElementById('pal-list');
    if (list) {
      for (const el of list.querySelectorAll('.pal-opt')) {
        const on = Number(el.dataset.i) === active;
        el.classList.toggle('is-active', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        const enter = el.querySelector('.pal-enter');
        if (on && !enter) el.insertAdjacentHTML('beforeend', '<span class="pal-enter" aria-hidden="true">↵</span>');
        else if (!on && enter) enter.remove();
      }
    }
    const box = document.getElementById('pal-q');
    if (box) {
      if (items.length) box.setAttribute('aria-activedescendant', `pal-opt-${active}`);
      else box.removeAttribute('aria-activedescendant');
    }
    const on = document.getElementById(`pal-opt-${active}`);
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function input(text) {
    query = String(text || '');
    items = results(query);
    active = 0;
    paint();
  }

  function move(by) {
    if (!items.length) return;
    active = (active + by + items.length) % items.length;
    mark();
  }

  function hover(n) {
    if (n === active || n < 0 || n >= items.length) return;
    active = n;
    mark();
  }

  function key(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); move(-1); return; }
    if (e.key === 'PageDown')  { e.preventDefault(); move(Math.min(5, items.length - 1 - active) || 0); return; }
    if (e.key === 'PageUp')    { e.preventDefault(); move(-Math.min(5, active) || 0); return; }
    if (e.key === 'Enter')     { e.preventDefault(); pick(active); }
  }

  // Closed first, then done: the dialog hands focus back to whatever opened
  // it, and only then does the thing picked move it on — to a tab's button,
  // a station's card, the place box — the way it would have from there.
  function pick(n) {
    const it = items[n];
    if (!it) return;
    Modal.close();
    it.run();
  }

  function open() {
    // Pressed again while it is up: back to the box, not a second dialog.
    const box = document.getElementById('pal-q');
    if (box) { box.focus(); box.select(); return; }
    query = '';
    Modal.open({
      title: 'Search',
      html: `
        <div class="pal">
          <input id="pal-q" class="pal-q" type="search" autocomplete="off" spellcheck="false"
                 role="combobox" aria-autocomplete="list" aria-controls="pal-list" aria-expanded="false"
                 aria-label="A station, a place, a tab or an action"
                 placeholder="A station, a place, a tab or an action…"
                 oninput="Palette.input(this.value)" onkeydown="Palette.key(event)">
          <div id="pal-list" class="pal-list" role="listbox" aria-label="Results"></div>
          <p id="pal-count" class="pal-count small txt-muted" role="status" aria-live="polite"></p>
          <p class="pal-hint small txt-muted">↑ ↓ to move · Enter to open · Esc to close</p>
        </div>`,
    });
    input('');
    const q = document.getElementById('pal-q');
    if (q) q.focus();
  }

  return { open, input, key, pick, hover, results };
})();
