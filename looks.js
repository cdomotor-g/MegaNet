// MegaNet — looks.js
//
//   Looks   how Flood-Net is laid out around its tabs — the banner, the bar
//           down the side, what a phone shows along its foot — as one choice
//           a person can make and take back: 🪷 Calm, the default since
//           October 2026; three drawn in pictures — 🔲 Tiles, 🎚️ Instrument
//           and 🪧 Signs; or 🗂️ Classic, the way it looked before.
//
// After core.js (state, LOOK_CHOICES, lookStored, CALM_MAP_OFF, mapLayerStored,
// announce, esc, escAttr),
// before init.js. Reaches across to app.js for renderTabs, renderHelp,
// renderMain, updateChromeHeight, invalidateMapSizes and refreshMapLayers,
// and to route.js for Route.newDevice — all at call time, so this file's
// position among the modules is free. Nothing runs at load
// (`npm run toplevel`); init.js calls start().
//
// ── Why there are two ────────────────────────────────────────────────────────
// People using the app said it was too much at once: forty-odd tabs listed
// down the side, six buttons in a blue banner, an emoji on every line, and a
// map ringed in four colours. Nothing in that list was wrong on its own, and
// every piece of it was asked for — which is why the answer is a second way of
// laying the same app out rather than a cull. Calm (calm-shell.js) files the
// tabs under their groups and shows one group's tabs at a time, keeps three
// things in the banner and puts the rest behind ⋯, and on a phone gives a site
// visit a bar of its own along the foot. Every tab, every action and every
// address is the same in both: a look changes what is in front of you, not
// what the app can do.
//
// Classic stays, whole, for anybody who had learnt where everything was. It is
// one pick away from either look — Theme in the banner (Classic), ⋯ → Theme &
// look (Calm), Ctrl+K → "classic" — and an address can carry it,
// `?look=classic`, which is the way back for somebody who cannot find the
// switch and the way the browser checks pin it (test/lib/browser.mjs).
//
// ── The three in pictures ────────────────────────────────────────────────────
// Asked for after Calm, by the same people: an app read at a glance rather
// than read. Each is Calm's shell with the line drawings swapped for
// pictograms (glyphs.js) — a tab, a group and a station's state each a
// picture — and 🏠 Home (home.js) as the front page they open on:
//   🔲 Tiles       light, a coloured tile per tool, every tool on Home.
//   🎚️ Instrument  a dark frame round the map: the groups a rail of pictures,
//                  the network's OK / watch / fault counts across the banner
//                  and the pins coloured by health on a dark ground.
//   🪧 Signs       black on yellow and large, for full sun and a gloved
//                  thumb: Home six signs, the inspection sheet a row of them.
// They share everything Calm does (lookUsesCalmShell, core.js) and each other's
// pictures (lookHasSymbols); what is a look's own is in styles.css under
// `:root[data-look="<id>"]`, and the map's base and health pins it starts with
// (addBaseLayers, mapHealthStored).
//
// ── Adding another ───────────────────────────────────────────────────────────
// A look is an entry in LOOKS below and in LOOK_CHOICES (core.js). Everything
// Calm's shell draws is scoped to `:root[data-shell="calm"]` in styles.css,
// which every look but Classic wears; what one look changes is scoped to
// `:root[data-look="<id>"]`. Nothing about a look is stored but its id, so a
// look can be withdrawn without a migration: a browser holding an id nobody
// knows is handed the default, as lookStored() does for any other junk.
//
// Exposes: start, set, current, is, label, pickerHtml, introHtml, dismissIntro,
//          layersOff, layersNoteHtml, layersOn, LOOKS.

