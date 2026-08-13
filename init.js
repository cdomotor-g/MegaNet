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
  MemMeter.start();
  // Before autoLoad(), so that a tab returning from a magic link has taken the
  // session out of the URL fragment before anything else reads location.
  Auth.start();
  autoLoad();
})();

// Restore a shared investigation from the URL hash. Runs at script load (after
// init's first render); station data arrives later via autoLoad → loadJson,
// which re-renders the restored tab.
if (typeof window !== 'undefined') wbRestoreFromUrl();

