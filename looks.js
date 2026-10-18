// MegaNet — looks.js
//
//   Looks   how Flood-Net is laid out around its tabs — the banner, the bar
//           down the side, what a phone shows along its foot — as one choice
//           a person can make and take back: 🪷 Calm, the default since
//           October 2026, or 🗂️ Classic, the way it looked before.
//
// After core.js (state, LOOK_CHOICES, lookStored, announce, esc, escAttr),
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
// ── Adding a third ───────────────────────────────────────────────────────────
// A look is an entry in LOOKS below and in LOOK_CHOICES (core.js), and
// everything it changes is scoped to `:root[data-look="<id>"]` in styles.css
// and to `state.look === '<id>'` in the code that draws the shell —
// renderTabs() hands the bar to a look's own renderer the way it hands it to
// CalmShell now. Nothing about a look is stored but its id, so a look can be
// withdrawn without a migration: a browser holding an id nobody knows is
// handed the default, as lookStored() does for any other junk.
//
// Exposes: start, set, current, is, label, pickerHtml, introHtml, dismissIntro, LOOKS.

const Looks = (() => {
  const KEY = 'mn-look';
  // The one-time line under Calm's section bar for somebody who knew the old
  // look: what changed and the way back. Seen is remembered; so is choosing.
  const INTRO_KEY = 'mn-look-intro';

  // The order is the order the Theme dialog lists them in.
  const LOOKS = {
    calm: {
      label: 'Calm',
      hint: 'Fewer buttons and quieter colours. The groups down the side and one group\'s tabs across the '
          + 'top; ⋯ in the banner for the rest. On a phone, a bar along the bottom for a site visit.',
    },
    classic: {
      label: 'Classic',
      hint: 'Every tab listed down the side and every button in the banner, as Flood-Net looked until '
          + 'October 2026.',
    },
  };

  const current = () => state.look;
  const is = id => state.look === id;
  const label = (id = state.look) => (LOOKS[id] ? LOOKS[id].label : id);

  function apply() {
    document.documentElement.setAttribute('data-look', state.look);
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
    // The forecast outlines follow the look for a browser that has not said
    // what it wants of them (core.js, mapPinSls).
    let sls = null;
    try { sls = localStorage.getItem('mn-pin-sls'); } catch (_) {}
    if (sls == null) state.mapPinSls = id !== 'calm';
    // A phone's drawer belongs to the bar being replaced; the new one opens
    // shut.
    if (typeof isPhoneNav === 'function' && isPhoneNav()) state.navCollapsed = true;
    renderTabs();
    renderHelp({ instant: true, remeasure: false });
    renderMain();
    updateChromeHeight();
    invalidateMapSizes(NAV_TRANSITION_MS + 40);
    const picker = document.getElementById('look-pick');
    if (picker) picker.querySelectorAll('input').forEach(r => { r.checked = r.value === id; });
    announce(`Look: ${label(id)}`);
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
        <span>Flood-Net has a calmer look: the same tabs, filed under their groups, and fewer buttons in the
          banner. Prefer the old one?</span>
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

  return { start, set, current, is, label, pickerHtml, introHtml, dismissIntro, LOOKS };
})();
if (typeof window !== 'undefined') window.Looks = Looks;
