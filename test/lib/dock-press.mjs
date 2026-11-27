// Opening a side-panel pane the way a person does now that the Stations tab's
// rail goes by job (app.js, DOCK_JOBS): 📍 Stations, 🔎 Places, 📻 Radio and
// 🚩 Site in the rail; a Radio or Site tool from its job's list; a Find a
// better site tool from that family's tabs; and Layers, Imagery over time,
// the Legend and Latency & signal from 🗺️ Map look on the map and the tabs at
// the top of its panes.
//
// pressDock(page, key) is a real click on the button that stands for `key`
// once whatever leads to it has been pressed — so where a check used to press
// a pane's button in the strip, it presses the same button where it is now.
// A pane already showing has its own button on screen, and pressing it does
// what it always did: shuts the side panel.

export async function pressDock(page, key) {
  const own = `#help-panel [data-dock="${key}"]:is(.dock-tab, .dock-job)`;
  const route = await page.evaluate((k) => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    if (vis(document.querySelector(`#help-panel [data-dock="${k}"]:is(.dock-tab, .dock-job)`))) return [];
    const job = typeof dockJobOf === 'function' ? dockJobOf(k) : null;
    if (job === 'look') return ['.mn-map-look'];
    if (!job) return [];
    const fam = dockFamilyOf(k);
    return [`#help-panel .dock-strip .dock-tab[data-dock="${job}"]`]
      .concat(fam ? [`#help-panel .dock-job[data-dock="${fam}"]`] : []);
  }, key);
  for (const step of route) {
    await page.click(step);
    await page.waitForTimeout(150);
  }
  // The way there may have opened it already (Map look opens the pane it
  // showed last; Find a better site, likewise).
  if (route.length && await page.evaluate((k) => dockShowing() === k, key)) return;
  await page.click(own);
}

// The button that stands for `key` now, for a check that focuses it rather
// than clicking: everything that leads to it is pressed first, as above, and
// its selector is returned.
export async function reachDock(page, key) {
  const own = `#help-panel [data-dock="${key}"]:is(.dock-tab, .dock-job)`;
  const shown = await page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, own);
  if (!shown) {
    await pressDock(page, key);
    await page.waitForTimeout(150);
  }
  return own;
}
