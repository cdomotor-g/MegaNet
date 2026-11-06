// MegaNet — map-mode.js
//
//   MapMode   the banner on the Stations map that says which mode the map is
//             in — while a click on the map, or on a station pin, does
//             something other than open that station — what a click does now,
//             and how to leave: ✕, or Escape.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and esc; across, at runtime only, to the
// modules whose modes it names (MapDraw, MapMovePin, SiteFeatures, LinkBudget,
// MapHere, Places, MapBestRepeater, MapDrive) through their public functions, and to
// modal.js's #app-modal. Nothing executes at load (`npm run toplevel`).
// initMap() attaches it, stopStationsMap() detaches it, and each of those
// modules calls MapMode.sync() where its mode goes on or off.
//
// ── Why ──────────────────────────────────────────────────────────────────────
// The map has eight ways to be in a mode, and only some said so on the map
// itself. A draw tool turns the station pins off; the link budget's card,
// while it is open, picks its ends off the next pin clicked; moving a pin,
// placing a site feature, What's here, the Best repeater pick and the drive's
// start each take the next click on the map. With nothing over the map naming
// the mode, a pin that did not open looked like a broken map, and the way out
// was a reload. (The bug report of 5 November 2026 that asked for this was a
// bug, fixed in map-direct.js — but it showed how a mode reads from outside:
// exactly like that.) So a mode now
// says itself: a banner in the second row of the map, under the zoom buttons,
// the station trail and ↺, with ✕ and "Esc leaves".
//
// ── What counts ──────────────────────────────────────────────────────────────
// A mode is what changes what a click does. Not a view (⛰️ 3-D, the twin, a
// colouring), not a card being open. DriveMode is one, but it has its own
// full-screen HUD with ✕ End and hides everything else on the stage
// (.is-driving), so it is left to it.
//
// ── Leaving ──────────────────────────────────────────────────────────────────
// ✕ calls the mode's own way out — the same function its own panel's button
// calls, so a draft about to be thrown away is asked about first, the way it
// always was (SiteFeatures.stop). Escape: five of the modes already take it
// themselves, and this leaves them to it. What's here and the Best repeater
// pick did not, so this takes it for them — in the capture phase, so that it
// is ahead of the full-screen map's Escape and one press does one thing; it
// claims the key with preventDefault, the app's convention, and stands back
// while a dialog is open, while the key is meant for a box being typed in,
// and while a mode that takes Escape itself is on (that one goes first).
//
// ── Where it sits ────────────────────────────────────────────────────────────
// #map-mode, beside #map-note in the stage (app.js): the row under the top
// row (zoom, station trail, ↺), the width the twin's offer is. While it is up
// the note — where the draw tools put their how-to — stands just under it,
// and the twin's offer stands down, as it already does for site features. On
// a phone it runs the width of the map under the zoom buttons. It takes the
// pointer only on itself.
const MapMode = (function () {
  let map = null;
  let el = null;
  let shownKey = '';
  let queued = false;
  let keyOn = false;

  // The draw tools' how-to stays where MapDraw puts it, in #map-note, which
  // stands under the banner while it is up: the banner says what the tool
  // costs, not how to use it again.
  const DRAW = {
    pin:    ['📍', 'Dropping pins'],
    line:   ['✏️', 'Drawing a line'],
    circle: ['✏️', 'Drawing a circle'],
    rect:   ['✏️', 'Drawing a rectangle'],
    text:   ['✏️', 'Adding a note'],
  };
  const NO_PINS = 'station pins can’t be opened until you leave';
  const PINS_OFF = 'Station pins can’t be opened until you leave';

  const nameOf = id => {
    const s = id && state.data && (state.data.stations || []).find(x => x.id === id);
    return s ? s.name : 'the station';
  };
  const classOn = c => !!map && map.getContainer().classList.contains(c);

  // Every mode, in the order they are listed when more than one is on. `on`
  // answers null or what the banner says; `own` is whether the mode already
  // takes Escape itself; `leave` is its own way out, safe to call twice. Each
  // names its module directly (a top-level const is not on window) and runs
  // inside a try, so a module that is not on this page is a mode that is off.
  const MODES = [
    {
      key: 'draw', own: true,
      on() {
        const t = state.draw && state.draw.tool;
        if (!t) return null;
        const [icon, title] = DRAW[t] || ['✏️', 'Drawing'];
        // A line has no last click: Enter ends it (MapDraw's onKey), and a
        // keyboard is where that is news. A finger has Finish line in the panel
        // and the double-tap the note under the banner gives.
        if (t === 'line') return { icon, title, how: 'click each corner', keys: ', then press Enter to finish the line',
                                   tail: `. ${PINS_OFF}.` };
        return { icon, title, how: `clicks on the map draw; ${NO_PINS}.` };
      },
      leave() { MapDraw.setTool(''); },
    },
    {
      key: 'movepin', own: true,
      on() {
        const id = MapMovePin.armed();
        if (!id) return null;
        return { icon: '📍', title: `Moving ${nameOf(id)}’s pin`,
                 how: 'drag it or click where it goes, then Save in its panel.' };
      },
      leave() { MapMovePin.cancel(); },
    },
    {
      key: 'sitefeatures', own: true,
      on() {
        const id = SiteFeatures.armed();
        if (!id) return null;
        const title = `Site features at ${nameOf(id)}`;
        if (classOn('mn-sf-drawing')) return { icon: '🧰', title, how: 'click the map for each point of the line',
                                               keys: ', then press Enter to finish it', tail: `. ${PINS_OFF}.` };
        if (classOn('mn-sf-placing')) return { icon: '🧰', title, how: `click the map where the feature is; ${NO_PINS}.` };
        return { icon: '🧰', title, how: 'add or change them in its panel.' };
      },
      leave() { SiteFeatures.stop(); },
    },
    {
      key: 'linkpick', own: true,
      on() {
        const L_ = state.link;
        if (!L_ || !L_.picking || (state.draw && state.draw.tool)) return null;
        const end = L_.target === 'a' || L_.target === 'b' ? `end ${L_.target.toUpperCase()}` : 'the next end';
        return { icon: '〽️', title: 'Picking the link budget’s ends',
                 how: `a click on a station or the map sets ${end}, not the station’s card.` };
      },
      leave() { LinkBudget.setPicking(false); },
    },
    {
      key: 'here', own: false,
      on() {
        if (!MapHere.armed()) return null;
        return { icon: 'ℹ️', title: 'What’s here?', how: 'click the map to see what’s known about that spot.' };
      },
      leave() { MapHere.arm(false); },
    },
    {
      key: 'places', own: false,
      on() {
        if (!Places.dropping()) return null;
        return { icon: '📍', title: 'Dropping pins', how: 'each click or tap on the map leaves a numbered pin there; station pins still open.' };
      },
      leave() { Places.arm(false); },
    },
    {
      key: 'bestrep', own: false,
      on() {
        if (!MapBestRepeater.armed()) return null;
        return { icon: '🎯', title: 'Best repeater', how: 'click the map where the new station would go.' };
      },
      leave() { MapBestRepeater.arm(false); },
    },
    {
      key: 'drive', own: true,
      on() {
        if (!MapDrive.picking()) return null;
        return { icon: '🛣️', title: 'Where does the drive start?',
                 how: `click the map where it starts; ${NO_PINS}.` };
      },
      leave() { MapDrive.choose(); },
    },
  ];

  function current() {
    if (!map) return [];
    const out = [];
    for (const m of MODES) {
      let said = null;
      try { said = m.on(); } catch (_) { said = null; }
      if (said) out.push({ ...said, key: m.key, own: m.own });
    }
    return out;
  }

  function stage() { return el && el.parentElement; }

  function render() {
    el = document.getElementById('map-mode');
    if (!el) return;
    const on = current();
    const key = JSON.stringify(on);
    if (key === shownKey) return;
    shownKey = key;
    const st = stage();
    if (!on.length) {
      // Focus on a ✕ that is going goes to the map it stood on.
      const hadFocus = el.contains(document.activeElement);
      el.hidden = true;
      el.innerHTML = '';
      if (st) { st.classList.remove('has-map-mode'); st.style.removeProperty('--map-mode-h'); }
      if (hadFocus && map) map.getContainer().focus({ preventScroll: true });
      syncKey(false);
      return;
    }
    el.innerHTML = on.map(m => `
      <div class="map-mode-row" data-mode="${esc(m.key)}">
        <span class="map-mode-what"><span aria-hidden="true">${esc(m.icon)}</span>
          <strong>${esc(m.title)}</strong> — ${esc(m.how)}${m.keys ? `<span class="map-mode-key">${esc(m.keys)}</span>` : ''}${esc(m.tail || '')}</span>
        <span class="map-mode-esc"><kbd>Esc</kbd> leaves</span>
        <button type="button" class="map-mode-x" data-mode="${esc(m.key)}"
                aria-label="Leave: ${esc(m.title)}" title="Leave: ${esc(m.title)}">✕</button>
      </div>`).join('');
    el.hidden = false;
    if (st) {
      st.classList.add('has-map-mode');
      st.style.setProperty('--map-mode-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    }
    syncKey(on.some(m => !m.own));
  }

  function leave(key) {
    const m = MODES.find(x => x.key === key);
    if (!m) return;
    try { m.leave(); } catch (_) { /* its own panel still has its own way out */ }
    sync();
  }

  function onClick(e) {
    const b = e.target.closest && e.target.closest('.map-mode-x');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    leave(b.dataset.mode);
  }

  // Escape, for the modes that do not take it themselves.
  function onKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const modal = document.getElementById('app-modal');
    if (modal && modal.style.display !== 'none' && modal.offsetParent !== null) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]')) return;
    const on = current();
    if (!on.length || on.some(m => m.own)) return;
    e.preventDefault();
    for (const m of on) leave(m.key);
  }

  function syncKey(want) {
    if (want && !keyOn) { document.addEventListener('keydown', onKey, true); keyOn = true; }
    else if (!want && keyOn) { document.removeEventListener('keydown', onKey, true); keyOn = false; }
  }

  // Something may have gone on or off: looked at once, after whatever is
  // running now has finished, however many modules said so.
  function sync() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; render(); });
  }

  return {
    attach(m) {
      map = m;
      shownKey = '';
      el = document.getElementById('map-mode');
      if (el && !el.dataset.wired) { el.addEventListener('click', onClick); el.dataset.wired = '1'; }
      sync();
    },
    detach() {
      map = null;
      shownKey = '';
      syncKey(false);
      const e = document.getElementById('map-mode');
      if (e) { e.hidden = true; e.innerHTML = ''; }
      const st = e && e.parentElement;
      if (st) st.classList.remove('has-map-mode');
    },
    sync,
    leave,
    // Read by the check: the modes the banner is showing, by key.
    shown: () => current().map(m => m.key),
  };
})();
if (typeof window !== 'undefined') window.MapMode = MapMode;
