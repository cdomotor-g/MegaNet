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
  setSplitWidth(state.splitW);          // also clamps whatever was stored
  renderTabs();
  renderHelp();
  renderMain();
  // The header's height and the shape of both rails depend on the width, so all
  // three are re-checked when it changes — crossing the phone breakpoint with a
  // drawer open would otherwise leave its backdrop behind.
  window.addEventListener('resize', () => {
    updateChromeHeight();
    syncNavChrome(state.navCollapsed);
    syncHelpChrome(state.helpCollapsed);
  });
  // Crossing the phone breakpoint changes what the two rails *are* — columns or
  // drawers — and so what their toggles should say. Re-rendered on the crossing
  // itself rather than on every resize event: both are rebuilt wholesale.
  window.matchMedia('(max-width: 560px)').addEventListener('change', () => {
    renderTabs();
    renderHelp();
  });
  // On a phone both rails are drawers laid over the page, and a drawer that
  // only closes by picking a tab is a trap — Escape backs out of either.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isPhoneNav()) return;
    if (!state.navCollapsed)  setNavCollapsed(true);
    if (!state.helpCollapsed) setHelpCollapsed(true);
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
// the theme and the split width renders the tab into a page that isn't ready
// for it. While init() ran from partway down app.js this call sat at its own
// position further down and got that ordering for free; now it has to say so.
// Station data arrives later via autoLoad → loadJson, which re-renders the
// restored tab.
if (typeof window !== 'undefined') Workbench.restoreFromUrl();

