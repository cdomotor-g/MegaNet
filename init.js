// MegaNet — init.js
//
// The top of the app.js lineage (#129 M1 / #132), and the only file in it that
// *does* anything at load. Everything else declares; this starts the app.
//
// It must stay last in index.html, and it must stay the only place with
// top-level side effects. That is not a style preference — it is what retires a
// whole class of crash. While init() ran from partway down app.js, every
// binding declared after it was in its temporal dead zone on the way past, and
// two of those were already live faults (#131): renderHelp → docUrl reached
// GITHUB_RAW_URL sixty lines before it existed, and renderMain → initMap
// reached the six map module consts thousands of lines before they existed.
// Both were latent rather than fatal only because of which tab happened to be
// default and because station data arrives asynchronously. Running last means
// every top-level binding in every earlier file is initialised before anything
// here is evaluated, so the class is gone by construction rather than by luck.
//
// Nothing should be added to this file that is not part of starting up. A
// helper defined here is a helper the modules cannot see.
//
// Exposes: nothing. Requires: core.js and every module file before it.

// ── Init ───────────────────────────────────────────────────────────────────────

(function init() {
  document.documentElement.setAttribute('data-theme', state.theme);
  setHeaderLabel('btn-theme', state.theme === 'dark' ? 'Light' : 'Dark');
  renderTabs();
  renderHelp();
  renderMain();
  // The header's height and the shape of both rails depend on the width, so all
  // three are re-checked when it changes — crossing the phone breakpoint with a
  // drawer open would otherwise leave its backdrop behind. The side panel's
  // width is re-clamped with them: its widest is whatever leaves the page its
  // share of this window, which a narrower window has less of. Instant, so the
  // clamp does not slide behind a window that is being dragged.
  window.addEventListener('resize', () => {
    updateChromeHeight();
    syncNavChrome(state.navCollapsed);
    syncHelpChrome();
    renderDock({ instant: true });
  });
  // Crossing the phone breakpoint changes what the two rails *are* — columns or
  // drawers — and so what their toggles should say. Re-rendered on the crossing
  // itself rather than on every resize event. MapChrome is asked again where
  // the Stations map's controls belong, and asked *before* the side panel is
  // painted: a control moving takes focus with it (MapChrome's relocate), and
  // it can only do that while the strip button it is leaving is still there.
  // (The answer is the side panel's strip at every width now, a phone's rail
  // included, so nothing moves; the question is still the host's to answer.)
  //
  // And the maps are measured again once the crossing has settled. The nav's
  // rail comes out of the row or goes back into it here, sliding as it does
  // (styles.css, #tab-nav), and Leaflet only watches the window: it measured
  // itself on the resize, against a page still carrying the rail's width, and
  // nothing after that told it otherwise — a phone turned on its side (390 px
  // to 844, and back) left the Stations map 56 px out, clicks landing that far
  // from where they were aimed.
  window.matchMedia(`(max-width: ${BREAKPOINTS.xs}px)`).addEventListener('change', () => {
    renderTabs();
    if (state.map) MapChrome.redock(state.map);
    renderHelp();
    invalidateMapSizes(NAV_TRANSITION_MS + 40);
  });
  // Crossing `lg` folds the Stations cards back under the map and unfolds them
  // into the side panel again, without the setting moving either way — and the
  // station table's columns follow the *layout*, not the setting: five of them
  // in the side panel, ten of them across the page. Same reasoning as the rail
  // above, and the same shape: the crossing moves the cards and repaints the
  // table, the 300 resize events between two crossings do not.
  window.matchMedia(`(max-width: ${BREAKPOINTS.lg}px)`).addEventListener('change', stationsLayoutChanged);
  // On a phone both rails are drawers laid over the page, and a drawer that
  // only closes by picking a tab is a trap — Escape backs out of either: the
  // nav's, or whichever pane the side panel has open (help, or one of the
  // Stations map's panels beside its rail).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isPhoneNav()) return;
    // …and stand down for a key already claimed: a dialog opened over a drawer
    // (help's "Read more" can open one) takes its Escape in the capture phase,
    // and one press should close the dialog, not the drawer under it as well.
    if (e.defaultPrevented) return;
    // Claim the key only when a drawer actually closes (the Modal contract):
    // the fullscreen map's Escape stands down for a claimed key, and an
    // Escape that closed nothing here should still be free to mean something
    // to whoever else is listening.
    const drawer = dockDrawerOpen();
    if (!state.navCollapsed || drawer) e.preventDefault();
    if (!state.navCollapsed) setNavCollapsed(true);
    if (drawer)              dockDrawerClose();
  });
  // Ctrl/Cmd+K — jump to a tab without going to the nav to find it (#108).
  // Registered here rather than on the nav because the whole value of it is that
  // it works from wherever you are, including with the rail collapsed and on a
  // phone where the nav is not on screen at all. preventDefault() because
  // Firefox gives the same chord to its search bar.
  document.addEventListener('keydown', e => {
    if ((e.key !== 'k' && e.key !== 'K') || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    focusNavFind();
  });
  MemMeter.start();
  // Before autoLoad(), so that a tab returning from a magic link has taken the
  // session out of the URL fragment before anything else reads location.
  Auth.start();
  autoLoad();
})();

// Restore a shared investigation from the URL hash. Defined in workbench.js,
// called from here because it has to run after init's first render — it
// switches to the Workbench and renders it, and doing that before init has set
// the theme renders the tab into a page that isn't ready for it. While init() ran from partway down app.js this call sat at its own
// position further down and got that ordering for free; now it has to say so.
// Station data arrives later via autoLoad → loadJson, which re-renders the
// restored tab.
if (typeof window !== 'undefined') Workbench.restoreFromUrl();