const Looks = (() => {
  const KEY = 'mn-look';
  // The one-time line under Calm's section bar for somebody who knew the old
  // look: what changed and the way back. Seen is remembered; so is choosing.
  const INTRO_KEY = 'mn-look-intro';

  // The Theme dialog lists them in LOOK_CHOICES' order. `brief` and `find`
  // are Ctrl+K's (palette.js): what the switch is said to do, and the words
  // that find it.
  const LOOKS = {
    calm: {
      label: 'Calm', icon: '🪷',
      hint: 'Fewer buttons and quieter colours. The groups down the side and one group\'s tabs across the '
          + 'top; ⋯ in the banner for the rest. On a phone, a bar along the bottom for a site visit.',
      brief: 'the groups down the side, fewer buttons',
      find: 'calm new quieter',
    },
    tiles: {
      label: 'Tiles', icon: '🔲',
      hint: 'Calm, in pictures: a coloured tile with a drawing on it for every tool, and 🏠 Home to start '
          + 'from — the things used most as big tiles, how the network is right now across the top, and '
          + 'every other tool under them.',
      brief: 'a coloured tile for every tool, and 🏠 Home',
      find: 'tiles icons symbols pictures pictograms launcher colourful colorful',
    },
    instrument: {
      label: 'Instrument', icon: '🎚️',
      hint: 'A dark frame round the network: the groups as a rail of pictures, how many stations are OK, on '
          + 'watch or at fault across the banner, and the Stations map on a dark ground with every pin '
          + 'coloured by its health.',
      brief: 'a dark frame, the network\'s state across the banner',
      find: 'instrument cockpit control room dark panel symbols pictures status at a glance',
    },
    signs: {
      label: 'Signs', icon: '🪧',
      hint: 'Black on yellow, thick edges and large type — every button a sign, to read in full sun and '
          + 'press with a glove. 🏠 Home is six big signs; on a phone the inspection sheet is a row of '
          + 'them, a section at a time.',
      brief: 'black on yellow and large, for full sun',
      find: 'signs high contrast large big buttons glove yellow symbols pictures',
    },
    classic: {
      label: 'Classic', icon: '🗂️',
      hint: 'Every tab listed down the side and every button in the banner, as Flood-Net looked until '
          + 'October 2026.',
      brief: 'every tab in the bar, every button in the banner',
      find: 'classic old back previous',
    },
  };

  const current = () => state.look;
  const is = id => state.look === id;
  const label = (id = state.look) => (LOOKS[id] ? LOOKS[id].label : id);

  // `data-look` is the look; `data-shell` is whose bar it is drawn with — the
  // stylesheet's Calm rules are written once, for every look that uses it.
  function apply() {
    const root = document.documentElement;
    root.setAttribute('data-look', state.look);
    root.setAttribute('data-shell', lookUsesCalmShell() ? 'calm' : 'classic');
  }

  // Called once from init.js, after Route.start() (which has to see the
  // address as it arrived) and before the first render. An address that names
  // a look is a choice, the same as picking it: stored, and then taken out of
  // the address, so that a link copied from here on does not carry it on to
  // somebody who never asked for it.
  function start() {
    let q = null;
    try { q = new URLSearchParams(location.search); } catch (_) {}
    const asked = q && q.get('look');
    if (q && q.has('look')) {
      if (LOOK_CHOICES.includes(asked)) {
        try { localStorage.setItem(KEY, asked); localStorage.setItem(INTRO_KEY, 'seen'); } catch (_) {}
      }
      q.delete('look');
      const rest = q.toString();
      try {
        history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
      } catch (_) {}
    }
    // A device opening Flood-Net for the first time has nothing to compare
    // Calm with, so it is never told that this is new — the same rule
    // What's new follows (whats-new.js). Written now, because by its second
    // visit it is no longer a new device and could not be told apart from
    // one that had used Classic for a year.
    if (typeof Route !== 'undefined' && Route.newDevice()) {
      try { localStorage.setItem(INTRO_KEY, 'seen'); } catch (_) {}
    }
    apply();
  }

  // Everything the shell draws is drawn again, at once, in the new look — the
  // bar, the side panel and the tab — because half a page in each is not a
  // page in either. The tab is drawn again too, not only re-measured: a tab
  // may lay itself out by the look (the Inspections sheet steps a section at a
  // time on a phone under Calm), and the Stations map is rebuilt at the width
  // the new bar leaves it rather than stretched to it.
  function set(id) {
    if (!LOOK_CHOICES.includes(id) || id === state.look) return;
    state.look = id;
    try { localStorage.setItem(KEY, id); localStorage.setItem(INTRO_KEY, 'seen'); } catch (_) {}
    apply();
    // The Stations map's context layers follow the look for a browser that
    // has not said what it wants of them (core.js, CALM_MAP_OFF) — and so do
    // its links' colouring (mapLinkColourFromStorage), its pins' health
    // colours (mapHealthStored) and its base map (addBaseLayers), all taken
    // up by the map being built again below.
    for (const [key, store] of CALM_MAP_OFF) state[key] = mapLayerStored(store);
    state.mapLinkColour = mapLinkColourFromStorage();
    state.mapFade = state.mapLinkColour === 'fade';
    state.mapHealth = mapHealthStored();
    // A phone's drawer belongs to the bar being replaced; the new one opens
    // shut. Instrument's bar is a rail of pictures, and starts as one — »
    // at its top still opens it, and that is remembered as it always was.
    if (typeof isPhoneNav === 'function' && isPhoneNav()) state.navCollapsed = true;
    else if (id === 'instrument') state.navCollapsed = true;
    renderTabs();
    renderHelp({ instant: true, remeasure: false });
    renderMain();
    updateChromeHeight();
    invalidateMapSizes(NAV_TRANSITION_MS + 40);
    const picker = document.getElementById('look-pick');
    if (picker) picker.querySelectorAll('input').forEach(r => { r.checked = r.value === id; });
    announce(`Look: ${label(id)}`);
  }

  // ── The map's layers under Calm ─────────────────────────────────────────
  // What the Calm look (or one of the three it shares its map with) left off
  // the Stations map and is still off, named, for the line at the top of
  // 🗺️ Map display (mapDisplayControlsHtml, app.js) — empty under Classic,
  // and once every one of them is on.
  function layersOff() {
    if (!lookUsesCalmShell()) return [];
    return CALM_MAP_OFF.filter(([key]) => !state[key]).map(([, , name]) => name);
  }

  function layersNoteHtml() {
    const off = layersOff();
    if (!off.length) return '';
    return `
      <div class="mapd-calm" id="map-display-calm">
        <p class="filter-note">The ${esc(label())} look starts the map quiet: ${esc(off.join(', '))} ${off.length === 1 ? 'is' : 'are'}
          off until ticked below.</p>
        <button type="button" class="link-btn" onclick="Looks.layersOn()">Turn ${off.length === 1 ? 'it' : 'them all'} on</button>
      </div>`;
  }

  // Every one of them on, and remembered as on — the same as ticking each —
  // and the map built again with them.
  function layersOn() {
    for (const [key, store] of CALM_MAP_OFF) {
      state[key] = true;
      try { localStorage.setItem(store, 'on'); } catch (_) {}
    }
    if (state.activeTab === 'stations') renderMain();
    announce('The map\'s layers are all on, and will be next time.');
  }

  // The radios, for the Theme dialog (openThemeMenu, app.js): a pick applies
  // at once and the dialog stays, as a theme's does, so the two can be
  // compared on the page behind it.
  function pickerHtml() {
    return `
      <fieldset class="theme-pick look-pick" id="look-pick">
        <legend>Look</legend>
        ${LOOK_CHOICES.map(id => `
        <label class="theme-opt">
          <input type="radio" name="mn-look-pick" value="${id}"${state.look === id ? ' checked' : ''}
                 onchange="Looks.set(this.value)">
          <span class="theme-opt-text"><strong>${esc(label(id))}</strong>
            <span class="small txt-muted">${esc(LOOKS[id].hint)}</span></span>
        </label>`).join('')}
      </fieldset>`;
  }

  // Due once, under Calm, on a device that has been here before and has not
  // chosen a look: it is the only device that can be surprised by this one.
  function introDue() {
    if (state.look !== 'calm') return false;
    try { return !localStorage.getItem(KEY) && !localStorage.getItem(INTRO_KEY); }
    catch (_) { return false; }
  }

  function introHtml() {
    if (!introDue()) return '';
    return `
      <div class="look-intro" role="note">
        <span>Flood-Net has a calmer look: the same tabs, filed under their groups, fewer buttons in the
          banner, and a quieter map — Layers, in the side panel, turns them back on. Prefer the old look?</span>
        <button type="button" class="link-btn" onclick="Looks.set('classic')">Switch back to Classic</button>
        <button type="button" class="look-intro-x" onclick="Looks.dismissIntro()"
                aria-label="Keep the calm look and hide this note" title="Keep this look">×</button>
      </div>`;
  }

  function dismissIntro() {
    try { localStorage.setItem(INTRO_KEY, 'seen'); } catch (_) {}
    const el = document.querySelector('.look-intro');
    if (el) el.remove();
    // The button that had focus went with the note; the section's own tabs
    // are the next thing along.
    const next = document.querySelector('#section-bar .tab-btn.active') || document.getElementById('main-content');
    if (next) next.focus();
  }

  return { start, set, current, is, label, pickerHtml, introHtml, dismissIntro, layersOff, layersNoteHtml, layersOn, LOOKS };
})();
if (typeof window !== 'undefined') window.Looks = Looks;
