// The side panel (#help-panel, "the dock"): one resizable, vertically tabbed
// column on the right that holds the help, the Stations cards and any map panel
// pinned into it.
//
// It replaced two things that each had checks of their own — the help rail
// (`shell`, `help`) and the Stations tab's right-hand column of cards
// (`maplinks` §9) — and those checks still hold the parts of the contract they
// always held: one labelled <aside>, the ❔ toggle's aria-expanded, a help pane
// that scrolls every link into reach, a walkthrough that scales. What none of
// them can see is the dock *as a dock*, and every assertion here is about a
// seam that only exists because it is one:
//
//   1. **Where a fresh visit lands.** On the Stations tab at 1440 the cards are
//      in the side panel and showing, and ❔ says Help is not; on any other tab
//      the panel is shut, because the pane it prefers is not there.
//   2. **Panes and buttons.** Help and back, and the showing pane's own button
//      shutting the panel — measured as the map getting the width, and as
//      Leaflet having been told (a map that is wider than Leaflet thinks takes
//      clicks in the wrong place and says nothing about it).
//   3. **The width handle is a real separator** — role, orientation, a value in
//      px with its range, focusable with a ring — that a real pointer drags,
//      that the keys move, that clamps, and whose width survives a reload.
//   4. **Leaving the tab leaves nothing behind.** The Stations button and every
//      card go with the tab, and no card id is ever on the page twice — the
//      failure that would be silent: getElementById finds the stale copy first
//      and the app paints into a card nobody can see.
//   5. **Pinning moves the panel, whole.** Map display, Draw & measure and the
//      repeater site finder go into the side panel with their icon, heading,
//      pin and body; the side panel opens on the one just pinned; a real click
//      inside works; the map being rebuilt (a tab switch and back) docks them
//      again; unpinning puts one back in the corner, shut, with focus on its
//      icon.
//   6. **Full screen** takes the pinned panels back onto the map — the side
//      panel is under the full-screen map — and gives them back after.
//   7. **◫, the lg fold and a phone**: the cards under the map and back with
//      the same Leaflet map; below 1,100 px the cards fold under the map and the
//      side panel keeps Help and the pinned panels; at 375 px it is the old
//      phone shape exactly — no column, the help edge tab, the cards under the
//      map and a pinned panel docked in the map's corner.
//   8. **No sideways scroll** at 375, 768 and 1440 with the side panel open.
//
// Everything runs against the bundled stations.json on loopback with the
// network policy in force.
//
// Run:  npm run dock
//       npm run dock -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// Every id the Stations cards are found by. Each must be on the page exactly
// once on the Stations tab and not at all anywhere else.
const CARD_IDS = ['stations-cards', 'stations-filter-card', 'stations-list-card', 'stations-table-wrap',
                  'path-profile-panel', 'link-budget-panel', 'stations-carriers-card', 'blast-card',
                  'stations-editor-card'];

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  const toStations = async () => {
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
  };
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await toStations();

  // What the side panel is doing, in the terms the assertions are written in.
  const look = () => page.evaluate((ids) => {
    const panel = document.getElementById('help-panel');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
    const map = document.getElementById('leaflet-map');
    const counts = {};
    for (const id of ids) counts[id] = document.querySelectorAll('#' + id).length;
    return {
      showing: dockShowing(),
      pref: state.dockTab,
      open: state.dockOpen,
      collapsed: panel.classList.contains('collapsed'),
      panel: box(panel),
      map: box(map),
      leafletW: state.map ? state.map.getSize().x : null,
      mapClientW: map ? map.clientWidth : null,
      strip: [...panel.querySelectorAll('.dock-strip .dock-tab')].map(b => b.dataset.dock),
      expanded: Object.fromEntries([...panel.querySelectorAll('.dock-strip .dock-tab')]
        .map(b => [b.dataset.dock, b.getAttribute('aria-expanded')])),
      help: document.querySelector('#help-panel .help-toggle')?.getAttribute('aria-expanded'),
      cardsIn: (() => { const c = document.getElementById('stations-cards');
        return !c ? null : c.closest('#help-panel') ? 'dock' : c.closest('#main-content') ? 'main' : '?'; })(),
      counts,
      active: document.activeElement ? (document.activeElement.dataset.dock
        || document.activeElement.className || document.activeElement.tagName) : null,
    };
  }, CARD_IDS);

  // ── 1. A fresh visit ─────────────────────────────────────────────────────
  let s = await look();
  check('a fresh visit opens the side panel on the Stations cards, at 1440',
    s.showing === 'stations' && s.cardsIn === 'dock' && !s.collapsed, JSON.stringify(s));
  check('…and ❔ says Help is not the pane showing, 📋 that Stations is',
    s.help === 'false' && s.expanded.stations === 'true', JSON.stringify(s.expanded));
  check('every card id is on the page exactly once',
    CARD_IDS.every(id => s.counts[id] === 1), JSON.stringify(s.counts));
  const shape = await page.evaluate(() => {
    const strip = document.querySelector('#help-panel .dock-strip');
    const outside = sel => [...document.querySelectorAll(sel)].filter(el => !el.closest('#main-content'));
    const btns = [...strip.querySelectorAll('.dock-tab')];
    return {
      asides: outside('aside').length,
      navs: outside('nav').length,
      stripRole: strip.getAttribute('role'),
      stripName: strip.getAttribute('aria-label'),
      named: btns.every(b => (b.getAttribute('aria-label') || '').trim().length > 0),
      controls: btns.every(b => !!document.getElementById(b.getAttribute('aria-controls'))),
      square: btns.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      firstIsHelp: btns[0] && btns[0].classList.contains('help-toggle'),
      stationsH2: !!document.querySelector('#dock-pane-stations > h2'),
    };
  });
  check('still one <aside> and one <nav>, and the strip is a labelled group of named buttons',
    shape.asides === 1 && shape.navs === 1 && shape.stripRole === 'group' && !!shape.stripName
      && shape.named && shape.controls && shape.firstIsHelp, JSON.stringify(shape));
  check('…44 px square', shape.square.every(([w, h]) => w === 44 && h === 44), JSON.stringify(shape.square));
  check('…and the Stations pane has the h2 its cards\' h3s step from', shape.stationsH2);

  // ── 2. Panes and buttons ─────────────────────────────────────────────────
  const w0 = s.panel.w;
  await page.click('#help-panel .dock-tab[data-dock="help"]');
  await page.waitForTimeout(300);
  s = await look();
  check('❔ switches the open pane to Help, at the same width',
    s.showing === 'help' && s.help === 'true' && s.expanded.stations === 'false' && s.panel.w === w0,
    JSON.stringify(s));
  check('…with focus still on the button that was pressed', s.active === 'help', String(s.active));
  await page.keyboard.press('ArrowDown');
  s = await look();
  check('ArrowDown walks the strip to the next button', s.active === 'stations', String(s.active));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  s = await look();
  check('…and 📋 brings the cards back', s.showing === 'stations' && s.help === 'false', JSON.stringify(s));

  const mapWide = s.map.w;
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(500);
  s = await look();
  check('pressing the showing pane\'s button shuts the side panel and the map takes the width',
    s.showing === null && s.collapsed && s.map.w > mapWide + 300 && s.pref === 'stations', JSON.stringify(s));
  check('…and Leaflet was told: the map it projects against is the map on screen',
    s.leafletW === s.mapClientW, `${s.leafletW} vs ${s.mapClientW}`);
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(500);
  s = await look();
  check('…and opening it again gives the width back, re-measured',
    s.showing === 'stations' && Math.abs(s.map.w - mapWide) <= 2 && s.leafletW === s.mapClientW,
    JSON.stringify(s));

  // ── 3. The width handle ──────────────────────────────────────────────────
  const handle = () => page.evaluate(() => {
    const h = document.querySelector('#help-panel .dock-resize');
    const r = h.getBoundingClientRect();
    return {
      role: h.getAttribute('role'), orient: h.getAttribute('aria-orientation'),
      name: h.getAttribute('aria-label'), tab: h.tabIndex,
      now: Number(h.getAttribute('aria-valuenow')), min: Number(h.getAttribute('aria-valuemin')),
      max: Number(h.getAttribute('aria-valuemax')), text: h.getAttribute('aria-valuetext'),
      x: r.left + r.width / 2, y: r.top + r.height / 2, width: dockWidth(),
      stored: localStorage.getItem('mn-dock-w'),
      mapW: Math.round(document.getElementById('leaflet-map').getBoundingClientRect().width),
      mainW: Math.round(document.getElementById('main-content').getBoundingClientRect().width),
    };
  });
  let h = await handle();
  check('the handle is a vertical separator with a name and a value in px',
    h.role === 'separator' && h.orient === 'vertical' && !!h.name && h.tab === 0
      && h.now === h.width && h.min <= h.now && h.now <= h.max && /\d+ pixels/.test(h.text || ''),
    JSON.stringify(h));
  await page.focus('#help-panel .dock-resize');
  const ring = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return { active: document.activeElement.classList.contains('dock-resize'), style: cs.outlineStyle, width: cs.outlineWidth };
  });
  check('…focusable, with the focus ring left on', ring.active && ring.style !== 'none' && ring.width !== '0px',
    JSON.stringify(ring));

  // A real pointer: grab it, drag it 100 px left, let go.
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x - 100, h.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragged = await handle();
  const dragMap = await look();
  check('a real pointer drags the handle, and the pane follows it',
    Math.abs(dragged.width - (h.width + 100)) <= 3 && dragged.now === dragged.width, JSON.stringify(dragged));
  check('…the map narrows with it, re-measured',
    dragged.mapW < h.mapW - 90 && dragMap.leafletW === dragMap.mapClientW, JSON.stringify({ h, dragged }));
  check('…and the width is written down when it is let go',
    Number(dragged.stored) === dragged.width, String(dragged.stored));

  await page.focus('#help-panel .dock-resize');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  let k = await handle();
  check('ArrowRight narrows it a step at a time', k.width === dragged.width - 40, JSON.stringify(k));
  await page.keyboard.press('Home');
  k = await handle();
  check('Home takes it to its narrowest', k.width === k.min && k.now === k.min, JSON.stringify(k));
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  k = await handle();
  check('End takes it to its widest, which still leaves the page its share',
    k.width === k.max && k.mainW >= 400 - 1, JSON.stringify(k));
  // Past the end of the range with the pointer: clamped, not overshot.
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  await page.mouse.move(40, k.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const clamped = await handle();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('…and a drag past it stops at it, with nothing scrolling sideways',
    clamped.width === clamped.max && !sideways, JSON.stringify(clamped));
  await page.keyboard.press('Home');
  for (let i = 0; i < 2; i++) await page.keyboard.press('PageUp');
  const kept = await handle();
  // Reloaded as a browser that last saw the help *rail*: its "collapsed" was an
  // answer about the help, given before the Stations cards were a pane, and
  // must not be read as "hide the cards".
  await page.evaluate(() => { localStorage.setItem('mn-help', 'collapsed'); localStorage.removeItem('mn-dock-tab'); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await toStations();
  const reloaded = await handle();
  check('the width survives a reload', reloaded.width === kept.width && kept.width === kept.min + 200,
    `${kept.width} → ${reloaded.width}`);
  check('…and a browser holding only the old help rail\'s "collapsed" still opens on the cards',
    await page.evaluate(() => dockShowing() === 'stations'));
  await page.evaluate(() => { localStorage.removeItem('mn-dock-w'); state.dockW = DOCK_DEFAULT_W; renderDock({ instant: true }); });
  await page.waitForTimeout(200);

  // ── 4. Leaving the tab ───────────────────────────────────────────────────
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(300);
  s = await look();
  check('leaving the tab takes the Stations button and every card with it',
    !s.strip.includes('stations') && CARD_IDS.every(id => s.counts[id] === 0), JSON.stringify(s));
  check('…and the side panel is shut there, still preferring the cards',
    s.showing === null && s.collapsed && s.pref === 'stations' && s.open === true, JSON.stringify(s));
  await toStations();
  s = await look();
  check('coming back opens it on the cards again',
    s.showing === 'stations' && s.cardsIn === 'dock', JSON.stringify(s));
  check('…with every card id on the page once, not twice',
    CARD_IDS.every(id => s.counts[id] === 1), JSON.stringify(s.counts));
  // A render inside the tab re-emits every card while the old ones are in the
  // side panel — the moment a duplicate would be born.
  await page.evaluate(() => renderMain());
  await page.waitForTimeout(400);
  s = await look();
  check('a render inside the tab leaves one of each, in the side panel',
    s.cardsIn === 'dock' && CARD_IDS.every(id => s.counts[id] === 1), JSON.stringify(s.counts));
  // Help, chosen on Stations, follows you out and back — the help rail's rule.
  await page.evaluate(() => setHelpCollapsed(false));
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(200);
  const helpOut = await look();
  await toStations();
  const helpBack = await look();
  check('Help, once chosen, is what shows on every tab — the Stations pane does not take over',
    helpOut.showing === 'help' && helpBack.showing === 'help', `${helpOut.showing} / ${helpBack.showing}`);
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(300);

  // ── 5. Pinning ───────────────────────────────────────────────────────────
  const wrapAt = (id) => page.evaluate((p) => {
    const all = [...document.querySelectorAll(`.mn-mapctl[data-panel="${p}"]`)];
    const w = all[0];
    if (!w) return { n: 0 };
    const body = w.querySelector('.mn-mapctl-body');
    return {
      n: all.length,
      where: w.closest('#help-panel') ? 'dock' : w.closest('.leaflet-control-container') ? 'corner' : '?',
      whole: !!(w.querySelector(':scope > .mn-mapctl-btn') && body
               && body.querySelector('.mn-mapctl-head .mn-mapctl-title') && body.querySelector('.mn-mapctl-pin')
               && body.querySelector('.mn-mapctl-content')),
      pinned: w.classList.contains('is-pinned'),
      shown: !!(body && (body.offsetWidth || body.offsetHeight)),
      title: (w.querySelector('.mn-mapctl-title') || {}).textContent,
      pane: (w.closest('.dock-pane') || {}).id || null,
    };
  }, id);

  // Map display, by a real pointer: over its icon, then the pin in its flyout.
  await page.hover('.mn-mapctl[data-panel="display"] .mn-mapctl-btn');
  await page.waitForTimeout(150);
  await page.click('.mn-mapctl[data-panel="display"] .mn-mapctl-pin');
  await page.waitForTimeout(400);
  let d = await wrapAt('display');
  s = await look();
  check('pinning Map display moves its whole wrapper into the side panel',
    d.n === 1 && d.where === 'dock' && d.whole && d.pinned, JSON.stringify(d));
  check('…opens the side panel on it, with a 🗺️ button of its own',
    s.showing === 'map-display' && s.strip.includes('map-display') && d.shown, JSON.stringify(s));
  check('…and focus is still on the pin that was pressed',
    await page.evaluate(() => document.activeElement?.classList.contains('mn-mapctl-pin')
      && !!document.activeElement.closest('#help-panel')));
  const arrowsBefore = await page.evaluate(() => state.mapArrows);
  await page.click('.mn-mapctl[data-panel="display"] #map-display-block input[onchange^="MapArrows.setEnabled"]');
  await page.waitForTimeout(300);
  check('a real click inside it works', await page.evaluate(() => state.mapArrows) === !arrowsBefore,
    `arrows ${arrowsBefore} → ${await page.evaluate(() => state.mapArrows)}`);
  await page.evaluate(() => MapArrows.setEnabled(true));

  await page.evaluate(() => { MapChrome.setPinned('draw', true); MapChrome.setPinned('sites', true); });
  await page.waitForTimeout(400);
  const dr = await wrapAt('draw');
  const si = await wrapAt('sites');
  s = await look();
  check('Draw & measure and the site finder go the same way',
    dr.where === 'dock' && dr.whole && si.where === 'dock' && si.whole
      && si.title === 'Repeater site finder' && s.showing === 'map-sites', JSON.stringify({ dr, si }));
  check('…and the strip orders them as the corner does, not as they were pinned',
    JSON.stringify(s.strip) === JSON.stringify(['help', 'stations', 'map-display', 'map-draw', 'map-sites']),
    JSON.stringify(s.strip));
  check('…with nothing left of them in the corner and no id twice',
    await page.evaluate(() => !document.querySelector('.leaflet-control-container .mn-mapctl[data-panel="display"], .leaflet-control-container .mn-mapctl[data-panel="draw"], .leaflet-control-container .mn-mapctl[data-panel="sites"]')
      && ['map-display-block', 'map-draw-panel', 'sites-run', 'map-legend'].every(id => document.querySelectorAll('#' + id).length === 1)));
  await page.locator('#sites-paste').fill('Alstonville STP');
  check('the site finder\'s box takes typing in the side panel',
    await page.evaluate(() => document.getElementById('sites-paste').value) === 'Alstonville STP');
  await page.locator('#sites-paste').fill('');
  await page.click('#help-panel .dock-tab[data-dock="map-draw"]');
  await page.waitForTimeout(250);
  await page.click('#map-draw-panel button:has-text("Line")');
  await page.waitForTimeout(250);
  check('…and a real click on Draw & measure\'s Line tool arms it', await page.evaluate(() => state.draw.tool) === 'line',
    await page.evaluate(() => state.draw.tool));
  await page.evaluate(() => MapDraw.setTool(''));
  await page.waitForTimeout(150);

  // The map is rebuilt on every visit to the tab; the panels dock themselves again.
  await page.evaluate(() => { state.map.__probe = 'old'; });
  await page.evaluate(() => switchTab('passranges'));
  await page.waitForTimeout(300);
  const away = await page.evaluate(() => ({
    wrappers: document.querySelectorAll('.mn-mapctl').length,
    strip: [...document.querySelectorAll('#help-panel .dock-tab')].map(b => b.dataset.dock),
  }));
  check('leaving the tab takes the pinned panels out of the side panel with their map',
    away.wrappers === 0 && JSON.stringify(away.strip) === '["help"]', JSON.stringify(away));
  await toStations();
  s = await look();
  const rebuilt = await page.evaluate(() => state.map.__probe !== 'old');
  check('coming back, the rebuilt map docks them again, in order, on the pane last open',
    rebuilt && JSON.stringify(s.strip) === JSON.stringify(['help', 'stations', 'map-display', 'map-draw', 'map-sites'])
      && s.showing === 'map-draw' && (await wrapAt('draw')).where === 'dock', JSON.stringify(s));

  // Unpinning, from the pin inside the docked panel.
  await page.click('#help-panel .mn-mapctl[data-panel="draw"] .mn-mapctl-pin');
  await page.mouse.move(600, 880);
  await page.waitForTimeout(300);
  const back = await wrapAt('draw');
  s = await look();
  check('unpinning puts it back in the map\'s corner, shut',
    back.where === 'corner' && !back.pinned && !back.shown && !s.strip.includes('map-draw'), JSON.stringify(back));
  check('…with focus on its corner icon',
    await page.evaluate(() => document.activeElement?.classList.contains('mn-mapctl-btn')
      && document.activeElement.closest('.mn-mapctl')?.dataset.panel === 'draw'));
  // Draw & measure was pinned while Map display was the pane on screen, so
  // that is where the side panel goes back to — not to whatever button was
  // pressed since, and not to the default.
  check('…and the side panel goes back to the pane it was showing before that pin',
    s.showing === 'map-display', JSON.stringify(s));

  // ── 6. Full screen ───────────────────────────────────────────────────────
  await page.evaluate(() => toggleMapFullscreen(true));
  await page.waitForTimeout(300);
  const full = await page.evaluate(() => {
    const fp = document.querySelector('.map-panel.is-full');
    const inFull = p => { const w = document.querySelector(`.mn-mapctl[data-panel="${p}"]`); return !!w && !!fp && fp.contains(w) && w.classList.contains('is-pinned'); };
    const body = document.querySelector('.mn-mapctl[data-panel="display"] .mn-mapctl-body');
    return { display: inFull('display'), sites: inFull('sites'), shown: !!(body && body.offsetWidth),
             strip: [...document.querySelectorAll('#help-panel .dock-tab')].map(b => b.dataset.dock) };
  });
  check('full screen puts the pinned panels back on the map, docked in its corner',
    full.display && full.sites && full.shown && !full.strip.some(t => t.startsWith('map-')), JSON.stringify(full));
  await page.evaluate(() => toggleMapFullscreen(false));
  await page.waitForTimeout(400);
  s = await look();
  check('…and leaving it gives them back to the side panel',
    (await wrapAt('display')).where === 'dock' && (await wrapAt('sites')).where === 'dock'
      && s.showing === 'map-display' && s.leafletW === s.mapClientW, JSON.stringify(s));

  // ── 6b. the keyboard, and a card that closes ─────────────────────────────
  // The strip is drawn on the panel's outer edge but written before the panes,
  // so Tab from a button that has just opened its pane goes into that pane.
  // Written after them (as it first was), Tab left the panel for <body> and
  // the skip link, and the pane could only be reached backwards.
  await page.evaluate(() => setDockTab('stations', { instant: true }));
  await page.focus('#help-panel .help-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const tabbed = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a ? a.tagName : '', inHelp: !!(a && a.closest('#dock-pane-help')),
               inStrip: !!(a && a.closest('#help-panel .dock-strip')) };
    });
    tabbed.push(at);
    if (!at.inStrip) break;
  }
  const landed = tabbed[tabbed.length - 1];
  check('Tab from ❔, once it has opened Help, walks the strip and then into the help it opened',
    landed.inHelp && tabbed.slice(0, -1).every(t => t.inStrip), JSON.stringify(tabbed));

  // Closing a station card must never change the layout — not reopen a side
  // panel the operator shut for the map's sake, and not swap Help for the
  // cards to park focus on a row it cannot see.
  await page.evaluate(() => setDockTab('stations', { instant: true }));
  await page.click('#stations-table-wrap tr[data-sid] button');
  await page.waitForTimeout(300);
  await page.click('#help-panel .dock-tab[data-dock="stations"]');
  await page.waitForTimeout(400);
  const shut = await look();
  await page.click('#stn-card button[aria-label="Close the station card"]');
  await page.waitForTimeout(400);
  const closed = await look();
  check('closing the station card leaves a shut side panel shut, and the map its width',
    shut.showing === null && closed.showing === null && closed.leafletW === shut.leafletW,
    JSON.stringify({ shut: [shut.showing, shut.leafletW], closed: [closed.showing, closed.leafletW] }));
  await page.evaluate(() => setDockTab('stations', { instant: true }));
  await page.waitForTimeout(300);
  check('<main>\'s own heading says it holds the map alone while the cards are beside it',
    await page.evaluate(() => document.getElementById('stations-main-h')?.textContent === 'Stations — map'));

  // ── 7. ◫, the fold, a phone ──────────────────────────────────────────────
  await page.evaluate(() => { state.map.__probe = 'same'; toggleStationsSplit(false); });
  await page.waitForTimeout(500);
  s = await look();
  check('◫ off puts the cards under the map and takes the Stations button away',
    s.cardsIn === 'main' && !s.strip.includes('stations'), JSON.stringify(s));
  await page.evaluate(() => toggleStationsSplit(true));
  await page.waitForTimeout(500);
  s = await look();
  check('◫ on puts them back in the side panel, open on them, with the same Leaflet map',
    s.cardsIn === 'dock' && s.showing === 'stations' && await page.evaluate(() => state.map.__probe === 'same'),
    JSON.stringify(s));

  // Focus is carried across the fold: moving the cards with a row button
  // focused used to drop the keyboard user back on <body>.
  await page.focus('#stations-table-wrap tr[data-sid] button');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(600);
  const foldFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a ? a.tagName : '', row: !!(a && a.closest('#stations-table-wrap tr[data-sid]')) };
  });
  check('crossing the 1100 px fold with a row focused keeps focus on that row', foldFocus.row, JSON.stringify(foldFocus));
  const folded = await page.evaluate(() => ({
    split: document.querySelector('.mn-map-split')?.getAttribute('aria-label') || '',
    h: document.getElementById('stations-main-h')?.textContent || '',
  }));
  check('…and below it ◫ says the side panel is for wider windows, and <main>\'s heading names the cards again',
    /wider windows/.test(folded.split) && /filters and station list/.test(folded.h), JSON.stringify(folded));
  s = await look();
  check('at 1000 px the cards fold under the map, and the side panel keeps Help and the pins',
    s.cardsIn === 'main' && !s.strip.includes('stations') && s.strip.includes('help')
      && s.strip.includes('map-display') && (await wrapAt('display')).where === 'dock', JSON.stringify(s));
  check('…without forgetting where the cards were wanted', s.pref === 'stations'
    && await page.evaluate(() => state.mapSplit === true), JSON.stringify(s));

  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(600);
  const phone = await page.evaluate(() => {
    const panel = document.getElementById('help-panel');
    const tab = panel.querySelector('.help-toggle');
    const r = tab.getBoundingClientRect();
    const w = document.querySelector('.mn-mapctl[data-panel="display"]');
    return {
      panelW: Math.round(panel.getBoundingClientRect().width),
      tabShown: r.width > 0 && r.height > 0 && getComputedStyle(tab.closest('.dock-strip')).position === 'fixed',
      tabAtEdge: Math.round(r.right) >= innerWidth - 1,
      strip: [...panel.querySelectorAll('.dock-tab')].map(b => b.dataset.dock),
      cards: !!document.querySelector('#main-content #stations-cards'),
      display: w && w.closest('.leaflet-control-container') && w.classList.contains('is-pinned') ? 'corner' : 'elsewhere',
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  check('at 375 px there is no side-panel column, only the help tab on the screen edge',
    phone.panelW === 0 && phone.tabShown && phone.tabAtEdge && JSON.stringify(phone.strip) === '["help"]',
    JSON.stringify(phone));
  check('…the cards are under the map and a pinned panel is docked in the map\'s corner',
    phone.cards && phone.display === 'corner' && !phone.sideways, JSON.stringify(phone));
  await page.evaluate(() => setHelpCollapsed(false));
  await page.waitForTimeout(300);
  const drawer = await page.evaluate(() => {
    const pane = document.getElementById('dock-pane-help');
    const r = pane.getBoundingClientRect();
    return { fixed: getComputedStyle(pane).position === 'fixed', right: Math.round(r.right), w: Math.round(r.width),
             backdrop: !document.getElementById('help-backdrop').hidden, help: document.querySelector('.help-toggle').getAttribute('aria-expanded') };
  });
  check('…and ❔ opens help as the drawer it always was, with its backdrop',
    drawer.fixed && drawer.right >= 374 && drawer.w > 200 && drawer.backdrop && drawer.help === 'true',
    JSON.stringify(drawer));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('…which Escape closes', await page.evaluate(() => !helpShowing()
    && document.getElementById('help-backdrop').hidden));

  // ── 8. No sideways scroll with the side panel open ───────────────────────
  for (const [width, how] of [[375, 'help'], [768, 'help'], [1440, 'stations'], [1440, 'map-display']]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(400);
    const over = await page.evaluate(async (t) => {
      if (t === 'help') setHelpCollapsed(false); else setDockTab(t);
      await new Promise(r => setTimeout(r, 300));
      const el = document.documentElement;
      return { scroll: el.scrollWidth, client: el.clientWidth, showing: dockShowing() };
    }, how);
    check(`no sideways scroll at ${width} px with ${how} open`,
      over.scroll <= over.client + 1 && over.showing === how, JSON.stringify(over));
  }

  await page.evaluate(() => {
    for (const p of ['display', 'draw', 'sites', 'legend']) MapChrome.setPinned(p, false);
    setDockTab('stations');
  });
  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — one side panel: the cards, the help and the pinned panels, tabbed, resizable,');
console.log('       and nothing left behind when the tab or the map goes.');
